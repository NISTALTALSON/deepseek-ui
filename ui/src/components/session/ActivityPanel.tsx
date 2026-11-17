import { useEffect, useMemo, useState } from 'react'
import type { AssistantMessage, ReplyBlock, Session } from '../../services/chat/types.js'
import { decideApproval, getRecoveryState, listApprovals, listRuns, resumeRun, type ApprovalRecord, type RecoveryState } from '../../services/api/client.js'
import { useSettings } from '../../services/settings.js'
import styles from './ActivityPanel.module.css'

const labelForBlock = (block: ReplyBlock) => {
  if (block.type === 'server_tool_use') {
    return block.name === 'deepseek_web_search' ? 'Web search' : 'Read page'
  }
  if (block.type === 'web_search_tool_result') {
    return 'Search results'
  }
  if (block.type === 'web_fetch_tool_result') {
    return 'Fetched page'
  }
  return null
}

const detailForBlock = (block: ReplyBlock) => {
  if (block.type === 'server_tool_use') {
    const input = block.input
    if ('query' in input) {
      return input.query || input.queries.join(', ')
    }
    if ('queries' in input) {
      return input.queries.join(', ')
    }
    if (input.action === 'find_in_page') {
      return `${input.url} · ${input.pattern}`
    }
    return input.url
  }
  if (block.type === 'web_search_tool_result') {
    return `${block.content.length} sources returned`
  }
  if (block.type === 'web_fetch_tool_result') {
    return 'error_code' in block.content ? block.content.error_code : block.content.content.title ?? 'Page fetched'
  }
  return ''
}

export const ActivityPanel = ({ session }: { session: Session }) => {
  const apiKey = useSettings((state) => state.apiKey) ?? ''
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([])
  const [recovery, setRecovery] = useState<RecoveryState | null>(null)
  useEffect(() => {
    let active = true
    void Promise.all([listApprovals(apiKey), listRuns(apiKey)]).then(async ([items, runs]) => {
      if (!active) {
        return
      }
      setApprovals(items.filter((item) => item.conversationId === session.id))
      const run = runs.find((item) => item.conversationId === session.id && ['paused', 'awaiting_approval'].includes(item.status))
      setRecovery(run ? await getRecoveryState(apiKey, run.id) : null)
    }).catch(() => {
      if (active) {
        setApprovals([])
        setRecovery(null)
      }
    })
    return () => { active = false }
  }, [apiKey, session.id])
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending')
  const activities = useMemo(() => {
    const result: { message: AssistantMessage; block: ReplyBlock; label: string; detail: string }[] = []
    for (const message of session.messages) {
      if (message.role !== 'assistant') {
        continue
      }
      for (const block of message.blocks) {
        const label = labelForBlock(block)
        if (label) {
          result.push({ message, block, label, detail: detailForBlock(block) })
        }
      }
    }
    return result.slice(-12).reverse()
  }, [session.messages])

  const latestAssistant = [...session.messages].reverse().find((message): message is AssistantMessage => message.role === 'assistant')

  return (
    <aside className={styles.panel} aria-label="Conversation activity">
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Activity</div>
          <div className={styles.subtitle}>Live tools and sources</div>
        </div>
        <span className={styles.status} data-status={latestAssistant?.status ?? 'done'}>
          {latestAssistant?.status === 'streaming' ? 'Working' : latestAssistant?.status === 'error' ? 'Error' : 'Ready'}
        </span>
      </div>
      <div className={styles.list}>
        {recovery?.recoverable && recovery.run.status !== 'awaiting_approval' ? (
          <div className={styles.item}>
            <div className={styles.itemTitle}>
              <span className={styles.dot} data-kind="tool" />
              <span>Interrupted run</span>
            </div>
            <div className={styles.detail}>
              Last checkpoint: {recovery.checkpoint?.phase ?? 'unknown'}
            </div>
            <button type="button" onClick={() => void resumeRun(apiKey, recovery.run.id).then(() => setRecovery(null))}>Resume</button>
          </div>
        ) : null}
        {pendingApprovals.map((approval) => (
          <div className={styles.item} key={approval.id}>
            <div className={styles.itemTitle}>
              <span className={styles.dot} data-kind="tool" />
              <span>Approval required</span>
            </div>
            <div className={styles.detail}>
              {approval.toolId} · {approval.permissionClass}
            </div>
            <div className={styles.detail}>
              {JSON.stringify(approval.arguments)}
            </div>
            <div>
              <button type="button" onClick={() => void decideApproval(apiKey, approval.id, 'approved').then((next) => setApprovals((current) => current.map((item) => item.id === next.id ? next : item)))}>Approve</button>
              <button type="button" onClick={() => void decideApproval(apiKey, approval.id, 'denied').then((next) => setApprovals((current) => current.map((item) => item.id === next.id ? next : item)))}>Deny</button>
            </div>
          </div>
        ))}
        {activities.length === 0 ? (
          <div className={styles.empty}>Tool calls and research sources will appear here.</div>
        ) : (
          activities.map(({ message, block, label, detail }) => (
            <div className={styles.item} key={`${message.id}-${block.type}-${'id' in block ? block.id : 'result'}`}>
              <div className={styles.itemTitle}>
                <span className={styles.dot} data-kind={block.type === 'server_tool_use' ? 'tool' : 'result'} />
                <span>{label}</span>
              </div>
              <div className={styles.detail}>{detail}</div>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
