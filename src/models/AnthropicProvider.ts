import Anthropic from '@anthropic-ai/sdk';
import { ChatMessage, ModelProvider, StreamChunk } from './ModelProvider';

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly defaultModel = 'claude-sonnet-4-6';

  private client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    // Pass a dummy key so the SDK doesn't throw in the constructor when the user
    // hasn't configured one yet — the real error surfaces on the first API call.
    this.client = new Anthropic({ apiKey: key || 'not-configured' });
  }

  async *chat(messages: ChatMessage[], model?: string): AsyncIterable<StreamChunk> {
    const systemMsg = messages.find(m => m.role === 'system');
    const conversationMsgs = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const stream = await this.client.messages.stream({
      model: model || this.defaultModel,
      max_tokens: 2048,
      system: systemMsg?.content,
      messages: conversationMsgs,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { delta: event.delta.text, done: false };
      }
    }

    yield { delta: '', done: true };
  }
}
