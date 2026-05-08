import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  TEAM_USERS,
} from './teamPresets'
import {
  createEmptyPeriodRow,
  getInitialFormBootstrap,
  savePersistedForm,
  type PersistedPeriod,
} from './formPersistence'
import { ActivityByDayChart, type ActivitySeriesPoint } from './ActivityByDayChart'
import { formatDayRu } from './chartDates'
import './App.css'

const initialForm = getInitialFormBootstrap()

type Stats = {
  approved: string
  commented: string
  mrsCreated: string
  approvedMrsDiffLines: string
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
        detailByDay: Record<string, DayDetailItem[]>
        approvedMrsDiffLinesTotal: number
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
      avgLinesPerComment: avgLines,
    }

    const points: ActivitySeriesPoint[] = byDayRes.days.map((day, i) => ({
      day,
      approved: byDayRes.approved[i] ?? 0,
      commented: byDayRes.commented[i] ?? 0,
      mrsCreated: byDayRes.mrsCreated[i] ?? 0,
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

  const skipUserEffectRef = useRef(true)

  useEffect(() => {
    if (skipUserEffectRef.current) {
      skipUserEffectRef.current = false
      return
    }
    if (userEntryMode !== 'list') return
    if (!gitlabUrl.trim() || !token.trim() || !username.trim() || !primaryStartDate) return

    const id = window.setTimeout(() => {
      void loadStats()
    }, 0)
    return () => window.clearTimeout(id)
    // Только смена выбора из списка / режима ввода — не при редактировании URL, токена и дат.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, userEntryMode])

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

  const detailContextPeriod =
    detailPeriodId && periodResults ? periodResults.find((p) => p.id === detailPeriodId) : undefined

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-badge">GitLab</div>
        <h1>Статистика активности</h1>
        <p className="hero-lead">
          Одобрения merge request и комментарии за выбранный период. Данные берутся из событий пользователя
          через API GitLab (заголовок <code className="inline-code">X-Total</code>).
        </p>
      </header>

      <main className="main-area">
        <div className="layout">
        <section className="card form-card">
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
        </section>

        <section className="results">
          {error ? (
            <div className="notice notice-error" role="alert">
              {error}
            </div>
          ) : null}

          {resolvedName ? (
            <p className="resolved">
              Пользователь:{' '}
              <strong>{resolveUserDisplayName(resolvedName) ?? `@${resolvedName}`}</strong>
            </p>
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
                          <th scope="col">№</th>
                          <th scope="col">Диапазон</th>
                          <th scope="col">Дней</th>
                          <th scope="col">Одобр.</th>
                          <th scope="col">Комм.</th>
                          <th scope="col">MR</th>
                          <th scope="col">Стр. диффа</th>
                          <th scope="col">Комм./одобр.</th>
                          <th scope="col">Стр./комм.</th>
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
                <div className="stat-grid">
                  <article className="stat-card stat-approved">
                    <div className="stat-label">Одобренных MR</div>
                    <div className="stat-value">{periodResults[0].stats.approved}</div>
                    <p className="stat-caption">События с действием approved</p>
                  </article>
                  <article className="stat-card stat-comments">
                    <div className="stat-label">Комментариев</div>
                    <div className="stat-value">{periodResults[0].stats.commented}</div>
                    <p className="stat-caption">
                      Только комментарии в MR <strong>других</strong> авторов; ваши собственные MR не учитываются.
                    </p>
                  </article>
                  <article className="stat-card stat-created">
                    <div className="stat-label">Созданных MR</div>
                    <div className="stat-value">{periodResults[0].stats.mrsCreated}</div>
                    <p className="stat-caption">MR с автором-пользователем.</p>
                  </article>
                  <article className="stat-card stat-ratio">
                    <div className="stat-label">Комментариев на одно одобрение</div>
                    <div className="stat-value stat-value--ratio">
                      {formatCommentsPerApproval(periodResults[0].stats.approved, periodResults[0].stats.commented)}
                    </div>
                    <p className="stat-caption">
                      Отношение таких комментариев к числу одобрений за период;
                    </p>
                  </article>
                  <article className="stat-card stat-diff-lines">
                    <div className="stat-label">Строк диффа в одобрённых MR</div>
                    <div className="stat-value">{periodResults[0].stats.approvedMrsDiffLines}</div>
                    <p className="stat-caption">
                      Сумма добавленных и удалённых строк по диффу для <strong>уникальных</strong> merge request из
                      событий approved.
                    </p>
                  </article>
                  <article className="stat-card stat-avg-lines">
                    <div className="stat-label">Строк диффа на 1 комментарий</div>
                    <div className="stat-value stat-value--ratio">{periodResults[0].stats.avgLinesPerComment}</div>
                    <p className="stat-caption">
                      Отношение суммы строк из предыдущей карточки к числу комментариев в <strong>чужих</strong> MR за
                      тот же период;
                    </p>
                  </article>
                </div>
              ) : null}
            </>
          ) : (
            !error && (
              <div className="placeholder">
                <p>
                  Заполните форму слева. Параметры формы сохраняются в этом браузере (localStorage) и подставляются при
                  следующем открытии. Если уже указаны GitLab, токен и основной период, статистика запросится сама при
                  выборе сотрудника из списка; иначе нажмите «Показать статистику».
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
              Распределение по календарным дням в часовом поясе браузера: созданные MR, одобрения и комментарии в MR.
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
                  Список событий за день совпадает с данными графика. Ссылки ведут в GitLab.
                </p>
                {detailItems.length === 0 ? (
                  <p className="day-detail-empty">За этот день событий не найдено.</p>
                ) : (
                  <ul className="day-detail-list">
                    {detailItems.map((item) => (
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
                          </div>
                          {item.kind === 'commented' && item.commentBody ? (
                            <div className="day-detail-comment">{item.commentBody}</div>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </section>
        ) : null}
      </main>

      <footer className="footer">
        <span>Локальный инструмент · API v4 · events, merge_requests</span>
      </footer>
    </div>
  )
}
