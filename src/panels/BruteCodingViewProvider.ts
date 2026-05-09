import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BruteAgent } from '../agent/BruteAgent';
import { archiveAgentSession } from '../agent/SessionStore';
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
  | { type: 'startProject'; goal: string; language: string }
  | { type: 'chat'; text: string }
  | { type: 'checkCode' }
  | { type: 'toolEvent'; event: BruteToolEvent }
  | { type: 'clearSession' }
  | { type: 'getOpenRouterModels' }
  | { type: 'updateToolMode'; toolMode: string }
  | { type: 'commandApprovalResult'; id: string; approved: boolean }
  | {
      type: 'saveConfig';
      provider: string;
      apiKey: string;
      baseUrl: string;
      model: string;
      teachingStyle: string;
      toolMode: string;
      commandRunner: string;
    };

export class BruteCodingViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'bruteCoding.chatView';
  static readonly panelViewId = 'bruteCoding.panelChatView';

  private view?: vscode.WebviewView;
  private agent: BruteAgent;
  private readonly extensionUri: vscode.Uri;
  private readonly context: vscode.ExtensionContext;
  private pendingCommandApprovals = new Map<string, (approved: boolean) => void>();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    this.agent = this.createAgent(createProviderPreview());
    this.wireAgent();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: PanelMessage) => this.handleMessage(msg));
  }

  checkActiveEditorCode(): void {
    this.handleMessage({ type: 'checkCode' });
  }

  hasActiveProject(): boolean {
    return Boolean(this.agent.project);
  }

  private wireAgent(): void {
    this.agent.onStream = (delta) => {
      this.view?.webview.postMessage({ type: 'stream', delta });
    };
    this.agent.onDone = (full) => {
      this.view?.webview.postMessage({ type: 'done', content: full });
    };
    this.agent.onError = (err) => {
      this.view?.webview.postMessage({ type: 'error', message: err.message });
    };
    this.agent.onToolEvent = (event) => {
      this.view?.webview.postMessage({ type: 'toolEvent', event });
    };
  }

  private createAgent(provider: ReturnType<typeof createProviderPreview>): BruteAgent {
    return new BruteAgent(provider, new BruteToolHost({
      requestCommandApproval: request => this.requestCommandApproval(request),
    }));
  }

  private requestCommandApproval(request: CommandApprovalRequest): Promise<boolean> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.view?.webview.postMessage({ type: 'commandApprovalRequested', id, request });

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

      case 'updateToolMode': {
        await this.updateToolMode(msg.toolMode);
        break;
      }

      case 'commandApprovalResult': {
        this.resolveCommandApproval(msg.id, msg.approved);
        break;
      }

      case 'startProject': {
        this.agent = this.createAgent(await createProvider(this.context));
        this.wireAgent();
        this.view?.webview.postMessage({ type: 'agentTyping' });
        await this.agent.startProject(msg.goal, msg.language);
        await vscode.commands.executeCommand('setContext', 'bruteCoding.sessionActive', true);
        break;
      }

      case 'chat': {
        this.view?.webview.postMessage({ type: 'agentTyping' });
        await this.agent.chat(msg.text);
        break;
      }

      case 'checkCode': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          this.view?.webview.postMessage({
            type: 'error',
            message: 'No active editor found. Open the file you want checked.',
          });
          return;
        }
        const selection = editor.selection;
        const code = selection.isEmpty
          ? editor.document.getText()
          : editor.document.getText(selection);

        this.view?.webview.postMessage({ type: 'agentTyping' });
        await this.agent.checkCode(code);
        break;
      }

      case 'clearSession': {
        await archiveAgentSession(this.context, this.agent);
        this.agent.clearHistory();
        this.agent = this.createAgent(await createProvider(this.context));
        this.wireAgent();
        await vscode.commands.executeCommand('setContext', 'bruteCoding.sessionActive', false);
        this.view?.webview.postMessage({ type: 'cleared' });
        break;
      }
    }
  }

  private async sendCurrentConfig(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('bruteCoding');
    const provider = cfg.get<string>('modelProvider', 'anthropic');

    const storedKey = await getStoredApiKey(this.context, provider);

    const needsKey = provider === 'anthropic' || provider === 'openai' || provider === 'openrouter';
    const needsUrl = provider === 'ollama' || provider === 'openai-compatible';
    const baseUrl = cfg.get<string>('openaiCompatibleBaseUrl', '');
    const needsSetup =
      (needsKey && !storedKey && !apiKeyEnvForProvider(provider)) ||
      (needsUrl && !baseUrl);

    this.view?.webview.postMessage({
      type: 'loadConfig',
      needsSetup,
      config: {
        provider,
        apiKey: storedKey ? '********' : '',
        baseUrl,
        model: cfg.get<string>('model', ''),
        teachingStyle: cfg.get<string>('teachingStyle', 'socratic'),
        toolMode: cfg.get<string>('toolMode', 'guided'),
        commandRunner: cfg.get<string>('commandRunner', 'background'),
      },
    });
  }

  private async saveConfig(msg: Extract<PanelMessage, { type: 'saveConfig' }>): Promise<void> {
    try {
      const cfg = vscode.workspace.getConfiguration('bruteCoding');
      const target = vscode.ConfigurationTarget.Global;

      await cfg.update('modelProvider', msg.provider, target);
      await cfg.update('teachingStyle', msg.teachingStyle as 'socratic' | 'direct' | 'hints-only', target);
      await cfg.update('model', msg.model, target);
      await cfg.update('toolMode', msg.toolMode as 'read-only' | 'guided' | 'full-access', target);
      await cfg.update('commandRunner', msg.commandRunner as 'background' | 'vscode-terminal', target);

      const isRealKey = msg.apiKey && msg.apiKey !== '********';
      if (isRealKey) {
        await storeApiKey(this.context, msg.provider, msg.apiKey);
      }

      if (msg.baseUrl) {
        await cfg.update('openaiCompatibleBaseUrl', msg.baseUrl, target);
      }

      this.agent.clearHistory();
      this.agent = this.createAgent(await createProvider(this.context));
      this.wireAgent();

      this.view?.webview.postMessage({ type: 'configSaved' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({ type: 'configError', message });
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
      this.view?.webview.postMessage({ type: 'openRouterModels', models });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({ type: 'openRouterModelsError', message });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'panel.html');

    if (fs.existsSync(htmlPath)) {
      let html = fs.readFileSync(htmlPath, 'utf8');
      const cssUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css')
      );
      const jsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js')
      );
      html = html.replace(/\{\{CSS_URI\}\}/g, cssUri.toString());
      html = html.replace(/\{\{JS_URI\}\}/g, jsUri.toString());
      html = html.replace(/\{\{CSP_SOURCE\}\}/g, webview.cspSource);
      return html;
    }

    return `<!DOCTYPE html><html><body><p>Media files not found. Run npm run build.</p></body></html>`;
  }
}
