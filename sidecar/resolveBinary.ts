// Shared `claude` binary resolution. Both interactive sessions
// (sidecar/index.ts start_session) and headless one-shot mode
// (sidecar/headless.ts) need to forward an absolute path to the local
// `claude` executable via `pathToClaudeCodeExecutable`. Without it, the
// agent SDK's dynamic-require resolution for its bundled Native CLI binary
// fails inside the Tauri bundle and surfaces as a misleading
// "Native CLI binary for <plat>-<arch> not found" string.
//
// Resolution order matches the interactive code path so behavior is
// identical:
//   1. `which claude` (or `where claude` on Windows) — uses process.env.PATH
//      which userShellEnv.inheritUserPath() may have already enriched from
//      the user's login shell.
//   2. Known install locations (.claude/local, .npm-global, .local/bin,
//      homebrew arm64+intel, /usr/local/bin, /usr/bin, volta, asdf shims)
//      — needed because macOS GUI apps inherit launchd's minimal PATH
//      (/usr/bin:/bin:/usr/sbin:/sbin) so `which` misses everything else.
// Returns the realpath-canonicalized absolute path, or `null` when no
// usable binary is found.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

let cachedClaudePath: string | null | undefined; // undefined = unresolved

function fileExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function searchedClaudePaths(): string[] {
  const home = os.homedir();
  return [
    // Claude Code's own bootstrap-installer location.
    path.join(home, ".claude", "local", "claude"),
    // npm global (npm prefix) + per-user bin.
    path.join(home, ".npm-global", "bin", "claude"),
    path.join(home, ".local", "bin", "claude"),
    // Homebrew (arm64 + intel).
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    // System.
    "/usr/bin/claude",
    // Node version managers.
    path.join(home, ".volta", "bin", "claude"),
    path.join(home, ".asdf", "shims", "claude"),
  ];
}

export async function resolveClaudeBinary(): Promise<string | null> {
  if (cachedClaudePath !== undefined) return cachedClaudePath;
  const which = await new Promise<string | null>((resolve) => {
    const p = spawn(process.platform === "win32" ? "where" : "which", ["claude"], {
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      if (code === 0) {
        const first = out.split(/\r?\n/).find((l) => l.trim());
        resolve(first ? first.trim() : null);
      } else {
        resolve(null);
      }
    });
  });
  const canonicalize = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  if (which && fileExecutable(which)) {
    const resolved = canonicalize(which);
    cachedClaudePath = resolved;
    return resolved;
  }
  for (const candidate of searchedClaudePaths()) {
    if (fileExecutable(candidate)) {
      const resolved = canonicalize(candidate);
      cachedClaudePath = resolved;
      return resolved;
    }
  }
  cachedClaudePath = null;
  return null;
}
