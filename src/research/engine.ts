import { randomUUID } from "node:crypto";
import { extractKeywords, numericClaims, relevance, titleSimilarity, tokenize } from "./text.js";
import { findMockPage } from "./fixtures.js";
import { extractPage } from "./extract.js";
import { PageFetcher } from "./fetcher.js";
import { domainOf, normalizeUrlForDedupe, parseUrl, validateDestinationSyntax } from "./url-safety.js";
import {
  ResearchError,
  defaultResearchLimits,
  type FetchedPage,
  type PageExtraction,
  type ResearchActivityListener,
  type ResearchConflict,
  type ResearchFinding,
  type ResearchLimits,
  type ResearchRunContext,
  type ResearchSourceRecord,
  type ResearchSourceStore,
  type ResearchWorkflowResult,
  type SearchPage,
  type SearchProvider,
  type SearchResult,
} from "./types.js";

export interface ResearchEngineOptions {
  provider: SearchProvider;
  fetcher?: PageFetcher;
  store?: ResearchSourceStore;
  limits?: Partial<ResearchLimits>;
  now?: () => Date;
  onActivity?: ResearchActivityListener;
  /** Fixture loader used when the provider is the deterministic local mock. */
  pageLoader?: (url: string) => { html: string; contentType?: string } | undefined;
}

export interface SearchOutcome {
  page: SearchPage;
  sources: ResearchSourceRecord[];
  deduplicated: number;
}

export interface FetchOutcome {
  source: ResearchSourceRecord;
  extraction: PageExtraction;
  page: FetchedPage;
}

interface IndexState {
  next: number;
  byUrl: Map<string, ResearchSourceRecord>;
}

const nowIso = (now: () => Date) => now().toISOString();

/** Runs tasks with a bounded concurrency, preserving input order. */
export const mapLimit = async <T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
};

export const generateQueries = (question: string, maxQueries = 4): string[] => {
  const clean = question.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const keywords = extractKeywords(clean, 8);
  const candidates = [clean];
  if (keywords.length >= 2) candidates.push(keywords.slice(0, 5).join(" "));
  if (keywords.length >= 3) candidates.push(`${keywords.slice(0, 3).join(" ")} latest`);
  if (keywords.length >= 3) candidates.push(`${keywords.slice(0, 2).join(" ")} explained`);
  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      const key = candidate.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, maxQueries));
};

export const dedupeSearchResults = (results: SearchResult[]): { kept: SearchResult[]; removed: number } => {
  const kept: SearchResult[] = [];
  const byUrl = new Set<string>();
  for (const result of results) {
    const canonical = normalizeUrlForDedupe(result.url);
    if (byUrl.has(canonical)) continue;
    const duplicate = kept.find(
      (other) => domainOf(other.url) === domainOf(result.url) && titleSimilarity(other.title, result.title) >= 0.85,
    );
    if (duplicate) continue;
    byUrl.add(canonical);
    kept.push(result);
  }
  return { kept, removed: results.length - kept.length };
};

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20);

export const evidenceFor = (query: string, text: string, limit = 2): string => {
  const list = sentences(text);
  const scored = list
    .map((sentence) => ({ sentence, score: relevance(query, sentence) }))
    .filter((item) => item.score > 0 || list.length <= limit)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const evidence = scored.map((item) => item.sentence).join(" ");
  return (evidence || text.slice(0, 320)).slice(0, 700);
};

const unitKey = (unit: string): string => unit.replace(/s$/, "");

export interface ConflictInput {
  id: string;
  title: string;
  content: string;
}

/** Detects explicit numeric claims that disagree across sources for the same unit. */
export const detectConflicts = (sources: ConflictInput[]): ResearchConflict[] => {
  const byUnit = new Map<string, Map<number, Set<string>>>();
  for (const source of sources) {
    for (const claim of numericClaims(source.content)) {
      const unit = unitKey(claim.unit);
      let values = byUnit.get(unit);
      if (!values) {
        values = new Map();
        byUnit.set(unit, values);
      }
      let ids = values.get(claim.value);
      if (!ids) {
        ids = new Set();
        values.set(claim.value, ids);
      }
      ids.add(source.id);
    }
  }
  const conflicts: ResearchConflict[] = [];
  for (const [unit, values] of byUnit) {
    const distinct = [...values.keys()].sort((a, b) => a - b);
    const sourceIds = [...new Set([...values.values()].flatMap((ids) => [...ids]))];
    if (distinct.length < 2 || sourceIds.length < 2) continue;
    const smallest = distinct[0]!;
    const largest = distinct.at(-1)!;
    if (smallest === 0 || largest / smallest <= 1.1) continue;
    conflicts.push({
      topic: unit,
      values: distinct.map((value) => `${value} ${unit}`),
      sourceIds,
      note: `Sources disagree on ${unit}: ${distinct.join(" vs ")}. Verify the definition and date before citing.`,
    });
  }
  return conflicts.sort((a, b) => a.topic.localeCompare(b.topic));
};

