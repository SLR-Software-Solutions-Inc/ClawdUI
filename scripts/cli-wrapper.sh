#!/usr/bin/env bash
# clawdui CLI wrapper. Locates the bundled Tauri binary on this machine and
# forwards all argv through to it so `clawdui -p "..."` triggers headless mode.
#
# Lookup order:
#   1. $CLAWDUI_BIN              (explicit override)
#   2. macOS .app under /Applications and ~/Applications
#   3. Local cargo target (debug then release) when invoked from a checkout
#   4. PATH (linux/windows portable install)
set -euo pipefail

find_bin() {
  if [[ -n "${CLAWDUI_BIN:-}" && -x "$CLAWDUI_BIN" ]]; then
    printf '%s\n' "$CLAWDUI_BIN"
    return 0
  fi

  local os
  os="$(uname -s 2>/dev/null || printf 'unknown')"

  if [[ "$os" == "Darwin" ]]; then
    local candidates=(
      "/Applications/ClawdUI.app/Contents/MacOS/clawdui"
      "/Applications/ClawdUI.app/Contents/MacOS/app"
      "$HOME/Applications/ClawdUI.app/Contents/MacOS/clawdui"
      "$HOME/Applications/ClawdUI.app/Contents/MacOS/app"
    )
    for c in "${candidates[@]}"; do
      [[ -x "$c" ]] && { printf '%s\n' "$c"; return 0; }
    done
  fi

  # Dev tree: walk up from the wrapper looking for src-tauri/target/*/app[.exe].
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  local repo="$(cd "$here/.." >/dev/null 2>&1 && pwd)"
  for build in debug release; do
    for name in app clawdui app.exe clawdui.exe; do
      local c="$repo/src-tauri/target/$build/$name"
      [[ -x "$c" ]] && { printf '%s\n' "$c"; return 0; }
    done
  done

  # Fall back to PATH lookup.
  if command -v clawdui >/dev/null 2>&1; then
    command -v clawdui
    return 0
  fi
  return 1
}

bin="$(find_bin)" || {
  printf 'clawdui: binary not found. Set CLAWDUI_BIN=/path/to/clawdui or install the app.\n' >&2
  exit 1
}

exec "$bin" "$@"
