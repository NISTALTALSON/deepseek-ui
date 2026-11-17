import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../src/gateway.js";
import { WorkspaceStore } from "../src/persistence.js";
import type { ModelProvider } from "../src/provider.js";
import type { Message, StreamEvent, ToolSpec } from "../src/types.js";

type ScriptStep = { toolCalls?: Array<{ name: string; args: Record<string, unknown> }>; text?: string };

class ScriptedProvider implements ModelProvider {
  readonly id = "mock";
  readonly displayName = "Scripted mock";
  steps: ScriptStep[] = [];
  calls = 0;

  setScript(steps: ScriptStep[]): void {
    this.steps = steps;
    this.calls = 0;
  }

  async *stream(_messages: Message[], _tools: ToolSpec[] = [], _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const step = this.steps[this.calls] ?? { text: "Done." };
    this.calls += 1;
    if (step.toolCalls?.length) {
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: null,
          tool_calls: step.toolCalls.map((call, index) => ({
            id: `call_${this.calls}_${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      };
      return;
    }
    const text = step.text ?? "Done.";
    yield { type: "text", delta: text };
    yield { type: "done", message: { role: "assistant", content: text } };
  }
}

type StreamEventRecord = { event: string; data: Record<string, unknown> };

const startGateway = async (config: Parameters<typeof createGateway>[0]) => {
  const gateway = await createGateway(config);
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", () => resolve()));
  const address = gateway.server.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port");
  return { gateway, base: `http://127.0.0.1:${address.port}` };
};

const readEvents = async (response: Response, onEvent?: (record: StreamEventRecord) => Promise<void> | void): Promise<StreamEventRecord[]> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: StreamEventRecord[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) eventName = line.slice(7);
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      if (dataLines.length) {
        const record = { event: eventName, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
        events.push(record);
        await onEvent?.(record);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
};

const postMessage = async (base: string, conversationId: string, text: string): Promise<Response> =>
  await fetch(`${base}/anthropic/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-deepseek-ui-conversation": conversationId },
    body: JSON.stringify({ model: "mock", system: "You are a research assistant.", messages: [{ role: "user", content: text }] }),
  });

const blocks = (events: StreamEventRecord[]) =>
  events
    .filter((record) => record.event === "content_block_start")
    .map((record) => record.data.content_block as Record<string, unknown>);

const waitForRunStatus = async (base: string, runId: string, status: string, timeoutMs = 5_000): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${base}/runs`);
    const body = (await response.json()) as { runs?: Array<Record<string, unknown>> };
    const run = body.runs?.find((item) => item.id === runId);
    if (run?.status === status) return run;
    if (Date.now() > deadline) throw new Error(`Run ${runId} did not reach ${status}; last=${String(run?.status)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** Windows can briefly retain a handle after the final atomic rename. */
const removeDirectory = async (directory: string): Promise<void> => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

test("gateway runs research tools end to end with citations and checkpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-gateway-"));
  const provider = new ScriptedProvider();
  const { gateway, base } = await startGateway({
    provider: "mock",
    dataFile: join(directory, "workspace.json"),
    filesRoot: join(directory, "files"),
    modelProvider: provider,
  });
  try {
    provider.setScript([
      { toolCalls: [{ name: "web_search", args: { query: "quantum error correction" } }] },
      { text: "Quantum error correction improved [citation:1]." },
    ]);
    const response = await postMessage(base, "c-research", "Research quantum error correction");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = await readEvents(response);

    const started = blocks(events).filter((block) => block.type === "server_tool_use");
    assert.equal(started.length, 1);
    assert.equal(started[0]?.name, "deepseek_web_search");
    assert.deepEqual((started[0]?.input as Record<string, unknown>).queries, ["quantum error correction"]);

    const searchResult = blocks(events).find((block) => block.type === "web_search_tool_result") as
      | { tool_use_id: string; content: Array<Record<string, unknown>>; kind: string }
      | undefined;
    assert.ok(searchResult);
    assert.equal(searchResult.kind, "search");
    assert.ok(searchResult.content.length >= 2);
    const firstResult = searchResult.content[0]!;
    assert.equal(firstResult.type, "web_search_result");
    assert.equal(firstResult.site_name, "example-science.org");
    assert.equal(firstResult.page_age, "2025-03-11T09:00:00.000Z");
    assert.equal(firstResult.is_mock, true);
    assert.equal(firstResult.citation_index, 1);

    const answer = events
      .filter((record) => record.event === "content_block_delta")
      .map((record) => (record.data.delta as Record<string, unknown>).text)
      .filter((text): text is string => typeof text === "string")
      .join("");
    assert.match(answer, /\[citation:1\]/);
    assert.equal(events.some((record) => record.event === "approval_required"), false);

    const sourcesResponse = await fetch(`${base}/research/sources?conversationId=c-research`);
    const sourcesBody = (await sourcesResponse.json()) as { sources: Array<Record<string, unknown>> };
    assert.ok(sourcesBody.sources.length >= 2);
    assert.equal(sourcesBody.sources[0]?.citationIndex, 1);
    assert.equal(sourcesBody.sources[0]?.isMock, true);
    assert.equal(sourcesBody.sources[0]?.provider, "local-mock");
    assert.ok(sourcesBody.sources[0]?.retrievedAt);

    const statusResponse = await fetch(`${base}/research/status`);
    const statusBody = (await statusResponse.json()) as Record<string, unknown>;
    assert.equal(statusBody.provider, "local-mock");
    assert.equal(statusBody.isMock, true);
    assert.equal((statusBody.security as Record<string, unknown>).executesPageScripts, false);

    // Journal and checkpoint state must survive on disk.
    const store = new WorkspaceStore(join(directory, "workspace.json"));
    await store.load();
    const runs = await store.runs("local");
    const run = runs.find((item) => item.conversationId === "c-research");
    assert.ok(run);
    assert.equal(run.status, "completed");
    const checkpoint = await store.latestCheckpoint(run.id, "local");
    assert.equal(checkpoint?.phase, "completed");
    const journal = await store.getToolExecution(`${run.id}:call_1_0`);
    assert.equal(journal?.status, "completed");
    assert.match(journal?.output ?? "", /example-science\.org/);
  } finally {
    await gateway.close();
    await removeDirectory(directory);
  }
});

test("gateway approves artifact creation with research source references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-gateway-artifact-"));
  const provider = new ScriptedProvider();
  const { gateway, base } = await startGateway({
    provider: "mock",
    dataFile: join(directory, "workspace.json"),
    filesRoot: join(directory, "files"),
    modelProvider: provider,
  });
  try {
    provider.setScript([
      { toolCalls: [{ name: "web_search", args: { query: "quantum error correction" } }] },
      { text: "Sources collected [citation:1]." },
    ]);
    await readEvents(await postMessage(base, "c-artifact", "collect sources"));
    const sourcesBody = (await (await fetch(`${base}/research/sources?conversationId=c-artifact`)).json()) as {
      sources: Array<{ sourceId: string; citationIndex: number }>;
    };
    const sourceId = sourcesBody.sources[0]!.sourceId;

    provider.setScript([
      { toolCalls: [{ name: "artifact_create", args: { name: "Quantum report", kind: "markdown", content: "# Report\n\nSee [citation:1].", sourceIds: [sourceId] } }] },
      { text: "Artifact created." },
    ]);
    const events = await readEvents(await postMessage(base, "c-artifact", "write the report"), async (record) => {
      if (record.event === "approval_required") {
        const approvalId = String(record.data.approvalId);
        const approved = await fetch(`${base}/approvals/${approvalId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approved" }),
        });
        assert.equal(approved.status, 200);
      }
    });
    assert.ok(events.some((record) => record.event === "approval_required"));

    const artifacts = (await (await fetch(`${base}/artifacts?conversationId=c-artifact`)).json()) as {
      artifacts: Array<{ id: string; metadata: Record<string, unknown>; versions: Array<{ sourceIds?: string[] }>; currentVersion: number }>;
    };
    assert.equal(artifacts.artifacts.length, 1);
    const artifact = artifacts.artifacts[0]!;
    assert.deepEqual(artifact.metadata.sourceIds, [sourceId]);
    assert.deepEqual(artifact.versions[0]?.sourceIds, [sourceId]);
    assert.equal(artifact.currentVersion, 1);
  } finally {
    await gateway.close();
    await removeDirectory(directory);
  }
});

