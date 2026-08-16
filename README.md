# dsh-lan-access

A DeepSeek Harness web plugin that adds a **LAN access** toggle to the DSH
Settings shell (Settings → General). It replaces the manual `cordis.patch.yml`
webserver override:

- **On** — the web GUI binds `0.0.0.0`, so other machines on the same network
  can open it at `http://<LAN-IP>:3080`. The /api trust fence is updated live,
  so the browser on a LAN machine works fully (chat, tools, workspace).
- **Off** — the GUI binds `127.0.0.1` again (loopback only — the safe default).

## How it works

| Half | File | Role |
| --- | --- | --- |
| Host | `src/index.ts` | Registers the persisted `lan-access` settings namespace, the fenced `/lan-access` JSON route (GET state / POST set), the bind controller, and the `lanAccess` bind-host service. The webserver row's composed `host` expression reads that service, so every webserver (re)start — boot, toggle, or a post-boot user-patch re-apply — converges to the persisted setting; the controller only restarts the row when the bind actually differs. |
| Client | `src/client/` | Registers the General-settings row (`settings.general.item`, order 15) with a native checkbox switch, the LAN URLs (primary first, all live NIC addresses shown, copy button), zh/en copy, and restart-tolerant polling. |

The route fence accepts loopback or the deployment's trusted authorities, read
live from the connection row's resolved config — the same boundary the /api
gateway uses. Cross-site requests are refused.

## Install from GitHub

The built artifacts (`lib/`) are committed, so installation needs no build
step and no modification of the DeepSeek Harness checkout:

```sh
# From GitHub (replace <owner>/<repo>)
dsh plugin --profile web add git+https://github.com/<owner>/<repo>.git

# ...or clone and install the local checkout (link: keeps your rebuilds live)
git clone https://github.com/<owner>/<repo>.git
dsh plugin --profile web add link:/path/to/dsh-lan-access

# Restart the GUI
dsh web
```

The install appends `dsh-lan-access` to `dsh.profile.bundles`; its
`dsh.bundle.patch` inserts the host row and overrides the webserver row's
`host` with the `lanAccess` service expression. The client half is picked up
by the client-modules scanner automatically. **No harness change is required
for the core feature** — the toggle, the LAN bind, and the live /api trust
fence all ship inside the plugin.

> **Local development** — rebuild with `pnpm build` (or `npm run build`)
> after changing `src/`, then reinstall/restart. The repo's `node_modules`
> mirrors the DSH profile's package farm (TypeScript/tsdown come from the
> harness checkout).

> **Migrating from a manual patch** — remove any `webserver` `host: 0.0.0.0`
> override from the profile's `cordis.patch.yml` (and the bundle patch layers)
> so the plugin is the single owner of the bind host.

## Use

1. Open the GUI, go to **Settings** (sidebar footer) → **General**.
2. Flip **局域网访问 / LAN access**.
   - Enabling shows the ONE address other devices can open — the IPv4 of the
     interface that owns the default route (`http://192.168.x.x:3080`) —
     with a copy button.
   - The web server restarts to rebind; the row waits for it and re-reads the
     state (a network error mid-restart is not reported as failure).
   - The plugin also installs a `crypto.randomUUID` polyfill on plain-HTTP
     LAN origins (that Web API only exists in secure contexts, and the DSH
     API client mints every RPC id with it — without the polyfill a remote
     browser fails with "crypto.randomUUID is not a function").
3. The choice is persisted in `~/.dsh/settings.yaml`:

   ```yaml
   lan-access:
     enabled: true
   ```

## Optional compatibility patches (fully working GUI from LAN)

The plugin itself is self-contained, but a few *pre-existing* DSH ecosystem
gates also block LAN browsers and live outside the plugin's own code. The
repo ships the fixes as ready-made patches with one installer:

```sh
./scripts/install-patches.sh web                          # better-sidebar fence fix
./scripts/install-patches.sh web /path/to/deepseek-harness # + optional harness patches
```

| Tier | Patch | Fixes | When you need it |
| --- | --- | --- | --- |
| 2 | `patches/dsh-better-sidebar.patch` | dsh-better-sidebar's trust fence matched the connection row by the wrong name and read the raw `!!js` config, so its panels (explorer / editor / terminal / git) only ever accepted loopback. The pnpm patch matches `@deepseek-ai/dsh-client-connection` and reads the fiber's resolved `trustedHosts` per request. | You use [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) and want its panels from a LAN machine. |
| 3 | `patches/harness-connection-trustedHostPrivileged.patch` + `patches/harness-connection-lan-served-origin.patch` | (a) The /api gateway pins the whole configuration plane (`settings.*`, `credentials.*`, `llm.discoverModels`, `host.pickDirectory`, `host.openPath`) to loopback even on trusted-host deployments — the opt-in `trustedHostPrivileged` config relaxes exactly the methods you list. (b) The browser connection treats a page loaded from a non-loopback IP literal as a served authority, so the Settings surfaces (Models, Plugins, Language, Appearance, …) use host-backed persistence instead of silently degrading to empty. | You want the remote Settings pages and host actions to work from LAN browsers. Without them, the Models page errors with "HTTP 403" and the Plugins page stays empty. |

Tier 2 is applied to the profile itself (a pnpm patch, like any
`patchedDependencies`). Tier 3 modifies the DSH dev checkout: the installer
applies every `patches/harness-*.patch` with `git apply`, runs the
harness's own `pnpm run build:lib:client` build, and prints the
connection-row override to add to the profile's `cordis.patch.yml`
(restate `trustedHosts`; drop `trustedHostPrivileged` to restore the
loopback-only pin). Without the Tier-3 patches the extra config key is
ignored harmlessly. The harness patches are generated against the
`0.1.0-rc.5` checkout they were developed on; on a different DSH version,
`git apply` may fail and the small hunks are trivial to re-apply by hand.

## Security notes

- Default is **off** (loopback). The DSH launcher itself refuses
  `--host 0.0.0.0` for the same reason: binding all interfaces exposes the
  agent's tools to the network. Only enable it on a trusted network.
- The toggle is only reachable through the fenced route, and disabling from a
  remote machine cuts that machine off (expected — re-enable locally).
- The bind survives plugin reloads and patch re-applies; a full process
  restart re-applies the persisted value at boot.

## Development

```sh
pnpm build        # tsdown: lib/index.js (host) + lib/client.js (browser bundle)
pnpm typecheck    # tsc --noEmit
```

The client bundle is a `__ModuleLoader__.load` closure-factory artifact (same
format as the DSH monorepo's tsdown client preset); only the frozen
platform-module table words stay external. After changing client code, rebuild
and restart `dsh web` (the client-modules package metadata cache expires only
on restart).
