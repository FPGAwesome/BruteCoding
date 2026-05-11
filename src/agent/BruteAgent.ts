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
  guidanceProvider?: string;
  taskmasterProvider?: string;
  guidanceModel?: string;
  taskmasterModel?: string;
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
  conversation: ChatMessage[];
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
  private taskmasterModel: string | undefined;
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
    const taskmasterOverride = cfg.get<string>('taskmasterModel', '');
    this.taskmasterModel = taskmasterOverride || this.model;

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
    const cards = await this.createProjectCards(goal, language, this.taskmasterModel);
    await this.startProjectWithCards(goal, language, cards, {
      guidanceModel: this.model,
      taskmasterModel: this.taskmasterModel,
    });
  }

  async planProjectCards(goal: string, language: string, taskmasterModel?: string): Promise<TaskCard[]> {
    return this.createProjectCards(goal, language, normalizeModelOverride(taskmasterModel, this.taskmasterModel));
  }

  async startProjectWithCards(
    goal: string,
    language: string,
    cards: TaskCard[],
    options: { guidanceProvider?: string; taskmasterProvider?: string; guidanceModel?: string; taskmasterModel?: string } = {}
  ): Promise<void> {
    this.model = normalizeModelOverride(options.guidanceModel, this.model);
    this.taskmasterModel = normalizeModelOverride(options.taskmasterModel, this.taskmasterModel);
    const normalizedCards = cards.map((card, index) => ({
      ...card,
      id: card.id || `card-${index + 1}`,
      status: index === 0 ? 'active' as const : 'locked' as const,
      conversation: [],
    }));

    this.project = {
      goal,
      language,
      guidanceProvider: options.guidanceProvider || this.provider.name,
      taskmasterProvider: options.taskmasterProvider || this.provider.name,
      guidanceModel: this.model,
      taskmasterModel: this.taskmasterModel,
      currentMilestone: 0,
      currentTask: normalizedCards[0].title,
      cards: normalizedCards,
      currentCardId: normalizedCards[0].id,
      startedAt: new Date(),
    };

    const kickoff = this.buildCurrentCardKickoff('New student project starting now. Welcome the student, explain the active card briefly, and give the first specific action for this card.');

    await this.send(kickoff, { recordUserMessage: false });
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

    await this.send(checkPrompt, { displayUserContent: 'Check my code.' });
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
      await this.send('The student marked the final task card complete. Congratulate them briefly and suggest one optional stretch goal without starting a new lesson.', { recordUserMessage: false });
      return;
    }

    next.status = 'active';
    this.project.currentCardId = next.id;
    this.project.currentMilestone = currentIndex + 1;
    this.project.currentTask = next.title;

    await this.send(this.buildCurrentCardKickoff('The previous card is complete. Start the next card as a fresh focused conversation. Assume completed cards are done.'), { recordUserMessage: false });
  }

  selectCard(cardId: string): void {
    if (!this.project || !this.project.cards.some(card => card.id === cardId)) {
      return;
    }

    this.project.currentCardId = cardId;
    const selectedIndex = this.project.cards.findIndex(card => card.id === cardId);
    this.project.currentMilestone = Math.max(0, selectedIndex);
    this.project.currentTask = this.getCurrentCard()?.title ?? this.project.currentTask;
  }

  private async send(
    userContent: string,
    options: { recordUserMessage?: boolean; displayUserContent?: string } = {}
  ): Promise<void> {
    const recordUserMessage = options.recordUserMessage ?? true;
    const card = this.getCurrentCard();
    const cardConversationLength = card?.conversation.length ?? 0;
    const requestHistory = this.buildRequestHistory(userContent);

    if (recordUserMessage && card) {
      card.conversation.push({ role: 'user', content: options.displayUserContent ?? userContent });
    }

    try {
      for (let index = 0; index < 6; index += 1) {
        let fullResponse = '';

        for await (const chunk of this.provider.chat(requestHistory, this.model)) {
          if (!chunk.done) {
            fullResponse += chunk.delta;
          }
        }

        const toolCalls = tryParseToolCalls(fullResponse);
        if (!toolCalls.length) {
          card?.conversation.push({ role: 'assistant', content: fullResponse });
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

        requestHistory.push({ role: 'assistant', content: fullResponse });
        requestHistory.push({
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
      if (card) {
        card.conversation.splice(cardConversationLength);
      }
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
    }
  }

  clearHistory(): void {
    this.history = [this.history[0]]; // keep system prompt
    this.project = null;
  }

  restoreProject(project: Project): void {
    const cards = project.cards.map(card => ({
      ...card,
      conversation: card.conversation ?? [],
      successCriteria: card.successCriteria ?? [],
    }));
    const currentCardId = cards.some(card => card.id === project.currentCardId)
      ? project.currentCardId
      : cards[0]?.id ?? '';

    this.project = {
      ...project,
      cards,
      currentCardId,
      currentMilestone: Math.max(0, cards.findIndex(card => card.id === currentCardId)),
      currentTask: cards.find(card => card.id === currentCardId)?.title ?? project.currentTask,
      startedAt: project.startedAt instanceof Date ? project.startedAt : new Date(project.startedAt),
    };
  }

  getHistory(): ChatMessage[] {
    if (!this.project) {
      return [];
    }

    return this.project.cards.flatMap(card => card.conversation);
  }

  private buildRequestHistory(userContent: string): ChatMessage[] {
    if (!this.project) {
      return [this.history[0], { role: 'user', content: userContent }];
    }

    const current = this.getCurrentCard();
    return [
      this.history[0],
      { role: 'user', content: this.buildCurrentCardContext() },
      ...(current?.conversation ?? []),
      { role: 'user', content: userContent },
    ];
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

  private getCurrentCard(): TaskCard | undefined {
    return this.project?.cards.find(card => card.id === this.project?.currentCardId);
  }

  private async createProjectCards(goal: string, language: string, taskmasterModel?: string): Promise<TaskCard[]> {
    try {
      const response = await this.runTaskmaster(goal, language, taskmasterModel);
      const parsed = parseCardPlan(response);
      return normalizeCardPlan(parsed);
    } catch {
      return createInitialCards(goal, language);
    }
  }

  private async runTaskmaster(goal: string, language: string, taskmasterModel?: string): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are BruteCoding Taskmaster, a staff-level coding mentor who turns a project goal into a small sequence of focused teaching cards.',
          'Return only JSON. No markdown, no prose.',
          'The JSON shape must be:',
          '{"cards":[{"title":"...","concept":"...","objective":"...","successCriteria":["..."]}]}',
          'Create 2 to 6 cards. Each card should be completable in one focused tutoring conversation.',
          'The first card should usually orient around the existing project or smallest starting context.',
          'The final card should usually verify, test, or reflect on what was built.',
          'Avoid broad phase names like "Implementation" unless the objective is concrete.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Project goal: ${goal}`,
          `Language/stack: ${language}`,
          '',
          'Design the card plan now.',
        ].join('\n'),
      },
    ];

    let fullResponse = '';
    for await (const chunk of this.provider.chat(messages, taskmasterModel)) {
      if (!chunk.done) {
        fullResponse += chunk.delta;
      }
    }
    return fullResponse;
  }
}

