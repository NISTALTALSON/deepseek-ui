import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { API_ORIGIN, request } from '../../services/api/client.js'
import { useSettings } from '../../services/settings.js'
import { createAgent, deleteAgent, closeAgents, loadAgents, selectAgent, updateAgent, useAgents, type Agent } from '../../services/agents.js'
import { useWorkspace } from '../../services/workspace.js'
import styles from '../workspace/WorkspaceDialog.module.css'

type Tool = { name: string; description: string }

const blank = (): Partial<Agent> & { name: string } => ({
  name: '', description: '', instructions: '', provider: 'mock', model: 'mock',
  skillNames: [], allowedTools: [], projectIds: [], memoryEnabled: true,
  welcomeMessage: '', examplePrompts: [], enabled: true,
})

export const AgentBuilder = () => {
  const open = useAgents((state) => state.open)
  if (!open) { return null }
  return <AgentBuilderContent />
}

const AgentBuilderContent = () => {
  const agents = useAgents((state) => state.agents)
  const selectedAgentId = useAgents((state) => state.selectedAgentId)
  const skills = useWorkspace((state) => state.gatewaySkills)
  const [draft, setDraft] = useState<Partial<Agent> & { name: string }>(blank())
  const [tools, setTools] = useState<Tool[]>([])
  const [busy, setBusy] = useState(false)
  const selected = useMemo(() => agents.find((agent) => agent.id === selectedAgentId), [agents, selectedAgentId])

  useEffect(() => {
    void loadAgents()
    const apiKey = useSettings.getState().apiKey
    void request(`${API_ORIGIN}/capabilities`, {
      headers: { ...(apiKey ? { 'x-api-key': apiKey } : {}), 'x-deepseek-ui-workspace': 'local' },
    }).then(async (response) => {
      const body = await response.json() as { toolsList?: Tool[] }
      setTools(body.toolsList ?? [])
    }).catch(() => setTools([]))
  }, [])

  useEffect(() => {
    setDraft(selected ? { ...selected } : blank())
  }, [selected])

  const setField = <K extends keyof Agent>(key: K, value: Agent[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const save = async () => {
    if (!draft.name?.trim()) { return }
    setBusy(true)
    try {
      if (selected) {
        await updateAgent(selected.id, { ...draft, name: draft.name.trim() })
      } else {
        const created = await createAgent({ ...draft, name: draft.name.trim() })
        selectAgent(created.id)
      }
    } finally {
      setBusy(false)
    }
  }
  const duplicate = async () => {
    if (!selected) { return }
    setBusy(true)
    try {
      const created = await createAgent({ ...selected, id: undefined, name: `${selected.name} copy`, version: undefined, versions: undefined, createdAt: undefined, updatedAt: undefined })
      selectAgent(created.id)
    } finally {
      setBusy(false)
    }
  }
  const exportAgent = () => {
    if (!selected) { return }
    const blob = new Blob([JSON.stringify(selected, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${selected.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'agent'}.json`
    link.click()
    URL.revokeObjectURL(url)
  }
  const importAgent = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) { return }
    const imported = JSON.parse(await file.text()) as Partial<Agent> & { name?: string }
    if (!imported.name?.trim()) { return }
    const created = await createAgent({ ...imported, id: undefined, name: `${imported.name} imported`, version: undefined, versions: undefined, createdAt: undefined, updatedAt: undefined })
    selectAgent(created.id)
  }

  return (
    <Modal title="Agents" closable className={styles.dialog} mainClassName={styles.main} onClose={closeAgents}>
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarTop}>
            <strong>My agents</strong>
            <Button size="s" variant="primary" onClick={() => { selectAgent(undefined); setDraft(blank()) }}>New</Button>
          </div>
          {agents.map((agent) => (
            <button type="button" key={agent.id} className={`${styles.project} ${agent.id === selectedAgentId ? styles.selected : ''}`} onClick={() => selectAgent(agent.id)}>
              <strong>{agent.avatar || '✦'} {agent.name}</strong>
              <span>{agent.description || 'No description'}{agent.enabled ? '' : ' · disabled'}</span>
            </button>
          ))}
          {!agents.length ? <div className={styles.empty}>Create an agent to give the runtime a reusable identity, model, skills, and tool policy.</div> : null}
        </aside>
        <section className={styles.editor}>
          <div className={styles.editorHeader}>
            <div><h2>{selected ? 'Edit agent' : 'Create agent'}</h2><p>Backend policy remains authoritative for every tool call.</p></div>
            {selected ? <Button size="s" variant="outlined" onClick={() => void duplicate()}>Duplicate</Button> : null}
            {selected ? <Button size="s" variant="outlined" onClick={exportAgent}>Export</Button> : null}
            <label className={styles.tab}><input hidden type="file" accept="application/json" onChange={(event) => void importAgent(event)} />Import</label>
          </div>
          <label>Name<input value={draft.name ?? ''} onChange={(event) => setField('name', event.target.value)} /></label>
          <label>Description<textarea rows={2} value={draft.description ?? ''} onChange={(event) => setField('description', event.target.value)} /></label>
          <label>System instructions<textarea rows={5} value={draft.instructions ?? ''} onChange={(event) => setField('instructions', event.target.value)} /></label>
          <div className={styles.cards}>
            <label>Provider<select value={draft.provider ?? 'mock'} onChange={(event) => setField('provider', event.target.value as Agent['provider'])}><option value="mock">Emily Sandbox</option><option value="deepseek">Hosted model</option></select></label>
            <label>Model<input value={draft.model ?? ''} onChange={(event) => setField('model', event.target.value)} /></label>
          </div>
          <label>Welcome message<textarea rows={2} value={draft.welcomeMessage ?? ''} onChange={(event) => setField('welcomeMessage', event.target.value)} /></label>
          <label className={styles.card}><input type="checkbox" checked={draft.enabled !== false} onChange={(event) => setField('enabled', event.target.checked)} /> Enabled</label>
          <h3>Skills</h3>
          <div className={styles.cards}>{skills.map((skill) => <label className={styles.card} key={skill}><input type="checkbox" checked={draft.skillNames?.includes(skill) ?? false} onChange={(event) => setField('skillNames', event.target.checked ? [...(draft.skillNames ?? []), skill] : (draft.skillNames ?? []).filter((item) => item !== skill))} /> {skill}</label>)}</div>
          <h3>Allowed tools</h3>
          <div className={styles.cards}>{tools.map((tool) => <label className={styles.card} key={tool.name}><input type="checkbox" checked={draft.allowedTools?.includes(tool.name) ?? false} onChange={(event) => setField('allowedTools', event.target.checked ? [...(draft.allowedTools ?? []), tool.name] : (draft.allowedTools ?? []).filter((item) => item !== tool.name))} /> <span>{tool.name}<small>{tool.description}</small></span></label>)}</div>
          <div className={styles.actions}>
            <Button size="m" variant="primary" disabled={busy || !draft.name?.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save agent'}</Button>
            {selected ? <Button size="m" variant="outlined" onClick={() => { selectAgent(selected.id); closeAgents() }}>Test in chat</Button> : null}
            {selected ? <Button size="m" variant="danger" onClick={() => void deleteAgent(selected.id)}>Delete</Button> : null}
          </div>
          {selected?.versions.length ? <small>Version {selected.version}. Previous versions: {selected.versions.map((item) => item.version).join(', ')}</small> : null}
        </section>
      </div>
    </Modal>
  )
}
