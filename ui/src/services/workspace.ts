import { create } from 'zustand'
import type { ChatModel } from './api/types.js'
import { setModel } from './settings.js'
import { useSettings } from './settings.js'
import { API_ORIGIN } from './api/client.js'

export type WorkspaceTab = 'models' | 'skills' | 'tools' | 'plugins' | 'mcp' | 'connectors'
export type IntegrationKind = 'plugin' | 'connector' | 'mcp'

export type ModelOption = {
  id: ChatModel
  name: string
  description: string
  badge: string
}

export type Integration = {
  id: string
  name: string
  description: string
  kind: IntegrationKind
  enabled: boolean
  status: 'connected' | 'available'
  detail?: string
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    description: 'Fast everyday answers with thinking and web search.',
    badge: 'Fast',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    description: 'More capable reasoning for complex work and long context.',
    badge: 'Pro',
  },
  {
    id: 'mock',
    name: 'Local mock',
    description: 'Deterministic local responses for setup, demos, and automated testing.',
    badge: 'Offline',
  },
]



const read = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

const readJson = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(read(key, JSON.stringify(fallback))) as T
  } catch {
    return fallback
  }
}

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Preferences remain active for this session when storage is unavailable.
  }
}

type WorkspaceState = {
  model: ChatModel
  enabledSkills: string[]
  integrations: Integration[]
  open: boolean
  tab: WorkspaceTab
  gatewayOnline: boolean
  gatewaySkills: string[]
  gatewayTools: Array<{ name: string; description: string; readOnly?: boolean }>
}

export const useWorkspace = create<WorkspaceState>(() => ({
  model: read('deepseek-ui:model', read('chat-demo:model', 'deepseek-flash')) as ChatModel,
  enabledSkills: readJson('deepseek-ui:skills', []),
  integrations: readJson('deepseek-ui:integrations', []),
  open: false,
  tab: 'models',
  gatewayOnline: false,
  gatewaySkills: [],
  gatewayTools: [],
}))

export const openWorkspace = (tab: WorkspaceTab = 'models') =>
  useWorkspace.setState({ open: true, tab })

export const closeWorkspace = () => useWorkspace.setState({ open: false })

export const setWorkspaceTab = (tab: WorkspaceTab) => useWorkspace.setState({ tab })

export const setWorkspaceModel = (model: ChatModel) => {
  write('deepseek-ui:model', model)
  setModel(model)
  useWorkspace.setState({ model })
}

export const toggleSkill = (skill: string) => {
  const current = useWorkspace.getState().enabledSkills
  const enabledSkills = current.includes(skill)
    ? current.filter((item) => item !== skill)
    : [...current, skill]
  write('deepseek-ui:skills', enabledSkills)
  useWorkspace.setState({ enabledSkills })
}

export const toggleIntegration = (id: string) => {
  const integrations = useWorkspace
    .getState()
    .integrations.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item))
  write('deepseek-ui:integrations', integrations)
  useWorkspace.setState({ integrations })
}

export const addIntegration = (integration: Integration) => {
  const integrations = [...useWorkspace.getState().integrations, integration]
  write('deepseek-ui:integrations', integrations)
  useWorkspace.setState({ integrations })
}

export const availableSkills = () => useWorkspace.getState().gatewaySkills

export const refreshGatewayCapabilities = async () => {
  try {
    const apiKey = useSettings.getState().apiKey
    const response = await fetch(`${API_ORIGIN}/capabilities`, {
      headers: apiKey ? { 'x-api-key': apiKey } : undefined,
    })
    if (!response.ok) {
      return
    }
    const data = (await response.json()) as {
      skills?: string[]
      mcpServers?: string[]
      toolsList?: Array<{ name: string; description: string; readOnly?: boolean }>
    }
    const current = useWorkspace.getState().integrations.filter((item) => item.kind === 'mcp' && item.status === 'connected')
    const integrations = [...current]
    for (const server of data.mcpServers ?? []) {
      const existing = integrations.find((item) => item.id === server)
      if (existing) {
        existing.status = 'connected'
        existing.detail = 'Connected to the gateway'
      } else {
        integrations.push({
          id: server,
          name: server,
          description: `Tools provided by the ${server} MCP server.`,
          kind: 'mcp',
          enabled: false,
          status: 'connected',
          detail: 'Connected to the gateway',
        })
      }
    }
    write('deepseek-ui:integrations', integrations)
    useWorkspace.setState({
      gatewayOnline: true,
      gatewaySkills: data.skills ?? [],
      gatewayTools: data.toolsList ?? [],
      integrations,
    })
  } catch {
    useWorkspace.setState({ gatewayOnline: false })
  }
}
