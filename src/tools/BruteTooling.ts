import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const MAX_FILE_LINES = 200;
const MAX_COMMAND_OUTPUT = 12000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;

export type BruteToolName = 'read_file' | 'run_command' | 'suggest_edit';
export type BruteToolMode = 'read-only' | 'guided' | 'full-access';

export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
  includeLineNumbers?: boolean;
}

export interface RunCommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface SuggestEditInput {
  path: string;
  startLine: number;
  endLine: number;
  intent:
    | 'boilerplate'
    | 'comment'
    | 'docstring'
    | 'type-shape'
    | 'fill-in-the-blank'
    | 'todo-scaffold';
  instruction: string;
  suggested: string;
  rationale?: string;
}

export interface BruteToolCall {
  tool: BruteToolName;
  arguments: ReadFileInput | RunCommandInput | SuggestEditInput;
}

export interface BruteToolEvent {
  tool: BruteToolName;
  title: string;
  detail: string;
  status: 'completed' | 'blocked';
}

export interface ToolResultEnvelope {
  ok: boolean;
  tool: BruteToolName;
  result?: unknown;
  error?: string;
}

export class BruteToolHost {
  async execute(call: BruteToolCall): Promise<{ envelope: ToolResultEnvelope; event: BruteToolEvent }> {
    const toolMode = getConfiguredToolMode();

    if (call.tool === 'suggest_edit' && toolMode === 'read-only') {
      return {
        envelope: {
          ok: false,
          tool: 'suggest_edit',
          error: 'Tool mode `read-only` does not allow edit suggestions.',
        },
        event: {
          tool: 'suggest_edit',
          title: 'Tool blocked',
          detail: 'Switch tool mode to `guided` or `full-access` to allow scaffold suggestions.',
          status: 'blocked',
        },
      };
    }

    switch (call.tool) {
      case 'read_file':
        return this.handleReadFile(call.arguments as ReadFileInput);
      case 'run_command':
        return this.handleRunCommand(call.arguments as RunCommandInput);
      case 'suggest_edit':
        return this.handleSuggestEdit(call.arguments as SuggestEditInput);
      default:
        return {
          envelope: {
            ok: false,
            tool: call.tool,
            error: `Unknown tool: ${String(call.tool)}`,
          },
          event: {
            tool: call.tool,
            title: 'Tool blocked',
            detail: `Unknown tool: ${String(call.tool)}`,
            status: 'blocked',
          },
        };
    }
  }

  static describeTools(mode: BruteToolMode): string {
    const modeLine = describeMode(mode);
    return [
      'You may use the following local tools when you truly need extra context.',
      `Current tool mode: \`${mode}\` - ${modeLine}`,
      '',
      '1. `read_file`',
      '   Arguments: `{ "path": string, "startLine"?: number, "endLine"?: number, "includeLineNumbers"?: boolean }`',
      '   Use for reading a specific workspace file or a bounded line range. In multi-root workspaces, you may prefix paths with the workspace folder name, for example `backend/src/index.ts`.',
      '   If you are not sure which folder or file exists, prefer `run_command` with discovery commands like `ls`, `pwd`, `find`, or `rg --files` instead of guessing a path.',
      '',
      '2. `run_command`',
      '   Arguments: `{ "command": string, "cwd"?: string, "timeoutMs"?: number }`',
      mode === 'full-access'
        ? '   Use for compile, test, or inspection commands such as `ls`, `npm test`, or `tsc --noEmit`. In `full-access`, commands run without a confirmation prompt.'
        : '   Use for compile, test, or inspection commands such as `ls`, `npm test`, or `tsc --noEmit`. The user will be asked before it runs.',
      '',
      '3. `suggest_edit`',
      '   Arguments: `{ "path": string, "startLine": number, "endLine": number, "intent": "boilerplate" | "comment" | "docstring" | "type-shape" | "fill-in-the-blank" | "todo-scaffold", "instruction": string, "suggested": string, "rationale"?: string }`',
      mode === 'read-only'
        ? '   Disabled in `read-only` mode.'
        : '   Use only for scaffolding, comments, docstrings, signatures, placeholder branches, or fill-in-the-blank code. Never use it to replace a full implementation.',
      '',
      'Web search is not implemented yet in this build.',
      '',
      'Tool call protocol:',
      'Return ONLY a fenced code block with language `brutetool` and a single JSON object, with no prose before or after it.',
      'Example:',
      '```brutetool',
      '{"tool":"read_file","arguments":{"path":"src/index.ts","startLine":1,"endLine":80}}',
      '```',
      '',
      'If you do not need a tool, answer normally.',
    ].join('\n');
  }

