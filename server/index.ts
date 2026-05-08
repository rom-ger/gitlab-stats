import cors from 'cors'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 8787
const isProd = process.env.NODE_ENV === 'production'

const app = express()
app.use(cors())
app.use(express.json({ limit: '512kb' }))

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

type DayDetailKind = 'approved' | 'commented' | 'mr_created'

type DayDetailItem = {
  id: string
  kind: DayDetailKind
  title: string
  createdAt: string
  webUrl: string | null
  /** Полный текст комментария из GitLab (только kind === 'commented'). */
  commentBody: string | null
}

function isCommentedActionName(actionName: unknown): boolean {
  const a = String(actionName ?? '')
    .toLowerCase()
    .trim()
  return a === 'commented' || a === 'commented on' || a.startsWith('commented')
}

async function fetchProjectPaths(
  base: string,
  token: string,
  projectIds: Iterable<number>,
): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  const ids = [...new Set(projectIds)].filter((id) => Number.isFinite(id) && id > 0)
  await Promise.all(
    ids.map(async (id) => {
      const url = `${base}/api/v4/projects/${id}`
      let r: Response
      try {
        r = await gitlabFetch(url, token, 'GET')
      } catch {
        return
      }
      if (!r.ok) return
      const j = (await r.json()) as { path_with_namespace?: unknown }
      if (typeof j.path_with_namespace === 'string' && j.path_with_namespace.trim()) {
        map.set(id, j.path_with_namespace.trim())
      }
    }),
  )
  return map
}

function asRecord(row: GitlabItem): Record<string, unknown> {
  return row as Record<string, unknown>
}

function asPositiveInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.trunc(v)
  if (typeof v === 'string') {
    const t = v.trim()
    if (/^\d+$/.test(t)) {
      const n = Number.parseInt(t, 10)
      return n > 0 ? n : null
    }
  }
  return null
}

