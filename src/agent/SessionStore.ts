import * as vscode from 'vscode';
import { ChatMessage } from '../models/ModelProvider';
import { BruteAgent, Project } from './BruteAgent';

const SAVED_SESSIONS_KEY = 'bruteCoding.savedSessions';
const MAX_SAVED_SESSIONS = 25;

export interface SavedBruteSession {
  id: string;
  title: string;
  savedAt: string;
  project: (Omit<Project, 'startedAt'> & { startedAt: string }) | null;
  history: ChatMessage[];
}

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

function getSessionTitle(project: Project | null, history: ChatMessage[]): string {
  if (project?.goal.trim()) {
    return project.goal.trim().slice(0, 80);
  }

  const firstUserMessage = history.find(message => message.role === 'user' && message.content.trim());
  return firstUserMessage?.content.trim().slice(0, 80) || 'Untitled BruteCoding session';
}
