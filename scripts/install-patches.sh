#!/usr/bin/env bash
# install-patches.sh — apply the optional compatibility patches this plugin
# ships with, so a LAN-served DSH GUI works from other machines.
#
# Usage:
#   ./scripts/install-patches.sh [profile] [harness-checkout]
#
#   profile          DSH profile name (default: web)
#   harness-checkout Optional absolute path of a deepseek-harness dev checkout.
#                    When given, the OPTIONAL harness patches are applied
#                    there and the patched packages are rebuilt. Without
#                    them, the remote Settings/workspace pages cannot work.
#
# What it does:
#   1. dsh-better-sidebar LAN-fence patch (only if better-sidebar is installed
#      in the profile): fixes the sidebar's trust fence so its explorer /
#      editor / terminal panels accept trusted LAN hosts.
#   2. [optional] harness patches: the /api privileged-method relaxation
#      (trustedHostPrivileged) and the LAN-served-origin classification that
#      lets remote browsers use the Settings pages, then rebuilds.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE="${1:-web}"
HARNESS="${2:-}"

HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "error: profile directory not found: $PROFILE_DIR" >&2
  exit 1
fi

# ── Tier 2: dsh-better-sidebar fence fix ─────────────────────────────────
if [ ! -d "$PROFILE_DIR/node_modules/dsh-better-sidebar" ]; then
  echo "==> dsh-better-sidebar is not installed in profile '$PROFILE' — skipping its patch"
else
  echo "==> Installing the dsh-better-sidebar LAN-fence patch into profile '$PROFILE'"
  mkdir -p "$PROFILE_DIR/patches"
  cp "$REPO_DIR/patches/dsh-better-sidebar.patch" "$PROFILE_DIR/patches/"
  python3 - "$PROFILE_DIR/pnpm-workspace.yaml" <<'PYEOF'
import sys
path = sys.argv[1]
entry = '  dsh-better-sidebar: patches/dsh-better-sidebar.patch'
with open(path) as f:
    text = f.read()
if entry in text:
    sys.exit(0)
if 'patchedDependencies:' not in text:
    if text and not text.endswith('\n'):
        text += '\n'
    text += 'patchedDependencies:\n' + entry + '\n'
else:
    lines = text.splitlines(keepends=True)
    out = []
    inserted = False
    for line in lines:
        out.append(line)
        if not inserted and line.rstrip('\n') == 'patchedDependencies:':
            out.append(entry + '\n')
            inserted = True
    text = ''.join(out)
with open(path, 'w') as f:
    f.write(text)
print('    registered in pnpm-workspace.yaml')
PYEOF
  echo "==> Applying the patch (pnpm install)"
  (cd "$PROFILE_DIR" && pnpm install)
fi

# ── Tier 3 (optional): harness patches (LAN-served GUI) ───────────────────
if [ -n "$HARNESS" ]; then
  if [ ! -d "$HARNESS/packages/client/connection" ]; then
    echo "error: harness checkout not found: $HARNESS" >&2
    exit 1
  fi
  for PATCH_NAME in "$REPO_DIR"/patches/harness-*.patch; do
    BASE="$(basename "$PATCH_NAME")"
    echo "==> Applying $BASE to $HARNESS"
    cp "$PATCH_NAME" "$HARNESS/$BASE"
    (cd "$HARNESS" && git apply --check "$BASE" && git apply "$BASE")
    rm -f "$HARNESS/$BASE"
  done
  echo "==> Rebuilding the patched packages (this runs the harness's own client build pass)"
  (cd "$HARNESS" && pnpm run build:lib:client)
  cat <<'EOF'

==> Add this connection-row override to $PROFILE_DIR/cordis.patch.yml
    (restating trustedHosts is required; drop trustedHostPrivileged to keep
    the loopback-only pin). The list below relaxes the whole configuration
    plane so the remote Settings pages (Models, Plugins) and workspace host
    actions work from LAN browsers; requests still must pass the
    trusted-host fence:

    - id: connection
      config:
        trustedHosts: !!js ctx.webRuntime.trustedHosts
        trustedHostPrivileged:
          - settings.describe
          - settings.openDocument
          - settings.update
          - settings.replace
          - settings.mutate
          - credentials.describe
          - credentials.set
          - credentials.unset
          - llm.discoverModels
          - host.pickDirectory
          - host.openPath
EOF
fi

echo "==> Done. Restart 'dsh web' (or your usual GUI command) to load the changes."
