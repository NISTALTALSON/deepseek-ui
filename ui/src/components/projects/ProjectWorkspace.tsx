import { useEffect, useRef, useState } from 'react'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import {
  archiveProject,
  createProject,
  deleteProject,
  deleteProjectFile,
  loadProjects,
  selectProject,
  updateProject,
  uploadProjectFile,
  useProjects,
} from '../../services/projects.js'
import styles from './ProjectWorkspace.module.css'

export const ProjectWorkspace = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const projects = useProjects((state) => state.projects)
  const selectedProjectId = useProjects((state) => state.selectedProjectId)
  const files = useProjects((state) => state.files)
  const project = projects.find((item) => item.id === selectedProjectId)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      void loadProjects()
    }
  }, [open])

  useEffect(() => {
    if (project) {
      setName(project.name)
      setDescription(project.description)
      setInstructions(project.instructions)
    }
  }, [project])

  if (!open) {
    return null
  }
  const visible = projects.filter((item) => !item.archived && item.name.toLowerCase().includes(search.toLowerCase()))
  const save = async () => {
    setBusy(true)
    try {
      if (project) {
        await updateProject(project.id, { name, description, instructions })
      } else {
        await createProject({ name: name || 'New project', description, instructions })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Projects" closable className={styles.dialog} mainClassName={styles.main} onClose={onClose}>
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarTop}>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" aria-label="Search projects" />
            <Button size="s" variant="primary" onClick={() => { void selectProject(); setName(''); setDescription(''); setInstructions('') }}>New</Button>
          </div>
          {visible.map((item) => (
            <button type="button" className={`${styles.project} ${item.id === selectedProjectId ? styles.selected : ''}`} key={item.id} onClick={() => void selectProject(item.id)}>
              <strong>{item.name}</strong>
              <span>{item.description || 'No description'}</span>
            </button>
          ))}
          {visible.length === 0 ? <div className={styles.empty}>No projects yet.</div> : null}
        </aside>
        <section className={styles.editor}>
          <div className={styles.editorHeader}>
            <div>
              <h2>{project ? project.name : 'Create a project'}</h2>
              <p>Instructions and files are isolated to this project.</p>
            </div>
            {project ? <Button size="s" variant="outlined" onClick={() => void archiveProject(project.id, true)}>Archive</Button> : null}
          </div>
          <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} /></label>
          <label>Project instructions<textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={5} placeholder="Tell the assistant how to work in this project." /></label>
          <div className={styles.actions}>
            <Button size="m" variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save project'}</Button>
            {project ? <Button size="m" variant="outlined" onClick={() => void deleteProject(project.id)}>Delete</Button> : null}
          </div>
          {project ? (
            <div className={styles.files}>
              <div className={styles.filesHeader}><h3>Project files</h3><Button size="s" variant="outlined" onClick={() => inputRef.current?.click()}>Upload files</Button></div>
              <input ref={inputRef} hidden type="file" multiple onChange={(event) => {
                const selected = Array.from(event.target.files ?? [])
                void Promise.all(selected.map((file) => uploadProjectFile(project.id, file)))
                event.target.value = ''
              }} />
              {files.map((file) => (
                <div className={styles.file} key={file.id}>
                  <span>{file.originalName}</span>
                  <small>{file.extractionStatus}{file.extractionError ? ` · ${file.extractionError}` : ''}</small>
                  <Button size="s" variant="outlined" onClick={() => void deleteProjectFile(file.id)}>Delete</Button>
                </div>
              ))}
              {files.length === 0 ? <div className={styles.empty}>Upload documents to make them searchable.</div> : null}
            </div>
          ) : null}
        </section>
      </div>
    </Modal>
  )
}
