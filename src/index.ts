/**
 * dsh-lan-access host half: owns the web GUI's bind host.
 *
 * The webserver row binds loopback by default. This plugin owns a persisted
 * `lan-access` settings namespace (`enabled: true` = bind all interfaces)
 * and converges the running webserver to it:
 *
 * - at boot, after both the settings seam and the webserver exist, the
 *   persisted value is applied once (a mismatch restarts the webserver row);
 * - every settings commit re-applies it, so the General-settings toggle takes
 *   effect immediately;
 * - a fenced /lan-access JSON route (GET state, POST set) lets the browser
 *   settings row read and flip the switch. The fence accepts loopback or the
 *   deployment's trusted authorities, read live from the connection row so
 *   LAN clients are admitted exactly when the /api gateway admits them.
 *
 * Rebinding restarts the webserver fiber, which cascades to every dependent
 * row (web-runtime, connection, api gateway…): web-runtime re-samples the
 * LAN trust snapshot and the connection row re-reads it, so the /api fence
 * admits the LAN authorities after an enable and drops them after a disable.
 *
 * The webserver is read lazily (`ctx.get`) and never injected, so this
 * plugin's own fiber survives the webserver restart it triggers.
 */
import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

/** Bind host values the webserver schema accepts. */
export type LanAccessHost = '127.0.0.1' | '0.0.0.0'

/** The persisted section: whether the GUI listens on all interfaces. */
export interface LanAccessSettings {
  enabled: boolean
}

/** Settings namespace owned by this plugin. */
export const LAN_ACCESS_NAMESPACE = 'lan-access'

/** Durable section schema (defaults to loopback — the safe state). */
export const LanAccessSchema: z<LanAccessSettings> = z.object({
  enabled: z.boolean().default(false),
})

/** One webserver service slice this plugin reads. */
export interface LanAccessWebServer {
  readonly host: LanAccessHost
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** One API request object passed to ctx.apiProxy domain methods. */
interface LanAccessApiRequest {
  rpcId: string
  payload: unknown
}

/** One API result slot returned by ctx.apiProxy domain methods. */
type LanAccessApiResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** One narrow response returned by ctx.apiProxy domain methods. */
interface LanAccessApiResponse {
  rpcId: string
  result: LanAccessApiResult
}

type LanAccessApiMethod = (
  request: LanAccessApiRequest,
  signal?: AbortSignal,
) => Promise<LanAccessApiResponse>

/** The apiProxy service face used by the exact privileged /api routes. */
interface LanAccessApiProxy {
  agentPresets: Record<'read' | 'copy' | 'openDocument' | 'remove', LanAccessApiMethod>
  host: Record<'pickDirectory' | 'openPath', LanAccessApiMethod>
  settings: Record<'describe' | 'openDocument' | 'update' | 'replace' | 'mutate', LanAccessApiMethod>
  credentials: Record<'describe' | 'set' | 'unset', LanAccessApiMethod>
  llm: Record<'discoverModels', LanAccessApiMethod>
}

/** One loader entry slice this plugin reads (the connection row's config). */
export interface LanAccessLoaderEntry {
  /** Fully-qualified entry id (group-prefixed; the address for loader.update). */
  id: string
  options: { name: string; config?: unknown }
  /** The entry's live fiber; its config is the post-interpolation resolved value. */
  fiber?: { config?: unknown }
}

/** The loader service face (structural subset of the cordis-plugin-loader tree). */
export interface LanAccessLoader {
  entries(): Iterable<LanAccessLoaderEntry>
  update(id: string, options: { config?: unknown }): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    loader: LanAccessLoader
    webServer: LanAccessWebServer
    apiProxy: LanAccessApiProxy
    /** The live bind-host source the webserver row's `host` expression reads. */
    lanAccess: LanAccessBindService
  }
}

/**
 * The bind-host source service: the webserver row's composed config carries
 * `host: !!js ctx.get('lanAccess')?.host ?? '127.0.0.1'`, so EVERY webserver
 * fiber (re)start — the initial boot, a toggle-triggered restart, and the
 * post-boot user-patch re-apply alike — evaluates the CURRENT persisted
 * setting instead of a literal that a later patch layer can clobber.
 */
export interface LanAccessBindService {
  /** The host the webserver should bind, from the persisted setting. */
  readonly host: LanAccessHost
}

/** Stable Cordis plugin name (the loader row mounts this package). */
export const name = 'dsh-lan-access'

/** Services required before mounting: settings for the persisted flag and loader for row updates. */
export const inject = ['loader', 'settings']

