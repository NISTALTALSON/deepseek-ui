import { API_ORIGIN, request } from './api/client.js'

/** Research gateway contracts mirrored from the local server. */

export type ResearchProviderStatus = {
  id: string
  displayName: string
  available: boolean
  isMock: boolean
  requiresCredentials: boolean
  limits: { maxResults: number; maxQueryChars: number; supportsPagination: boolean; maxPages?: number }
  reason?: string
}

export type ResearchStatus = {
  provider: string
  displayName: string
  available: boolean
  isMock: boolean
  requiresCredentials: boolean
  note: string
  degraded: boolean
  limits: ResearchProviderStatus['limits'] & { maxSourceChars?: number }
  providers: ResearchProviderStatus[]
  tools: string[]
  security: {
    allowedProtocols: string[]
    allowedPorts: number[]
    blocksPrivateAddresses: boolean
    pinsDnsAnswers: boolean
    revalidatesRedirects: boolean
    maxResponseBytes: number
    fetchTimeoutMs: number
    executesPageScripts: boolean
    respectsRobotsTxt: boolean
  }
}

export type ResearchSourceView = {
  sourceId: string
  citationIndex: number
  title: string
  url: string
  domain: string
  snippet: string
  excerpt: string
  publishedAt: string | null
  retrievedAt: string
  provider: string
  isMock: boolean
  status: 'search' | 'fetched' | 'extracted' | 'error'
  error: string | null
  score: number | null
  content?: string
  metadata?: Record<string, unknown>
}

const headers = (apiKey: string, json = false): Record<string, string> => ({
  ...(json ? { 'content-type': 'application/json' } : {}),
  ...(apiKey ? { 'x-api-key': apiKey } : {}),
  'x-deepseek-ui-workspace': 'local',
})

export const getResearchStatus = async (apiKey: string, signal?: AbortSignal): Promise<ResearchStatus> => {
  const response = await request(`${API_ORIGIN}/research/status`, { method: 'GET', headers: headers(apiKey), signal })
  return (await response.json()) as ResearchStatus
}

export const listResearchSources = async (
  apiKey: string,
  conversationId: string,
  signal?: AbortSignal
): Promise<ResearchSourceView[]> => {
  const response = await request(
    `${API_ORIGIN}/research/sources?conversationId=${encodeURIComponent(conversationId)}`,
    { method: 'GET', headers: headers(apiKey), signal }
  )
  const body = (await response.json()) as { sources?: ResearchSourceView[] }
  return body.sources ?? []
}

export const getResearchSource = async (
  apiKey: string,
  sourceId: string,
  signal?: AbortSignal
): Promise<ResearchSourceView> => {
  const response = await request(`${API_ORIGIN}/research/sources/${encodeURIComponent(sourceId)}`, {
    method: 'GET',
    headers: headers(apiKey),
    signal,
  })
  return ((await response.json()) as { source: ResearchSourceView }).source
}

export const searchResearch = async (
  apiKey: string,
  conversationId: string,
  query: string,
  signal?: AbortSignal
): Promise<{ provider: string; isMock: boolean; sources: ResearchSourceView[] }> => {
  const response = await request(`${API_ORIGIN}/research/search`, {
    method: 'POST',
    headers: headers(apiKey, true),
    body: JSON.stringify({ conversationId, query }),
    signal,
  })
  return (await response.json()) as { provider: string; isMock: boolean; sources: ResearchSourceView[] }
}
