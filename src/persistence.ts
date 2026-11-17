import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type RunStatus = "queued" | "running" | "awaiting_approval" | "paused" | "completed" | "failed" | "cancelled" | "expired";

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

export interface PersistenceAdapter {
  load(): Promise<void>;
  conversation(input?: Partial<ConversationRecord>): Promise<ConversationRecord>;
  listConversations(owner?: string): Promise<ConversationRecord[]>;
  appendMessage(message: Record<string, unknown>): Promise<void>;
  createRun(input: Pick<RunRecord, "conversationId" | "provider" | "model"> & Partial<Pick<RunRecord, "owner">>): Promise<RunRecord>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined>;
  getRun(id: string): Promise<RunRecord | undefined>;
  appendEvent(runId: string, conversationId: string, type: string, payload: Record<string, unknown>): Promise<WorkspaceEvent>;
  events(runId: string, after?: number): Promise<WorkspaceEvent[]>;
  runs(owner?: string): Promise<RunRecord[]>;
  recoverInterruptedRuns(): Promise<RunRecord[]>;
  beginToolExecution(input: Omit<ToolExecutionRecord, "createdAt" | "updatedAt" | "status">): Promise<ToolExecutionRecord>;
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
}

type StoreData = {
  conversations: ConversationRecord[];
  messages: Array<Record<string, unknown>>;
  runs: RunRecord[];
  events: WorkspaceEvent[];
  toolExecutions: ToolExecutionRecord[];
  approvals: Array<Record<string, unknown>>;
  projects: ProjectRecord[];
  memories: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  files: FileRecord[];
  knowledgeChunks: KnowledgeChunkRecord[];
  agents: AgentRecord[];
};

const emptyData = (): StoreData => ({
  conversations: [], messages: [], runs: [], events: [], toolExecutions: [],
  approvals: [], projects: [], memories: [], artifacts: [], files: [], knowledgeChunks: [], agents: [],
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
}
