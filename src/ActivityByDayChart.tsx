import { useLayoutEffect, useRef, useState } from 'react'
import { formatDayRu } from './chartDates'

export type ActivitySeriesPoint = {
  day: string
  approved: number
  commented: number
  /** Одно событие push в GitLab = 1 в этом ряду; без пушей с заголовком «Merge branch …». */
  pushCommits: number
}

const COLORS = {
  approved: '#fca326',
  commented: '#8b7fd6',
  pushCommits: '#17a689',
} as const

export type ActivitySeriesKey = keyof typeof COLORS

export const ACTIVITY_SERIES_DEFAULT_VISIBILITY: Record<ActivitySeriesKey, boolean> = {
  approved: true,
  commented: true,
  pushCommits: true,
}

type SeriesKey = ActivitySeriesKey

const SERIES_ORDER: SeriesKey[] = ['approved', 'commented', 'pushCommits']

const SERIES_LABEL: Record<SeriesKey, string> = {
  approved: 'Одобрение MR',
  commented: 'Комментарий в чужом MR',
  pushCommits: 'Коммиты (push)',
}

function maxLeftAxis(points: ActivitySeriesPoint[], visibility: Record<SeriesKey, boolean>): number {
  let m = 0
  for (const p of points) {
    if (visibility.approved) m = Math.max(m, p.approved)
    if (visibility.commented) m = Math.max(m, p.commented)
    if (visibility.pushCommits) m = Math.max(m, p.pushCommits)
  }
  return m
}

function axisTicks(yTop: number): number[] {
  const tickCount = Math.min(5, yTop)
  return Array.from(
    new Set(Array.from({ length: tickCount + 1 }, (_, i) => Math.round((yTop * i) / tickCount))),
  ).sort((a, b) => a - b)
}

function tooltipPosition(clientX: number, clientY: number, rowCount: number): { left: number; top: number } {
  const pad = 12
  const w = 280
  const h = 36 + rowCount * 28
  let left = clientX + pad
  let top = clientY + pad
  if (typeof window !== 'undefined') {
    if (left + w > window.innerWidth - 8) {
      left = Math.max(8, clientX - w - pad)
    }
    if (top + h > window.innerHeight - 8) {
      top = Math.max(8, clientY - h - pad)
    }
  }
  return { left, top }
}

/** Общая легенда серий для всех графиков активности на странице. */
export function ActivitySeriesLegend({
  visibility,
  onVisibilityChange,
  /** Закрепить легенду у верха вьюпорта при прокрутке (несколько графиков подряд). */
  sticky = false,
}: {
  visibility: Record<ActivitySeriesKey, boolean>
  onVisibilityChange: (next: Record<ActivitySeriesKey, boolean>) => void
  sticky?: boolean
}) {
  function toggleSeries(key: SeriesKey) {
    const on = SERIES_ORDER.filter((k) => visibility[k]).length
    if (visibility[key] && on <= 1) return
    onVisibilityChange({ ...visibility, [key]: !visibility[key] })
  }

  return (
    <div
      className={
        'activity-chart activity-chart--legend-only' +
        (sticky ? ' activity-chart--legend-sticky' : '')
      }
    >
      <ul className="activity-chart-legend" aria-label="Серии на графиках — нажмите, чтобы скрыть или показать">
        {SERIES_ORDER.map((key) => (
          <li key={key}>
            <button
              type="button"
              className={`activity-chart-legend-btn${visibility[key] ? '' : ' activity-chart-legend-btn--off'}`}
              aria-pressed={visibility[key]}
              title={
                key === 'pushCommits'
                  ? 'Число событий pushed за день (каждое событие = 1). Пуши с «Merge branch» в push_data.commit_title не входят.'
                  : undefined
              }
              onClick={() => toggleSeries(key)}
            >
              <span className="activity-chart-swatch" style={{ background: COLORS[key] }} aria-hidden />
              {SERIES_LABEL[key]}
            </button>
          </li>
        ))}
      </ul>
      <p className="activity-chart-global-legend-hint" aria-hidden>
        Настройки серий действуют на все графики ниже и на подробные списки по дню.
      </p>
    </div>
  )
}

