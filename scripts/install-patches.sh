#!/usr/bin/env bash
# install-patches.sh — apply the optional compatibility patch this plugin
# ships with, so a LAN-served DSH GUI works from other machines.
#
# The plugin itself needs NO harness modification: LAN access, the remote
# Settings pages (Models/Plugins provider directory, credentials), and the
# workspace are all served through the plugin's own fenced routes and a
# runtime connection patch. This script only fixes dsh-better-sidebar's
# pre-existing trust-fence bug (a profile-level pnpm patch, not a harness
# change).
#
# Usage:
#   ./scripts/install-patches.sh [profile]
#
#   profile   DSH profile name (default: web)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE="${1:-web}"

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

echo "==> Done. Restart 'dsh web' (or your usual GUI command) to load the changes."
