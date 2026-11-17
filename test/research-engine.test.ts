import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchEngine, dedupeSearchResults, detectConflicts, generateQueries, mapLimit } from "../src/research/engine.js";
import { ResearchTools, RESEARCH_TOOL_NAMES, researchToolSpecs } from "../src/research/tools.js";
import { LocalMockSearchProvider } from "../src/research/providers/mock.js";
import { WorkspaceStore } from "../src/persistence.js";
import {
  ResearchError,
  type ResearchRunContext,
  type ResearchSourceRecord,
  type ResearchSourceStore,
  type SearchPage,
  type SearchProvider,
  type SearchRequest,
} from "../src/research/types.js";

class MemorySourceStore implements ResearchSourceStore {
  readonly records: ResearchSourceRecord[] = [];

  async saveSource(record: ResearchSourceRecord): Promise<ResearchSourceRecord> {
    const existing = this.records.find(
      (item) => item.owner === record.owner && item.conversationId === record.conversationId && item.canonicalUrl === record.canonicalUrl,
    );
    if (existing) {
      Object.assign(existing, { ...record, id: existing.id, citationIndex: existing.citationIndex });
      return existing;
    }
    this.records.push(record);
    return record;
  }

  async listSources(owner: string, conversationId: string): Promise<ResearchSourceRecord[]> {
    return this.records
      .filter((item) => item.owner === owner && item.conversationId === conversationId)
      .sort((a, b) => a.citationIndex - b.citationIndex);
  }

  async getSource(id: string, owner: string): Promise<ResearchSourceRecord | undefined> {
    return this.records.find((item) => item.id === id && item.owner === owner);
  }
}

const fixedNow = () => new Date("2026-02-03T04:05:06.000Z");
const context: ResearchRunContext = { owner: "local", conversationId: "conversation-1", runId: "run-1" };

const createEngine = (options: { store?: ResearchSourceStore; maxPages?: number; maxQueries?: number; provider?: SearchProvider; tools?: boolean } = {}) =>
  new ResearchEngine({
    provider: options.provider ?? new LocalMockSearchProvider(),
    store: options.store,
    now: fixedNow,
    limits: { maxPages: options.maxPages ?? 5, maxQueries: options.maxQueries ?? 4, maxFetchConcurrency: 2, fetchTimeoutMs: 5_000 },
  });

test("query generation is deterministic and bounded", () => {
  const queries = generateQueries("What are the latest quantum computing qubit milestones?", 3);
  assert.equal(queries.length, 3);
  assert.equal(queries[0], "What are the latest quantum computing qubit milestones?");
  assert.deepEqual(generateQueries("What are the latest quantum computing qubit milestones?", 3), queries);
  assert.deepEqual(generateQueries("   ", 3), []);
});

test("deduplication removes canonical duplicates and near-identical titles", () => {
  const page: SearchPage = {
    provider: "local-mock",
    isMock: true,
    query: "q",
    results: [
      { id: "a", title: "Quantum milestone report", url: "https://example.com/a?utm_source=x", snippet: "s", domain: "example.com", provider: "local-mock", isMock: true },
      { id: "b", title: "Quantum milestone report", url: "https://example.com/a", snippet: "s", domain: "example.com", provider: "local-mock", isMock: true },
      { id: "c", title: "Quantum milestone report", url: "https://example.com/a2", snippet: "s", domain: "example.com", provider: "local-mock", isMock: true },
    ],
    hasMore: false,
  };
  const deduped = dedupeSearchResults(page.results);
  assert.equal(deduped.kept.length, 1);
  assert.equal(deduped.removed, 2);
});

test("mapLimit preserves order and bounds concurrency", async () => {
  let active = 0;
  let peak = 0;
  const values = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(values, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2);
});

test("search persists sources with stable citation indices", async () => {
  const store = new MemorySourceStore();
  const engine = createEngine({ store });
  const first = await engine.search("quantum error correction", context);
  assert.ok(first.sources.length >= 2);
  assert.equal(first.sources[0]?.citationIndex, 1);
  assert.equal(first.sources[0]?.retrievedAt, "2026-02-03T04:05:06.000Z");
  assert.equal(first.sources[0]?.isMock, true);
  assert.equal(first.sources[0]?.provider, "local-mock");
  const second = await engine.search("quantum error correction", context);
  assert.deepEqual(
    second.sources.map((source) => source.citationIndex),
    first.sources.map((source) => source.citationIndex),
  );
  const listed = await engine.listSources(context);
  assert.equal(listed.length, first.sources.length);
});

