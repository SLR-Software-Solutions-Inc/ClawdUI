// Headless one-shot mode. ClawdUI can be invoked as `clawdui -p "..."` from
// scripts/CI; the Tauri main process then spawns the sidecar with
// CLAWDUI_HEADLESS=1 and forwards stdout. This module bypasses the
// JSON-over-stdin RPC loop entirely: it builds a Query, feeds the single
// prompt, streams events, then exits.
//
// Parity goal: headless must reach the same agent context as an interactive
// session (minus the UI). That means resolving the local `claude` binary,
// applying persisted settings (mcpServers, permissionMode, systemPrompt,
// shell hooks), and respecting precedence: CLI flag > env > settings > default.
//
// Env contract (set by src-tauri/src/lib.rs::run_headless / headless.rs):
//   CLAWDUI_HEADLESS        = "1"            (toggle)
//   CLAWDUI_PROMPT          = "<text>"       (required)
//   CLAWDUI_MODEL           = "<model id>"   (optional)
//   CLAWDUI_OUTPUT_FORMAT   = text|json|stream-json   (default: text)
//   CLAWDUI_MAX_TURNS       = "<n>"          (optional)
//   CLAWDUI_CWD             = "<path>"       (optional; defaults to process.cwd())
//   CLAWDUI_ALLOWED_TOOLS   = "a,b,c"        (optional; CLI overrides settings)
//   CLAWDUI_PERMISSION_MODE = default|acceptEdits|bypassPermissions|plan (optional)
//
// Exit codes: 0 ok, 1 runtime error, 2 invalid args (validated upstream in Rust).

import { spawn } from "node:child_process";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { getClaudeAccessToken } from "./oauth.js";
import { resolveClaudeBinary, searchedClaudePaths } from "./resolveBinary.js";
import { loadPersistedSettings, type SettingsHookMatcher } from "./settings.js";
import { inheritUserPath } from "./userShellEnv.js";

type AnyMsg = Record<string, unknown>;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object") {
        const blk = b as Record<string, unknown>;
        if (typeof blk.text === "string") parts.push(blk.text);
        else if (typeof blk.content === "string") parts.push(blk.content);
      }
    }
    return parts.join("");
  }
  return "";
}

/** Minimal headless hook runner — no UI emit, just exec + observe exit code.
 *  exit=2 blocks the tool call (Claude Code hook contract). Other non-zero
 *  exits are logged to stderr but don't block, matching interactive behavior. */
function makeHeadlessHookCallback(matchers: SettingsHookMatcher[], cwd: string) {
  return async (input: unknown) => {
    const toolName = (input as { tool_name?: string } | undefined)?.tool_name;
    const payload = JSON.stringify(input);
    for (const m of matchers) {
      if (m.matcher && m.matcher !== "*") {
        if (!toolName) continue;
        try {
          if (!new RegExp(m.matcher).test(toolName) && m.matcher !== toolName) continue;
        } catch {
          continue;
        }
      }
      for (const h of m.hooks) {
        const timeoutMs = Math.min(
          typeof h.timeout === "number" && h.timeout > 0 ? h.timeout * 1000 : 30_000,
          5 * 60 * 1000,
        );
        const res = await runShellHook(h.command, cwd, payload, timeoutMs);
        if (res.exitCode === 2) {
          // Hook blocked — propagate to SDK so the tool call aborts.
          return {
            continue: false,
            stopReason: (res.stderr || res.stdout || "blocked by user hook").trim(),
          };
        }
        if (res.exitCode !== 0) {
          process.stderr.write(
            `clawdui hook (exit ${res.exitCode}): ${h.command}\n${(res.stderr || res.stdout).slice(0, 2000)}\n`,
          );
        }
      }
    }
    return { continue: true };
  };
}

function runShellHook(
  command: string,
  cwd: string,
  inputJson: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(shell, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ exitCode: 124, stdout, stderr: stderr + `\ntimeout after ${timeoutMs}ms` });
    }, timeoutMs);
    if (typeof t.unref === "function") t.unref();
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ exitCode: 1, stdout, stderr: stderr + String((e as Error).message) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ exitCode: typeof code === "number" ? code : 1, stdout, stderr });
    });
    try {
      child.stdin.end(inputJson);
    } catch {
      /* ignore */
    }
  });
}

function buildHooksFromSettings(
  hooks: Record<string, SettingsHookMatcher[]>,
  cwd: string,
): AnyMsg {
  const out: AnyMsg = {};
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!matchers || matchers.length === 0) continue;
    (out as Record<string, unknown[]>)[event] = [
      { hooks: [makeHeadlessHookCallback(matchers, cwd)] },
    ];
  }
  return out;
}

