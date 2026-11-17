# Implementation report

## Scope delivered in this run

This run implements the provider and durable-runtime foundation from the
ten-milestone directive without replacing the existing React/Rspack UI or
DeepSeek agent loop.

### Milestone 1 — persistence and data architecture

**Completed:** A dependency-free, atomic JSON workspace store now persists
conversations, messages, runs, versioned events, approvals/projects/memories/
artifacts collections, and run metadata. Conversations and runs have stable
IDs, timestamps, provider/model metadata, status, usage/error fields, and
replayable event sequences.

**Partial:** The store is single-user/local and is not a relational database.
Authentication, multi-user ownership, migrations, and server-side file/blob
storage remain unimplemented.

**Files:** `src/persistence.ts`, `test/core.test.ts`.

The store reloads under a per-file serialized mutation lock before every
write, uses unique temporary filenames plus atomic rename, assigns monotonic
per-run event sequences, and exposes the `PersistenceAdapter` interface.
Concurrent-writer, event-ordering, unique-ID, and owner-isolation tests pass.

### Milestone 2 — durable runtime and streaming

**Completed:** Gateway requests create queued/running runs, append structured
`run.*` events, persist user/assistant execution records, transition to
completed/failed/cancelled, and expose replay and cancellation endpoints:

- `GET /runs`
- `GET /runs/:id/events?after=<sequence>`
- `POST /runs/:id/cancel`
- `GET /conversations`

The existing SSE stream remains backward-compatible. Event records include
event ID, version, run ID, conversation ID, sequence, timestamp, type, and
payload. The gateway marks queued/running records as `paused` on startup,
tracks active abort controllers, makes cancellation idempotent, propagates
abort signals to provider/MCP execution, persists stable tool execution IDs
before and after calls, and serves replay as SSE with `Last-Event-ID`.
The UI client exposes `streamRunEvents` for reconciliation after refresh.
Automatic checkpoint continuation is intentionally not implemented: ambiguous
external side effects are not replayed.

**Files:** `src/gateway.ts`, `src/persistence.ts`,
`ui/src/services/chat/store.ts`, `ui/src/services/api/client.ts`.

### Milestone 3 — workspace UI

**Existing and preserved:** Rich markdown, code, math, attachments, search,
session navigation, model selection, workspace tabs, and structured response
parsing.

**Implemented:** The sidebar now supports persistent conversation search,
pinned conversations, archive/unarchive navigation, and metadata updates through
the existing IndexedDB store. The session view includes an optional responsive
activity panel that renders real structured search/read tool blocks, result
counts, source details, and current generation status from the gateway stream.

**Partial:** Durable run history and approval cards are not yet surfaced as
independent server-backed records in the panel. The existing message stream
remains authoritative for the visible activity cards.

### Projects, files, and knowledge workspace

**Implemented:** Owner-scoped project CRUD, project instructions, archive/delete,
project conversation history, safe local file storage, upload validation,
multi-file and drag-and-drop project uploads, extraction status, PDF/DOCX/text/
JSON/CSV/source-code extraction, chunking, keyword retrieval, project-scoped
knowledge search, source links, file preview/download/delete, and gateway
authorization checks. Project instructions are injected into the agent system
context, and the `knowledge_search` tool retrieves bounded untrusted evidence
for the active project. Vector search and reranking are intentionally not
claimed when no embedding provider is configured; keyword search is the real
fallback.

**Files:** `src/knowledge.ts`, `src/persistence.ts`, `src/gateway.ts`,
`ui/src/services/projects.ts`, `ui/src/components/projects/`.

### Agent ecosystem milestone

**Implemented:** Persistent owner-scoped agents with version snapshots, CRUD,
duplicate/delete/enable controls, provider/model/instruction configuration,
skill and tool allowlists, project allowlists, agent selection in the chat
composer, backend-enforced execution, and conversation metadata association.
The agent builder uses the real gateway skill and tool discovery data. The
gateway now exposes `/agents`, `/skills`, `/tools`, `/mcp/servers`, and enriched
`/capabilities` responses. Existing MCP tools retain schema validation,
timeouts, retries, bounded untrusted observations, and policy enforcement.

