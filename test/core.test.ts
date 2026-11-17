import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareMessages } from "../src/deepseek.js";
import { Permissions } from "../src/permissions.js";
import { SkillRegistry, parseFrontmatter } from "../src/skills.js";
import { createGateway, getRequestApiKey, toAgentMessages } from "../src/gateway.js";
import { compactMessages } from "../src/agent.js";
import { MockProvider } from "../src/provider.js";
import { WorkspaceStore } from "../src/persistence.js";
import { chunkDocument, extractDocument, FileStorage, validateUpload } from "../src/knowledge.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../src/types.js";

const history: Message[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: null, reasoning_content: "thinking...", tool_calls: [] },
];

test("mock provider works without external credentials", async () => {
  const provider = new MockProvider();
  const events = [];
  for await (const event of provider.stream([{ role: "user", content: "offline setup" }])) {
    events.push(event);
  }
  assert.equal(events[0]?.type, "text");
  assert.match(events[0]?.type === "text" ? events[0].delta : "", /offline setup/);
  assert.equal(events.at(-1)?.type, "done");
});

test("workspace store persists runs and replayable events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-"));
  const file = join(directory, "workspace.json");
  try {
    const first = new WorkspaceStore(file);
    const conversation = await first.conversation({ title: "Persistent chat", provider: "mock", model: "mock" });
    const run = await first.createRun({ conversationId: conversation.id, provider: "mock", model: "mock" });
    await first.updateRun(run.id, { status: "running" });
    await first.appendEvent(run.id, conversation.id, "run.started", { provider: "mock" });
    const second = new WorkspaceStore(file);
    assert.equal((await second.listConversations())[0]?.title, "Persistent chat");
    assert.equal((await second.getRun(run.id))?.status, "running");
    assert.equal((await second.events(run.id, -1))[0]?.sequence, 0);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("durable approvals use compare-and-set decisions and expire safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-approval-"));
  const store = new WorkspaceStore(join(directory, "workspace.json"));
  try {
    await store.load();
    const approval = await store.createApproval({
      id: "approval-1",
      owner: "alice",
      workspaceId: "alice",
      conversationId: "conversation-1",
      runId: "run-1",
      toolExecutionId: "run-1:tool-1",
      toolId: "payments__charge",
      arguments: { amount: 10 },
      operationSnapshot: { name: "payments__charge", args: { amount: 10 } },
      operationHash: "hash",
      permissionClass: "destructive",
      policyResult: "approval_required",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const [approved, denied] = await Promise.all([
      store.decideApproval(approval.id, "alice", "approved", "alice"),
      store.decideApproval(approval.id, "alice", "denied", "alice"),
    ]);
    const finalApproval = await store.getApproval(approval.id, "alice");
    assert.ok(finalApproval?.status === "approved" || finalApproval?.status === "denied");
    assert.equal(approved?.decisionAt, denied?.decisionAt);
    assert.equal((await store.getApproval(approval.id, "bob")), undefined);
    const expired = await store.createApproval({
      ...approval,
      id: "approval-expired",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    test("execution checkpoints are versioned, ordered, integrity-checked, and leased", async () => {
      const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-checkpoint-"));
      const store = new WorkspaceStore(join(directory, "workspace.json"));
      try {
        await store.load();
        const run = await store.createRun({ owner: "alice", conversationId: "conversation-1", provider: "mock", model: "mock" });
        const lease = await store.acquireRunLease(run.id, "worker-a");
        assert.equal(lease?.lease?.owner, "worker-a");
        assert.equal((await store.acquireRunLease(run.id, "worker-b")), undefined);
        const first = await store.createCheckpoint({
          runId: run.id,
          conversationId: run.conversationId,
          owner: "alice",
          phase: "awaiting_model",
          agentConfig: { agentId: "agent-1" },
          providerId: "mock",
          modelId: "mock",
          modelParameters: {},
          messages: [{ role: "user", content: "hello" }],
          pendingToolCalls: [],
          completedToolExecutionIds: [],
          toolResults: {},
          approvalIds: [],
          context: {},
        });
        const second = await store.createCheckpoint({
          ...first,
          phase: "model_response_received",
          messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "world" }],
        });
        assert.equal(second.sequence, first.sequence + 1);
        assert.equal((await store.latestCheckpoint(run.id, "alice"))?.id, second.id);
        assert.equal((await store.latestCheckpoint(run.id, "bob")), undefined);
        assert.equal((await store.releaseRunLease(run.id, "worker-a"))?.lease, undefined);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    const expiredDecision = await store.decideApproval(expired.id, "alice", "approved", "alice");
    assert.equal(expiredDecision?.status, "expired");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace store serializes concurrent writers and preserves event order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-concurrent-"));
  const file = join(directory, "workspace.json");
  try {
    const first = new WorkspaceStore(file);
    const second = new WorkspaceStore(file);
    const conversation = await first.conversation({ provider: "mock", model: "mock" });
    const run = await first.createRun({ conversationId: conversation.id, provider: "mock", model: "mock" });
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? first : second).appendEvent(run.id, conversation.id, `event.${index}`, { index }),
    ));
    const events = await new WorkspaceStore(file).events(run.id);
    assert.equal(events.length, 20);
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 20 }, (_, index) => index));
    assert.equal(new Set(events.map((event) => event.id)).size, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart recovery pauses active runs without replaying side effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-recovery-"));
  const file = join(directory, "workspace.json");
  try {
    const first = new WorkspaceStore(file);
    const conversation = await first.conversation({ provider: "mock", model: "mock" });
    const run = await first.createRun({ conversationId: conversation.id, provider: "mock", model: "mock" });
    await first.updateRun(run.id, { status: "running" });
    const second = new WorkspaceStore(file);
    const recovered = await second.recoverInterruptedRuns();
    assert.equal(recovered[0]?.status, "paused");
    assert.match(recovered[0]?.error ?? "", /Gateway restarted/);
    assert.equal((await second.getRun(run.id))?.status, "paused");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace run listing isolates owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-owner-"));
  const file = join(directory, "workspace.json");
  try {
    const store = new WorkspaceStore(file);
    const conversation = await store.conversation({ owner: "alice" });
    await store.createRun({ owner: "alice", conversationId: conversation.id, provider: "mock", model: "mock" });
    await store.createRun({ owner: "bob", conversationId: conversation.id, provider: "mock", model: "mock" });
    assert.equal((await store.runs("alice")).length, 1);
    assert.equal((await store.runs("bob")).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace conversation listing isolates owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-conversations-"));
  const store = new WorkspaceStore(join(directory, "workspace.json"));
  await store.conversation({ id: "owner-a", owner: "a", title: "A" });
  await store.conversation({ id: "owner-b", owner: "b", title: "B" });
  assert.deepEqual((await store.listConversations("a")).map((conversation) => conversation.id), ["owner-a"]);
});

test("agent persistence versions updates and isolates owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-agents-"));
  try {
    const store = new WorkspaceStore(join(directory, "workspace.json"));
    const agent = await store.createAgent({
      owner: "alice",
      name: "Researcher",
      provider: "mock",
      model: "mock",
      instructions: "Use concise evidence.",
      skillNames: ["research"],
      allowedTools: ["knowledge_search"],
    });

    test("managed skills install, inspect, update, and remove without executing package scripts", async () => {
      const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-managed-skills-"));
      try {
        const registry = new SkillRegistry();
        const source = "---\nname: local-skill\ndescription: Local test\nversion: 1.0.0\n---\nUse evidence.";
        const skill = await registry.install(directory, "local-skill", source);
        assert.equal(skill.version, "1.0.0");
        assert.match((await registry.source("local-skill")) ?? "", /Use evidence/);
        await registry.update("local-skill", source.replace("1.0.0", "1.1.0"));
        assert.equal(registry.list()[0]?.version, "1.1.0");
        assert.equal(await registry.remove("local-skill"), true);
        assert.equal(registry.has("local-skill"), false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("remote MCP rejects private endpoints before connecting", async () => {
      const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-mcp-ssrf-"));
      const gateway = await createGateway({
        provider: "mock",
        dataFile: join(directory, "workspace.json"),
        mcp: { servers: { private: { transport: "streamable-http", url: "https://127.0.0.1:8443/mcp" } } },
      });
      await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
      const address = gateway.server.address();
      const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      try {
        const body = await (await fetch(`${base}/capabilities`)).json() as { mcpDetails?: Array<{ id: string; status: string; error?: string }> };
        assert.equal(body.mcpDetails?.find((item) => item.id === "private")?.status, "error");
        assert.match(body.mcpDetails?.find((item) => item.id === "private")?.error ?? "", /private|local/i);
      } finally {
        await gateway.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
    const updated = await store.updateAgent(agent.id, "alice", { description: "Updated" });
    assert.equal(updated?.version, 2);
    assert.equal(updated?.versions.length, 1);
    assert.equal((await store.listAgents("bob")).length, 0);
    assert.equal((await store.getAgent(agent.id, "bob")), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("gateway creates owner-scoped agents and executes selected agent configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-gateway-agents-"));
  const gateway = await createGateway({ provider: "mock", dataFile: join(directory, "workspace.json") });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const created = await fetch(`${base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-deepseek-ui-workspace": "alice" },
      body: JSON.stringify({ name: "Offline helper", provider: "mock", model: "mock", instructions: "Always say configured.", allowedTools: [] }),
    });
    assert.equal(created.status, 201);
    const agent = (await created.json() as { agent: { id: string; version: number } }).agent;
    assert.equal(agent.version, 1);
    assert.equal((await fetch(`${base}/agents/${agent.id}`, { headers: { "x-deepseek-ui-workspace": "bob" } })).status, 404);
    const response = await fetch(`${base}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-deepseek-ui-workspace": "alice",
        "x-deepseek-ui-agent": agent.id,
      },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "run configured agent" }] }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /run configured agent/);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("projects, files, extraction, and keyword knowledge stay owner and project scoped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-projects-"));
  const store = new WorkspaceStore(join(directory, "workspace.json"));
  const project = await store.createProject({ owner: "alice", name: "Policies", instructions: "Use policy documents." });
  const storage = new FileStorage(join(directory, "files"));
  const info = validateUpload("policy.md", 42);
  const fileId = "file-policy";
  const storageKey = await storage.put(fileId, Buffer.from("# Retention\nKeep records for seven years."));
  const file = await store.createFile({
    id: fileId, owner: "alice", projectId: project.id, originalName: "policy.md", mimeType: info.mimeType,
    size: 42, storageKey, extractionStatus: "queued", metadata: {},
  });

  const extracted = await extractDocument(await storage.read(storageKey), file.originalName);
  await store.updateFile(file.id, "alice", { extractionStatus: "completed", extractedText: extracted.text });
  await store.replaceKnowledgeChunks(file.id, "alice", chunkDocument(file, extracted, 200, 20));
  assert.equal((await store.searchKnowledge("alice", "seven years", project.id)).length, 1);
  assert.equal((await store.searchKnowledge("bob", "seven years", project.id)).length, 0);
  assert.throws(() => validateUpload("../secret.txt", 5));
});

test("gateway project and file APIs enforce ownership and expose searchable sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-gateway-projects-"));
  const gateway = await createGateway({ provider: "mock", dataFile: join(directory, "workspace.json"), filesRoot: join(directory, "files") });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const projectResponse = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-deepseek-ui-workspace": "alice" },
      body: JSON.stringify({ name: "Research", instructions: "Use uploaded evidence." }),
    });
    assert.equal(projectResponse.status, 201);
    const project = (await projectResponse.json() as { project: { id: string } }).project;
    const upload = await fetch(`${base}/files`, {
      method: "POST",
      headers: { "x-deepseek-ui-workspace": "alice", "x-project-id": project.id, "x-file-name": "notes.md", "content-type": "text/markdown" },
      body: "# Facts\nThe retention period is seven years.",
    });
    assert.equal(upload.status, 201);
    const file = (await upload.json() as { file: { id: string } }).file;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await (await fetch(`${base}/files/${file.id}`, { headers: { "x-deepseek-ui-workspace": "alice" } })).json() as { file: { extractionStatus: string } };
      if (current.file.extractionStatus === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const search = await fetch(`${base}/knowledge/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-deepseek-ui-workspace": "alice" },
      body: JSON.stringify({ projectId: project.id, query: "seven years" }),
    });
    assert.equal((await search.json() as { results: Array<{ fileId: string }> }).results[0]?.fileId, file.id);
    assert.equal((await fetch(`${base}/files/${file.id}`, { headers: { "x-deepseek-ui-workspace": "bob" } })).status, 404);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("gateway cancellation aborts active mock generation and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-ui-cancel-"));
  const gateway = await createGateway({ provider: "mock", mockDelayMs: 200, dataFile: join(directory, "workspace.json") });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    const request = fetch(`${base}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-deepseek-ui-conversation": "cancel-test" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "cancel me" }] }),
    });
    let runs = { runs: [] as Array<{ id: string }> };
    for (let attempt = 0; attempt < 20 && runs.runs.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      runs = await (await fetch(`${base}/runs`)).json() as { runs: Array<{ id: string }> };
    }
    assert.equal(runs.runs.length, 1);
    assert.equal((await fetch(`${base}/runs/${runs.runs[0].id}/cancel`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${base}/runs/${runs.runs[0].id}/cancel`, { method: "POST" })).status, 200);
    await request.catch(() => undefined);
    const finalRuns = await (await fetch(`${base}/runs`)).json() as { runs: Array<{ status: string }> };
    assert.equal(finalRuns.runs[0].status, "cancelled");
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reasoning_content is kept when tools are in the request", () => {
  const out = prepareMessages(history, true);
  assert.equal((out[1] as { reasoning_content?: string }).reasoning_content, "thinking...");
});

test("reasoning_content is dropped when there are no tools", () => {
  const out = prepareMessages(history, false);
  assert.equal("reasoning_content" in out[1], false);
});

test("permissions: first matching rule wins, default applies otherwise", async () => {
  const p = new Permissions(
    { rules: [{ tool: "fs__read*", decision: "allow" }, { tool: "fs__*", decision: "deny" }], default: "ask" },
    async () => true,
  );
  assert.equal(p.decide("fs__read_file"), "allow");
  assert.equal(p.decide("fs__write_file"), "deny");
  assert.equal(p.decide("other__thing"), "ask");
  assert.equal(await p.authorize("other__thing", {}), true);
  assert.equal(await p.authorize("fs__write_file", {}), false);
});

test("permissions: selection never bypasses policy, configured denies still win", async () => {
  const p = new Permissions(
    { rules: [{ tool: "danger__*", decision: "deny" }], default: "deny" },
    async () => false,
  );
  assert.equal(await p.authorizeSelected("fs__read_file", {}, true), false);
  assert.equal(await p.authorizeSelected("danger__delete", {}, true), false);
  assert.equal(await p.authorizeSelected("other__tool", {}, false), false);
});

test("frontmatter parsing", () => {
  const { meta, body } = parseFrontmatter("---\nname: x\ndescription: \"does y\"\n---\nbody here");
  assert.equal(meta.name, "x");
  assert.equal(meta.description, "does y");
  assert.equal(body, "body here");
});

test("skills: catalog lists skills, load returns body only", async () => {
  const reg = new SkillRegistry();
  await reg.scan(["./skills"]);
  assert.ok(reg.catalog().includes("example"));
  const body = await reg.load("example");
  assert.ok(body.includes("SKILLS_OK"));
  assert.equal(body.includes("description:"), false);
});

test("gateway converts Anthropic messages and preserves thinking", () => {
  const messages = toAgentMessages([
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "answer" },
      ],
    },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "answer", reasoning_content: "reasoning" },
  ]);
});

test("gateway accepts x-api-key and bearer authentication", () => {
  assert.equal(getRequestApiKey({ "x-api-key": "direct" }), "direct");
  assert.equal(getRequestApiKey({ authorization: "Bearer bearer-key" }), "bearer-key");
  assert.equal(getRequestApiKey({}, "fallback"), "fallback");
});

test("agent context compaction keeps the system prompt and newest messages", () => {
  const messages: Message[] = [
    { role: "system", content: "policy" },
    { role: "user", content: "old ".repeat(100) },
    { role: "assistant", content: "older ".repeat(100) },
    { role: "user", content: "latest" },
  ];
  const compacted = compactMessages(messages, 180);
  assert.equal(compacted[0].role, "system");
  assert.equal(compacted.at(-1)?.content, "latest");
  assert.ok(compacted.some((message) => message.content?.toString().includes("compacted")));
});