function absoluteFromBase(base: string, raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  if (/^https?:\/\//i.test(t)) return t
  if (t.startsWith('/')) {
    try {
      return new URL(t, base.endsWith('/') ? base : `${base}/`).href
    } catch {
      return null
    }
  }
  return null
}

function withNoteFragment(url: string, noteDbId: number | null): string {
  if (noteDbId == null) return url
  const frag = `#note_${noteDbId}`
  return url.includes('#') ? url : `${url}${frag}`
}

function normalizeNoteableType(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const s = raw.trim()
  const lower = s.toLowerCase()
  if (lower === 'mergerequest' || lower === 'merge_request') return 'MergeRequest'
  if (lower === 'issue') return 'Issue'
  if (lower === 'snippet') return 'Snippet'
  if (lower === 'commit' || lower === 'commit::commit') return 'Commit'
  return s
}

function isNoteTargetType(tt: string): boolean {
  const lower = tt.toLowerCase()
  return (
    tt === 'Note' ||
    lower === 'note' ||
    tt === 'DiffNote' ||
    lower === 'diffnote' ||
    tt === 'DiscussionNote' ||
    lower === 'discussionnote'
  )
}

function eventTitle(e: Record<string, unknown>): string {
  const tt = e['target_title']
  if (typeof tt === 'string' && tt.trim()) return tt.trim()
  const note = e['note']
  if (note && typeof note === 'object') {
    const body = (note as Record<string, unknown>)['body']
    if (typeof body === 'string' && body.trim()) {
      const line = body.trim().split('\n')[0] ?? ''
      const short = line.length > 140 ? `${line.slice(0, 137)}…` : line
      if (short) return short
    }
  }
  const push = e['push_data']
  if (push && typeof push === 'object') {
    const title = (push as Record<string, unknown>)['commit_title']
    if (typeof title === 'string' && title.trim()) return title.trim()
  }
  return 'Событие'
}

const COMMENT_BODY_MAX_CHARS = 12_000

function eventCommentBody(e: Record<string, unknown>): string | null {
  const note = e['note']
  if (!note || typeof note !== 'object') return null
  const body = (note as Record<string, unknown>)['body']
  if (typeof body !== 'string') return null
  const t = body.replace(/\r\n/g, '\n').trim()
  if (!t) return null
  if (t.length > COMMENT_BODY_MAX_CHARS) return `${t.slice(0, COMMENT_BODY_MAX_CHARS)}…`
  return t
}

function eventWebUrl(
  base: string,
  paths: Map<number, string>,
  e: Record<string, unknown>,
): string | null {
  const tu = e['target_url']
  if (typeof tu === 'string' && tu.trim()) {
    const abs = absoluteFromBase(base, tu.trim())
    if (abs) return abs
  }

  const pid = asPositiveInt(e['project_id'])
  if (pid == null) return null
  const path = paths.get(pid)
  if (!path) return null

  const ttRaw = e['target_type']
  const tt = typeof ttRaw === 'string' ? ttRaw.trim() : ''
  const targetIid = asPositiveInt(e['target_iid'])
  const ttLower = tt.toLowerCase()

  if ((tt === 'MergeRequest' || ttLower === 'merge_request' || ttLower === 'mergerequest') && targetIid != null) {
    return `${base}/${path}/-/merge_requests/${targetIid}`
  }

  if ((tt === 'Issue' || ttLower === 'issue') && targetIid != null) {
    return `${base}/${path}/-/issues/${targetIid}`
  }

  if (isNoteTargetType(tt)) {
    const note = e['note']
    const noteDbId =
      (note && typeof note === 'object' ? asPositiveInt((note as Record<string, unknown>)['id']) : null) ??
      asPositiveInt(e['target_id']) ??
      targetIid

    if (note && typeof note === 'object') {
      const n = note as Record<string, unknown>

      for (const key of ['web_url', 'webUrl', 'url'] as const) {
        const direct = n[key]
        if (typeof direct === 'string' && direct.trim()) {
          const abs = absoluteFromBase(base, direct.trim())
          if (abs) return withNoteFragment(abs, noteDbId)
        }
      }

      const noteable = n['noteable']
      if (noteable && typeof noteable === 'object') {
        const nb = noteable as Record<string, unknown>
        for (const key of ['web_url', 'webUrl'] as const) {
          const w = nb[key]
          if (typeof w === 'string' && w.trim()) {
            const abs = absoluteFromBase(base, w.trim())
            if (abs) return withNoteFragment(abs, noteDbId)
          }
        }
        const nbIid = asPositiveInt(nb['iid'])
        const nbType =
          normalizeNoteableType(nb['type']) ??
          normalizeNoteableType(nb['noteable_type']) ??
          normalizeNoteableType(n['noteable_type'])
        const hash = noteDbId != null ? `#note_${noteDbId}` : ''
        if (nbType === 'MergeRequest' && nbIid != null) {
          return `${base}/${path}/-/merge_requests/${nbIid}${hash}`
        }
        if (nbType === 'Issue' && nbIid != null) {
          return `${base}/${path}/-/issues/${nbIid}${hash}`
        }
        if (nbType === 'Snippet' && nbIid != null) {
          return `${base}/${path}/-/snippets/${nbIid}${hash}`
        }
      }

      const noteableType = normalizeNoteableType(n['noteable_type'])
      const noteableIid = asPositiveInt(n['noteable_iid'])
      const hash = noteDbId != null ? `#note_${noteDbId}` : ''

      if (noteableType === 'MergeRequest' && noteableIid != null) {
        return `${base}/${path}/-/merge_requests/${noteableIid}${hash}`
      }
      if (noteableType === 'Issue' && noteableIid != null) {
        return `${base}/${path}/-/issues/${noteableIid}${hash}`
      }
      if (noteableType === 'Snippet' && noteableIid != null) {
        return `${base}/${path}/-/snippets/${noteableIid}${hash}`
      }
      if (noteableType === 'Commit') {
        const sha = n['commit_id']
        if (typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha.trim())) {
          return `${base}/${path}/-/commit/${sha.trim()}${hash}`
        }
      }
    }
  }

  return null
}

const GRAPHQL_NOTE_GID_TYPES = ['Note', 'DiffNote', 'DiscussionNote'] as const

