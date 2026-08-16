/**
 * Client half of dsh-lan-access. Two jobs:
 *
 * 1. A runtime connection patch that makes LAN-served pages behave like the
 *    local page WITHOUT any harness change: `connection.isLoopback` is
 *    widened to "loopback OR served LAN authority" (so settingsScope-bound
 *    surfaces use host persistence on LAN), and the loopback-pinned
 *    `api.settings.*` / `api.credentials.*` calls are routed through this
 *    plugin's fenced /lan-access/rpc proxy. The plugin injects only
 *    `connection`, which is available in the first boot wave — before any
 *    settings surface binds — so the patch is in place deterministically.
 *
 * 2. The LAN-access toggle row in the Settings shell's General section
 *    (`settings.general.item`), which reads and writes the fenced
 *    /lan-access host route; the host owns the settings namespace and the
 *    webserver rebind.
 */
import type { Context } from '@deepseek-ai/cordis'
import { LanAccessRow, type LanAccessRowInjected } from './LanAccessRow.tsx'
import { attachLocale, en, LOCALE_NS, zh, type LanAccessLocaleService } from './locales.ts'
import { installRandomUUIDPolyfill } from './polyfill.ts'
import { installConnectionPatch, type LanAccessConnectionHandle } from './connection-patch.ts'

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
    connection: LanAccessConnectionHandle
  }
}

// Module scope: run as soon as this bundle materializes. On a plain-HTTP LAN
// origin crypto.randomUUID does not exist (non-secure context), which breaks
// every API RPC ("crypto.randomUUID is not a function"); the connection loop
// retries with backoff, so the polyfill lands before its next handshake.
installRandomUUIDPolyfill()

/**
 * Services required before mounting: ONLY `connection` — provided in the
 * first boot wave, before the settings surfaces (which wait on `remote` /
 * `settingsScope`) bind. The settings row itself is mounted from a child
 * fiber once slots + locale exist.
 */
export const inject = ['connection']

/**
 * Client plugin body.
 * @param ctx - the client cordis context (connection injected; slots/locale via child fiber).
 */
export function apply(ctx: Context): void {
  // Defensive re-install (module scope already ran; tests may mount directly).
  installRandomUUIDPolyfill()
  // The connection patch: served-authority classification + settings/
  // credentials RPC routing. Runs in the first boot wave, so every settings
  // consumer that binds later sees the patched behavior. Disposed with this
  // fiber (HMR-safe).
  const connection = ctx.get('connection')
  if (connection !== undefined) {
    ctx.effect(() => installConnectionPatch(connection), 'dsh-lan-access: connection patch')
  }

  // The settings row + dictionaries need slots/locale, which arrive later;
  // mount them in a child fiber that waits for those services.
  ctx.inject(['slots', 'locale'], (uiCtx) => {
    // Follow the DSH i18n system: register the plugin's dictionaries into the
    // shared locale registry; the row re-renders on locale switches through
    // the bound service. Disposers run on fiber disposal (HMR-safe).
    attachLocale(uiCtx.locale)
    uiCtx.effect(() => {
      const offZh = uiCtx.locale.register(LOCALE_NS, 'zh', zh)
      const offEn = uiCtx.locale.register(LOCALE_NS, 'en', en)
      return () => { offZh(); offEn() }
    }, 'dsh-lan-access: dictionaries')

    // The General-settings row: contributed only while the General entry
    // declares the item slot.
    uiCtx.slots.inject('settings.general.item', () => uiCtx.slots.register({
      name: 'settings.general.item',
      id: 'lan-access',
      order: 15,
      inject: (): LanAccessRowInjected => ({}),
    }, LanAccessRow))
  })
}
