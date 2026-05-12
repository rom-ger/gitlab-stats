import { getFormDefaultsFromEnv } from './formEnvDefaults'
import { isPresetUsername } from './teamPresets'

export const FORM_STORAGE_KEY = 'gitlab-stats-form-v2'

export type PersistedPeriod = { id: string; startDate: string; endDate: string }

/** Строка «сотрудник для сравнения» (логин + режим выбора, как в v2 для одного пользователя). */
export type PersistedCompareUser = {
  id: string
  username: string
  userEntryMode: 'list' | 'manual'
}

export type PersistedFormV3 = {
  v: 3
  gitlabUrl: string
  token: string
  users: PersistedCompareUser[]
  periods: PersistedPeriod[]
}

type LegacyV2 = {
  v?: number
  gitlabUrl?: string
  token?: string
  username?: string
  userEntryMode?: 'list' | 'manual'
  periods?: unknown
}

type LegacyV1 = {
  v?: number
  gitlabUrl?: string
  token?: string
  username?: string
  userEntryMode?: 'list' | 'manual'
  startDate?: string
  endDate?: string
}

function newCompareUserId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `u-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function newPeriodId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function createEmptyPeriodRow(): PersistedPeriod {
  return { id: newPeriodId(), startDate: '', endDate: '' }
}

export function createEmptyCompareUserRow(): PersistedCompareUser {
  return { id: newCompareUserId(), username: '', userEntryMode: 'list' }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function parsePeriods(raw: unknown): PersistedPeriod[] | null {
  if (!Array.isArray(raw)) return null
  const out: PersistedPeriod[] = []
  for (const p of raw) {
    if (!isRecord(p)) continue
    if (typeof p.id === 'string' && typeof p.startDate === 'string' && typeof p.endDate === 'string') {
      out.push({ id: p.id, startDate: p.startDate, endDate: p.endDate })
    }
  }
  return out.length > 0 ? out : null
}

function parseUsersV3(raw: unknown): PersistedCompareUser[] | null {
  if (!Array.isArray(raw)) return null
  const out: PersistedCompareUser[] = []
  for (const u of raw) {
    if (!isRecord(u)) continue
    if (typeof u.id !== 'string') continue
    const username = typeof u.username === 'string' ? u.username : ''
    const mode = u.userEntryMode === 'manual' || u.userEntryMode === 'list' ? u.userEntryMode : 'list'
    out.push({ id: u.id, username, userEntryMode: mode })
  }
  return out.length > 0 ? out : null
}

/** Читает сохранённую форму; v1 → v2 → v3. */
export function loadPersistedForm(): Partial<PersistedFormV3> | null {
  try {
    const raw = localStorage.getItem(FORM_STORAGE_KEY)
    if (!raw?.trim()) return null
    const j = JSON.parse(raw) as unknown
    if (!isRecord(j)) return null

    const env = getFormDefaultsFromEnv()
    const base: Partial<PersistedFormV3> = {
      gitlabUrl: typeof j.gitlabUrl === 'string' ? j.gitlabUrl : env.gitlabUrl,
      token: typeof j.token === 'string' ? j.token : env.token,
    }

    if (j.v === 3 && Array.isArray(j.users)) {
      const users = parseUsersV3(j.users)
      if (users) {
        const periodsParsed = parsePeriods(j.periods)
        return { ...base, v: 3, users, periods: periodsParsed ?? undefined }
      }
    }

    const legacy2 = j as LegacyV2
    const usersFromLegacy = (() => {
      const u = typeof legacy2.username === 'string' ? legacy2.username.trim() : ''
      if (!u) return null
      const mode =
        legacy2.userEntryMode === 'manual' || legacy2.userEntryMode === 'list'
          ? legacy2.userEntryMode
          : buildInitialUserFromUsername(u).userEntryMode
      return [{ id: newCompareUserId(), username: u, userEntryMode: mode }]
    })()

    if (legacy2.v === 2 && Array.isArray(legacy2.periods)) {
      const periods = parsePeriods(legacy2.periods)
      if (periods) {
        const users =
          usersFromLegacy ??
          (() => {
            const row = createEmptyCompareUserRow()
            const u = typeof legacy2.username === 'string' ? legacy2.username.trim() : ''
            if (u) {
              row.username = u
              row.userEntryMode =
                legacy2.userEntryMode === 'manual' || legacy2.userEntryMode === 'list'
                  ? legacy2.userEntryMode
                  : buildInitialUserFromUsername(u).userEntryMode
            }
            return [row]
          })()
        return { ...base, v: 3, users, periods }
      }
    }

    const legacy = j as LegacyV1
    if (typeof legacy.startDate === 'string' && legacy.startDate.trim()) {
      const periods: PersistedPeriod[] = [
        { id: newPeriodId(), startDate: legacy.startDate, endDate: String(legacy.endDate ?? '') },
      ]
      if (usersFromLegacy) {
        return { ...base, v: 3, users: usersFromLegacy, periods }
      }
      const emptyUser = createEmptyCompareUserRow()
      const envU = env.username.trim()
      if (envU) {
        const inferred = buildInitialUserFromUsername(envU)
        emptyUser.username = inferred.username
        emptyUser.userEntryMode = inferred.userEntryMode
      }
      return { ...base, v: 3, users: [emptyUser], periods }
    }

    if (usersFromLegacy) {
      return { ...base, v: 3, users: usersFromLegacy, periods: undefined }
    }

    if (base.gitlabUrl || base.token) {
      return base
    }
    return null
  } catch {
    return null
  }
}

export function savePersistedForm(data: PersistedFormV3): void {
  try {
    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* quota / private mode */
  }
}

export function buildInitialUserFromUsername(username: string): { username: string; userEntryMode: 'list' | 'manual' } {
  const u = username.trim()
  if (!u) return { username: '', userEntryMode: 'list' }
  if (isPresetUsername(u)) return { username: u, userEntryMode: 'list' }
  return { username: u, userEntryMode: 'manual' }
}

/** Однократное чтение localStorage + env для начального состояния формы (вызывать один раз при старте приложения). */
export function getInitialFormBootstrap(): {
  gitlabUrl: string
  token: string
  users: PersistedCompareUser[]
  periods: PersistedPeriod[]
} {
  const env = getFormDefaultsFromEnv()
  const persisted = loadPersistedForm()

  const gitlabUrl = (persisted?.gitlabUrl ?? '').trim() || env.gitlabUrl
  const token = (persisted?.token ?? '').trim() || env.token

  let users: PersistedCompareUser[]
  if (persisted?.v === 3 && persisted.users && persisted.users.length > 0) {
    users = persisted.users.map((u) => ({ ...u }))
  } else {
    const row = createEmptyCompareUserRow()
    if (env.username.trim()) {
      const inferred = buildInitialUserFromUsername(env.username.trim())
      row.username = inferred.username
      row.userEntryMode = inferred.userEntryMode
    }
    users = [row]
  }

  let periods: PersistedPeriod[]
  if (persisted?.periods && persisted.periods.length > 0) {
    periods = persisted.periods.map((r) => ({ ...r }))
  } else {
    periods = [{ id: newPeriodId(), startDate: env.startDate, endDate: env.endDate }]
  }

  return { gitlabUrl, token, users, periods }
}
