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
