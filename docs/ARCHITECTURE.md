# DeepSeek UI workspace architecture

## Current system

The repository has two intentionally separate layers:

- `ui/` is the browser application. It owns conversation persistence in the
  existing client store, rich message rendering, settings, attachments, and
  workspace selection.
- `src/` is the local gateway and agent runtime. It owns provider calls, MCP
  processes, skills, permission policy, schema validation, context limits, and
  streaming translation.

The browser cannot safely spawn stdio MCP servers or hold provider secrets, so
the gateway is the security and execution boundary.

## End-to-end request path

1. The UI selects a model, skills, integrations, and provider mode.
2. `streamMessage` sends an Anthropic-compatible request to
   `/anthropic/v1/messages` with capability headers.
3. The gateway converts the request into the internal `Message` protocol.
4. `Agent` selects only enabled tools, validates arguments, applies policy, and
   executes skills or MCP tools.
5. A `ModelProvider` streams reasoning, text, tool calls, and usage.
6. The gateway emits Anthropic-compatible SSE events, including structured
   `tool_use` blocks.
7. The UI applies those events to its structured reply model and persists the
   conversation locally.
8. The sidebar metadata and optional activity panel read the same persisted
   local session model and structured response blocks; no second conversation
   store is introduced.

## Implemented boundaries

- Provider boundary: `src/provider.ts`; DeepSeek is the production provider
  and the deterministic mock provider supports offline setup and tests.
- Tool boundary: `src/mcp.ts` and `src/skills.ts`; tools are namespaced,
  filtered, schema-checked, bounded, and marked as untrusted observations.
- Policy boundary: `src/permissions.ts`; UI selection is never an authorization
  grant.
- Transport boundary: `src/gateway.ts`; authentication, CORS, body limits,
  cancellation, SSE conversion, and capability discovery live here.
- Persistence boundary: `PersistenceAdapter` in `src/persistence.ts`; the
  current atomic JSON adapter serializes mutations per file, reloads before
  each write, and can be replaced by SQLite/PostgreSQL without changing the
  agent or gateway contracts.
- Workspace presentation boundary: `ui/src/components/sider` owns search,
  pinning, and archive navigation, while `ActivityPanel` renders only
  structured tool/source blocks received from the gateway stream.
- Project and knowledge boundary: `src/persistence.ts` stores owner-scoped
  projects, file metadata, extraction state, and knowledge chunks;
  `src/knowledge.ts` owns safe local storage, extraction, chunking, and
  keyword retrieval. The gateway exposes project/file/knowledge APIs and
  injects only the selected project's instructions and retrieved evidence.

## Known gaps

- Conversation persistence is local file-backed; there is no server database,
  account/authentication system, project store, or cross-device sync.
- Only DeepSeek and the deterministic mock provider are wired. Additional
  providers should implement `ModelProvider` rather than modify `Agent`.
- Approval is currently non-durable. A production approval flow needs a run ID,
  checkpoint store, resumable tool call, and UI approval card.
- Gateway startup marks queued/running runs as `paused`, and never replays their
  tool calls automatically. Durable continuation from a checkpoint is still
  intentionally not claimed.
- Run event replay is available through the SSE form of
  `GET /runs/:id/events` with `Last-Event-ID`; the UI client has a reusable
  `streamRunEvents` helper. On conversation load, the UI also queries
  `GET /runs` and reconciles terminal or paused runs into explicit message
  status without replaying side effects. The visible activity panel currently
  reflects the structured message stream rather than independently rendering
  the full run journal after refresh.
- MCP transport is currently stdio-based. The current SDK includes Streamable
  HTTP primitives, but remote connection management, OAuth, SSRF/DNS-rebinding
  defenses, and credential isolation are intentionally not exposed until they
  can be implemented as a dedicated secure transport boundary.
- Artifacts, long-term memory, project files, and evaluation scenarios need
  richer persistent domain models and APIs before their UI surfaces should
  claim to support them. Projects, uploaded files, extraction, keyword search,
  source links, and project-scoped conversations are now implemented; vector
  embeddings, reranking, and object-storage backends remain future work.
- Agent ecosystem boundary: `AgentRecord` is persisted by the same adapter and
  loaded by `src/gateway.ts` for every selected run. The gateway, not the
  browser, applies the agent's provider/model, instructions, skill allowlist,
  project allowlist, and tool allowlist. `/agents`, `/skills`, `/tools`, and
  `/mcp/servers` expose the real configured runtime state.
- Managed package boundary: user-uploaded `SKILL.md` packages are stored under
  the configured skill root and can be inspected, edited, enabled, and removed
  through the gateway. Skill content is treated as untrusted instructions;
  package scripts are never executed. Plugin, MCP, and connector metadata is
  owner-scoped in the persistence adapter, while actual MCP connectivity still
  comes only from the trusted gateway configuration.

## Implementation order

1. Provider registry and offline/mock execution.
2. Durable runs, approval, resume, and structured execution history.
3. Persistent projects, files, artifacts, and memory.
4. Secure remote MCP and connector credential flows.
5. Additional provider adapters and evaluation harnesses.
