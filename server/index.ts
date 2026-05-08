import cors from 'cors'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 8787
const isProd = process.env.NODE_ENV === 'production'

const app = express()
app.use(cors())
app.use(express.json({ limit: '32kb' }))

function normalizeBaseUrl(raw: string): string {
  let u = raw.trim()
  if (!/^https?:\/\//i.test(u)) {
    u = `https://${u}`
  }
  return u.replace(/\/+$/, '')
}

function readXTotal(headers: Headers): string | null {
  return headers.get('x-total')
}

async function gitlabFetch(
  url: string,
  token: string,
  method: 'HEAD' | 'GET',
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      'PRIVATE-TOKEN': token,
    },
    redirect: 'follow',
  })
}

const PER_PAGE = 100
const MAX_LIST_PAGES = 400

function compareYmd(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function nextYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d + 1)
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/** Каждый календарный день от start до end включительно (строки YYYY-MM-DD). */
function enumerateYmdInclusive(start: string, end: string): string[] {
  const out: string[] = []
  let cur = start
  while (compareYmd(cur, end) <= 0) {
    out.push(cur)
    cur = nextYmd(cur)
    if (out.length > 800) break
  }
  return out
}

function safeTimeZone(raw: string | undefined): string {
  const tz = (raw ?? 'UTC').trim() || 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz }).format(new Date())
    return tz
  } catch {
    return 'UTC'
  }
}

function dayKeyInTimeZone(iso: string, timeZone: string): string {
  const d = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  const day = parts.find((p) => p.type === 'day')?.value
  if (!y || !m || !day) return iso.slice(0, 10)
  return `${y}-${m}-${day}`
}

type GitlabItem = { created_at?: unknown }

async function collectGitlabPagesOnly(
  pageUrl: (page: number) => string,
  token: string,
): Promise<
  | { ok: true; items: GitlabItem[] }
  | { ok: false; status: number; message: string }
> {
  const items: GitlabItem[] = []
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const url = pageUrl(page)
    let r: Response
    try {
      r = await gitlabFetch(url, token, 'GET')
    } catch {
      return { ok: false, status: 502, message: 'Не удалось подключиться к GitLab.' }
    }
    if (!r.ok) {
      const text = await r.text()
      return {
        ok: false,
        status: r.status,
        message: text.slice(0, 400),
      }
    }
    const chunk = (await r.json()) as unknown
    if (!Array.isArray(chunk)) {
      return { ok: false, status: 502, message: 'Неожиданный ответ GitLab (ожидался массив).' }
    }
    for (const row of chunk) {
      if (row && typeof row === 'object') items.push(row as GitlabItem)
    }
    if (chunk.length < PER_PAGE) break
  }
  return { ok: true, items }
}

/** HEAD (или GET), читаем X-Total как у списков с пагинацией. */
async function respondWithGitlabListTotal(
  res: express.Response,
  url: string,
  token: string,
): Promise<void> {
  let response: Response
  try {
    response = await gitlabFetch(url, token.trim(), 'HEAD')
  } catch {
    res.status(502).json({ error: 'Не удалось подключиться к GitLab.' })
    return
  }

  let total = readXTotal(response.headers)

  if (total == null) {
    try {
      response = await gitlabFetch(url, token.trim(), 'GET')
      total = readXTotal(response.headers)
    } catch {
      res.status(502).json({ error: 'Не удалось подключиться к GitLab.' })
      return
    }
  }

  if (!response.ok && total == null) {
    const text = await response.text().catch(() => '')
    res.status(response.status).json({
      error: `GitLab ответил ${response.status}. ${text.slice(0, 400)}`,
    })
    return
  }

  res.json({
    total: total ?? '0',
    status: response.status,
  })
}

app.post('/api/resolve-user', async (req, res) => {
  const gitlabUrl = req.body?.gitlabUrl as string | undefined
  const token = req.body?.token as string | undefined
  const username = req.body?.username as string | undefined

  if (!gitlabUrl?.trim() || !token?.trim() || !username?.trim()) {
    res.status(400).json({ error: 'Укажите URL GitLab, токен и логин.' })
    return
  }

  const base = normalizeBaseUrl(gitlabUrl)
  const q = new URLSearchParams({ username: username.trim() })
  const url = `${base}/api/v4/users?${q}`

  let r: Response
  try {
    r = await gitlabFetch(url, token.trim(), 'GET')
  } catch {
    res.status(502).json({ error: 'Не удалось подключиться к GitLab.' })
    return
  }

  if (!r.ok) {
    const text = await r.text()
    res.status(r.status).json({
      error: `GitLab ответил ${r.status}. ${text.slice(0, 400)}`,
    })
    return
  }

  const users = (await r.json()) as Array<{ id: number; username: string }>
  const user = users[0]
  if (!user) {
    res.status(404).json({ error: `Пользователь «${username.trim()}» не найден.` })
    return
  }

  res.json({ id: user.id, username: user.username })
})

app.post('/api/events-total', async (req, res) => {
  const gitlabUrl = req.body?.gitlabUrl as string | undefined
  const token = req.body?.token as string | undefined
  const userId = req.body?.userId as number | undefined
  const after = req.body?.after as string | undefined
  const before = req.body?.before as string | undefined
  const action = req.body?.action as string | undefined

  if (
    !gitlabUrl?.trim() ||
    !token?.trim() ||
    typeof userId !== 'number' ||
    !after?.trim() ||
    !before?.trim() ||
    !action?.trim()
  ) {
    res.status(400).json({ error: 'Неполные параметры запроса.' })
    return
  }

  const base = normalizeBaseUrl(gitlabUrl)
  const params = new URLSearchParams({
    after: after.trim(),
    before: before.trim(),
    per_page: String(PER_PAGE),
    action: action.trim(),
  })
  const url = `${base}/api/v4/users/${userId}/events?${params}`
  await respondWithGitlabListTotal(res, url, token.trim())
})

