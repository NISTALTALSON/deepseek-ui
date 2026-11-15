import type { AssistantMessage, Message, StreamEvent, ToolCall, ToolSpec } from "./types.js";

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string; // default https://api.deepseek.com
  model?: string; // "deepseek-v4-pro" | "deepseek-flash"
  reasoningEffort?: "none" | "high" | "max"; // verify against current docs
}

/**
 * DeepSeek thinking mode + tools: every earlier assistant turn must carry its
 * reasoning_content back, or the API returns 400. Without tools it is dropped.
 * Messages are never rebuilt by hand, so nothing is lost.
 */
export function prepareMessages(messages: Message[], hasTools: boolean): Message[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    if (hasTools) return m;
    const { reasoning_content: _drop, ...rest } = m;
    return rest as AssistantMessage;
  });
}

export class DeepSeekClient {
  constructor(private opts: DeepSeekOptions) {}

  async *stream(messages: Message[], tools: ToolSpec[] = [], signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const hasTools = tools.length > 0;
    const body: Record<string, unknown> = {
      model: this.opts.model ?? "deepseek-v4-pro",
      messages: prepareMessages(messages, hasTools),
      stream: true,
    };
    if (this.opts.reasoningEffort) body.reasoning_effort = this.opts.reasoningEffort;
    if (hasTools) {
      body.tools = tools.map((t) => ({ type: "function", function: t }));
    }

    const res = await fetch(`${this.opts.baseUrl ?? "https://api.deepseek.com"}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
    }

    let content = "";
    let reasoning = "";
    const calls = new Map<number, ToolCall>();
    const decoder = new TextDecoder();
    let buf = "";

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const delta = JSON.parse(data).choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          yield { type: "reasoning", delta: delta.reasoning_content };
        }
        if (delta.content) {
          content += delta.content;
          yield { type: "text", delta: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          calls.set(tc.index, cur);
        }
      }
    }

    const message: AssistantMessage = { role: "assistant", content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (calls.size) message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    yield { type: "done", message };
  }
}
