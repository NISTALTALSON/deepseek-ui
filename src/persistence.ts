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
}

type StoreData = {
  conversations: ConversationRecord[];
  messages: Array<Record<string, unknown>>;
  runs: RunRecord[];
  events: WorkspaceEvent[];
  toolExecutions: ToolExecutionRecord[];
  approvals: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  memories: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
};

const emptyData = (): StoreData => ({
  conversations: [], messages: [], runs: [], events: [], toolExecutions: [],
  approvals: [], projects: [], memories: [], artifacts: [],
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
}
