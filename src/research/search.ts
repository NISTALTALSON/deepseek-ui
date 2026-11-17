import { LocalMockSearchProvider } from "./providers/mock.js";
import { TavilySearchProvider, type TavilyOptions } from "./providers/tavily.js";
import type { ProviderStatus, SearchProvider } from "./types.js";

export type SearchProviderSelection = "auto" | "mock" | "tavily";

export interface SearchProviderSettings {
  provider?: SearchProviderSelection;
  /** Explicit key; falls back to TAVILY_API_KEY. */
  apiKey?: string;
  maxResults?: number;
  tavily?: TavilyOptions;
}

export interface SearchProviderResolution {
  provider: SearchProvider;
  selection: SearchProviderSelection;
  /** True when a real provider was requested but is not configured. */
  degraded: boolean;
  statuses: ProviderStatus[];
  note: string;
}

export const createSearchProviders = (settings: SearchProviderSettings = {}): SearchProvider[] => {
  const tavilyKey = settings.apiKey ?? process.env.TAVILY_API_KEY;
  return [
    new TavilySearchProvider({ ...settings.tavily, apiKey: tavilyKey, maxResults: settings.maxResults }),
    new LocalMockSearchProvider({ maxResults: settings.maxResults }),
  ];
};

/**
 * Resolves the configured provider. `auto` prefers a configured real provider
 * and falls back to the deterministic local corpus, reporting that fallback so
 * the UI can label mock results honestly.
 */
export const resolveSearchProvider = (settings: SearchProviderSettings = {}): SearchProviderResolution => {
  const providers = createSearchProviders(settings);
  const tavily = providers.find((provider) => provider.id === "tavily")!;
  const mock = providers.find((provider) => provider.id === "local-mock")!;
  const requested = settings.provider ?? (process.env.RESEARCH_PROVIDER as SearchProviderSelection | undefined) ?? "auto";
  const statuses = providers.map((provider) => provider.status());

  if (requested === "mock") {
    return {
      provider: mock,
      selection: "mock",
      degraded: false,
      statuses,
      note: "Using deterministic local fixtures; no internet search is performed.",
    };
  }
  if (requested === "tavily") {
    if (!tavily.status().available) {
      return {
        provider: tavily,
        selection: "tavily",
        degraded: true,
        statuses,
        note: "Tavily was selected but is not configured; web_search will report provider_unavailable.",
      };
    }
    return { provider: tavily, selection: "tavily", degraded: false, statuses, note: "Using Tavily live search." };
  }
  if (tavily.status().available) {
    return { provider: tavily, selection: "auto", degraded: false, statuses, note: "Using Tavily live search (auto)." };
  }
  return {
    provider: mock,
    selection: "auto",
    degraded: false,
    statuses,
    note: "No search credentials configured; using deterministic local fixtures.",
  };
};
