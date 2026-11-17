import { createHash } from "node:crypto";
import { domainOf, normalizeUrlForDedupe } from "../url-safety.js";
import {
  ResearchError,
  type ProviderLimits,
  type ProviderStatus,
  type SearchPage,
  type SearchProvider,
  type SearchRequest,
  type SearchResult,
} from "../types.js";

export interface TavilyOptions {
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
  maxResults?: number;
  /** Injectable transport for deterministic tests. */
  fetchImpl?: typeof fetch;
}

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
  published_date?: unknown;
}

/**
 * Real search adapter for Tavily. Requires TAVILY_API_KEY (or an explicit
 * apiKey). It is reported as unavailable when no key is configured; callers
 * must not silently substitute another provider.
 */
export class TavilySearchProvider implements SearchProvider {
  readonly id = "tavily";
  readonly displayName = "Tavily";
  readonly isMock = false;
  readonly requiresCredentials = true;
  readonly limits: ProviderLimits;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TavilyOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.TAVILY_API_KEY ?? "").trim();
    this.endpoint = options.endpoint ?? process.env.TAVILY_API_URL ?? "https://api.tavily.com/search";
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limits = {
      maxResults: options.maxResults ?? 10,
      maxQueryChars: 400,
      supportsPagination: false,
    };
  }

  status(): ProviderStatus {
    return {
      id: this.id,
      displayName: this.displayName,
      available: Boolean(this.apiKey),
      isMock: false,
      requiresCredentials: true,
      limits: this.limits,
      ...(this.apiKey ? {} : { reason: "TAVILY_API_KEY is not configured." }),
    };
  }

  async search({ query, signal, pageSize }: SearchRequest): Promise<SearchPage> {
    if (!this.apiKey) {
      throw new ResearchError("provider_unavailable", "Tavily is not configured; set TAVILY_API_KEY.", {
        provider: this.id,
      });
    }
    const text = query.text.trim();
    if (!text) throw new ResearchError("invalid_request", "A search query is required.");
    if (text.length > this.limits.maxQueryChars) {
      throw new ResearchError("invalid_request", "Search query is too long.", { max: this.limits.maxQueryChars });
    }
    const maxResults = Math.min(this.limits.maxResults, Math.max(1, pageSize ?? query.maxResults ?? 5));
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: text,
          max_results: maxResults,
          search_depth: "basic",
          include_answer: false,
          include_images: false,
          include_raw_content: false,
        }),
        signal: combined,
      });
    } catch (error) {
      if (combined.aborted) {
        throw new ResearchError("timeout", "Search provider timed out.", { provider: this.id, timeoutMs: this.timeoutMs });
      }
      throw new ResearchError("provider_error", "Search provider request failed.", {
        provider: this.id,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      // Never echo the request body or key; keep the provider's short message.
      const hint = raw.slice(0, 300).replace(/\s+/g, " ");
      throw new ResearchError("provider_error", `Search provider returned HTTP ${response.status}.`, {
        provider: this.id,
        status: response.status,
        hint: hint || undefined,
      });
    }
    if (raw.length > 1_000_000) {
      throw new ResearchError("provider_error", "Search provider response was too large.", { provider: this.id });
    }
    let parsed: { results?: unknown; response_time?: unknown };
    try {
      parsed = JSON.parse(raw) as { results?: unknown };
    } catch {
      throw new ResearchError("provider_error", "Search provider returned invalid JSON.", { provider: this.id });
    }
    const items = Array.isArray(parsed.results) ? (parsed.results as TavilyResult[]) : [];
    const results: SearchResult[] = items.flatMap((item): SearchResult[] => {
      if (typeof item.url !== "string" || typeof item.title !== "string") return [];
      let url: string;
      try {
        url = new URL(item.url).toString();
      } catch {
        return [];
      }
      const published = typeof item.published_date === "string" && Number.isFinite(Date.parse(item.published_date))
        ? new Date(item.published_date).toISOString()
        : undefined;
      return [{
        id: `tavily_${createHash("sha256").update(normalizeUrlForDedupe(url)).digest("hex").slice(0, 16)}`,
        title: item.title.slice(0, 500),
        url,
        snippet: typeof item.content === "string" ? item.content.slice(0, 2000) : "",
        domain: domainOf(url),
        publishedAt: published,
        provider: this.id,
        isMock: false,
        score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : undefined,
      }];
    });
    return {
      provider: this.id,
      isMock: false,
      query: text,
      results: results.slice(0, maxResults),
      totalResults: results.length,
      hasMore: false,
    };
  }
}
