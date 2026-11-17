import { API_ORIGIN, request } from './api/client.js'

export type ArtifactKind = 'markdown' | 'code' | 'html' | 'mermaid' | 'json' | 'data' | 'text'
export type ArtifactVersion = {
  id: string
  version: number
  content: string
  mimeType: string
  createdAt: string
  createdBy: 'user' | 'assistant' | 'system'
  changeSummary?: string
}
export type Artifact = {
  id: string
  owner: string
  conversationId?: string
  projectId?: string
  name: string
  kind: ArtifactKind
  language?: string
  mimeType: string
  currentVersion: number
  versions: ArtifactVersion[]
  createdAt: string
  updatedAt: string
  metadata: Record<string, unknown>
}

const headers = { 'content-type': 'application/json' }

export const listArtifacts = async (conversationId: string, signal?: AbortSignal): Promise<Artifact[]> => {
  const response = await request(`${API_ORIGIN}/artifacts?conversationId=${encodeURIComponent(conversationId)}`, {
    method: 'GET',
    signal,
  })
  return ((await response.json()) as { artifacts?: Artifact[] }).artifacts ?? []
}

export const updateArtifact = async (
  artifact: Artifact,
  content: string,
  signal?: AbortSignal
): Promise<Artifact> => {
  const response = await request(`${API_ORIGIN}/artifacts/${encodeURIComponent(artifact.id)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ content, changeSummary: 'Edited in workspace' }),
    signal,
  })
  return (await response.json() as { artifact: Artifact }).artifact
}

export const restoreArtifact = async (
  artifact: Artifact,
  version: number,
  signal?: AbortSignal
): Promise<Artifact> => {
  const response = await request(`${API_ORIGIN}/artifacts/${encodeURIComponent(artifact.id)}/versions/${version}/restore`, {
    method: 'POST',
    signal,
  })
  return (await response.json() as { artifact: Artifact }).artifact
}

export const artifactDownloadUrl = (artifact: Artifact): string =>
  `${API_ORIGIN}/artifacts/${encodeURIComponent(artifact.id)}/download`
