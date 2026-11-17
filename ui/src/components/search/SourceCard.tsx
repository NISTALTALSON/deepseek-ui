import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import type { Source } from '../../services/chat/view.js'
import { formatDate } from '../../utils/format.js'
import { SiteLogo } from './SiteLogo.js'
import styles from './SourceCard.module.css'

/** 显示为 YYYY/MM/DD；无法解析的日期原样显示 */
const formatPublishedAt = (value: string | null) => (value ? (formatDate(value, '/') ?? value) : '')

/**
 * 搜索结果卡片：站点图标与名称、日期、标题、摘要。
 * 元数据缺失时省略摘要，图标使用链接图标兜底。
 * 传入 onInspect 时改为按钮，在当前会话的搜索结果面板内查看来源详情。
 */
export const SourceCard = ({
  source,
  className,
  onInspect,
}: {
  source: Source
  className?: string
  onInspect?: (source: Source) => void
}) => {
  const t = useTranslate()
  const date = formatPublishedAt(source.publishedAt)
  const retrieved = source.retrievedAt ? formatPublishedAt(source.retrievedAt) : ''
  const providerLabel = source.isMock
    ? t('researchMockProvider')
    : source.provider
      ? source.provider
      : null
  const body = (
    <div className={clsx(styles.card, className)}>
      <div className={styles.meta}>
        <SiteLogo url={source.siteIcon} className={styles.siteIcon} />
        {source.siteName ? <span className={styles.siteName}>{source.siteName}</span> : null}
        {providerLabel ? (
          <span className={styles.badge} data-mock={source.isMock ? 'true' : undefined}>
            {providerLabel}
          </span>
        ) : null}
        {source.siteName && date ? <span className={styles.divider} /> : null}
        {date ? <span className={styles.date}>{date}</span> : null}
      </div>
      <div className={styles.title}>{source.title}</div>
      {source.snippet ? <div className={styles.snippet}>{source.snippet}</div> : null}
      {retrieved ? (
        <div className={styles.retrieved} title={source.retrievedAt}>
          {t('researchSourceRetrieved', { date: retrieved })}
          {source.extraction
            ? ` · ${
                source.extraction.ok
                  ? t('researchExtracted', { count: source.extraction.chars ?? 0 })
                  : t('researchExtractFailed')
              }`
            : ''}
        </div>
      ) : null}
    </div>
  )
  if (onInspect) {
    return (
      <button
        type="button"
        className={styles.anchor}
        onClick={() => onInspect(source)}
        aria-label={t('researchInspectSource')}
      >
        {body}
      </button>
    )
  }
  return (
    <a className={styles.anchor} href={source.url} target="_blank" rel="noreferrer">
      {body}
    </a>
  )
}
