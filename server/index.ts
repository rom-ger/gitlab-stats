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
    per_page: '100',
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
    per_page: '100',
    state: 'all',
    scope: 'all',
  })
  const url = `${base}/api/v4/merge_requests?${params}`
  await respondWithGitlabListTotal(res, url, token.trim())
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
