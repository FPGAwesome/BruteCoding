import * as vscode from 'vscode';
import { ChatMessage, ModelProvider } from '../models/ModelProvider';
import { buildSystemPrompt, buildCodeCheckPrompt } from './prompts';
import {
  BruteToolEvent,
  BruteToolHost,
  formatToolResult,
  getConfiguredToolMode,
  tryParseToolCalls,
} from '../tools';

export interface Project {
  goal: string;
  language: string;
  currentMilestone: number;
  currentTask: string;
  startedAt: Date;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export class BruteAgent {
  private history: ChatMessage[] = [];
  private provider: ModelProvider;
  private readonly toolHost: BruteToolHost;
  private model: string | undefined;
  private teachingStyle: 'socratic' | 'direct' | 'hints-only';
  project: Project | null = null;

  onStream?: (delta: string) => void;
  onDone?: (fullResponse: string) => void;
  onError?: (error: Error) => void;
  onToolEvent?: (event: BruteToolEvent) => void;

  constructor(provider: ModelProvider, toolHost = new BruteToolHost()) {
    this.provider = provider;
    this.toolHost = toolHost;
    const cfg = vscode.workspace.getConfiguration('bruteCoding');
    this.teachingStyle = cfg.get<'socratic' | 'direct' | 'hints-only'>('teachingStyle', 'socratic');
    const modelOverride = cfg.get<string>('model', '');
    this.model = modelOverride || undefined;

    this.history.push({
      role: 'system',
      content: buildSystemPrompt(this.teachingStyle, BruteToolHost.describeTools(getConfiguredToolMode())),
    });
  }

  refreshToolPrompt(): void {
    this.history[0] = {
      role: 'system',
      content: buildSystemPrompt(this.teachingStyle, BruteToolHost.describeTools(getConfiguredToolMode())),
    };
  }

  async startProject(goal: string, language: string): Promise<void> {
    this.project = {
      goal,
      language,
      currentMilestone: 0,
      currentTask: '',
      startedAt: new Date(),
    };

    const kickoff = `New student project starting now.

**Goal:** ${goal}
**Language:** ${language}
**Experience level:** Unknown (calibrate as we go)

Please welcome the student, outline the milestones you see for this project, and give them their first specific coding task.`;

    await this.send(kickoff);
  }

  async chat(userMessage: string): Promise<void> {
    await this.send(userMessage);
  }

  async checkCode(code: string): Promise<void> {
    if (!this.project) {
      throw new Error('No active project. Start a project first.');
    }

    const checkPrompt = buildCodeCheckPrompt(
      this.project.currentTask || this.project.goal,
      code,
      this.project.language
    );

    await this.send(checkPrompt);
  }

  private async send(userContent: string): Promise<void> {
    const initialHistoryLength = this.history.length;
    this.history.push({ role: 'user', content: userContent });

    try {
      for (let index = 0; index < 6; index += 1) {
        let fullResponse = '';

        for await (const chunk of this.provider.chat(this.history, this.model)) {
          if (!chunk.done) {
            fullResponse += chunk.delta;
          }
        }

        const toolCalls = tryParseToolCalls(fullResponse);
        if (!toolCalls.length) {
          this.history.push({ role: 'assistant', content: fullResponse });
          this.onStream?.(fullResponse);
          this.onDone?.(fullResponse);
          return;
        }

        const envelopes = [];
        for (const toolCall of toolCalls) {
          const { envelope, event } = await this.toolHost.execute(toolCall);
          envelopes.push(envelope);
          this.onToolEvent?.(event);
        }

        this.history.push({ role: 'assistant', content: fullResponse });
        this.history.push({
          role: 'user',
          content: [
            `Tool result${envelopes.length === 1 ? '' : 's'}:`,
            '```json',
            formatToolResult(envelopes.length === 1 ? envelopes[0] : envelopes),
            '```',
            '',
            'If a tool failed for an easily recoverable reason such as a wrong path, try one targeted debugging step such as `workspace_info` or `list_files`, then retry with the corrected input. Do not stop at the first obvious tool failure.',
          ].join('\n'),
        });
      }

      throw new Error('Tool loop exceeded the safety limit.');
    } catch (err) {
      this.history.splice(initialHistoryLength);
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
    }
  }

  clearHistory(): void {
    this.history = [this.history[0]]; // keep system prompt
    this.project = null;
  }

  getHistory(): ChatMessage[] {
    return this.history.slice(1); // exclude system prompt
  }
}
