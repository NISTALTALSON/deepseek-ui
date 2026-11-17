import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { Agent } from "./agent.js";
import { createProvider } from "./provider.js";
import { McpHub, type McpConfig } from "./mcp.js";
import { Permissions, defaultPolicy, type PolicyConfig } from "./permissions.js";
import { SkillRegistry } from "./skills.js";
import { WorkspaceStore, type AgentRecord } from "./persistence.js";
import { FileStorage, MAX_FILE_BYTES, processFile, validateUpload } from "./knowledge.js";
import type { AssistantMessage, Message } from "./types.js";

export type GatewayConfig = {
  host?: string;
  port?: number;
  model?: string;
  baseUrl?: string;
  maxRetries?: number;
  provider?: "deepseek" | "mock";
  mockDelayMs?: number;
  mcp?: McpConfig;
  policy?: PolicyConfig;
  skills?: string[];
  allowedOrigins?: string[];
  maxRequestBytes?: number;
  dataFile?: string;
  filesRoot?: string;
};

export type GatewayCapabilities = {
  ok?: boolean;
  skills: string[];
  mcpServers: string[];
  tools: number;
  providers: Array<{ id: string; name: string; configured: boolean }>;
  toolsList?: Array<{ name: string; description: string; readOnly?: boolean; timeoutMs?: number }>;
};

type AnthropicContent =
  | string
  | Array<{
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
    }>;

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContent;
};