export class ResearchEngine {
  readonly provider: SearchProvider;
  readonly limits: ResearchLimits;
  private readonly fetcher?: PageFetcher;
  private readonly store?: ResearchSourceStore;
  private readonly now: () => Date;
  private readonly onActivity?: ResearchActivityListener;
  private readonly pageLoader?: (url: string) => { html: string; contentType?: string } | undefined;
  private readonly indexStates = new Map<string, IndexState>();

  constructor(options: ResearchEngineOptions) {
    this.provider = options.provider;
    this.limits = { ...defaultResearchLimits, ...options.limits };
    this.fetcher = options.fetcher;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.onActivity = options.onActivity;
    this.pageLoader = options.pageLoader ?? (this.provider.isMock ? (url) => {
      const fixture = findMockPage(url);
      return fixture ? { html: fixture.html, contentType: fixture.contentType ?? "text/html" } : undefined;
    } : undefined);
  }

  private emit(activity: Parameters<NonNullable<ResearchActivityListener>>[0]): void {
    this.onActivity?.(activity);
  }

  private stateKey(context: ResearchRunContext): string {
    return `${context.owner}:${context.conversationId}`;
  }

  private async indexState(context: ResearchRunContext): Promise<IndexState> {
    const key = this.stateKey(context);
    const cached = this.indexStates.get(key);
    if (cached) return cached;
    const state: IndexState = { next: 1, byUrl: new Map() };
    if (this.store) {
      const existing = await this.store.listSources(context.owner, context.conversationId);
      for (const source of existing) {
        state.byUrl.set(source.canonicalUrl, source);
        state.next = Math.max(state.next, source.citationIndex + 1);
      }
    }
    this.indexStates.set(key, state);
    return state;
  }

  private async persist(
    context: ResearchRunContext,
    input: Omit<ResearchSourceRecord, "id" | "owner" | "conversationId" | "citationIndex">,
  ): Promise<ResearchSourceRecord> {
    const state = await this.indexState(context);
    const existing = state.byUrl.get(input.canonicalUrl);
    const record: ResearchSourceRecord = {
      ...input,
      id: existing?.id ?? randomUUID(),
      owner: context.owner,
      conversationId: context.conversationId,
      runId: context.runId,
      citationIndex: existing?.citationIndex ?? state.next,
    };
    if (!existing) state.next += 1;
    const saved = this.store ? await this.store.saveSource(record) : record;
    state.byUrl.set(saved.canonicalUrl, saved);
    return saved;
  }

  async listSources(context: ResearchRunContext): Promise<ResearchSourceRecord[]> {
    if (this.store) return (await this.store.listSources(context.owner, context.conversationId)).sort((a, b) => a.citationIndex - b.citationIndex);
    const state = await this.indexState(context);
    return [...state.byUrl.values()].sort((a, b) => a.citationIndex - b.citationIndex);
  }

  async getSource(id: string, context: ResearchRunContext): Promise<ResearchSourceRecord | undefined> {
    if (this.store) {
      const found = await this.store.getSource(id, context.owner);
      return found && found.conversationId === context.conversationId ? found : undefined;
    }
    const state = await this.indexState(context);
    return [...state.byUrl.values()].find((source) => source.id === id);
  }