/** The webserver row's plugin name (matched by name — its entry id is group-prefixed). */
const WEBSERVER_PLUGIN = '@deepseek-ai/dsh-host-webserver'

/** The connection row whose resolved `trustedHosts` the /api fence uses. */
const CONNECTION_ROW = '@deepseek-ai/dsh-client-connection'

/** Request-body size bound of the POST write (defense against unbounded reads). */
const MAX_BODY_BYTES = 64 * 1024

/** Request-body size bound for exact /api privileged-route proxying. */
const MAX_API_BODY_BYTES = 160 * 1024 * 1024

/** Methods whose npm connection gateway pins to loopback on older dsh builds. */
const PRIVILEGED_API_METHODS = [
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
] as const

type PrivilegedApiMethod = typeof PRIVILEGED_API_METHODS[number]

const PRIVILEGED_API_DISPATCH: Record<
  PrivilegedApiMethod,
  (api: LanAccessApiProxy, request: LanAccessApiRequest, signal: AbortSignal) => Promise<LanAccessApiResponse>
> = {
  'agentPreset.read': (api, request, signal) => api.agentPresets.read(request, signal),
  'agentPreset.copy': (api, request, signal) => api.agentPresets.copy(request, signal),
  'agentPreset.openDocument': (api, request, signal) => api.agentPresets.openDocument(request, signal),
  'agentPreset.remove': (api, request, signal) => api.agentPresets.remove(request, signal),
  'host.pickDirectory': (api, request, signal) => api.host.pickDirectory(request, signal),
  'host.openPath': (api, request, signal) => api.host.openPath(request, signal),
  'settings.describe': (api, request, signal) => api.settings.describe(request, signal),
  'settings.openDocument': (api, request, signal) => api.settings.openDocument(request, signal),
  'settings.update': (api, request, signal) => api.settings.update(request, signal),
  'settings.replace': (api, request, signal) => api.settings.replace(request, signal),
  'settings.mutate': (api, request, signal) => api.settings.mutate(request, signal),
  'credentials.describe': (api, request, signal) => api.credentials.describe(request, signal),
  'credentials.set': (api, request, signal) => api.credentials.set(request, signal),
  'credentials.unset': (api, request, signal) => api.credentials.unset(request, signal),
  'llm.discoverModels': (api, request, signal) => api.llm.discoverModels(request, signal),
}

const PRIVILEGED_API_METHOD_SET = new Set<string>(PRIVILEGED_API_METHODS)
const INVALID_API_RPC_ID = 'invalid-request'

interface LanAccessClientApiRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

interface LanAccessServerApiResponse {
  type: 'server-response'
  rpcId: string
  result: LanAccessApiResult
}

/** An HTTP failure with a wire code and status. */
class LanAccessHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Interface names that never carry the machine's routable LAN address. */
const VIRTUAL_INTERFACE = /^(docker|veth|br-|vmnet|utun|tun|tap|tailscale|wg|vbox|virbr|lo|bridge|ppp)/i

/** Interface names that typically carry the primary LAN address (physical NICs). */
const PHYSICAL_INTERFACE = /^(en|eth|wlan|ens|enp|wl|awdl)/i

/** One candidate LAN address with its interface name. */
interface LanAddressCandidate {
  address: string
  name: string
  physical: boolean
}

/**
 * The machine's LAN IPv4 literals, primary first. Nothing is hard-coded: every
 * address is read live from the OS network interfaces of the machine running
 * the DSH server, virtual interfaces (docker/vpn/bridge/loopback) are
 * filtered out, and physical NICs (en0, eth0, wlan0, …) rank ahead of the
 * rest so the first entry is the address another machine on the LAN should
 * open.
 * The /api trust fence admits every returned literal, so any of them works.
 */
function lanAddresses(): string[] {
  const candidates: LanAddressCandidate[] = []
  for (const [name, ifaces] of Object.entries(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface === undefined || iface.family !== 'IPv4' || iface.internal) continue
      if (VIRTUAL_INTERFACE.test(name)) continue
      candidates.push({ address: iface.address, name, physical: PHYSICAL_INTERFACE.test(name) })
    }
  }
  const byAddress = new Map<string, LanAddressCandidate>()
  for (const candidate of candidates) {
    const existing = byAddress.get(candidate.address)
    if (existing === undefined || (candidate.physical && !existing.physical)) {
      byAddress.set(candidate.address, candidate)
    }
  }
  return [...byAddress.values()]
    .sort((left, right) => Number(right.physical) - Number(left.physical))
    .map(candidate => candidate.address)
}

