function trimOrEmpty(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Значения из `.env` для начального состояния формы (только `VITE_*` доступны в браузере). */
export function getFormDefaultsFromEnv() {
  return {
    gitlabUrl: trimOrEmpty(import.meta.env.VITE_GITLAB_URL),
    token: trimOrEmpty(import.meta.env.VITE_GITLAB_TOKEN),
    username: trimOrEmpty(import.meta.env.VITE_GITLAB_USERNAME),
    startDate: trimOrEmpty(import.meta.env.VITE_STATS_DATE_START),
    endDate: trimOrEmpty(import.meta.env.VITE_STATS_DATE_END),
  }
}