test("fetch and extract return cited metadata and extracted text", async () => {
  const store = new MemorySourceStore();
  const engine = createEngine({ store });
  const url = "https://www.example-science.org/quantum/error-correction";
  const outcome = await engine.fetchPage(url, context);
  assert.equal(outcome.extraction.ok, true);
  assert.equal(outcome.source.status, "extracted");
  assert.equal(outcome.source.publishedAt, "2025-03-11T09:00:00.000Z");
  assert.match(outcome.source.content, /256-qubit/);
  assert.equal(outcome.source.retrievedAt, "2026-02-03T04:05:06.000Z");
  assert.equal(outcome.source.isMock, true);

  const focused = await engine.extractPage(url, context, "logical error rate");
  assert.ok(focused.focusedText);
  assert.match(focused.focusedText!, /logical error rate/i);

  await assert.rejects(engine.fetchPage("https://mock.example/unknown", context), (error: unknown) => {
    assert.ok(error instanceof ResearchError);
    assert.equal(error.code, "fetch_failed");
    return true;
  });
});

test("research workflow generates citations, detects conflicts, and stays bounded", async () => {
  const store = new MemorySourceStore();
  const engine = createEngine({ store, maxPages: 4, maxQueries: 3 });
  const result = await engine.runWorkflow("What are the latest quantum computing qubit milestones?", context);
  assert.ok(result.queries.length <= 3);
  assert.ok(result.sources.length > 0);
  assert.ok(result.findings.length > 0);
  assert.ok(result.pagesFetched <= 4);
  assert.equal(result.isMock, true);
  assert.match(result.brief, /local mock corpus/i);
  assert.match(result.brief, /\[citation:\d+\]/);
  const indexes = new Set(result.sources.map((source) => source.citationIndex));
  for (const finding of result.findings) assert.ok(indexes.has(finding.citationIndex));
  for (const match of result.brief.matchAll(/\[citation:(\d+)\]/g)) {
    assert.ok(indexes.has(Number(match[1])), `brief cites unknown source ${match[1]}`);
  }
  assert.ok(result.conflicts.some((conflict) => conflict.topic === "qubit"), JSON.stringify(result.conflicts));
  const stored = await store.listSources(context.owner, context.conversationId);
  assert.deepEqual(stored.map((source) => source.citationIndex), [...stored.map((source) => source.citationIndex)].sort((a, b) => a - b));
  assert.ok(stored.some((source) => source.status === "extracted" && source.content.length > 100));
});

test("workflow records provider failures without crashing", async () => {
  const failingProvider: SearchProvider = {
    id: "broken",
    displayName: "Broken provider",
    isMock: false,
    requiresCredentials: false,
    limits: { maxResults: 5, maxQueryChars: 400, supportsPagination: false },
    status() {
      return { id: "broken", displayName: "Broken provider", available: true, isMock: false, requiresCredentials: false, limits: this.limits };
    },
    async search(_request: SearchRequest): Promise<SearchPage> {
      throw new ResearchError("provider_error", "upstream exploded");
    },
  };
  const engine = createEngine({ provider: failingProvider });
  const result = await engine.runWorkflow("what happened", context);
  assert.equal(result.sources.length, 0);
  assert.ok(result.errors.length >= 1);
  assert.equal(result.errors[0]?.stage, "search");
  await assert.rejects(engine.search("anything", context), (error: unknown) => {
    assert.ok(error instanceof ResearchError);
    assert.equal(error.code, "provider_error");
    return true;
  });
});

test("detectConflicts only reports numeric disagreement across sources", () => {
  const conflicts = detectConflicts([
    { id: "s1", title: "A", content: "The device had 256 qubits in 2025." },
    { id: "s2", title: "B", content: "The vendor announced 1000 qubits in 2025." },
    { id: "s3", title: "C", content: "The device had 256 qubits in 2025." },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.topic, "qubit");
  assert.deepEqual(conflicts[0]?.values, ["256 qubit", "1000 qubit"]);
  assert.deepEqual(conflicts[0]?.sourceIds.sort(), ["s1", "s2", "s3"]);

  const noConflict = detectConflicts([
    { id: "s1", title: "A", content: "It costs 10 dollars." },
    { id: "s2", title: "B", content: "It costs 11 dollars." },
  ]);
  assert.equal(noConflict.length, 0);
});

test("research tools return honest mock labels and error payloads", async () => {
  const store = new MemorySourceStore();
  const engine = createEngine({ store });
  const tools = new ResearchTools(engine, { maxCallsPerRun: 3 });

  const search = JSON.parse(await tools.execute("web_search", { query: "quantum" }, context)) as { ok: boolean; isMock: boolean; notice: string; results: Array<{ citationIndex: number; url: string }> };
  assert.equal(search.ok, true);
  assert.equal(search.isMock, true);
  assert.match(search.notice, /MOCK SEARCH/);
  assert.ok(search.results[0]?.citationIndex >= 1);

  const fetch = JSON.parse(await tools.execute("web_fetch", { url: search.results[0]!.url }, context)) as { ok: boolean; sourceId: string; content: string; note: string };
  assert.equal(fetch.ok, true);
  assert.match(fetch.note, /untrusted/);
  assert.ok(fetch.sourceId);

  const blocked = JSON.parse(await tools.execute("web_fetch", { url: "http://169.254.169.254/latest/meta-data/" }, context)) as { ok: boolean; error: { code: string } };
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "private_address");

  const exhausted = JSON.parse(await tools.execute("web_search", { query: "quantum" }, context)) as { ok: boolean; error: { message: string } };
  assert.equal(exhausted.ok, false);
  assert.match(exhausted.error.message, /budget/i);
});

