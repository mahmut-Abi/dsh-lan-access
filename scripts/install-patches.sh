#!/usr/bin/env bash
# install-patches.sh — apply the optional compatibility patches this plugin
# ships with, so a LAN-served DSH GUI works from other machines.
#
# Usage:
#   ./scripts/install-patches.sh [profile] [harness-checkout]
#
#   profile          DSH profile name (default: web)
#   harness-checkout Optional absolute path of a deepseek-harness dev checkout.
#                    When given, the OPTIONAL trustedHostPrivileged source
#                    patch is applied there and the connection package is
#                    rebuilt (this tier is only needed for host.openPath /
#                    host.pickDirectory from LAN browsers).
#
# What it does:
#   1. dsh-better-sidebar LAN-fence patch (only if better-sidebar is installed
#      in the profile): fixes the sidebar's trust fence so its explorer /
#      editor / terminal panels accept trusted LAN hosts.
#   2. [optional] harness connection patch + rebuild, and prints the
#      connection-row config to add to the profile's cordis.patch.yml.
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

# ── Tier 3 (optional): harness trustedHostPrivileged ─────────────────────
if [ -n "$HARNESS" ]; then
  if [ ! -d "$HARNESS/packages/client/connection" ]; then
    echo "error: harness checkout not found: $HARNESS" >&2
    exit 1
  fi
  echo "==> Applying the harness connection patch to $HARNESS"
  PATCH_NAME="harness-connection-trustedHostPrivileged.patch"
  cp "$REPO_DIR/patches/$PATCH_NAME" "$HARNESS/"
  (cd "$HARNESS" && git apply --check "$PATCH_NAME" && git apply "$PATCH_NAME")
  rm -f "$HARNESS/$PATCH_NAME"
  echo "==> Rebuilding the connection package (this runs the harness's own client build pass)"
  (cd "$HARNESS" && pnpm run build:lib:client)
  cat <<'EOF'

==> Add this connection-row override to $PROFILE_DIR/cordis.patch.yml
    (restating trustedHosts is required; drop trustedHostPrivileged to keep
    the loopback-only pin):

    - id: connection
      config:
        trustedHosts: !!js ctx.webRuntime.trustedHosts
        trustedHostPrivileged:
          - host.pickDirectory
          - host.openPath
EOF
fi

echo "==> Done. Restart 'dsh web' (or your usual GUI command) to load the changes."