/** GitLab 15.9+: Query.note — прямой URL комментария, если REST-событие без target_url / noteable_iid. */
async function fetchNoteUrlViaGraphql(
  base: string,
  token: string,
  noteDbId: number,
): Promise<string | null> {
  const query = `query GitlabStatsNoteUrl($id: NoteID!) { note(id: $id) { url } }`
  const url = `${base}/api/graphql`
  for (const typ of GRAPHQL_NOTE_GID_TYPES) {
    let r: Response
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PRIVATE-TOKEN': token,
        },
        body: JSON.stringify({
          query,
          variables: { id: `gid://gitlab/${typ}/${noteDbId}` },
        }),
      })
    } catch {
      continue
    }
    if (!r.ok) continue
    let j: unknown
    try {
      j = await r.json()
    } catch {
      continue
    }
    if (!j || typeof j !== 'object') continue
    const obj = j as { errors?: unknown; data?: { note?: { url?: unknown } | null } }
    if (Array.isArray(obj.errors) && obj.errors.length > 0) continue
    const u = obj.data?.note?.url
    if (typeof u === 'string' && u.trim()) return u.trim()
  }
  return null
}

async function enrichCommentedWebUrls(
  base: string,
  token: string,
  paths: Map<number, string>,
  commentedList: GitlabItem[],
): Promise<Map<number, string>> {
  const overrides = new Map<number, string>()
  const eventToNoteId = new Map<number, number>()

  for (const row of commentedList) {
    const e = asRecord(row)
    const eventId = asPositiveInt(e['id'])
    if (eventId == null) continue
    if (eventWebUrl(base, paths, e) != null) continue

    const ttRaw = e['target_type']
    const tt = typeof ttRaw === 'string' ? ttRaw.trim() : ''
    if (!isNoteTargetType(tt)) continue

    const note = e['note']
    const noteDbId =
      (note && typeof note === 'object' ? asPositiveInt((note as Record<string, unknown>)['id']) : null) ??
      asPositiveInt(e['target_id'])
    if (noteDbId == null) continue

    eventToNoteId.set(eventId, noteDbId)
  }

  const uniqueNoteIds = [...new Set(eventToNoteId.values())]
  const NOTE_FETCH_CONCURRENCY = 8
  const urlByNoteId = new Map<number, string | null>()

  for (let i = 0; i < uniqueNoteIds.length; i += NOTE_FETCH_CONCURRENCY) {
    const chunk = uniqueNoteIds.slice(i, i + NOTE_FETCH_CONCURRENCY)
    await Promise.all(
      chunk.map(async (noteId) => {
        const resolved = await fetchNoteUrlViaGraphql(base, token, noteId)
        urlByNoteId.set(noteId, resolved)
      }),
    )
  }

  for (const [eventId, noteId] of eventToNoteId) {
    const raw = urlByNoteId.get(noteId)
    if (typeof raw !== 'string' || !raw.trim()) continue
    const abs = absoluteFromBase(base, raw.trim()) ?? raw.trim()
    overrides.set(eventId, abs)
  }

  return overrides
}

function readAuthorIdFromObject(author: unknown): number | null {
  if (!author || typeof author !== 'object') return null
  return asPositiveInt((author as Record<string, unknown>)['id'])
}

/** Метаданные комментария именно к merge request (не issue/snippet). */
function mergeRequestCommentMeta(
  e: Record<string, unknown>,
): { pid: number; mrIid: number | null; embeddedAuthorId: number | null } | null {
  const note = e['note']
  if (!note || typeof note !== 'object') return null
  const n = note as Record<string, unknown>

  const noteableType =
    normalizeNoteableType(n['noteable_type']) ??
    (n['noteable'] && typeof n['noteable'] === 'object'
      ? normalizeNoteableType((n['noteable'] as Record<string, unknown>)['type'])
      : null)

  if (noteableType !== 'MergeRequest') return null

  const pid = asPositiveInt(e['project_id'])
  if (pid == null) return null

  let mrIid = asPositiveInt(n['noteable_iid'])
  if (mrIid == null && n['noteable'] && typeof n['noteable'] === 'object') {
    mrIid = asPositiveInt((n['noteable'] as Record<string, unknown>)['iid'])
  }

  let embeddedAuthorId: number | null = null
  if (n['noteable'] && typeof n['noteable'] === 'object') {
    embeddedAuthorId = readAuthorIdFromObject((n['noteable'] as Record<string, unknown>)['author'])
  }

  return { pid, mrIid, embeddedAuthorId }
}