**Validated:** Agent CRUD/version persistence, owner isolation, selected-agent
mock execution, UI type-check, UI lint, production build, and the complete
root suite (21 passing tests).

**Files:** `src/persistence.ts`, `src/agent.ts`, `src/gateway.ts`,
`src/mcp.ts`, `src/skills.ts`, `ui/src/services/agents.ts`,
`ui/src/components/agents/AgentBuilder.tsx`.

**Managed capabilities:** `SKILL.md` upload, metadata inspection, source
editing, removal, and version metadata are now backed by the gateway. Plugin,
MCP, and connector records can be created, enabled/disabled, listed, and
removed as owner-scoped metadata. They remain `available` until a real backend
connection/authentication succeeds; no placeholder integration is reported as
connected.

### Milestone 4 — providers

**Completed:** `ModelProvider` is now the agent dependency. DeepSeek and the
credential-free deterministic Local mock are available through the gateway;
provider availability is reported by `/capabilities`.

**Partial:** OpenAI, Anthropic, Gemini, Mistral, OpenRouter, and Ollama adapters
are not implemented.

### Milestones 5–10

**Existing partial capabilities:** MCP/skills, permissions, tool validation,
context compaction, structured tool-use blocks, usage reporting, retries,
bounded observations, and gateway health/capability discovery.

**Not yet complete:** relational project storage, connector OAuth, durable approval/resume, artifact
versions, web research, user/project/agent memory controls, evaluation
scenarios, cost dashboards, OpenTelemetry export, and a production auth layer.

## Validation results

- Root tests: **21 passed, 0 failed**
- Root TypeScript type-check: **passed**
- UI TypeScript type-check: **passed**
- UI lint: **0 warnings, 0 errors**
- UI production build: **passed**
- `git diff --check`: **passed**
- Workspace UI steps: **search/pin/archive and activity panel type-check/lint
  passed; production build passed after the activity-panel step**
- Durable gateway smoke test: **HTTP 200**, run reached `completed`, replay
  returned `run.started`, `run.text`, `run.done`, and `run.completed`.
- Restart/replay smoke test: an active persisted run was restored as `paused`
  and its event journal replayed over SSE with event IDs.
- Projects/files integration: project creation, upload, extraction completion,
  keyword retrieval, source links, and unauthorized file access are covered.
- Agent ecosystem integration: agent CRUD/versioning, owner isolation, selected
  agent execution, managed skill lifecycle, real tool/skill discovery, and
  gateway policy boundaries are covered.

## Configuration and external dependencies

- DeepSeek production mode requires `DEEPSEEK_API_KEY` or a request API key.
- `deepseek-ui.config.json` supports `provider`, `dataFile`, `maxRetries`,
  `skills`, `mcp`, policy, origin, host, and port settings.
- Local mock mode requires no API key or external service.
- MCP servers remain optional and require their own commands/credentials.
- Remote Streamable HTTP MCP requires explicit HTTPS configuration; private/local
  DNS targets, URL credentials, and redirects are rejected. OAuth is not yet
  interactive.
- The JSON store defaults to `.deepseek-ui/workspace.json`; use `dataFile` to
  place it elsewhere.

## Remaining limitations

The JSON store is intentionally a reliable local foundation, not a substitute
for a multi-user database. The gateway currently records execution lifecycle
and replay but does not yet resume an interrupted model call from a checkpoint.
Approvals still use the existing policy callback and are not durable approval
requests. Browser reopen now queries the durable run list for the loaded
conversation and converts paused, failed, or cancelled in-flight messages into
explicit recoverable error/stopped states without retrying side effects. The
activity panel currently reflects structured stream blocks rather than
independently replaying run events after a full browser refresh. Plugin package
execution, MCP OAuth, connector secrets, large-scale object storage, OCR
for scanned PDFs/images, vector embeddings, reranking, and richer page-level
previews are still required for the full production vision. The UI deliberately
does not show unconfigured plugins/connectors as connected integrations.