  private async handleReadFile(input: ReadFileInput): Promise<{ envelope: ToolResultEnvelope; event: BruteToolEvent }> {
    try {
      const filePath = await resolveWorkspacePath(input.path);
      const raw = await fs.readFile(filePath, 'utf8');
      const lines = raw.split(/\r?\n/);
      const totalLines = lines.length;
      const requestedStart = clampPositiveInteger(input.startLine ?? 1, 1);
      const requestedEnd = clampPositiveInteger(input.endLine ?? Math.min(totalLines, requestedStart + MAX_FILE_LINES - 1), requestedStart);
      const endLine = Math.min(requestedEnd, requestedStart + MAX_FILE_LINES - 1, totalLines);
      const selectedLines = lines.slice(requestedStart - 1, endLine);
      const content = (input.includeLineNumbers ?? true)
        ? selectedLines.map((line, index) => `${requestedStart + index}: ${line}`).join('\n')
        : selectedLines.join('\n');

      return {
        envelope: {
          ok: true,
          tool: 'read_file',
          result: {
            path: workspaceRelativePath(filePath),
            startLine: requestedStart,
            endLine,
            totalLines,
            content,
          },
        },
        event: {
          tool: 'read_file',
          title: 'Read file',
          detail: `\`${workspaceRelativePath(filePath)}:${requestedStart}-${endLine}\``,
          status: 'completed',
        },
      };
    } catch (error) {
      return toolFailure('read_file', error);
    }
  }

  private async handleRunCommand(input: RunCommandInput): Promise<{ envelope: ToolResultEnvelope; event: BruteToolEvent }> {
    const command = input.command.trim();
    if (!command) {
      return toolFailure('run_command', new Error('Command must not be empty.'));
    }

    try {
      const cwd = input.cwd ? await resolveWorkspacePath(input.cwd) : await getPreferredWorkspacePath();
      const timeoutMs = clampPositiveInteger(input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 1000);
      const toolMode = getConfiguredToolMode();

      if (toolMode !== 'full-access') {
        const approved = await vscode.window.showWarningMessage(
          `Allow BruteCoding to run \`${command}\` in ${workspaceRelativePath(cwd)}?`,
          { modal: true },
          'Run',
          'Cancel'
        );

        if (approved !== 'Run') {
          return {
            envelope: {
              ok: false,
              tool: 'run_command',
              error: 'User declined to run the command.',
            },
            event: {
              tool: 'run_command',
              title: 'Command blocked',
              detail: `\`${command}\``,
              status: 'blocked',
            },
          };
        }
      }

      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_OUTPUT * 2,
      });

      return {
        envelope: {
          ok: true,
          tool: 'run_command',
          result: {
            command,
            cwd: workspaceRelativePath(cwd),
            exitCode: 0,
            stdout: trimOutput(stdout),
            stderr: trimOutput(stderr),
            timedOut: false,
          },
        },
        event: {
          tool: 'run_command',
          title: 'Ran command',
          detail: `\`${command}\` in \`${workspaceRelativePath(cwd)}\``,
          status: 'completed',
        },
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
      return {
        envelope: {
          ok: false,
          tool: 'run_command',
          error: err.message,
          result: {
            command,
            cwd: input.cwd ?? '.',
            exitCode: typeof err.code === 'number' ? err.code : null,
            stdout: trimOutput(err.stdout ?? ''),
            stderr: trimOutput(err.stderr ?? ''),
            timedOut: Boolean(err.killed),
          },
        },
        event: {
          tool: 'run_command',
          title: 'Command failed',
          detail: `\`${command}\``,
          status: 'blocked',
        },
      };
    }
  }

  private async handleSuggestEdit(input: SuggestEditInput): Promise<{ envelope: ToolResultEnvelope; event: BruteToolEvent }> {
    try {
      const filePath = await resolveWorkspacePath(input.path);
      const raw = await fs.readFile(filePath, 'utf8');
      const lines = raw.split(/\r?\n/);
      const startLine = clampPositiveInteger(input.startLine, 1);
      const endLine = clampPositiveInteger(input.endLine, startLine);

      if (endLine - startLine + 1 > MAX_FILE_LINES) {
        throw new Error(`Suggested edit range is too large. Keep it within ${MAX_FILE_LINES} lines.`);
      }

      const original = lines.slice(startLine - 1, endLine).join('\n');

      return {
        envelope: {
          ok: true,
          tool: 'suggest_edit',
          result: {
            path: workspaceRelativePath(filePath),
            startLine,
            endLine,
            intent: input.intent,
            instruction: input.instruction,
            original,
            suggested: input.suggested,
            rationale: input.rationale ?? '',
          },
        },
        event: {
          tool: 'suggest_edit',
          title: 'Suggested scaffold',
          detail: [
            `\`${workspaceRelativePath(filePath)}:${startLine}-${endLine}\``,
            '',
            `Intent: \`${input.intent}\``,
            '',
            `Instruction: ${input.instruction}`,
            '',
            '```',
            input.suggested,
            '```',
          ].join('\n'),
          status: 'completed',
        },
      };
    } catch (error) {
      return toolFailure('suggest_edit', error);
    }
  }
}

