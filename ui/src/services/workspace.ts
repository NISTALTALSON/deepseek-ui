import { create } from 'zustand'
import type { ChatModel } from './api/types.js'
import { setModel } from './settings.js'
import { useSettings } from './settings.js'
import { API_ORIGIN, listConnectors } from './api/client.js'

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
  status: 'connected' | 'available' | 'not_connected' | 'awaiting_authorization' | 'disconnected' | 'error'
  detail?: string
  version?: string
}

export type SkillInfo = { name: string; description: string; version?: string; scope?: string }

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: 'deepseek-flash',
    name: 'Emily',
    description: 'Your everyday assistant, connected to the active model endpoint.',
    badge: 'Default',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'Emily · Reasoning',
    description: 'A deeper reasoning profile for research, planning, and complex work.',
    badge: 'Reasoning',
  },
  {
    id: 'mock',
    name: 'Emily Sandbox',
    description: 'A local demo profile for setup and offline exploration.',
    badge: 'Local',
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
  gatewaySkillInfo: SkillInfo[]
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
  gatewaySkillInfo: [],
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
  const current = useWorkspace.getState().integrations
  const target = current.find((item) => item.id === id)
  const integrations = current.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item))
  write('deepseek-ui:integrations', integrations)
  useWorkspace.setState({ integrations })
  if (target && /^[0-9a-f-]{20,}$/i.test(id)) {
    void fetch(`${API_ORIGIN}/integrations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-deepseek-ui-workspace': 'local' },
      body: JSON.stringify({ enabled: !target.enabled }),
    }).catch(() => undefined)
  }
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
      skills?: Array<SkillInfo | string>
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
      gatewaySkills: (data.skills ?? []).map((skill) => typeof skill === 'string' ? skill : skill.name),
      gatewaySkillInfo: (data.skills ?? []).map((skill) => typeof skill === 'string' ? { name: skill, description: '' } : skill),
      gatewayTools: data.toolsList ?? [],
      integrations,
    })
    const integrationsResponse = await fetch(`${API_ORIGIN}/integrations`, {
      headers: { 'x-deepseek-ui-workspace': 'local', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    })
    if (integrationsResponse.ok) {
      const body = await integrationsResponse.json() as { integrations?: Array<Integration & { id: string }> }
      useWorkspace.setState({ integrations: [...integrations, ...(body.integrations ?? []).filter((item) => !integrations.some((current) => current.id === item.id))] })
    }
    const connectorResponse = await listConnectors()
    const connectorIntegrations = connectorResponse.map((connector) => ({
      id: connector.integrationId ?? `connector:${connector.id}`,
      name: connector.displayName,
      description: connector.description,
      kind: 'connector' as const,
      enabled: connector.enabled,
      status: connector.status as Integration['status'],
      detail: connector.operations.length ? `${connector.operations.length} capabilities available` : 'Provider setup pending',
    }))
    const merged = [...useWorkspace.getState().integrations.filter((item) => item.kind !== 'connector')]
    for (const connector of connectorIntegrations) {
      merged.push(connector)
    }
    write('deepseek-ui:integrations', merged)
    useWorkspace.setState({ integrations: merged })
  } catch {
    useWorkspace.setState({ gatewayOnline: false })
  }
}