export function ActivityByDayChart({
  points,
  selectedDay = null,
  onDayClick,
  visibility: visibilityFromParent,
  onVisibilityChange,
  /** Ложь — легенда не рисуется (например, общая легенда над блоком графиков). */
  showLegend = true,
}: {
  points: ActivitySeriesPoint[]
  selectedDay?: string | null
  onDayClick?: (day: string) => void
  /** Если задано — отрисовка столбцов по этим флажкам (часто общие для нескольких графиков). */
  visibility?: Record<SeriesKey, boolean>
  onVisibilityChange?: (next: Record<SeriesKey, boolean>) => void
  showLegend?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollViewportWidth, setScrollViewportWidth] = useState(0)

  const [hover, setHover] = useState<{
    point: ActivitySeriesPoint
    left: number
    top: number
  } | null>(null)
  const [visibilityInternal, setVisibilityInternal] = useState<Record<SeriesKey, boolean>>(
    ACTIVITY_SERIES_DEFAULT_VISIBILITY,
  )
  const usesParentVisibility = visibilityFromParent != null
  const visibility = usesParentVisibility ? visibilityFromParent! : visibilityInternal

  const visibilityLayoutKey = `${visibility.approved ? 1 : 0}${visibility.commented ? 1 : 0}${visibility.pushCommits ? 1 : 0}`

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => {
      const w = el.getBoundingClientRect().width
      setScrollViewportWidth(Number.isFinite(w) && w > 0 ? w : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [points.length, visibilityLayoutKey])

  if (points.length === 0) return null

  const H = 260
  const showLeft = visibility.approved || visibility.commented || visibility.pushCommits
  const padL = showLeft ? 40 : 26
  const padR = 12
  const padT = 16
  const padB = 52

  const maxL = maxLeftAxis(points, visibility)
  const yTopLeft = !showLeft || maxL <= 0 ? 1 : Math.ceil(maxL * 1.08)

  /** Минимальная ширина «дня» в координатах SVG; плюс не уже видимой области контейнера (на всю ширину окна). */
  const minUnitsPerDay = 4.25
  const baseInnerMin = 720 - padL - padR
  const innerMax = 5600 - padL - padR
  const fillFromViewport =
    scrollViewportWidth > 0 ? Math.max(0, scrollViewportWidth - padL - padR) : 0
  const innerW = Math.min(
    innerMax,
    Math.max(baseInnerMin, Math.ceil(points.length * minUnitsPerDay), fillFromViewport),
  )
  const W = padL + innerW + padR
  const innerH = H - padT - padB

  function yForLeft(v: number): number {
    return padT + innerH * (1 - v / yTopLeft)
  }

  const y0 = padT + innerH

  const ticksLeft = showLeft ? axisTicks(yTopLeft) : []

  const n = points.length
  const groupW = innerW / n
  const innerGap = Math.max(1, Math.min(3, groupW * 0.04))
  const activeKeys = SERIES_ORDER.filter((k) => visibility[k])
  const visibleCount = activeKeys.length
  const barW =
    visibleCount > 0
      ? Math.min(14, (groupW - innerGap * (visibleCount + 1)) / visibleCount)
      : 0
  const clusterW = visibleCount * barW + Math.max(0, visibleCount - 1) * innerGap

  const approxXLabelSlots = 24
  const labelEvery = n <= approxXLabelSlots ? 1 : Math.max(1, Math.ceil(n / approxXLabelSlots))

  function toggleSeries(key: SeriesKey) {
    const apply = (prev: Record<SeriesKey, boolean>) => {
      const on = SERIES_ORDER.filter((k) => prev[k]).length
      if (prev[key] && on <= 1) return prev
      return { ...prev, [key]: !prev[key] }
    }
    if (onVisibilityChange) {
      onVisibilityChange(apply(usesParentVisibility ? visibilityFromParent! : visibilityInternal))
    } else {
      setVisibilityInternal((prev) => apply(prev))
    }
  }

  const tooltipRows = SERIES_ORDER.filter((k) => visibility[k])

  return (
    <div className="activity-chart">
      <div className="activity-chart-scroll" ref={scrollRef}>
        <svg
          className="activity-chart-svg activity-chart-svg--sized"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
        >
          <line
            x1={padL}
            y1={y0}
            x2={W - padR}
            y2={y0}
            stroke="var(--border)"
            strokeWidth={1}
          />

          {ticksLeft.map((t) => {
            const y = yForLeft(t)
            return (
              <g key={`grid-${t}`}>
                <line
                  x1={padL - 4}
                  y1={y}
                  x2={W - padR}
                  y2={y}
                  stroke="var(--border)"
                  strokeOpacity={0.35}
                  strokeWidth={1}
                />
              </g>
            )
          })}

          {ticksLeft.map((t) => {
            const y = yForLeft(t)
            return (
              <text
                key={`L-${t}`}
                x={padL - 8}
                y={y + 4}
                textAnchor="end"
                className="activity-chart-tick"
                fontSize={10}
              >
                {t}
              </text>
            )
          })}

          {points.map((p, i) => {
            const colX = padL + i * groupW
            const isHot = hover?.point.day === p.day
            const isSelected = selectedDay === p.day
            const barStartX = colX + (groupW - clusterW) / 2

            return (
              <g key={p.day}>
                {isHot ? (
                  <rect
                    x={colX}
                    y={padT}
                    width={groupW}
                    height={y0 - padT}
                    fill="var(--accent-glow)"
                    opacity={0.35}
                    rx={4}
                  />
                ) : null}

                {activeKeys.map((key, j) => {
                  const vRaw = p[key] as number
                  const h = y0 - yForLeft(vRaw)
                  const x = barStartX + j * (barW + innerGap)
                  const y = yForLeft(vRaw)
                  return (
                    <rect
                      key={key}
                      x={x}
                      y={y}
                      width={barW}
                      height={Math.max(0, h)}
                      rx={2}
                      fill={COLORS[key]}
                      opacity={isHot ? 1 : 0.92}
                    />
                  )
                })}

                {i % labelEvery === 0 || i === n - 1 ? (
                  <text
                    x={colX + groupW / 2}
                    y={H - 18}
                    textAnchor="middle"
                    className="activity-chart-x"
                    fontSize={9}
                    transform={`rotate(-42 ${colX + groupW / 2} ${H - 18})`}
                  >
                    {p.day.slice(5)}
                  </text>
                ) : null}

                {isSelected ? (
                  <rect
                    x={colX + 0.5}
                    y={padT}
                    width={groupW - 1}
                    height={y0 - padT}
                    fill="none"
                    stroke="var(--accent-soft)"
                    strokeWidth={1.5}
                    rx={4}
                    opacity={0.95}
                    pointerEvents="none"
                  />
                ) : null}

                <rect
                  className={`activity-chart-hit${onDayClick ? ' activity-chart-hit--clickable' : ''}`}
                  x={colX}
                  y={padT}
                  width={groupW}
                  height={y0 - padT}
                  fill="transparent"
                  onMouseEnter={(e) => {
                    const { left, top } = tooltipPosition(e.clientX, e.clientY, tooltipRows.length)
                    setHover({ point: p, left, top })
                  }}
                  onMouseMove={(e) => {
                    const { left, top } = tooltipPosition(e.clientX, e.clientY, tooltipRows.length)
                    setHover({ point: p, left, top })
                  }}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDayClick?.(p.day)
                  }}
                />
              </g>
            )
          })}
        </svg>
      </div>

      {hover ? (
        <div
          className="activity-chart-tooltip"
          style={{ left: hover.left, top: hover.top }}
          role="tooltip"
        >
          <div className="activity-chart-tooltip-date">{formatDayRu(hover.point.day)}</div>
          <dl className="activity-chart-tooltip-rows">
            {tooltipRows.map((key) => (
              <div key={key} className="activity-chart-tooltip-row">
                <dt>
                  <span className="activity-chart-tooltip-dot" style={{ background: COLORS[key] }} />
                  {SERIES_LABEL[key]}
                </dt>
                <dd>{hover.point[key]}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {showLegend ? (
        <ul className="activity-chart-legend" aria-label="Серии на графике — нажмите, чтобы скрыть или показать">
          {SERIES_ORDER.map((key) => (
            <li key={key}>
              <button
                type="button"
                className={`activity-chart-legend-btn${visibility[key] ? '' : ' activity-chart-legend-btn--off'}`}
                aria-pressed={visibility[key]}
                title={
                  key === 'pushCommits'
                    ? 'Число событий pushed за день (каждое событие = 1). Пуши с «Merge branch» в push_data.commit_title не входят.'
                    : undefined
                }
                onClick={() => toggleSeries(key)}
              >
                <span className="activity-chart-swatch" style={{ background: COLORS[key] }} aria-hidden />
                {SERIES_LABEL[key]}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {points.length > 90 ? (
        <p className="activity-chart-axis-note" aria-hidden>
          Длинный период — прокрутка графика по горизонтали.
        </p>
      ) : null}
    </div>
  )
}
