import { createHash } from "node:crypto";
import { mockPages, type MockPage } from "../fixtures.js";
import { domainOf, normalizeUrlForDedupe } from "../url-safety.js";
import { tokenize } from "../text.js";
import { ResearchError, type ProviderLimits, type ProviderStatus, type SearchPage, type SearchProvider, type SearchRequest, type SearchResult } from "../types.js";

/**
 * Deterministic offline provider. It never touches the network and every
 * consumer must surface `isMock` so a mock search is never presented as a live
 * internet result.
 */
export class LocalMockSearchProvider implements SearchProvider {
  readonly id = "local-mock";
  readonly displayName = "Local mock corpus";
  readonly isMock = true;
  readonly requiresCredentials = false;
  readonly limits: ProviderLimits;

  private readonly pages: MockPage[];

  constructor(options: { pages?: MockPage[]; maxResults?: number } = {}) {
    this.pages = options.pages ?? mockPages;
    this.limits = {
      maxResults: options.maxResults ?? 8,
      maxQueryChars: 400,
      supportsPagination: true,
    };
  }

  status(): ProviderStatus {
    return {
      id: this.id,
      displayName: this.displayName,
      available: true,
      isMock: true,
      requiresCredentials: false,
      limits: this.limits,
      reason: "Deterministic local fixtures; no internet access is used.",
    };
  }

  async search({ query, signal, pageSize, cursor }: SearchRequest): Promise<SearchPage> {
    if (signal?.aborted) throw new ResearchError("provider_error", "Search was cancelled.");
    const text = query.text.trim();
    if (!text) throw new ResearchError("invalid_request", "A search query is required.");
    if (text.length > this.limits.maxQueryChars) {
      throw new ResearchError("invalid_request", "Search query is too long.", { max: this.limits.maxQueryChars });
    }
    const tokens = tokenize(text);
    const scored = this.pages
      .map((page) => ({ page, score: scorePage(tokens, page) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.page.url.localeCompare(b.page.url));

    const size = Math.min(this.limits.maxResults, Math.max(1, pageSize ?? this.limits.maxResults));
    const offset = Math.max(0, Number(cursor ?? 0) || 0);
    const slice = scored.slice(offset, offset + size);
    const results: SearchResult[] = slice.map(({ page: item, score }) => ({
      id: `mock_${createHash("sha256").update(normalizeUrlForDedupe(item.url)).digest("hex").slice(0, 16)}`,
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      domain: domainOf(item.url),
      publishedAt: item.publishedAt,
      provider: this.id,
      isMock: true,
      score,
      metadata: { siteName: item.siteName, fixture: true },
    }));
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < scored.length;
    return {
      provider: this.id,
      isMock: true,
      query: text,
      results,
      totalResults: scored.length,
      hasMore,
      ...(hasMore ? { nextPage: String(nextOffset) } : {}),
    };
  }
}

const scorePage = (tokens: string[], page: MockPage): number => {
  if (!tokens.length) return 0;
  const title = page.title.toLowerCase();
  const keywords = page.keywords.map((keyword) => keyword.toLowerCase());
  const body = `${page.snippet} ${page.keywords.join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 3;
    if (keywords.some((keyword) => keyword.includes(token) || token.includes(keyword))) score += 2;
    if (body.includes(token)) score += 1;
  }
  return score;
};