  async search(queryText: string, context: ResearchRunContext, options: { maxResults?: number } = {}): Promise<SearchOutcome> {
    const query = queryText.trim();
    if (!query) throw new ResearchError("invalid_request", "A search query is required.");
    if (query.length > this.provider.limits.maxQueryChars) {
      throw new ResearchError("invalid_request", "Search query is too long.", { max: this.provider.limits.maxQueryChars });
    }
    const maxResults = Math.min(
      this.provider.limits.maxResults,
      Math.max(1, options.maxResults ?? this.limits.maxResultsPerQuery),
    );
    this.emit({ type: "search_started", query, provider: this.provider.id, isMock: this.provider.isMock });
    let page: SearchPage;
    try {
      page = await this.provider.search({
        query: { text: query, maxResults },
        pageSize: maxResults,
        signal: context.signal,
      });
    } catch (error) {
      this.emit({
        type: "search_failed",
        query,
        provider: this.provider.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const deduped = dedupeSearchResults(page.results);
    this.emit({ type: "search_completed", query, provider: page.provider, found: deduped.kept.length, isMock: page.isMock });
    if (deduped.removed > 0) this.emit({ type: "deduplicated", kept: deduped.kept.length, removed: deduped.removed });
    const retrievedAt = nowIso(this.now);
    const sources: ResearchSourceRecord[] = [];
    for (const result of deduped.kept) {
      sources.push(await this.persist(context, {
        query,
        title: result.title,
        url: result.url,
        canonicalUrl: normalizeUrlForDedupe(result.url),
        domain: result.domain || domainOf(result.url),
        snippet: result.snippet,
        retrievedAt,
        publishedAt: result.publishedAt,
        excerpt: "",
        content: "",
        provider: page.provider,
        isMock: page.isMock,
        status: "search",
        score: result.score,
        metadata: { providerId: result.id, ...(result.metadata ?? {}) },
      }));
    }
    return { page, sources, deduplicated: deduped.removed };
  }

  async fetchPage(url: string, context: ResearchRunContext): Promise<FetchOutcome> {
    parseUrl(url);
    // Always reject blocked literals/hosts even when fixtures serve the body.
    validateDestinationSyntax(url);
    this.emit({ type: "fetch_started", url });
    let page: FetchedPage;
    if (this.provider.isMock) {
      const fixture = this.pageLoader?.(url);
      if (!fixture) {
        const error = new ResearchError("fetch_failed", "The local mock corpus has no page for this URL.");
        this.emit({ type: "fetch_failed", url, error: error.message });
        throw error;
      }
      const body = fixture.html;
      page = {
        url,
        finalUrl: url,
        status: 200,
        contentType: fixture.contentType ?? "text/html",
        charset: "utf-8",
        body,
        byteLength: Buffer.byteLength(body),
        retrievedAt: nowIso(this.now),
        redirects: [],
      };
    } else {
      if (!this.fetcher) throw new ResearchError("fetch_failed", "No safe page fetcher is configured.");
      page = await this.fetcher.fetch(url, { signal: context.signal });
    }
    this.emit({ type: "fetch_completed", url, status: page.status, bytes: page.byteLength });
    const extraction = extractPage({
      html: page.body,
      url: page.finalUrl,
      contentType: page.contentType,
      maxChars: this.limits.maxSourceChars,
      excerptChars: this.limits.maxExcerptChars,
    });
    if (extraction.ok) {
      this.emit({ type: "extraction_completed", url: page.finalUrl, title: extraction.title, chars: extraction.contentLength });
    } else {
      this.emit({ type: "extraction_failed", url: page.finalUrl, error: extraction.error ?? "extraction_failed" });
    }
    const source = await this.persist(context, {
      title: extraction.title || domainOf(page.finalUrl) || page.finalUrl,
      url: page.finalUrl,
      canonicalUrl: normalizeUrlForDedupe(extraction.canonicalUrl || page.finalUrl),
      domain: domainOf(extraction.canonicalUrl || page.finalUrl),
      snippet: extraction.description ?? extraction.excerpt,
      retrievedAt: page.retrievedAt,
      publishedAt: extraction.publishedAt,
      excerpt: extraction.excerpt,
      content: extraction.text,
      provider: this.provider.id,
      isMock: this.provider.isMock,
      status: extraction.ok ? "extracted" : "error",
      error: extraction.ok ? undefined : extraction.error ?? "extraction_failed",
      metadata: {
        contentType: page.contentType,
        byteLength: page.byteLength,
        redirects: page.redirects,
        contentLength: extraction.contentLength,
      },
    });
    return { source, extraction, page };
  }

  async extractPage(url: string, context: ResearchRunContext, query?: string): Promise<FetchOutcome & { focusedText?: string }> {
    const outcome = await this.fetchPage(url, context);
    if (!query) return outcome;
    return { ...outcome, focusedText: evidenceFor(query, outcome.extraction.text, 4) };
  }

  async runWorkflow(question: string, context: ResearchRunContext): Promise<ResearchWorkflowResult> {
    const clean = question.trim();
    if (!clean) throw new ResearchError("invalid_request", "A research question is required.");
    const limits = this.limits;
    const queries = generateQueries(clean, limits.maxQueries);
    const errors: ResearchWorkflowResult["errors"] = [];

    const searchOutcomes = await mapLimit(queries, limits.maxSearchConcurrency, async (query) => {
      try {
        return await this.search(query, context, { maxResults: limits.maxResultsPerQuery });
      } catch (error) {
        errors.push({ stage: "search", message: error instanceof Error ? error.message : String(error), url: undefined });
        return undefined;
      }
    });

    const discovered = searchOutcomes.flatMap((outcome) => outcome?.sources ?? []);
    const deduped = new Map<string, ResearchSourceRecord>();
    for (const source of discovered) {
      const existing = deduped.get(source.canonicalUrl);
      if (!existing || (source.score ?? 0) > (existing.score ?? 0)) deduped.set(source.canonicalUrl, source);
    }
    const ranked = [...deduped.values()]
      .map((source) => ({
        source,
        rank: relevance(clean, `${source.title} ${source.snippet}`) + Math.min(0.2, (source.score ?? 0) / 10),
      }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limits.maxPages)
      .map((item) => item.source);

    const fetched = await mapLimit(ranked, limits.maxFetchConcurrency, async (source) => {
      try {
        return await this.fetchPage(source.url, context);
      } catch (error) {
        errors.push({
          stage: "fetch",
          message: error instanceof Error ? error.message : String(error),
          url: source.url,
        });
        return undefined;
      }
    });

    const pages = fetched.filter((outcome): outcome is FetchOutcome => Boolean(outcome));
    // Fetched snapshots win over discovery-only records for the same canonical URL.
    const merged = new Map<string, ResearchSourceRecord>(deduped);
    for (const outcome of pages) merged.set(outcome.source.canonicalUrl, outcome.source);
    const resolvedSources = [...merged.values()].sort((a, b) => a.citationIndex - b.citationIndex);
    const conflictSources = pages.map((outcome) => ({
      id: outcome.source.id,
      title: outcome.source.title,
      content: outcome.source.content,
    }));
    const conflicts = detectConflicts(conflictSources);
    for (const conflict of conflicts) {
      this.emit({
        type: "conflict_detected",
        topic: conflict.topic,
        values: conflict.values,
        sourceIds: conflict.sourceIds,
      });
    }

    const findings: ResearchFinding[] = pages
      .map((outcome) => ({
        citationIndex: outcome.source.citationIndex,
        sourceId: outcome.source.id,
        title: outcome.source.title,
        url: outcome.source.url,
        evidence: evidenceFor(clean, outcome.extraction.text || outcome.source.content),
        relevance: relevance(clean, `${outcome.source.title} ${outcome.extraction.text || outcome.source.content}`),
      }))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, Math.max(1, limits.maxPages));

    const brief = buildBrief(clean, queries, resolvedSources, findings, conflicts, this.provider.isMock);
    this.emit({
      type: "research_completed",
      sources: resolvedSources.length,
      pages: pages.length,
      findings: findings.length,
    });

    return {
      question: clean,
      queries,
      provider: this.provider.id,
      isMock: this.provider.isMock,
      sources: resolvedSources,
      findings,
      conflicts,
      brief,
      pagesFetched: pages.length,
      errors,
    };
  }
}

const buildBrief = (
  question: string,
  queries: string[],
  sources: ResearchSourceRecord[],
  findings: ResearchFinding[],
  conflicts: ResearchConflict[],
  isMock: boolean,
): string => {
  const lines: string[] = [`# Research brief: ${question}`, ""];
  lines.push(`Sources: ${sources.length} discovered, ${findings.length} fetched and extracted.`);
  if (isMock) {
    lines.push("**Data source: deterministic local mock corpus. No internet search was performed.**");
  }
  lines.push(`Queries: ${queries.join(" · ")}`, "");
  lines.push("## Key findings");
  if (!findings.length) lines.push("- No page content could be extracted; report the gap rather than guessing.");
  for (const finding of findings) {
    lines.push(`- [citation:${finding.citationIndex}] ${finding.evidence} — ${finding.title} (${finding.url})`);
  }
  lines.push("", "## Sources");
  for (const source of sources) {
    const date = source.publishedAt ? ` · published ${source.publishedAt.slice(0, 10)}` : "";
    lines.push(`- [citation:${source.citationIndex}] ${source.title} — ${source.domain}${date} · retrieved ${source.retrievedAt}`);
  }
  if (conflicts.length) {
    lines.push("", "## Conflicts to verify");
    for (const conflict of conflicts) lines.push(`- ${conflict.note}`);
  }
  lines.push("");
  return lines.join("\n");
};
