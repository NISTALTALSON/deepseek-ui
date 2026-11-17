import { useEffect, useMemo, useState } from 'react'
import { Markdown } from '../markdown/Markdown.js'
import { artifactDownloadUrl, listArtifacts, restoreArtifact, updateArtifact, type Artifact } from '../../services/artifacts.js'
import styles from './ArtifactPanel.module.css'

const currentVersion = (artifact: Artifact) => artifact.versions.find((item) => item.version === artifact.currentVersion) ?? artifact.versions.at(-1)

const previewHtml = (content: string) => `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:;"><style>body{font-family:system-ui,sans-serif;padding:24px;color:#202124}*{max-width:100%}</style>${content}`

export const ArtifactPanel = ({ conversationId, onClose }: { conversationId: string; onClose: () => void }) => {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const selected = artifacts.find((artifact) => artifact.id === selectedId)
  const version = selected ? currentVersion(selected) : undefined

  useEffect(() => {
    const controller = new AbortController()
    void listArtifacts(conversationId, controller.signal).then((items) => {
      setArtifacts(items)
      setSelectedId(items[0]?.id)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [conversationId])

  useEffect(() => {
    setDraft(version?.content ?? '')
    setEditing(false)
  }, [selectedId, selected?.currentVersion, version?.content])

  const save = async () => {
    if (!selected) { return }
    setBusy(true)
    try {
      const updated = await updateArtifact(selected, draft)
      setArtifacts((items) => items.map((item) => item.id === updated.id ? updated : item))
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (versionNumber: number) => {
    if (!selected) { return }
    setBusy(true)
    try {
      const updated = await restoreArtifact(selected, versionNumber)
      setArtifacts((items) => items.map((item) => item.id === updated.id ? updated : item))
    } finally {
      setBusy(false)
    }
  }

  const body = useMemo(() => {
    if (!selected || !version) { return <div className={styles.empty}>Select an artifact to preview it.</div> }
    if (selected.kind === 'html') {
      return <iframe className={styles.frame} title={`${selected.name} preview`} sandbox="" srcDoc={previewHtml(version.content)} />
    }
    if (selected.kind === 'markdown') {
      return <Markdown content={version.content} loading={false} cacheKey={`${selected.id}-${version.version}`} disableLink />
    }
    if (selected.kind === 'mermaid') {
      return <Markdown content={`~~~mermaid\n${version.content}\n~~~`} loading={false} cacheKey={`${selected.id}-${version.version}`} disableLink />
    }
    if (selected.kind === 'code' || selected.kind === 'json' || selected.kind === 'data') {
      const language = selected.language ?? (selected.kind === 'json' ? 'json' : '')
      return <Markdown content={`~~~${language}\n${version.content}\n~~~`} loading={false} cacheKey={`${selected.id}-${version.version}`} disableLink />
    }
    return <pre className={styles.code}><code>{version.content}</code></pre>
  }, [selected, version])

  return (
    <aside className={styles.panel} aria-label="Artifacts workspace">
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Artifacts</div>
          <div className={styles.subtitle}>Persistent files from this conversation</div>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close artifacts">×</button>
      </div>
      <div className={styles.toolbar}>
        <select value={selectedId ?? ''} onChange={(event) => setSelectedId(event.target.value)} aria-label="Select artifact">
          <option value="">Select artifact</option>
          {artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.name}</option>)}
        </select>
        {selected ? <a href={artifactDownloadUrl(selected)} className={styles.link}>Download</a> : null}
      </div>
      {selected ? (
        <div className={styles.actions}>
          <button type="button" onClick={() => setEditing((value) => !value)}>{editing ? 'Preview' : 'Edit'}</button>
          {editing ? <button type="button" onClick={() => void save()} disabled={busy}>Save version</button> : null}
          <button type="button" onClick={() => setHistoryOpen((value) => !value)}>History</button>
        </div>
      ) : null}
      {historyOpen && selected ? (
        <div className={styles.history}>
          {selected.versions.slice().reverse().map((item) => (
            <button type="button" key={item.id} onClick={() => void restore(item.version)} disabled={busy || item.version === selected.currentVersion}>
              v{item.version} · {item.changeSummary ?? item.createdBy}
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.content}>
        {editing && selected ? <textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} /> : body}
      </div>
    </aside>
  )
}
