import { useEffect } from 'react'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import {
  closeWorkspace,
  MODEL_OPTIONS,
  setWorkspaceModel,
  toggleIntegration,
  toggleSkill,
  useWorkspace,
  refreshGatewayCapabilities,
  type WorkspaceTab,
} from '../../services/workspace.js'
import styles from './WorkspaceDialog.module.css'

const tabs: { id: WorkspaceTab; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'skills', label: 'Skills' },
  { id: 'tools', label: 'Tools' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'connectors', label: 'Connectors' },
]

export const WorkspaceDialog = () => {
  const open = useWorkspace((state) => state.open)
  if (!open) {
    return null
  }
  return <WorkspaceContent />
}

const WorkspaceContent = () => {
  const tab = useWorkspace((state) => state.tab)
  useEffect(() => {
    void refreshGatewayCapabilities()
  }, [])
  return (
    <Modal
      title="Workspace"
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={closeWorkspace}
    >
      <nav className={styles.tabs} aria-label="Workspace sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
            type="button"
            aria-selected={tab === item.id}
            onClick={() => useWorkspace.setState({ tab: item.id })}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className={styles.panel}>
        {tab === 'models' ? <ModelsPanel /> : null}
        {tab === 'skills' ? <SkillsPanel /> : null}
        {tab === 'tools' ? <ToolsPanel /> : null}
        {tab === 'plugins' ? <IntegrationPanel kind="plugin" /> : null}
        {tab === 'mcp' ? <IntegrationPanel kind="mcp" /> : null}
        {tab === 'connectors' ? <IntegrationPanel kind="connector" /> : null}
      </div>
    </Modal>
  )
}

const ModelsPanel = () => {
  const selected = useWorkspace((state) => state.model)
  return (
    <>
      <h2 className={styles.heading}>Choose a model</h2>
      <p className={styles.description}>Switch models per conversation. Your choice is saved locally.</p>
      <div className={styles.cards}>
        {MODEL_OPTIONS.map((model) => (
          <button
            key={model.id}
            type="button"
            className={`${styles.card} ${selected === model.id ? styles.selected : ''}`}
            onClick={() => setWorkspaceModel(model.id)}
          >
            <div className={styles.cardBody}>
              <div className={styles.cardTitle}>
                {model.name}
                <span className={styles.badge}>{model.badge}</span>
              </div>
              <div className={styles.cardText}>{model.description}</div>
            </div>
            {selected === model.id ? <span className={styles.check}>✓</span> : null}
          </button>
        ))}
      </div>
    </>
  )
}

const SkillsPanel = () => {
  const enabled = useWorkspace((state) => state.enabledSkills)
  const skills = useWorkspace((state) => state.gatewaySkills)
  return (
    <>
      <h2 className={styles.heading}>Skills</h2>
      <p className={styles.description}>Choose reusable instructions that shape how the assistant works.</p>
      <div className={styles.cards}>
        {skills.map((skill) => (
          <button
            key={skill}
            type="button"
            className={`${styles.card} ${enabled.includes(skill) ? styles.selected : ''}`}
            onClick={() => toggleSkill(skill)}
          >
            <div className={styles.cardBody}>
              <div className={styles.cardTitle}>{skill}</div>
              <div className={styles.cardText}>Load this skill before handling matching tasks.</div>
            </div>
            {enabled.includes(skill) ? <span className={styles.check}>✓</span> : null}
          </button>
        ))}
      </div>
      {skills.length === 0 ? (
        <div className={styles.empty}>
          No skills are loaded. Add a skill folder containing SKILL.md under a configured gateway skills root.
        </div>
      ) : null}
    </>
  )
}

const IntegrationPanel = ({ kind }: { kind: 'plugin' | 'mcp' | 'connector' }) => {
  const integrations = useWorkspace((state) => state.integrations.filter((item) => item.kind === kind))
  const title = kind === 'plugin' ? 'Plugins' : kind === 'mcp' ? 'MCP servers' : 'Connectors'
  const description =
    kind === 'mcp'
      ? 'Connect local or remote MCP servers through the gateway configuration.'
      : 'Manage integrations that can provide context and actions to the assistant.'
  return (
    <>
      <h2 className={styles.heading}>{title}</h2>
      <p className={styles.description}>{description}</p>
      <div className={styles.cards}>
        {integrations.length === 0 ? <div className={styles.empty}>No {title.toLowerCase()} configured yet.</div> : null}
        {integrations.map((integration) => (
          <div key={integration.id} className={`${styles.card} ${integration.enabled ? styles.selected : ''}`}>
            <div className={styles.cardBody}>
              <div className={styles.cardTitle}>
                {integration.name}
                <span className={`${styles.status} ${integration.status === 'connected' ? styles.statusConnected : ''}`}>
                  {integration.status === 'connected' ? 'Connected' : 'Available'}
                </span>
              </div>
              <div className={styles.cardText}>{integration.description}</div>
              {integration.detail ? <div className={styles.cardText}>{integration.detail}</div> : null}
            </div>
            <Button size="s" variant={integration.enabled ? 'outlined' : 'primary'} onClick={() => toggleIntegration(integration.id)}>
              {integration.enabled ? 'Disable' : 'Enable'}
            </Button>
          </div>
        ))}
      </div>
    </>
  )
}

const ToolsPanel = () => {
  const tools = useWorkspace((state) => state.gatewayTools)
  return (
    <>
      <h2 className={styles.heading}>Available tools</h2>
      <p className={styles.description}>These are the tools the gateway actually discovered. Agents must explicitly allow them.</p>
      <div className={styles.cards}>
        {tools.map((tool) => (
          <div className={styles.card} key={tool.name}>
            <div className={styles.cardBody}>
              <div className={styles.cardTitle}>{tool.name}<span className={styles.badge}>{tool.readOnly ? 'Read-only' : 'Policy checked'}</span></div>
              <div className={styles.cardText}>{tool.description}</div>
            </div>
          </div>
        ))}
        {!tools.length ? <div className={styles.empty}>No tools are currently discovered from configured MCP servers.</div> : null}
      </div>
    </>
  )
}
