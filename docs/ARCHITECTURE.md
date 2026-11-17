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
- Consequential tool calls now create owner-scoped durable approval records with
  immutable arguments, schema fingerprints, operation hashes, expiry, and
  compare-and-set decisions. The active run pauses at `awaiting_approval` and
  resumes the original call after approval through `/approvals/:id`. A gateway
  restart preserves the approval record and checkpoint; approved tool
  continuation is reconstructed only when the persisted operation is safe to
  resume.
- Execution checkpoints now persist normalized agent messages, pending tool
  calls, operation references, provider/model configuration, phase, sequence,
  and an integrity hash. A run lease prevents two gateway workers from
  resuming the same run. `/runs/:id/checkpoint`, `/checkpoint-history`,
  `/recovery`, and `/resume` expose owner-scoped recovery controls.
- Gateway startup marks queued/running runs as `paused`, and never replays
  side effects automatically. A valid checkpoint plus an approved operation
  can be reconstructed by the resume worker; completed journal entries are
  reused. Running/ambiguous external operations remain paused and require
  reconciliation rather than blind retry.
- Run event replay is available through the SSE form of
  `GET /runs/:id/events` with `Last-Event-ID`; the UI client has a reusable
  `streamRunEvents` helper. On conversation load, the UI also queries
  `GET /runs` and reconciles terminal or paused runs into explicit message
  status without replaying side effects. The visible activity panel currently
  reflects the structured message stream rather than independently rendering
  the full run journal after refresh.
- MCP supports trusted local stdio and explicitly configured Streamable HTTP.
  Remote URLs must use HTTPS, cannot contain inline credentials, resolve only
  to public addresses, reject redirects, and receive only that server's
  configured headers. OAuth lifecycle and interactive credential setup remain
  future work; no browser credential is forwarded to MCP.
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
- Connector boundary: `src/connectors.ts` defines connector capabilities and
  registers connector tools through the same `Agent` tool path as MCP and
  skills. Connector access tokens are encrypted with AES-256-GCM in
  `src/credentials.ts`; plaintext credentials never enter checkpoints, API
  responses, or tool metadata. OAuth transactions are owner-bound, expiring,
  one-time records with PKCE verifier state. Real connector routes require
  `GATEWAY_API_KEY`, `GATEWAY_OWNER`, and `CREDENTIAL_ENCRYPTION_KEY`; local
  workspace-header mode cannot create or use external credentials.
- GitHub currently provides executable repository listing, file reads, and
  approval-classified issue creation. Google Drive and Notion are registered
  as capability placeholders until provider OAuth endpoints and resource
  boundaries are configured; they are not reported as connected by metadata
  alone.
- Artifact boundary: `ArtifactRecord` in `src/persistence.ts` stores
  owner-scoped, conversation/project-associated content with append-only
  versions. `POST/PATCH /artifacts` never overwrites an earlier version;
  restore creates a new version, and download returns only the current
  owner-authorized content. The agent exposes `artifact_create` and
  `artifact_update` through the same approval, journal, checkpoint, and
  recovery path as other side-effecting tools. Artifact creation carries a
  stable tool-call execution marker so recovery can reuse a completed local
  mutation instead of duplicating it.
- Artifact preview boundary: the UI artifact panel renders markdown and
  source content locally, while HTML is placed in an iframe with an empty
  sandbox and restrictive CSP. Generated HTML/JavaScript is never executed in
  the trusted application origin.
- Research boundary: `src/research/` implements a provider-independent
  `SearchProvider` (Tavily live adapter plus a deterministic local fixture
  provider), a safe fetcher that rejects private/loopback/link-local
  destinations, pins the validated DNS answer for the socket, revalidates every
  redirect, bounds size/time, and refuses non-textual responses, and a
  readability-style extractor that returns plain sanitized text only.
  `ResearchEngine` performs bounded query generation, de-duplication, page
  retrieval, relevance ranking, numeric-claim conflict detection, and cited
  brief synthesis. The gateway registers `web_search`, `web_fetch`,
  `web_extract`, and `research_sources` as read-only builtin tools through the
  same permission, journal, checkpoint, and resume path as other tools, and
  maps their results to `server_tool_use`, `web_search_tool_result`, and
  `web_fetch_tool_result` blocks so the activity panel, citation chips, and
  search panel work without a parallel UI store. Each snapshot is persisted as
  an owner-scoped `ResearchSourceRecord` (URL, canonical URL, domain, title,
  snippet, extraction, retrieval time, publication date, provider, mock flag,
  citation index); artifacts may reference those ids and keep them per version.
  Endpoints: `GET /research/status`, `GET /research/sources`,
  `GET /research/sources/:id`, `POST /research/search`, `POST /research/run`.
  Mock results are always labelled as local fixtures in the tool payload, the
  SSE blocks, and the UI; they are never presented as internet results.
- Research security boundary: retrieved page text is untrusted evidence. The
  extractor strips scripts/styles/hidden elements/comments before extraction,
  and the agent wraps every tool observation in an untrusted envelope. The
  research system prompt forbids following page instructions or inventing
  URLs, dates, quotes, and citations. Live retrieval honors a cached
  robots.txt policy, serializes per-host requests, and never executes page
  JavaScript.
- Managed package boundary: user-uploaded `SKILL.md` packages are stored under
  the configured skill root and can be inspected, edited, enabled, and removed
  through the gateway. Skill content is treated as untrusted instructions;
  package scripts are never executed. Plugin, MCP, and connector metadata is
  owner-scoped in the persistence adapter, while actual MCP connectivity still
  comes only from the trusted gateway configuration.
- Research gaps: only the Tavily adapter and the deterministic local fixture
  provider are wired. Fetched pages must be HTML/XHTML/plain text; there is no
  JavaScript rendering, PDF/image extraction, crawl queue, CAPTCHA handling, or
  embedding reranker. robots.txt is best-effort and extraction is heuristic.
  Workflow synthesis is extractive (the agent model writes the final answer);
  research activity for `research_sources` run mode appears after the call
  completes rather than streaming each internal query. Mock mode never performs
  internet search and every surface labels it accordingly.

## Implementation order

1. Provider registry and offline/mock execution.
2. Durable runs, approval, resume, and structured execution history.
3. Persistent projects, files, artifacts, and memory.
4. Secure remote MCP and connector credential flows.
5. Additional provider adapters and evaluation harnesses.
6. Web research: provider abstraction, SSRF-safe retrieval, cited answers,
   research activity, and research artifacts (implemented).
