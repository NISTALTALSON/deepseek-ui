import { create } from 'zustand'
import { API_ORIGIN, request } from './api/client.js'
import { useSettings } from './settings.js'

export type Agent = {
  id: string
  owner: string
  name: string
  description: string
  avatar?: string
  instructions: string
  provider: 'deepseek' | 'mock'
  model: string
  parameters: Record<string, unknown>
  skillNames: string[]
  allowedTools: string[]
  projectIds: string[]
  memoryEnabled: boolean
  welcomeMessage: string
  examplePrompts: string[]
  enabled: boolean
  version: number
  versions: Array<{ version: number; savedAt: string; config: Record<string, unknown> }>
  createdAt: string
  updatedAt: string
}

type AgentState = {
  agents: Agent[]
  selectedAgentId?: string
  loading: boolean
  open: boolean
}

export const useAgents = create<AgentState>(() => ({
  agents: [],
  loading: false,
  open: false,
}))

const headers = () => ({
  'content-type': 'application/json',
  'x-deepseek-ui-workspace': 'local',
  ...(useSettings.getState().apiKey ? { 'x-api-key': useSettings.getState().apiKey ?? '' } : {}),
})

export const loadAgents = async () => {
  if (!useSettings.getState().apiKey) {
    useAgents.setState({ agents: [], loading: false })
    return
  }
  useAgents.setState({ loading: true })
  try {
    const response = await request(`${API_ORIGIN}/agents?includeDisabled=true`, { headers: headers() })
    const body = (await response.json()) as { agents?: Agent[] }
    useAgents.setState({ agents: body.agents ?? [] })
  } finally {
    useAgents.setState({ loading: false })
  }
}

export const createAgent = async (input: Partial<Agent> & Pick<Agent, 'name'>) => {
  const response = await request(`${API_ORIGIN}/agents`, { method: 'POST', headers: headers(), body: JSON.stringify(input) })
  const body = (await response.json()) as { agent: Agent }
  useAgents.setState((state) => ({ agents: [body.agent, ...state.agents] }))
  return body.agent
}

export const updateAgent = async (id: string, patch: Partial<Agent>) => {
  const response = await request(`${API_ORIGIN}/agents/${encodeURIComponent(id)}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(patch) })
  const body = (await response.json()) as { agent: Agent }
  useAgents.setState((state) => ({ agents: state.agents.map((agent) => agent.id === id ? body.agent : agent) }))
  return body.agent
}

export const deleteAgent = async (id: string) => {
  await request(`${API_ORIGIN}/agents/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() })
  useAgents.setState((state) => ({ agents: state.agents.filter((agent) => agent.id !== id), selectedAgentId: state.selectedAgentId === id ? undefined : state.selectedAgentId }))
}

export const selectAgent = (id?: string) => useAgents.setState({ selectedAgentId: id })
export const openAgents = () => useAgents.setState({ open: true })
export const closeAgents = () => useAgents.setState({ open: false })
