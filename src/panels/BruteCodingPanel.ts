import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BruteAgent } from '../agent/BruteAgent';
import {
  apiKeyEnvForProvider,
  createProvider,
  createProviderPreview,
  getStoredApiKey,
  storeApiKey,
} from '../models/providerFactory';
import { getOpenRouterModels } from '../models/OpenRouterModels';

type PanelMessage =
  | { type: 'ready' }
  | { type: 'startProject'; goal: string; language: string }
  | { type: 'chat'; text: string }
  | { type: 'checkCode' }
  | { type: 'clearSession' }
  | { type: 'getOpenRouterModels' }
  | {
      type: 'saveConfig';
      provider: string;
      apiKey: string;
      baseUrl: string;
      model: string;
      teachingStyle: string;
    };

export class BruteCodingPanel {
  static currentPanel: BruteCodingPanel | undefined;
  private static readonly viewType = 'bruteCoding.panel';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private agent: BruteAgent;
  private disposables: vscode.Disposable[] = [];
  private readonly context: vscode.ExtensionContext;

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

    this.agent = new BruteAgent(createProviderPreview());

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

      case 'startProject': {
        this.agent = new BruteAgent(await createProvider(this.context));
        this.wireAgent();
        this.panel.webview.postMessage({ type: 'agentTyping' });
        await this.agent.startProject(msg.goal, msg.language);
        await vscode.commands.executeCommand('setContext', 'bruteCoding.sessionActive', true);
        break;
      }

      case 'chat': {
        this.panel.webview.postMessage({ type: 'agentTyping' });
        await this.agent.chat(msg.text);
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
        break;
      }

      case 'clearSession': {
        this.agent.clearHistory();
        this.agent = new BruteAgent(await createProvider(this.context));
        this.wireAgent();
        await vscode.commands.executeCommand('setContext', 'bruteCoding.sessionActive', false);
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
        teachingStyle: cfg.get<string>('teachingStyle', 'socratic'),
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
      this.agent = new BruteAgent(await createProvider(this.context));
      this.wireAgent();

      this.panel.webview.postMessage({ type: 'configSaved' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.panel.webview.postMessage({ type: 'configError', message });
    }
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
      html = html.replace(/\{\{CSS_URI\}\}/g, cssUri.toString());
      html = html.replace(/\{\{JS_URI\}\}/g, jsUri.toString());
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
