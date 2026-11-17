import clsx from 'clsx'
import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { MobileHeader } from './MobileHeader.js'
import { ActivityPanel } from './ActivityPanel.js'
import styles from './SessionView.module.css'
import { openWorkspace, MODEL_OPTIONS, useWorkspace } from '../../services/workspace.js'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  const model = useWorkspace((state) => state.model)
  const modelName = MODEL_OPTIONS.find((item) => item.id === model)?.name ?? model
  const [activityOpen, setActivityOpen] = useState(false)
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} />
      ) : (
        <div className={styles.header}>
          <button type="button" className={styles.modelButton} onClick={() => openWorkspace('models')}>
            <span>{modelName}</span>
            <span className={styles.modelChevron}>⌄</span>
          </button>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
          <button type="button" className={styles.activityButton} onClick={() => setActivityOpen((open) => !open)}>
            {activityOpen ? 'Hide activity' : 'Activity'}
          </button>
        </div>
      )}
      <div className={styles.content}>
        <MessageList
          session={session}
          streaming={streaming}
          footer={
            <div className={styles.inputContainer}>
              <ChatInput sessionId={session.id} />
              <div className={styles.caveat}>{t('contentCaveat')}</div>
            </div>
          }
        />
        {activityOpen ? <ActivityPanel session={session} /> : null}
      </div>
    </div>
  )
}
