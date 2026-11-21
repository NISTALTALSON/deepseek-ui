import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'
import { setDraftText } from '../../services/chat/drafts.js'
import type { TranslationKey } from '../../i18n/index.js'

const startingPoints = [
  { number: '01', title: 'welcomeRouteOne', detail: 'welcomeRouteOneDetail', prompt: 'welcomeRouteOnePrompt' },
  { number: '02', title: 'welcomeRouteTwo', detail: 'welcomeRouteTwoDetail', prompt: 'welcomeRouteTwoPrompt' },
  { number: '03', title: 'welcomeRouteThree', detail: 'welcomeRouteThreeDetail', prompt: 'welcomeRouteThreePrompt' },
]

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.pageMark}><span>EMILY</span><span>WORKING STUDIO</span><span>LOCAL / PRIVATE</span></div>
        <div className={styles.welcomeGrid}>
          <section className={styles.lead}>
            <div className={styles.eyebrow}><span>{t('welcomeKicker')}</span><span>{t('welcomeIndex')}</span></div>
            <h1 className={styles.greeting}>{t('welcomeHeadline')}</h1>
            <p className={styles.intro}>{t('welcomeIntro')}</p>
            <div className={styles.leadRule}><span className={styles.ruleIndex}>E—01</span><span>{t('welcomeRule')}</span></div>
          </section>
          <section className={styles.routes} aria-label="Starting points">
            <div className={styles.routesHeading}><span>{t('welcomeRoutesHeading')}</span><span>{t('welcomeRoutesCount')}</span></div>
            {startingPoints.map((item) => (
              <button
                type="button"
                key={item.number}
                className={styles.route}
                onClick={() => setDraftText(null, t(item.prompt as TranslationKey))}
              >
                <span className={styles.routeNumber}>{item.number}</span>
                <span className={styles.routeCopy}><strong>{t(item.title as TranslationKey)}</strong><small>{t(item.detail as TranslationKey)}</small></span>
                <span className={styles.routeArrow}>↗</span>
              </button>
            ))}
          </section>
        </div>
        <section className={styles.compose}>
          <div className={styles.composeLabel}><span>{t('welcomeComposeLabel')}</span><span>{t('welcomeComposeHint')}</span></div>
          <ChatInput sessionId={null} />
          <div className={styles.composeFoot}><span>{t('welcomeDeviceNotice')}</span><span>{t('welcomeAccuracyNotice')}</span></div>
        </section>
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
