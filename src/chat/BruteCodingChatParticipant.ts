import * as vscode from 'vscode';
import { BruteAgent } from '../agent/BruteAgent';
import { createProvider } from '../models/providerFactory';

const PARTICIPANT_ID = 'brute-coding.brutecoding';

export function registerBruteCodingChatParticipant(
  context: vscode.ExtensionContext
): vscode.Disposable {
  let agentPromise = createAgent(context);

  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, _context, response) => {
      const agent = await agentPromise;
      agent.onStream = (delta) => response.markdown(delta);
      agent.onDone = undefined;
      agent.onError = (error) => response.markdown(`Error: ${error.message}`);

      switch (request.command) {
        case 'start': {
          const prompt = request.prompt.trim();
          if (!prompt) {
            response.markdown('Tell me the goal and stack, like: `build a REST API in Go`.');
            return;
          }

          await agent.startProject(prompt, inferLanguage(prompt));
          return;
        }

        case 'check': {
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            response.markdown('Open the file you want checked, then run `@brutecoding /check` again.');
            return;
          }

          const selection = editor.selection;
          const code = selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(selection);

          if (!agent.project) {
            response.markdown('Start a project first with `@brutecoding /start <goal and stack>`.');
            return;
          }

          await agent.checkCode(code);
          return;
        }

        case 'reset':
          agent.clearHistory();
          agentPromise = createAgent(context);
          response.markdown('Session reset. Tell me what you want to build next.');
          return;

        default:
          await agent.chat(request.prompt);
      }
    }
  );

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity-icon.svg');
  participant.followupProvider = {
    provideFollowups: () => [
      { prompt: '/check', label: 'Check the active file' },
      { prompt: '/reset', label: 'Reset the session' },
    ],
  };

  return participant;
}

async function createAgent(context: vscode.ExtensionContext): Promise<BruteAgent> {
  return new BruteAgent(await createProvider(context));
}

function inferLanguage(prompt: string): string {
  const lower = prompt.toLowerCase();
  const languages = [
    'typescript',
    'javascript',
    'python',
    'rust',
    'go',
    'java',
    'c#',
    'c++',
    'php',
    'ruby',
    'swift',
    'kotlin',
  ];

  return languages.find(language => lower.includes(language)) ?? 'unspecified';
}
