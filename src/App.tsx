import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { getFormDefaultsFromEnv } from './formEnvDefaults'
import {
  CUSTOM_SELECT_VALUE,
  TEAM_USERS,
  isPresetUsername,
  teamDisplayName,
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

function padDateParts(y: number, m: number, d: number): { start: string; end: string } {
  const startLocal = new Date(y, m - 1, d, 0, 0, 0, 0)
  const endLocal = new Date(y, m - 1, d, 23, 59, 59, 999)
  return {
    start: startLocal.toISOString(),
    end: endLocal.toISOString(),
  }
}

function rangeFromInputs(startDate: string, endDate: string): { after: string; before: string } | null {
  if (!startDate || !endDate) return null
  const [sy, sm, sd] = startDate.split('-').map(Number)
  const [ey, em, ed] = endDate.split('-').map(Number)
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
    return Boolean(gitlabUrl.trim() && token.trim() && username.trim() && startDate && endDate)
  }, [gitlabUrl, token, username, startDate, endDate])

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
        }>('/api/activity-by-day', {
          gitlabUrl,
          token,
          userId: user.id,
          after: range.after,
          before: range.before,
          startDate,
          endDate,
          timeZone,
        }),
      ])

      const commentedSum = byDayRes.commented.reduce((s, n) => s + (n ?? 0), 0)

      setStats({
        approved: approvedRes.total,
        commented: String(commentedSum),
        mrsCreated: mrsRes.total,
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
    if (!gitlabUrl.trim() || !token.trim() || !username.trim() || !startDate || !endDate) return

    const id = window.setTimeout(() => {
      void loadStats()
    }, 0)
    return () => window.clearTimeout(id)
    // Только смена выбора из списка / режима ввода — не при редактировании URL, токена и дат.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, userEntryMode])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
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
              <small className="hint">Токен отправляется только на локальный прокси, не в браузер GitLab.</small>
            </label>

            <label className="field">
              <span>Сотрудник</span>
              <select
                className="select-control"
                aria-label="Сотрудник из списка"
                value={userEntryMode === 'manual' ? CUSTOM_SELECT_VALUE : username}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === CUSTOM_SELECT_VALUE) {
                    setUserEntryMode('manual')
                    setUsername('')
                    return
                  }
                  setUserEntryMode('list')
                  setUsername(v)
                }}
                required={userEntryMode === 'list'}
              >
                <option value="">— Выберите из списка —</option>
                {TEAM_USERS.map((u) => (
                  <option key={u.username} value={u.username}>
                    {u.name}
                  </option>
                ))}
                <option value={CUSTOM_SELECT_VALUE}>Другой пользователь…</option>
              </select>
              <small className="hint">В списке отображаются только имена; логин подставляется автоматически.</small>
            </label>

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
                  required
                />
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
              <strong>{teamDisplayName(resolvedName) ?? `@${resolvedName}`}</strong>
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
                    Только комментарии в MR <strong>других</strong> авторов; ваши собственные MR не учитываются
                    (как на графике).
                  </p>
                </article>
                <article className="stat-card stat-created">
                  <div className="stat-label">Созданных MR</div>
                  <div className="stat-value">{stats.mrsCreated}</div>
                  <p className="stat-caption">
                    MR с автором-пользователем, дата создания в выбранном периоде (API merge_requests,
                    state=all)
                  </p>
                </article>
                <article className="stat-card stat-ratio">
                  <div className="stat-label">Комментариев на одно одобрение</div>
                  <div className="stat-value stat-value--ratio">
                    {formatCommentsPerApproval(stats.approved, stats.commented)}
                  </div>
                  <p className="stat-caption">
                    Отношение таких комментариев к числу одобрений за период; при отсутствии одобрений —
                    «—»
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
              MR. Данные собираются постранично из GitLab (до 40 000 событий на каждый тип). Комментарии в графике —
              только в <strong>чужих</strong> merge request.{' '}
              <strong>Клик по столбцу дня</strong> показывает тот же набор событий, что уже загружен для графика (без
              повторного запроса).
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
                  Список событий за день совпадает с данными графика (одна загрузка с сервера). Ссылки ведут в GitLab.
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
