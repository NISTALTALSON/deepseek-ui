import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import type { ToolSpec } from "./types.js";

// MCP client. Plug in any existing MCP server (Desktop Commander, filesystem,
// GitHub...) and DeepSeek gets its tools. Tool names are namespaced as
// `<server>__<tool>` so permission rules can target a whole server with "server__*".

export interface McpServerConfig {
  transport?: "stdio" | "streamable-http";
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

const isPrivateAddress = (address: string): boolean => {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(normalized) === 6) {
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
      first >= 0xff00 || normalized.startsWith("2001:db8");
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
};

const validateRemoteUrl = async (value: string): Promise<URL> => {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Remote MCP URLs must use HTTPS");
  if (url.username || url.password) throw new Error("Credentials in MCP URLs are not allowed");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Remote MCP host resolves to a private or local address");
  }
  return url;
};

export class McpHub {
  private clients = new Map<string, Client>();
  private specs: ToolSpec[] = [];
  private statuses = new Map<string, { status: "connected" | "error"; error?: string }>();

  async connect(cfg: McpConfig): Promise<void> {
    for (const [name, s] of Object.entries(cfg.servers)) {
      try {
        const transport = s.transport === "streamable-http"
          ? new StreamableHTTPClientTransport(await validateRemoteUrl(s.url ?? ""), {
              requestInit: { headers: { ...(s.headers ?? {}) }, redirect: "error" },
              redirectPolicy: "same-origin",
            })
          : new StdioClientTransport({
              command: s.command ?? (() => { throw new Error("stdio MCP server requires a command"); })(),
              args: s.args ?? [],
              env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) },
            });
        const client = new Client({ name: "deepseek-ui", version: "0.0.1" });
        await client.connect(transport);
        this.clients.set(name, client);
        this.statuses.set(name, { status: "connected" });
        const { tools } = await client.listTools();
        for (const t of tools) {
          this.specs.push({
            name: `${name}__${t.name}`,
              displayName: t.name,
              source: "mcp",
              description: t.description ?? "",
              parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
              schemaFingerprint: createHash("sha256").update(JSON.stringify(t.inputSchema ?? {})).digest("hex"),
              availability: "available",
            readOnly: t.annotations?.readOnlyHint === true,
            timeoutMs: s.timeoutMs,
            retries: s.retries,
          });
        }
      } catch (err) {
        this.statuses.set(name, { status: "error", error: (err as Error).message });
        console.error(`[mcp] failed to start "${name}":`, (err as Error).message);
      }
    }
  }

  serverNames(): string[] {
    return [...this.clients.keys()];
  }

  serverDetails(): Array<{ id: string; status: "connected" | "error"; error?: string; tools: string[] }> {
    return [...this.statuses.entries()].map(([id, status]) => ({
      id,
      ...status,
      tools: this.specs.filter((tool) => tool.name.startsWith(`${id}__`)).map((tool) => tool.name),
    }));
  }

  tools(enabledServers?: ReadonlySet<string>): ToolSpec[] {
    if (!enabledServers) return this.specs;
    return this.specs.filter((tool) => enabledServers.has(tool.name.split("__", 1)[0]));
  }

  owns(toolName: string): boolean {
    return this.specs.some((s) => s.name === toolName);
  }

  async call(toolName: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const sep = toolName.indexOf("__");
    if (sep <= 0) return `Invalid MCP tool name: ${toolName}`;
    const client = this.clients.get(toolName.slice(0, sep));
    if (!client) return `Unknown MCP server for tool ${toolName}`;
    const spec = this.specs.find((item) => item.name === toolName);
    const timeoutMs = spec?.timeoutMs ?? 30_000;
    const retries = spec?.retries ?? 1;
    let res;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      const timer = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`MCP tool timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      const cancelled = signal
        ? new Promise<never>((_, reject) => {
            abortHandler = () => reject(new Error("MCP tool cancelled"));
            if (signal.aborted) abortHandler();
            else signal.addEventListener("abort", abortHandler, { once: true });
          })
        : undefined;
      try {
        res = await Promise.race([
          client.callTool({
            name: toolName.slice(sep + 2),
            arguments: args as Record<string, unknown>,
          }),
          timer,
          ...(cancelled ? [cancelled] : []),
        ]);
        break;
      } catch (error) {
        if (attempt === retries) throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      }
    }
    if (!res) throw new Error(`MCP tool failed: ${toolName}`);
    const parts = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = parts.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
    return res.isError ? `Tool error: ${text}` : text;
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
  }
}
