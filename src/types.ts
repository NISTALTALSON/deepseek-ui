// Shared message types. Assistant messages are stored VERBATIM (including
// reasoning_content) because DeepSeek thinking mode + tools returns a 400
// if earlier reasoning_content is dropped from history.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
};

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  name: string;
  displayName?: string;
  source?: "builtin" | "skill" | "mcp" | "connector";
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  schemaFingerprint?: string;
  availability?: "available" | "unavailable";
  permissionClass?: "read-only" | "reversible" | "external-side-effect" | "sensitive" | "destructive";
  readOnly?: boolean;
  timeoutMs?: number;
  retries?: number;
}

export type StreamEvent =
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | {
      type: "done";
      message: AssistantMessage;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
