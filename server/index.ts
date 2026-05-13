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
/** Несколько MR в одном GraphQL-запросе (один project fullPath). */
const MR_DIFF_GRAPHQL_IIDS_PER_REQUEST = 8
/** Параллельных GraphQL-запросов к разным проектам / батчам. */
const MR_DIFF_GRAPHQL_HTTP_CONCURRENCY = 6
/** Параллельных REST/GraphQL fallback на один MR после батча. */
const MR_DIFF_FALLBACK_CHUNK = 18
const MAX_LIST_PAGES = 400
/** Пагинация GET /users — верхняя граница страниц (100 пользователей на страницу). */
const MAX_USER_LIST_PAGES = 200

/**
 * Учитываются только MR автора с target_branch из списка (merge в develop или в dev).
 * При необходимости добавьте ветки в этот массив.
 */
const AUTHOR_MR_TARGET_BRANCHES = ['develop', 'dev'] as const

function mrTargetBranchAllowed(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false
  const lower = raw.trim().toLowerCase()
  return (AUTHOR_MR_TARGET_BRANCHES as readonly string[]).includes(lower)
}

function filterMrsByAllowedTargetBranch(rows: GitlabItem[]): GitlabItem[] {
  return rows.filter((row) => mrTargetBranchAllowed(asRecord(row)['target_branch']))
}

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

type DayDetailKind = 'approved' | 'commented' | 'mr_created' | 'push_commits'

