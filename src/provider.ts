import { DeepSeekClient, type DeepSeekOptions } from "./deepseek.js";
import type { Message, StreamEvent, ToolSpec } from "./types.js";

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  stream(messages: Message[], tools?: ToolSpec[], signal?: AbortSignal): AsyncGenerator<StreamEvent>;
}

export class MockProvider implements ModelProvider {
  readonly id = "mock";
  readonly displayName = "Local mock";

  constructor(private readonly delayMs = 0) {}

  async *stream(messages: Message[], _tools: ToolSpec[] = [], signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Mock generation cancelled"));
        }, { once: true });
      });
    }
    const latest = [...messages].reverse().find((message) => message.role === "user");
    const prompt = latest?.role === "user" ? latest.content : "";
    const text = `Mock response: ${prompt}`;
    yield { type: "text", delta: text };
    yield {
      type: "done",
      message: { role: "assistant", content: text },
      usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length },
    };
  }
}

export const createProvider = (provider: string | undefined, options: DeepSeekOptions): ModelProvider =>
  provider === "mock" ? new MockProvider(options.mockDelayMs) : new DeepSeekClient(options);
