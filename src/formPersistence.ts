import { getFormDefaultsFromEnv } from './formEnvDefaults'
import { isPresetUsername } from './teamPresets'

export const FORM_STORAGE_KEY = 'gitlab-stats-form-v2'

export type PersistedPeriod = { id: string; startDate: string; endDate: string }

export type PersistedFormV2 = {
  v: 2
  gitlabUrl: string
  token: string
  username: string
  userEntryMode: 'list' | 'manual'
  periods: PersistedPeriod[]
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

function newPeriodId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function createEmptyPeriodRow(): PersistedPeriod {
  return { id: newPeriodId(), startDate: '', endDate: '' }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

/** Читает сохранённую форму; поддерживает миграцию с v1 (одна пара дат). */
export function loadPersistedForm(): Partial<PersistedFormV2> | null {
  try {
    const raw = localStorage.getItem(FORM_STORAGE_KEY)
    if (!raw?.trim()) return null
    const j = JSON.parse(raw) as unknown
    if (!isRecord(j)) return null

    const env = getFormDefaultsFromEnv()
    const base: Partial<PersistedFormV2> = {
      gitlabUrl: typeof j.gitlabUrl === 'string' ? j.gitlabUrl : env.gitlabUrl,
      token: typeof j.token === 'string' ? j.token : env.token,
      username: typeof j.username === 'string' ? j.username : env.username,
      userEntryMode: j.userEntryMode === 'manual' || j.userEntryMode === 'list' ? j.userEntryMode : undefined,
    }

    if (j.v === 2 && Array.isArray(j.periods)) {
      const periods = j.periods
        .filter((p): p is PersistedPeriod => {
          if (!isRecord(p)) return false
          return typeof p.id === 'string' && typeof p.startDate === 'string' && typeof p.endDate === 'string'
        })
        .map((p) => ({ id: p.id, startDate: p.startDate, endDate: p.endDate }))
      if (periods.length > 0) {
        return { ...base, v: 2, periods }
      }
    }

    const legacy = j as LegacyV1
    if (typeof legacy.startDate === 'string' && legacy.startDate.trim()) {
      return {
        ...base,
        v: 2,
        periods: [{ id: newPeriodId(), startDate: legacy.startDate, endDate: String(legacy.endDate ?? '') }],
      }
    }

    if (base.gitlabUrl || base.token || base.username) {
      return base
    }
    return null
  } catch {
    return null
  }
}

export function savePersistedForm(data: PersistedFormV2): void {
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
  username: string
  userEntryMode: 'list' | 'manual'
  periods: PersistedPeriod[]
} {
  const env = getFormDefaultsFromEnv()
  const persisted = loadPersistedForm()

  const gitlabUrl = (persisted?.gitlabUrl ?? '').trim() || env.gitlabUrl
  const token = (persisted?.token ?? '').trim() || env.token

  let username = ''
  let userEntryMode: 'list' | 'manual' = 'list'
  if (persisted?.username && String(persisted.username).trim()) {
    const inferred = buildInitialUserFromUsername(String(persisted.username))
    username = inferred.username
    userEntryMode = persisted.userEntryMode ?? inferred.userEntryMode
  } else if (env.username.trim()) {
    const eu = env.username.trim()
    if (isPresetUsername(eu)) {
      username = eu
      userEntryMode = 'list'
    } else {
      username = eu
      userEntryMode = 'manual'
    }
  }

  let periods: PersistedPeriod[]
  if (persisted?.periods && persisted.periods.length > 0) {
    periods = persisted.periods.map((r) => ({ ...r }))
  } else {
    periods = [{ id: newPeriodId(), startDate: env.startDate, endDate: env.endDate }]
  }

  return { gitlabUrl, token, username, userEntryMode, periods }
}

export { newPeriodId }