export function tryParseToolCall(message: string): BruteToolCall | null {
  const trimmed = message.trim();
  const match = trimmed.match(/^```brutetool\s*([\s\S]*?)```$/);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1].trim()) as Partial<BruteToolCall>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.tool !== 'string' || typeof parsed.arguments !== 'object') {
      return null;
    }
    if (!['read_file', 'run_command', 'suggest_edit'].includes(parsed.tool)) {
      return null;
    }
    return parsed as BruteToolCall;
  } catch {
    return null;
  }
}

export function formatToolResult(envelope: ToolResultEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

async function resolveWorkspacePath(targetPath: string): Promise<string> {
  const folders = getWorkspaceFolders();
  const normalizedTargetPath = targetPath.trim();

  if (path.isAbsolute(normalizedTargetPath)) {
    const matchingFolder = folders.find(folder => isInsideWorkspace(folder.uri.fsPath, normalizedTargetPath));
    if (!matchingFolder) {
      throw new Error(`Path must stay inside the workspace: ${targetPath}`);
    }
    return normalizedTargetPath;
  }

  const explicitFolderMatch = resolveAgainstNamedWorkspaceFolder(normalizedTargetPath, folders);
  if (explicitFolderMatch) {
    return explicitFolderMatch;
  }

  for (const folder of folders) {
    const candidate = path.resolve(folder.uri.fsPath, normalizedTargetPath);
    if (!isInsideWorkspace(folder.uri.fsPath, candidate)) {
      continue;
    }
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  const fallback = path.resolve(folders[0].uri.fsPath, normalizedTargetPath);
  if (!isInsideWorkspace(folders[0].uri.fsPath, fallback)) {
    throw new Error(`Path must stay inside the workspace: ${targetPath}`);
  }
  return fallback;
}

async function getPrimaryWorkspacePath(): Promise<string> {
  return getWorkspaceFolders()[0].uri.fsPath;
}

async function getPreferredWorkspacePath(): Promise<string> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) {
      return activeFolder.uri.fsPath;
    }
  }

  return getPrimaryWorkspacePath();
}

function workspaceRelativePath(targetPath: string): string {
  const matchingFolder = vscode.workspace.workspaceFolders?.find(folder =>
    isInsideWorkspace(folder.uri.fsPath, targetPath)
  );
  if (!matchingFolder) {
    return targetPath;
  }

  const relativePath = path.relative(matchingFolder.uri.fsPath, targetPath) || '.';
  if ((vscode.workspace.workspaceFolders?.length ?? 0) === 1) {
    return relativePath;
  }

  return relativePath === '.' ? matchingFolder.name : `${matchingFolder.name}/${relativePath}`;
}

function getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    throw new Error('No workspace folder is open.');
  }
  return folders;
}

function resolveAgainstNamedWorkspaceFolder(
  targetPath: string,
  folders: readonly vscode.WorkspaceFolder[]
): string | null {
  const [firstSegment, ...remainingSegments] = targetPath.split(/[\\/]/);
  const matchingFolder = folders.find(folder => folder.name === firstSegment);
  if (!matchingFolder) {
    return null;
  }

  const remainder = remainingSegments.join(path.sep);
  const resolved = remainder
    ? path.resolve(matchingFolder.uri.fsPath, remainder)
    : matchingFolder.uri.fsPath;

  if (!isInsideWorkspace(matchingFolder.uri.fsPath, resolved)) {
    throw new Error(`Path must stay inside the workspace: ${targetPath}`);
  }

  return resolved;
}

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function getConfiguredToolMode(): BruteToolMode {
  return vscode.workspace
    .getConfiguration('bruteCoding')
    .get<BruteToolMode>('toolMode', 'guided');
}

function describeMode(mode: BruteToolMode): string {
  switch (mode) {
    case 'read-only':
      return 'file reads plus confirmed shell commands';
    case 'full-access':
      return 'reads, shell commands without confirmation, and scaffold suggestions';
    case 'guided':
    default:
      return 'reads, confirmed shell commands, and scaffold suggestions';
  }
}

function clampPositiveInteger(value: number, min: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.floor(value));
}

function trimOutput(output: string): string {
  return output.length > MAX_COMMAND_OUTPUT ? `${output.slice(0, MAX_COMMAND_OUTPUT)}\n...[truncated]` : output;
}

function toolFailure(tool: BruteToolName, error: unknown): { envelope: ToolResultEnvelope; event: BruteToolEvent } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    envelope: {
      ok: false,
      tool,
      error: message,
    },
    event: {
      tool,
      title: 'Tool failed',
      detail: message,
      status: 'blocked',
    },
  };
}
