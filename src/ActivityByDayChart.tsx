import { useLayoutEffect, useRef, useState } from 'react'
import { formatDayRu } from './chartDates'

export type ActivitySeriesPoint = {
  day: string
  approved: number
  commented: number
  /** Число MR, созданных в этот день (для подсказки и детализации). */
  mrsCreated: number
  /** Сумма строк диффа (добавления+удаления) по MR, созданным в этот день — отдельная шкала Y. */
  mrsCreatedDiffLines: number
}

const COLORS = {
  approved: '#fca326',
  commented: '#8b7fd6',
  mrsCreated: '#2da44e',
} as const

export type ActivitySeriesKey = keyof typeof COLORS

export const ACTIVITY_SERIES_DEFAULT_VISIBILITY: Record<ActivitySeriesKey, boolean> = {
  mrsCreated: true,
  approved: true,
  commented: true,
}

type SeriesKey = ActivitySeriesKey

const SERIES_ORDER: SeriesKey[] = ['mrsCreated', 'approved', 'commented']

const SERIES_ORDER_NO_MR: SeriesKey[] = ['approved', 'commented']

const SERIES_LABEL: Record<SeriesKey, string> = {
  mrsCreated: 'Созд. MR — строки диффа',
  approved: 'Одобрение MR',
  commented: 'Комментарий в чужом MR',
}

function maxLeftAxis(points: ActivitySeriesPoint[], visibility: Record<SeriesKey, boolean>): number {
  let m = 0
  for (const p of points) {
    if (visibility.approved) m = Math.max(m, p.approved)
    if (visibility.commented) m = Math.max(m, p.commented)
  }
  return m
}

/**
 * Верх правой шкалы без «раздувания» из‑за единичного дня с гигантским диффом:
 * при подозрительном выбросе масштаб по p99/p95, столбцы выше шкалы упираются вверх (точное значение в подсказке).
 */
function rightAxisScaleMax(
  diffValues: readonly number[],
  mrsSeriesOn: boolean,
): { yTop: number; clipped: boolean } {
  if (!mrsSeriesOn) return { yTop: 1, clipped: false }
  const positive = diffValues.filter((x) => Number.isFinite(x) && x > 0)
  if (positive.length === 0) return { yTop: 1, clipped: false }
  const sorted = [...positive].sort((a, b) => a - b)
  const rawMax = sorted[sorted.length - 1]!
  const n = sorted.length
  const at = (fraction: number) =>
    sorted[Math.max(0, Math.min(n - 1, Math.floor((n - 1) * fraction)))]!

  const p99 = at(0.99)
  const p95 = at(0.95)
  const p90 = at(0.9)

  const spike = rawMax > Math.max(p99 * 4, p95 * 14, 3000)
  if (!spike) {
    return { yTop: Math.max(1, Math.ceil(rawMax * 1.08)), clipped: false }
  }
  const yTop = Math.max(1, Math.ceil(Math.max(p99 * 1.12, p95 * 1.45, p90 * 2, rawMax * 0.02)))
  return { yTop, clipped: rawMax > yTop }
}

function axisTicks(yTop: number): number[] {
  const tickCount = Math.min(5, yTop)
  return Array.from(
    new Set(Array.from({ length: tickCount + 1 }, (_, i) => Math.round((yTop * i) / tickCount))),
  ).sort((a, b) => a - b)
}

