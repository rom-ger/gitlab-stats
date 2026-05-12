import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  TEAM_USERS,
} from './teamPresets'
import {
  createEmptyPeriodRow,
  getInitialFormBootstrap,
  savePersistedForm,
  type PersistedPeriod,
} from './formPersistence'
import {
  ActivityByDayChart,
  ACTIVITY_SERIES_DEFAULT_VISIBILITY,
  type ActivitySeriesKey,
  type ActivitySeriesPoint,
} from './ActivityByDayChart'
import { formatDayRu } from './chartDates'
import './App.css'

const initialForm = getInitialFormBootstrap()

/** Подсказки к заголовкам таблицы сравнения периодов (нативный title / курсор help). */
const COMPARE_TABLE_COL_HINTS = {
  index: 'Порядковый номер периода в сравнении.',
  range:
    'Календарные границы: дата начала и дата конца (если конец не задан, используется сегодняшняя дата).',
  days: 'Число календарных дней в ряду графика активности (часовой пояс браузера).',
  approved: 'Количество событий одобрения merge request (approved) за период.',
  commented:
    'Комментарии пользователя в merge request других авторов; комментарии в собственных MR не учитываются.',
  mrsCreated:
    'Число merge request с автором-пользователем за период с целевой веткой develop или dev (GitLab target_branch).',
  diffLines:
    'Сумма добавленных и удалённых строк по диффу для уникальных MR из событий одобрения за период.',
  createdDiffLines:
    'Сумма строк диффа по уникальным MR автора с target_branch develop или dev, созданным за период.',
  avgCreatedDiffPerDay:
    'Средняя сумма строк диффа по таким MR на календарный день периода (сумма / число дней в ряду).',
  avgCreatedDiffPerMr:
    'Средняя сумма строк диффа на один такой MR: сумма диффа / число MR в колонке «MR» (только develop и dev).',
  commPerAppr:
    'Отношение числа комментариев в чужих MR к числу одобрений за тот же период (комментариев на одно одобрение).',
  linesPerComm:
    'Отношение суммы строк диффа в одобрённых MR к числу комментариев в чужих MR за период (строк на один комментарий).',
} as const

type Stats = {
  approved: string
  commented: string
  mrsCreated: string
  approvedMrsDiffLines: string
  createdMrsDiffLines: string
  avgCreatedMrsDiffLinesPerDay: string
  avgCreatedMrsDiffLinesPerMr: string
  avgLinesPerComment: string
}

type PeriodResult = {
  id: string
  label: string
  startDate: string
  endDateInput: string
  endEffectiveYmd: string
  stats: Stats
  activityByDay: ActivitySeriesPoint[]
  detailByDay: Record<string, DayDetailItem[]>
}

type DayDetailItem = {
  id: string
  kind: 'approved' | 'commented' | 'mr_created'
  title: string
  createdAt: string
  webUrl: string | null
  commentBody?: string | null
  /** Сумма добавленных и удалённых строк в диффе MR, если известна из загрузки периода. */
  mrDiffLines?: number | null
  /** Число изменённых файлов (changes_count), если есть в ответе GitLab. */
  mrChangesCount?: number | null
}

function formatEventTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function dayDetailKindLabel(kind: DayDetailItem['kind']): string {
  if (kind === 'mr_created') return 'MR'
  if (kind === 'approved') return 'Одобрение'
  return 'Комментарий'
}

function dayDetailKindClass(kind: DayDetailItem['kind']): string {
  if (kind === 'mr_created') return 'day-detail-kind day-detail-kind--mr'
  if (kind === 'approved') return 'day-detail-kind day-detail-kind--approved'
  return 'day-detail-kind day-detail-kind--commented'
}