test("gateway resumes a checkpointed research call without re-executing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-gateway-resume-"));
  const provider = new ScriptedProvider();
  const dataFile = join(directory, "workspace.json");

  const store = new WorkspaceStore(dataFile);
  await store.load();
  await store.conversation({ id: "c-resume", owner: "local" });
  const run = await store.createRun({ conversationId: "c-resume", provider: "mock", model: "mock", owner: "local" });
  const pending = {
    id: "call_resume",
    type: "function" as const,
    function: { name: "web_search", arguments: JSON.stringify({ query: "quantum" }) },
  };
  const messages = [
    { role: "system" as const, content: "You are a research assistant." },
    { role: "user" as const, content: "Find quantum sources" },
    { role: "assistant" as const, content: null, tool_calls: [pending] },
  ];
  await store.createCheckpoint({
    runId: run.id,
    conversationId: "c-resume",
    owner: "local",
    phase: "tool_proposed",
    agentConfig: { systemPrompt: "You are a research assistant.", projectId: undefined, skillNames: [], enabledMcpServers: [], enabledConnectors: [], allowedTools: [] },
    providerId: "mock",
    modelId: "mock",
    modelParameters: {},
    messages,
    pendingToolCalls: [pending],
    completedToolExecutionIds: [],
    toolResults: {},
    approvalIds: [],
    context: {},
  });
  const journalId = `${run.id}:call_resume`;
  await store.beginToolExecution({ id: journalId, runId: run.id, toolName: "web_search", argumentsHash: "hash" });
  const wrapped = JSON.stringify({
    source: "web",
    trusted: false,
    instruction: "untrusted",
    content: JSON.stringify({ ok: true, query: "quantum", provider: "local-mock", isMock: true, results: [{ citationIndex: 1, title: "Cached", url: "https://example.com/cached" }] }),
  });
  await store.finishToolExecution(journalId, { status: "completed", output: wrapped });

  const { gateway, base } = await startGateway({
    provider: "mock",
    dataFile,
    filesRoot: join(directory, "files"),
    modelProvider: provider,
  });
  try {
    provider.setScript([{ text: "Recovered answer [citation:1]." }]);

    const resume = await fetch(`${base}/runs/${run.id}/resume`, { method: "POST" });
    assert.ok([200, 202].includes(resume.status), `unexpected resume status ${resume.status}`);
    await waitForRunStatus(base, run.id, "completed");
    assert.equal(provider.calls, 1);

    const reopened = new WorkspaceStore(dataFile);
    await reopened.load();
    const journal = await reopened.getToolExecution(journalId);
    assert.equal(journal?.status, "completed");
    assert.equal(journal?.output, wrapped);
    const checkpoints = await reopened.checkpointHistory(run.id, "local");
    assert.ok(checkpoints.some((checkpoint) => checkpoint.phase === "completed"));
  } finally {
    await gateway.close();
    await removeDirectory(directory);
  }
});

