/**
 * Client half of dsh-lan-access: registers the LAN-access toggle row into the
 * Settings shell's General section (`settings.general.item`), following the
 * DSH settings-row recipe. The row reads and writes the fenced /lan-access
 * host route; the host owns the settings namespace and the webserver rebind.
 */
import type { Context } from '@deepseek-ai/cordis'
import { LanAccessRow, type LanAccessRowInjected } from './LanAccessRow.tsx'
import { attachLocale, en, LOCALE_NS, zh, type LanAccessLocaleService } from './locales.ts'
import { installRandomUUIDPolyfill } from './polyfill.ts'

/** The client slots service face (subset of the runtime SlotRegistry). */
export interface LanAccessSlotsService {
  register(options: {
    name: string
    id?: string
    order?: number
    locale?: string
    inject?: (...args: unknown[]) => object
  }, component: unknown): () => void
  /** Run a callback for each declaration lifetime of a slot (no-op while undeclared). */
  inject(key: string, callback: () => () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: LanAccessSlotsService
    locale: LanAccessLocaleService
  }
}

// Module scope: run as soon as this bundle materializes. On a plain-HTTP LAN
// origin crypto.randomUUID does not exist (non-secure context), which breaks
// every API RPC ("crypto.randomUUID is not a function"); the connection loop
// retries with backoff, so the polyfill lands before its next handshake.
installRandomUUIDPolyfill()

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'locale']

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, locale).
 */
export function apply(ctx: Context): void {
  // Defensive re-install (module scope already ran; tests may mount directly).
  installRandomUUIDPolyfill()
  // Follow the DSH i18n system: register the plugin's dictionaries into the
  // shared locale registry; the row re-renders on locale switches through
  // the bound service. Disposers run on fiber disposal (HMR-safe).
  attachLocale(ctx.locale)
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    return () => { offZh(); offEn() }
  }, 'dsh-lan-access: dictionaries')

  // The General-settings row: contributed only while the General entry
  // declares the item slot.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'lan-access',
    order: 15,
    inject: (): LanAccessRowInjected => ({}),
  }, LanAccessRow))
}
