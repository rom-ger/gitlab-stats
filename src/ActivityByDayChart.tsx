import { useState } from 'react'
import { formatDayRu } from './chartDates'

export type ActivitySeriesPoint = {
  day: string
  approved: number
  commented: number
  mrsCreated: number
}

const COLORS = {
  approved: '#fca326',
  commented: '#8b7fd6',
  mrsCreated: '#2da44e',
} as const

type SeriesKey = keyof typeof COLORS

const SERIES_ORDER: SeriesKey[] = ['mrsCreated', 'approved', 'commented']

const SERIES_LABEL: Record<SeriesKey, string> = {
  mrsCreated: 'Создание MR',
  approved: 'Одобрение MR',
  commented: 'Комментарий в чужом MR',
}

function maxVisibleInSeries(points: ActivitySeriesPoint[], visibility: Record<SeriesKey, boolean>): number {
  let m = 0
  for (const p of points) {
    for (const k of SERIES_ORDER) {
      if (visibility[k]) m = Math.max(m, p[k])
    }
  }
  return m
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

const defaultVisibility: Record<SeriesKey, boolean> = {
  mrsCreated: true,
  approved: true,
  commented: true,
}

export function ActivityByDayChart({
  points,
  selectedDay = null,
  onDayClick,
}: {
  points: ActivitySeriesPoint[]
  selectedDay?: string | null
  onDayClick?: (day: string) => void
}) {
  const [hover, setHover] = useState<{
    point: ActivitySeriesPoint
    left: number
    top: number
  } | null>(null)
  const [visibility, setVisibility] = useState<Record<SeriesKey, boolean>>(defaultVisibility)

  if (points.length === 0) return null

  const W = 720
  const H = 260
  const padL = 36
  const padR = 12
  const padT = 16
  const padB = 52
  const innerW = W - padL - padR
  const innerH = H - padT - padB

  const activeKeys = SERIES_ORDER.filter((k) => visibility[k])
  const visibleCount = activeKeys.length

  const maxVal = maxVisibleInSeries(points, visibility)
  const yTop = maxVal <= 0 ? 1 : Math.ceil(maxVal * 1.08)

  const n = points.length
  const groupW = innerW / n
  const innerGap = Math.max(1, Math.min(3, groupW * 0.04))
  const barW =
    visibleCount > 0
      ? Math.min(14, (groupW - innerGap * (visibleCount + 1)) / visibleCount)
      : 0
  const clusterW = visibleCount * barW + Math.max(0, visibleCount - 1) * innerGap

  /** Плотность подписей по X: до ~24 отметок на ширину графика. */
  const approxXLabelSlots = 24
  const labelEvery = n <= approxXLabelSlots ? 1 : Math.max(1, Math.ceil(n / approxXLabelSlots))

  function yFor(v: number): number {
    return padT + innerH * (1 - v / yTop)
  }

  const y0 = yFor(0)
  const tickCount = Math.min(5, yTop)
  const ticks = Array.from(
    new Set(Array.from({ length: tickCount + 1 }, (_, i) => Math.round((yTop * i) / tickCount))),
  ).sort((a, b) => a - b)

  function toggleSeries(key: SeriesKey) {
    setVisibility((prev) => {
      const on = SERIES_ORDER.filter((k) => prev[k]).length
      if (prev[key] && on <= 1) return prev
      return { ...prev, [key]: !prev[key] }
    })
  }

  const tooltipRows = SERIES_ORDER.filter((k) => visibility[k])

  return (
    <div className="activity-chart">
      <svg
        className="activity-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <line
          x1={padL}
          y1={y0}
          x2={W - padR}
          y2={y0}
          stroke="var(--border)"
          strokeWidth={1}
        />

        {ticks.map((t) => {
          const y = yFor(t)
          return (
            <g key={t}>
              <line
                x1={padL - 4}
                y1={y}
                x2={W - padR}
                y2={y}
                stroke="var(--border)"
                strokeOpacity={0.35}
                strokeWidth={1}
              />
              <text
                x={padL - 8}
                y={y + 4}
                textAnchor="end"
                className="activity-chart-tick"
                fontSize={10}
              >
                {t}
              </text>
            </g>
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
                const v = p[key]
                const h = y0 - yFor(v)
                const x = barStartX + j * (barW + innerGap)
                const y = yFor(v)
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

      <ul className="activity-chart-legend" aria-label="Серии на графике — нажмите, чтобы скрыть или показать">
        {SERIES_ORDER.map((key) => (
          <li key={key}>
            <button
              type="button"
              className={`activity-chart-legend-btn${visibility[key] ? '' : ' activity-chart-legend-btn--off'}`}
              aria-pressed={visibility[key]}
              onClick={() => toggleSeries(key)}
            >
              <span className="activity-chart-swatch" style={{ background: COLORS[key] }} aria-hidden />
              {SERIES_LABEL[key]}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
