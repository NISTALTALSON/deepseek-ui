import { create } from 'zustand'
import { API_ORIGIN } from './api/client.js'
import { useSettings } from './settings.js'

export type Project = {
  id: string
  owner: string
  name: string
  description: string
  instructions: string
  preferredModel?: string
  preferredAgent?: string
  memoryEnabled: boolean
  archived: boolean
  createdAt: string
  updatedAt: string
}

export type ProjectFile = {
  id: string
  projectId?: string
  originalName: string
  mimeType: string
  size: number
  extractionStatus: 'uploaded' | 'queued' | 'processing' | 'completed' | 'failed'
  extractionError?: string
  uploadedAt: string
}

export type ProjectConversation = {
  id: string
  title: string
  updatedAt: string
  model: string
}

type ProjectState = {
  projects: Project[]
  files: ProjectFile[]
  conversations: ProjectConversation[]
  selectedProjectId?: string
  loading: boolean
  error?: string
}

const workspaceHeaders = (): Record<string, string> => ({
  'x-deepseek-ui-workspace': 'local',
  ...(useSettings.getState().apiKey ? { 'x-api-key': useSettings.getState().apiKey as string } : {}),
})

const jsonRequest = async (url: string, init: RequestInit = {}) => {
  const response = await fetch(`${API_ORIGIN}${url}`, {
    ...init,
    headers: { ...workspaceHeaders(), 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!response.ok) {
    throw new Error((await response.text()) || response.statusText)
  }
  return response.json()
}

export const useProjects = create<ProjectState>(() => ({
  projects: [],
  files: [],
  conversations: [],
  loading: false,
}))

export const loadProjects = async () => {
  useProjects.setState({ loading: true, error: undefined })
  try {
    const body = await jsonRequest('/projects')
    useProjects.setState({ projects: body.projects ?? [], loading: false })
  } catch (error) {
    useProjects.setState({ loading: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export const selectProject = async (projectId?: string) => {
  useProjects.setState({ selectedProjectId: projectId })
  if (!projectId) {
    useProjects.setState({ files: [], conversations: [] })
    return
  }
  try {
    const [filesBody, conversationsBody] = await Promise.all([
      jsonRequest(`/projects/${encodeURIComponent(projectId)}/files`),
      jsonRequest(`/projects/${encodeURIComponent(projectId)}/conversations`),
    ])
    useProjects.setState({ files: filesBody.files ?? [], conversations: conversationsBody.conversations ?? [] })
  } catch (error) {
    useProjects.setState({ error: error instanceof Error ? error.message : String(error) })
  }
}

export const createProject = async (input: Pick<Project, 'name'> & Partial<Pick<Project, 'description' | 'instructions'>>) => {
  const body = await jsonRequest('/projects', { method: 'POST', body: JSON.stringify(input) })
  const project = body.project as Project
  useProjects.setState((state) => ({ projects: [project, ...state.projects], selectedProjectId: project.id }))
  return project
}

export const updateProject = async (id: string, patch: Partial<Project>) => {
  const body = await jsonRequest(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  useProjects.setState((state) => ({ projects: state.projects.map((project) => project.id === id ? body.project : project) }))
  return body.project as Project
}

export const archiveProject = (id: string, archived: boolean) => updateProject(id, { archived })

export const deleteProject = async (id: string) => {
  await jsonRequest(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
  useProjects.setState((state) => ({
    projects: state.projects.filter((project) => project.id !== id),
    selectedProjectId: state.selectedProjectId === id ? undefined : state.selectedProjectId,
    files: state.selectedProjectId === id ? [] : state.files,
  }))
}

export const uploadProjectFile = async (projectId: string, file: File) => {
  const response = await fetch(`${API_ORIGIN}/files`, {
    method: 'POST',
    headers: { ...workspaceHeaders(), 'x-project-id': projectId, 'x-file-name': file.name, 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!response.ok) {
    throw new Error((await response.text()) || response.statusText)
  }
  const body = await response.json() as { file: ProjectFile }
  useProjects.setState((state) => ({ files: [body.file, ...state.files] }))
  return body.file
}

export const deleteProjectFile = async (id: string) => {
  const response = await fetch(`${API_ORIGIN}/files/${encodeURIComponent(id)}`, { method: 'DELETE', headers: workspaceHeaders() })
  if (!response.ok) {
    throw new Error((await response.text()) || response.statusText)
  }
  useProjects.setState((state) => ({ files: state.files.filter((file) => file.id !== id) }))
}

export const openProjectFile = async (id: string, download = false) => {
  const response = await fetch(`${API_ORIGIN}/files/${encodeURIComponent(id)}/content`, { headers: workspaceHeaders() })
  if (!response.ok) {
    throw new Error((await response.text()) || response.statusText)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  if (download) {
    anchor.download = 'project-file'
    anchor.click()
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