/** Cached primary address (the default-route interface IPv4). */
let primaryCache: { address: string; at: number } | undefined
/** How long a resolved primary address stays fresh (routing rarely changes). */
const PRIMARY_TTL_MS = 30_000

/** The interface owning the default route, from the OS routing table. */
function defaultRouteInterfaceName(): Promise<string | undefined> {
  return new Promise((resolve) => {
    // macOS/BSD: `route -n get default` prints `interface: en0`.
    // Linux: `ip route show default` prints `... dev eth0 ...`.
    const [file, args] = process.platform === 'linux'
      ? ['ip', ['route', 'show', 'default']] as const
      : ['route', ['-n', 'get', 'default']] as const
    execFile(file, args, { timeout: 1500, windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      const text = String(stdout)
      const mac = /interface:\s*(\S+)/.exec(text)
      const linux = /\bdev\s+(\S+)/.exec(text)
      resolve(mac?.[1] ?? linux?.[1])
    })
  })
}

/**
 * The ONE address another machine should open: the IPv4 of the interface that
 * owns the default route (the NIC the LAN actually reaches the machine
 * through), falling back to the first physical-NIC candidate. The row shows
 * only this address; the /api fence still admits every LAN literal.
 */
async function primaryLanAddress(): Promise<string | undefined> {
  const now = Date.now()
  if (primaryCache !== undefined && now - primaryCache.at < PRIMARY_TTL_MS) {
    return primaryCache.address
  }
  const ifaceName = await defaultRouteInterfaceName()
  let address: string | undefined
  if (ifaceName !== undefined) {
    const iface = networkInterfaces()[ifaceName]?.find(candidate =>
      candidate !== undefined && candidate.family === 'IPv4' && !candidate.internal)
    address = iface?.address
  }
  address ??= lanAddresses()[0]
  primaryCache = { address, at: now }
  return address
}
/* ── browser-trust fence (behaviorally identical to the /api gateway's fence
   in @deepseek-ai/dsh-client-connection; helpers restated because the package
   does not export them and this plugin must not depend on its internals).
   Host-header loopback or a configured trusted authority passes; cross-site
   browser markers refuse. This is a DNS-rebinding / cross-site defense, not
   authentication. */

function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** Decide whether one request may reach the plugin route. */
function isTrustedApiRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/* ── /lan-access route ──────────────────────────────────────────────────── */

/** Wire state of the LAN-access feature. */
export interface LanAccessState {
  /** Whether the settings seam and webserver are both up (false while booting). */
  ready: boolean
  /** The persisted enabled flag. */
  enabled: boolean
  /** The current webserver bind host. */
  host: LanAccessHost | null
  /** The current webserver port. */
  port: number | null
  /** Whether a bind change is currently being applied. */
  pending: boolean
  /** LAN IPv4 literals served while bound to all interfaces. */
  addresses: string[]
  /** The LAN URL to open from other devices, when one is served. */
  url: string | null
}

/** Read the connection row's resolved trusted authorities, live. */
function trustedHostsOf(loader: LanAccessLoader): string[] {
  for (const entry of loader.entries()) {
    if (entry.options.name !== CONNECTION_ROW) continue
    // Prefer the fiber's RESOLVED config (the post-interpolation value the
    // /api fence itself reads): the composed row carries
    // `trustedHosts: !!js ctx.webRuntime.trustedHosts`, which only the
    // connection fiber may evaluate. The fiber re-resolves after a rebind
    // (web-runtime re-provisions the LAN snapshot), so the fence stays live.
    const fiberConfig = (entry as { fiber?: { config?: unknown } }).fiber?.config as
      { trustedHosts?: unknown } | undefined
    const raw = fiberConfig?.trustedHosts
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
    return []
  }
  return []
}

function objectConfig(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Read a bounded JSON request body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new LanAccessHttpError('payload-too-large', 'request body too large', 413)
    }
    chunks.push(buffer)
  }
  if (total === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new LanAccessHttpError('bad-request', 'request body is not valid JSON', 400)
  }
}

/** Write one JSON response (the socket may die mid-rebind; never throw). */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch {
    /* the request already dropped (webserver restart) — nothing to answer */
  }
}

/** Read a bounded raw request body for /api proxying. */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > maxBytes) {
      throw new LanAccessHttpError('payload-too-large', 'request body too large', 413)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function badApiResponse(
  rpcId: string,
  message: string,
  details: Record<string, unknown> = { issues: [] },
): LanAccessServerApiResponse {
  return {
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code: 'bad-request', message, details } },
  }
}