async function fetchMergeRequestAuthorId(
  base: string,
  token: string,
  projectId: number,
  mrIid: number,
): Promise<number | null> {
  const url = `${base}/api/v4/projects/${projectId}/merge_requests/${mrIid}`
  let r: Response
  try {
    r = await gitlabFetch(url, token, 'GET')
  } catch {
    return null
  }
  if (!r.ok) return null
  let j: unknown
  try {
    j = await r.json()
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  return readAuthorIdFromObject((j as Record<string, unknown>)['author'])
}

/** Убирает комментарии к MR, автором которых является selfUserId. Остальные события (issue и т.д.) сохраняются. */
async function filterOutCommentsOnOwnMergeRequests(
  base: string,
  token: string,
  selfUserId: number,
  rows: GitlabItem[],
): Promise<GitlabItem[]> {
  type Meta = NonNullable<ReturnType<typeof mergeRequestCommentMeta>>
  const entries: { row: GitlabItem; meta: Meta | null }[] = rows.map((row) => ({
    row,
    meta: mergeRequestCommentMeta(asRecord(row)),
  }))

  const fetchKeys = new Map<string, { pid: number; iid: number }>()
  for (const { meta } of entries) {
    if (!meta) continue
    if (meta.embeddedAuthorId != null) continue
    if (meta.mrIid == null) continue
    fetchKeys.set(`${meta.pid}:${meta.mrIid}`, { pid: meta.pid, iid: meta.mrIid })
  }

  const authorByFetchKey = new Map<string, number | null>()
  const chunkSize = 12
  const toFetch = [...fetchKeys.values()]
  for (let i = 0; i < toFetch.length; i += chunkSize) {
    await Promise.all(
      toFetch.slice(i, i + chunkSize).map(async ({ pid, iid }) => {
        const key = `${pid}:${iid}`
        const aid = await fetchMergeRequestAuthorId(base, token, pid, iid)
        authorByFetchKey.set(key, aid)
      }),
    )
  }

  const out: GitlabItem[] = []
  for (const { row, meta } of entries) {
    if (!meta) {
      out.push(row)
      continue
    }
    let authorId = meta.embeddedAuthorId
    if (authorId == null && meta.mrIid != null) {
      authorId = authorByFetchKey.get(`${meta.pid}:${meta.mrIid}`) ?? null
    }
    if (authorId != null && authorId === selfUserId) continue
    out.push(row)
  }
  return out
}

function uniqueApprovedMergeRequestTargets(approvedList: GitlabItem[]): { pid: number; iid: number }[] {
  const seen = new Set<string>()
  const out: { pid: number; iid: number }[] = []
  for (const row of approvedList) {
    const e = asRecord(row)
    const tt = typeof e['target_type'] === 'string' ? e['target_type'].trim() : ''
    const tl = tt.toLowerCase()
    if (tt !== 'MergeRequest' && tl !== 'mergerequest' && tl !== 'merge_request') continue
    const pid = asPositiveInt(e['project_id'])
    const iid = asPositiveInt(e['target_iid'])
    if (pid == null || iid == null) continue
    const key = `${pid}:${iid}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ pid, iid })
  }
  return out
}

function parseUnidiffLineStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('+++ ') || rawLine.startsWith('--- ')) continue
    if (rawLine.startsWith('@@')) continue
    if (rawLine.startsWith('+')) additions++
    else if (rawLine.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

async function fetchMrDiffLineTotalGraphql(
  base: string,
  token: string,
  fullPath: string,
  mrIid: number,
): Promise<number | null> {
  const query = `query GitlabStatsMrDiff($fullPath: ID!, $iid: String!) {
    project(fullPath: $fullPath) {
      mergeRequest(iid: $iid) {
        diffStatsSummary { additions deletions }
      }
    }
  }`
  let r: Response
  try {
    r = await fetch(`${base}/api/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': token,
      },
      body: JSON.stringify({
        query,
        variables: { fullPath, iid: String(mrIid) },
      }),
    })
  } catch {
    return null
  }
  if (!r.ok) return null
  let j: unknown
  try {
    j = await r.json()
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  const obj = j as {
    errors?: unknown
    data?: {
      project?: {
        mergeRequest?: { diffStatsSummary?: { additions?: unknown; deletions?: unknown } | null } | null
      } | null
    }
  }
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return null
  const mr = obj.data?.project?.mergeRequest
  if (mr == null) return null
  const s = mr.diffStatsSummary
  if (s == null || typeof s !== 'object') return null
  const a = (s as Record<string, unknown>)['additions']
  const d = (s as Record<string, unknown>)['deletions']
  if (typeof a !== 'number' || typeof d !== 'number' || !Number.isFinite(a) || !Number.isFinite(d)) return null
  const add = a >= 0 ? Math.trunc(a) : 0
  const del = d >= 0 ? Math.trunc(d) : 0
  return add + del
}

