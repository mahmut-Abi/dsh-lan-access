/**
 * zh/en copy for the LAN-access settings row, registered into the DSH locale
 * registry under the plugin namespace. `attachLocale` binds the client
 * locale service (provided by @deepseek-ai/dsh-client-locale) at apply time;
 * `translate` resolves the active locale through it, falling back to the
 * browser language when the service is absent (standalone/test compositions).
 */

/** Locale dictionary key space (one key per row string). */
export type LanAccessDict = {
  title: string
  desc: string
  urlLabel: string
  copy: string
  copied: string
  applying: string
  loading: string
  loadFailed: string
  saveFailed: string
  timeout: string
}

/** Simplified Chinese copy. */
export const zh: LanAccessDict = {
  title: '局域网访问',
  desc: '允许同一网络中的其他设备打开此界面（绑定 0.0.0.0）。',
  urlLabel: '其他设备可访问',
  copy: '复制',
  copied: '已复制',
  applying: '正在应用更改，连接会短暂中断…',
  loading: '加载中…',
  loadFailed: '无法读取访问状态',
  saveFailed: '更改失败',
  timeout: '服务器重启后未能重新连接，请刷新页面重试',
}

/** English copy. */
export const en: LanAccessDict = {
  title: 'LAN access',
  desc: 'Let other devices on the same network open this GUI (bind 0.0.0.0).',
  urlLabel: 'Other devices can open',
  copy: 'Copy',
  copied: 'Copied',
  applying: 'Applying change — the connection will drop briefly…',
  loading: 'Loading…',
  loadFailed: 'Failed to read the access state',
  saveFailed: 'Failed to apply the change',
  timeout: 'Could not reconnect after the server restart — refresh the page',
}

/** The plugin's locale namespace (dictionary registry key). */
export const LOCALE_NS = 'lan-access'

/** The locale service face this plugin consumes (subset of LocaleRuntime). */
export interface LanAccessLocaleService {
  getSnapshot(): { active: string }
  subscribe(fn: () => void): () => void
  register(ns: string, locale: string, dict: Record<string, string>): () => void
}

let service: LanAccessLocaleService | undefined

/** Bind the locale service (apply time); the row re-renders on locale switches. */
export function attachLocale(locale: LanAccessLocaleService): void {
  service = locale
}

/** Current active locale id ('zh' | 'en'), or a browser-language guess. */
export function activeLocale(): string {
  if (service !== undefined) return service.getSnapshot().active
  if (typeof navigator !== 'undefined') {
    const primary = (navigator.language ?? '').toLowerCase().split('-')[0]
    if (primary === 'zh') return 'zh'
  }
  return 'en'
}

/** Resolve one copy key in the active locale. */
export function translate(key: keyof LanAccessDict): string {
  const dict = activeLocale() === 'zh' ? zh : en
  return dict[key] ?? String(key)
}

/** React subscription seam for the active locale (useSyncExternalStore). */
export function subscribeLocale(fn: () => void): () => void {
  return service?.subscribe(fn) ?? (() => {})
}
