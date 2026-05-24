/**
 * Hook model for ClawdUI's visual editor.
 *
 * Canonical shape (matches Claude Code / Claude Agent SDK):
 *
 *   hooks: {
 *     PreToolUse?:        HookEntry[],
 *     PostToolUse?:       HookEntry[],
 *     UserPromptSubmit?:  HookEntry[],
 *     Stop?:              HookEntry[],
 *     SubagentStop?:      HookEntry[],
 *     SessionStart?:      HookEntry[],
 *     SessionEnd?:        HookEntry[],
 *     Notification?:      HookEntry[],
 *     PreCompact?:        HookEntry[],
 *   }
 *
 *   HookEntry = {
 *     matcher?: string,    // tool-name regex for Pre/PostToolUse, "*" or omitted otherwise
 *     hooks: HookCommand[],
 *   }
 *
 *   HookCommand = {
 *     type: "command",
 *     command: string,
 *     timeout?: number,         // seconds
 *     run_in_background?: boolean,
 *   }
 */

import { writable, get, derived, type Readable } from "svelte/store";
import { settings, patchSettings } from "./settings";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PreCompact",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Events where the matcher meaningfully filters by tool name. */
export const TOOL_MATCHER_EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse"];

export type HookCommand = {
  type: "command";
  command: string;
  timeout?: number;
  run_in_background?: boolean;
};

export type HookEntry = {
  matcher?: string;
  hooks: HookCommand[];
};

export type HookMap = Partial<Record<HookEvent, HookEntry[]>>;

export type ParseResult =
  | { ok: true; map: HookMap }
  | { ok: false; error: string };

const KNOWN_EVENTS = new Set<string>(HOOK_EVENTS as readonly string[]);

/** Parse a JSON string into a structured HookMap. Permissive but typed. */
export function parseHooksJson(raw: string | undefined | null): ParseResult {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, map: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid JSON" };
  }
  if (value == null) return { ok: true, map: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "hooks must be an object keyed by event name" };
  }

  const map: HookMap = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!KNOWN_EVENTS.has(k)) {
      return { ok: false, error: `unknown hook event: ${k}` };
    }
    if (!Array.isArray(v)) {
      return { ok: false, error: `${k} must be an array` };
    }
    const entries: HookEntry[] = [];
    for (const entry of v) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, error: `${k}[]: each item must be an object` };
      }
      const e = entry as Record<string, unknown>;
      const matcher = e.matcher;
      if (matcher !== undefined && typeof matcher !== "string") {
        // SDK also allows objects, but our editor produces strings; preserve via JSON.stringify.
        // Be tolerant: accept anything non-string by stringifying.
      }
      const hooksRaw = e.hooks;
      if (!Array.isArray(hooksRaw)) {
        return { ok: false, error: `${k}[].hooks must be an array` };
      }
      const cmds: HookCommand[] = [];
      for (const c of hooksRaw) {
        if (!c || typeof c !== "object" || Array.isArray(c)) {
          return { ok: false, error: `${k}[].hooks[]: each command must be an object` };
        }
        const co = c as Record<string, unknown>;
        const type = co.type;
        if (type !== "command") {
          return { ok: false, error: `${k}[].hooks[].type must be "command"` };
        }
        const cmdStr = typeof co.command === "string" ? co.command : "";
        const timeoutVal =
          typeof co.timeout === "number" && Number.isFinite(co.timeout)
            ? co.timeout
            : undefined;
        const runBg =
          typeof co.run_in_background === "boolean"
            ? co.run_in_background
            : undefined;
        const cmd: HookCommand = { type: "command", command: cmdStr };
        if (timeoutVal !== undefined) cmd.timeout = timeoutVal;
        if (runBg !== undefined) cmd.run_in_background = runBg;
        cmds.push(cmd);
      }
      const out: HookEntry = { hooks: cmds };
      if (typeof matcher === "string") out.matcher = matcher;
      entries.push(out);
    }
    map[k as HookEvent] = entries;
  }
  return { ok: true, map };
}

/** Serialize a HookMap to a JSON string suitable for `Settings.hooksJson`. */
export function stringifyHooks(map: HookMap): string {
  // Drop empty event keys for a tidy output.
  const out: HookMap = {};
  for (const ev of HOOK_EVENTS) {
    const v = map[ev];
    if (v && v.length) out[ev] = v;
  }
  if (!Object.keys(out).length) return "{}";
  return JSON.stringify(out, null, 2);
}

