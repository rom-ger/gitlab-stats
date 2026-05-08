/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GITLAB_URL?: string
  readonly VITE_GITLAB_TOKEN?: string
  readonly VITE_GITLAB_USERNAME?: string
  readonly VITE_STATS_DATE_START?: string
  readonly VITE_STATS_DATE_END?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