test("research_sources run executes the workflow and list returns stored sources", async () => {
  const store = new MemorySourceStore();
  const engine = createEngine({ store });
  const tools = new ResearchTools(engine, { maxCallsPerRun: 10 });
  const run = JSON.parse(await tools.execute("research_sources", { action: "run", question: "quantum qubit milestones" }, context)) as {
    ok: boolean;
    isMock: boolean;
    findings: Array<{ citationIndex: number }>;
    sources: Array<{ citationIndex: number }>;
  };
  assert.equal(run.isMock, true);
  assert.ok(run.findings.length > 0);
  assert.ok(run.sources.length > 0);

  const list = JSON.parse(await tools.execute("research_sources", { action: "list" }, context)) as { ok: boolean; count: number; sources: Array<{ url: string }> };
  assert.equal(list.ok, true);
  assert.ok(list.count >= 1);
  assert.ok(list.sources.every((source) => typeof source.url === "string"));

  assert.deepEqual(
    researchToolSpecs().map((spec) => spec.name),
    [...RESEARCH_TOOL_NAMES],
  );
  assert.ok(researchToolSpecs().every((spec) => spec.readOnly && spec.permissionClass === "read-only"));
});

test("source snapshots and artifact source references persist across reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-research-"));
  try {
    const file = join(directory, "workspace.json");
    const store = new WorkspaceStore(file);
    await store.load();
    const engine = new ResearchEngine({
      provider: new LocalMockSearchProvider(),
      store: {
        saveSource: (record) => store.saveResearchSource(record),
        listSources: (owner, conversationId) => store.listResearchSources(owner, conversationId),
        getSource: (id, owner) => store.getResearchSource(id, owner),
      },
      now: fixedNow,
      limits: { maxPages: 2, maxQueries: 1 },
    });
    const outcome = await engine.search("quantum error correction", context);
    assert.ok(outcome.sources.length >= 1);
    const first = outcome.sources[0]!;
    const second = outcome.sources[1] ?? outcome.sources[0]!;
    const distinctIds = [...new Set([first.id, second.id])];

    // Re-saving the same canonical URL must not renumber the citation.
    const fetched = await engine.fetchPage(first.url, context);
    assert.equal(fetched.source.citationIndex, first.citationIndex);
    assert.equal(fetched.source.id, first.id);

    const artifact = await store.createArtifact({
      owner: "local",
      conversationId: context.conversationId,
      name: "Quantum brief",
      kind: "markdown",
      mimeType: "text/markdown",
      metadata: { sourceIds: distinctIds },
      content: "# Brief\n\nSee [citation:1].",
      createdBy: "assistant",
      sourceIds: distinctIds,
    });
    assert.deepEqual(artifact.versions[0]?.sourceIds, distinctIds);

    const updated = await store.updateArtifact(artifact.id, "local", {
      content: "# Brief v2\n\nSee [citation:1].",
      createdBy: "assistant",
      sourceIds: distinctIds,
    });
    assert.equal(updated?.currentVersion, 2);
    assert.deepEqual(updated?.versions[1]?.sourceIds, distinctIds);

    const reloaded = new WorkspaceStore(file);
    await reloaded.load();
    const persisted = await reloaded.listResearchSources("local", context.conversationId);
    assert.equal(persisted.length, outcome.sources.length);
    assert.equal(persisted[0]?.title, fetched.source.title);
    assert.ok((persisted[0]?.content.length ?? 0) > 100);
    assert.equal(persisted[0]?.retrievedAt, "2026-02-03T04:05:06.000Z");
    assert.equal(persisted[0]?.publishedAt, "2025-03-11T09:00:00.000Z");
    const reloadedArtifact = await reloaded.getArtifact(artifact.id, "local");
    assert.equal(reloadedArtifact?.versions[1]?.sourceIds?.length, distinctIds.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
