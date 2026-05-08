import * as https from 'https';

export interface OpenRouterModelOption {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: string;
  completionPrice: string;
  label: string;
  detail: string;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    context_length?: number;
    pricing?: {
      prompt?: string;
      completion?: string;
    };
  }>;
}

let cachedModels: OpenRouterModelOption[] | undefined;
let cachedAt = 0;

export async function getOpenRouterModels(): Promise<OpenRouterModelOption[]> {
  const now = Date.now();
  if (cachedModels && now - cachedAt < 10 * 60 * 1000) {
    return cachedModels;
  }

  const json = await getJson<OpenRouterModelsResponse>('https://openrouter.ai/api/v1/models');
  const models = (json.data ?? [])
    .filter(model => model.id && model.name)
    .map(model => {
      const promptPrice = model.pricing?.prompt ?? '0';
      const completionPrice = model.pricing?.completion ?? '0';
      const contextLength = model.context_length ?? 0;
      const priceLabel = `${formatUsdPerMillion(promptPrice)} in / ${formatUsdPerMillion(completionPrice)} out`;
      const contextLabel = contextLength ? `${formatContext(contextLength)} ctx` : 'unknown ctx';

      return {
        id: model.id!,
        name: model.name!,
        contextLength,
        promptPrice,
        completionPrice,
        label: `${model.name} - ${priceLabel}`,
        detail: `${model.id} - ${contextLabel}`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  cachedModels = models;
  cachedAt = now;
  return models;
}

function getJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https
      .get(url, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
        });
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`OpenRouter returned HTTP ${res.statusCode ?? 'unknown'}`));
            return;
          }

          try {
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      })
      .on('error', reject);
  });
}

function formatUsdPerMillion(value: string): string {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) {
    return 'free';
  }

  const perMillion = price * 1_000_000;
  if (perMillion < 0.01) {
    return '<$0.01/M';
  }

  return `$${perMillion.toFixed(perMillion >= 10 ? 2 : 3)}/M`;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${trimNumber(tokens / 1_000_000)}M`;
  }

  if (tokens >= 1_000) {
    return `${trimNumber(tokens / 1_000)}K`;
  }

  return String(tokens);
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