type DayDetailItem = {
  id: string
  kind: DayDetailKind
  title: string
  createdAt: string
  webUrl: string | null
  /** Полный текст комментария из GitLab (только kind === 'commented'). */
  commentBody: string | null
  /**
   * Сумма добавленных и удалённых строк в диффе MR, если уже посчитана при загрузке периода
   * (одобрения и совпадение MR в комментариях) или пришла во вложенных полях события.
   */
  mrDiffLines: number | null
  /** Число изменённых файлов из ответа GitLab (в т.ч. для созданных MR из списка). */
  mrChangesCount: number | null
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

const MERGE_BRANCH_COMMIT_TITLE_NEEDLE = 'merge branch'

/** Событие push не учитываем в статистике коммитов, если заголовок коммита GitLab — типичное «Merge branch …». */
function pushEventIsMergeBranchCommitTitle(e: Record<string, unknown>): boolean {
  const push = e['push_data']
  if (!push || typeof push !== 'object') return false
  const title = (push as Record<string, unknown>)['commit_title']
  if (typeof title !== 'string' || !title.trim()) return false
  return title.toLowerCase().includes(MERGE_BRANCH_COMMIT_TITLE_NEEDLE)
}

/** Ссылка на конец пуша или на ветку в GitLab (если SHA нет). */
function pushEventWebUrl(base: string, paths: Map<number, string>, e: Record<string, unknown>): string | null {
  const pid = asPositiveInt(e['project_id'])
  if (pid == null) return null
  const pathNs = paths.get(pid)
  if (!pathNs) return null
  const push = e['push_data']
  if (!push || typeof push !== 'object') return `${base}/${pathNs}`
  const pd = push as Record<string, unknown>
  const commitTo = pd['commit_to']
  if (typeof commitTo === 'string' && commitTo.trim()) {
    const sha = commitTo.trim()
    if (/^[a-f0-9]{7,64}$/i.test(sha)) {
      return `${base}/${pathNs}/-/commit/${sha}`
    }
  }
  const refRaw = pd['ref']
  if (typeof refRaw === 'string' && refRaw.trim()) {
    const ref = refRaw.trim().replace(/^refs\/heads\//i, '').replace(/^refs\/tags\//i, '')
    if (ref) {
      return `${base}/${pathNs}/-/commits/${encodeURIComponent(ref)}`
    }
  }
  return `${base}/${pathNs}`
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

/** Уникальные MR из событий комментариев (project_id + iid), чтобы подтянуть дифф и для MR без одобрения. */
function uniqueMergeRequestTargetsFromCommentedList(commentedList: GitlabItem[]): { pid: number; iid: number }[] {
  const seen = new Set<string>()
  const out: { pid: number; iid: number }[] = []
  for (const row of commentedList) {
    const meta = mergeRequestCommentMeta(asRecord(row))
    if (!meta || meta.mrIid == null) continue
    const k = mrTargetKey(meta.pid, meta.mrIid)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ pid: meta.pid, iid: meta.mrIid })
  }
  return out
}

type MedianMrBreakdownBaseRow = {
  projectId: number
  iid: number
  diffLines: number
  userCommentCount: number
  linesPerUserComment: number
}

function medianOfSortedAscending(sorted: number[]): number | null {
  const n = sorted.length
  if (n === 0) return null
  const mid = Math.floor(n / 2)
  if (n % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Медиана «стр./комм.» по чужим MR: объединяются MR с комментариями пользователя и MR, которые он одобрил.
 * Если в MR нет учтённых комментариев (только одобрение), отношение считается 0.
 * Если есть комментарии: (строки диффа MR) / (число комментариев); при неизвестном или нулевом диффе такой MR в медиану не входит.
 * Одобрения собственных MR (автор в target) не учитываются.
 * Строки для UI — по убыванию linesPerUserComment.
 */
function buildMedianMrBreakdownRows(
  commentedList: GitlabItem[],
  approvedList: GitlabItem[],
  selfUserId: number,
  mrDiffLinesByKey: ReadonlyMap<string, number>,
): { median: number | null; rows: MedianMrBreakdownBaseRow[] } {
  type Agg = { comments: number; diffLines: number | null }
  const byKey = new Map<string, Agg>()
  for (const row of commentedList) {
    const e = asRecord(row)
    const meta = mergeRequestCommentMeta(e)
    if (!meta || meta.mrIid == null) continue
    const k = mrTargetKey(meta.pid, meta.mrIid)
    let rec = byKey.get(k)
    if (!rec) {
      let diff: number | null = null
      if (mrDiffLinesByKey.has(k)) diff = mrDiffLinesByKey.get(k)!
      if (diff == null) diff = tryReadMrLineStatsFromCommentNoteable(e) ?? tryReadMrLineStatsFromEventTarget(e)
      rec = { comments: 0, diffLines: diff }
      byKey.set(k, rec)
    }
    rec.comments += 1
    if (rec.diffLines == null) {
      const d = tryReadMrLineStatsFromCommentNoteable(e) ?? tryReadMrLineStatsFromEventTarget(e)
      if (d != null) rec.diffLines = d
    }
  }

  const approvalSampleByKey = buildApprovalSampleByMrKey(approvedList)
  for (const [k, sample] of approvalSampleByKey) {
    const authorId = readMrAuthorIdFromEventTarget(sample)
    if (authorId != null && authorId === selfUserId) continue
    if (!byKey.has(k)) {
      let diff: number | null = null
      if (mrDiffLinesByKey.has(k)) diff = mrDiffLinesByKey.get(k)!
      if (diff == null) diff = tryReadMrLineStatsFromEventTarget(sample)
      byKey.set(k, { comments: 0, diffLines: diff })
    }
  }

  const ratios: number[] = []
  const rows: MedianMrBreakdownBaseRow[] = []
  for (const [k, rec] of byKey) {
    const d = rec.diffLines
    const c = rec.comments
    let ratio: number
    let diffForRow: number
    if (c > 0) {
      if (d == null || !Number.isFinite(d) || d <= 0) continue
      ratio = d / c
      diffForRow = Math.trunc(d)
    } else {
      ratio = 0
      diffForRow = d != null && Number.isFinite(d) && d > 0 ? Math.trunc(d) : 0
    }
    ratios.push(ratio)
    const colon = k.indexOf(':')
    if (colon <= 0) continue
    const projectId = Number.parseInt(k.slice(0, colon), 10)
    const iid = Number.parseInt(k.slice(colon + 1), 10)
    if (!Number.isFinite(projectId) || !Number.isFinite(iid)) continue
    rows.push({
      projectId,
      iid,
      diffLines: diffForRow,
      userCommentCount: c,
      linesPerUserComment: ratio,
    })
  }
  if (ratios.length === 0) return { median: null, rows: [] }
  ratios.sort((a, b) => a - b)
  const median = medianOfSortedAscending(ratios)
  rows.sort((a, b) => b.linesPerUserComment - a.linesPerUserComment)
  return { median, rows }
}

type MedianMrBreakdownHint = {
  webUrl: string | null
  title: string | null
  totalUserNotesCount: number | null
}

function eventTargetTypeIsMergeRequest(raw: unknown): boolean {
  const tt = typeof raw === 'string' ? raw.trim() : ''
  const tl = tt.toLowerCase()
  return tt === 'MergeRequest' || tl === 'mergerequest' || tl === 'merge_request'
}

/** Поля MR из вложенного объекта GitLab (target / noteable), без доп. HTTP. */
function readMergeRequestDisplayHintFromObject(o: Record<string, unknown>): {
  title: string | null
  webUrl: string | null
  userNotesCount: number | null
} {
  const title = typeof o['title'] === 'string' && o['title'].trim() ? o['title'].trim() : null
  let webUrl: string | null = null
  for (const key of ['web_url', 'webUrl'] as const) {
    const w = o[key]
    if (typeof w === 'string' && w.trim()) {
      webUrl = w.trim()
      break
    }
  }
  const unc = o['user_notes_count']
  const userNotesCount =
    typeof unc === 'number' && Number.isFinite(unc) ? Math.max(0, Math.trunc(unc)) : null
  return { title, webUrl, userNotesCount }
}

function mergeMedianMrBreakdownHint(into: MedianMrBreakdownHint, patch: MedianMrBreakdownHint): void {
  into.webUrl = patch.webUrl ?? into.webUrl
  if (patch.title && patch.title.trim()) into.title = patch.title.trim()
  else if (!into.title || !into.title.trim()) into.title = patch.title
  if (patch.totalUserNotesCount != null) into.totalUserNotesCount = patch.totalUserNotesCount
}

/**
 * Дополняет строки разбивки медианы ссылкой/заголовком/MR без N запросов к API:
 * данные из уже загруженных событий одобрения и комментариев + fallback URL по project path.
 */
function mergeMedianMrBreakdownWithEventData(
  base: string,
  paths: Map<number, string>,
  rows: MedianMrBreakdownBaseRow[],
  approvedList: GitlabItem[],
  commentedList: GitlabItem[],
): Array<
  MedianMrBreakdownBaseRow & {
    webUrl: string | null
    title: string | null
    totalUserNotesCount: number | null
  }
> {
  const hints = new Map<string, MedianMrBreakdownHint>()

  function hintFor(k: string): MedianMrBreakdownHint {
    let h = hints.get(k)
    if (!h) {
      h = { webUrl: null, title: null, totalUserNotesCount: null }
      hints.set(k, h)
    }
    return h
  }

  for (const row of approvedList) {
    const e = asRecord(row)
    if (!eventTargetTypeIsMergeRequest(e['target_type'])) continue
    const pid = asPositiveInt(e['project_id'])
    const iid = asPositiveInt(e['target_iid'])
    if (pid == null || iid == null) continue
    const k = mrTargetKey(pid, iid)
    const tgt = e['target']
    const fromObj =
      tgt && typeof tgt === 'object'
        ? readMergeRequestDisplayHintFromObject(tgt as Record<string, unknown>)
        : { title: null, webUrl: null, userNotesCount: null as number | null }
    const targetTitle =
      typeof e['target_title'] === 'string' && e['target_title'].trim() ? e['target_title'].trim() : null
    const web = eventWebUrl(base, paths, e)
    let webUrl = web
    if (!webUrl && fromObj.webUrl) {
      webUrl = absoluteFromBase(base, fromObj.webUrl) ?? fromObj.webUrl
    }
    mergeMedianMrBreakdownHint(hintFor(k), {
      webUrl,
      title: fromObj.title ?? targetTitle,
      totalUserNotesCount: fromObj.userNotesCount,
    })
  }

  for (const row of commentedList) {
    const e = asRecord(row)
    const meta = mergeRequestCommentMeta(e)
    if (!meta || meta.mrIid == null) continue
    const k = mrTargetKey(meta.pid, meta.mrIid)
    const note = e['note']
    let fromObj = { title: null as string | null, webUrl: null as string | null, userNotesCount: null as number | null }
    if (note && typeof note === 'object') {
      const noteable = (note as Record<string, unknown>)['noteable']
      if (noteable && typeof noteable === 'object') {
        fromObj = readMergeRequestDisplayHintFromObject(noteable as Record<string, unknown>)
      }
    }
    const web = eventWebUrl(base, paths, e)
    let webUrl = web
    if (!webUrl && fromObj.webUrl) {
      webUrl = absoluteFromBase(base, fromObj.webUrl) ?? fromObj.webUrl
    }
    const evTitle = eventTitle(e)
    const title =
      (fromObj.title && fromObj.title.trim()) ||
      (evTitle !== 'Событие' && evTitle.trim() ? evTitle.trim() : null)
    mergeMedianMrBreakdownHint(hintFor(k), {
      webUrl,
      title,
      totalUserNotesCount: fromObj.userNotesCount,
    })
  }

  return rows.map((r) => {
    const k = mrTargetKey(r.projectId, r.iid)
    const h = hints.get(k)
    const projectPath = paths.get(r.projectId)
    const fallbackWeb = projectPath != null ? `${base}/${projectPath}/-/merge_requests/${r.iid}` : null
    return {
      ...r,
      webUrl: h?.webUrl ?? fallbackWeb,
      title: h?.title ?? null,
      totalUserNotesCount: h?.totalUserNotesCount ?? null,
    }
  })
}

/** Уникальные MR из списка /merge_requests (project_id + iid). */
function uniqueMergeRequestTargetsFromMrList(mrList: GitlabItem[]): { pid: number; iid: number }[] {
  const seen = new Set<string>()
  const out: { pid: number; iid: number }[] = []
  for (const row of mrList) {
    const m = asRecord(row)
    const pid = asPositiveInt(m['project_id'])
    const iid = asPositiveInt(m['iid'])
    if (pid == null || iid == null) continue
    const key = mrTargetKey(pid, iid)
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
  return readDiffStatsLineTotalFromMergeRequestGql(mr)
}

function readDiffStatsLineTotalFromMergeRequestGql(mr: unknown): number | null {
  if (mr == null || typeof mr !== 'object') return null
  const s = (mr as Record<string, unknown>)['diffStatsSummary']
  if (s == null || typeof s !== 'object') return null
  const a = (s as Record<string, unknown>)['additions']
  const d = (s as Record<string, unknown>)['deletions']
  if (typeof a !== 'number' || typeof d !== 'number' || !Number.isFinite(a) || !Number.isFinite(d)) return null
  const add = a >= 0 ? Math.trunc(a) : 0
  const del = d >= 0 ? Math.trunc(d) : 0
  return add + del
}

/** Несколько iid одного проекта за один HTTP к /api/graphql. */
async function fetchMrDiffLineTotalsBatchGraphql(
  base: string,
  token: string,
  fullPath: string,
  iids: number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (iids.length === 0) return out

  const selectionLines = iids.map((iid, idx) => {
    const iidStr = JSON.stringify(String(iid))
    return `    m${idx}: mergeRequest(iid: ${iidStr}) { diffStatsSummary { additions deletions } }`
  })
  const query = `query GitlabStatsMrDiffBatch($fullPath: ID!) {
  project(fullPath: $fullPath) {
${selectionLines.join('\n')}
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
        variables: { fullPath },
      }),
    })
  } catch {
    return out
  }
  if (!r.ok) return out
  let j: unknown
  try {
    j = await r.json()
  } catch {
    return out
  }
  if (!j || typeof j !== 'object') return out
  const obj = j as { errors?: unknown; data?: { project?: Record<string, unknown> | null } | null }
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return out
  const project = obj.data?.project
  if (!project || typeof project !== 'object') return out

  for (let idx = 0; idx < iids.length; idx++) {
    const iid = iids[idx]
    const mr = project[`m${idx}`]
    const n = readDiffStatsLineTotalFromMergeRequestGql(mr)
    if (n != null) out.set(iid, n)
  }
  return out
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

/**
 * Считает дифф по MR для детализации и сводки: объединяет уникальные MR из одобрений, созданных и из комментариев,
 * чтобы не дублировать запросы; сумма approvedMrsDiffLinesTotal — только по MR из одобрений (как раньше).
 */
async function mergeRequestDiffLinesForApprovedTotalAndDetail(
  base: string,
  token: string,
  paths: Map<number, string>,
  approvedList: GitlabItem[],
  mrList: GitlabItem[],
  commentedList: GitlabItem[],
): Promise<{ approvedMrsDiffLinesTotal: number; byKey: Map<string, number> }> {
  const approvedTargets = uniqueApprovedMergeRequestTargets(approvedList)
  const createdTargets = uniqueMergeRequestTargetsFromMrList(mrList)
  const commentedTargets = uniqueMergeRequestTargetsFromCommentedList(commentedList)
  const seen = new Set<string>()
  const fetchTargets: { pid: number; iid: number }[] = []
  for (const t of [...approvedTargets, ...createdTargets, ...commentedTargets]) {
    const k = mrTargetKey(t.pid, t.iid)
    if (seen.has(k)) continue
    seen.add(k)
    fetchTargets.push(t)
  }

  const byKey = new Map<string, number>()

  const iidSetByPid = new Map<number, Set<number>>()
  for (const { pid, iid } of fetchTargets) {
    if (!paths.get(pid)) continue
    let s = iidSetByPid.get(pid)
    if (!s) {
      s = new Set()
      iidSetByPid.set(pid, s)
    }
    s.add(iid)
  }

  type GraphBatchTask = { pid: number; fullPath: string; iids: number[] }
  const graphTasks: GraphBatchTask[] = []
  for (const [pid, set] of iidSetByPid) {
    const fullPath = paths.get(pid)
    if (!fullPath) continue
    const iids = [...set]
    for (let i = 0; i < iids.length; i += MR_DIFF_GRAPHQL_IIDS_PER_REQUEST) {
      graphTasks.push({ pid, fullPath, iids: iids.slice(i, i + MR_DIFF_GRAPHQL_IIDS_PER_REQUEST) })
    }
  }

  for (let i = 0; i < graphTasks.length; i += MR_DIFF_GRAPHQL_HTTP_CONCURRENCY) {
    const slice = graphTasks.slice(i, i + MR_DIFF_GRAPHQL_HTTP_CONCURRENCY)
    const batchMaps = await Promise.all(
      slice.map((t) => fetchMrDiffLineTotalsBatchGraphql(base, token, t.fullPath, t.iids)),
    )
    for (let j = 0; j < slice.length; j++) {
      const { pid, iids } = slice[j]
      const m = batchMaps[j]
      for (const iid of iids) {
        const n = m.get(iid)
        if (n != null) byKey.set(mrTargetKey(pid, iid), n)
      }
    }
  }

  const fallback: { pid: number; iid: number }[] = []
  for (const { pid, iid } of fetchTargets) {
    if (!byKey.has(mrTargetKey(pid, iid))) fallback.push({ pid, iid })
  }
  for (let i = 0; i < fallback.length; i += MR_DIFF_FALLBACK_CHUNK) {
    const chunk = fallback.slice(i, i + MR_DIFF_FALLBACK_CHUNK)
    const parts = await Promise.all(
      chunk.map(({ pid, iid }) => fetchMrDiffLineTotal(base, token, paths, pid, iid)),
    )
    for (let j = 0; j < chunk.length; j++) {
      const { pid, iid } = chunk[j]
      byKey.set(mrTargetKey(pid, iid), parts[j])
    }
  }

  let approvedMrsDiffLinesTotal = 0
  for (const t of approvedTargets) {
    approvedMrsDiffLinesTotal += byKey.get(mrTargetKey(t.pid, t.iid)) ?? 0
  }

  return { approvedMrsDiffLinesTotal, byKey }
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

function mrTargetKey(projectId: number, mrIid: number): string {
  return `${projectId}:${mrIid}`
}

function tryReadAdditionsDeletionsSum(o: Record<string, unknown>): number | null {
  const a = o['additions']
  const d = o['deletions']
  const an = typeof a === 'number' && Number.isFinite(a) ? Math.max(0, Math.trunc(a)) : null
  const dn = typeof d === 'number' && Number.isFinite(d) ? Math.max(0, Math.trunc(d)) : null
  if (an == null || dn == null) return null
  return an + dn
}

/** Поля additions/deletions во вложенном target события (если GitLab отдал). */
function tryReadMrLineStatsFromEventTarget(e: Record<string, unknown>): number | null {
  const t = e['target']
  if (!t || typeof t !== 'object') return null
  return tryReadAdditionsDeletionsSum(t as Record<string, unknown>)
}

/** id автора MR из вложенного target события (одобрение и др.), если GitLab отдал. */
function readMrAuthorIdFromEventTarget(e: Record<string, unknown>): number | null {
  const t = e['target']
  if (!t || typeof t !== 'object') return null
  return readAuthorIdFromObject((t as Record<string, unknown>)['author'])
}

/** Первое событие одобрения по каждому MR (ключ projectId:iid) — для автора и размера диффа из target. */
function buildApprovalSampleByMrKey(approvedList: GitlabItem[]): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>()
  for (const row of approvedList) {
    const e = asRecord(row)
    const tt = typeof e['target_type'] === 'string' ? e['target_type'].trim() : ''
    const tl = tt.toLowerCase()
    if (tt !== 'MergeRequest' && tl !== 'mergerequest' && tl !== 'merge_request') continue
    const pid = asPositiveInt(e['project_id'])
    const iid = asPositiveInt(e['target_iid'])
    if (pid == null || iid == null) continue
    const k = mrTargetKey(pid, iid)
    if (!m.has(k)) m.set(k, e)
  }
  return m
}

/** additions/deletions во вложенном note.noteable для MR. */
function tryReadMrLineStatsFromCommentNoteable(e: Record<string, unknown>): number | null {
  const note = e['note']
  if (!note || typeof note !== 'object') return null
  const noteable = (note as Record<string, unknown>)['noteable']
  if (!noteable || typeof noteable !== 'object') return null
  const nb = noteable as Record<string, unknown>
  const typ =
    normalizeNoteableType(nb['type']) ??
    normalizeNoteableType(nb['noteable_type']) ??
    normalizeNoteableType((note as Record<string, unknown>)['noteable_type'])
  if (typ !== 'MergeRequest') return null
  return tryReadAdditionsDeletionsSum(nb)
}

function readChangesCountField(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.trunc(raw))
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (/^\d+$/.test(t)) return Number.parseInt(t, 10)
  }
  return null
}

/** Размер созданного MR из объекта списка /merge_requests (без доп. запросов). */
function readMrSizeFromMergeRequestListItem(m: Record<string, unknown>): {
  lines: number | null
  files: number | null
} {
  const lines = tryReadAdditionsDeletionsSum(m)
  const files = readChangesCountField(m['changes_count'])
  return { lines, files }
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
  pushedList: GitlabItem[],
  mrDiffLinesByKey: ReadonlyMap<string, number>,
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
    const pid = asPositiveInt(e['project_id'])
    const targetIid = asPositiveInt(e['target_iid'])
    const key =
      pid != null && targetIid != null ? mrTargetKey(pid, targetIid) : null
    const fromTarget = tryReadMrLineStatsFromEventTarget(e)
    let mrDiffLines: number | null = null
    if (key != null && mrDiffLinesByKey.has(key)) {
      mrDiffLines = mrDiffLinesByKey.get(key)!
    } else if (fromTarget != null) {
      mrDiffLines = fromTarget
    }
    out[dk].push({
      id: `approved-${typeof id === 'number' ? id : `${dk}-${out[dk].length}`}`,
      kind: 'approved',
      title: eventTitle(e),
      createdAt: typeof created === 'string' ? created : '',
      webUrl: eventWebUrl(base, paths, e),
      commentBody: null,
      mrDiffLines,
      mrChangesCount: null,
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
    const meta = mergeRequestCommentMeta(e)
    let mrDiffLines: number | null = null
    if (meta?.mrIid != null) {
      const k = mrTargetKey(meta.pid, meta.mrIid)
      if (mrDiffLinesByKey.has(k)) mrDiffLines = mrDiffLinesByKey.get(k)!
    }
    if (mrDiffLines == null) {
      mrDiffLines =
        tryReadMrLineStatsFromCommentNoteable(e) ?? tryReadMrLineStatsFromEventTarget(e)
    }
    out[dk].push({
      id: `commented-${typeof id === 'number' ? id : `${dk}-${out[dk].length}`}`,
      kind: 'commented',
      title: eventTitle(e),
      createdAt: typeof created === 'string' ? created : '',
      webUrl,
      commentBody: eventCommentBody(e),
      mrDiffLines,
      mrChangesCount: null,
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
    const pid = asPositiveInt(m['project_id'])
    const iid = asPositiveInt(m['iid'])
    const mapKey = pid != null && iid != null ? mrTargetKey(pid, iid) : null
    const { lines: listLines, files: listFiles } = readMrSizeFromMergeRequestListItem(m)
    let mrDiffLines: number | null = null
    if (mapKey != null && mrDiffLinesByKey.has(mapKey)) {
      mrDiffLines = mrDiffLinesByKey.get(mapKey)!
    } else if (listLines != null) {
      mrDiffLines = listLines
    }
    out[dk].push({
      id: `mr-${typeof id === 'number' ? id : `${dk}-${out[dk].length}`}`,
      kind: 'mr_created',
      title: typeof title === 'string' && title.trim() ? title.trim() : 'Merge request',
      createdAt: typeof created === 'string' ? created : '',
      webUrl: typeof web === 'string' && /^https?:\/\//i.test(web) ? web : null,
      commentBody: null,
      mrDiffLines,
      mrChangesCount: listFiles,
    })
  }

  for (const row of pushedList) {
    const dk = dayOf(row)
    if (!dk) continue
    const e = asRecord(row)
    const id = e['id']
    const created = e['created_at']
    out[dk].push({
      id: `push-${typeof id === 'number' ? id : `${dk}-${out[dk].length}`}`,
      kind: 'push_commits',
      title: eventTitle(e),
      createdAt: typeof created === 'string' ? created : '',
      webUrl: pushEventWebUrl(base, paths, e),
      commentBody: null,
      mrDiffLines: null,
      mrChangesCount: null,
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
async function readGitlabListTotalNumber(
  url: string,
  token: string,
): Promise<
  | { ok: true; total: number; httpStatus: number }
  | { ok: false; status: number; message: string }
> {
  let response: Response
  try {
    response = await gitlabFetch(url, token.trim(), 'HEAD')
  } catch {
    return { ok: false, status: 502, message: 'Не удалось подключиться к GitLab.' }
  }

  let total = readXTotal(response.headers)

  if (total == null) {
    try {
      response = await gitlabFetch(url, token.trim(), 'GET')
      total = readXTotal(response.headers)
    } catch {
      return { ok: false, status: 502, message: 'Не удалось подключиться к GitLab.' }
    }
  }

  if (!response.ok && total == null) {
    const text = await response.text().catch(() => '')
    return {
      ok: false,
      status: response.status >= 400 && response.status < 600 ? response.status : 502,
      message: `GitLab ответил ${response.status}. ${text.slice(0, 400)}`,
    }
  }

  const n = Number.parseInt(total ?? '0', 10)
  return { ok: true, total: Number.isFinite(n) ? n : 0, httpStatus: response.status }
}

async function respondWithGitlabListTotal(
  res: express.Response,
  url: string,
  token: string,
): Promise<void> {
  const r = await readGitlabListTotalNumber(url, token)
  if (!r.ok) {
    res.status(r.status).json({ error: r.message })
    return
  }

  res.json({
    total: String(r.total),
    status: r.httpStatus,
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

app.post('/api/list-users', async (req, res) => {
  const gitlabUrl = req.body?.gitlabUrl as string | undefined
  const token = req.body?.token as string | undefined

  if (!gitlabUrl?.trim() || !token?.trim()) {
    res.status(400).json({ error: 'Укажите URL GitLab и токен.' })
    return
  }

  const base = normalizeBaseUrl(gitlabUrl)
  const out: { username: string; name: string }[] = []
  const seen = new Set<string>()

  for (let page = 1; page <= MAX_USER_LIST_PAGES; page++) {
    const p = new URLSearchParams({
      per_page: String(PER_PAGE),
      page: String(page),
    })
    const url = `${base}/api/v4/users?${p}`
    let r: Response
    try {
      r = await gitlabFetch(url, token.trim(), 'GET')
    } catch {
      res.status(502).json({ error: 'Не удалось подключиться к GitLab.' })
      return
    }
    if (!r.ok) {
      const text = await r.text()
      res.status(r.status >= 400 && r.status < 600 ? r.status : 502).json({
        error: `GitLab ответил ${r.status}. ${text.slice(0, 400)}`,
      })
      return
    }
    let chunk: unknown
    try {
      chunk = await r.json()
    } catch {
      res.status(502).json({ error: 'Не удалось разобрать ответ GitLab.' })
      return
    }
    if (!Array.isArray(chunk)) {
      res.status(502).json({ error: 'Неожиданный ответ GitLab (ожидался массив пользователей).' })
      return
    }
    for (const row of chunk) {
      if (!row || typeof row !== 'object') continue
      const o = row as Record<string, unknown>
      const username = typeof o.username === 'string' ? o.username.trim() : ''
      if (!username || seen.has(username)) continue
      seen.add(username)
      const rawName = typeof o.name === 'string' ? o.name.trim() : ''
      const name = rawName || username
      out.push({ username, name })
    }
    if (chunk.length < PER_PAGE) break
  }

  out.sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }))
  res.json({ users: out, count: out.length })
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
  const baseMrParams = new URLSearchParams({
    author_id: String(userId),
    created_after: createdAfter.trim(),
    created_before: createdBefore.trim(),
    per_page: String(PER_PAGE),
    state: 'all',
    scope: 'all',
  })

  const branchResults = await Promise.all(
    AUTHOR_MR_TARGET_BRANCHES.map(async (branch) => {
      const p = new URLSearchParams(baseMrParams)
      p.set('target_branch', branch)
      const url = `${base}/api/v4/merge_requests?${p}`
      return readGitlabListTotalNumber(url, token.trim())
    }),
  )

  let sum = 0
  let lastHttpStatus = 200
  for (const r of branchResults) {
    if (!r.ok) {
      res.status(r.status).json({ error: r.message })
      return
    }
    sum += r.total
    lastHttpStatus = r.httpStatus
  }

  res.json({
    total: String(sum),
    status: lastHttpStatus,
  })
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
  const pushedUrl = (page: number) =>
    `${base}/api/v4/users/${userId}/events?${userEventsSearch({ action: 'pushed' })}&page=${page}`

  const mrBaseParams = new URLSearchParams({
    author_id: String(userId),
    created_after: ra,
    created_before: rb,
    per_page: String(PER_PAGE),
    state: 'all',
    scope: 'all',
  })

  const mrCollectTasks = AUTHOR_MR_TARGET_BRANCHES.map((branch) => {
    const p = new URLSearchParams(mrBaseParams)
    p.set('target_branch', branch)
    const mrUrl = (page: number) => `${base}/api/v4/merge_requests?${p}&page=${page}`
    return collectGitlabPagesOnly(mrUrl, token.trim())
  })

  const [approvedRes, commentedRes, noteRes, pushedRes, ...mrResList] = await Promise.all([
    collectGitlabPagesOnly(approvedUrl, token.trim()),
    collectGitlabPagesOnly(commentedUrl, token.trim()),
    collectGitlabPagesOnly(noteEventsUrl, token.trim()),
    collectGitlabPagesOnly(pushedUrl, token.trim()),
    ...mrCollectTasks,
  ])

  for (const result of [approvedRes, commentedRes, noteRes, pushedRes, ...mrResList]) {
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

  const approvedList = dedupEventsById(approvedRes.items)
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
  const mrList = dedupEventsById(
    filterMrsByAllowedTargetBranch(mrResList.flatMap((r) => (r.ok ? r.items : []))),
  )
  const pushedList = dedupEventsById(pushedRes.items).filter(
    (row) => !pushEventIsMergeBranchCommitTitle(asRecord(row)),
  )

  const days = enumerateYmdInclusive(sd, ed)
  const approved = new Array<number>(days.length).fill(0)
  const commented = new Array<number>(days.length).fill(0)
  const mrsCreated = new Array<number>(days.length).fill(0)
  const pushCommits = new Array<number>(days.length).fill(0)
  const indexByDay = new Map<string, number>()
  days.forEach((d, i) => indexByDay.set(d, i))

  for (const row of pushedList) {
    const iso = row.created_at
    if (typeof iso !== 'string') continue
    const day = dayKeyInTimeZone(iso, timeZone)
    const idx = indexByDay.get(day)
    if (idx === undefined) continue
    pushCommits[idx] += 1
  }

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
  for (const row of pushedList) {
    const e = asRecord(row)
    const pid = asPositiveInt(e['project_id'])
    if (pid != null) projectIds.push(pid)
  }

  const paths = await fetchProjectPaths(base, token.trim(), projectIds)
  const [diffBundle, commentWebUrlByEventId] = await Promise.all([
    mergeRequestDiffLinesForApprovedTotalAndDetail(base, token.trim(), paths, approvedList, mrList, commentedList),
    enrichCommentedWebUrls(base, token.trim(), paths, commentedList),
  ])
  const approvedMrsDiffLinesTotal = diffBundle.approvedMrsDiffLinesTotal
  const mrDiffLinesByKey = diffBundle.byKey
  const createdTargets = uniqueMergeRequestTargetsFromMrList(mrList)
  let createdMrsDiffLinesTotal = 0
  for (const t of createdTargets) {
    createdMrsDiffLinesTotal += mrDiffLinesByKey.get(mrTargetKey(t.pid, t.iid)) ?? 0
  }
  const foreignMrCommentCount = commentedList.length
  const avgLinesPerComment =
    foreignMrCommentCount > 0 ? approvedMrsDiffLinesTotal / foreignMrCommentCount : null
  const medianBuilt = buildMedianMrBreakdownRows(commentedList, approvedList, userId, mrDiffLinesByKey)
  const medianLinesPerCommentByMr = medianBuilt.median
  const medianLinesPerCommentMrBreakdown = mergeMedianMrBreakdownWithEventData(
    base,
    paths,
    medianBuilt.rows,
    approvedList,
    commentedList,
  )

  const mrsCreatedDiffLinesByDay = new Array<number>(days.length).fill(0)
  for (const row of mrList) {
    const iso = row.created_at
    if (typeof iso !== 'string') continue
    const day = dayKeyInTimeZone(iso, timeZone)
    const idx = indexByDay.get(day)
    if (idx === undefined) continue
    const m = asRecord(row)
    const pid = asPositiveInt(m['project_id'])
    const iid = asPositiveInt(m['iid'])
    const mapKey = pid != null && iid != null ? mrTargetKey(pid, iid) : null
    let lines = 0
    if (mapKey != null && mrDiffLinesByKey.has(mapKey)) {
      lines = mrDiffLinesByKey.get(mapKey) ?? 0
    } else {
      const { lines: listLines } = readMrSizeFromMergeRequestListItem(m)
      lines =
        listLines != null && Number.isFinite(listLines) ? Math.max(0, Math.trunc(listLines)) : 0
    }
    mrsCreatedDiffLinesByDay[idx] += lines
  }

  const detailByDay = buildDetailByDay(
    base,
    paths,
    days,
    timeZone,
    approvedList,
    commentedList,
    mrList,
    pushedList,
    mrDiffLinesByKey,
    commentWebUrlByEventId,
  )

  res.json({
    days,
    approved,
    commented,
    mrsCreated,
    /** Число событий pushed за день (каждое событие = 1); с commit_title, содержащим «Merge branch», не учитываются. */
    pushCommits,
    /** Согласовано с рядом pushCommits: сумма по дням в календарном диапазоне. */
    pushCommitsTotal: pushCommits.reduce((s, n) => s + n, 0),
    mrsCreatedDiffLinesByDay,
    timeZone,
    detailByDay,
    approvedMrsDiffLinesTotal,
    createdMrsDiffLinesTotal,
    foreignMrCommentCount,
    avgLinesPerComment,
    /** Медиана по чужим MR: комментарии — (дифф) / (число комментариев); только одобрение без комментариев — отношение 0; плюс все одобрённые чужие MR. */
    medianLinesPerCommentByMr,
    /** Разбивка для модалки: дифф, заметки в MR (user_notes_count); сортировка по убыванию стр./комм. */
    medianLinesPerCommentMrBreakdown,
    /** События approved за интервал after/before (после дедупликации по id), для сводки без отдельного HEAD. */
    approvedEventsTotal: approvedList.length,
    /** Созданные MR (develop/dev), уникальные по id после фильтра веток — согласовано с рядами mrsCreated. */
    mergeRequestsCreatedTotal: mrList.length,
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
