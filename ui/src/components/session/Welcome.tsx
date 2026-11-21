import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.orbit} aria-hidden="true"><span className={styles.orbitCore}>e</span><i /><i /><i /></div>
        <div className={styles.eyebrow}>YOUR THOUGHT PARTNER</div>
        <h1 className={styles.greeting}>{t('welcomeMessageChat250808')}</h1>
        <p className={styles.intro}>Meet Emily — a new kind of intelligence, ready to think alongside you.</p>
        <div className={styles.capabilities}><span>✦ Explore ideas</span><span>⌘ Build something</span><span>↗ Find your way</span></div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