function formatMrSeriesTooltip(p: ActivitySeriesPoint, scaleMax: number): string {
  const lines = p.mrsCreatedDiffLines.toLocaleString('ru-RU')
  const base =
    p.mrsCreated > 0 ? `${lines} стр. · ${p.mrsCreated} MR` : `${lines} стр.`
  if (p.mrsCreatedDiffLines > scaleMax) {
    return `${base} (выше подписи шкалы — ${scaleMax.toLocaleString('ru-RU')} стр.)`
  }
  return base
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

export function ActivityByDayChart({
  points,
  selectedDay = null,
  onDayClick,
  visibility: visibilityControlled,
  onVisibilityChange,
  /** Ложь — не рисуем серию «созд. MR», правую ось Y и пункт легенды (только одобрения и комментарии). */
  showMrsCreatedSeries = true,
}: {
  points: ActivitySeriesPoint[]
  selectedDay?: string | null
  onDayClick?: (day: string) => void
  /** Если задано вместе с onVisibilityChange — контролируемая легенда (фильтр серий). */
  visibility?: Record<SeriesKey, boolean>
  onVisibilityChange?: (next: Record<SeriesKey, boolean>) => void
  showMrsCreatedSeries?: boolean
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
  const isControlled = visibilityControlled != null && onVisibilityChange != null
  const visibilityRaw = isControlled ? visibilityControlled : visibilityInternal
  const visibility: Record<SeriesKey, boolean> = showMrsCreatedSeries
    ? visibilityRaw
    : { ...visibilityRaw, mrsCreated: false }

  const seriesOrder = showMrsCreatedSeries ? SERIES_ORDER : SERIES_ORDER_NO_MR

  const visibilityLayoutKey = `${visibility.approved ? 1 : 0}${visibility.commented ? 1 : 0}${visibility.mrsCreated ? 1 : 0}`

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
  const showLeft = visibility.approved || visibility.commented
  const showRight = visibility.mrsCreated
  const padL = showLeft ? 40 : 26
  const padR = showRight ? 44 : 12
  const padT = 16
  const padB = 52

  const diffSeries = points.map((p) => p.mrsCreatedDiffLines)
  const { yTop: yTopRight, clipped: rightAxisClipped } = rightAxisScaleMax(diffSeries, showRight)

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
  function yForRight(v: number): number {
    return padT + innerH * (1 - v / yTopRight)
  }

  const y0 = padT + innerH

  const ticksLeft = showLeft ? axisTicks(yTopLeft) : []
  const ticksRight = showRight ? axisTicks(yTopRight) : []
  const gridTicks = showLeft ? ticksLeft : ticksRight

  const activeKeys = seriesOrder.filter((k) => visibility[k])
  const visibleCount = activeKeys.length

  const n = points.length
  const groupW = innerW / n
  const innerGap = Math.max(1, Math.min(3, groupW * 0.04))
  const barW =
    visibleCount > 0
      ? Math.min(14, (groupW - innerGap * (visibleCount + 1)) / visibleCount)
      : 0
  const clusterW = visibleCount * barW + Math.max(0, visibleCount - 1) * innerGap

  const approxXLabelSlots = 24
  const labelEvery = n <= approxXLabelSlots ? 1 : Math.max(1, Math.ceil(n / approxXLabelSlots))

  function toggleSeries(key: SeriesKey) {
    if (!showMrsCreatedSeries && key === 'mrsCreated') return
    const apply = (prev: Record<SeriesKey, boolean>) => {
      const on = seriesOrder.filter((k) => prev[k]).length
      if (prev[key] && on <= 1) return prev
      const next = { ...prev, [key]: !prev[key] }
      if (!showMrsCreatedSeries) next.mrsCreated = false
      return next
    }
    if (isControlled) {
      onVisibilityChange!(apply(visibilityControlled))
    } else {
      setVisibilityInternal(apply)
    }
  }

  const tooltipRows = seriesOrder.filter((k) => visibility[k])

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

        {gridTicks.map((t) => {
          const y = showLeft ? yForLeft(t) : yForRight(t)
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

        {showLeft
          ? ticksLeft.map((t) => {
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
            })
          : null}

        {showRight
          ? ticksRight.map((t) => {
              const y = yForRight(t)
              return (
                <text
                  key={`R-${t}`}
                  x={W - padR + 6}
                  y={y + 4}
                  textAnchor="start"
                  className="activity-chart-tick activity-chart-tick--right"
                  fontSize={10}
                >
                  {t}
                </text>
              )
            })
          : null}

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
                const isMr = key === 'mrsCreated'
                const vRaw = isMr ? p.mrsCreatedDiffLines : (p[key] as number)
                const vPlot = isMr ? Math.min(vRaw, yTopRight) : vRaw
                const yScale = isMr ? yForRight : yForLeft
                const h = y0 - yScale(vPlot)
                const x = barStartX + j * (barW + innerGap)
                const y = yScale(vPlot)
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
                <dd>
                  {key === 'mrsCreated'
                    ? formatMrSeriesTooltip(hover.point, yTopRight)
                    : hover.point[key]}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <ul className="activity-chart-legend" aria-label="Серии на графике — нажмите, чтобы скрыть или показать">
        {seriesOrder.map((key) => (
          <li key={key}>
            <button
              type="button"
              className={`activity-chart-legend-btn${visibility[key] ? '' : ' activity-chart-legend-btn--off'}`}
              aria-pressed={visibility[key]}
              title={
                key === 'mrsCreated'
                  ? 'Столбцы по правой шкале: сумма строк диффа в MR за день (только target_branch develop или dev). Число MR — в подсказке.'
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
      {showLeft && showRight ? (
        <p className="activity-chart-axis-note" aria-hidden>
          Левая шкала — одобрения и комментарии (шт.), правая — строки диффа в созданных MR.
          {rightAxisClipped
            ? ' На длинных периодах правая шкала без редких выбросов: столбец до верха — значение выше подписи; точное число в подсказке.'
            : ''}{' '}
          Длинный ряд дней — прокрутка графика по горизонтали.
        </p>
      ) : showRight && !showLeft ? (
        <p className="activity-chart-axis-note" aria-hidden>
          {rightAxisClipped
            ? 'Шкала без редких выбросов; столбец до верха — значение выше подписи (см. подсказку). '
            : ''}
          Длинный период — прокрутка по горизонтали.
        </p>
      ) : points.length > 90 ? (
        <p className="activity-chart-axis-note" aria-hidden>
          Длинный период — прокрутка графика по горизонтали.
        </p>
      ) : null}
    </div>
  )
}
