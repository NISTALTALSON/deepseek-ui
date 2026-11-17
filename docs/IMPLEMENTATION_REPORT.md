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

**Not yet complete:** relational projects/files/knowledge retrieval, agent
builder, connector OAuth, remote HTTP MCP, durable approval/resume, artifact
versions, web research, user/project/agent memory controls, evaluation
scenarios, cost dashboards, OpenTelemetry export, and a production auth layer.

## Validation results

- Root tests: **15 passed, 0 failed**
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

## Configuration and external dependencies

- DeepSeek production mode requires `DEEPSEEK_API_KEY` or a request API key.
- `deepseek-ui.config.json` supports `provider`, `dataFile`, `maxRetries`,
  `skills`, `mcp`, policy, origin, host, and port settings.
- Local mock mode requires no API key or external service.
- MCP servers remain optional and require their own commands/credentials.
- The JSON store defaults to `.deepseek-ui/workspace.json`; use `dataFile` to
  place it elsewhere.

## Remaining limitations

The JSON store is intentionally a reliable local foundation, not a substitute
for a multi-user database. The gateway currently records execution lifecycle
and replay but does not yet resume an interrupted model call from a checkpoint.
Approvals still use the existing policy callback and are not durable approval
requests. Browser reconnect logic is exposed as a replay helper but is not yet
automatically integrated into the chat store. The activity panel currently
reflects structured stream blocks rather than independently replaying run events
after a full browser refresh. Remote MCP/OAuth, connector secrets,
artifact/file/project APIs, additional provider adapters, and evaluation
benchmarks are still required for the full production vision.
