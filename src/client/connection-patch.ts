/**
 * Runtime connection patch: makes the DSH client treat a LAN-served page
 * like the local page, and routes the loopback-pinned settings/credentials
 * RPCs through this plugin's fenced proxy. Applied from the plugin's apply,
 * which injects only `connection` (available in the first boot wave, before
 * any settings surface binds), so every settingsScope consumer and every
 * direct api caller sees the patched behavior — no harness change needed.
 */

/** The connection handle slice this patch touches. */
export interface LanAccessConnectionHandle {
  isLoopback: boolean
  api: {
    settings?: Record<string, (...args: unknown[]) => Promise<unknown>>
    credentials?: Record<string, (...args: unknown[]) => Promise<unknown>>
  }
}

/** One RPC result envelope (mirror of the /api RpcResult wire form). */
type RpcResultEnvelope =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

/** One RPC response envelope; rpcId echoes the request. */
interface RpcResponseEnvelope {
  rpcId: string
  result: RpcResultEnvelope
}

/** The plugin's fenced RPC route. */
const RPC_PATH = '/lan-access/rpc'

/** Whether a WHATWG hostname is a non-loopback IPv4 literal (the served-LAN case). */
function isServedLanHostname(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  if (!parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false
  return parts[0] !== '127'
}

/** Mint one rpc id (the plugin's bundle installs the randomUUID polyfill). */
function mintRpcId(): string {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid === 'function') return uuid()
  return `lan-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Call one proxied method; the response keeps the /api envelope shape. */
async function rpcCall(
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<RpcResponseEnvelope> {
  let response: Response
  try {
    response = await fetch(RPC_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: mintRpcId(), method, payload }),
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    throw new Error(`transport failure for ${method}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`transport failure for ${RPC_PATH}: HTTP ${String(response.status)}`)
  return await response.json() as RpcResponseEnvelope
}

/**
 * Patch the shared connection handle:
 * 1. `isLoopback` becomes "loopback OR served LAN authority", so
 *    settingsScope-bound surfaces use host persistence on LAN pages;
 * 2. `api.settings.*` / `api.credentials.*` route through the plugin's
 *    fenced proxy instead of the loopback-pinned /api methods.
 * @param connection - the ctx.connection handle (patched in place).
 * @returns the disposer restoring every patched member (HMR-safe).
 */
export function installConnectionPatch(connection: LanAccessConnectionHandle): () => void {
  const restorers: Array<() => void> = []

  // Skip fixture mode (test pages) — the fixture api must stay untouched.
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('fixture')) {
    return () => {}
  }

  const originalIsLoopback = connection.isLoopback
  try {
    Object.defineProperty(connection, 'isLoopback', {
      configurable: true,
      get: (): boolean => originalIsLoopback
        || (typeof location !== 'undefined' && isServedLanHostname(location.hostname)),
    })
    restorers.push(() => {
      Object.defineProperty(connection, 'isLoopback', {
        configurable: true,
        writable: true,
        value: originalIsLoopback,
      })
    })
  } catch {
    // Non-fatal: without the classification, settings surfaces stay in
    // memory mode on LAN pages (the pre-patch behavior).
  }

  const wrapMethod = (face: 'settings' | 'credentials', method: string): void => {
    const target = connection.api[face]
    if (target === undefined) return
    const original = target[method]
    if (typeof original !== 'function') return
    target[method] = (...args: unknown[]): Promise<unknown> =>
      rpcCall(`${face}.${method}`, args[0], args[1] as AbortSignal | undefined)
    restorers.push(() => { target[method] = original })
  }
  for (const method of ['describe', 'update', 'replace', 'mutate', 'openDocument']) {
    wrapMethod('settings', method)
  }
  for (const method of ['describe', 'set', 'unset']) {
    wrapMethod('credentials', method)
  }

  return () => {
    for (const restore of restorers) {
      try { restore() } catch { /* ignore */ }
    }
  }
}
