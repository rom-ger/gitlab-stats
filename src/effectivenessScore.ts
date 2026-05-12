/**
 * Эвристический «индекс активности» по метрикам GitLab за период.
 * Не оценка качества работы человека — только агрегат видимой активности в MR.
 * Ревью: только ваши комментарии в чужих MR (число и «вес» комментариев), без числа одобрений и без
 * размера чужих MR — на поток и дифф вы не влияете. Свой код: MR в develop/dev и дифф по ним.
 */

export type EffectivenessInput = {
  activityByDayLength: number
  /** Из ответа периода; в индекс не входят approved и approvedMrsDiffLines — намеренно не учитываем. */
  stats: {
    approved: string
    commented: string
    mrsCreated: string
    approvedMrsDiffLines: string
    createdMrsDiffLines: string
    avgCreatedMrsDiffLinesPerDay: string
    avgCreatedMrsDiffLinesPerMr: string
    avgLinesPerComment: string
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
 * Суточные нормы: комментарии и свой код делятся на число дней в ряду графика.
 */
export function computeEffectivenessScore(input: EffectivenessInput): EffectivenessScoreResult {
  const days = Math.max(1, input.activityByDayLength)
  const commented = Number.parseInt(input.stats.commented, 10)
  const mrsCreated = Number.parseInt(input.stats.mrsCreated, 10)
  const creatDiff = parseRuNumericStat(input.stats.createdMrsDiffLines) ?? 0
  const avgMr = parseRuNumericStat(input.stats.avgCreatedMrsDiffLinesPerMr)
  const avgLinesPerComm = parseRuNumericStat(input.stats.avgLinesPerComment)

  const commPerDay = Number.isFinite(commented) && commented > 0 ? commented / days : 0
  const mrPerDay = Number.isFinite(mrsCreated) && mrsCreated > 0 ? mrsCreated / days : 0
  const creatDiffPerDay = creatDiff > 0 ? creatDiff / days : 0

  /** Объём ревью: только комментарии в чужих MR (на день). Одобрения и размер чужих MR не входят. */
  const reviewVolume = saturating100(commPerDay, 0.9)

  const authorVolume =
    0.42 * saturating100(mrPerDay, 0.35) + 0.58 * saturating100(creatDiffPerDay, 2200)

  let reviewDepth = 0
  if (Number.isFinite(commented) && commented > 0 && avgLinesPerComm != null && avgLinesPerComm > 0) {
    reviewDepth = saturating100(avgLinesPerComm, 420)
  }

  let mrHeft = 0
  if (Number.isFinite(mrsCreated) && mrsCreated > 0 && avgMr != null && avgMr > 0) {
    mrHeft = saturating100(avgMr, 320)
  }

  const minPillar = Math.min(reviewVolume, authorVolume)
  const balanceBonus = minPillar >= 18 ? Math.min(8, 6 * (minPillar / 55)) : 0

  const raw =
    0.36 * reviewVolume +
    0.34 * authorVolume +
    0.16 * reviewDepth +
    0.14 * mrHeft +
    balanceBonus

  const score = Math.max(0, Math.min(100, Math.round(raw)))
  const band = bandForScore(score)

  const tooltip = [
    'Индекс активности (эвристика): не KPI и не рейтинг сотрудника.',
    'Ревью: только комментарии в чужих MR (интенсивность и «стр./комм.»); число одобрений и размер чужих MR не учитываются.',
    'Свой код: MR в develop/dev, строки диффа, средний размер MR; плюс бонус за баланс ревью и разработки.',
    `Вклад частей (0–100, до бонуса): ревью ${reviewVolume.toFixed(0)}, код ${authorVolume.toFixed(0)}, глубина ${reviewDepth.toFixed(0)}, размер MR ${mrHeft.toFixed(0)}, баланс +${balanceBonus.toFixed(1)}.`,
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
