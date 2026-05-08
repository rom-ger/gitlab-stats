export type TeamMember = { readonly username: string; readonly name: string }

/** Логин хранится в `username`, в интерфейсе показываем только `name`. */
export const TEAM_USERS: readonly TeamMember[] = [
  { username: 'romger', name: 'Роман Герасимович' },
  { username: 'agafonov.denis', name: 'Денис Агафонов' },
  { username: 'sultan.usmanov', name: 'Султан Усманов' },
  { username: 'anton.zherebtsov', name: 'Антон Жеребцов' },
  { username: 'vsevolod.pantjukhin', name: 'Всеволод Пантюхин' },
] as const

const CUSTOM_SELECT_VALUE = '__custom__'

export { CUSTOM_SELECT_VALUE }

export function teamDisplayName(username: string): string | undefined {
  return TEAM_USERS.find((u) => u.username === username)?.name
}

export function isPresetUsername(username: string): boolean {
  return TEAM_USERS.some((u) => u.username === username)
}
