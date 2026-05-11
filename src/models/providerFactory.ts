import * as vscode from 'vscode';
import { ModelProvider } from './ModelProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';

const DEFAULT_OPENROUTER_MODEL = 'qwen/qwen3-next-80b-a3b-instruct:free';

type ApiKeyProvider = 'anthropic' | 'openai' | 'openrouter' | 'openai-compatible';

const API_KEY_SETTINGS: Record<ApiKeyProvider, string> = {
  anthropic: 'anthropicApiKey',
  openai: 'openaiApiKey',
  openrouter: 'openRouterApiKey',
  'openai-compatible': 'openaiCompatibleApiKey',
};

const API_KEY_SECRETS: Record<ApiKeyProvider, string> = {
  anthropic: 'bruteCoding.anthropicApiKey',
  openai: 'bruteCoding.openaiApiKey',
  openrouter: 'bruteCoding.openRouterApiKey',
  'openai-compatible': 'bruteCoding.openaiCompatibleApiKey',
};

export async function createProvider(
  context: vscode.ExtensionContext,
  providerOverride?: string
): Promise<ModelProvider> {
  return createProviderWithKeys({
    anthropic: await getStoredApiKey(context, 'anthropic'),
    openai: await getStoredApiKey(context, 'openai'),
    openrouter: await getStoredApiKey(context, 'openrouter'),
    'openai-compatible': await getStoredApiKey(context, 'openai-compatible'),
  }, providerOverride);
}

export function createProviderPreview(providerOverride?: string): ModelProvider {
  return createProviderWithKeys({}, providerOverride);
}

export async function migrateApiKeysToSecrets(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('bruteCoding');

  for (const provider of Object.keys(API_KEY_SETTINGS) as ApiKeyProvider[]) {
    const settingName = API_KEY_SETTINGS[provider];
    const existingSecret = await context.secrets.get(API_KEY_SECRETS[provider]);
    const settingValue = cfg.get<string>(settingName, '');

    if (settingValue && !existingSecret) {
      await context.secrets.store(API_KEY_SECRETS[provider], settingValue);
    }

    if (settingValue) {
      await clearApiKeySetting(settingName);
    }
  }
}

export async function getStoredApiKey(
  context: vscode.ExtensionContext,
  provider: string
): Promise<string | undefined> {
  if (!isApiKeyProvider(provider)) {
    return undefined;
  }

  return (
    await context.secrets.get(API_KEY_SECRETS[provider]) ||
    vscode.workspace.getConfiguration('bruteCoding').get<string>(API_KEY_SETTINGS[provider], '')
  );
}

export async function storeApiKey(
  context: vscode.ExtensionContext,
  provider: string,
  apiKey: string
): Promise<void> {
  if (!isApiKeyProvider(provider)) {
    return;
  }

  await context.secrets.store(API_KEY_SECRETS[provider], apiKey);
  await clearApiKeySetting(API_KEY_SETTINGS[provider]);
}

export function apiKeyEnvForProvider(provider: string): string | undefined {
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY;
  }

  if (provider === 'openrouter') {
    return process.env.OPENROUTER_API_KEY;
  }

  if (provider === 'openai-compatible') {
    return process.env.OPENAI_COMPATIBLE_API_KEY;
  }

  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY;
  }

  return undefined;
}

export async function hasConfiguredBackend(context: vscode.ExtensionContext): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('bruteCoding');
  const provider = cfg.get<string>('modelProvider', 'anthropic');

  if (provider === 'ollama') {
    return true;
  }

  if (provider === 'openai-compatible') {
    return Boolean(cfg.get<string>('openaiCompatibleBaseUrl', 'http://localhost:11434/v1'));
  }

  return Boolean(await getStoredApiKey(context, provider) || apiKeyEnvForProvider(provider));
}

function createProviderWithKeys(
  apiKeys: Partial<Record<ApiKeyProvider, string>>,
  providerOverride?: string
): ModelProvider {
  const cfg = vscode.workspace.getConfiguration('bruteCoding');
  const providerName = providerOverride || cfg.get<string>('modelProvider', 'anthropic');

  switch (providerName) {
    case 'anthropic':
      return new AnthropicProvider(apiKeys.anthropic);

    case 'openai':
      return new OpenAICompatibleProvider({
        name: 'openai',
        apiKey: apiKeys.openai,
        envApiKey: process.env.OPENAI_API_KEY,
        defaultModel: 'gpt-4o',
      });

    case 'openrouter':
      return new OpenAICompatibleProvider({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: apiKeys.openrouter,
        envApiKey: process.env.OPENROUTER_API_KEY,
        defaultModel: cfg.get<string>('model') || DEFAULT_OPENROUTER_MODEL,
        disableProviderFallbacks: true,
        defaultHeaders: {
          'X-OpenRouter-Title': 'BruteCoding',
        },
      });

    case 'ollama':
      return new OpenAICompatibleProvider({
        name: 'ollama',
        baseURL: 'http://localhost:11434/v1',
        defaultModel: cfg.get<string>('model') || 'llama3',
      });

    case 'openai-compatible':
      return new OpenAICompatibleProvider({
        name: 'openai-compatible',
        baseURL: cfg.get<string>('openaiCompatibleBaseUrl') || 'http://localhost:11434/v1',
        apiKey: apiKeys['openai-compatible'],
        envApiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
        defaultModel: cfg.get<string>('model') || 'llama3',
      });

    default:
      return new AnthropicProvider();
  }
}

function isApiKeyProvider(provider: string): provider is ApiKeyProvider {
  return provider in API_KEY_SECRETS;
}

async function clearApiKeySetting(settingName: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('bruteCoding');
  await cfg.update(settingName, undefined, vscode.ConfigurationTarget.Global);

  if (vscode.workspace.workspaceFolders?.length) {
    await cfg.update(settingName, undefined, vscode.ConfigurationTarget.Workspace);
  }
}
