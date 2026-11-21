import { useIsMobile } from '../../app/viewport.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'
import { setDraftText } from '../../services/chat/drafts.js'

const reviewPrompts = [
  { number: '01', title: 'Classify this patch', detail: 'Request the model label and its reported score.', prompt: 'Classify the attached lymph-node histopathology patch. Return the model label and any score it provides.' },
  { number: '02', title: 'Check image quality', detail: 'Flag blur, artifacts, or an unreadable field.', prompt: 'Assess whether the attached lymph-node histopathology patch is clear enough for classification. Note visible quality issues.' },
  { number: '03', title: 'Review an uncertain result', detail: 'Keep uncertainty and evidence separate.', prompt: 'Review the attached patch and explain any uncertainty. Do not invent a confidence score.' },
]

/** Emily's starting workspace for patch-level histopathology review. */
export const Welcome = () => {
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <main className={styles.welcome}>
        <header className={styles.pageMark}>
          <span>EMILY</span><span>LYMPH NODE · PATCH REVIEW</span><span>MODEL WORKSPACE / 01</span>
        </header>
        <div className={styles.welcomeGrid}>
          <section className={styles.lead}>
            <div className={styles.eyebrow}><span>HISTOPATHOLOGY / IMAGE CLASSIFIER</span><span>PATCH LEVEL</span></div>
            <h1 className={styles.greeting}>Keep the tissue<br />in view.</h1>
            <p className={styles.intro}>Review a lymph-node patch with Emily. The model result stays tied to the image, with its score and image-quality notes shown separately.</p>
            <div className={styles.scope}><span className={styles.scopeMark}>!</span><span><strong>Patch-level model output</strong><small>Not a patient-level diagnosis or clinical conclusion.</small></span></div>
          </section>
          <section className={styles.routes} aria-label="Patch review actions">
            <div className={styles.routesHeading}><span>START A REVIEW</span><span>01 — 03</span></div>
            {reviewPrompts.map((item) => (
              <button type="button" key={item.number} className={styles.route} onClick={() => setDraftText(null, item.prompt)}>
                <span className={styles.routeNumber}>{item.number}</span>
                <span className={styles.routeCopy}><strong>{item.title}</strong><small>{item.detail}</small></span>
                <span className={styles.routeArrow}>↗</span>
              </button>
            ))}
            <div className={styles.readout}><span className={styles.readoutLabel}>RESULT DISPLAY</span><span><i className={styles.swatchTumor} />Model label</span><span><i className={styles.swatchScore} />Reported score</span><span><i className={styles.swatchQuality} />Quality / uncertainty</span></div>
          </section>
        </div>
        <section className={styles.compose}>
          <div className={styles.composeLabel}><span>PATCH INTAKE</span><span>Attach a patch image · PNG, JPEG, GIF, WebP</span></div>
          <ChatInput sessionId={null} />
          <div className={styles.composeFoot}><span>Emily receives the original image at the configured model endpoint.</span><span>Scores are shown only when the model returns them.</span></div>
        </section>
      </main>
    </div>
  )
}
