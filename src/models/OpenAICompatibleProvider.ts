import OpenAI from 'openai';
import { ChatMessage, ModelProvider, StreamChunk } from './ModelProvider';

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel: string;

  private client: OpenAI;

  constructor(opts: {
    name?: string;
    baseURL?: string;
    apiKey?: string;
    envApiKey?: string;
    defaultModel?: string;
    defaultHeaders?: Record<string, string>;
  } = {}) {
    this.name = opts.name ?? 'openai-compatible';
    this.defaultModel = opts.defaultModel ?? 'gpt-4o';
    this.client = new OpenAI({
      apiKey: opts.apiKey || opts.envApiKey || 'ollama',
      baseURL: opts.baseURL,
      defaultHeaders: opts.defaultHeaders,
    });
  }

  async *chat(messages: ChatMessage[], model?: string): AsyncIterable<StreamChunk> {
    const stream = await this.client.chat.completions.create({
      model: model || this.defaultModel,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: 2048,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        yield { delta, done: false };
      }
    }

    yield { delta: '', done: true };
  }
}
