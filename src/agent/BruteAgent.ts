import * as vscode from 'vscode';
import { ChatMessage, ModelProvider } from '../models/ModelProvider';
import { buildSystemPrompt, buildCodeCheckPrompt } from './prompts';

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
  private model: string | undefined;
  private teachingStyle: 'socratic' | 'direct' | 'hints-only';
  project: Project | null = null;

  onStream?: (delta: string) => void;
  onDone?: (fullResponse: string) => void;
  onError?: (error: Error) => void;

  constructor(provider: ModelProvider) {
    this.provider = provider;
    const cfg = vscode.workspace.getConfiguration('bruteCoding');
    this.teachingStyle = cfg.get<'socratic' | 'direct' | 'hints-only'>('teachingStyle', 'socratic');
    const modelOverride = cfg.get<string>('model', '');
    this.model = modelOverride || undefined;

    this.history.push({
      role: 'system',
      content: buildSystemPrompt(this.teachingStyle),
    });
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
    this.history.push({ role: 'user', content: userContent });

    let fullResponse = '';

    try {
      for await (const chunk of this.provider.chat(this.history, this.model)) {
        if (!chunk.done) {
          fullResponse += chunk.delta;
          this.onStream?.(chunk.delta);
        }
      }

      this.history.push({ role: 'assistant', content: fullResponse });
      this.onDone?.(fullResponse);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
      // Remove the user message we just added so history stays consistent
      this.history.pop();
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