async function fetchMrDiffLineTotalFromChanges(
  base: string,
  token: string,
  projectId: number,
  mrIid: number,
): Promise<number | null> {
  const url = `${base}/api/v4/projects/${projectId}/merge_requests/${mrIid}/changes`
  let r: Response
  try {
    r = await gitlabFetch(url, token, 'GET')
  } catch {
    return null
  }
  if (!r.ok) return null
  let j: unknown
  try {
    j = await r.json()
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  const changes = (j as Record<string, unknown>)['changes']
  if (!Array.isArray(changes)) return null
  let sum = 0
  for (const c of changes) {
    if (!c || typeof c !== 'object') continue
    const diff = (c as Record<string, unknown>)['diff']
    if (typeof diff !== 'string' || !diff) continue
    const { additions, deletions } = parseUnidiffLineStats(diff)
    sum += additions + deletions
  }
  return sum
}

async function fetchMrDiffLineTotal(
  base: string,
  token: string,
  paths: Map<number, string>,
  pid: number,
  iid: number,
): Promise<number> {
  const fullPath = paths.get(pid)
  if (fullPath) {
    const g = await fetchMrDiffLineTotalGraphql(base, token, fullPath, iid)
    if (g != null) return g
  }
  const rest = await fetchMrDiffLineTotalFromChanges(base, token, pid, iid)
  return rest != null ? rest : 0
}

async function sumDiffLinesForApprovedMergeRequests(
  base: string,
  token: string,
  paths: Map<number, string>,
  approvedList: GitlabItem[],
): Promise<number> {
  const targets = uniqueApprovedMergeRequestTargets(approvedList)
  const chunkSize = 10
  let total = 0
  for (let i = 0; i < targets.length; i += chunkSize) {
    const chunk = targets.slice(i, i + chunkSize)
    const parts = await Promise.all(
      chunk.map(({ pid, iid }) => fetchMrDiffLineTotal(base, token, paths, pid, iid)),
    )
    for (const n of parts) total += n
  }
  return total
}

function dedupEventsById(rows: GitlabItem[]): GitlabItem[] {
  const seen = new Set<number>()
  const out: GitlabItem[] = []
  for (const row of rows) {
    const id = asRecord(row)['id']
    if (typeof id !== 'number' || seen.has(id)) continue
    seen.add(id)
    out.push(row)
  }
  return out
}

function sortDetailItemsDesc(items: DayDetailItem[]): void {
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

function buildDetailByDay(
  base: string,
  paths: Map<number, string>,
  days: string[],
  timeZone: string,
  approvedList: GitlabItem[],
  commentedList: GitlabItem[],
  mrList: GitlabItem[],
  commentWebUrlByEventId?: Map<number, string>,
): Record<string, DayDetailItem[]> {
  const daySet = new Set(days)
  const out: Record<string, DayDetailItem[]> = Object.fromEntries(days.map((d) => [d, []]))

  function dayOf(row: GitlabItem): string | null {
    const iso = row.created_at
    if (typeof iso !== 'string') return null
    const dk = dayKeyInTimeZone(iso, timeZone)
    return daySet.has(dk) ? dk : null
  }

  for (const row of approvedList) {
    const dk = dayOf(row)
    if (!dk) continue
    const e = asRecord(row)
    const id = e['id']
    const created = e['created_at']
    out[dk].push({
      id: `approved-${typeof id === 'number' ? id : `${dk}-${out[dk].length}`}`,
      kind: 'approved',
      title: eventTitle(e),
      createdAt: typeof created === 'string' ? created : '',
      webUrl: eventWebUrl(base, paths, e),
      commentBody: null,
    })
  }

  for (const row of commentedList) {
    const dk = dayOf(row)
    if (!dk) continue
    const e = asRecord(row)
    const id = e['id']
    const created = e['created_at']
    const evNum = asPositiveInt(id)
    const override =
      evNum != null && commentWebUrlByEventId ? commentWebUrlByEventId.get(evNum) : undefined
    const webUrl =
      typeof override === 'string' && override.trim()
        ? override.trim()
        : eventWebUrl(base, paths, e)
    out[dk].push({
      id: `commented-${typeof id === 'number' ? id : `${dk}-${out[dk].length}`}`,
      kind: 'commented',
      title: eventTitle(e),
      createdAt: typeof created === 'string' ? created : '',
      webUrl,
      commentBody: eventCommentBody(e),
    })
  }

  for (const row of mrList) {
    const dk = dayOf(row)
    if (!dk) continue
    const m = asRecord(row)
    const id = m['id']
    const created = m['created_at']
    const title = m['title']
    const web = m['web_url']
    out[dk].push({
      id: `mr-${typeof id === 'number' ? id : `${dk}-${out[dk].length}`}`,
      kind: 'mr_created',
      title: typeof title === 'string' && title.trim() ? title.trim() : 'Merge request',
      createdAt: typeof created === 'string' ? created : '',
      webUrl: typeof web === 'string' && /^https?:\/\//i.test(web) ? web : null,
      commentBody: null,
    })
  }

  for (const d of days) {
    sortDetailItemsDesc(out[d])
  }
  return out
}

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
  const ra = after.trim()
  const rb = before.trim()

  function userEventsSearch(extra: Record<string, string>): string {
    const p = new URLSearchParams({
      after: ra,
      before: rb,
      per_page: String(PER_PAGE),
    })
    for (const [k, v] of Object.entries(extra)) {
      p.set(k, v)
    }
    return p.toString()
  }

  const approvedUrl = (page: number) =>
    `${base}/api/v4/users/${userId}/events?${userEventsSearch({ action: 'approved' })}&page=${page}`
  const commentedUrl = (page: number) =>
    `${base}/api/v4/users/${userId}/events?${userEventsSearch({ action: 'commented' })}&page=${page}`
  const noteEventsUrl = (page: number) =>
    `${base}/api/v4/users/${userId}/events?${userEventsSearch({ target_type: 'note' })}&page=${page}`

  const mrParams = new URLSearchParams({
    author_id: String(userId),
    created_after: ra,
    created_before: rb,
    per_page: String(PER_PAGE),
    state: 'all',
    scope: 'all',
  })
  const mrUrl = (page: number) => `${base}/api/v4/merge_requests?${mrParams}&page=${page}`

  const [approvedRes, commentedRes, noteRes, mrRes] = await Promise.all([
    collectGitlabPagesOnly(approvedUrl, token.trim()),
    collectGitlabPagesOnly(commentedUrl, token.trim()),
    collectGitlabPagesOnly(noteEventsUrl, token.trim()),
    collectGitlabPagesOnly(mrUrl, token.trim()),
  ])

  for (const result of [approvedRes, commentedRes, noteRes, mrRes]) {
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
  const commentedDeduped = dedupEventsById([
    ...commentedRes.items,
    ...noteRes.items.filter((row) => isCommentedActionName(asRecord(row)['action_name'])),
  ])
  const commentedList = await filterOutCommentsOnOwnMergeRequests(
    base,
    token.trim(),
    userId,
    commentedDeduped,
  )
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

  const projectIds: number[] = []
  for (const row of [...approvedList, ...commentedList]) {
    const e = asRecord(row)
    const pid = asPositiveInt(e['project_id'])
    if (pid != null) projectIds.push(pid)
  }
  for (const row of mrList) {
    const m = asRecord(row)
    const pid = asPositiveInt(m['project_id'])
    if (pid != null) projectIds.push(pid)
  }

  const paths = await fetchProjectPaths(base, token.trim(), projectIds)
  const [approvedMrsDiffLinesTotal, commentWebUrlByEventId] = await Promise.all([
    sumDiffLinesForApprovedMergeRequests(base, token.trim(), paths, approvedList),
    enrichCommentedWebUrls(base, token.trim(), paths, commentedList),
  ])
  const foreignMrCommentCount = commentedList.length
  const avgLinesPerComment =
    foreignMrCommentCount > 0 ? approvedMrsDiffLinesTotal / foreignMrCommentCount : null
  const detailByDay = buildDetailByDay(
    base,
    paths,
    days,
    timeZone,
    approvedList,
    commentedList,
    mrList,
    commentWebUrlByEventId,
  )

  res.json({
    days,
    approved,
    commented,
    mrsCreated,
    timeZone,
    detailByDay,
    approvedMrsDiffLinesTotal,
    foreignMrCommentCount,
    avgLinesPerComment,
  })
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
