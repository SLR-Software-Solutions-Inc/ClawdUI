// macOS GUI apps launched from Finder/Dock/Spotlight inherit launchd's
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) — they do NOT source the
// user's shell rc files. That means tools the user installed via homebrew,
// npm-global, volta, asdf, fnm, .local/bin, .claude/local, etc. are
// invisible to ANY child process the sidecar spawns: `claude`, `git`, MCP
// servers, shell hooks — all of them get "command not found" even when
// the same command works fine in Terminal.
//
// Fix: at sidecar startup, exec the user's login shell with `-ilc` so it
// sources .zprofile/.zshrc / .bash_profile / .bashrc, then capture its
// PATH and overlay onto process.env.PATH. Every child process forked
// after that point inherits the real PATH.
//
// Constraints:
//   - One-shot at startup. Don't respawn a shell per call (slow).
//   - 5s timeout. If the shell hangs or rc files are broken, don't block
//     sidecar boot — fall back to the existing (minimal) PATH.
//   - Best-effort. A failure here is recoverable because resolveBinary.ts
//     also probes a hard-coded candidate list.

import { spawn } from "node:child_process";

let inheritPromise: Promise<void> | null = null;

function probeShellPath(timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    let out = "";
    let settled = false;
    const child = spawn(shell, ["-ilc", "echo $PATH"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve(null);
    }, timeoutMs);
    if (typeof t.unref === "function") t.unref();
    child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(null);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (code !== 0) return resolve(null);
      // Take the LAST non-empty line — interactive rc files (oh-my-zsh,
      // p10k, motd) often print banners before our `echo $PATH` runs.
      const line = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      resolve(line || null);
    });
  });
}

/**
 * Idempotent. Safe to call from both sidecar/index.ts and headless.ts
 * startup — only the first invocation actually spawns a shell; subsequent
 * calls await the same promise.
 */
export function inheritUserPath(): Promise<void> {
  if (inheritPromise) return inheritPromise;
  inheritPromise = (async () => {
    // Skip on Windows — login-shell PATH inheritance is a POSIX-only quirk.
    if (process.platform === "win32") return;
    const probed = await probeShellPath();
    if (!probed) return;
    const current = process.env.PATH || "";
    // Union: shell PATH first (user intent), then anything already in
    // process.env.PATH that wasn't there (preserve launchd minimal dirs
    // so /usr/bin etc. stay reachable even if the user's shell PATH
    // omits them).
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const dir of probed.split(":").concat(current.split(":"))) {
      const d = dir.trim();
      if (!d || seen.has(d)) continue;
      seen.add(d);
      merged.push(d);
    }
    process.env.PATH = merged.join(":");
  })();
  return inheritPromise;
}