export async function runHeadless(): Promise<number> {
  // Defense in depth: index.ts already awaits inheritUserPath at top-level
  // boot, but inheritUserPath is idempotent (memoized promise) so calling
  // again here is free and guarantees PATH is hydrated even if a future
  // entry point bypasses index.ts.
  await inheritUserPath();

  const prompt = process.env.CLAWDUI_PROMPT ?? "";
  if (!prompt.trim()) {
    process.stderr.write("clawdui: empty prompt\n");
    return 2;
  }
  const model = process.env.CLAWDUI_MODEL?.trim() || undefined;
  const format = (process.env.CLAWDUI_OUTPUT_FORMAT ?? "text").trim();
  const maxTurnsRaw = process.env.CLAWDUI_MAX_TURNS?.trim();
  const maxTurns = maxTurnsRaw ? Number(maxTurnsRaw) : undefined;
  const cwd = process.env.CLAWDUI_CWD?.trim() || process.cwd();
  const allowedEnv = process.env.CLAWDUI_ALLOWED_TOOLS?.trim();
  const allowedToolsCli = allowedEnv
    ? allowedEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const permissionModeEnv = process.env.CLAWDUI_PERMISSION_MODE?.trim() || undefined;

  // Resolve `claude` binary BEFORE Query construction — otherwise the SDK
  // tries to dynamically require its bundled platform-specific Native CLI
  // (cli-<plat>-<arch>) which fails inside the Tauri bundle and surfaces
  // as "Native CLI binary for darwin-arm64 not found". Mirrors the
  // interactive start_session code path.
  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    process.stderr.write(
      `clawdui: claude binary not found. Searched: which claude, ${searchedClaudePaths().join(", ")}.\n` +
        `Install Claude Code: npm install -g @anthropic-ai/claude-code\n`,
    );
    return 1;
  }

  // Load persisted settings (~/.claude + project .claude). Precedence
  // applied below: CLI flag > env > settings > default.
  const settings = loadPersistedSettings(cwd);

  const opts: Options = { cwd } as Options;
  (opts as AnyMsg).pathToClaudeCodeExecutable = claudeBin;

  if (model) (opts as AnyMsg).model = model;
  if (typeof maxTurns === "number" && Number.isFinite(maxTurns)) {
    (opts as AnyMsg).maxTurns = maxTurns;
  }

  // allowedTools — CLI flag wins, else settings, else SDK default.
  const allowedTools = allowedToolsCli ?? settings.allowedTools;
  if (allowedTools && allowedTools.length) (opts as AnyMsg).allowedTools = allowedTools;
  if (settings.disallowedTools && settings.disallowedTools.length) {
    (opts as AnyMsg).disallowedTools = settings.disallowedTools;
  }

  // permissionMode — env flag wins, else settings, else SDK default.
  const permissionMode = permissionModeEnv ?? settings.permissionMode;
  if (permissionMode) (opts as AnyMsg).permissionMode = permissionMode;

  // systemPrompt — settings only (no CLI flag yet).
  if (settings.systemPrompt !== undefined) {
    (opts as AnyMsg).systemPrompt = settings.systemPrompt;
  }

  // mcpServers — settings only.
  if (settings.mcpServers && Object.keys(settings.mcpServers).length) {
    (opts as AnyMsg).mcpServers = settings.mcpServers;
  }

  // hooks — wire settings.json shell hooks as SDK callbacks so they run on
  // PreToolUse/PostToolUse/etc just like in interactive mode.
  if (Object.keys(settings.hooks).length) {
    (opts as AnyMsg).hooks = buildHooksFromSettings(settings.hooks, cwd);
  }

  // OAuth: forward keychain token through env so the spawned `claude` CLI
  // skips its own keystore lookup (which fails when invoked from headless
  // ancestry without ACL grant). MUST spread process.env — SDK uses
  // options.env AS-IS, not as an overlay.
  try {
    const token = await getClaudeAccessToken();
    if (token) {
      (opts as { env?: Record<string, string> }).env = {
        ...(process.env as Record<string, string>),
        CLAUDE_CODE_OAUTH_TOKEN: token,
      };
    }
  } catch {
    // Non-fatal — SDK will surface its own auth error.
  }

  const out = process.stdout;
  const emitJson = (obj: unknown) => out.write(JSON.stringify(obj) + "\n");

  try {
    const q = query({ prompt, options: opts });
    let assembled = "";
    let lastText = "";
    for await (const msg of q) {
      const rec = msg as AnyMsg;
      if (format === "stream-json" || format === "json") {
        emitJson(msg);
      } else {
        const role =
          (rec.role as string | undefined) ??
          ((rec.message as AnyMsg | undefined)?.role as string | undefined);
        if (rec.type === "assistant" || role === "assistant") {
          const content =
            (rec.content as unknown) ?? (rec.message as AnyMsg | undefined)?.content;
          const text = extractText(content);
          if (text) {
            if (text.startsWith(lastText) && text.length > lastText.length) {
              out.write(text.slice(lastText.length));
            } else if (text !== lastText) {
              out.write(text);
            }
            lastText = text;
            assembled += text;
          }
        }
      }
    }
    if (format !== "stream-json" && format !== "json") {
      if (assembled && !assembled.endsWith("\n")) out.write("\n");
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`clawdui: ${msg}\n`);
    return 1;
  }
}
