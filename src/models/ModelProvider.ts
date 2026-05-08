export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
}

export interface ModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  chat(messages: ChatMessage[], model?: string): AsyncIterable<StreamChunk>;
}
