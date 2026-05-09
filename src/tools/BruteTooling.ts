import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const MAX_FILE_LINES = 200;
const MAX_LIST_ENTRIES = 200;
const MAX_COMMAND_OUTPUT = 12000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const TERMINAL_SHELL_INTEGRATION_TIMEOUT_MS = 3000;
const BRUTE_TERMINAL_NAME = 'BruteCoding Tools';
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, 'g');

let bruteTerminal: vscode.Terminal | undefined;

export type BruteToolName = 'workspace_info' | 'list_files' | 'read_file' | 'run_command' | 'suggest_edit';
export type BruteToolMode = 'read-only' | 'guided' | 'full-access';
export type BruteCommandRunner = 'background' | 'vscode-terminal';

export interface WorkspaceInfoInput {
  includeTopLevelFiles?: boolean;
}

export interface ListFilesInput {
  path?: string;
  maxDepth?: number;
  maxEntries?: number;
}

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
  requiresApproval?: boolean;
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
  arguments: WorkspaceInfoInput | ListFilesInput | ReadFileInput | RunCommandInput | SuggestEditInput;
}

export interface BruteToolEvent {
  tool: BruteToolName;
  title: string;
  detail: string;
  status: 'completed' | 'blocked';
}

export interface CommandApprovalRequest {
  command: string;
  cwd: string;
  reason: string;
}

export interface BruteToolHostOptions {
  requestCommandApproval?: (request: CommandApprovalRequest) => Promise<boolean>;
}

export interface ToolResultEnvelope {
  ok: boolean;
  tool: BruteToolName;
  result?: unknown;
  error?: string;
}

export class BruteToolHost {
  constructor(private readonly options: BruteToolHostOptions = {}) {}