type AnthropicRequest = {
  model?: string;
  system?: string;
  messages?: AnthropicMessage[];
  thinking?: { type?: "enabled" | "disabled" };
  max_tokens?: number;
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const readLimitedBody = async (req: IncomingMessage, maxBytes: number): Promise<Buffer> => {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (contentLength > maxBytes) throw new Error("Request body is too large");
  const body = await readBody(req);
  if (body.byteLength > maxBytes) throw new Error("Request body is too large");
  return body;
};

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const csvHeader = (headers: IncomingHttpHeaders, name: string): Set<string> | undefined => {
  const value = header(headers, name);
  if (!value) return undefined;
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
};

export const getRequestApiKey = (headers: IncomingHttpHeaders, fallback?: string): string | undefined => {
  const direct = header(headers, "x-api-key");
  if (direct) return direct;
  const authorization = header(headers, "authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return fallback;
};

const contentText = (content: AnthropicContent, includeThinking = true): string =>
  typeof content === "string"
    ? content
    : content
        .map((block) =>
          block.text ??
          (includeThinking ? block.thinking : undefined) ??
          (block.type === "image" || block.type === "document" ? "[attachment]" : "")
        )
        .filter(Boolean)
        .join("");

export const toAgentMessages = (messages: AnthropicMessage[]): Message[] =>
  messages.flatMap((message): Message[] => {
    const text = contentText(message.content, message.role === "user");
    if (!text) return [];
    if (message.role === "user") return [{ role: "user", content: text }];
    const blocks = Array.isArray(message.content) ? message.content : [];
    const reasoning = blocks
      .filter((block) => block.type === "thinking" && block.thinking)
      .map((block) => block.thinking)
      .join("");
    const assistant: AssistantMessage = { role: "assistant", content: text };
    if (reasoning) assistant.reasoning_content = reasoning;
    return [assistant];
  });

const writeEvent = (res: ServerResponse, event: string, data: unknown) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const proxy = async (
  req: IncomingMessage,
  res: ServerResponse,
  upstream: string,
  apiKey: string
) => {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readLimitedBody(req, 10_000_000);
  const response = await fetch(upstream, {
    method: req.method,
    headers: {
      ...(header(req.headers, "content-type") ? { "content-type": header(req.headers, "content-type")! } : {}),
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      ...(header(req.headers, "anthropic-beta") ? { "anthropic-beta": header(req.headers, "anthropic-beta")! } : {}),
    },
    body: body ? new Blob([new Uint8Array(body)]) : undefined,
  });
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  }
  res.end();
};

const loadConfig = async (): Promise<GatewayConfig> => {
  try {
    return JSON.parse(await readFile("deepseek-ui.config.json", "utf8")) as GatewayConfig;
  } catch {
    return {};
  }
};

export const createGateway = async (config: GatewayConfig = {}) => {
  const cfg = { ...config };
  const upstreamKey = process.env.DEEPSEEK_API_KEY;
  const upstream = cfg.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const mcp = new McpHub();
  if (cfg.mcp) await mcp.connect(cfg.mcp);
  const skills = new SkillRegistry();
  await skills.scan(cfg.skills ?? ["./skills"]);
  const permissions = new Permissions(
    cfg.policy ?? {
      ...defaultPolicy,
      rules: [...defaultPolicy.rules, { tool: "knowledge_search", decision: "allow" }],
      default: "deny",
    },
    async () => false,
  );
  const store = new WorkspaceStore(cfg.dataFile);
  const fileStorage = new FileStorage(cfg.filesRoot);
  await store.load();
  await store.recoverInterruptedRuns();
  const activeRuns = new Map<string, AbortController>();

  const server = createServer(async (req, res) => {
    const origin = header(req.headers, "origin");
    const allowedOrigins = cfg.allowedOrigins ?? ["http://localhost:8090", "http://127.0.0.1:8090"];
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
    res.setHeader(
      "access-control-allow-headers",
      "content-type, authorization, x-api-key, anthropic-beta, x-deepseek-ui-agent, x-deepseek-ui-skills, x-deepseek-ui-integrations, x-deepseek-ui-provider, x-deepseek-ui-workspace, x-deepseek-ui-project, x-project-id, x-conversation-id, x-file-name",
    );
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if ((req.url === "/health" || req.url === "/capabilities") && req.method === "GET") {
      const capabilities: GatewayCapabilities = {
        ok: true,
        tools: mcp.tools().length,
        skills: skills.list().map((skill) => skill.name),
        mcpServers: mcp.serverNames(),
        providers: [
          { id: "deepseek", name: "DeepSeek", configured: Boolean(upstreamKey) },
          { id: "mock", name: "Local mock", configured: true },
        ],
        toolsList: mcp.tools().map((tool) => ({
          name: tool.name, description: tool.description, readOnly: tool.readOnly, timeoutMs: tool.timeoutMs,
        })),
      };
      json(res, 200, capabilities);
      return;
    }

    const requestedProvider = header(req.headers, "x-deepseek-ui-provider");
    const provider = requestedProvider === "mock" || cfg.provider === "mock" ? "mock" : "deepseek";
    const owner = header(req.headers, "x-deepseek-ui-workspace") ?? "local";
    const apiKey = getRequestApiKey(req.headers, upstreamKey);
    const gatewayKey = process.env.GATEWAY_API_KEY;
    if (gatewayKey && apiKey !== gatewayKey) {
      json(res, 401, { error: { message: "Invalid gateway API key", type: "authentication_error" } });
      return;
    }
    if (!apiKey && provider !== "mock") {
      json(res, 401, { error: { message: "Missing API key", type: "authentication_error" } });
      return;
    }
    const requestUrl = new URL(req.url ?? "/", "http://localhost");

    if (requestUrl.pathname === "/agents" && req.method === "GET") {
      json(res, 200, { agents: await store.listAgents(owner, requestUrl.searchParams.get("includeDisabled") === "true") });
      return;
    }
    if (requestUrl.pathname === "/agents" && req.method === "POST") {
      try {
        const body = JSON.parse((await readLimitedBody(req, cfg.maxRequestBytes ?? 2_000_000)).toString("utf8")) as Partial<AgentRecord>;
        if (typeof body.name !== "string" || !body.name.trim()) throw new Error("Agent name is required");
        const agent = await store.createAgent({
          owner,
          name: body.name,
          description: typeof body.description === "string" ? body.description : "",
          avatar: typeof body.avatar === "string" ? body.avatar : undefined,
          instructions: typeof body.instructions === "string" ? body.instructions : "",
          provider: body.provider === "deepseek" ? "deepseek" : "mock",
          model: typeof body.model === "string" ? body.model : "mock",
          parameters: body.parameters && typeof body.parameters === "object" ? body.parameters : {},
          skillNames: Array.isArray(body.skillNames) ? body.skillNames.filter((item): item is string => typeof item === "string") : [],
          allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.filter((item): item is string => typeof item === "string") : [],
          projectIds: Array.isArray(body.projectIds) ? body.projectIds.filter((item): item is string => typeof item === "string") : [],
          memoryEnabled: body.memoryEnabled !== false,
          welcomeMessage: typeof body.welcomeMessage === "string" ? body.welcomeMessage : "",
          examplePrompts: Array.isArray(body.examplePrompts) ? body.examplePrompts.filter((item): item is string => typeof item === "string") : [],
          enabled: body.enabled !== false,
        });
        json(res, 201, { agent });
      } catch (error) {
        json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    const agentMatch = requestUrl.pathname.match(/^\/agents\/([^/]+)$/);
    if (agentMatch && req.method === "GET") {
      const agent = await store.getAgent(agentMatch[1], owner);
      json(res, agent ? 200 : 404, agent ? { agent } : { error: { message: "Agent not found" } });
      return;
    }
    if (agentMatch && req.method === "PATCH") {
      try {
        const body = JSON.parse((await readLimitedBody(req, cfg.maxRequestBytes ?? 2_000_000)).toString("utf8")) as Partial<AgentRecord>;
        const patch: Partial<AgentRecord> = {
          ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.avatar === "string" ? { avatar: body.avatar } : {}),
          ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
          ...(body.provider === "deepseek" || body.provider === "mock" ? { provider: body.provider } : {}),
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(body.parameters && typeof body.parameters === "object" ? { parameters: body.parameters } : {}),
          ...(Array.isArray(body.skillNames) ? { skillNames: body.skillNames.filter((item): item is string => typeof item === "string") } : {}),
          ...(Array.isArray(body.allowedTools) ? { allowedTools: body.allowedTools.filter((item): item is string => typeof item === "string") } : {}),
          ...(Array.isArray(body.projectIds) ? { projectIds: body.projectIds.filter((item): item is string => typeof item === "string") } : {}),
          ...(typeof body.memoryEnabled === "boolean" ? { memoryEnabled: body.memoryEnabled } : {}),
          ...(typeof body.welcomeMessage === "string" ? { welcomeMessage: body.welcomeMessage } : {}),
          ...(Array.isArray(body.examplePrompts) ? { examplePrompts: body.examplePrompts.filter((item): item is string => typeof item === "string") } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        };
        const agent = await store.updateAgent(agentMatch[1], owner, patch);
        json(res, agent ? 200 : 404, agent ? { agent } : { error: { message: "Agent not found" } });
      } catch (error) {
        json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    if (agentMatch && req.method === "DELETE") {
      const deleted = await store.deleteAgent(agentMatch[1], owner);
      json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: { message: "Agent not found" } });
      return;
    }

    if (requestUrl.pathname === "/projects" && req.method === "GET") {
      json(res, 200, { projects: await store.listProjects(owner, requestUrl.searchParams.get("includeArchived") === "true") });
      return;
    }
    if (requestUrl.pathname === "/projects" && req.method === "POST") {
      try {
        const body = JSON.parse((await readLimitedBody(req, cfg.maxRequestBytes ?? 2_000_000)).toString("utf8")) as Record<string, unknown>;
        if (typeof body.name !== "string" || !body.name.trim()) throw new Error("Project name is required");
        json(res, 201, { project: await store.createProject({
          owner, name: body.name.trim(), description: typeof body.description === "string" ? body.description : "",
          instructions: typeof body.instructions === "string" ? body.instructions : "",
          preferredModel: typeof body.preferredModel === "string" ? body.preferredModel : undefined,
          preferredAgent: typeof body.preferredAgent === "string" ? body.preferredAgent : undefined,
          memoryEnabled: body.memoryEnabled !== false, config: typeof body.config === "object" && body.config ? body.config as Record<string, unknown> : {},
        }) });
      } catch (error) {
        json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    const projectMatch = requestUrl.pathname.match(/^\/projects\/([^/]+)$/);
    if (projectMatch && req.method === "GET") {
      const project = await store.getProject(projectMatch[1], owner);
      json(res, project ? 200 : 404, project ? { project } : { error: { message: "Project not found" } });
      return;
    }
    if (projectMatch && req.method === "PATCH") {
      try {
        const patch = JSON.parse((await readLimitedBody(req, cfg.maxRequestBytes ?? 2_000_000)).toString("utf8")) as Record<string, unknown>;
        const project = await store.updateProject(projectMatch[1], owner, {
          ...(typeof patch.name === "string" ? { name: patch.name.trim() } : {}),
          ...(typeof patch.description === "string" ? { description: patch.description } : {}),
          ...(typeof patch.instructions === "string" ? { instructions: patch.instructions } : {}),
          ...(typeof patch.preferredModel === "string" ? { preferredModel: patch.preferredModel } : {}),
          ...(typeof patch.preferredAgent === "string" ? { preferredAgent: patch.preferredAgent } : {}),
          ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
        });
        json(res, project ? 200 : 404, project ? { project } : { error: { message: "Project not found" } });
      } catch (error) {
        json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    if (projectMatch && req.method === "DELETE") {
      const deleted = await store.deleteProject(projectMatch[1], owner);
      json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: { message: "Project not found" } });
      return;
    }
    const projectFilesMatch = requestUrl.pathname.match(/^\/projects\/([^/]+)\/files$/);
    if (projectFilesMatch && req.method === "GET") {
      if (!await store.getProject(projectFilesMatch[1], owner)) {
        json(res, 404, { error: { message: "Project not found" } });
        return;
      }
      const projectConversationsMatch = requestUrl.pathname.match(/^\/projects\/([^/]+)\/conversations$/);
      if (projectConversationsMatch && req.method === "GET") {
        if (!await store.getProject(projectConversationsMatch[1], owner)) {
          json(res, 404, { error: { message: "Project not found" } });
          return;
        }
        const conversations = (await store.listConversations(owner)).filter((conversation) => conversation.metadata.projectId === projectConversationsMatch[1]);
        json(res, 200, { conversations });
        return;
      }
      json(res, 200, { files: await store.listFiles(owner, projectFilesMatch[1]) });
      return;
    }
    if (requestUrl.pathname === "/files" && req.method === "GET") {
      json(res, 200, { files: await store.listFiles(owner, requestUrl.searchParams.get("projectId") ?? undefined, requestUrl.searchParams.get("conversationId") ?? undefined) });
      return;
    }
    if (requestUrl.pathname === "/files" && req.method === "POST") {
      try {
        const name = header(req.headers, "x-file-name") ?? "";
        const projectId = header(req.headers, "x-project-id") ?? undefined;
        const conversationId = header(req.headers, "x-conversation-id") ?? undefined;
        const body = await readLimitedBody(req, cfg.maxRequestBytes ?? MAX_FILE_BYTES);
        const info = validateUpload(name, body.byteLength);
        if (projectId && !await store.getProject(projectId, owner)) throw new Error("Project not found");
        const id = randomUUID();
        const storageKey = await fileStorage.put(id, body);
        const file = await store.createFile({
          id, owner, projectId, conversationId, originalName: name, mimeType: header(req.headers, "content-type") ?? info.mimeType,
          size: body.byteLength, storageKey, extractionStatus: "queued", metadata: { extension: info.extension },
        });
        void processFile(store, fileStorage, file);
        json(res, 201, { file });
      } catch (error) {
        json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    const fileMatch = requestUrl.pathname.match(/^\/files\/([^/]+)$/);
    if (fileMatch && req.method === "GET") {
      const file = await store.getFile(fileMatch[1], owner);
      json(res, file ? 200 : 404, file ? { file } : { error: { message: "File not found" } });
      return;
    }
    const fileContentMatch = requestUrl.pathname.match(/^\/files\/([^/]+)\/content$/);
    if (fileContentMatch && req.method === "GET") {
      const file = await store.getFile(fileContentMatch[1], owner);
      if (!file) {
        json(res, 404, { error: { message: "File not found" } });
        return;
      }
      const content = await fileStorage.read(file.storageKey);
      res.writeHead(200, { "content-type": file.mimeType, "content-length": content.byteLength, "content-disposition": `inline; filename="${file.originalName.replace(/["\r\n]/g, "")}"` });
      res.end(content);
      return;
    }
    if (fileMatch && req.method === "DELETE") {
      const file = await store.getFile(fileMatch[1], owner);
      if (!file) {
        json(res, 404, { error: { message: "File not found" } });
        return;
      }
      await fileStorage.remove(file.storageKey);
      await store.deleteFile(file.id, owner);
      json(res, 200, { ok: true });
      return;
    }
    if (requestUrl.pathname === "/knowledge/search" && req.method === "POST") {
      try {
        const body = JSON.parse((await readLimitedBody(req, cfg.maxRequestBytes ?? 2_000_000)).toString("utf8")) as { query?: string; projectId?: string; limit?: number };
        if (!body.query?.trim()) throw new Error("query is required");
        const chunks = await store.searchKnowledge(owner, body.query, body.projectId, Math.min(20, Math.max(1, body.limit ?? 8)));
        json(res, 200, { results: chunks.map((chunk) => ({
          id: chunk.id, content: chunk.content, page: chunk.page, section: chunk.section, fileId: chunk.fileId,
          source: `Source: [${chunk.metadata.filename ?? chunk.fileId}](/files/${chunk.fileId}/content)${chunk.page ? ` (page ${chunk.page})` : ""}`,
        })) });
      } catch (error) {
        json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    const runEventsMatch = requestUrl.pathname.match(/^\/runs\/([^/]+)\/events$/);
    if (runEventsMatch && req.method === "GET") {
      const run = await store.getRun(runEventsMatch[1]);
      if (!run || run.owner !== owner) {
        json(res, 404, { error: { message: "Run not found" } });
        return;
      }
      const after = Number(requestUrl.searchParams.get("after") ?? "-1");
      let events = await store.events(runEventsMatch[1], Number.isFinite(after) ? after : -1);
      const lastEventId = header(req.headers, "last-event-id");
      if (lastEventId) {
        const all = await store.events(runEventsMatch[1], -1);
        const cursor = all.find((event) => event.id === lastEventId)?.sequence;
        if (cursor !== undefined) events = all.filter((event) => event.sequence > cursor);
      }
      if (header(req.headers, "accept")?.includes("text/event-stream")) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        for (const event of events) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } else {
        json(res, 200, { events });
      }
      return;
    }
    if (requestUrl.pathname === "/runs" && req.method === "GET") {
      json(res, 200, { runs: await store.runs(owner) });
      return;
    }
    if (requestUrl.pathname === "/conversations" && req.method === "GET") {
      json(res, 200, { conversations: await store.listConversations(owner) });
      return;
    }
    const cancelMatch = requestUrl.pathname.match(/^\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      const existing = await store.getRun(cancelMatch[1]);
      if (!existing || existing.owner !== owner) {
        json(res, 404, { error: { message: "Run not found" } });
        return;
      }
      activeRuns.get(cancelMatch[1])?.abort();
      const current = await store.getRun(cancelMatch[1]);
      const run = current && ["completed", "failed", "cancelled", "expired"].includes(current.status)
        ? current
        : await store.updateRun(cancelMatch[1], { status: "cancelled" });
      json(res, run ? 200 : 404, run ?? { error: { message: "Run not found" } });
      return;
    }

    if (req.url === "/models" || req.url?.startsWith("/anthropic/v1/files")) {
      if (!apiKey) {
        json(res, 401, { error: { message: "Missing API key", type: "authentication_error" } });
        return;
      }
      try {
        await proxy(req, res, `${upstream}${req.url}`, apiKey);
      } catch (error) {
        json(res, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (req.url !== "/anthropic/v1/messages" || req.method !== "POST") {
      json(res, 404, { error: { message: "Not found", type: "not_found_error" } });
      return;
    }

    let input: AnthropicRequest;
    try {
      input = JSON.parse(
        (await readLimitedBody(req, cfg.maxRequestBytes ?? 2_000_000)).toString("utf8"),
      ) as AnthropicRequest;
    } catch {
      json(res, 400, { error: { message: "Request body must be valid JSON", type: "invalid_request_error" } });
      return;
    }
    if (!input.messages?.length) {
      json(res, 400, { error: { message: "messages must not be empty", type: "invalid_request_error" } });
      return;
    }

    const selectedAgentId = header(req.headers, "x-deepseek-ui-agent");
    const selectedAgent = selectedAgentId ? await store.getAgent(selectedAgentId, owner) : undefined;
    if (selectedAgentId && (!selectedAgent || !selectedAgent.enabled)) {
      json(res, 403, { error: { message: "Agent is unavailable for this workspace" } });
      return;
    }
    const selectedProjectId = header(req.headers, "x-deepseek-ui-project") ?? undefined;
    if (selectedAgent?.projectIds.length && selectedProjectId && !selectedAgent.projectIds.includes(selectedProjectId)) {
      json(res, 403, { error: { message: "Agent is not allowed in this project" } });
      return;
    }
    const effectiveProvider = selectedAgent?.provider ?? provider;
    const effectiveModel = selectedAgent?.model ?? input.model ?? cfg.model ?? "deepseek-flash";
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const agent = new Agent({
      client: createProvider(effectiveProvider, {
        apiKey: apiKey ?? "",
        baseUrl: upstream,
        model: process.env.DEEPSEEK_MODEL ?? effectiveModel,
        reasoningEffort: input.thinking?.type === "enabled" ? "high" : "none",
        maxRetries: cfg.maxRetries,
        mockDelayMs: cfg.mockDelayMs,
      }),
      mcp,
      skills,
      permissions,
      systemPrompt: [input.system ?? "You are a helpful assistant.", selectedAgent?.instructions].filter(Boolean).join("\n\n"),
      maxIterations: input.max_tokens ? Math.max(1, Math.min(40, Math.ceil(input.max_tokens / 256))) : undefined,
      enabledSkills: new Set(
        [...(csvHeader(req.headers, "x-deepseek-ui-skills") ?? new Set<string>())]
          .filter((skill) => !selectedAgent || selectedAgent.skillNames.includes(skill)),
      ),
      enabledMcpServers: csvHeader(req.headers, "x-deepseek-ui-integrations"),
      maxContextChars: 120_000,
      projectInstructions: (await store.getProject(header(req.headers, "x-deepseek-ui-project") ?? "", owner))?.instructions,
      knowledgeSearch: async (query) => {
        const projectId = header(req.headers, "x-deepseek-ui-project") ?? undefined;
        const chunks = await store.searchKnowledge(owner, query, projectId, 8);
        if (!chunks.length) return "No relevant project knowledge was found.";
        return chunks.map((chunk) =>
          `[Source: ${chunk.metadata.filename ?? chunk.fileId}](/files/${chunk.fileId}/content)${chunk.page ? ` (page ${chunk.page})` : ""}\n${chunk.content}`,
        ).join("\n\n");
      },
      allowedTools: selectedAgent ? new Set(selectedAgent.allowedTools) : undefined,
    });
    const conversationId = header(req.headers, "x-deepseek-ui-conversation") ?? randomUUID();
    await store.conversation({
      id: conversationId,
      owner,
      provider: effectiveProvider,
      model: effectiveModel,
      metadata: {
        projectId: header(req.headers, "x-deepseek-ui-project") ?? undefined,
        agentId: selectedAgent?.id,
      },
    });
    const run = await store.createRun({
      owner,
      conversationId,
      provider: effectiveProvider,
      model: effectiveModel,
    });
    activeRuns.set(run.id, controller);
    const emit = async (type: string, payload: Record<string, unknown>) => {
      await store.appendEvent(run.id, conversationId, type, payload);
    };
    await store.updateRun(run.id, { status: "running" });
    await emit("run.started", { provider: effectiveProvider, model: run.model });
    const history = toAgentMessages(input.messages);
    const latest = history.at(-1);
    const prompt = latest?.role === "user" ? latest.content : "";
    agent.messages.push(...(latest?.role === "user" ? history.slice(0, -1) : history));
    await store.appendMessage({ conversationId, runId: run.id, role: "user", content: prompt });

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const messageId = randomUUID();
    writeEvent(res, "message_start", {
      type: "message_start",
      message: { id: messageId, type: "message", role: "assistant",       model: effectiveModel, usage: { input_tokens: 0, output_tokens: 0 } },
    });
    let index = 0;
    let usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 };
    let textIndex: number | undefined;
    let thinkingIndex: number | undefined;
    const toolIndexes = new Map<string, number>();
    const ensureBlock = (kind: "text" | "thinking") => {
      const current = kind === "text" ? textIndex : thinkingIndex;
      if (current !== undefined) return current;
      const next = index++;
      if (kind === "text") textIndex = next;
      else thinkingIndex = next;
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index: next,
        content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" },
      });
      return next;
    };

    try {
      for await (const event of agent.run(prompt, controller.signal)) {
        const eventPayload =
          event.type === "text" || event.type === "reasoning"
            ? { delta: event.delta }
            : event.type === "tool_start"
              ? { id: event.id, name: event.name, args: event.args }
              : event.type === "tool_result"
                ? { id: event.id, name: event.name, output: event.output }
                : event.type === "tool_denied"
                  ? { id: event.id, name: event.name }
                  : { usage: event.usage };
        await emit(`run.${event.type}`, eventPayload);
        if (event.type === "reasoning") {
          writeEvent(res, "content_block_delta", { type: "content_block_delta", index: ensureBlock("thinking"), delta: { type: "thinking_delta", thinking: event.delta } });
        } else if (event.type === "text") {
          writeEvent(res, "content_block_delta", { type: "content_block_delta", index: ensureBlock("text"), delta: { type: "text_delta", text: event.delta } });
        } else if (event.type === "tool_start") {
          await store.beginToolExecution({
            id: `${run.id}:${event.id}`,
            runId: run.id,
            toolName: event.name,
            argumentsHash: createHash("sha256").update(JSON.stringify(event.args)).digest("hex"),
          });
          const toolIndex = index++;
          toolIndexes.set(event.id, toolIndex);
          writeEvent(res, "content_block_start", {
            type: "content_block_start",
            index: toolIndex,
            content_block: { type: "tool_use", id: event.id, name: event.name, input: event.args },
          });
        } else if (event.type === "tool_result") {
          await store.finishToolExecution(`${run.id}:${event.id}`, { status: "completed", output: event.output });
          const toolIndex = toolIndexes.get(event.id);
          if (toolIndex !== undefined) {
            writeEvent(res, "content_block_stop", { type: "content_block_stop", index: toolIndex });
          }
          writeEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: ensureBlock("text"),
            delta: { type: "text_delta", text: `\n[${event.name} result]\n${event.output}\n` },
          });
        } else if (event.type === "tool_denied") {
          await store.finishToolExecution(`${run.id}:${event.id}`, { status: "failed", error: "Denied by policy" });
          const toolIndex = toolIndexes.get(event.id);
          if (toolIndex !== undefined) {
            writeEvent(res, "content_block_stop", { type: "content_block_stop", index: toolIndex });
          }
          writeEvent(res, "content_block_delta", { type: "content_block_delta", index: ensureBlock("text"), delta: { type: "text_delta", text: `\n[Denied: ${event.name}]\n` } });
        } else if (event.type === "done" && event.usage) {
          usage = {
            input_tokens: event.usage.prompt_tokens ?? 0,
            output_tokens: event.usage.completion_tokens ?? 0,
          };
        }
      }
      for (const blockIndex of [thinkingIndex, textIndex]) {
        if (blockIndex !== undefined) writeEvent(res, "content_block_stop", { type: "content_block_stop", index: blockIndex });
      }
      writeEvent(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage });
      writeEvent(res, "message_stop", { type: "message_stop" });
      await store.appendMessage({
        conversationId,
        runId: run.id,
        role: "assistant",
        content: "streamed",
        metadata: { provider: effectiveProvider, usage },
      });
      await store.updateRun(run.id, { status: "completed" });
      await emit("run.completed", { usage });
      res.end();
    } catch (error) {
      const cancelled = controller.signal.aborted;
      await store.updateRun(run.id, { status: cancelled ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error) });
      await emit(cancelled ? "run.cancelled" : "run.failed", { error: error instanceof Error ? error.message : String(error) });
      if (!res.writableEnded) {
        writeEvent(res, "error", { type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } });
        res.end();
      }
    } finally {
      activeRuns.delete(run.id);
    }
  });

  return {
    server,
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
};

if (process.argv[1]?.endsWith("gateway.ts")) {
  const config = await loadConfig();
  const gateway = await createGateway(config);
  const host = config.host ?? process.env.GATEWAY_HOST ?? "127.0.0.1";
  const port = config.port ?? Number(process.env.GATEWAY_PORT ?? 8787);
  gateway.server.listen(port, host, () => {
    console.log(`Gateway listening on http://${host}:${port}`);
  });
}
