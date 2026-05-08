import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { getFormDefaultsFromEnv } from './formEnvDefaults'
import {
  TEAM_USERS,
  isPresetUsername,
} from './teamPresets'
import { ActivityByDayChart, type ActivitySeriesPoint } from './ActivityByDayChart'
import { formatDayRu } from './chartDates'
import './App.css'

const formDefaults = getFormDefaultsFromEnv()

function getInitialUserState(): { username: string; userEntryMode: 'list' | 'manual' } {
  const envUser = formDefaults.username.trim()
  if (!envUser) return { username: '', userEntryMode: 'list' }
  if (isPresetUsername(envUser)) return { username: envUser, userEntryMode: 'list' }
  return { username: envUser, userEntryMode: 'manual' }
}

const initialUser = getInitialUserState()

type Stats = {
  approved: string
  commented: string
  mrsCreated: string
  approvedMrsDiffLines: string
  avgLinesPerComment: string
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
  const [gitlabUrl, setGitlabUrl] = useState(formDefaults.gitlabUrl)
  const [token, setToken] = useState(formDefaults.token)
  const [username, setUsername] = useState(initialUser.username)
  const [userEntryMode, setUserEntryMode] = useState<'list' | 'manual'>(initialUser.userEntryMode)
  const [fetchedUserList, setFetchedUserList] = useState<{ username: string; name: string }[] | null>(null)
  const [usersListLoading, setUsersListLoading] = useState(false)
  const [usersListHint, setUsersListHint] = useState<string | null>(null)
  const [usersListError, setUsersListError] = useState<string | null>(null)
  const [userPickerOpen, setUserPickerOpen] = useState(false)
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [userListHighlight, setUserListHighlight] = useState(0)
  const userPickerRef = useRef<HTMLDivElement>(null)
  const userPickerSearchRef = useRef<HTMLInputElement>(null)
  const [startDate, setStartDate] = useState(formDefaults.startDate)
  const [endDate, setEndDate] = useState(formDefaults.endDate)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolvedName, setResolvedName] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [activityByDay, setActivityByDay] = useState<ActivitySeriesPoint[] | null>(null)
  const [detailByDay, setDetailByDay] = useState<Record<string, DayDetailItem[]> | null>(null)
  const [detailDay, setDetailDay] = useState<string | null>(null)
  const [detailItems, setDetailItems] = useState<DayDetailItem[]>([])

  const canSubmit = useMemo(() => {
    return Boolean(gitlabUrl.trim() && token.trim() && username.trim() && startDate.trim())
  }, [gitlabUrl, token, username, startDate])

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

  async function loadStats() {
    setError(null)
    setStats(null)
    setActivityByDay(null)
    setDetailByDay(null)
    setDetailDay(null)
    setDetailItems([])
    setResolvedName(null)

    const range = rangeFromInputs(startDate, endDate)
    if (!range) {
      setError('Выберите корректный период.')
      return
    }

    const afterMs = Date.parse(range.after)
    const beforeMs = Date.parse(range.before)
    if (afterMs > beforeMs) {
      setError('Дата начала позже даты конца.')
      return
    }

    setLoading(true)
    try {
      const user = await postJson<{ id: number; username: string }>('/api/resolve-user', {
        gitlabUrl,
        token,
        username,
      })
      setResolvedName(user.username)

      const basePayload = {
        gitlabUrl,
        token,
        userId: user.id,
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
          userId: user.id,
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
          userId: user.id,
          after: range.after,
          before: range.before,
          startDate,
          endDate: endDate.trim() || todayLocalYmd(),
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

      setStats({
        approved: approvedRes.total,
        commented: String(commentCount),
        mrsCreated: mrsRes.total,
        approvedMrsDiffLines: diffLinesTotal.toLocaleString('ru-RU'),
        avgLinesPerComment: avgLines,
      })

      const points: ActivitySeriesPoint[] = byDayRes.days.map((day, i) => ({
        day,
        approved: byDayRes.approved[i] ?? 0,
        commented: byDayRes.commented[i] ?? 0,
        mrsCreated: byDayRes.mrsCreated[i] ?? 0,
      }))
      setActivityByDay(points)
      setDetailByDay(byDayRes.detailByDay ?? {})
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
    if (!gitlabUrl.trim() || !token.trim() || !username.trim() || !startDate.trim()) return

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
    setDetailItems([])
  }

  function openDayDetail(day: string) {
    setDetailDay(day)
    setDetailItems(detailByDay?.[day] ?? [])
  }

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

            <div className="field-row">
              <label className="field">
                <span>Дата начала</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Дата конца</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  aria-describedby="end-date-hint"
                />
                <span id="end-date-hint" className="hint">
                  Если не указать, используется сегодняшняя дата.
                </span>
              </label>
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

          {stats ? (
            <>
              <div className="stat-grid">
                <article className="stat-card stat-approved">
                  <div className="stat-label">Одобренных MR</div>
                  <div className="stat-value">{stats.approved}</div>
                  <p className="stat-caption">События с действием approved</p>
                </article>
                <article className="stat-card stat-comments">
                  <div className="stat-label">Комментариев</div>
                  <div className="stat-value">{stats.commented}</div>
                  <p className="stat-caption">
                    Только комментарии в MR <strong>других</strong> авторов; ваши собственные MR не учитываются.
                  </p>
                </article>
                <article className="stat-card stat-created">
                  <div className="stat-label">Созданных MR</div>
                  <div className="stat-value">{stats.mrsCreated}</div>
                  <p className="stat-caption">
                    MR с автором-пользователем.
                  </p>
                </article>
                <article className="stat-card stat-ratio">
                  <div className="stat-label">Комментариев на одно одобрение</div>
                  <div className="stat-value stat-value--ratio">
                    {formatCommentsPerApproval(stats.approved, stats.commented)}
                  </div>
                  <p className="stat-caption">
                    Отношение таких комментариев к числу одобрений за период;
                  </p>
                </article>
                <article className="stat-card stat-diff-lines">
                  <div className="stat-label">Строк диффа в одобрённых MR</div>
                  <div className="stat-value">{stats.approvedMrsDiffLines}</div>
                  <p className="stat-caption">
                    Сумма добавленных и удалённых строк по диффу для <strong>уникальных</strong> merge request из
                    событий approved.
                  </p>
                </article>
                <article className="stat-card stat-avg-lines">
                  <div className="stat-label">Строк диффа на 1 комментарий</div>
                  <div className="stat-value stat-value--ratio">{stats.avgLinesPerComment}</div>
                  <p className="stat-caption">
                    Отношение суммы строк из предыдущей карточки к числу комментариев в <strong>чужих</strong> MR за тот
                    же период;
                  </p>
                </article>
              </div>

            </>
          ) : (
            !error && (
              <div className="placeholder">
                <p>
                  Заполните форму слева. Если уже указаны GitLab, токен и период, статистика запросится сама при
                  выборе сотрудника из списка; иначе нажмите «Показать статистику».
                </p>
              </div>
            )
          )}
        </section>
        </div>

        {stats && activityByDay && activityByDay.length > 0 ? (
          <section className="chart-fullwidth card chart-card" aria-labelledby="activity-chart-title">
            <h2 className="chart-title" id="activity-chart-title">
              Активность по дням
            </h2>
            <p className="chart-lead">
              Распределение по календарным дням в часовом поясе браузера: созданные MR, одобрения и комментарии в
              MR.
            </p>
            <ActivityByDayChart
              points={activityByDay}
              selectedDay={detailDay}
              onDayClick={detailByDay != null ? openDayDetail : undefined}
            />

            {detailDay ? (
              <div className="day-detail">
                <div className="day-detail-head">
                  <h3 className="day-detail-title">{formatDayRu(detailDay)}</h3>
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