  async execute(call: BruteToolCall): Promise<{ envelope: ToolResultEnvelope; event: BruteToolEvent }> {
    const toolMode = getConfiguredToolMode();

    if (call.tool === 'run_command' && toolMode === 'read-only') {
      return {
        envelope: {
          ok: false,
          tool: 'run_command',
          error: 'Tool mode `read-only` does not allow shell commands. Use `workspace_info`, `list_files`, or `read_file` instead.',
        },
        event: {
          tool: 'run_command',
          title: 'Tool blocked',
          detail: 'Read-only mode does not allow shell commands.',
          status: 'blocked',
        },
      };
    }

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
      case 'workspace_info':
        return this.handleWorkspaceInfo(call.arguments as WorkspaceInfoInput);
      case 'list_files':
        return this.handleListFiles(call.arguments as ListFilesInput);
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
    const runner = getConfiguredCommandRunner();
    const runnerLine = runner === 'background'
      ? 'Commands run in the background with output captured in the tool tray.'
      : 'Commands run in the BruteCoding Tools VS Code terminal.';
    return [
      'You may use the following local tools when you truly need extra context.',
      `Current tool mode: \`${mode}\` - ${modeLine}`,
      `Current command runner: \`${runner}\` - ${runnerLine}`,
      '',
      '1. `workspace_info`',
      '   Arguments: `{ "includeTopLevelFiles"?: boolean }`',
      '   Use this first when you need to orient yourself. It reports workspace folders, the active file, and optionally top-level files.',
      '',
      '2. `list_files`',
      '   Arguments: `{ "path"?: string, "maxDepth"?: number, "maxEntries"?: number }`',
      '   Use this before reading guessed paths. It is workspace-contained and does not require user confirmation.',
      '',
      '3. `read_file`',
      '   Arguments: `{ "path": string, "startLine"?: number, "endLine"?: number, "includeLineNumbers"?: boolean }`',
      '   Use for reading a specific workspace file or a bounded line range. In multi-root workspaces, you may prefix paths with the workspace folder name, for example `backend/src/index.ts`.',
      '   If you are not sure which folder or file exists, use `workspace_info` or `list_files` before guessing a path.',
      '',
      '4. `run_command`',
      '   Arguments: `{ "command": string, "cwd"?: string, "timeoutMs"?: number, "requiresApproval"?: boolean }`',
      mode === 'read-only'
        ? '   Disabled in `read-only` mode. Use `workspace_info`, `list_files`, and `read_file` instead.'
        : mode === 'full-access'
          ? '   Use for compile, test, or inspection commands such as `npm test` or `tsc --noEmit`. In `full-access`, commands run without a confirmation prompt, but destructive commands are blocked.'
          : '   Use for compile, test, run, or inspection commands such as `cargo run`, `npm test`, or `tsc --noEmit`. In `guided`, low-risk local project commands can run without a prompt; installs, deletes, network calls, configuration changes, and unclear side effects require user approval.',
      mode === 'read-only'
        ? ''
        : '   Set `requiresApproval` to `false` only for low-risk local commands such as `pwd`, `ls`, `rg --files`, `git status`, `cargo check`, `cargo test`, `cargo run`, `npm test`, or `npm run build`. Set it to `true` for installs, deletes, network calls, configuration changes, or anything you are unsure about.',
      '',
      '5. `suggest_edit`',
      '   Arguments: `{ "path": string, "startLine": number, "endLine": number, "intent": "boilerplate" | "comment" | "docstring" | "type-shape" | "fill-in-the-blank" | "todo-scaffold", "instruction": string, "suggested": string, "rationale"?: string }`',
      mode === 'read-only'
        ? '   Disabled in `read-only` mode.'
        : '   Use only to propose scaffolding, comments, docstrings, signatures, placeholder branches, or fill-in-the-blank code. This tool does not edit files directly; after it returns, tell the student what to add. Never use it to replace a full implementation.',
      '',
      'Web search is not implemented yet in this build.',
      '',
      'Tool call protocol:',
      'When you use a tool, your assistant response must contain only one or more fenced code blocks with language `brutetool`.',
      'Do not include prose before or after tool calls. After the tool result is returned, continue normally.',
      'Each `brutetool` block must contain exactly one JSON object with `tool` and `arguments` keys.',
      'Never use XML tags such as `<tool_call>`, `<function=...>`, or `<parameter=...>`.',
      '',
      'Good examples:',
      '',
      'Check the workspace before guessing paths:',
      '```brutetool',
      '{"tool":"workspace_info","arguments":{"includeTopLevelFiles":true}}',
      '```',
      '',
      'List files in a known folder:',
      '```brutetool',
      '{"tool":"list_files","arguments":{"path":".","maxDepth":2}}',
      '```',
      '',
      'Read a bounded file range:',
      '```brutetool',
      '{"tool":"read_file","arguments":{"path":"src/index.ts","startLine":1,"endLine":80,"includeLineNumbers":true}}',
      '```',
      '',
      'Run a safe read-only discovery command:',
      '```brutetool',
      '{"tool":"run_command","arguments":{"command":"pwd && ls","requiresApproval":false}}',
      '```',
      '',
      'Run a command with possible side effects:',
      '```brutetool',
      '{"tool":"run_command","arguments":{"command":"npm install","requiresApproval":true}}',
      '```',
      '',
      'Suggest a small comment scaffold:',
      '```brutetool',
      '{"tool":"suggest_edit","arguments":{"path":"src/main.rs","startLine":1,"endLine":1,"intent":"comment","instruction":"Add a short file-level comment explaining what this file is for.","suggested":"// TODO: describe the program entry point here.","rationale":"A small comment prompt keeps the student doing the actual writing."}}',
      '```',
      '',
      'Use multiple tools by returning multiple fenced blocks and nothing else:',
      '```brutetool',
      '{"tool":"workspace_info","arguments":{"includeTopLevelFiles":true}}',
      '```',
      '```brutetool',
      '{"tool":"read_file","arguments":{"path":"package.json","startLine":1,"endLine":120}}',
      '```',
      '',
      'Bad format, do not do this:',
      '<tool_call><function=read_file><parameter=path>src/index.ts</parameter></function></tool_call>',
      '',
      'If you do not need a tool, answer normally.',
    ].join('\n');
  }

  private async handleWorkspaceInfo(input: WorkspaceInfoInput): Promise<{ envelope: ToolResultEnvelope; event: BruteToolEvent }> {
    try {
      const folders = getWorkspaceFolders();
      const preferredPath = await getPreferredWorkspacePath();
      const activeDocument = vscode.window.activeTextEditor?.document;
      const includeTopLevelFiles = input.includeTopLevelFiles ?? true;

      const topLevel = includeTopLevelFiles
        ? await Promise.all(folders.map(async folder => ({
          folder: folder.name,
          entries: await listDirectory(folder.uri.fsPath, 1, 50),
        })))
        : undefined;

      return {
        envelope: {
          ok: true,
          tool: 'workspace_info',
          result: {
            workspaceFolders: folders.map(folder => ({
              name: folder.name,
              path: folder.uri.fsPath,
            })),
            preferredCwd: workspaceRelativePath(preferredPath),
            activeFile: activeDocument ? {
              path: workspaceRelativePath(activeDocument.uri.fsPath),
              languageId: activeDocument.languageId,
            } : null,
            topLevel,
          },
        },
        event: {
          tool: 'workspace_info',
          title: 'Checked workspace',
          detail: `Preferred cwd: \`${workspaceRelativePath(preferredPath)}\``,
          status: 'completed',
        },
      };
    } catch (error) {
      return toolFailure('workspace_info', error);
    }
  }

