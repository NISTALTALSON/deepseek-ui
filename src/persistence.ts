import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Message, ToolCall } from "./types.js";

export type RunStatus = "queued" | "running" | "awaiting_approval" | "paused" | "completed" | "failed" | "cancelled" | "expired";
export type ExecutionPhase =
  | "initialized"
  | "awaiting_model"
  | "model_response_received"
  | "tool_proposed"
  | "awaiting_approval"
  | "tool_ready"
  | "tool_running"
  | "tool_result_persisted"
  | "awaiting_model_continuation"
  | "paused"
  | "completed"
  | "failed"
  | "requires_reconciliation"
  | "cancelled";

export type WorkspaceEvent = {
  id: string;
  version: 1;
  runId: string;
  conversationId: string;
  sequence: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

export type ConversationRecord = {
  id: string;
  owner: string;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  pinned: boolean;
  metadata: Record<string, unknown>;
};

export type RunRecord = {
  id: string;
  owner: string;
  conversationId: string;
  provider: string;
  model: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  usage?: Record<string, number>;
  lease?: { owner: string; acquiredAt: string; expiresAt: string };
};

export type ExecutionCheckpoint = {
  id: string;
  runId: string;
  conversationId: string;
  owner: string;
  sequence: number;
  phase: ExecutionPhase;
  agentConfig: Record<string, unknown>;
  providerId: string;
  modelId: string;
  modelParameters: Record<string, unknown>;
  messages: Message[];
  pendingToolCalls: ToolCall[];
  completedToolExecutionIds: string[];
  toolResults: Record<string, string>;
  approvalIds: string[];
  context: Record<string, unknown>;
  version: 1;
  createdAt: string;
  updatedAt: string;
  integrityHash: string;
};

export type ToolExecutionRecord = {
  id: string;
  runId: string;
  toolName: string;
  argumentsHash: string;
  status: "started" | "completed" | "failed" | "ambiguous";
  createdAt: string;
  updatedAt: string;
  output?: string;
  error?: string;
};

export type ProjectRecord = {
  id: string;
  owner: string;
  name: string;
  description: string;
  instructions: string;
  preferredModel?: string;
  preferredAgent?: string;
  memoryEnabled: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  config: Record<string, unknown>;
};

export type FileRecord = {
  id: string;
  owner: string;
  projectId?: string;
  conversationId?: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  uploadedAt: string;
  extractionStatus: "uploaded" | "queued" | "processing" | "completed" | "failed";
  extractionError?: string;
  extractedText?: string;
  metadata: Record<string, unknown>;
};

export type KnowledgeChunkRecord = {
  id: string;
  owner: string;
  projectId?: string;
  fileId: string;
  chunkIndex: number;
  content: string;
  page?: number;
  section?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AgentRecord = {
  id: string;
  owner: string;
  name: string;
  description: string;
  avatar?: string;
  instructions: string;
  provider: "deepseek" | "mock";
  model: string;
  parameters: Record<string, unknown>;
  skillNames: string[];
  allowedTools: string[];
  projectIds: string[];
  memoryEnabled: boolean;
  welcomeMessage: string;
  examplePrompts: string[];
  enabled: boolean;
  version: number;
  versions: Array<{ version: number; savedAt: string; config: Record<string, unknown> }>;
  createdAt: string;
  updatedAt: string;
};

export type IntegrationRecord = {
  id: string;
  owner: string;
  kind: "plugin" | "mcp" | "connector";
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  status: "available" | "connected" | "error" | "disabled" | "not_configured" | "not_connected" | "awaiting_authorization" | "token_expired" | "reauthorization_required" | "disconnected";
  config: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type CredentialRecord = {
  id: string;
  owner: string;
  integrationId: string;
  connectorId: string;
  encrypted: { ciphertext: string; iv: string; tag: string; keyVersion: number };
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type OAuthTransactionRecord = {
  id: string;
  owner: string;
  connectorId: string;
  redirectUri: string;
  codeVerifier: string;
  state: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
};

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled" | "executing" | "completed" | "failed" | "requires_reapproval";
export type ApprovalRecord = {
  id: string;
  owner: string;
  workspaceId: string;
  conversationId: string;
  runId: string;
  toolExecutionId: string;
  toolId: string;
  arguments: unknown;
  operationSnapshot: Record<string, unknown>;
  operationHash: string;
  schemaFingerprint?: string;
  permissionClass: string;
  policyResult: string;
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  decisionActor?: string;
  decisionAt?: string;
  executionStatus?: string;
  result?: string;
  error?: string;
};

export interface PersistenceAdapter {
  load(): Promise<void>;
  conversation(input?: Partial<ConversationRecord>): Promise<ConversationRecord>;
  listConversations(owner?: string): Promise<ConversationRecord[]>;
  appendMessage(message: Record<string, unknown>): Promise<void>;
  createRun(input: Pick<RunRecord, "conversationId" | "provider" | "model"> & Partial<Pick<RunRecord, "owner">>): Promise<RunRecord>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined>;
  getRun(id: string): Promise<RunRecord | undefined>;
  acquireRunLease(id: string, owner: string, ttlMs?: number): Promise<RunRecord | undefined>;
  releaseRunLease(id: string, owner: string): Promise<RunRecord | undefined>;
  appendEvent(runId: string, conversationId: string, type: string, payload: Record<string, unknown>): Promise<WorkspaceEvent>;
  events(runId: string, after?: number): Promise<WorkspaceEvent[]>;
  runs(owner?: string): Promise<RunRecord[]>;
  recoverInterruptedRuns(): Promise<RunRecord[]>;
  beginToolExecution(input: Omit<ToolExecutionRecord, "createdAt" | "updatedAt" | "status">): Promise<ToolExecutionRecord>;
  getToolExecution(id: string): Promise<ToolExecutionRecord | undefined>;
  finishToolExecution(id: string, patch: Pick<ToolExecutionRecord, "status"> & Partial<Pick<ToolExecutionRecord, "output" | "error">>): Promise<ToolExecutionRecord | undefined>;
  createProject(input: Pick<ProjectRecord, "owner" | "name"> & Partial<ProjectRecord>): Promise<ProjectRecord>;
  listProjects(owner: string, includeArchived?: boolean): Promise<ProjectRecord[]>;
  getProject(id: string, owner: string): Promise<ProjectRecord | undefined>;
  updateProject(id: string, owner: string, patch: Partial<ProjectRecord>): Promise<ProjectRecord | undefined>;
  deleteProject(id: string, owner: string): Promise<boolean>;
  attachConversationToProject(conversationId: string, projectId: string | undefined, owner: string): Promise<ConversationRecord | undefined>;
  createFile(input: Omit<FileRecord, "uploadedAt"> & Partial<Pick<FileRecord, "uploadedAt">>): Promise<FileRecord>;
  listFiles(owner: string, projectId?: string, conversationId?: string): Promise<FileRecord[]>;
  getFile(id: string, owner: string): Promise<FileRecord | undefined>;
  updateFile(id: string, owner: string, patch: Partial<FileRecord>): Promise<FileRecord | undefined>;
  deleteFile(id: string, owner: string): Promise<boolean>;
  replaceKnowledgeChunks(fileId: string, owner: string, chunks: Omit<KnowledgeChunkRecord, "createdAt">[]): Promise<KnowledgeChunkRecord[]>;
  searchKnowledge(owner: string, query: string, projectId?: string, limit?: number): Promise<KnowledgeChunkRecord[]>;
  createAgent(input: Pick<AgentRecord, "owner" | "name"> & Partial<AgentRecord>): Promise<AgentRecord>;
  listAgents(owner: string, includeDisabled?: boolean): Promise<AgentRecord[]>;
  getAgent(id: string, owner: string): Promise<AgentRecord | undefined>;
  updateAgent(id: string, owner: string, patch: Partial<AgentRecord>): Promise<AgentRecord | undefined>;
  deleteAgent(id: string, owner: string): Promise<boolean>;
  createIntegration(input: Pick<IntegrationRecord, "owner" | "kind" | "name"> & Partial<IntegrationRecord>): Promise<IntegrationRecord>;
  listIntegrations(owner: string): Promise<IntegrationRecord[]>;
  updateIntegration(id: string, owner: string, patch: Partial<IntegrationRecord>): Promise<IntegrationRecord | undefined>;
  deleteIntegration(id: string, owner: string): Promise<boolean>;
  createCredential(input: Omit<CredentialRecord, "createdAt" | "updatedAt">): Promise<CredentialRecord>;
  getCredential(integrationId: string, owner: string): Promise<CredentialRecord | undefined>;
  revokeCredential(integrationId: string, owner: string): Promise<CredentialRecord | undefined>;
  createOAuthTransaction(input: Omit<OAuthTransactionRecord, "createdAt">): Promise<OAuthTransactionRecord>;
  consumeOAuthTransaction(state: string, owner: string): Promise<OAuthTransactionRecord | undefined>;
  createApproval(input: Omit<ApprovalRecord, "createdAt" | "status"> & Partial<Pick<ApprovalRecord, "createdAt" | "status">>): Promise<ApprovalRecord>;
  listApprovals(owner: string, statuses?: ApprovalStatus[]): Promise<ApprovalRecord[]>;
  getApproval(id: string, owner: string): Promise<ApprovalRecord | undefined>;
  decideApproval(id: string, owner: string, decision: "approved" | "denied", actor: string): Promise<ApprovalRecord | undefined>;
  updateApproval(id: string, owner: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | undefined>;
  createCheckpoint(input: Omit<ExecutionCheckpoint, "id" | "sequence" | "createdAt" | "updatedAt" | "integrityHash" | "version">): Promise<ExecutionCheckpoint>;
  latestCheckpoint(runId: string, owner: string): Promise<ExecutionCheckpoint | undefined>;
  checkpointHistory(runId: string, owner: string): Promise<ExecutionCheckpoint[]>;
  getCheckpoint(id: string, owner: string): Promise<ExecutionCheckpoint | undefined>;
};

type StoreData = {
  conversations: ConversationRecord[];
  messages: Array<Record<string, unknown>>;
  runs: RunRecord[];
  events: WorkspaceEvent[];
  toolExecutions: ToolExecutionRecord[];
  projects: ProjectRecord[];
  memories: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  files: FileRecord[];
  knowledgeChunks: KnowledgeChunkRecord[];
  agents: AgentRecord[];
  approvals: ApprovalRecord[];
  integrations: IntegrationRecord[];
  credentials: CredentialRecord[];
  oauthTransactions: OAuthTransactionRecord[];
  checkpoints: ExecutionCheckpoint[];
};

const emptyData = (): StoreData => ({
  conversations: [], messages: [], runs: [], events: [], toolExecutions: [],
  approvals: [], projects: [], memories: [], artifacts: [], files: [], knowledgeChunks: [], agents: [], integrations: [], checkpoints: [], credentials: [], oauthTransactions: [],
});

const locks = new Map<string, Promise<void>>();

export class WorkspaceStore implements PersistenceAdapter {
  private data: StoreData = emptyData();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = join(process.cwd(), ".deepseek-ui", "workspace.json")) {}

  private async readDisk(): Promise<void> {
    try {
      this.data = { ...emptyData(), ...JSON.parse(await readFile(this.filePath, "utf8")) } as StoreData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = emptyData();
    }
    this.loaded = true;
  }

  async load(): Promise<void> {
    if (!this.loaded) await this.readDisk();
  }

  private async save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.data, null, 2), "utf8");
      await rename(temporary, this.filePath);
    });
    await this.writeQueue;
  }

  private async mutate<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = locks.get(this.filePath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const lockToken = previous.then(() => current);
    locks.set(this.filePath, lockToken);
    await previous;
    try {
      await this.readDisk();
      const result = await fn();
      await this.save();
      return result;
    } finally {
      release();
      if (locks.get(this.filePath) === lockToken) locks.delete(this.filePath);
    }
  }

  private checkpointIntegrityPayload(checkpoint: Omit<ExecutionCheckpoint, "integrityHash">): string {
      return JSON.stringify({
        id: checkpoint.id,
        runId: checkpoint.runId,
        conversationId: checkpoint.conversationId,
        owner: checkpoint.owner,
        sequence: checkpoint.sequence,
        phase: checkpoint.phase,
        agentConfig: checkpoint.agentConfig,
        providerId: checkpoint.providerId,
        modelId: checkpoint.modelId,
        modelParameters: checkpoint.modelParameters,
        messages: checkpoint.messages,
        pendingToolCalls: checkpoint.pendingToolCalls,
        completedToolExecutionIds: checkpoint.completedToolExecutionIds,
        toolResults: checkpoint.toolResults,
        approvalIds: checkpoint.approvalIds,
        context: checkpoint.context,
        version: checkpoint.version,
        createdAt: checkpoint.createdAt,
        updatedAt: checkpoint.updatedAt,
      });
  }

  async conversation(input: Partial<ConversationRecord> = {}): Promise<ConversationRecord> {
    return this.mutate(async () => {
      const now = new Date().toISOString();
      const record: ConversationRecord = {
        id: input.id ?? randomUUID(), owner: input.owner ?? "local", title: input.title ?? "New conversation",
        provider: input.provider ?? "deepseek", model: input.model ?? "deepseek-flash",
        createdAt: input.createdAt ?? now, updatedAt: now,
        archived: input.archived ?? false, pinned: input.pinned ?? false, metadata: input.metadata ?? {},
      };
      const existing = this.data.conversations.findIndex((item) => item.id === record.id);
      if (existing >= 0) this.data.conversations[existing] = { ...this.data.conversations[existing], ...record, updatedAt: now };
      else this.data.conversations.push(record);
      return this.data.conversations.find((item) => item.id === record.id)!;
    });
  }

  async listConversations(owner?: string): Promise<ConversationRecord[]> {
    await this.load();
    return [...this.data.conversations]
      .filter((conversation) => owner === undefined || conversation.owner === owner)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async appendMessage(message: Record<string, unknown>): Promise<void> {
    await this.mutate(() => {
      const id = typeof message.id === "string" ? message.id : randomUUID();
      if (!this.data.messages.some((item) => item.id === id)) {
        this.data.messages.push({ id, createdAt: new Date().toISOString(), ...message });
      }
    });
  }

  async createRun(input: Pick<RunRecord, "conversationId" | "provider" | "model"> & Partial<Pick<RunRecord, "owner">>): Promise<RunRecord> {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const run: RunRecord = { id: randomUUID(), owner: input.owner ?? "local", ...input, status: "queued", createdAt: now, updatedAt: now };
      this.data.runs.push(run);
      return run;
    });
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
    return this.mutate(() => {
      const item = this.data.runs.find((run) => run.id === id);
      if (!item) return undefined;
      Object.assign(item, patch, { updatedAt: new Date().toISOString() });
      if (["completed", "failed", "cancelled", "expired"].includes(item.status)) item.completedAt ??= new Date().toISOString();
      return item;
    });
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    await this.load();
    return this.data.runs.find((run) => run.id === id);
  }

  async acquireRunLease(id: string, owner: string, ttlMs = 30_000): Promise<RunRecord | undefined> {
    return this.mutate(() => {
      const run = this.data.runs.find((item) => item.id === id);
      if (!run) return undefined;
      const now = Date.now();
      if (run.lease && run.lease.owner !== owner && Date.parse(run.lease.expiresAt) > now) return undefined;
      const acquiredAt = new Date(now).toISOString();
      run.lease = { owner, acquiredAt, expiresAt: new Date(now + ttlMs).toISOString() };
      run.updatedAt = acquiredAt;
      return run;
    });
  }

  async releaseRunLease(id: string, owner: string): Promise<RunRecord | undefined> {
    return this.mutate(() => {
      const run = this.data.runs.find((item) => item.id === id);
      if (!run || run.lease?.owner !== owner) return run;
      delete run.lease;
      run.updatedAt = new Date().toISOString();
      return run;
    });
  }

  async appendEvent(runId: string, conversationId: string, type: string, payload: Record<string, unknown>): Promise<WorkspaceEvent> {
    return this.mutate(() => {
      const sequence = this.data.events.filter((event) => event.runId === runId).length;
      const event: WorkspaceEvent = {
        id: randomUUID(), version: 1, runId, conversationId, sequence, type,
        timestamp: new Date().toISOString(), payload,
      };
      this.data.events.push(event);
      return event;
    });
  }

  async events(runId: string, after = -1): Promise<WorkspaceEvent[]> {
    await this.load();
    return this.data.events.filter((event) => event.runId === runId && event.sequence > after).sort((a, b) => a.sequence - b.sequence);
  }

  async runs(owner?: string): Promise<RunRecord[]> {
    await this.load();
    return [...this.data.runs].filter((run) => !owner || run.owner === owner).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recoverInterruptedRuns(): Promise<RunRecord[]> {
    return this.mutate(() => {
      const recovered: RunRecord[] = [];
      for (const run of this.data.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "paused";
          run.error = "Gateway restarted while this run was active; it was paused without replaying side effects.";
          run.updatedAt = new Date().toISOString();
          recovered.push(run);
        }
      }
      return recovered;
    });
  }

  async beginToolExecution(input: Omit<ToolExecutionRecord, "createdAt" | "updatedAt" | "status">): Promise<ToolExecutionRecord> {
    return this.mutate(() => {
      const existing = this.data.toolExecutions.find((item) => item.id === input.id);
      if (existing) return existing;
      const now = new Date().toISOString();
      const record: ToolExecutionRecord = { ...input, status: "started", createdAt: now, updatedAt: now };
      this.data.toolExecutions.push(record);
      return record;
    });
  }

  async getToolExecution(id: string): Promise<ToolExecutionRecord | undefined> {
    await this.load();
    return this.data.toolExecutions.find((item) => item.id === id);
  }

  async finishToolExecution(id: string, patch: Pick<ToolExecutionRecord, "status"> & Partial<Pick<ToolExecutionRecord, "output" | "error">>): Promise<ToolExecutionRecord | undefined> {
    return this.mutate(() => {
      const item = this.data.toolExecutions.find((execution) => execution.id === id);
      if (!item) return undefined;
      Object.assign(item, patch, { updatedAt: new Date().toISOString() });
      return item;
    });
  }

  async createProject(input: Pick<ProjectRecord, "owner" | "name"> & Partial<ProjectRecord>): Promise<ProjectRecord> {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: input.id ?? randomUUID(),
        owner: input.owner,
        name: input.name,
        description: input.description ?? "",
        instructions: input.instructions ?? "",
        preferredModel: input.preferredModel,
        preferredAgent: input.preferredAgent,
        memoryEnabled: input.memoryEnabled ?? true,
        archived: input.archived ?? false,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
        config: input.config ?? {},
      };
      this.data.projects.push(project);
      return project;
    });
  }

  async listProjects(owner: string, includeArchived = false): Promise<ProjectRecord[]> {
    await this.load();
    return this.data.projects
      .filter((project) => project.owner === owner && (includeArchived || !project.archived))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProject(id: string, owner: string): Promise<ProjectRecord | undefined> {
    await this.load();
    return this.data.projects.find((project) => project.id === id && project.owner === owner);
  }

  async updateProject(id: string, owner: string, patch: Partial<ProjectRecord>): Promise<ProjectRecord | undefined> {
    return this.mutate(() => {
      const project = this.data.projects.find((item) => item.id === id && item.owner === owner);
      if (!project) return undefined;
      Object.assign(project, patch, { id: project.id, owner: project.owner, updatedAt: new Date().toISOString() });
      return project;
    });
  }

  async deleteProject(id: string, owner: string): Promise<boolean> {
    return this.mutate(() => {
      const index = this.data.projects.findIndex((project) => project.id === id && project.owner === owner);
      if (index < 0) return false;
      this.data.projects.splice(index, 1);
      for (const conversation of this.data.conversations) {
        if (conversation.owner === owner && conversation.metadata.projectId === id) {
          delete conversation.metadata.projectId;
        }
      }
      return true;
    });
  }

  async attachConversationToProject(conversationId: string, projectId: string | undefined, owner: string): Promise<ConversationRecord | undefined> {
    return this.mutate(() => {
      const conversation = this.data.conversations.find((item) => item.id === conversationId && item.owner === owner);
      if (!conversation) return undefined;
      if (projectId && !this.data.projects.some((project) => project.id === projectId && project.owner === owner)) return undefined;
      conversation.metadata = { ...conversation.metadata, ...(projectId ? { projectId } : {}) };
      if (!projectId) delete conversation.metadata.projectId;
      conversation.updatedAt = new Date().toISOString();
      return conversation;
    });
  }

  async createFile(input: Omit<FileRecord, "uploadedAt"> & Partial<Pick<FileRecord, "uploadedAt">>): Promise<FileRecord> {
    return this.mutate(() => {
      const file: FileRecord = { ...input, uploadedAt: input.uploadedAt ?? new Date().toISOString() };
      this.data.files.push(file);
      return file;
    });
  }

  async listFiles(owner: string, projectId?: string, conversationId?: string): Promise<FileRecord[]> {
    await this.load();
    return this.data.files.filter((file) =>
      file.owner === owner &&
      (projectId === undefined || file.projectId === projectId) &&
      (conversationId === undefined || file.conversationId === conversationId),
    );
  }

  async getFile(id: string, owner: string): Promise<FileRecord | undefined> {
    await this.load();
    return this.data.files.find((file) => file.id === id && file.owner === owner);
  }

  async updateFile(id: string, owner: string, patch: Partial<FileRecord>): Promise<FileRecord | undefined> {
    return this.mutate(() => {
      const file = this.data.files.find((item) => item.id === id && item.owner === owner);
      if (!file) return undefined;
      Object.assign(file, patch, { id: file.id, owner: file.owner });
      return file;
    });
  }

  async deleteFile(id: string, owner: string): Promise<boolean> {
    return this.mutate(() => {
      const index = this.data.files.findIndex((file) => file.id === id && file.owner === owner);
      if (index < 0) return false;
      this.data.files.splice(index, 1);
      this.data.knowledgeChunks = this.data.knowledgeChunks.filter((chunk) => chunk.fileId !== id || chunk.owner !== owner);
      return true;
    });
  }

  async replaceKnowledgeChunks(fileId: string, owner: string, chunks: Omit<KnowledgeChunkRecord, "createdAt">[]): Promise<KnowledgeChunkRecord[]> {
    return this.mutate(() => {
      this.data.knowledgeChunks = this.data.knowledgeChunks.filter((chunk) => !(chunk.fileId === fileId && chunk.owner === owner));
      const created = chunks.map((chunk) => ({ ...chunk, createdAt: new Date().toISOString() }));
      this.data.knowledgeChunks.push(...created);
      return created;
    });
  }

  async searchKnowledge(owner: string, query: string, projectId?: string, limit = 8): Promise<KnowledgeChunkRecord[]> {
    await this.load();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.data.knowledgeChunks
      .filter((chunk) => chunk.owner === owner && (projectId === undefined || chunk.projectId === projectId))
      .map((chunk) => ({
        chunk,
        score: terms.reduce((score, term) => score + (chunk.content.toLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.chunkIndex - b.chunk.chunkIndex)
      .slice(0, limit)
      .map((item) => item.chunk);
  }

  async createAgent(input: Pick<AgentRecord, "owner" | "name"> & Partial<AgentRecord>): Promise<AgentRecord> {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const agent: AgentRecord = {
        id: input.id ?? randomUUID(),
        owner: input.owner,
        name: input.name.trim(),
        description: input.description ?? "",
        avatar: input.avatar,
        instructions: input.instructions ?? "",
        provider: input.provider ?? "mock",
        model: input.model ?? "mock",
        parameters: input.parameters ?? {},
        skillNames: [...(input.skillNames ?? [])],
        allowedTools: [...(input.allowedTools ?? [])],
        projectIds: [...(input.projectIds ?? [])],
        memoryEnabled: input.memoryEnabled ?? true,
        welcomeMessage: input.welcomeMessage ?? "",
        examplePrompts: [...(input.examplePrompts ?? [])],
        enabled: input.enabled ?? true,
        version: input.version ?? 1,
        versions: input.versions ?? [],
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      };
      this.data.agents.push(agent);
      return agent;
    });
  }

  async listAgents(owner: string, includeDisabled = false): Promise<AgentRecord[]> {
    await this.load();
    return this.data.agents
      .filter((agent) => agent.owner === owner && (includeDisabled || agent.enabled))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getAgent(id: string, owner: string): Promise<AgentRecord | undefined> {
    await this.load();
    return this.data.agents.find((agent) => agent.id === id && agent.owner === owner);
  }

  async updateAgent(id: string, owner: string, patch: Partial<AgentRecord>): Promise<AgentRecord | undefined> {
    return this.mutate(() => {
      const agent = this.data.agents.find((item) => item.id === id && item.owner === owner);
      if (!agent) return undefined;
      const previous = { ...agent };
      const nextVersion = agent.version + 1;
      const snapshot = Object.fromEntries(Object.entries(previous).filter(([key]) =>
        !["versions", "updatedAt"].includes(key),
      ));
      Object.assign(agent, patch, { id: agent.id, owner: agent.owner, version: nextVersion, updatedAt: new Date().toISOString() });
      agent.versions = [...agent.versions, { version: agent.version, savedAt: previous.updatedAt, config: snapshot }];
      return agent;
    });
  }

  async deleteAgent(id: string, owner: string): Promise<boolean> {
    return this.mutate(() => {
      const index = this.data.agents.findIndex((agent) => agent.id === id && agent.owner === owner);
      if (index < 0) return false;
      this.data.agents.splice(index, 1);
      return true;
    });
  }

  async createIntegration(input: Pick<IntegrationRecord, "owner" | "kind" | "name"> & Partial<IntegrationRecord>): Promise<IntegrationRecord> {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const integration: IntegrationRecord = {
        id: input.id ?? randomUUID(),
        owner: input.owner,
        kind: input.kind,
        name: input.name.trim(),
        description: input.description ?? "",
        version: input.version ?? "1.0.0",
        enabled: input.enabled ?? false,
        status: input.status ?? "available",
        config: input.config ?? {},
        error: input.error,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      };
      this.data.integrations.push(integration);
      return integration;
    });
  }

  async listIntegrations(owner: string): Promise<IntegrationRecord[]> {
    await this.load();
    return this.data.integrations.filter((item) => item.owner === owner).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async updateIntegration(id: string, owner: string, patch: Partial<IntegrationRecord>): Promise<IntegrationRecord | undefined> {
    return this.mutate(() => {
      const integration = this.data.integrations.find((item) => item.id === id && item.owner === owner);
      if (!integration) return undefined;
      Object.assign(integration, patch, { id: integration.id, owner: integration.owner, updatedAt: new Date().toISOString() });
      return integration;
    });
  }

  async deleteIntegration(id: string, owner: string): Promise<boolean> {
    return this.mutate(() => {
      const index = this.data.integrations.findIndex((item) => item.id === id && item.owner === owner);
      if (index < 0) return false;
      this.data.integrations.splice(index, 1);
      return true;
    });
  }

  async createCredential(input: Omit<CredentialRecord, "createdAt" | "updatedAt">): Promise<CredentialRecord> {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const record = { ...input, createdAt: now, updatedAt: now };
      this.data.credentials = this.data.credentials.filter((item) => !(item.integrationId === input.integrationId && item.owner === input.owner));
      this.data.credentials.push(record);
      return record;
    });
  }

  async getCredential(integrationId: string, owner: string): Promise<CredentialRecord | undefined> {
    await this.load();
    return this.data.credentials.find((item) => item.integrationId === integrationId && item.owner === owner && !item.revokedAt);
  }

  async revokeCredential(integrationId: string, owner: string): Promise<CredentialRecord | undefined> {
    return this.mutate(() => {
      const credential = this.data.credentials.find((item) => item.integrationId === integrationId && item.owner === owner);
      if (!credential) return undefined;
      credential.revokedAt = new Date().toISOString();
      credential.updatedAt = credential.revokedAt;
      return credential;
    });
  }

  async createOAuthTransaction(input: Omit<OAuthTransactionRecord, "createdAt">): Promise<OAuthTransactionRecord> {
    return this.mutate(() => {
      const record = { ...input, createdAt: new Date().toISOString() };
      this.data.oauthTransactions.push(record);
      return record;
    });
  }

  async consumeOAuthTransaction(state: string, owner: string): Promise<OAuthTransactionRecord | undefined> {
    return this.mutate(() => {
      const transaction = this.data.oauthTransactions.find((item) => item.state === state && item.owner === owner);
      if (!transaction || transaction.consumedAt || Date.parse(transaction.expiresAt) <= Date.now()) return undefined;
      transaction.consumedAt = new Date().toISOString();
      return transaction;
    });
  }

  async createApproval(input: Omit<ApprovalRecord, "createdAt" | "status"> & Partial<Pick<ApprovalRecord, "createdAt" | "status">>): Promise<ApprovalRecord> {
    return this.mutate(() => {
      const approval: ApprovalRecord = {
        ...input,
        createdAt: input.createdAt ?? new Date().toISOString(),
        status: input.status ?? "pending",
      };
      this.data.approvals.push(approval);
      return approval;
    });
  }

  async listApprovals(owner: string, statuses?: ApprovalStatus[]): Promise<ApprovalRecord[]> {
    await this.load();
    return this.data.approvals
      .filter((approval) => approval.owner === owner && (!statuses || statuses.includes(approval.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getApproval(id: string, owner: string): Promise<ApprovalRecord | undefined> {
    await this.load();
    return this.data.approvals.find((approval) => approval.id === id && approval.owner === owner);
  }

  async decideApproval(id: string, owner: string, decision: "approved" | "denied", actor: string): Promise<ApprovalRecord | undefined> {
    return this.mutate(() => {
      const approval = this.data.approvals.find((item) => item.id === id && item.owner === owner);
      if (!approval) return undefined;
      if (approval.status !== "pending") return approval;
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        approval.status = "expired";
        approval.decisionAt = new Date().toISOString();
        return approval;
      }
      approval.status = decision;
      approval.decisionActor = actor;
      approval.decisionAt = new Date().toISOString();
      return approval;
    });
  }

  async updateApproval(id: string, owner: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | undefined> {
    return this.mutate(() => {
      const approval = this.data.approvals.find((item) => item.id === id && item.owner === owner);
      if (!approval) return undefined;
      const { id: _id, owner: _owner, workspaceId: _workspaceId, conversationId: _conversationId, runId: _runId,
        toolExecutionId: _toolExecutionId, toolId: _toolId, arguments: _arguments, operationSnapshot: _operationSnapshot,
        operationHash: _operationHash, schemaFingerprint: _schemaFingerprint, permissionClass: _permissionClass,
        policyResult: _policyResult, createdAt: _createdAt, expiresAt: _expiresAt, ...mutable } = patch;
      Object.assign(approval, mutable, { id: approval.id, owner: approval.owner });
      return approval;
    });
  }

  async createCheckpoint(input: Omit<ExecutionCheckpoint, "id" | "sequence" | "createdAt" | "updatedAt" | "integrityHash" | "version">): Promise<ExecutionCheckpoint> {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const sequence = this.data.checkpoints.filter((checkpoint) => checkpoint.runId === input.runId).length;
      const base = { ...input, id: randomUUID(), sequence, createdAt: now, updatedAt: now, version: 1 as const };
      const integrityHash = createHash("sha256").update(this.checkpointIntegrityPayload(base)).digest("hex");
      const checkpoint: ExecutionCheckpoint = { ...base, integrityHash };
      this.data.checkpoints.push(checkpoint);
      return checkpoint;
    });
  }

  async latestCheckpoint(runId: string, owner: string): Promise<ExecutionCheckpoint | undefined> {
    await this.load();
    return [...this.data.checkpoints]
      .filter((checkpoint) => checkpoint.runId === runId && checkpoint.owner === owner)
      .sort((a, b) => b.sequence - a.sequence)
      .find((checkpoint) => createHash("sha256").update(this.checkpointIntegrityPayload(checkpoint)).digest("hex") === checkpoint.integrityHash);
  }

  async checkpointHistory(runId: string, owner: string): Promise<ExecutionCheckpoint[]> {
    await this.load();
    return this.data.checkpoints
      .filter((checkpoint) => checkpoint.runId === runId && checkpoint.owner === owner)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async getCheckpoint(id: string, owner: string): Promise<ExecutionCheckpoint | undefined> {
    await this.load();
    return this.data.checkpoints.find((checkpoint) => checkpoint.id === id && checkpoint.owner === owner);
  }
}
