export type CommentMarkerId = 'bang' | 'query' | 's' | 'p' | 'none'

export type CommentMarkerCounts = Record<CommentMarkerId, number>

const ZERO: CommentMarkerCounts = { bang: 0, query: 0, s: 0, p: 0, none: 0 }

const ORDER: CommentMarkerId[] = ['bang', 'query', 's', 'p', 'none']

export const COMMENT_MARKER_META: Record<
  CommentMarkerId,
  { tag: string; shortLabel: string; barClass: string }
> = {
  bang: { tag: '[!]', shortLabel: 'Важно', barClass: 'comment-markers-seg--bang' },
  query: { tag: '[?]', shortLabel: 'Вопрос', barClass: 'comment-markers-seg--query' },
  s: { tag: '[S]', shortLabel: 'Предложение', barClass: 'comment-markers-seg--s' },
  p: { tag: '[P]', shortLabel: 'Позитив', barClass: 'comment-markers-seg--p' },
  none: { tag: '—', shortLabel: 'Без маркера', barClass: 'comment-markers-seg--none' },
}

/** Маркер только в самом начале текста (после trim в API совпадает с началом строки). */
export function commentMarkerFromBody(body: string | null | undefined): CommentMarkerId {
  if (body == null || typeof body !== 'string') return 'none'
  const t = body.replace(/\r\n/g, '\n').trimStart()
  if (t.startsWith('[!]')) return 'bang'
  if (t.startsWith('[?]')) return 'query'
  if (t.startsWith('[S]')) return 's'
  if (t.startsWith('[P]')) return 'p'
  return 'none'
}

export function normalizeCommentMarkerCounts(raw: unknown): CommentMarkerCounts {
  if (!raw || typeof raw !== 'object') return { ...ZERO }
  const o = raw as Record<string, unknown>
  const n = (k: CommentMarkerId): number => {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.trunc(v)
    return 0
  }
  return { bang: n('bang'), query: n('query'), s: n('s'), p: n('p'), none: n('none') }
}

export function totalCommentMarkers(c: CommentMarkerCounts): number {
  return ORDER.reduce((s, k) => s + c[k], 0)
}

function pct(part: number, total: number): string {
  if (total <= 0 || part <= 0) return '0'
  return Math.round((100 * part) / total).toLocaleString('ru-RU')
}

export function commentMarkersTooltipLine(c: CommentMarkerCounts, total: number): string {
  return ORDER.filter((k) => c[k] > 0)
    .map((k) => `${COMMENT_MARKER_META[k].tag} ${c[k]} (${pct(c[k], total)}%)`)
    .join(' · ')
}

export function CommentMarkersSummary({
  counts,
  compact = false,
}: {
  counts: CommentMarkerCounts
  compact?: boolean
}) {
  const total = totalCommentMarkers(counts)
  if (total <= 0) {
    return <span className="comment-markers-empty">Нет комментариев в чужих MR за период.</span>
  }

  const tooltip = commentMarkersTooltipLine(counts, total)

  return (
    <div className={`comment-markers-summary${compact ? ' comment-markers-summary--compact' : ''}`}>
      <div
        className="comment-markers-bar"
        role="img"
        aria-label={`Доля комментариев по маркерам: ${tooltip}`}
        title={tooltip}
      >
        {ORDER.map((id) => {
          const n = counts[id]
          if (n <= 0) return null
          return (
            <div
              key={id}
              className={`comment-markers-seg ${COMMENT_MARKER_META[id].barClass}`}
              style={{ flexGrow: n }}
            />
          )
        })}
      </div>
      {!compact ? (
        <ul className="comment-markers-legend">
          {ORDER.map((id) => {
            const n = counts[id]
            if (n <= 0) return null
            return (
              <li key={id} className="comment-markers-legend-item">
                <span className={`comment-markers-dot ${COMMENT_MARKER_META[id].barClass}`} aria-hidden />
                <span className="comment-markers-tag">{COMMENT_MARKER_META[id].tag}</span>
                <span className="comment-markers-meta">
                  {COMMENT_MARKER_META[id].shortLabel}
                  <span className="comment-markers-num">
                    {' '}
                    {n.toLocaleString('ru-RU')} ({pct(n, total)}%)
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