  private async handleListFiles(input: ListFilesInput): Promise<{ envelope: ToolResultEnvelope; event: BruteToolEvent }> {
    try {
      const requestedPath = input.path?.trim() || '.';
      const targetPath = await resolveWorkspacePath(requestedPath);
      const stats = await fs.stat(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${requestedPath}`);
      }

      const maxDepth = Math.min(clampPositiveInteger(input.maxDepth ?? 2, 1), 5);
      const maxEntries = Math.min(clampPositiveInteger(input.maxEntries ?? MAX_LIST_ENTRIES, 1), MAX_LIST_ENTRIES);
      const entries = await listDirectory(targetPath, maxDepth, maxEntries);

      return {
        envelope: {
          ok: true,
          tool: 'list_files',
          result: {
            path: workspaceRelativePath(targetPath),
            maxDepth,
            maxEntries,
            entries,
            truncated: entries.length >= maxEntries,
          },
        },
        event: {
          tool: 'list_files',
          title: 'Listed files',
          detail: `\`${workspaceRelativePath(targetPath)}\` (${entries.length} entries)`,
          status: 'completed',
        },
      };
    } catch (error) {
      return toolFailure('list_files', error);
    }
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

    let cwdForResult = input.cwd ?? '.';

    try {
      const cwd = input.cwd ? await resolveWorkspacePath(input.cwd) : await getPreferredWorkspacePath();
      cwdForResult = workspaceRelativePath(cwd);
      const timeoutMs = clampPositiveInteger(input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 1000);
      const toolMode = getConfiguredToolMode();
      const blockedReason = blockedShellCommandReason(command);
      if (blockedReason) {
        return {
          envelope: {
            ok: false,
            tool: 'run_command',
            error: blockedReason,
            result: {
              command,
              cwd: cwdForResult,
              exitCode: null,
              stdout: '',
              stderr: '',
              timedOut: false,
            },
          },
          event: {
            tool: 'run_command',
            title: 'Command blocked',
            detail: `${blockedReason}\n\n\`${command}\``,
            status: 'blocked',
          },
        };
      }

      const approval = getCommandApprovalDecision(command, input.requiresApproval);

      if (toolMode !== 'full-access' && approval.requiresPrompt) {
        const approved = await this.requestCommandApproval({
          command,
          cwd: workspaceRelativePath(cwd),
          reason: approval.reason,
        });

        if (!approved) {
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

      const result = await executeCommand(command, cwd, timeoutMs, approval.canRetryWithExec);
      const commandStatus = getCommandStatus(result);

      return {
        envelope: {
          ok: true,
          tool: 'run_command',
          result: {
            command,
            cwd: workspaceRelativePath(cwd),
            exitCode: result.exitCode,
            stdout: trimOutput(result.stdout),
            stderr: trimOutput(result.stderr),
            timedOut: result.timedOut,
            runner: result.runner,
            exitCodeKnown: result.exitCodeKnown,
            approval: toolMode === 'full-access' ? 'full-access' : approval.label,
          },
        },
        event: {
          tool: 'run_command',
          title: commandStatus.title,
          detail: formatCommandEventDetail(command, cwd, result, toolMode === 'full-access' ? 'full-access' : approval.label),
          status: commandStatus.status,
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
            cwd: cwdForResult,
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
      const allowedIntents: SuggestEditInput['intent'][] = [
        'boilerplate',
        'comment',
        'docstring',
        'type-shape',
        'fill-in-the-blank',
        'todo-scaffold',
      ];
      if (!allowedIntents.includes(input.intent)) {
        throw new Error(`Unsupported suggest_edit intent: ${String(input.intent)}`);
      }
      if (input.suggested.length > 4000) {
        throw new Error('Suggested scaffold is too large. Keep suggestions short and partial.');
      }
      if (looksLikeFullImplementation(input.suggested)) {
        throw new Error('Suggested scaffold looks like a full implementation. Keep it partial: signatures, comments, TODOs, or fill-in-the-blank shapes only.');
      }

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

  private async requestCommandApproval(request: CommandApprovalRequest): Promise<boolean> {
    if (this.options.requestCommandApproval) {
      return this.options.requestCommandApproval(request);
    }

    const approved = await vscode.window.showWarningMessage(
      `Allow BruteCoding to run \`${request.command}\` in ${request.cwd}?\n\n${request.reason}`,
      { modal: true },
      'Run'
    );
    return approved === 'Run';
  }
}

export function tryParseToolCall(message: string): BruteToolCall | null {
  return tryParseToolCalls(message)[0] ?? null;
}

export function tryParseToolCalls(message: string): BruteToolCall[] {
  const trimmed = message.trim();
  const calls: BruteToolCall[] = [];

  const matches = [...trimmed.matchAll(/```brutetool\s*([\s\S]*?)```/g)];
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1].trim()) as Partial<BruteToolCall>;
      if (!isValidToolCall(parsed)) {
        continue;
      }
      calls.push(parsed);
    } catch {
      continue;
    }
  }

  calls.push(...tryParseXmlishToolCalls(trimmed));
  return calls;
}

function isValidToolCall(value: unknown): value is BruteToolCall {
  return isRecord(value) &&
    typeof value.tool === 'string' &&
    isRecord(value.arguments) &&
    ['workspace_info', 'list_files', 'read_file', 'run_command', 'suggest_edit'].includes(value.tool);
}

function tryParseXmlishToolCalls(message: string): BruteToolCall[] {
  const calls: BruteToolCall[] = [];
  const blocks = [...message.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)];

