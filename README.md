# deepseek-ui

Open-source agent layer for DeepSeek: MCP tools, Claude-style skills, a real permission system, and (next) a GUI that gives DeepSeek local system access.

**Why DeepSeek:** V4 has a 1M-token context, 384K max output, native tool calling, very low cached-input pricing, and OpenAI + Anthropic compatible endpoints. The model is not the bottleneck. The harness is.

## Status: Milestone 1 (engine), working

| Piece | File | State |
|---|---|---|
| Streaming DeepSeek client with `reasoning_content` round-trip | `src/deepseek.ts` | tested (unit) |
| Agent loop (plan, tool, observe) with iteration cap + output truncation | `src/agent.ts` | untested against live API |
| MCP client (stdio), tools namespaced `server__tool` | `src/mcp.ts` | untested against a live server |
| Skills loader (`SKILL.md`, progressive loading via `load_skill`) | `src/skills.ts` | tested |
| Permissions (allow / ask / deny, glob rules) | `src/permissions.ts` | tested |
| Terminal harness | `src/cli.ts` | untested |

Run: `npm install --include=dev`, then `DEEPSEEK_API_KEY=... npm run dev`. Tests: `npm test`.
(`--include=dev` matters if `NODE_ENV=production` is set globally, since npm then silently skips devDependencies.)

## Research findings (Nov 2026)

**DeepSeek is cheap, not free.** Since Aug 16 2026 pricing has peak and off-peak rates (weekday peak is about 2x). Cache hits are the big saving. Treat "cheap + 1M context" as the pitch, not "free".

**The wedge: thinking mode + tools breaks other clients.** DeepSeek requires `reasoning_content` from earlier assistant turns to be sent back when tools are in the request, otherwise it returns 400. This broke Cursor, opencode, LangChain and claude-code-router on V4 (a proxy exists just to patch it). Our client stores assistant messages verbatim and never rebuilds them. Note: some blog posts say "never resend reasoning_content". The official thinking-mode guide says to resend it with tools, which is what we follow. Verify against https://api-docs.deepseek.com/guides/thinking_mode.

**Open WebUI weak spots:** MCP is not native by design (needs the `mcpo` proxy), agent loops are capped by `CHAT_RESPONSE_MAX_TOOL_CALL_ITERATIONS`, no context trimming by design, RAM growth with document uploads, and users report native web search is weak. It is a server app, so no local machine access.

**LibreChat weak spots:** heavy stack (MongoDB + MeiliSearch + Node, about 2-4 GB RAM), verbose `librechat.yaml`, web only (no desktop app). It already ships Agents, MCP and Skills, so "we have skills" is not a differentiator on its own.

**Our angle:** local-first desktop app (real filesystem and terminal via MCP, no Docker/Mongo), DeepSeek-native behaviour (reasoning round-trip, thinking modes, cache-friendly prompt prefixes, 1M-context handling), and a permission layer that lives in code, not in the prompt.

## Roadmap

1. Verify the loop end to end against the live API and Desktop Commander MCP.
2. Cache-aware context manager (stable prefix first so cache hits stay high; summarise tool output).
3. Electron shell + chat UI (streaming, collapsible reasoning, tool-call cards, approve/deny prompts).
4. Plugin manifest (bundle skills + MCP servers + commands, one-step install).
5. Persistent sessions and a cost meter (peak/off-peak aware).
6. Prompt-injection hardening for tool results (treat as untrusted data).
