import * as vscode from 'vscode';
import { ChatMessage } from '../models/ModelProvider';
import { BruteAgent, Project, TaskCard } from './BruteAgent';

const SAVED_SESSIONS_KEY = 'bruteCoding.savedSessions';
const MAX_SAVED_SESSIONS = 25;

export interface SavedBruteSession {
  id: string;
  title: string;
  savedAt: string;
  project: (Omit<Project, 'startedAt'> & { startedAt: string }) | null;
  history: ChatMessage[];
}

type StoredProject = SavedBruteSession['project'];

export async function archiveAgentSession(
  context: vscode.ExtensionContext,
  agent: BruteAgent
): Promise<boolean> {
  const history = agent.getHistory();
  if (!agent.project && history.length === 0) {
    return false;
  }

  const session: SavedBruteSession = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: getSessionTitle(agent.project, history),
    savedAt: new Date().toISOString(),
    project: agent.project
      ? {
          ...agent.project,
          startedAt: agent.project.startedAt.toISOString(),
        }
      : null,
    history,
  };

  const previous = context.globalState.get<SavedBruteSession[]>(SAVED_SESSIONS_KEY, []);
  await context.globalState.update(SAVED_SESSIONS_KEY, [session, ...previous].slice(0, MAX_SAVED_SESSIONS));
  return true;
}

export function listSavedSessions(context: vscode.ExtensionContext): SavedBruteSession[] {
  return context.globalState.get<SavedBruteSession[]>(SAVED_SESSIONS_KEY, []);
}

export function getSavedSession(
  context: vscode.ExtensionContext,
  id: string
): SavedBruteSession | undefined {
  return listSavedSessions(context).find(session => session.id === id);
}

export function hydrateSavedProject(session: SavedBruteSession): Project | null {
  if (!session.project) {
    return null;
  }

  const project = session.project;
  const cards = hydrateCards(project, session);
  const currentCardId = cards.some(card => card.id === project.currentCardId)
    ? project.currentCardId
    : cards[0]?.id ?? '';

  return {
    ...project,
    cards,
    currentCardId,
    currentMilestone: Math.max(0, cards.findIndex(card => card.id === currentCardId)),
    currentTask: cards.find(card => card.id === currentCardId)?.title ?? project.currentTask,
    startedAt: new Date(project.startedAt),
  };
}

export async function deleteSavedSession(
  context: vscode.ExtensionContext,
  id: string
): Promise<void> {
  const sessions = listSavedSessions(context).filter(session => session.id !== id);
  await context.globalState.update(SAVED_SESSIONS_KEY, sessions);
}

function getSessionTitle(project: Project | null, history: ChatMessage[]): string {
  if (project?.goal.trim()) {
    return project.goal.trim().slice(0, 80);
  }

  const firstUserMessage = history.find(message => message.role === 'user' && message.content.trim());
  return firstUserMessage?.content.trim().slice(0, 80) || 'Untitled BruteCoding session';
}

function hydrateCards(project: NonNullable<StoredProject>, session: SavedBruteSession): TaskCard[] {
  if (Array.isArray(project.cards) && project.cards.length > 0) {
    return project.cards.map((card, index) => ({
      id: card.id || `card-${index + 1}`,
      title: card.title || `Task ${index + 1}`,
      concept: card.concept || 'saved work',
      objective: card.objective || 'Continue the saved task.',
      successCriteria: Array.isArray(card.successCriteria) ? card.successCriteria : [],
      status: card.status || (index === 0 ? 'active' : 'locked'),
      summary: card.summary,
      conversation: Array.isArray(card.conversation) ? card.conversation : [],
    }));
  }

  return [{
    id: 'card-1',
    title: project.currentTask || session.title,
    concept: 'saved conversation',
    objective: 'Continue this saved BruteCoding session.',
    successCriteria: ['The saved context is loaded.', 'The next useful step is clear.'],
    status: 'active',
    conversation: session.history,
  }];
}