  for (const block of blocks) {
    const body = block[1];
    const functionMatch = body.match(/<function=([a-z_]+)>\s*([\s\S]*?)<\/function>/i);
    if (!functionMatch) {
      continue;
    }

    const tool = functionMatch[1] as BruteToolName;
    if (!['workspace_info', 'list_files', 'read_file', 'run_command', 'suggest_edit'].includes(tool)) {
      continue;
    }

    const parameters = functionMatch[2];
    const args: Record<string, unknown> = {};
    for (const parameter of parameters.matchAll(/<parameter=([a-zA-Z0-9_]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) {
      args[parameter[1]] = parseXmlishParameterValue(parameter[2]);
    }

    calls.push({ tool, arguments: args });
  }

  return calls;
}

function parseXmlishParameterValue(value: string): unknown {
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === 'true';
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

export function formatToolResult(envelope: unknown): string {
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
  const configured = vscode.workspace
    .getConfiguration('bruteCoding')
    .get<BruteToolMode>('toolMode', 'guided');

  return ['read-only', 'guided', 'full-access'].includes(configured) ? configured : 'guided';
}

export function getConfiguredCommandRunner(): BruteCommandRunner {
  const configured = vscode.workspace
    .getConfiguration('bruteCoding')
    .get<BruteCommandRunner>('commandRunner', 'background');

  return ['background', 'vscode-terminal'].includes(configured) ? configured : 'background';
}

function describeMode(mode: BruteToolMode): string {
  switch (mode) {
    case 'read-only':
      return 'workspace info, file listing, and file reads only';
    case 'full-access':
      return 'reads, shell commands without confirmation, and scaffold suggestions; destructive shell commands are still blocked';
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
  const withoutAnsi = output.replace(ANSI_ESCAPE_PATTERN, '');
  return withoutAnsi.length > MAX_COMMAND_OUTPUT ? `${withoutAnsi.slice(0, MAX_COMMAND_OUTPUT)}\n...[truncated]` : withoutAnsi;
}

async function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  canRetryWithExec: boolean
): Promise<CommandExecutionResult> {
  if (getConfiguredCommandRunner() === 'background') {
    return executeCommandInBackground(command, cwd, timeoutMs);
  }

  return executeCommandInTerminal(command, cwd, timeoutMs, canRetryWithExec);
}

async function executeCommandInTerminal(
  command: string,
  cwd: string,
  timeoutMs: number,
  canRetryWithExec: boolean
): Promise<CommandExecutionResult> {
  const terminal = await getBruteTerminal(cwd);
  if (terminal.shellIntegration) {
    terminal.show(false);
    const execution = terminal.shellIntegration.executeCommand(command);
    const outputBuffer = createTerminalOutputBuffer(execution);
    const exitPromise = waitForTerminalExecutionEnd(execution, timeoutMs);
    const timeoutPromise = delay(timeoutMs).then(() => 'timeout' as const);

    const exitResult = await Promise.race([exitPromise, timeoutPromise]);
    await delay(100);
    const stdout = outputBuffer.read();

    if (exitResult === 'timeout') {
      terminal.sendText('\u0003', false);
      return {
        exitCode: null,
        stdout,
        stderr: `Command timed out after ${timeoutMs}ms.`,
        timedOut: true,
        runner: 'terminal',
        exitCodeKnown: false,
      };
    }

    if (exitResult.exitCode === undefined && canRetryWithExec) {
      return executeCommandWithExec(command, cwd, timeoutMs, 'exec-fallback');
    }

    return {
      exitCode: exitResult.exitCode ?? null,
      stdout,
      stderr: '',
      timedOut: false,
      runner: 'terminal',
      exitCodeKnown: exitResult.exitCode !== undefined,
    };
  }

  return executeCommandWithExec(command, cwd, timeoutMs, 'exec');
}

interface CommandExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  runner: 'background' | 'terminal' | 'exec' | 'exec-fallback';
  exitCodeKnown: boolean;
}

function executeCommandInBackground(command: string, cwd: string, timeoutMs: number): Promise<CommandExecutionResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        SYSTEMD_PAGER: '',
        MANPAGER: 'cat',
      },
    });

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}Command timed out after ${timeoutMs}ms.`,
        timedOut: true,
        runner: 'background',
        exitCodeKnown: false,
      });
    }, timeoutMs);

    child.stdout?.on('data', chunk => {
      stdout = appendBoundedOutput(stdout, chunk.toString());
    });

    child.stderr?.on('data', chunk => {
      stderr = appendBoundedOutput(stderr, chunk.toString());
    });

    child.on('error', error => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        stdout,
        stderr: appendBoundedOutput(stderr, error.message),
        timedOut: false,
        runner: 'background',
        exitCodeKnown: false,
      });
    });

    child.on('close', code => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut: false,
        runner: 'background',
        exitCodeKnown: true,
      });
    });
  });
}

function appendBoundedOutput(current: string, next: string): string {
  const combined = current + next;
  return combined.length > MAX_COMMAND_OUTPUT * 2
    ? `${combined.slice(0, MAX_COMMAND_OUTPUT * 2)}\n...[truncated]`
    : combined;
}

async function executeCommandWithExec(
  command: string,
  cwd: string,
  timeoutMs: number,
  runner: 'exec' | 'exec-fallback'
): Promise<CommandExecutionResult> {
  const { stdout, stderr } = await execAsync(command, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_COMMAND_OUTPUT * 2,
  });

  return {
    exitCode: 0,
    stdout,
    stderr,
    timedOut: false,
    runner,
    exitCodeKnown: true,
  };
}

function getCommandStatus(result: CommandExecutionResult): { title: string; status: BruteToolEvent['status'] } {
  if (result.timedOut) {
    return { title: 'Command timed out', status: 'blocked' };
  }
  if (!result.exitCodeKnown) {
    return { title: 'Command completed', status: 'completed' };
  }
  return result.exitCode === 0
    ? { title: 'Ran command', status: 'completed' }
    : { title: 'Command failed', status: 'blocked' };
}

function formatCommandEventDetail(
  command: string,
  cwd: string,
  result: CommandExecutionResult,
  approval: string
): string {
  const exitDetail = result.exitCodeKnown ? `exit ${result.exitCode}` : 'exit unknown';
  const extra = result.stderr ? `\n${trimOutput(result.stderr)}` : '';
  return `\`${command}\` in \`${workspaceRelativePath(cwd)}\` via ${result.runner} (${approval}, ${exitDetail})${extra}`;
}

