import * as vscode from 'vscode';
import { BruteCodingViewProvider } from './panels/BruteCodingViewProvider';
import { BruteCodingPanel } from './panels/BruteCodingPanel';
import { registerBruteCodingChatParticipant } from './chat/BruteCodingChatParticipant';
import { BruteCodingLanguageModelProvider } from './chat/BruteCodingLanguageModelProvider';
import { migrateApiKeysToSecrets } from './models/providerFactory';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('BruteCoding');
  context.subscriptions.push(output);
  output.appendLine('Activating BruteCoding.');

  void migrateApiKeysToSecrets(context).catch(err => {
    output.appendLine(`API key migration failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  const sidebarProvider = new BruteCodingViewProvider(context);
  const panelProvider = new BruteCodingViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BruteCodingViewProvider.viewId, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(BruteCodingViewProvider.panelViewId, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const revealBruteCoding = async () => {
    output.appendLine('bruteCoding.openPanel invoked.');
    void vscode.window.showInformationMessage('BruteCoding command fired.');

    try {
      await vscode.commands.executeCommand('workbench.view.extension.bruteCodingChatPanel');
      await vscode.commands.executeCommand(`${BruteCodingViewProvider.panelViewId}.focus`);
      output.appendLine('Focused BruteCoding panel chat view.');
    } catch (err) {
      output.appendLine(`Panel focus failed: ${err instanceof Error ? err.message : String(err)}`);
      output.appendLine('Opening standalone BruteCoding panel.');
      BruteCodingPanel.createOrShow(context);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('bruteCoding.openPanel', revealBruteCoding),

    vscode.commands.registerCommand('bruteCoding.newProject', revealBruteCoding),

    vscode.commands.registerCommand('bruteCoding.checkMyCode', () => {
      output.appendLine('bruteCoding.checkMyCode invoked.');
      if (panelProvider.hasActiveProject()) {
        panelProvider.checkActiveEditorCode();
        return;
      }

      if (sidebarProvider.hasActiveProject()) {
        sidebarProvider.checkActiveEditorCode();
        return;
      }

      if (BruteCodingPanel.currentPanel?.hasActiveProject()) {
        BruteCodingPanel.currentPanel.checkActiveEditorCode();
        return;
      }

      panelProvider.checkActiveEditorCode();
    })
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(mortar-board) BruteCoding';
  statusBar.tooltip = 'Open BruteCoding';
  statusBar.command = 'bruteCoding.openPanel';
  statusBar.show();
  context.subscriptions.push(statusBar);

  registerOptionalChatIntegrations(context, output);
}

export function deactivate(): void {}

function registerOptionalChatIntegrations(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): void {
  const vscodeApi = vscode as typeof vscode & {
    chat?: { createChatParticipant?: unknown };
    lm?: { registerLanguageModelChatProvider?: unknown };
  };

  try {
    if (typeof vscodeApi.chat?.createChatParticipant === 'function') {
      context.subscriptions.push(registerBruteCodingChatParticipant(context));
      output.appendLine('Registered BruteCoding chat participant.');
    } else {
      output.appendLine('VS Code Chat Participant API is not available in this host.');
    }
  } catch (err) {
    output.appendLine(`Chat participant registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    if (typeof vscodeApi.lm?.registerLanguageModelChatProvider === 'function') {
      context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider(
          'brute-coding',
          new BruteCodingLanguageModelProvider(context)
        )
      );
      output.appendLine('Registered BruteCoding language model provider.');
    } else {
      output.appendLine('VS Code Language Model Chat Provider API is not available in this host.');
    }
  } catch (err) {
    output.appendLine(`Language model provider registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
