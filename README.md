# deepseek-ui

Open-source agent layer for DeepSeek: MCP tools, Claude-style skills, a real permission system, and a GUI. Goal: use DeepSeek heavily, for as close to zero cost as possible, with the same powers (MCP, skills, plugins) that Claude has.

## Architecture

```
 ui/  (fork of DeepSeek's official MIT chat-demo, React + zustand)
   |   speaks the Anthropic Messages protocol, streaming
   v
 gateway (src/, planned)  <- local server, our engine runs here
   |-- agent loop (plan -> tool -> observe)
   |-- MCP hub (any MCP server: Desktop Commander, filesystem, GitHub...)
   |-- skills loader (SKILL.md, progressive loading)
   |-- permissions (allow / ask / deny, enforced in code)
   v
 any provider: DeepSeek API | OpenRouter free tier | LM Studio (local)
```

Why a gateway: a browser cannot spawn MCP stdio servers or touch the filesystem. The official UI already lets you point `apiOrigin` at any compatible server (`ui/rspack.config.ts`), so the gateway is the seam.

## Status

| Piece | Where | State |
|---|---|---|
| DeepSeek client with `reasoning_content` round-trip | `src/deepseek.ts` | unit tested |
| Agent loop, iteration cap, output truncation | `src/agent.ts` | not yet run against a live API |
| MCP hub (stdio), tools namespaced `server__tool` | `src/mcp.ts` | not yet run against a live server |
| Skills loader | `src/skills.ts` | unit tested |
| Permissions | `src/permissions.ts` | unit tested |
| Terminal harness | `src/cli.ts` | not yet run |
| Official UI vendored, builds on Windows | `ui/` | builds and is wired to the local gateway |
| Gateway (Anthropic Messages endpoint in front of the engine) | `src/gateway.ts` | implemented |

Engine: `npm install --include=dev`, `DEEPSEEK_API_KEY=... npm run dev`, `npm test`.
Gateway + UI: `DEEPSEEK_API_KEY=... npm run gateway` in one terminal, then `cd ui`, `pnpm install`, `pnpm dev` (http://localhost:8090) in another. The UI development build points to the local gateway by default. Set `DEEPSEEK_UI_API_ORIGIN` to use another compatible API.
(If `NODE_ENV=production` is set globally, npm/pnpm silently skip devDependencies. Set `NODE_ENV=development` for installs.)

MCP tools execute in the gateway process, never in the browser. Configure per-server
`timeoutMs` and `retries` in `deepseek-ui.config.json`. MCP tools that advertise
`readOnlyHint` can run concurrently when the model emits multiple independent calls.
The DeepSeek stream requests provider usage data and forwards input/output token counts
through the Anthropic-compatible response.

The chat workspace includes a model switcher plus persistent Skills, Plugins, MCP servers, and Connectors panels. Use the model pill in a conversation header or the `Workspace` control beside the composer. MCP servers are real: configure them in `deepseek-ui.config.json`, open the workspace, enable the connected server, and the model receives only that server's namespaced tools. Gateway streams expose executed tools as structured `tool_use` blocks, while bounded results remain marked as untrusted evidence. Enabled skills are loaded from real `SKILL.md` folders and are gated server-side. Connector entries become executable when backed by an MCP server with the same id; no credentials are stored in the browser.

The provider boundary is implemented in `src/provider.ts`. DeepSeek remains the
production provider, while the explicitly labelled **Local mock** model runs
without network access or credentials for setup, UI testing, and automation.
The gateway can also be configured with `"provider": "mock"`; the browser's
`mock` model selection sends the equivalent provider header per request.

## Staying free (honest version)

DeepSeek's API is prepaid per token, so "free" depends on the route. Verify each in its own console before relying on it.

| Route | Cost | Catch |
|---|---|---|
| OpenRouter `deepseek/deepseek-v4-flash:free` | free | reported cap about 200 requests/day. An agent loop uses one request per tool call, so this runs out fast. Free models can change without notice. |
| DeepSeek signup grant | free once | third-party sites claim a one-time 5M-token grant; DeepSeek's own pricing page does not publish one. Check the console. |
| Local model via LM Studio | free forever | 16 GB RAM laptop limits you to small quantized models. Weak at long context and tool calling. |
| Official API, V4.1-Flash | very cheap | off-peak about $0.15/M input, $0.003/M cached. Not zero. |
| Unofficial web-chat adapters | free | reverse-engineer private endpoints, break often, risk account bans. We do not build on these. |

Design consequence: the engine is provider-agnostic (configurable base URL), spends as few requests as possible (parallel tool calls, cache-friendly stable prefix, summarised tool output), and will show a live request/cost meter.

## Research findings (Nov 2026)

- **Thinking mode + tools breaks other clients.** DeepSeek returns 400 unless earlier `reasoning_content` is sent back when tools are in the request. This broke Cursor, opencode, LangChain and claude-code-router on V4. Our client stores assistant messages verbatim. Some blog posts say never to resend it; the official thinking-mode guide says to resend it with tools, which we follow. https://api-docs.deepseek.com/guides/thinking_mode
- **Open WebUI:** MCP needs the `mcpo` proxy, agent loops are capped, memory grows with uploads, server app (no local machine access).
- **LibreChat:** MongoDB + MeiliSearch stack (about 2-4 GB RAM), verbose config, web only. Already ships Agents, MCP and Skills.
- **DeepSeek's own UI (Nov 13 2026):** official, MIT, static, no backend, no tool or agent layer. That is the gap we fill.

## Roadmap

1. UI changes: dedicated tool-call cards, approve/deny prompts, skills and MCP panels, request/cost meter.
2. Verify end to end with Desktop Commander as the first MCP server.
3. Cache-aware context manager.
4. Plugin manifest (skills + MCP servers + commands, one-step install).
5. Prompt-injection hardening: tool results are untrusted data.
6. Desktop packaging (Electron; Rust is not required).

## License

MIT. `ui/` is derived from https://github.com/deepseek-ai/chat-demo (MIT, Copyright (c) 2026 DeepSeek); see `ui/LICENSE` and `ui/UPSTREAM.md`.
