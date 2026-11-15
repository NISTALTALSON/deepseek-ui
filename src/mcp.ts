import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSpec } from "./types.js";

// MCP client. Plug in any existing MCP server (Desktop Commander, filesystem,
// GitHub...) and DeepSeek gets its tools. Tool names are namespaced as
// `<server>__<tool>` so permission rules can target a whole server with "server__*".

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export class McpHub {
  private clients = new Map<string, Client>();
  private specs: ToolSpec[] = [];

  async connect(cfg: McpConfig): Promise<void> {
    for (const [name, s] of Object.entries(cfg.servers)) {
      try {
        const transport = new StdioClientTransport({
          command: s.command,
          args: s.args ?? [],
          env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) },
        });
        const client = new Client({ name: "deepseek-ui", version: "0.0.1" });
        await client.connect(transport);
        this.clients.set(name, client);
        const { tools } = await client.listTools();
        for (const t of tools) {
          this.specs.push({
            name: `${name}__${t.name}`,
            description: t.description ?? "",
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          });
        }
      } catch (err) {
        console.error(`[mcp] failed to start "${name}":`, (err as Error).message);
      }
    }
  }

  tools(): ToolSpec[] {
    return this.specs;
  }

  owns(toolName: string): boolean {
    return this.specs.some((s) => s.name === toolName);
  }

  async call(toolName: string, args: unknown): Promise<string> {
    const sep = toolName.indexOf("__");
    const client = this.clients.get(toolName.slice(0, sep));
    if (!client) return `Unknown MCP server for tool ${toolName}`;
    const res = await client.callTool({ name: toolName.slice(sep + 2), arguments: args as Record<string, unknown> });
    const parts = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = parts.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
    return res.isError ? `Tool error: ${text}` : text;
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
  }
}