/** Deep clone helper for safe mutation. */
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

/** Total number of HookEntry rows across all events. */
export function totalEntries(map: HookMap): number {
  let n = 0;
  for (const ev of HOOK_EVENTS) n += (map[ev]?.length ?? 0);
  return n;
}

/**
 * Reactive store derived from `settings.hooksJson`.
 *
 * Reading: always reflects the latest parse of `settings.hooksJson`.
 * Writing: use the `update*` helpers — they re-serialize and patch settings.
 *
 * If the underlying JSON is unparseable, the store emits `{ ok: false, error }`
 * so the UI can show a banner and offer "fix" / "edit raw".
 */
export const hooksModel: Readable<ParseResult> = derived(settings, ($s) =>
  parseHooksJson($s.hooksJson),
);

/** Get a fresh, mutable copy of the current map (or empty if invalid). */
export function snapshot(): HookMap {
  const r = parseHooksJson(get(settings).hooksJson);
  return r.ok ? clone(r.map) : {};
}

/** Persist a HookMap back to settings. */
export function commit(map: HookMap): void {
  patchSettings({ hooksJson: stringifyHooks(map) });
}

/* -------- mutation helpers (each returns the new map) -------- */

export function ensureEvent(map: HookMap, ev: HookEvent): HookMap {
  const m = clone(map);
  if (!m[ev]) m[ev] = [];
  return m;
}

export function addEntry(map: HookMap, ev: HookEvent, matcher = ""): HookMap {
  const m = ensureEvent(map, ev);
  const entry: HookEntry = { hooks: [{ type: "command", command: "" }] };
  if (TOOL_MATCHER_EVENTS.includes(ev) || matcher) entry.matcher = matcher;
  (m[ev] as HookEntry[]).push(entry);
  return m;
}

export function removeEntry(map: HookMap, ev: HookEvent, idx: number): HookMap {
  const m = clone(map);
  const arr = m[ev];
  if (!arr) return m;
  arr.splice(idx, 1);
  if (!arr.length) delete m[ev];
  return m;
}

export function updateMatcher(
  map: HookMap,
  ev: HookEvent,
  idx: number,
  matcher: string,
): HookMap {
  const m = clone(map);
  const e = m[ev]?.[idx];
  if (!e) return m;
  if (matcher === "") delete e.matcher;
  else e.matcher = matcher;
  return m;
}

export function addCommand(
  map: HookMap,
  ev: HookEvent,
  idx: number,
): HookMap {
  const m = clone(map);
  const e = m[ev]?.[idx];
  if (!e) return m;
  e.hooks.push({ type: "command", command: "" });
  return m;
}

export function removeCommand(
  map: HookMap,
  ev: HookEvent,
  idx: number,
  cmdIdx: number,
): HookMap {
  const m = clone(map);
  const e = m[ev]?.[idx];
  if (!e) return m;
  e.hooks.splice(cmdIdx, 1);
  return m;
}

export function updateCommand(
  map: HookMap,
  ev: HookEvent,
  idx: number,
  cmdIdx: number,
  patch: Partial<HookCommand>,
): HookMap {
  const m = clone(map);
  const e = m[ev]?.[idx];
  if (!e) return m;
  const cur = e.hooks[cmdIdx];
  if (!cur) return m;
  e.hooks[cmdIdx] = { ...cur, ...patch, type: "command" };
  // strip empty optionals so JSON stays clean
  const next = e.hooks[cmdIdx];
  if (next.timeout === undefined || (typeof next.timeout === "number" && Number.isNaN(next.timeout))) {
    delete next.timeout;
  }
  if (next.run_in_background === false || next.run_in_background === undefined) {
    delete next.run_in_background;
  }
  return m;
}

/** Convenience: a writable mirror for editors that want bind:value. */
export function makeDraft(): {
  draft: ReturnType<typeof writable<HookMap>>;
  pull: () => void;
  push: () => void;
} {
  const draft = writable<HookMap>(snapshot());
  return {
    draft,
    pull: () => draft.set(snapshot()),
    push: () => commit(get(draft)),
  };
}
