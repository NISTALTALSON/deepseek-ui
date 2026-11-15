import { DeepSeekClient } from "./deepseek.js";
import { McpHub } from "./mcp.js";
import { Permissions } from "./permissions.js";
import { SkillRegistry } from "./skills.js";
import type { Message, ToolCall, ToolSpec } from "./types.js";

export type AgentEvent =
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_denied"; id: string; name: string }
  | { type: "tool_result"; id: string; name: string; output: string }
  | { type: "done" };

export interface AgentDeps {
  client: DeepSeekClient;
  mcp: McpHub;
  skills: SkillRegistry;
  permissions: Permissions;
  systemPrompt?: string;
  maxIterations?: number;
  maxToolOutputChars?: number;
}

export class Agent {
  readonly messages: Message[] = [];
  constructor(private d: AgentDeps) {
    const base = d.systemPrompt ?? "You are a capable, careful assistant with access to tools.";
    this.messages.push({ role: "system", content: [base, d.skills.catalog()].filter(Boolean).join("\n\n") });
  }

  private allTools(): ToolSpec[] {
    const t = [...this.d.mcp.tools()];
    if (this.d.skills.list().length) t.push(this.d.skills.toolSpec());
    return t;
  }

  private async execute(call: ToolCall): Promise<string> {
    let args: unknown = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return `Invalid JSON arguments: ${call.function.arguments}`;
    }
    const name = call.function.name;
    let out: string;
    if (name === "load_skill") out = await this.d.skills.load((args as { name: string }).name);
    else if (this.d.mcp.owns(name)) out = await this.d.mcp.call(name, args);
    else out = `Unknown tool: ${name}`;
    const max = this.d.maxToolOutputChars ?? 50_000;
    return out.length > max ? `${out.slice(0, max)}\n...[truncated ${out.length - max} chars]` : out;
  }

  async *run(userText: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: "user", content: userText });
    const limit = this.d.maxIterations ?? 40;

    for (let i = 0; i < limit; i++) {
      let assistant;
      for await (const ev of this.d.client.stream(this.messages, this.allTools(), signal)) {
        if (ev.type === "reasoning") yield { type: "reasoning", delta: ev.delta };
        else if (ev.type === "text") yield { type: "text", delta: ev.delta };
        else assistant = ev.message;
      }
      if (!assistant) throw new Error("Stream ended without a message");
      this.messages.push(assistant); // verbatim, reasoning_content included

      if (!assistant.tool_calls?.length) {
        yield { type: "done" };
        return;
      }
      for (const call of assistant.tool_calls) {
        const name = call.function.name;
        let args: unknown = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* reported by execute() */ }
        yield { type: "tool_start", id: call.id, name, args };
        if (!(await this.d.permissions.authorize(name, args))) {
          this.messages.push({ role: "tool", tool_call_id: call.id, content: "Denied by user policy." });
          yield { type: "tool_denied", id: call.id, name };
          continue;
        }
        const output = await this.execute(call);
        this.messages.push({ role: "tool", tool_call_id: call.id, content: output });
        yield { type: "tool_result", id: call.id, name, output };
      }
    }
    this.messages.push({ role: "user", content: "[system] Tool-call limit reached. Summarize progress and stop." });
    yield { type: "done" };
  }
}