app.post('/api/merge-requests-total', async (req, res) => {
  const gitlabUrl = req.body?.gitlabUrl as string | undefined
  const token = req.body?.token as string | undefined
  const userId = req.body?.userId as number | undefined
  const createdAfter = req.body?.createdAfter as string | undefined
  const createdBefore = req.body?.createdBefore as string | undefined

  if (
    !gitlabUrl?.trim() ||
    !token?.trim() ||
    typeof userId !== 'number' ||
    !createdAfter?.trim() ||
    !createdBefore?.trim()
  ) {
    res.status(400).json({ error: 'Неполные параметры запроса.' })
    return
  }

  const base = normalizeBaseUrl(gitlabUrl)
  const params = new URLSearchParams({
    author_id: String(userId),
    created_after: createdAfter.trim(),
    created_before: createdBefore.trim(),
    per_page: String(PER_PAGE),
    state: 'all',
    scope: 'all',
  })
  const url = `${base}/api/v4/merge_requests?${params}`
  await respondWithGitlabListTotal(res, url, token.trim())
})

const ymdRe = /^\d{4}-\d{2}-\d{2}$/

app.post('/api/activity-by-day', async (req, res) => {
  const gitlabUrl = req.body?.gitlabUrl as string | undefined
  const token = req.body?.token as string | undefined
  const userId = req.body?.userId as number | undefined
  const after = req.body?.after as string | undefined
  const before = req.body?.before as string | undefined
  const startDate = req.body?.startDate as string | undefined
  const endDate = req.body?.endDate as string | undefined
  const timeZone = safeTimeZone(req.body?.timeZone as string | undefined)

  if (
    !gitlabUrl?.trim() ||
    !token?.trim() ||
    typeof userId !== 'number' ||
    !after?.trim() ||
    !before?.trim() ||
    !startDate?.trim() ||
    !endDate?.trim()
  ) {
    res.status(400).json({ error: 'Неполные параметры запроса.' })
    return
  }

  const sd = startDate.trim()
  const ed = endDate.trim()
  if (!ymdRe.test(sd) || !ymdRe.test(ed)) {
    res.status(400).json({ error: 'Некорректный формат дат (ожидается YYYY-MM-DD).' })
    return
  }
  if (compareYmd(sd, ed) > 0) {
    res.status(400).json({ error: 'Дата начала позже даты конца.' })
    return
  }

  const base = normalizeBaseUrl(gitlabUrl)

  const eventsParams = (action: string) =>
    new URLSearchParams({
      after: after.trim(),
      before: before.trim(),
      per_page: String(PER_PAGE),
      action,
    })

  const approvedUrl = (page: number) =>
    `${base}/api/v4/users/${userId}/events?${eventsParams('approved')}&page=${page}`
  const commentedUrl = (page: number) =>
    `${base}/api/v4/users/${userId}/events?${eventsParams('commented')}&page=${page}`

  const mrParams = new URLSearchParams({
    author_id: String(userId),
    created_after: after.trim(),
    created_before: before.trim(),
    per_page: String(PER_PAGE),
    state: 'all',
    scope: 'all',
  })
  const mrUrl = (page: number) => `${base}/api/v4/merge_requests?${mrParams}&page=${page}`

  const [approvedRes, commentedRes, mrRes] = await Promise.all([
    collectGitlabPagesOnly(approvedUrl, token.trim()),
    collectGitlabPagesOnly(commentedUrl, token.trim()),
    collectGitlabPagesOnly(mrUrl, token.trim()),
  ])

  for (const result of [approvedRes, commentedRes, mrRes]) {
    if (!result.ok) {
      const status = result.status >= 400 && result.status < 600 ? result.status : 502
      res.status(status).json({
        error:
          result.status === 502
            ? result.message
            : `GitLab ответил ${result.status}. ${result.message}`,
      })
      return
    }
  }

  const approvedList = approvedRes.items
  const commentedList = commentedRes.items
  const mrList = mrRes.items
  const days = enumerateYmdInclusive(sd, ed)
  const approved = new Array<number>(days.length).fill(0)
  const commented = new Array<number>(days.length).fill(0)
  const mrsCreated = new Array<number>(days.length).fill(0)
  const indexByDay = new Map<string, number>()
  days.forEach((d, i) => indexByDay.set(d, i))

  function bump(list: GitlabItem[], target: 'approved' | 'commented' | 'mrsCreated') {
    for (const row of list) {
      const iso = row.created_at
      if (typeof iso !== 'string') continue
      const day = dayKeyInTimeZone(iso, timeZone)
      const idx = indexByDay.get(day)
      if (idx === undefined) continue
      if (target === 'approved') approved[idx] += 1
      else if (target === 'commented') commented[idx] += 1
      else mrsCreated[idx] += 1
    }
  }

  bump(approvedList, 'approved')
  bump(commentedList, 'commented')
  bump(mrList, 'mrsCreated')

  res.json({ days, approved, commented, mrsCreated, timeZone })
})

if (isProd) {
  const dist = path.join(__dirname, '..', 'dist')
  app.use(express.static(dist))
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.info(`GitLab proxy: http://127.0.0.1:${PORT}`)
})