async function getBruteTerminal(cwd: string): Promise<vscode.Terminal> {
  if (!bruteTerminal || bruteTerminal.exitStatus) {
    bruteTerminal = vscode.window.createTerminal({
      name: BRUTE_TERMINAL_NAME,
      cwd,
      isTransient: true,
    });
    bruteTerminal.show(false);
  }

  if (!bruteTerminal.shellIntegration) {
    await waitForShellIntegration(bruteTerminal, TERMINAL_SHELL_INTEGRATION_TIMEOUT_MS);
  }

  return bruteTerminal;
}

function waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<void> {
  if (terminal.shellIntegration) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      resolve();
    }, timeoutMs);

    const disposable = vscode.window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal === terminal) {
        clearTimeout(timeout);
        disposable.dispose();
        resolve();
      }
    });
  });
}

function createTerminalOutputBuffer(execution: vscode.TerminalShellExecution): { read: () => string } {
  let output = '';

  void (async () => {
    try {
      for await (const chunk of execution.read()) {
        output += chunk;
        if (output.length > MAX_COMMAND_OUTPUT * 2) {
          output = `${output.slice(0, MAX_COMMAND_OUTPUT * 2)}\n...[truncated]`;
          break;
        }
      }
    } catch {
      // Terminal output capture is best-effort; command completion is tracked separately.
    }

  })();

  return {
    read: () => output,
  };
}