function fullApiResponse(response: LanAccessApiResponse): LanAccessServerApiResponse {
  return { type: 'server-response', rpcId: response.rpcId, result: response.result }
}

function apiMethodFromPath(pathname: string): PrivilegedApiMethod | undefined {
  if (!pathname.startsWith('/api/')) return undefined
  const method = pathname.slice('/api/'.length)
  return PRIVILEGED_API_METHOD_SET.has(method) ? method as PrivilegedApiMethod : undefined
}

function clientApiRequestOf(value: unknown): LanAccessClientApiRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== 'client-request' || typeof record.rpcId !== 'string' || typeof record.method !== 'string') {
    return undefined
  }
  return {
    type: 'client-request',
    rpcId: record.rpcId,
    method: record.method,
    payload: record.payload,
  }
}

async function proxyApiRequest(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  trustedHosts: readonly string[],
): Promise<void> {
  if (!isTrustedApiRequest(req, trustedHosts)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const method = apiMethodFromPath(new URL(req.url ?? '/', 'http://dsh.internal').pathname)
  if (method === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const mediaType = header(req.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }
  const apiProxy = ctx.get('apiProxy') as LanAccessApiProxy | undefined
  if (apiProxy === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  let body: unknown
  try {
    body = JSON.parse((await readRawBody(req, MAX_API_BODY_BYTES)).toString('utf8'))
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const message = clientApiRequestOf(body)
  if (message === undefined) {
    writeJson(res, 200, badApiResponse(INVALID_API_RPC_ID, 'invalid client-request message'))
    return
  }
  if (message.method !== method) {
    writeJson(res, 200, badApiResponse(message.rpcId, `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(method)}`))
    return
  }
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  writeJson(res, 200, fullApiResponse(await PRIVILEGED_API_DISPATCH[method](
    apiProxy,
    { rpcId: message.rpcId, payload: message.payload },
    abort.signal,
  )))
}

/* ── settings/credentials RPC proxy ───────────────────────────────────────
   The /api gateway pins the whole configuration plane (settings.*,
   credentials.*) to loopback even on trusted-host deployments. For a
   LAN-served GUI this plugin mirrors the settings + credentials domains on
   its own fenced route (/lan-access/rpc) so the remote Settings surfaces
   (Models provider directory, Plugins cards, Language/Appearance rows)
   work. The proxy reuses the same exposure boundary as the /api gateway:
   model-provider namespaces plus the web/product allowlist, redacted
   values, revision-fenced writes, and the same error codes. It is not a
   bypass — the route sits behind the identical browser-trust fence. */

/** Web-surface settings namespaces the /api proxy exposes (its allowlist mirror). */
const WEB_SETTINGS_NAMESPACES = [
  'agent-loop', 'shell', 'locale', 'permission', 'ui-conversation', 'ui-theme', 'web-search-deepseek',
] as const

/** Product-owned settings namespaces (the api-proxy's product allowlist mirror). */
const PRODUCT_SETTINGS_NAMESPACES = ['ui-onboarding', 'agent-presets'] as const

/** The llm service face used to enumerate configurable provider namespaces. */
interface LanAccessLlmService {
  listConfigurableProviders(): Array<{ settingsNs: string }>
}

/** The settings seam face (structural subset of SettingsProvider). */
interface LanAccessSettingsSeam {
  readonly writable: boolean
  readonly documentPath?: string
  describe(options?: { redactSecrets?: boolean }): unknown[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
  mutate(ns: string, ops: readonly unknown[], expectedRevision?: number): Promise<void>
  prepareDocument(): Promise<string | undefined>
}

/** Open one path with the OS default application (Finder/Explorer/xdg-open). */
function openWithSystem(path: string): void {
  if (process.platform === 'darwin') {
    execFile('open', [path], { timeout: 5000 }, () => {})
  } else if (process.platform === 'linux') {
    execFile('xdg-open', [path], { timeout: 5000 }, () => {})
  } else {
    execFile('cmd', ['/c', 'start', '', path], { timeout: 5000 }, () => {})
  }
}

/** The credentials seam face (structural subset of CredentialProvider). */
interface LanAccessCredentialsSeam {
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** One RPC result envelope (mirror of the /api RpcResult wire form). */
type LanAccessRpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** One RPC response envelope; rpcId echoes the request. */
interface LanAccessRpcResponse {
  rpcId: string
  result: LanAccessRpcResult
}

function rpcOk(rpcId: string, value: unknown): LanAccessRpcResponse {
  return { rpcId, result: { ok: true, value } }
}

function rpcErr(
  rpcId: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): LanAccessRpcResponse {
  return { rpcId, result: { ok: false, error: { code, message, details } } }
}

/** The settings namespaces this proxy serves — the api-proxy exposure mirror. */
function exposedSettingsNamespaces(ctx: Context): Set<string> {
  const exposed = new Set<string>(WEB_SETTINGS_NAMESPACES)
  for (const ns of PRODUCT_SETTINGS_NAMESPACES) exposed.add(ns)
  const llm = ctx.get('llm') as LanAccessLlmService | undefined
  for (const entry of llm?.listConfigurableProviders() ?? []) exposed.add(entry.settingsNs)
  return exposed
}

/** Map one redacted settings descriptor to its wire view (api-proxy namespaceView mirror). */
function namespaceViewOf(descriptor: {
  ns: unknown
  schema: unknown
  value: unknown
  base?: unknown
  user?: unknown
  applies: string
  revision: number
  secrets?: Array<{ path: readonly string[]; set: boolean }>
}): Record<string, unknown> {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined ? {} : { user: descriptor.user },
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map(secret => ({ path: [...secret.path], set: secret.set })),
    revision: descriptor.revision,
  }
}

/** settings.update/replace/mutate with the api-proxy exposure + error mapping. */
async function settingsWriteRpc(
  ctx: Context,
  rpcId: string,
  ns: string,
  mode: 'update' | 'replace' | 'mutate',
  section: unknown,
  expectedRevision?: number,
): Promise<LanAccessRpcResponse> {
  const settings = ctx.get('settings') as LanAccessSettingsSeam | undefined
  if (settings === undefined) return rpcErr(rpcId, 'internal', 'settings service is absent')
  if (!exposedSettingsNamespaces(ctx).has(ns)) {
    return rpcErr(rpcId, 'settings-not-exposed', `settings namespace "${ns}" is not exposed to configuration clients`)
  }
  let branded: ReturnType<typeof settingsNamespace>
  try {
    branded = settingsNamespace(ns)
  } catch (error: unknown) {
    return rpcErr(rpcId, 'settings-rejected', error instanceof Error ? error.message : String(error))
  }
  try {
    if (mode === 'update') await settings.update(branded, section as object, expectedRevision)
    else if (mode === 'replace') await settings.replace(branded, section as object, expectedRevision)
    else await settings.mutate(branded, section as readonly unknown[], expectedRevision)
  } catch (error: unknown) {
    if (error instanceof SettingsConflictError) {
      return rpcErr(rpcId, 'settings-conflict', error.message, {
        ns, expected: error.expected, actual: error.actual,
      })
    }
    return rpcErr(rpcId, 'settings-rejected', error instanceof Error ? error.message : String(error))
  }
  const descriptor = (settings.describe({ redactSecrets: true }) as Array<{ ns: unknown }>).find(candidate => String(candidate.ns) === ns)
  if (descriptor === undefined) {
    return rpcErr(rpcId, 'internal', `settings namespace "${ns}" was disposed after the ${mode}`)
  }
  return rpcOk(rpcId, namespaceViewOf(descriptor as Parameters<typeof namespaceViewOf>[0]))
}

/** Dispatch one proxied settings/credentials method (mirror of the /api domains). */
async function dispatchLanAccessRpc(ctx: Context, method: string, payload: unknown): Promise<LanAccessRpcResponse> {
  const record = (payload ?? {}) as Record<string, unknown>
  const rpcId = typeof record.rpcId === 'string' ? record.rpcId : 'lan-access'
  switch (method) {
    case 'settings.describe': {
      const settings = ctx.get('settings') as LanAccessSettingsSeam | undefined
      if (settings === undefined) return rpcErr(rpcId, 'internal', 'settings service is absent')
      const exposed = exposedSettingsNamespaces(ctx)
      return rpcOk(rpcId, {
        writable: settings.writable,
        hasDocument: settings.documentPath !== undefined,
        namespaces: (settings.describe({ redactSecrets: true }) as Parameters<typeof namespaceViewOf>[0][])
          .filter(descriptor => exposed.has(String(descriptor.ns)))
          .map(namespaceViewOf),
      })
    }
    case 'settings.update':
    case 'settings.replace':
    case 'settings.mutate': {
      const ns = record.ns
      if (typeof ns !== 'string') return rpcErr(rpcId, 'bad-request', 'expected a string "ns"')
      const expectedRevision = typeof record.expectedRevision === 'number' ? record.expectedRevision : undefined
      const section = method === 'settings.update' ? record.patch : method === 'settings.replace' ? record.section : record.ops
      return settingsWriteRpc(ctx, rpcId, ns, method.slice('settings.'.length) as 'update' | 'replace' | 'mutate', section, expectedRevision)
    }
    case 'settings.openDocument': {
      const settings = ctx.get('settings') as LanAccessSettingsSeam | undefined
      if (settings === undefined) return rpcErr(rpcId, 'internal', 'settings service is absent')
      let path: string | undefined
      try {
        path = await settings.prepareDocument()
      } catch (error: unknown) {
        return rpcErr(rpcId, 'internal', `settings document preparation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (path === undefined) return rpcErr(rpcId, 'internal', 'settings provider has no local document to open')
      openWithSystem(path)
      return rpcOk(rpcId, { opened: true })
    }
    case 'credentials.describe': {
      const credentials = ctx.get('credentials') as LanAccessCredentialsSeam | undefined
      if (credentials === undefined) return rpcErr(rpcId, 'internal', 'credentials service is absent')
      const refs = record.refs
      if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string')) {
        return rpcErr(rpcId, 'bad-request', 'expected an array of string refs')
      }
      const entries: Record<string, unknown> = {}
      for (const ref of refs as string[]) {
        try {
          const info = await credentials.describe(credentialRef(ref))
          entries[ref] = {
            configured: info.configured,
            ...info.source === undefined ? {} : { source: info.source },
            writable: info.writable,
          }
        } catch (error: unknown) {
          return rpcErr(rpcId, 'credential-rejected', error instanceof Error ? error.message : String(error), { ref })
        }
      }
      return rpcOk(rpcId, { credentials: entries })
    }
    case 'credentials.set':
    case 'credentials.unset': {
      const credentials = ctx.get('credentials') as LanAccessCredentialsSeam | undefined
      if (credentials === undefined) return rpcErr(rpcId, 'internal', 'credentials service is absent')
      const ref = record.ref
      if (typeof ref !== 'string') return rpcErr(rpcId, 'bad-request', 'expected a string "ref"')
      try {
        if (method === 'credentials.set') {
          const value = record.value
          if (typeof value !== 'string') return rpcErr(rpcId, 'bad-request', 'expected a string "value"')
          await credentials.set(credentialRef(ref), value)
        } else {
          await credentials.unset(credentialRef(ref))
        }
      } catch (error: unknown) {
        return rpcErr(rpcId, 'credential-rejected', error instanceof Error ? error.message : String(error), { ref })
      }
      return rpcOk(rpcId, {})
    }
    default:
      return rpcErr(rpcId, 'not-found', `unknown lan-access rpc method "${method}"`)
  }
}

/** The /lan-access/rpc route handler: fenced, POST-only, envelope-mirroring. */
async function handleRpc(
  ctx: Context,
  trustedHosts: readonly string[],
  req: IncomingMessage,
  res: ServerResponse,
  log?: (method: string, ok: boolean, code?: string, ns?: string, namespaces?: string[]) => void,
): Promise<void> {
  if (!isTrustedApiRequest(req, trustedHosts)) {
    writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'request origin is not trusted' } })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
    return
  }
  const body = await readJsonBody(req)
  const record = (body ?? {}) as Record<string, unknown>
  if (typeof record.method !== 'string' || typeof record.payload !== 'object' || record.payload === null) {
    writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'expected {"method", "payload"}' } })
    return
  }
  const rpcId = typeof record.rpcId === 'string' ? record.rpcId : 'lan-access'
  const response = await dispatchLanAccessRpc(ctx, record.method, { rpcId, ...(record.payload as object) })
  if (log !== undefined) {
    const ns = (record.payload as { ns?: unknown } | null)?.ns
    const namespaces = response.result.ok
      ? (response.result.value as { namespaces?: Array<{ ns: unknown }> } | null)?.namespaces?.map(view => String(view.ns))
      : undefined
    log(
      record.method,
      response.result.ok,
      response.result.ok ? undefined : response.result.error.code,
      typeof ns === 'string' ? ns : undefined,
      namespaces,
    )
  }
  writeJson(res, 200, response)
}


/**
 * Mount the LAN-access controller.
 * @param ctx - host context (loader injected).
 */
export function apply(ctx: Context): void {
  const loader = ctx.loader
  const ns = settingsNamespace(LAN_ACCESS_NAMESPACE)
  const scope = ctx.settings.register<LanAccessSettings>(ns, LanAccessSchema)
  // The live bind-host source for the webserver row's `host` expression
  // (`!!js ctx.get('lanAccess')?.host ?? '127.0.0.1'`, composed by this
  // plugin's bundle patch). The bundle also makes the webserver row inject this
  // service, so the first server start reads the persisted setting.
  ctx.provide('lanAccess', {
    get host(): LanAccessHost {
      return scope.get().enabled === true ? '0.0.0.0' : '127.0.0.1'
    },
  } satisfies LanAccessBindService)
  // Client boot diagnostics (the last few browser reports; debug aid).
  const diagReports: Array<{ at: number; data: unknown }> = []
  // RPC traffic log (the last 60 proxied calls; debug aid).
  const rpcTraffic: Array<{ at: number; method: string; ok: boolean; code?: string; ns?: string; namespaces?: string[] }> = []
  const logRpc = (method: string, ok: boolean, code?: string, ns?: string, namespaces?: string[]): void => {
    rpcTraffic.push({ at: Date.now(), method, ok, code, ns, namespaces })
    if (rpcTraffic.length > 60) rpcTraffic.shift()
  }
  // Serialized bind application: concurrent toggles queue; the chain stays
  // fulfilled so one failure cannot strand later writes.
  let applying: Promise<void> = Promise.resolve()
  let pendingCount = 0
  let queuedApply: { enabled: boolean; task: Promise<void> } | undefined

  const serverOf = (): LanAccessWebServer | undefined =>
    ctx.get('webServer') as LanAccessWebServer | undefined

  const warn = (phase: string, error: unknown): void => {
    ctx.logger.warn('[dsh-lan-access] %s: %s', phase, error instanceof Error ? error.message : String(error))
  }

  /** Find the webserver loader entry by plugin name (its id is group-prefixed). */
  const webserverEntry = (): LanAccessLoaderEntry | undefined => {
    for (const entry of loader.entries()) {
      if (entry.options.name === WEBSERVER_PLUGIN) return entry
    }
    return undefined
  }

  /** Find the connection loader entry by plugin name. */
  const connectionEntry = (): LanAccessLoaderEntry | undefined => {
    for (const entry of loader.entries()) {
      if (entry.options.name === CONNECTION_ROW) return entry
    }
    return undefined
  }

  /** Trust the live LAN literals on older connection builds whose webRuntime value stays stale. */
  const updateConnectionTrustedHosts = async (enabled: boolean): Promise<void> => {
    const entry = connectionEntry()
    if (entry === undefined) return
    const currentConfig = objectConfig(entry.options.config)
    const currentHosts = stringArray(currentConfig.trustedHosts)
    const addresses = lanAddresses()
    const nextHosts = enabled
      ? [...new Set([...currentHosts, ...addresses])]
      : currentHosts.filter(host => !addresses.includes(host))
    if (sameStrings(currentHosts, nextHosts)) return
    await loader.update(entry.id, { config: { ...currentConfig, trustedHosts: nextHosts } })
  }

  const routeTrustedHosts = (): string[] => {
    const configured = trustedHostsOf(loader)
    if (scope.get().enabled !== true && serverOf()?.host !== '0.0.0.0') return configured
    return [...new Set([...configured, ...lanAddresses()])]
  }

  /** Queue one bind convergence and keep the connection trust list in sync. */
  const enqueueApply = (enabled: boolean): Promise<void> => {
    if (queuedApply?.enabled === enabled) return queuedApply.task
    pendingCount += 1
    const queued = {
      enabled,
      task: applying.then(async () => {
        const server = serverOf()
        if (server === undefined) return
        const desiredHost: LanAccessHost = enabled ? '0.0.0.0' : '127.0.0.1'
        if (server.host !== desiredHost) {
          const entry = webserverEntry()
          if (entry === undefined) {
            throw new Error('webserver loader entry not found')
          }
          await loader.update(entry.id, { config: { host: desiredHost, port: server.port } })
        }
        await updateConnectionTrustedHosts(enabled)
      }),
    }
    queuedApply = queued
    applying = queued.task.catch(() => {})
    void queued.task.finally(() => {
      pendingCount -= 1
      if (queuedApply === queued) queuedApply = undefined
    }).catch(() => {})
    return queued.task
  }

  /** Converge the webserver bind to the persisted setting once both sides exist. */
  const align = (): void => {
    if (serverOf() === undefined) return
    void enqueueApply(scope.get().enabled).catch(error => warn('align', error))
  }

  const stateOf = async (): Promise<LanAccessState> => {
    const server = serverOf()
    const enabled = scope.get().enabled
    const addresses = enabled ? lanAddresses() : []
    const primary = enabled ? await primaryLanAddress() : undefined
    return {
      ready: server !== undefined,
      enabled,
      host: server?.host ?? null,
      port: server?.port ?? null,
      pending: pendingCount > 0,
      addresses,
      url: primary !== undefined && server !== undefined
        ? `http://${primary}:${server.port}`
        : null,
    }
  }

  // The durable section: follow every commit and align at boot. This plugin
  // fiber is independent of the webserver, so a rebind never tears it down.
  scope.watch((next) => {
    void enqueueApply(next.enabled).catch(error => warn('settings change', error))
  })
  align()

  // The fenced route + boot alignment. This child fiber reloads after a
  // rebind (the webserver service disappears and returns), re-registering
  // the route on the fresh server.
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: '/lan-access',
      handler: (req, res) => {
        void handle(req, res).catch((error: unknown) => {
          if (error instanceof LanAccessHttpError) {
            writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
            return
          }
          writeJson(res, 500, {
            ok: false,
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
          })
        })
      },
    }), 'dsh-lan-access: /lan-access route')

    // The settings/credentials RPC proxy (mirrors the loopback-pinned /api
    // configuration plane for LAN-served pages; same fence, same envelopes).
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: '/lan-access/rpc',
      handler: (req, res) => {
        void handleRpc(ctx, routeTrustedHosts(), req, res, (method, ok, code, ns, namespaces) => logRpc(method, ok, code, ns, namespaces)).catch((error: unknown) => {
          writeJson(res, 500, {
            ok: false,
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
          })
        })
      },
    }), 'dsh-lan-access: /lan-access/rpc route')

    for (const method of PRIVILEGED_API_METHODS) {
      httpCtx.effect(() => httpCtx.webServer.register({
        kind: 'exact',
        path: `/api/${method}`,
        handler: (req, res) => {
          void proxyApiRequest(ctx, req, res, routeTrustedHosts()).catch((error: unknown) => {
            if (error instanceof LanAccessHttpError) {
              writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
              return
            }
            writeJson(res, 500, {
              ok: false,
              error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
            })
          })
        },
      }), `dsh-lan-access: /api/${method} privileged route`)
    }

    // Client boot diagnostics: browsers POST their ledger state after boot;
    // GET reads the last reports (debug aid for LAN settings issues).
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: '/lan-access/diag',
      handler: (req, res) => {
        void (async () => {
          if (!isTrustedApiRequest(req, routeTrustedHosts())) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'request origin is not trusted' } })
            return
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            diagReports.push({ at: Date.now(), data: body })
            if (diagReports.length > 20) diagReports.shift()
            writeJson(res, 200, { ok: true })
            return
          }
          writeJson(res, 200, { ok: true, value: { reports: diagReports, traffic: rpcTraffic } })
        })().catch((error: unknown) => {
          writeJson(res, 500, {
            ok: false,
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
          })
        })
      },
    }), 'dsh-lan-access: /lan-access/diag route')
    align()
  })

  /** One /lan-access request: GET reads state, POST persists and applies. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (url.pathname !== '/lan-access') {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
      return
    }
    if (!isTrustedApiRequest(req, routeTrustedHosts())) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'request origin is not trusted' } })
      return
    }
    if (req.method === 'GET') {
      writeJson(res, 200, { ok: true, value: await stateOf() })
      return
    }
    if (req.method === 'POST') {
      const payload = await readJsonBody(req)
      if (payload === null || typeof payload !== 'object' || typeof (payload as { enabled?: unknown }).enabled !== 'boolean') {
        throw new LanAccessHttpError('bad-request', 'expected {"enabled": boolean}')
      }
      const enabled = (payload as { enabled: boolean }).enabled
      const settings = ctx.get('settings')
      if (settings === undefined) {
        throw new LanAccessHttpError('not-ready', 'LAN access settings are not ready yet', 503)
      }
      // Persist first (the commit fires the watch → enqueueApply), then make
      // sure the bind follows even if the watch raced this request.
      await settings.update(settingsNamespace(LAN_ACCESS_NAMESPACE), { enabled })
      await enqueueApply(enabled)
      writeJson(res, 200, { ok: true, value: await stateOf() })
      return
    }
    writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
  }
}
