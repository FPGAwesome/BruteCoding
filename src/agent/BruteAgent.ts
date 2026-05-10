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
  cards: TaskCard[];
  currentCardId: string;
  startedAt: Date;
}

export interface TaskCard {
  id: string;
  title: string;
  concept: string;
  objective: string;
  successCriteria: string[];
  status: 'active' | 'complete' | 'locked';
  summary?: string;
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
    const cards = createInitialCards(goal, language);
    this.project = {
      goal,
      language,
      currentMilestone: 0,
      currentTask: cards[0].title,
      cards,
      currentCardId: cards[0].id,
      startedAt: new Date(),
    };

    this.resetConversationForCurrentCard();
    const kickoff = this.buildCurrentCardKickoff('New student project starting now. Welcome the student, explain the active card briefly, and give the first specific action for this card.');

    await this.send(kickoff);
  }

  async chat(userMessage: string): Promise<void> {
    await this.send(this.project ? `${this.buildCurrentCardContext()}\n\nStudent message:\n${userMessage}` : userMessage);
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

  async completeCurrentCard(): Promise<void> {
    if (!this.project) {
      throw new Error('No active project. Start a project first.');
    }

    const currentIndex = this.project.cards.findIndex(card => card.id === this.project?.currentCardId);
    if (currentIndex === -1) {
      throw new Error('No active task card.');
    }

    const current = this.project.cards[currentIndex];
    current.status = 'complete';
    current.summary = `Completed: ${current.objective}`;

    const next = this.project.cards[currentIndex + 1];
    if (!next) {
      this.project.currentTask = 'Project complete';
      await this.send('The student marked the final task card complete. Congratulate them briefly and suggest one optional stretch goal without starting a new lesson.');
      return;
    }

    next.status = 'active';
    this.project.currentCardId = next.id;
    this.project.currentMilestone = currentIndex + 1;
    this.project.currentTask = next.title;
    this.resetConversationForCurrentCard();

    await this.send(this.buildCurrentCardKickoff('The previous card is complete. Start the next card as a fresh focused conversation. Assume completed cards are done.'));
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

  private resetConversationForCurrentCard(): void {
    this.history = [this.history[0], {
      role: 'user',
      content: this.buildCurrentCardContext(),
    }];
  }

  private buildCurrentCardKickoff(instruction: string): string {
    return `${this.buildCurrentCardContext()}\n\n${instruction}`;
  }

  private buildCurrentCardContext(): string {
    if (!this.project) {
      return '';
    }

    const current = this.project.cards.find(card => card.id === this.project?.currentCardId) ?? this.project.cards[0];
    const completed = this.project.cards
      .filter(card => card.status === 'complete')
      .map(card => `- ${card.title}: ${card.summary ?? card.objective}`)
      .join('\n') || '- None yet';

    return [
      'Project task-card context:',
      `Goal: ${this.project.goal}`,
      `Language/stack: ${this.project.language}`,
      '',
      'Completed cards:',
      completed,
      '',
      'Active card:',
      `Title: ${current.title}`,
      `Concept: ${current.concept}`,
      `Objective: ${current.objective}`,
      'Success criteria:',
      ...current.successCriteria.map(criterion => `- ${criterion}`),
      '',
      'Tutor constraints:',
      '- Help the student complete only the active card.',
      '- Do not advance to later cards unless the student explicitly asks or marks this card complete.',
      '- Ask for or inspect evidence before saying the active card is done.',
    ].join('\n');
  }
}

function createInitialCards(goal: string, language: string): TaskCard[] {
  return [
    {
      id: 'card-1',
      title: 'Orient the Project',
      concept: 'project structure',
      objective: `Identify the existing files, entry point, and smallest runnable shape for ${goal}.`,
      successCriteria: [
        'The workspace structure is understood.',
        'The student can name the entry point or file to edit first.',
        'The project can be opened or inspected without guessing paths.',
      ],
      status: 'active',
    },
    {
      id: 'card-2',
      title: 'Make the Smallest Working Slice',
      concept: 'vertical slice',
      objective: `Create or verify the smallest ${language} behavior that proves the project is alive.`,
      successCriteria: [
        'There is one tiny observable behavior.',
        'The student understands what code produced it.',
        'The behavior can be run or checked locally.',
      ],
      status: 'locked',
    },
    {
      id: 'card-3',
      title: 'Add the Core Behavior',
      concept: 'core logic',
      objective: `Implement the first meaningful piece of logic for ${goal} without polishing early.`,
      successCriteria: [
        'The core behavior is represented in code.',
        'The student can explain the main data/control flow.',
        'Obvious edge cases are named, even if not all are solved yet.',
      ],
      status: 'locked',
    },
    {
      id: 'card-4',
      title: 'Verify and Tighten',
      concept: 'feedback loop',
      objective: 'Run, test, or manually verify the current behavior and fix the most important issue found.',
      successCriteria: [
        'The project has been run, tested, or checked.',
        'At least one concrete issue or confidence signal is identified.',
        'The next improvement is clear.',
      ],
      status: 'locked',
    },
  ];
}
