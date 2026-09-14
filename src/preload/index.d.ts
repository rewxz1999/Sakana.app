import type { SakanaApi } from '../shared/api'

declare global {
  interface Window {
    sakana: SakanaApi
  }
}

export {}
