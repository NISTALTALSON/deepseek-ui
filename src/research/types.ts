// Provider-independent web research contracts.
//
// These types are intentionally free of any provider, transport, or storage
// dependency: a search adapter implements SearchProvider, the safe fetcher
// returns FetchedPage, and the orchestrator persists ResearchSourceRecord
// snapshots through a caller-supplied store. Retrieved page content is always
// treated as untrusted data.

export type SearchProviderId = string;

export interface SearchQuery {
  text: string;
  /** Optional cap requested by the caller; clamped by provider limits. */
  maxResults?: number;
}

export interface ProviderLimits {
  maxResults: number;
  maxQueryChars: number;
  /** Providers that support paging return a nextPage cursor. */
  supportsPagination: boolean;
}

export interface ProviderStatus {
  id: string;
  displayName: string;
  available: boolean;
  isMock: boolean;
  requiresCredentials: boolean;
  limits: ProviderLimits;
  reason?: string;
}

export interface SearchResult {
  /** Provider-stable result id; used for de-duplication and source snapshots. */
  id: string;
  title: string;
  url: string;
  snippet: string;
  domain: string;
  /** RFC 3339 publication date when the provider reports one. */
  publishedAt?: string;
  provider: string;
  isMock: boolean;
  score?: number;
  /** Non-sensitive provider metadata only. */
  metadata?: Record<string, unknown>;
}

export interface SearchPage {
  provider: string;
  isMock: boolean;
  query: string;
  results: SearchResult[];
  totalResults?: number;
  hasMore: boolean;
  /** Opaque cursor for the next page; only when the provider supports paging. */
  nextPage?: string;
}

export interface SearchRequest {
  query: SearchQuery;
  signal?: AbortSignal;
  pageSize?: number;
  cursor?: string;
}

export interface SearchProvider {
  readonly id: SearchProviderId;
  readonly displayName: string;
  readonly isMock: boolean;
  readonly requiresCredentials: boolean;
  readonly limits: ProviderLimits;
  status(): ProviderStatus;
  search(request: SearchRequest): Promise<SearchPage>;
}

export type ResearchErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "credentials_in_url"
  | "blocked_host"
  | "blocked_port"
  | "private_address"
  | "dns_failure"
  | "dns_rebinding"
  | "too_many_redirects"
  | "unsafe_redirect"
  | "response_too_large"
  | "unsupported_content_type"
  | "timeout"
  | "network_error"
  | "http_error"
  | "robots_disallowed"
  | "provider_unavailable"
  | "provider_error"
  | "invalid_request"
  | "fetch_failed"
  | "extraction_failed";

export class ResearchError extends Error {
  constructor(
    readonly code: ResearchErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ResearchError";
  }
}

export interface FetchedPage {
  /** URL that was requested after validation. */
  url: string;
  /** URL of the final response after redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  charset: string;
  body: string;
  byteLength: number;
  retrievedAt: string;
  redirects: string[];
}

export interface PageExtraction {
  ok: boolean;
  title: string;
  siteName?: string;
  description?: string;
  canonicalUrl?: string;
  publishedAt?: string;
  /** Plain text only; remote markup and scripts are never returned. */
  text: string;
  excerpt: string;
  /** Characters of usable body text after sanitization. */
  contentLength: number;
  error?: string;
}

export interface ExtractedPage {
  page: FetchedPage;
  extraction: PageExtraction;
}

export type ResearchSourceStatus = "search" | "fetched" | "extracted" | "error";

/**
 * Persisted snapshot of one discovered source. Content is bounded plain text.
 * `citationIndex` is stable for the run/conversation that produced it.
 */
export interface ResearchSourceRecord {
  id: string;
  owner: string;
  conversationId: string;
  runId?: string;
  query?: string;
  title: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  snippet: string;
  /** RFC 3339 timestamp of the retrieval that produced this snapshot. */
  retrievedAt: string;
  publishedAt?: string;
  excerpt: string;
  content: string;
  provider: string;
  isMock: boolean;
  status: ResearchSourceStatus;
  error?: string;
  /** Provider relevance score when available. */
  score?: number;
  /** Ordering within the research run, used for [citation:N] markers. */
  citationIndex: number;
  metadata: Record<string, unknown>;
}

export interface ResearchSourceStore {
  saveSource(record: ResearchSourceRecord): Promise<ResearchSourceRecord>;
  listSources(owner: string, conversationId: string): Promise<ResearchSourceRecord[]>;
  getSource(id: string, owner: string): Promise<ResearchSourceRecord | undefined>;
}

export interface ResearchRunContext {
  owner: string;
  conversationId: string;
  runId?: string;
  /** Bounds every network call made for this context. */
  signal?: AbortSignal;
}

export type ResearchActivity =
  | { type: "search_started"; query: string; provider: string; isMock: boolean }
  | { type: "search_completed"; query: string; provider: string; found: number; isMock: boolean }
  | { type: "search_failed"; query: string; provider: string; error: string }
  | { type: "deduplicated"; kept: number; removed: number }
  | { type: "fetch_started"; url: string }
  | { type: "fetch_completed"; url: string; status: number; bytes: number }
  | { type: "fetch_failed"; url: string; error: string }
  | { type: "extraction_completed"; url: string; title: string; chars: number }
  | { type: "extraction_failed"; url: string; error: string }
  | { type: "conflict_detected"; topic: string; values: string[]; sourceIds: string[] }
  | { type: "research_completed"; sources: number; pages: number; findings: number };

export type ResearchActivityListener = (activity: ResearchActivity) => void;

export interface ResearchLimits {
  maxResultsPerQuery: number;
  maxQueries: number;
  maxPages: number;
  maxFetchConcurrency: number;
  maxSearchConcurrency: number;
  maxSourceChars: number;
  maxExcerptChars: number;
  fetchTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
}

export const defaultResearchLimits: ResearchLimits = {
  maxResultsPerQuery: 8,
  maxQueries: 4,
  maxPages: 5,
  maxFetchConcurrency: 3,
  maxSearchConcurrency: 2,
  maxSourceChars: 20_000,
  maxExcerptChars: 600,
  fetchTimeoutMs: 15_000,
  maxResponseBytes: 2_000_000,
  maxRedirects: 4,
};

export interface ResearchConflict {
  topic: string;
  values: string[];
  sourceIds: string[];
  note: string;
}

export interface ResearchFinding {
  /** Citation index the finding refers to. */
  citationIndex: number;
  sourceId: string;
  title: string;
  url: string;
  /** Short evidence quote/summary taken from the extracted page. */
  evidence: string;
  relevance: number;
}

export interface ResearchWorkflowResult {
  question: string;
  queries: string[];
  provider: string;
  isMock: boolean;
  sources: ResearchSourceRecord[];
  findings: ResearchFinding[];
  conflicts: ResearchConflict[];
  brief: string;
  pagesFetched: number;
  errors: Array<{ stage: string; message: string; url?: string }>;
}

export interface ResearchToolError {
  ok: false;
  error: { code: ResearchErrorCode | "unavailable"; message: string; details?: Record<string, unknown> };
}

export interface ResearchToolSearchResult {
  ok: true;
  query: string;
  provider: string;
  isMock: boolean;
  notice: string;
  results: Array<{
    citationIndex: number;
    sourceId: string;
    title: string;
    url: string;
    domain: string;
    snippet: string;
    publishedAt: string | null;
    retrievedAt: string;
  }>;
}