test("research_sources run emits a visible search step with citations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-gateway-run-"));
  const provider = new ScriptedProvider();
  const { gateway, base } = await startGateway({
    provider: "mock",
    dataFile: join(directory, "workspace.json"),
    filesRoot: join(directory, "files"),
    modelProvider: provider,
  });
  try {
    provider.setScript([
      { toolCalls: [{ name: "research_sources", args: { action: "run", question: "quantum qubit milestones" } }] },
      { text: "The sources disagree on qubit counts [citation:1]." },
    ]);
    const events = await readEvents(await postMessage(base, "c-workflow", "Compare quantum claims"));
    const started = blocks(events).filter((block) => block.type === "server_tool_use");
    assert.ok(started.length >= 1);
    assert.ok(Array.isArray((started[0]?.input as Record<string, unknown>).queries));
    const result = blocks(events).find((block) => block.type === "web_search_tool_result") as
      | { content: Array<Record<string, unknown>> }
      | undefined;
    assert.ok(result);
    assert.ok(result.content.length >= 1);
    assert.equal(result.content[0]?.type, "web_search_result");
    assert.equal(result.content[0]?.is_mock, true);
    const sourceId = String(result.content[0]?.source_id);
    assert.ok(sourceId);

    const stored = (await (await fetch(`${base}/research/sources?conversationId=c-workflow`)).json()) as {
      sources: Array<{ sourceId: string; status: string; content?: string }>;
    };
    assert.ok(stored.sources.some((source) => source.sourceId === sourceId));
  } finally {
    await gateway.close();
    await removeDirectory(directory);
  }
});

test("gateway reports an unconfigured provider instead of faking results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-gateway-missing-"));
  const provider = new ScriptedProvider();
  const { gateway, base } = await startGateway({
    provider: "mock",
    research: { provider: "tavily", apiKey: "" },
    dataFile: join(directory, "workspace.json"),
    filesRoot: join(directory, "files"),
    modelProvider: provider,
  });
  try {
    provider.setScript([
      { toolCalls: [{ name: "web_search", args: { query: "quantum" } }] },
      { text: "Search is unavailable." },
    ]);
    const events = await readEvents(await postMessage(base, "c-missing", "search quantum"));
    const failed = blocks(events).find((block) => block.type === "web_search_tool_result") as
      | { content: Array<Record<string, unknown>> }
      | undefined;
    assert.ok(failed);
    assert.equal(failed.content[0]?.type, "web_search_tool_result_error");
    assert.equal(failed.content[0]?.error_code, "unavailable");

    const status = (await (await fetch(`${base}/research/status`)).json()) as Record<string, unknown>;
    assert.equal(status.provider, "tavily");
    assert.equal(status.available, false);
    assert.equal(status.degraded, true);
  } finally {
    await gateway.close();
    await removeDirectory(directory);
  }
});
