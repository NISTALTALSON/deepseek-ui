import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { Source } from '../../services/chat/view.js'
import { getResearchSource, type ResearchSourceView } from '../../services/research.js'
import { useSettings } from '../../services/settings.js'
import {
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconLinkOutline14,
  IconBrowseWarningOutline16,
} from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { closeSearchPanel, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import styles from './SearchPanel.module.css'

/** 右侧「搜索结果」面板；点击来源可在会话内查看抓取正文与元数据。 */
export const SearchPanel = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey) ?? ''
  const entry = useSearchPanel((state) => state.entry)
  const sources = useSearchPanel((state) => state.sources)
  const [active, setActive] = useState<Source | null>(null)
  const [detail, setDetail] = useState<ResearchSourceView | null>(null)
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'error'>('idle')

  useEffect(() => {
    setActive(null)
    setDetail(null)
    setDetailState('idle')
  }, [entry])

  useEffect(() => {
    if (!active) {
      setDetail(null)
      setDetailState('idle')
      return
    }
    if (!active.sourceId) {
      setDetail(null)
      setDetailState('idle')
      return
    }
    let cancelled = false
    setDetailState('loading')
    getResearchSource(apiKey, active.sourceId)
      .then((source) => {
        if (!cancelled) {
          setDetail(source)
          setDetailState('idle')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(null)
          setDetailState('error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [active, apiKey])

  if (!entry) {
    return null
  }

  const detailTitle = detail?.title ?? active?.title ?? t('searchResult')
  const retrieved = detail?.retrievedAt ?? active?.retrievedAt ?? null
  const published = detail?.publishedAt ?? active?.publishedAt ?? null
  const isMock = detail?.isMock ?? active?.isMock ?? false
  const provider = detail?.provider ?? active?.provider ?? ''

  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        {active ? (
          <IconButton
            icon={<IconChevronRightOutline14 />}
            aria-label={t('researchBackToSources')}
            className={styles.back}
            onClick={() => setActive(null)}
          />
        ) : null}
        <div role="heading" className={styles.title} title={detailTitle}>
          {active ? detailTitle : t('searchResult')}
        </div>
        <IconButton icon={<IconCloseOutline16 />} aria-label={t('close')} onClick={closeSearchPanel} />
      </div>
      <div className={styles.content}>
        {active ? (
          <div className={styles.detail}>
            <div className={styles.detailMeta}>
              <span className={styles.domain}>{detail?.domain ?? active.siteName}</span>
              {isMock ? (
                <span className={styles.mockBadge}>{t('researchMockProvider')}</span>
              ) : provider ? (
                <span className={styles.providerBadge}>{provider}</span>
              ) : null}
            </div>
            {published ? (
              <div className={styles.detailLine}>
                {new Date(published).toLocaleDateString()} · {detail?.domain ?? active.siteName}
              </div>
            ) : null}
            {retrieved ? (
              <div className={styles.detailLine}>
                {t('researchSourceRetrieved', {
                  date: new Date(retrieved).toLocaleString(),
                })}
              </div>
            ) : null}
            {isMock ? <div className={styles.mockNotice}>{t('researchMockNotice')}</div> : null}
            {detailState === 'loading' ? <div className={styles.detailLine}>{t('researchLoading')}</div> : null}
            {detailState === 'error' ? (
              <div className={styles.mockNotice}>
                <IconBrowseWarningOutline16 /> {t('researchExtractFailed')}
              </div>
            ) : null}
            {active.snippet && !detail?.content ? (
              <p className={styles.snippet}>{active.snippet}</p>
            ) : null}
            {(detail?.content ?? detail?.excerpt) ? (
              <div className={styles.detailContent}>{detail?.content ?? detail?.excerpt}</div>
            ) : null}
            <div className={styles.detailActions}>
              <a className={styles.detailLink} href={detail?.url ?? active.url} target="_blank" rel="noreferrer">
                <IconLinkOutline14 /> {t('researchOpenPage')}
              </a>
            </div>
          </div>
        ) : (
          sources.map((source) => (
            <SourceCard
              key={source.url}
              source={source}
              className={styles.item}
              onInspect={setActive}
            />
          ))
        )}
      </div>
    </aside>
  )
}
