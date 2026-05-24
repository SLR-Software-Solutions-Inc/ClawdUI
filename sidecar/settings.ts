// Persisted settings reader. Mirrors Claude Code's settings.json layout so
// both interactive sessions and headless one-shot mode can read the same
// user/project configuration sources:
//   - ~/.claude/settings.json
//   - <cwd>/.claude/settings.json
//   - <cwd>/.claude/settings.local.json   (project-local overrides)
//
// Project-scope values shadow user-scope (last-write-wins). Headless mode
// uses these to honor `mcpServers`, `permissionMode`, `systemPrompt`, and
// shell `hooks` that the interactive sidecar otherwise builds at runtime.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SettingsHook = { type?: string; command: string; timeout?: number };
export type SettingsHookMatcher = { matcher?: string; hooks: SettingsHook[] };
export type SettingsHooks = Record<string, SettingsHookMatcher[]>;

export type PersistedSettings = {
  hooks: SettingsHooks;
  mcpServers: Record<string, unknown> | undefined;
  permissionMode: string | undefined;
  systemPrompt: unknown;
  allowedTools: string[] | undefined;
  disallowedTools: string[] | undefined;
  raw: Record<string, unknown>;
};

export function readJsonSafe(p: string): unknown {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function extractSettingsHooks(parsed: unknown): SettingsHooks {
  const out: SettingsHooks = {};
  if (!parsed || typeof parsed !== "object") return out;
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== "object") return out;
  for (const [event, val] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(val)) continue;
    const matchers: SettingsHookMatcher[] = [];
    for (const entry of val) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { matcher?: unknown; hooks?: unknown };
      const inner: SettingsHook[] = [];
      if (Array.isArray(e.hooks)) {
        for (const h of e.hooks) {
          if (!h || typeof h !== "object") continue;
          const cmd = (h as { command?: unknown }).command;
          if (typeof cmd === "string" && cmd.trim()) {
            inner.push({
              type: (h as { type?: string }).type,
              command: cmd,
              timeout: (h as { timeout?: number }).timeout,
            });
          }
        }
      }
      if (inner.length > 0) {
        matchers.push({
          matcher: typeof e.matcher === "string" ? e.matcher : undefined,
          hooks: inner,
        });
      }
    }
    if (matchers.length > 0) out[event] = matchers;
  }
  return out;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string" && x.trim()) out.push(x.trim());
  }
  return out.length ? out : undefined;
}

/** Merge settings sources for a cwd. Project scope wins. */
export function loadPersistedSettings(cwd: string): PersistedSettings {
  const sources = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];

  const mergedHooks: SettingsHooks = {};
  const raw: Record<string, unknown> = {};
  let mcpServers: Record<string, unknown> | undefined;
  let permissionMode: string | undefined;
  let systemPrompt: unknown;
  let allowedTools: string[] | undefined;
  let disallowedTools: string[] | undefined;

  for (const src of sources) {
    const parsed = readJsonSafe(src);
    if (!parsed || typeof parsed !== "object") continue;
    const p = parsed as Record<string, unknown>;
    Object.assign(raw, p);

    const h = extractSettingsHooks(parsed);
    for (const [event, matchers] of Object.entries(h)) {
      const existing = mergedHooks[event] ?? [];
      mergedHooks[event] = [...existing, ...matchers];
    }

    if (p.mcpServers && typeof p.mcpServers === "object") {
      mcpServers = { ...(mcpServers ?? {}), ...(p.mcpServers as Record<string, unknown>) };
    }
    if (typeof p.permissionMode === "string" && p.permissionMode.trim()) {
      permissionMode = p.permissionMode.trim();
    }
    if (p.systemPrompt !== undefined) {
      systemPrompt = p.systemPrompt;
    }
    const at = asStringArray(p.allowedTools);
    if (at) allowedTools = at;
    const dt = asStringArray(p.disallowedTools);
    if (dt) disallowedTools = dt;
  }

  return {
    hooks: mergedHooks,
    mcpServers,
    permissionMode,
    systemPrompt,
    allowedTools,
    disallowedTools,
    raw,
  };
}
