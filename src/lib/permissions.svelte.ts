// Svelte 5 $state-backed queue of pending permission requests forwarded
// from the sidecar's `canUseTool` callback. App.svelte feeds requests
// in; PermissionPrompt.svelte renders the head and resolves them via
// the existing send_to_sidecar RPC channel.
//
// Three persistence tiers are evaluated on every enqueue:
//   1. "Allow once"      – no caching, just a single response.
//   2. "Session"         – in-memory Set, lost on reload.
//   3. "Persist"         – Settings.permanentAllowList in localStorage,
//                          with exact / prefix / any / glob match types.

import { settings, patchSettings, getSettings } from "./settings";
import type { PermanentAllow, PermanentAllowMatchType } from "./types";

export type PermissionUpdate = unknown;

export type PermissionRequest = {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  tool_use_id?: string;
  session_id: string | null;
  title?: string;
  description?: string;
  blocked_path?: string;
  /** Wall-clock millis when received, used for sorting / display only. */
  received_at: number;
};

export type PermissionDecision =
  | {
      behavior: "allow";
      remember?: "session" | "persist";
      persistMatch?: PermanentAllowMatchType;
      persistPattern?: string;
      persistDescription?: string;
    }
  | { behavior: "deny"; message?: string };

export type PermissionResolution = {
  request_id: string;
  decision: PermissionDecision;
};

/** Stable JSON stringify (sorted keys) so memo keys are deterministic. */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return (v as unknown[]).map(walk);
    const o = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      sorted[k] = walk(o[k]);
    }
    return sorted;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return String(value);
  }
}

function memoKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}::${stableStringify(input)}`;
}

/**
 * Pull the most user-meaningful string field from a tool input. Used both
 * to compute prefix patterns and to drive prefix matching at runtime.
 *
 * Tool                  | field
 * ----------------------|----------------------------------
 * Read/Write/Edit       | input.file_path ?? input.path
 * Glob/Grep             | input.path ?? input.file_path
 * Bash                  | input.command  (first token used for prefix)
 * <other>               | first own string-typed field
 *
 * Returns null when no string is available – callers should disable
 * the PREFIX option in that case.
 */
export function findPrimaryStringField(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const t = toolName;
  const fileTools = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
  const searchTools = new Set(["Glob", "Grep"]);
  if (fileTools.has(t)) {
    const v = (input.file_path ?? input.path) as unknown;
    if (typeof v === "string" && v) return v;
  }
  if (searchTools.has(t)) {
    const v = (input.path ?? input.file_path) as unknown;
    if (typeof v === "string" && v) return v;
  }
  if (t === "Bash") {
    const v = input.command as unknown;
    if (typeof v === "string" && v) return v;
  }
  // Fallback: first own string-typed field, in declaration order.
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * Heuristic prefix suggestion. For a path like
 *   /Users/<you>/dev/foo/bar.txt
 * suggest the parent dir + trailing slash:
 *   /Users/<you>/dev/foo/
 * For Bash commands, suggest the first token (e.g. "git status -s" -> "git ").
 */
export function suggestPrefix(toolName: string, primary: string): string {
  if (toolName === "Bash") {
    const tok = primary.split(/\s+/)[0] ?? primary;
    return tok ? tok + " " : primary;
  }
  // path-like
  if (primary.startsWith("/") || primary.startsWith("~")) {
    const slash = primary.lastIndexOf("/");
    if (slash > 0) return primary.slice(0, slash + 1);
  }
  return primary;
}

/** Tiny inline glob: supports `*` (any segment) and `**` (any chars including /). */
export function globMatch(pattern: string, value: string): boolean {
  // Escape regex specials except * and ?, then translate * / ** / ?.
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (/[.+^${}()|\\\][]/.test(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
    i += 1;
  }
  try {
    return new RegExp("^" + re + "$").test(value);
  } catch {
    return false;
  }
}

/** Does a single permanent rule match the request? */
export function matchesPermanent(
  rule: PermanentAllow,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (rule.toolName !== toolName) return false;
  if (rule.matchType === "any") return true;
  if (rule.matchType === "exact") {
    return rule.pattern === stableStringify(input);
  }
  const primary = findPrimaryStringField(toolName, input);
  if (primary == null) return false;
  if (rule.matchType === "prefix") {
    return primary.startsWith(rule.pattern);
  }
  if (rule.matchType === "glob") {
    return globMatch(rule.pattern, primary);
  }
  return false;
}

/** First permanent rule that matches, or null. */
function firstPermanentMatch(
  toolName: string,
  input: Record<string, unknown>,
): PermanentAllow | null {
  const list = getSettings().permanentAllowList ?? [];
  for (const r of list) {
    if (matchesPermanent(r, toolName, input)) return r;
  }
  return null;
}

/** Build a default human-friendly description for a new rule. */
export function describeRule(rule: PermanentAllow): string {
  if (rule.description) return rule.description;
  if (rule.matchType === "any") return `${rule.toolName} (any input)`;
  if (rule.matchType === "exact") return `${rule.toolName} (this exact call)`;
  return `${rule.toolName} ${rule.matchType}: ${rule.pattern}`;
}

/** Append a permanent rule to settings (de-duped). */
export function addPermanentRule(rule: PermanentAllow): void {
  const cur = getSettings().permanentAllowList ?? [];
  // de-dup on (toolName, matchType, pattern)
  const dup = cur.some(
    (r) =>
      r.toolName === rule.toolName &&
      r.matchType === rule.matchType &&
      r.pattern === rule.pattern,
  );
  if (dup) return;
  patchSettings({ permanentAllowList: [...cur, rule] });
}

/** Remove a rule by index. */
export function removePermanentRuleAt(idx: number): void {
  const cur = getSettings().permanentAllowList ?? [];
  if (idx < 0 || idx >= cur.length) return;
  const next = [...cur.slice(0, idx), ...cur.slice(idx + 1)];
  patchSettings({ permanentAllowList: next });
}

/** Drop every persistent rule. */
export function clearPermanentRules(): void {
  patchSettings({ permanentAllowList: [] });
}

type Responder = (requestId: string, decision: PermissionDecision) => void;

class PermissionStore {
  // queue of unresolved requests, oldest-first
  queue = $state<PermissionRequest[]>([]);

  // App.svelte registers the sidecar responder at mount. InlinePermissionCard's
  // resolve() must invoke it, otherwise the sidecar's canUseTool callback waits
  // forever and the turn stalls. PermissionPrompt has its own dispatch path,
  // but the inline card has no event channel, so the responder hook is the only
  // way to bridge UI -> sidecar for inline decisions.
  private responder: Responder | null = null;
  setResponder(fn: Responder | null): void {
    this.responder = fn;
  }

  // map of tool_use_id -> deny reason. Lets MessageBlock annotate the
  // tool_use block that was blocked. Reactive so the UI updates.
  denied = $state<Record<string, string>>({});

  // toast hint set when a request is auto-allowed via a persistent rule, so
  // PermissionPrompt / App can surface a non-modal banner. Cleared on read.
  lastAutoAllowDescription = $state<string | null>(null);

  // session-only "always allow" memory (NOT persisted to localStorage)
  private sessionAllow = new Set<string>();

  /** Push a new request. Returns the auto-decision if memoized, else null. */
  enqueue(req: PermissionRequest): PermissionDecision | null {
    // Tier 2 — session cache (exact match by hash).
    const key = memoKey(req.tool_name, req.input);
    if (this.sessionAllow.has(key)) {
      return { behavior: "allow" };
    }
    // Tier 3 — persistent rules (only meaningful in default mode but the
    // sidecar only ever calls canUseTool in default mode anyway).
    const hit = firstPermanentMatch(req.tool_name, req.input);
    if (hit) {
      this.lastAutoAllowDescription = describeRule(hit);
      return { behavior: "allow" };
    }
    this.queue = [...this.queue, req];
    return null;
  }

  /**
   * Pop the request matching id and remember the decision according to the
   * caller's chosen tier:
   *   remember = "session" → in-memory exact hash
   *   remember = "persist" → append a PermanentAllow to settings
   */
  resolve(requestId: string, decision: PermissionDecision): PermissionRequest | null {
    const idx = this.queue.findIndex((r) => r.request_id === requestId);
    if (idx === -1) return null;
    const req = this.queue[idx];
    this.queue = [...this.queue.slice(0, idx), ...this.queue.slice(idx + 1)];
    // Fire the sidecar response. PermissionPrompt also dispatches its own
    // event for the modal flow; the responder de-dups via requestId (the
    // sidecar drops responses for unknown ids). Safe to call from both paths.
    try {
      this.responder?.(requestId, decision);
    } catch {
      // swallow — UI still updates even if RPC fails; App.svelte surfaces toast.
    }
    if (decision.behavior === "allow" && decision.remember === "session") {
      this.sessionAllow.add(memoKey(req.tool_name, req.input));
    }
    if (decision.behavior === "allow" && decision.remember === "persist") {
      const matchType = decision.persistMatch ?? "exact";
      const pattern =
        matchType === "exact"
          ? stableStringify(req.input)
          : matchType === "any"
            ? "*"
            : (decision.persistPattern ?? "");
      // Refuse to persist a useless empty prefix/glob.
      if (
        (matchType === "prefix" || matchType === "glob") &&
        !pattern.trim()
      ) {
        // fall through without persisting; still allow the call
      } else {
        addPermanentRule({
          toolName: req.tool_name,
          matchType,
          pattern,
          addedAt: Date.now(),
          description: decision.persistDescription,
        });
      }
    }
    if (decision.behavior === "deny" && req.tool_use_id) {
      this.denied = {
        ...this.denied,
        [req.tool_use_id]: decision.message ?? "denied by user",
      };
    }
    return req;
  }

  /** Mark a tool_use as denied (used for memoized auto-decisions). */
  markDenied(toolUseId: string, message: string): void {
    this.denied = { ...this.denied, [toolUseId]: message };
  }

  /** Drop everything (e.g. on session end). */
  clear(): void {
    this.queue = [];
    this.denied = {};
    this.sessionAllow.clear();
    // NOTE: persistent rules survive — they are user config.
  }

  /** Peek at the head of the queue. */
  get head(): PermissionRequest | null {
    return this.queue[0] ?? null;
  }
}

export const permissions = new PermissionStore();

// Surface settings type for consumers (UI).
export type { PermanentAllow, PermanentAllowMatchType };

// Re-export the settings store for components that want to subscribe to
// permanentAllowList without a direct dep.
export { settings };