function formatRuChangedFiles(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  const num = n.toLocaleString('ru-RU')
  if (mod10 === 1 && mod100 !== 11) return `${num} файл`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${num} файла`
  return `${num} файлов`
}

/** Размер MR в строке детализации: только из уже полученных данных. */
function dayDetailMrSizeBadge(item: DayDetailItem): { text: string; title: string } | null {
  const lines =
    item.mrDiffLines != null && Number.isFinite(item.mrDiffLines) ? Math.trunc(item.mrDiffLines) : null
  const linePart = lines != null ? `±${lines.toLocaleString('ru-RU')} стр.` : null
  const fc =
    item.mrChangesCount != null && Number.isFinite(item.mrChangesCount)
      ? Math.max(0, Math.trunc(item.mrChangesCount))
      : null
  const filePart = fc != null && fc > 0 ? formatRuChangedFiles(fc) : null
  if (!linePart && !filePart) return null
  const text = [linePart, filePart].filter(Boolean).join(' · ')
  let title =
    'Размер MR из ответов GitLab при загрузке периода (без отдельных запросов для этой таблицы).'
  if (linePart && filePart) {
    title =
      'Строки диффа (добавления+удаления) и число изменённых файлов (changes_count), как в API.'
  } else if (linePart) {
    title =
      'Сумма добавленных и удалённых строк в диффе. Для комментариев совпадает с MR из одобрений за период либо берётся из вложенных полей события, если GitLab их отдал.'
  } else if (filePart) {
    title = 'Число изменённых файлов по полю changes_count в объекте merge request.'
  }
  return { text, title }
}

function todayLocalYmd(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function padDateParts(y: number, m: number, d: number): { start: string; end: string } {
  const startLocal = new Date(y, m - 1, d, 0, 0, 0, 0)
  const endLocal = new Date(y, m - 1, d, 23, 59, 59, 999)
  return {
    start: startLocal.toISOString(),
    end: endLocal.toISOString(),
  }
}

function rangeFromInputs(startDate: string, endDate: string): { after: string; before: string } | null {
  if (!startDate?.trim()) return null
  const endYmd = endDate?.trim() || todayLocalYmd()
  const [sy, sm, sd] = startDate.split('-').map(Number)
  const [ey, em, ed] = endYmd.split('-').map(Number)
  if (!sy || !sm || !sd || !ey || !em || !ed) return null
  const start = padDateParts(sy, sm, sd)
  const end = padDateParts(ey, em, ed)
  return { after: start.start, before: end.end }
}

/** Приблизительная метрика: отношение числа событий commented к approved за тот же период. */
function formatCommentsPerApproval(approvedRaw: string, commentedRaw: string): string {
  const approved = Number.parseInt(approvedRaw, 10)
  const commented = Number.parseInt(commentedRaw, 10)
  if (!Number.isFinite(approved) || !Number.isFinite(commented)) return '—'
  if (approved <= 0) return '—'
  const ratio = commented / approved
  return ratio.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 2 })
}

function ruPeriodCountLabel(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} период`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} периода`
  return `${n} периодов`
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await r.json()) as T & { error?: string }
  if (!r.ok) {
    throw new Error(data.error ?? `Ошибка ${r.status}`)
  }
  return data
}

export default function App() {
  const [gitlabUrl, setGitlabUrl] = useState(initialForm.gitlabUrl)
  const [token, setToken] = useState(initialForm.token)
  const [username, setUsername] = useState(initialForm.username)
  const [userEntryMode, setUserEntryMode] = useState<'list' | 'manual'>(initialForm.userEntryMode)
  const [fetchedUserList, setFetchedUserList] = useState<{ username: string; name: string }[] | null>(null)
  const [usersListLoading, setUsersListLoading] = useState(false)
  const [usersListHint, setUsersListHint] = useState<string | null>(null)
  const [usersListError, setUsersListError] = useState<string | null>(null)
  const [userPickerOpen, setUserPickerOpen] = useState(false)
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [userListHighlight, setUserListHighlight] = useState(0)
  const userPickerRef = useRef<HTMLDivElement>(null)
  const userPickerSearchRef = useRef<HTMLInputElement>(null)
  const [periodRows, setPeriodRows] = useState<PersistedPeriod[]>(initialForm.periods)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolvedName, setResolvedName] = useState<string | null>(null)
  const [periodResults, setPeriodResults] = useState<PeriodResult[] | null>(null)
  const [detailDay, setDetailDay] = useState<string | null>(null)
  const [detailPeriodId, setDetailPeriodId] = useState<string | null>(null)
  const [detailItems, setDetailItems] = useState<DayDetailItem[]>([])
  const [chartVisibilityByPeriod, setChartVisibilityByPeriod] = useState<
    Record<string, Record<ActivitySeriesKey, boolean>>
  >({})
  const [settingsOpen, setSettingsOpen] = useState(false)

  const primaryStartDate = periodRows[0]?.startDate?.trim() ?? ''

  const canSubmit = useMemo(() => {
    if (!gitlabUrl.trim() || !token.trim() || !username.trim()) return false
    if (!primaryStartDate) return false
    return periodRows.every((row) => {
      if (!row.startDate.trim()) return true
      const range = rangeFromInputs(row.startDate, row.endDate)
      if (!range) return false
      return Date.parse(range.after) <= Date.parse(range.before)
    })
  }, [gitlabUrl, token, username, primaryStartDate, periodRows])

  useEffect(() => {
    const id = window.setTimeout(() => {
      savePersistedForm({
        v: 2,
        gitlabUrl,
        token,
        username,
        userEntryMode,
        periods: periodRows.map((r) => ({ id: r.id, startDate: r.startDate, endDate: r.endDate })),
      })
    }, 400)
    return () => window.clearTimeout(id)
  }, [gitlabUrl, token, username, userEntryMode, periodRows])

  useEffect(() => {
    if (!settingsOpen) return
    function onKeyDown(ev: globalThis.KeyboardEvent) {
      if (ev.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [settingsOpen])

  const mergedSelectUsers = useMemo(() => {
    const m = new Map<string, { username: string; name: string }>()
    for (const u of TEAM_USERS) m.set(u.username, { username: u.username, name: u.name })
    if (fetchedUserList) {
      for (const u of fetchedUserList) {
        if (!m.has(u.username)) m.set(u.username, u)
      }
    }
    return [...m.values()].sort((a, b) =>
      (a.name || a.username).localeCompare(b.name || b.username, 'ru', { sensitivity: 'base' }),
    )
  }, [fetchedUserList])

  const filteredSelectUsers = useMemo(() => {
    const q = userSearchQuery.trim().toLowerCase()
    if (!q) return mergedSelectUsers
    return mergedSelectUsers.filter(
      (u) => u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q),
    )
  }, [mergedSelectUsers, userSearchQuery])

  const userPickerOtherIndex =
    filteredSelectUsers.length > 0 ? filteredSelectUsers.length : 0

  const safeListHighlight = Math.min(userListHighlight, userPickerOtherIndex)

  useEffect(() => {
    if (!userPickerOpen) return
    const id = requestAnimationFrame(() => userPickerSearchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [userPickerOpen])

  useEffect(() => {
    if (!userPickerOpen) return
    function handlePointerDown(ev: MouseEvent) {
      const root = userPickerRef.current
      if (!root || !(ev.target instanceof Node) || root.contains(ev.target)) return
      setUserPickerOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [userPickerOpen])

  function selectUserFromList(u: { username: string; name: string }) {
    setUserEntryMode('list')
    setUsername(u.username)
    setUserPickerOpen(false)
    setUserSearchQuery('')
    setUserListHighlight(0)
    setSettingsOpen(false)
  }

  function pickOtherUser() {
    setUserEntryMode('manual')
    setUsername('')
    setUserPickerOpen(false)
    setUserSearchQuery('')
    setUserListHighlight(0)
  }

  function backToUserList() {
    setUserEntryMode('list')
    setUsername('')
    setUserPickerOpen(false)
    setUserSearchQuery('')
    setUserListHighlight(0)
  }

  function confirmUserPickerSelection() {
    const hi = safeListHighlight
    const n = filteredSelectUsers.length
    if (n === 0) {
      pickOtherUser()
      return
    }
    if (hi <= n - 1) {
      selectUserFromList(filteredSelectUsers[hi])
    } else {
      pickOtherUser()
    }
  }

  function handleUserPickerSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setUserPickerOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setUserListHighlight((h) =>
        Math.min(Math.min(h, userPickerOtherIndex) + 1, userPickerOtherIndex),
      )
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setUserListHighlight((h) => Math.max(Math.min(h, userPickerOtherIndex) - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      confirmUserPickerSelection()
    }
  }

  function resolveUserDisplayName(login: string | null): string | undefined {
    if (!login) return undefined
    const preset = TEAM_USERS.find((u) => u.username === login)
    if (preset) return preset.name
    const remote = fetchedUserList?.find((u) => u.username === login)
    if (remote?.name) return remote.name
    return login
  }

  function updatePeriodRow(id: string, patch: Partial<Pick<PersistedPeriod, 'startDate' | 'endDate'>>) {
    setPeriodRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function addComparePeriod() {
    setPeriodRows((rows) => [...rows, createEmptyPeriodRow()])
  }

  function removePeriodRow(id: string) {
    setPeriodRows((rows) => (rows.length <= 1 ? rows : rows.filter((r) => r.id !== id)))
  }

  async function fetchOnePeriodData(
    userId: number,
    row: PersistedPeriod,
    label: string,
  ): Promise<PeriodResult> {
    const range = rangeFromInputs(row.startDate, row.endDate)
    if (!range) {
      throw new Error(`Период «${label}»: некорректные даты.`)
    }
    const afterMs = Date.parse(range.after)
    const beforeMs = Date.parse(range.before)
    if (afterMs > beforeMs) {
      throw new Error(`Период «${label}»: дата начала позже даты конца.`)
    }

    const endEffectiveYmd = row.endDate.trim() || todayLocalYmd()
    const basePayload = {
      gitlabUrl,
      token,
      userId,
      after: range.after,
      before: range.before,
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

    const [approvedRes, mrsRes, byDayRes] = await Promise.all([
      postJson<{ total: string }>('/api/events-total', {
        ...basePayload,
        action: 'approved',
      }),
      postJson<{ total: string }>('/api/merge-requests-total', {
        gitlabUrl,
        token,
        userId,
        createdAfter: range.after,
        createdBefore: range.before,
      }),
      postJson<{
        days: string[]
        approved: number[]
        commented: number[]
        mrsCreated: number[]
        mrsCreatedDiffLinesByDay?: number[]
        detailByDay: Record<string, DayDetailItem[]>
        approvedMrsDiffLinesTotal: number
        createdMrsDiffLinesTotal?: number
        foreignMrCommentCount: number
        avgLinesPerComment: number | null
      }>('/api/activity-by-day', {
        gitlabUrl,
        token,
        userId,
        after: range.after,
        before: range.before,
        startDate: row.startDate,
        endDate: endEffectiveYmd,
        timeZone,
      }),
    ])

    const commentedSum = byDayRes.commented.reduce((s, n) => s + (n ?? 0), 0)
    const commentCount =
      typeof byDayRes.foreignMrCommentCount === 'number' ? byDayRes.foreignMrCommentCount : commentedSum

    const diffLinesTotal =
      typeof byDayRes.approvedMrsDiffLinesTotal === 'number' && Number.isFinite(byDayRes.approvedMrsDiffLinesTotal)
        ? byDayRes.approvedMrsDiffLinesTotal
        : 0
    const createdDiffTotal =
      typeof byDayRes.createdMrsDiffLinesTotal === 'number' && Number.isFinite(byDayRes.createdMrsDiffLinesTotal)
        ? byDayRes.createdMrsDiffLinesTotal
        : 0
    const calendarDays = byDayRes.days.length
    const avgCreatedPerDayStr =
      calendarDays > 0
        ? (createdDiffTotal / calendarDays).toLocaleString('ru-RU', {
            maximumFractionDigits: 1,
            minimumFractionDigits: 0,
          })
        : '—'
    const mrsCreatedNum = Number.parseInt(mrsRes.total, 10)
    const avgCreatedPerMrStr =
      Number.isFinite(mrsCreatedNum) && mrsCreatedNum > 0
        ? (createdDiffTotal / mrsCreatedNum).toLocaleString('ru-RU', {
            maximumFractionDigits: 1,
            minimumFractionDigits: 0,
          })
        : '—'
    const avgLines =
      byDayRes.avgLinesPerComment != null && Number.isFinite(byDayRes.avgLinesPerComment)
        ? byDayRes.avgLinesPerComment.toLocaleString('ru-RU', {
            maximumFractionDigits: 1,
            minimumFractionDigits: 0,
          })
        : '—'

    const stats: Stats = {
      approved: approvedRes.total,
      commented: String(commentCount),
      mrsCreated: mrsRes.total,
      approvedMrsDiffLines: diffLinesTotal.toLocaleString('ru-RU'),
      createdMrsDiffLines: createdDiffTotal.toLocaleString('ru-RU'),
      avgCreatedMrsDiffLinesPerDay: avgCreatedPerDayStr,
      avgCreatedMrsDiffLinesPerMr: avgCreatedPerMrStr,
      avgLinesPerComment: avgLines,
    }

    const points: ActivitySeriesPoint[] = byDayRes.days.map((day, i) => ({
      day,
      approved: byDayRes.approved[i] ?? 0,
      commented: byDayRes.commented[i] ?? 0,
      mrsCreated: byDayRes.mrsCreated[i] ?? 0,
      mrsCreatedDiffLines: byDayRes.mrsCreatedDiffLinesByDay?.[i] ?? 0,
    }))

    return {
      id: row.id,
      label,
      startDate: row.startDate,
      endDateInput: row.endDate,
      endEffectiveYmd,
      stats,
      activityByDay: points,
      detailByDay: byDayRes.detailByDay ?? {},
    }
  }

  async function loadStats() {
    setError(null)
    setPeriodResults(null)
    setDetailDay(null)
    setDetailPeriodId(null)
    setDetailItems([])
    setChartVisibilityByPeriod({})
    setResolvedName(null)

    if (!periodRows[0]?.startDate.trim()) {
      setError('Укажите дату начала основного периода.')
      return
    }

    const activeRows = periodRows.filter((r) => r.startDate.trim())
    if (activeRows.length === 0) {
      setError('Нет периодов с заполненной датой начала.')
      return
    }

    for (let i = 0; i < activeRows.length; i++) {
      const row = activeRows[i]
      const range = rangeFromInputs(row.startDate, row.endDate)
      if (!range) {
        setError(`Период ${i + 1}: некорректные даты.`)
        return
      }
      if (Date.parse(range.after) > Date.parse(range.before)) {
        setError(`Период ${i + 1}: дата начала позже даты конца.`)
        return
      }
    }

    setLoading(true)
    try {
      const user = await postJson<{ id: number; username: string }>('/api/resolve-user', {
        gitlabUrl,
        token,
        username,
      })
      setResolvedName(user.username)

      const results = await Promise.all(
        activeRows.map((row, i) => {
          const label =
            activeRows.length === 1 ? 'Период' : i === 0 ? `Период 1 · основной` : `Период ${i + 1}`
          return fetchOnePeriodData(user.id, row, label)
        }),
      )
      setPeriodResults(results)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Неизвестная ошибка.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!canSubmit) return
    const id = window.setTimeout(() => {
      void loadStats()
    }, 0)
    return () => window.clearTimeout(id)
    // Автозагрузка при старте (полная форма из localStorage) и при смене пользователя/режима.
    // URL, токен и даты без смены этих полей не триггерят запрос — нужна кнопка «Показать статистику».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, userEntryMode, canSubmit])

  async function handleLoadUserList() {
    setUsersListError(null)
    setUsersListHint(null)
    if (!gitlabUrl.trim() || !token.trim()) {
      setUsersListError('Сначала укажите адрес GitLab и токен.')
      return
    }
    setUsersListLoading(true)
    try {
      const data = await postJson<{ users: { username: string; name: string }[]; count: number }>(
        '/api/list-users',
        { gitlabUrl, token },
      )
      setFetchedUserList(data.users)
      setUsersListHint(
        data.count > 0
          ? `Из GitLab загружено ${data.count} пользователей; список объединён с пресетом команды.`
          : 'GitLab вернул пустой список — возможно, у токена нет права читать пользователей.',
      )
    } catch (err) {
      setUsersListError(err instanceof Error ? err.message : 'Не удалось загрузить список')
    } finally {
      setUsersListLoading(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (userEntryMode === 'list' && !username.trim()) {
      setError('Выберите сотрудника из списка.')
      return
    }
    setSettingsOpen(false)
    await loadStats()
  }

  function closeDayDetail() {
    setDetailDay(null)
    setDetailPeriodId(null)
    setDetailItems([])
  }

  function openDayDetail(day: string, periodId: string) {
    const pr = periodResults?.find((p) => p.id === periodId)
    setDetailDay(day)
    setDetailPeriodId(periodId)
    setDetailItems(pr?.detailByDay[day] ?? [])
  }

  function periodRowTitle(index: number): string {
    if (index === 0) return 'Основной период'
    return `Период для сравнения ${index}`
  }

  function formatPeriodRangeShort(pr: PeriodResult): string {
    const end = pr.endDateInput.trim() ? pr.endDateInput : pr.endEffectiveYmd
    return `${pr.startDate} — ${end}`
  }

  const appBarContext = useMemo(() => {
    if (!resolvedName) return null
    let periodBit = ''
    if (periodResults && periodResults.length === 1) {
      periodBit = formatPeriodRangeShort(periodResults[0])
    } else if (periodResults && periodResults.length > 1) {
      periodBit = ruPeriodCountLabel(periodResults.length)
    } else if (primaryStartDate && periodRows[0]) {
      const row = periodRows[0]
      const end = row.endDate.trim() || '…'
      periodBit = `${row.startDate} — ${end}`
    }
    return {
      name: resolveUserDisplayName(resolvedName) ?? resolvedName,
      periodBit,
    }
  }, [resolvedName, periodResults, periodRows, primaryStartDate])

  const detailContextPeriod =
    detailPeriodId && periodResults ? periodResults.find((p) => p.id === detailPeriodId) : undefined

  const detailItemsFiltered = useMemo(() => {
    if (!detailPeriodId) return detailItems
    const vis =
      chartVisibilityByPeriod[detailPeriodId] ?? ACTIVITY_SERIES_DEFAULT_VISIBILITY
    return detailItems.filter((item) => {
      if (item.kind === 'approved') return vis.approved
      if (item.kind === 'commented') return vis.commented
      return vis.mrsCreated
    })
  }, [detailItems, detailPeriodId, chartVisibilityByPeriod])

  return (
    <div className="shell">
      <header className="app-bar">
        <div className="app-bar-inner">
          <div className="app-bar-brand">
            <span className="hero-badge">GitLab</span>
            <h1 className="app-bar-title">Статистика активности</h1>
          </div>
          <div className="app-bar-actions">
            {appBarContext ? (
              <span
                className="app-bar-summary"
                title={[appBarContext.name, appBarContext.periodBit].filter(Boolean).join(' · ')}
              >
                <span className="app-bar-summary-name">{appBarContext.name}</span>
                {appBarContext.periodBit ? (
                  <>
                    <span className="app-bar-summary-sep" aria-hidden>
                      ·
                    </span>
                    <span className="app-bar-summary-period">{appBarContext.periodBit}</span>
                  </>
                ) : null}
              </span>
            ) : null}
            <button
              type="button"
              className="app-bar-settings-btn"
              aria-expanded={settingsOpen}
              aria-controls="settings-drawer"
              onClick={() => setSettingsOpen(true)}
            >
              Параметры
            </button>
          </div>
        </div>
      </header>

      <main className="main-area">
        <div className="content-column">
        <section className="results card results-panel">
          {error ? (
            <div className="notice notice-error" role="alert">
              {error}
            </div>
          ) : null}

          {periodResults && periodResults.length > 0 ? (
            <>
              {periodResults.length > 1 ? (
                <div className="compare-wrap">
                  <h2 className="compare-heading">Сравнение периодов</h2>
                  <div className="compare-table-scroll">
                    <table className="compare-table">
                      <thead>
                        <tr>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.index}>
                            №
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.range}>
                            Диапазон
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.days}>
                            Дней
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.approved}>
                            Одобр.
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.commented}>
                            Комм.
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.mrsCreated}>
                            MR
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.diffLines}>
                            Стр. диффа (одобр.)
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.createdDiffLines}>
                            Стр. диффа (созд.)
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.avgCreatedDiffPerDay}>
                            Ср. стр./день (созд.)
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.avgCreatedDiffPerMr}>
                            Ср. стр./MR (созд.)
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.commPerAppr}>
                            Комм./одобр.
                          </th>
                          <th scope="col" title={COMPARE_TABLE_COL_HINTS.linesPerComm}>
                            Стр./комм.
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {periodResults.map((pr, i) => (
                          <tr key={pr.id}>
                            <td>{i + 1}</td>
                            <td>{formatPeriodRangeShort(pr)}</td>
                            <td>{pr.activityByDay.length}</td>
                            <td>{pr.stats.approved}</td>
                            <td>{pr.stats.commented}</td>
                            <td>{pr.stats.mrsCreated}</td>
                            <td>{pr.stats.approvedMrsDiffLines}</td>
                            <td>{pr.stats.createdMrsDiffLines}</td>
                            <td>{pr.stats.avgCreatedMrsDiffLinesPerDay}</td>
                            <td>{pr.stats.avgCreatedMrsDiffLinesPerMr}</td>
                            <td>{formatCommentsPerApproval(pr.stats.approved, pr.stats.commented)}</td>
                            <td>{pr.stats.avgLinesPerComment}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {periodResults.length === 1 ? (
                <div className="stat-groups">
                  <section
                    className="stat-group stat-group--reviews"
                    aria-labelledby="stat-group-reviews"
                    title="Одобрения и комментарии в чужих merge request. Наведите на карточку — краткое пояснение метрики."
                  >
                    <h3 className="stat-group-title" id="stat-group-reviews">
                      Рецензирование
                    </h3>
                    <div className="stat-grid stat-grid--in-group stat-grid--compact">
                      <article
                        className="stat-card stat-approved"
                        title="События с действием approved в GitLab."
                      >
                        <div className="stat-label">Одобренных MR</div>
                        <div className="stat-value">{periodResults[0].stats.approved}</div>
                      </article>
                      <article
                        className="stat-card stat-comments"
                        title="Только комментарии в merge request других авторов; комментарии в ваших собственных MR не учитываются."
                      >
                        <div className="stat-label">Комментариев</div>
                        <div className="stat-value">{periodResults[0].stats.commented}</div>
                      </article>
                      <article
                        className="stat-card stat-ratio"
                        title="Отношение числа комментариев в чужих MR к числу одобрений за тот же период."
                      >
                        <div className="stat-label">Комментариев на одно одобрение</div>
                        <div className="stat-value stat-value--ratio">
                          {formatCommentsPerApproval(
                            periodResults[0].stats.approved,
                            periodResults[0].stats.commented,
                          )}
                        </div>
                      </article>
                      <article
                        className="stat-card stat-diff-lines"
                        title="Сумма добавленных и удалённых строк по диффу для уникальных merge request из событий одобрения (approved) за период."
                      >
                        <div className="stat-label">Строк диффа в одобрённых MR</div>
                        <div className="stat-value">{periodResults[0].stats.approvedMrsDiffLines}</div>
                      </article>
                      <article
                        className="stat-card stat-avg-lines"
                        title="Отношение суммы строк диффа в одобрённых MR к числу комментариев в чужих MR за тот же период."
                      >
                        <div className="stat-label">Строк диффа на 1 комментарий</div>
                        <div className="stat-value stat-value--ratio">{periodResults[0].stats.avgLinesPerComment}</div>
                      </article>
                    </div>
                  </section>

                  <section
                    className="stat-group stat-group--own"
                    aria-labelledby="stat-group-own"
                    title="Созданные вами MR с merge в develop или dev (target_branch) и размер диффа. Наведите на карточку — пояснение."
                  >
                    <h3 className="stat-group-title" id="stat-group-own">
                      Собственный код
                    </h3>
                    <div className="stat-grid stat-grid--in-group stat-grid--compact">
                      <article
                        className="stat-card stat-created"
                        title="Число MR с вами автором и целевой веткой develop или dev (GitLab target_branch), созданных за период."
                      >
                        <div className="stat-label">Созданных MR</div>
                        <div className="stat-value">{periodResults[0].stats.mrsCreated}</div>
                      </article>
                      <article
                        className="stat-card stat-created-diff"
                        title="Сумма диффа по уникальным MR автора с target_branch develop или dev за период; те же величины, что в детализации по дню."
                      >
                        <div className="stat-label">Строк диффа в созданных MR</div>
                        <div className="stat-value">{periodResults[0].stats.createdMrsDiffLines}</div>
                      </article>
                      <article
                        className="stat-card stat-created-per-day"
                        title="Сумма строк диффа по MR в develop/dev, делённая на число календарных дней периода."
                      >
                        <div className="stat-label">Средняя сумма строк диффа в день</div>
                        <div className="stat-value stat-value--ratio">
                          {periodResults[0].stats.avgCreatedMrsDiffLinesPerDay}
                        </div>
                      </article>
                      <article
                        className="stat-card stat-created-per-mr"
                        title="Сумма диффа по таким MR, делённая на их число (карточка «Созданных MR» — только develop и dev)."
                      >
                        <div className="stat-label">Средняя сумма строк диффа на 1 MR</div>
                        <div className="stat-value stat-value--ratio">
                          {periodResults[0].stats.avgCreatedMrsDiffLinesPerMr}
                        </div>
                      </article>
                    </div>
                  </section>
                </div>
              ) : null}
            </>
          ) : (
            !error && (
              <div className="placeholder">
                <p>
                  Откройте «Параметры» вверху справа и заполните подключение к GitLab, сотрудника и периоды. Значения
                  сохраняются в этом браузере (localStorage). Если уже всё указано и выбран сотрудник из списка,
                  статистика подгрузится сама; иначе нажмите «Показать статистику» в панели.
                </p>
              </div>
            )
          )}
        </section>
        </div>

        {periodResults && periodResults.some((p) => p.activityByDay.length > 0) ? (
          <section className="chart-fullwidth card chart-card" aria-labelledby="activity-chart-title">
            <h2 className="chart-title" id="activity-chart-title">
              Активность по дням
            </h2>
            <p className="chart-lead">
              По дням (часовой пояс браузера): одобрения и комментарии в MR — левая шкала (количество событий);
              созданные вами MR <strong>в develop или dev</strong> — <strong>правая шкала</strong> (сумма строк диффа в MR за день; число MR — во
              всплывающей подсказке).
              {periodResults.length > 1
                ? ' Ниже — отдельный график для каждого периода; детализация по клику относится к выбранному графику.'
                : ''}
            </p>
            {periodResults.map((pr) => (
              <div key={pr.id} className="chart-period-block">
                {periodResults.length > 1 ? (
                  <h3 className="chart-period-title">
                    {pr.label}: {formatPeriodRangeShort(pr)}
                  </h3>
                ) : null}
                <ActivityByDayChart
                  points={pr.activityByDay}
                  selectedDay={detailPeriodId === pr.id ? detailDay : null}
                  onDayClick={
                    pr.activityByDay.length > 0 ? (day) => openDayDetail(day, pr.id) : undefined
                  }
                  visibility={chartVisibilityByPeriod[pr.id] ?? ACTIVITY_SERIES_DEFAULT_VISIBILITY}
                  onVisibilityChange={(next) =>
                    setChartVisibilityByPeriod((m) => ({ ...m, [pr.id]: next }))
                  }
                />
              </div>
            ))}

            {detailDay && detailPeriodId ? (
              <div className="day-detail">
                <div className="day-detail-head">
                  <h3 className="day-detail-title">
                    {formatDayRu(detailDay)}
                    {detailContextPeriod ? (
                      <span className="day-detail-period"> · {formatPeriodRangeShort(detailContextPeriod)}</span>
                    ) : null}
                  </h3>
                  <button type="button" className="day-detail-close" onClick={closeDayDetail}>
                    Закрыть
                  </button>
                </div>
                <p className="day-detail-hint">
                  Список событий за день учитывает видимые на графике серии (легенда под графиком): скрытые типы не
                  показываются. Ссылки ведут в GitLab. Размер MR (строки и/или файлы) — из ответов API при загрузке
                  периода.
                </p>
                {detailItemsFiltered.length === 0 ? (
                  <p className="day-detail-empty">
                    {detailItems.length === 0
                      ? 'За этот день событий не найдено.'
                      : 'Нет событий выбранных типов — включите серии в легенде графика.'}
                  </p>
                ) : (
                  <ul className="day-detail-list">
                    {detailItemsFiltered.map((item) => {
                      const sizeBadge = dayDetailMrSizeBadge(item)
                      return (
                      <li key={item.id} className="day-detail-item">
                        <span className="day-detail-time">{formatEventTime(item.createdAt)}</span>
                        <div className="day-detail-body">
                          <div className="day-detail-line">
                            <span className={dayDetailKindClass(item.kind)}>{dayDetailKindLabel(item.kind)}</span>
                            {item.webUrl ? (
                              <a
                                className="day-detail-link"
                                href={item.webUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {item.title}
                              </a>
                            ) : (
                              <span className="day-detail-text">{item.title}</span>
                            )}
                            {sizeBadge ? (
                              <span className="day-detail-mr-size" title={sizeBadge.title}>
                                {sizeBadge.text}
                              </span>
                            ) : null}
                          </div>
                          {item.kind === 'commented' && item.commentBody ? (
                            <div className="day-detail-comment">{item.commentBody}</div>
                          ) : null}
                        </div>
                      </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            ) : null}
          </section>
        ) : null}
        <div
          className={"settings-backdrop" + (settingsOpen ? " is-open" : "")}
          aria-hidden={!settingsOpen}
          onClick={() => setSettingsOpen(false)}
        />
        <div
          id="settings-drawer"
          className={"settings-drawer" + (settingsOpen ? " is-open" : "")}
          role="dialog"
          aria-modal="true"
          aria-hidden={!settingsOpen}
          aria-labelledby="settings-drawer-title"
        >
          <div className="settings-drawer-head">
            <div>
              <h2 className="settings-drawer-title" id="settings-drawer-title">
                Параметры
              </h2>
              <p className="settings-drawer-lead">
                Подключение к GitLab, сотрудник и периоды. Данные событий — через API (заголовок{' '}
                <code className="inline-code">X-Total</code>).
              </p>
            </div>
            <button
              type="button"
              className="settings-drawer-close"
              onClick={() => setSettingsOpen(false)}
            >
              Закрыть
            </button>
          </div>
          <div className="settings-drawer-body">
            <form className="form" onSubmit={handleSubmit}>
              <label className="field">
              <span>Адрес GitLab</span>
              <input
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://gitlab.example.com"
              value={gitlabUrl}
              onChange={(e) => setGitlabUrl(e.target.value)}
              required
              />
              </label>

              <label className="field">
              <span>Personal Access Token</span>
              <input
              type="password"
              autoComplete="off"
              placeholder="glpat-…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              />
              </label>

              <div className="field">
              <span>Сотрудник</span>
              <div className="field-select-row">
              {userEntryMode === 'list' ? (
              <div className="user-picker" ref={userPickerRef}>
              <button
              type="button"
              className="select-control user-picker-trigger"
              aria-expanded={userPickerOpen}
              aria-haspopup="listbox"
              id="user-picker-trigger"
              onClick={() => {
              setUserPickerOpen((o) => !o)
              if (!userPickerOpen) {
              setUserSearchQuery('')
              setUserListHighlight(0)
              }
              }}
              >
              <span className="user-picker-trigger-text">
              {username
              ? `${resolveUserDisplayName(username) ?? username} (${username})`
              : '— Выберите сотрудника —'}
              </span>
              </button>
              {userPickerOpen ? (
              <div className="user-picker-dropdown" role="listbox" aria-labelledby="user-picker-trigger">
              <input
              ref={userPickerSearchRef}
              type="search"
              className="user-picker-search"
              placeholder="Поиск по имени или логину…"
              value={userSearchQuery}
              onChange={(e) => {
              setUserSearchQuery(e.target.value)
              setUserListHighlight(0)
              }}
              onKeyDown={handleUserPickerSearchKeyDown}
              autoComplete="off"
              aria-label="Поиск по списку сотрудников"
              />
              <ul className="user-picker-options">
              {filteredSelectUsers.length === 0 ? (
              <li className="user-picker-empty" role="presentation">
              Нет совпадений — ниже можно перейти к ручному вводу логина.
              </li>
              ) : (
              filteredSelectUsers.map((u, i) => (
              <li key={u.username} role="none">
              <button
              type="button"
              role="option"
              aria-selected={username === u.username}
              className={`user-picker-option${i === safeListHighlight ? ' user-picker-option--active' : ''}`}
              onMouseEnter={() => setUserListHighlight(i)}
              onClick={() => selectUserFromList(u)}
              >
              <span className="user-picker-option-name">{u.name}</span>
              <span className="user-picker-option-login">({u.username})</span>
              </button>
              </li>
              ))
              )}
              <li role="none">
              <button
              type="button"
              role="option"
              className={`user-picker-option user-picker-option--other${safeListHighlight === userPickerOtherIndex ? ' user-picker-option--active' : ''}`}
              onMouseEnter={() => setUserListHighlight(userPickerOtherIndex)}
              onClick={pickOtherUser}
              >
              Другой пользователь…
              </button>
              </li>
              </ul>
              </div>
              ) : null}
              </div>
              ) : (
              <button type="button" className="select-control user-picker-trigger" onClick={backToUserList}>
              <span className="user-picker-trigger-text">← К списку сотрудников</span>
              </button>
              )}
              <button
              type="button"
              className="btn-inline"
              disabled={usersListLoading || !gitlabUrl.trim() || !token.trim()}
              onClick={() => void handleLoadUserList()}
              >
              {usersListLoading ? 'Загрузка…' : 'Из GitLab'}
              </button>
              </div>
              {usersListError ? (
              <p className="field-inline-msg field-inline-msg--error" role="alert">
              {usersListError}
              </p>
              ) : null}
              {usersListHint ? <p className="field-inline-msg hint">{usersListHint}</p> : null}
              </div>

              {userEntryMode === 'manual' ? (
              <label className="field">
              <span>Логин в GitLab</span>
              <input
              type="text"
              autoComplete="username"
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              />
              </label>
              ) : null}

              <div className="field periods-field">
              <span>Периоды</span>
              <p className="hint periods-hint">
              По умолчанию один период. Можно добавить ещё — данные загрузятся для каждого заполненного диапазона
              и появятся сравнительная таблица и отдельные графики.
              </p>
              <div className="period-rows">
              {periodRows.map((row, index) => (
              <div key={row.id} className="period-row card-nested">
              <div className="period-row-head">
              <span className="period-row-title">{periodRowTitle(index)}</span>
              {index > 0 ? (
              <button
              type="button"
              className="btn-inline btn-danger-ghost"
              onClick={() => removePeriodRow(row.id)}
              aria-label={`Удалить ${periodRowTitle(index)}`}
              >
              Удалить
              </button>
              ) : null}
              </div>
              <div className="field-row">
              <label className="field">
              <span>Дата начала</span>
              <input
              type="date"
              value={row.startDate}
              onChange={(e) => updatePeriodRow(row.id, { startDate: e.target.value })}
              required={index === 0}
              aria-required={index === 0}
              />
              </label>
              <label className="field">
              <span>Дата конца</span>
              <input
              type="date"
              value={row.endDate}
              onChange={(e) => updatePeriodRow(row.id, { endDate: e.target.value })}
              aria-describedby={index === 0 ? 'end-date-hint' : undefined}
              />
              {index === 0 ? (
              <span id="end-date-hint" className="hint">
              Если не указать, используется сегодняшняя дата.
              </span>
              ) : (
              <span className="hint">Пустой конец — по сегодня.</span>
              )}
              </label>
              </div>
              </div>
              ))}
              </div>
              <button type="button" className="btn-inline add-period-btn" onClick={addComparePeriod}>
              + Добавить период для сравнения
              </button>
              </div>

              <button className="submit" type="submit" disabled={!canSubmit || loading}>
              {loading ? 'Загрузка…' : 'Показать статистику'}
              </button>
            </form>
          </div>
        </div>

      </main>

      <footer className="footer">
        <span>Локальный инструмент · API v4 · events, merge_requests</span>
      </footer>

      {loading ? (
        <div className="global-loading" role="status" aria-live="polite" aria-busy="true">
          <div className="global-loading-inner">
            <div className="global-loading-spinner" aria-hidden />
            <span className="global-loading-label">Загрузка статистики…</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