interface RawCardPlan {
  cards?: Array<Partial<Omit<TaskCard, 'id' | 'status' | 'conversation'>>>;
}

function parseCardPlan(text: string): RawCardPlan {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed;

  try {
    return JSON.parse(candidate) as RawCardPlan;
  } catch {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    if (!objectMatch) {
      throw new Error('Taskmaster did not return JSON.');
    }
    return JSON.parse(objectMatch[0]) as RawCardPlan;
  }
}

function normalizeCardPlan(plan: RawCardPlan): TaskCard[] {
  const rawCards = Array.isArray(plan.cards) ? plan.cards.slice(0, 6) : [];
  const cards = rawCards
    .map((card, index): TaskCard | null => {
      const title = cleanText(card.title);
      const concept = cleanText(card.concept);
      const objective = cleanText(card.objective);
      const successCriteria = Array.isArray(card.successCriteria)
        ? card.successCriteria.map(cleanText).filter(Boolean).slice(0, 5)
        : [];

      if (!title || !concept || !objective || successCriteria.length === 0) {
        return null;
      }

      return {
        id: `card-${index + 1}`,
        title,
        concept,
        objective,
        successCriteria,
        status: index === 0 ? 'active' : 'locked',
        conversation: [],
      };
    })
    .filter((card): card is TaskCard => Boolean(card));

  if (cards.length < 2) {
    throw new Error('Taskmaster returned too few usable cards.');
  }

  return cards;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 240) : '';
}

function normalizeModelOverride(value: string | undefined, fallback: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || fallback;
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
      conversation: [],
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
      conversation: [],
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
      conversation: [],
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
      conversation: [],
    },
  ];
}
