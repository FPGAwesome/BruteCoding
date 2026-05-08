import * as vscode from 'vscode';
import { buildSystemPrompt } from '../agent/prompts';
import { ChatMessage } from '../models/ModelProvider';
import {
  createProvider,
  createProviderPreview,
  hasConfiguredBackend,
} from '../models/providerFactory';

const MODEL_ID = 'teacher';

export class BruteCodingLanguageModelProvider implements vscode.LanguageModelChatProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (options.silent && !(await hasConfiguredBackend(this.context))) {
      return [];
    }

    const provider = createProviderPreview();
    const model = configuredModel() || provider.defaultModel;

    return [
      {
        id: MODEL_ID,
        name: 'BruteCoding Teacher',
        family: 'brutecoding',
        version: model,
        tooltip: `Guided coding practice through ${provider.name}:${model}`,
        detail: provider.name,
        maxInputTokens: 120000,
        maxOutputTokens: 4096,
        capabilities: {},
      },
    ];
  }

  async provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const provider = await createProvider(this.context);
    const cfg = vscode.workspace.getConfiguration('bruteCoding');
    const teachingStyle = cfg.get<'socratic' | 'direct' | 'hints-only'>('teachingStyle', 'socratic');
    const modelOverride = cfg.get<string>('model', '') || undefined;

    const providerMessages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(teachingStyle) },
      ...messages.map(toProviderMessage).filter((message): message is ChatMessage => Boolean(message)),
    ];

    for await (const chunk of provider.chat(providerMessages, modelOverride)) {
      if (token.isCancellationRequested) {
        return;
      }

      if (!chunk.done && chunk.delta) {
        progress.report(new vscode.LanguageModelTextPart(chunk.delta));
      }
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const content = typeof text === 'string' ? text : messageText(text);
    return Math.ceil(content.length / 4);
  }
}

function toProviderMessage(message: vscode.LanguageModelChatRequestMessage): ChatMessage | undefined {
  const content = messageText(message).trim();
  if (!content) {
    return undefined;
  }

  return {
    role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
    content,
  };
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '')
    .join('');
}

function configuredModel(): string {
  return vscode.workspace.getConfiguration('bruteCoding').get<string>('model', '');
}