function waitForTerminalExecutionEnd(
  execution: vscode.TerminalShellExecution,
  timeoutMs: number
): Promise<{ exitCode: number | undefined }> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      resolve({ exitCode: undefined });
    }, timeoutMs + 1000);

    const disposable = vscode.window.onDidEndTerminalShellExecution(event => {
      if (event.execution === execution) {
        clearTimeout(timeout);
        disposable.dispose();
        resolve({ exitCode: event.exitCode });
      }
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listDirectory(rootPath: string, maxDepth: number, maxEntries: number): Promise<Array<{ path: string; type: 'file' | 'directory' }>> {
  const results: Array<{ path: string; type: 'file' | 'directory' }> = [];
  await collectDirectoryEntries(rootPath, rootPath, maxDepth, maxEntries, results);
  return results;
}

async function collectDirectoryEntries(
  basePath: string,
  currentPath: string,
  depthRemaining: number,
  maxEntries: number,
  results: Array<{ path: string; type: 'file' | 'directory' }>
): Promise<void> {
  if (results.length >= maxEntries) {
    return;
  }

  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const sortedEntries = entries
    .filter(entry => !shouldSkipDirectoryEntry(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  for (const entry of sortedEntries) {
    if (results.length >= maxEntries) {
      return;
    }

    const fullPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(basePath, fullPath) || '.';
    const type = entry.isDirectory() ? 'directory' : 'file';
    results.push({ path: relativePath, type });

    if (entry.isDirectory() && depthRemaining > 1) {
      await collectDirectoryEntries(basePath, fullPath, depthRemaining - 1, maxEntries, results);
    }
  }
}

function shouldSkipDirectoryEntry(name: string): boolean {
  return [
    '.git',
    '.vscode-test',
    'coverage',
    'dist',
    'node_modules',
    'out',
  ].includes(name);
}

interface CommandApprovalDecision {
  requiresPrompt: boolean;
  canRetryWithExec: boolean;
  label: string;
  reason: string;
}

function getCommandApprovalDecision(command: string, modelRequiresApproval: boolean | undefined): CommandApprovalDecision {
  const isSafe = isSafeReadOnlyShellCommand(command);

  if (modelRequiresApproval === true) {
    return {
      requiresPrompt: true,
      canRetryWithExec: false,
      label: 'approval requested',
      reason: 'The model marked this command as requiring approval.',
    };
  }

  if (isSafe) {
    return {
      requiresPrompt: false,
      canRetryWithExec: true,
      label: modelRequiresApproval === false ? 'auto-approved local command' : 'auto-approved inferred-local command',
      reason: 'BruteCoding verified this as a low-risk local command.',
    };
  }

  return {
    requiresPrompt: true,
    canRetryWithExec: false,
    label: modelRequiresApproval === false ? 'approval required after safety check' : 'approval required',
    reason: modelRequiresApproval === false
      ? 'The model marked this command as safe, but BruteCoding could not verify it as a low-risk local command.'
      : 'BruteCoding only auto-approves known low-risk local commands.',
  };
}

function isSafeReadOnlyShellCommand(command: string): boolean {
  if (/[|<>`]/.test(command) || /\$\(/.test(command)) {
    return false;
  }

  const parts = command
    .split(/\s*(?:&&|;)\s*/g)
    .map(part => part.trim())
    .filter(Boolean);

  return parts.length > 0 && parts.every(isSafeReadOnlyCommandPart);
}

function isSafeReadOnlyCommandPart(command: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (!normalized || /\b(--output|-o|--out|--write|--replace|--jsonl)\b/.test(lower)) {
    return false;
  }

  const safePatterns = [
    /^(pwd|get-location)(\s+[-\w]+)?$/i,
    /^(ls|dir|get-childitem|tree)(\s+[\w./\\:*?"'\-[\]=,]+)*$/i,
    /^rg(\s+[\w./\\:*?"'\-[\]=,+@]+)*$/i,
    /^findstr(\s+[\w./\\:*?"'\-[\]=,+@]+)*$/i,
    /^git\s+(status|diff|log|show|branch|remote|rev-parse)(\s+[\w./\\:*?"'\-[\]=,+@]+)*$/i,
    /^npm\s+(test|audit)(\s+--[\w:-]+)*$/i,
    /^npm\s+run\s+(build|compile|lint|test|typecheck|check)(\s+--[\w:-]+)*$/i,
    /^npx\s+tsc\s+--noemit(\s+[\w./\\:*?"'\-[\]=,+@]+)*$/i,
    /^cargo\s+(check|build|test|run|clippy)(\s+[\w./\\:*?"'\-[\]=,+@]+)*$/i,
    /^cargo\s+fmt(\s+--\s+--check)?$/i,
    /^rustc\s+--version$/i,
    /^rustup\s+show(\s+[\w:-]+)*$/i,
  ];

  return safePatterns.some(pattern => pattern.test(normalized));
}

function blockedShellCommandReason(command: string): string | null {
  const normalized = command.toLowerCase();
  const blockedPatterns = [
    /\brm\s+(-[^\s]*r|-[^\s]*f)/,
    /\bremove-item\b.*\s-(recurse|force)\b/,
    /\brmdir\b/,
    /\bdel\b/,
    /\berase\b/,
    /\bformat\b/,
    /\bshutdown\b/,
    /\brestart-computer\b/,
    /\bstop-computer\b/,
    /\bgit\s+(reset|clean)\b/,
    /\bset-content\b.*(\.ssh|id_rsa|authorized_keys)/,
    /\bget-content\b.*(\.ssh|id_rsa|id_dsa|id_ecdsa|id_ed25519)/,
    /\bcat\b.*(\.ssh|id_rsa|id_dsa|id_ecdsa|id_ed25519)/,
  ];

  return blockedPatterns.some(pattern => pattern.test(normalized))
    ? 'Command is blocked by BruteCoding safety rules.'
    : null;
}

function looksLikeFullImplementation(suggested: string): boolean {
  const lines = suggested
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length > 40) {
    return true;
  }

  const executableLineCount = lines.filter(line =>
    !line.startsWith('//') &&
    !line.startsWith('#') &&
    !line.startsWith('*') &&
    !line.includes('TODO') &&
    !line.includes('...') &&
    !line.includes('___')
  ).length;

  return executableLineCount > 12;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toolFailure(tool: BruteToolName, error: unknown): { envelope: ToolResultEnvelope; event: BruteToolEvent } {
  const message = error instanceof Error ? error.message : String(error);
  const recovery = getToolRecoveryHint(tool, error, message);
  return {
    envelope: {
      ok: false,
      tool,
      error: message,
      ...(recovery ? { result: { recovery } } : {}),
    },
    event: {
      tool,
      title: 'Tool failed',
      detail: recovery ? `${message}\n\n${recovery}` : message,
      status: 'blocked',
    },
  };
}

function getToolRecoveryHint(tool: BruteToolName, error: unknown, message: string): string | null {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const isPathTool = tool === 'read_file' || tool === 'list_files' || tool === 'suggest_edit';
  const looksLikeMissingPath = code === 'ENOENT' || /no such file|cannot find|path .*does not exist/i.test(message);

  if (isPathTool && looksLikeMissingPath) {
    return [
      'Recovery hint: the path is probably wrong.',
      'Use `workspace_info` or `list_files` to confirm the workspace root and actual file paths, then retry the original tool with the corrected relative path.',
      'Do not ask the user to fix this until you have tried one obvious path-discovery step.',
    ].join(' ');
  }

  if (tool === 'run_command' && /not recognized|command not found|not found/i.test(message)) {
    return 'Recovery hint: the command may not exist on this system. Check the project scripts or use a more portable discovery command before giving up.';
  }

  return null;
}
