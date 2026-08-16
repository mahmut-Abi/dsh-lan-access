/**
 * crypto.randomUUID polyfill for non-secure contexts.
 *
 * The DSH browser API client mints every RPC id with `crypto.randomUUID()`
 * (packages/host/apiproxy/src/fetch/client.ts). That Web API only exists in
 * SECURE contexts — HTTPS, or http://localhost/127.0.0.1 — so on a plain-HTTP
 * LAN origin (http://192.168.x.x:3080) it is undefined and every RPC throws
 * "crypto.randomUUID is not a function", breaking the workspace and other
 * API surfaces on remote machines. The polyfill supplies a UUID v4 built on
 * `crypto.getRandomValues`, which IS available in insecure contexts.
 *
 * Installed at module scope (runs when this bundle materializes, before the
 * connection loop's next backoff retry) and again defensively in apply.
 */

/** The crypto surface we patch (structural subset). */
interface UuidCrypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T
  randomUUID?: () => string
}

/** Format 16 random bytes as a UUID v4 string. */
function uuidV4FromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Install the polyfill when the platform lacks crypto.randomUUID. */
export function installRandomUUIDPolyfill(): void {
  const cryptoObj = (globalThis as { crypto?: UuidCrypto }).crypto
  if (cryptoObj === undefined || typeof cryptoObj.randomUUID === 'function') return
  try {
    const buffer = new Uint8Array(16)
    Object.defineProperty(cryptoObj, 'randomUUID', {
      configurable: true,
      value: (): string => {
        cryptoObj.getRandomValues(buffer)
        return uuidV4FromBytes(buffer)
      },
    })
  } catch {
    // Non-fatal: without a UUID source some RPC paths keep failing, but the
    // rest of the plugin still works.
  }
}
