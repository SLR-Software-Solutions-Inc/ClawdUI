#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) SLR Software Solutions Inc.
#
# dev-install.sh — bootstrap a local ClawdUI dev environment.
#
# What it does:
#   1. Verifies prerequisites (node, npm, rustup, claude CLI).
#   2. Installs frontend deps:           npm install
#   3. Installs sidecar deps:            (cd sidecar && npm install)
#   4. Prints next steps for `npm run tauri:dev`.
#
# This script is intentionally generic — it makes NO assumptions about Apple
# signing identities, internal secret paths, or CI environment. If you want
# the macOS "stable-signed dev install" flow that preserves TCC grants across
# rebuilds, see `fastlane mac build_dmg_notarized` (release build) or wire up
# your own signing identity via the APPLE_SIGNING_IDENTITY env var before
# running `npm run tauri:build`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

say() { printf "\033[1;36m>>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*" >&2; }
die() { printf "\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }

# -------- prerequisites --------
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js >= 18: https://nodejs.org/"
command -v npm  >/dev/null 2>&1 || die "npm not found (should ship with node)."
command -v cargo >/dev/null 2>&1 || warn "cargo not found. Install Rust via rustup: https://rustup.rs/"
command -v claude >/dev/null 2>&1 || warn "claude CLI not found on PATH. Install + auth: https://docs.claude.com/en/docs/claude-code"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  die "Node $NODE_MAJOR detected; ClawdUI requires Node >= 18."
fi

# -------- install --------
say "Installing frontend deps (npm install)…"
npm install

say "Installing sidecar deps (cd sidecar && npm install)…"
(cd sidecar && npm install)

# -------- next steps --------
cat <<'EOF'

ClawdUI dev environment is ready.

Next steps:
  npm run tauri:dev           # boot the app in dev mode (hot reload)
  npm run tauri:build         # produce a release bundle
  npm run sidecar:build       # rebuild just the Node sidecar

Notes:
  - First `tauri:dev` compiles ~350 Rust crates (3–7 min on cold machine).
    Incremental runs are seconds.
  - The sidecar is built automatically by `tauri:dev` / `tauri:build`.
  - For signed release builds, see fastlane/Fastfile and copy fastlane/.env.template
    to fastlane/.env with your signing credentials.
EOF
