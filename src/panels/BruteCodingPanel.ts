import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BruteAgent, TaskCard } from '../agent/BruteAgent';
import {
  archiveAgentSession,
  deleteSavedSession,
  getSavedSession,
  hydrateSavedProject,
  listSavedSessions,
} from '../agent/SessionStore';
import {
  apiKeyEnvForProvider,
  createProvider,
  createProviderPreview,
  getStoredApiKey,
  storeApiKey,
} from '../models/providerFactory';
import { getOpenRouterModels } from '../models/OpenRouterModels';
import { BruteToolEvent, BruteToolHost, CommandApprovalRequest } from '../tools';

type PanelMessage =
  | { type: 'ready' }
  | { type: 'startProject'; goal: string; language: string; guidanceProvider?: string; guidanceModel?: string; taskmasterProvider?: string; taskmasterModel?: string }
  | { type: 'planProject'; goal: string; language: string; taskmasterProvider?: string; taskmasterModel?: string }
  | { type: 'approveProjectPlan'; goal: string; language: string; guidanceProvider?: string; guidanceModel?: string; taskmasterProvider?: string; taskmasterModel?: string; cards: TaskCard[] }
  | { type: 'chat'; text: string }
  | { type: 'checkCode' }
  | { type: 'toolEvent'; event: BruteToolEvent }
  | { type: 'clearSession' }
  | { type: 'completeCard' }
  | { type: 'selectCard'; cardId: string }
  | { type: 'getSessions' }
  | { type: 'restoreSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'getOpenRouterModels' }
  | { type: 'updateToolMode'; toolMode: string }
  | { type: 'commandApprovalResult'; id: string; approved: boolean }
  | {
      type: 'saveConfig';
      provider: string;
      apiKey: string;
      baseUrl: string;
      model: string;
      taskmasterModel: string;
      teachingStyle: string;
      toolMode: string;
      commandRunner: string;
    };

export class BruteCodingPanel {
  static currentPanel: BruteCodingPanel | undefined;
  private static readonly viewType = 'bruteCoding.panel';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private agent: BruteAgent;
  private disposables: vscode.Disposable[] = [];
  private readonly context: vscode.ExtensionContext;
  private pendingCommandApprovals = new Map<string, (approved: boolean) => void>();

  static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (BruteCodingPanel.currentPanel) {
      BruteCodingPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      BruteCodingPanel.viewType,
      'BruteCoding',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );

    BruteCodingPanel.currentPanel = new BruteCodingPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.extensionUri = context.extensionUri;

    this.agent = this.createAgent(createProviderPreview());

    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg: PanelMessage) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.wireAgent();
  }

  private wireAgent(): void {
    this.agent.onStream = (delta) => {
      this.panel.webview.postMessage({ type: 'stream', delta });
    };
    this.agent.onDone = (full) => {
      this.panel.webview.postMessage({ type: 'done', content: full });
    };
    this.agent.onError = (err) => {
      this.panel.webview.postMessage({ type: 'error', message: err.message });
    };
    this.agent.onToolEvent = (event) => {
      this.panel.webview.postMessage({ type: 'toolEvent', event });
    };
  }

  private createAgent(provider: ReturnType<typeof createProviderPreview>): BruteAgent {
    return new BruteAgent(provider, new BruteToolHost({
      requestCommandApproval: request => this.requestCommandApproval(request),
    }));
  }

  private requestCommandApproval(request: CommandApprovalRequest): Promise<boolean> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.panel.webview.postMessage({ type: 'commandApprovalRequested', id, request });

    return new Promise(resolve => {
      this.pendingCommandApprovals.set(id, resolve);
    });
  }

  private resolveCommandApproval(id: string, approved: boolean): void {
    const resolve = this.pendingCommandApprovals.get(id);
    if (!resolve) {
      return;
    }
    this.pendingCommandApprovals.delete(id);
    resolve(approved);
  }

  private async handleMessage(msg: PanelMessage): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        await this.sendCurrentConfig();
        break;
      }

      case 'saveConfig': {
        await this.saveConfig(msg);
        break;
      }

      case 'getOpenRouterModels': {
        await this.sendOpenRouterModels();
        break;
      }

      case 'getSessions': {
        this.postSavedSessions();
        break;
      }

      case 'updateToolMode': {
        await this.updateToolMode(msg.toolMode);
        break;
      }

      case 'commandApprovalResult': {
        this.resolveCommandApproval(msg.id, msg.approved);
        break;
      }

      case 'startProject': {
        this.agent = this.createAgent(await createProvider(this.context, msg.guidanceProvider));
        this.wireAgent();
        this.panel.webview.postMessage({ type: 'agentTyping' });
        const planner = this.createAgent(await createProvider(this.context, msg.taskmasterProvider));
        const cards = await planner.planProjectCards(msg.goal, msg.language, msg.taskmasterModel);
        await this.agent.startProjectWithCards(msg.goal, msg.language, cards, {
          guidanceProvider: msg.guidanceProvider,
          taskmasterProvider: msg.taskmasterProvider,
          guidanceModel: msg.guidanceModel,
          taskmasterModel: msg.taskmasterModel,
        });
        this.postProjectState();
        await vscode.commands.executeCommand('setContext', 'bruteCoding.sessionActive', true);
        break;
      }

      case 'planProject': {
        this.panel.webview.postMessage({ type: 'planningProject' });
        const planner = this.createAgent(await createProvider(this.context, msg.taskmasterProvider));
        const cards = await planner.planProjectCards(msg.goal, msg.language, msg.taskmasterModel);
        this.panel.webview.postMessage({ type: 'projectPlan', goal: msg.goal, language: msg.language, cards });
        break;
      }

      case 'approveProjectPlan': {
        this.agent = this.createAgent(await createProvider(this.context, msg.guidanceProvider));
        this.wireAgent();
        this.panel.webview.postMessage({ type: 'agentTyping' });
        await this.agent.startProjectWithCards(msg.goal, msg.language, msg.cards, {
          guidanceProvider: msg.guidanceProvider,
          taskmasterProvider: msg.taskmasterProvider,
          guidanceModel: msg.guidanceModel,
          taskmasterModel: msg.taskmasterModel,
        });
        this.postProjectState();
        await vscode.commands.executeCommand('setContext', 'bruteCoding.sessionActive', true);
        break;
      }

      case 'completeCard': {
        this.panel.webview.postMessage({ type: 'agentTyping' });
        await this.agent.completeCurrentCard();
        this.postProjectState();
        break;
      }

      case 'chat': {
        this.panel.webview.postMessage({ type: 'agentTyping' });
        await this.agent.chat(msg.text);
        this.postProjectState();
        break;
      }

      case 'selectCard': {
        this.agent.selectCard(msg.cardId);
        this.postProjectState();
        break;
      }

      case 'restoreSession': {
        await this.restoreSession(msg.id);
        break;
      }

      case 'deleteSession': {
        await deleteSavedSession(this.context, msg.id);
        this.postSavedSessions();
        break;
      }

      case 'checkCode': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          this.panel.webview.postMessage({
            type: 'error',
            message: 'No active editor found. Open the file you want checked.',
          });
          return;
        }
        const selection = editor.selection;
        const code = selection.isEmpty
          ? editor.document.getText()
          : editor.document.getText(selection);

        this.panel.webview.postMessage({ type: 'agentTyping' });
        await this.agent.checkCode(code);
        this.postProjectState();
        break;
      }

      case 'clearSession': {
        await archiveAgentSession(this.context, this.agent);
        this.agent.clearHistory();
        this.agent = this.createAgent(await createProvider(this.context));
        this.wireAgent();
        await vscode.commands.executeCommand('setContext', 'bruteCoding.sessionActive', false);
        this.postProjectState();
        this.panel.webview.postMessage({ type: 'cleared' });
        break;
      }
    }
  }

  private async sendCurrentConfig(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('bruteCoding');
    const provider = cfg.get<string>('modelProvider', 'anthropic');

    // Mask stored key. Send an indicator, not the raw value.
    const storedKey = await getStoredApiKey(this.context, provider);

    // Check whether mandatory config is missing so UI knows to show config screen
    const needsKey = provider === 'anthropic' || provider === 'openai' || provider === 'openrouter';
    const needsUrl = provider === 'ollama' || provider === 'openai-compatible';
    const baseUrl = cfg.get<string>('openaiCompatibleBaseUrl', '');
    const needsSetup =
      (needsKey && !storedKey && !apiKeyEnvForProvider(provider)) ||
      (needsUrl && !baseUrl);

    this.panel.webview.postMessage({
      type: 'loadConfig',
      needsSetup,
      config: {
        provider,
        apiKey: storedKey ? '********' : '',
        baseUrl,
        model: cfg.get<string>('model', ''),
        taskmasterModel: cfg.get<string>('taskmasterModel', ''),
        teachingStyle: cfg.get<string>('teachingStyle', 'socratic'),
        toolMode: cfg.get<string>('toolMode', 'guided'),
        commandRunner: cfg.get<string>('commandRunner', 'background'),
      },
    });
  }

  private postProjectState(): void {
    this.panel.webview.postMessage({ type: 'projectState', project: this.agent.project });
  }

  private postSavedSessions(): void {
    this.panel.webview.postMessage({ type: 'savedSessions', sessions: listSavedSessions(this.context) });
  }

  private async restoreSession(id: string): Promise<void> {
    const session = getSavedSession(this.context, id);
    const project = session ? hydrateSavedProject(session) : null;
    if (!session || !project) {
      this.panel.webview.postMessage({ type: 'error', message: 'Saved session could not be restored.' });
      this.postSavedSessions();
      return;
    }

    this.agent = this.createAgent(await createProvider(this.context));
    this.agent.restoreProject(project);
    this.wireAgent();
    await vscode.commands.executeCommand('setContext', 'bruteCoding.sessionActive', true);
    this.panel.webview.postMessage({ type: 'sessionRestored' });
    this.postProjectState();
  }

  private async saveConfig(msg: Extract<PanelMessage, { type: 'saveConfig' }>): Promise<void> {
    try {
      const cfg = vscode.workspace.getConfiguration('bruteCoding');
      const target = vscode.ConfigurationTarget.Global;

      await cfg.update('modelProvider', msg.provider, target);
      await cfg.update('teachingStyle', msg.teachingStyle as 'socratic' | 'direct' | 'hints-only', target);
      await cfg.update('model', msg.model, target);
      await cfg.update('taskmasterModel', msg.taskmasterModel, target);
      await cfg.update('toolMode', msg.toolMode as 'read-only' | 'guided' | 'full-access', target);
      await cfg.update('commandRunner', msg.commandRunner as 'background' | 'vscode-terminal', target);

      // Only write API key if user entered a real value (not the masked placeholder)
      const isRealKey = msg.apiKey && msg.apiKey !== '********';
      if (isRealKey) {
        await storeApiKey(this.context, msg.provider, msg.apiKey);
      }

      if (msg.baseUrl) {
        await cfg.update('openaiCompatibleBaseUrl', msg.baseUrl, target);
      }

      // Rebuild agent with new provider config
      this.agent.clearHistory();
      this.agent = this.createAgent(await createProvider(this.context));
      this.wireAgent();

      this.panel.webview.postMessage({ type: 'configSaved' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.panel.webview.postMessage({ type: 'configError', message });
    }
  }

  private async updateToolMode(toolMode: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('bruteCoding');
    await cfg.update('toolMode', toolMode as 'read-only' | 'guided' | 'full-access', vscode.ConfigurationTarget.Global);
    this.agent.refreshToolPrompt();
  }

  private async sendOpenRouterModels(): Promise<void> {
    try {
      const models = await getOpenRouterModels();
      this.panel.webview.postMessage({ type: 'openRouterModels', models });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.panel.webview.postMessage({ type: 'openRouterModelsError', message });
    }
  }

  checkActiveEditorCode(): void {
    this.handleMessage({ type: 'checkCode' });
  }

  hasActiveProject(): boolean {
    return Boolean(this.agent.project);
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'panel.html');

    if (fs.existsSync(htmlPath)) {
      let html = fs.readFileSync(htmlPath, 'utf8');
      const cssUri = this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css')
      );
      const jsUri = this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js')
      );
      const katexCssUri = this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'katex', 'katex.min.css')
      );
      const katexJsUri = this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'katex', 'katex.min.js')
      );
      html = html.replace(/\{\{CSS_URI\}\}/g, cssUri.toString());
      html = html.replace(/\{\{JS_URI\}\}/g, jsUri.toString());
      html = html.replace(/\{\{KATEX_CSS_URI\}\}/g, katexCssUri.toString());
      html = html.replace(/\{\{KATEX_JS_URI\}\}/g, katexJsUri.toString());
      html = html.replace(/\{\{CSP_SOURCE\}\}/g, this.panel.webview.cspSource);
      return html;
    }

    return `<!DOCTYPE html><html><body><p>Media files not found. Run the build.</p></body></html>`;
  }

  dispose(): void {
    BruteCodingPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
