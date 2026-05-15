/**
 * Эвристический «индекс активности» по метрикам GitLab за период.
 * Не оценка качества работы человека — только агрегат видимой активности в ревью и коммитах.
 * Учитываются: комментарии в чужих MR (интенсивность и глубина), push-события; без созданных MR и без одобрений как отдельного сигнала.
 */

export type EffectivenessInput = {
  activityByDayLength: number
  stats: {
    commented: string
    pushCommits: string
    /** Среднее «стр./комм.» по одобрённым MR — запасной сигнал глубины, если медиана недоступна. */
    avgLinesPerComment: string
    /** Медиана (стр. диффа MR)/(число ваших комментариев в MR) по чужим MR. */
    medianLinesPerCommentByMr: string
  }
}

function parseRuNumericStat(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '—' || trimmed === '') return null
  const normalized = trimmed.replace(/\u00a0/g, '').replace(/\s/g, '').replace(',', '.')
  const n = Number.parseFloat(normalized)
  return Number.isFinite(n) ? n : null
}

/** 0…100: быстрее насыщается при росте value; scale типичный «полупериод насыщения». */
function saturating100(value: number, scale: number): number {
  if (!(value > 0) || !(scale > 0)) return 0
  return 100 * (1 - Math.exp(-value / scale))
}

function bandForScore(score: number): string {
  if (score < 22) return 'Очень низкий'
  if (score < 38) return 'Низкий'
  if (score < 52) return 'Ниже среднего'
  if (score < 65) return 'Средний'
  if (score < 78) return 'Выше среднего'
  if (score < 90) return 'Высокий'
  return 'Очень высокий'
}

export type EffectivenessScoreResult = {
  /** Целое 0–100 */
  score: number
  band: string
  /** Подсказка: формула и вклад частей */
  tooltip: string
}

/**
 * Веса подобраны так, чтобы «типичная» загрузка давала ~45–70, сильная активность — 80+.
 * Суточные нормы: комментарии и push делятся на число дней в ряду графика.
 */
export function computeEffectivenessScore(input: EffectivenessInput): EffectivenessScoreResult {
  const days = Math.max(1, input.activityByDayLength)
  const commented = Number.parseInt(input.stats.commented, 10)
  const pushCommits = Number.parseInt(input.stats.pushCommits, 10)
  const avgLinesPerComm = parseRuNumericStat(input.stats.avgLinesPerComment)
  const medianLinesPerMr = parseRuNumericStat(input.stats.medianLinesPerCommentByMr)

  const commPerDay = Number.isFinite(commented) && commented > 0 ? commented / days : 0
  const pushPerDay = Number.isFinite(pushCommits) && pushCommits > 0 ? pushCommits / days : 0

  const reviewVolume = saturating100(commPerDay, 0.9)
  const pushVolume = saturating100(pushPerDay, 2.2)

  let reviewDepth = 0
  if (Number.isFinite(commented) && commented > 0) {
    const depthLines =
      medianLinesPerMr != null && medianLinesPerMr > 0 ? medianLinesPerMr : avgLinesPerComm
    if (depthLines != null && depthLines > 0) {
      reviewDepth = saturating100(depthLines, 420)
    }
  }

  const minPillar = Math.min(reviewVolume, pushVolume)
  const balanceBonus = minPillar >= 14 ? Math.min(10, 6.5 * (minPillar / 52)) : 0

  const raw = 0.42 * reviewVolume + 0.3 * reviewDepth + 0.2 * pushVolume + balanceBonus

  const score = Math.max(0, Math.min(100, Math.round(raw)))
  const band = bandForScore(score)

  const tooltip = [
    'Индекс активности (эвристика): не KPI и не рейтинг сотрудника.',
    'Ревью: комментарии в чужих MR (интенсивность и глубина — в основном медиана «стр./комм.» по MR).',
    'Push-коммиты и бонус за баланс «ревью ↔ коммиты»; число одобрений и метрики созданных MR не входят.',
    `Вклад частей (0–100, до бонуса): ревью ${reviewVolume.toFixed(0)}, глубина ${reviewDepth.toFixed(0)}, push ${pushVolume.toFixed(0)}, баланс +${balanceBonus.toFixed(1)}.`,
  ].join(' ')

  return { score, band, tooltip }
}

export function effectivenessScoreFromPeriod(pr: {
  activityByDay: { length: number }
  stats: EffectivenessInput['stats']
}): EffectivenessScoreResult {
  return computeEffectivenessScore({
    activityByDayLength: pr.activityByDay.length,
    stats: pr.stats,
  })
}
