// Streaming CLI RPC store for `claude` CLI subcommands.
// Each section tracks running state, captured output, parsed result, and
// the rpc id used for in-flight aborts.

import { type UnlistenFn } from "@tauri-apps/api/event";
import { writable, derived, get, type Writable, type Readable } from "svelte/store";
import { safeInvoke, safeListen } from "./safeInvoke";
import { isTauri, setCliFound } from "./systemStatus";

export type SectionKey =
  | "auth"
  | "authLogin"
  | "authLogout"
  | "setupToken"
  | "doctor"
  | "updateCheck"
  | "updateApply"
  | "ultrareview";

export type SectionState = {
  running: boolean;
  rpcId: string | null;
  output: string;
  exit: number | null;
  error: string | null;
  value: unknown;
  startedAt: number | null;
  finishedAt: number | null;
};

const empty = (): SectionState => ({
  running: false,
  rpcId: null,
  output: "",
  exit: null,
  error: null,
  value: null,
  startedAt: null,
  finishedAt: null,
});

export type CliState = {
  binaryPath: string | null;
  searched: string[];
  resolved: boolean;
  sections: Record<SectionKey, SectionState>;
};

const initial: CliState = {
  binaryPath: null,
  searched: [],
  resolved: false,
  sections: {
    auth: empty(),
    authLogin: empty(),
    authLogout: empty(),
    setupToken: empty(),
    doctor: empty(),
    updateCheck: empty(),
    updateApply: empty(),
    ultrareview: empty(),
  },
};

export const cli: Writable<CliState> = writable(initial);

/**
 * Parses CLI auth output to determine signed-in state and (optional) user label.
 * Sources, in priority order:
 *   1. `auth status --json` parsed JSON  (sections.auth.value.json)
 *   2. `auth status` raw stdout         (sections.auth.value.raw)
 *   3. recent `auth login` stdout       (sections.authLogin.output)
 *
 * Recognised success markers (case-insensitive):
 *   - "Login successful"
 *   - "Logged in as <user>"
 *   - "Signed in as <user>"
 *   - "You are logged in"
 *   - "Authenticated as <user>"
 * Recognised signed-out markers:
 *   - "Not logged in", "Logged out", "Please run /login", "No credentials"
 */
export type AuthSignedInState = {
  state: "signed-in" | "signed-out" | "unknown";
  user: string | null;
};

const SIGNED_IN_RE =
  /(?:login\s+successful|you\s+are\s+logged\s+in|signed\s+in(?:\s+as\s+([^\n.,]+))?|logged\s+in(?:\s+as\s+([^\n.,]+))?|authenticated(?:\s+as\s+([^\n.,]+))?)/i;
const SIGNED_OUT_RE =
  /(?:not\s+logged\s+in|logged\s+out|please\s+run\s+\/login|no\s+credentials|no\s+auth(?:entication)?\s+token)/i;

function extractFromJson(json: unknown): AuthSignedInState | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  // Best-effort across CLI versions. Common keys: loggedIn, signedIn, status, user, account, email.
  const loggedIn =
    typeof j.loggedIn === "boolean"
      ? j.loggedIn
      : typeof j.signedIn === "boolean"
        ? j.signedIn
        : typeof j.authenticated === "boolean"
          ? j.authenticated
          : typeof j.status === "string"
            ? /logged.?in|signed.?in|authenticated|ok/i.test(j.status as string)
            : null;
  if (loggedIn === null) return null;
  let user: string | null = null;
  const tryFields = ["user", "username", "email", "account", "login"];
  for (const k of tryFields) {
    const v = j[k];
    if (typeof v === "string" && v.trim()) {
      user = v.trim();
      break;
    }
    if (v && typeof v === "object") {
      const inner = v as Record<string, unknown>;
      for (const k2 of ["email", "username", "name", "login"]) {
        const v2 = inner[k2];
        if (typeof v2 === "string" && v2.trim()) {
          user = v2.trim();
          break;
        }
      }
      if (user) break;
    }
  }
  return { state: loggedIn ? "signed-in" : "signed-out", user };
}

function extractFromText(text: string): AuthSignedInState | null {
  if (!text) return null;
  // Prefer signed-out markers — the status command often prints both
  // "Login successful" history and a current "Not logged in" state. Check
  // signed-out first so a stale success line doesn't override current state.
  if (SIGNED_OUT_RE.test(text)) {
    return { state: "signed-out", user: null };
  }
  const m = text.match(SIGNED_IN_RE);
  if (m) {
    const user = (m[1] ?? m[2] ?? m[3] ?? "").trim() || null;
    return { state: "signed-in", user };
  }
  return null;
}

export function deriveAuthSignedIn(state: CliState): AuthSignedInState {
  const auth = state.sections.auth;
  const login = state.sections.authLogin;
  const logout = state.sections.authLogout;

  // After a successful logout, treat as signed-out until status confirms.
  if (logout.finishedAt && (!auth.finishedAt || logout.finishedAt > auth.finishedAt)) {
    return { state: "signed-out", user: null };
  }

  const v = auth.value as { json?: unknown; raw?: string } | null | undefined;
  if (v?.json) {
    const fromJson = extractFromJson(v.json);
    if (fromJson) return fromJson;
  }
  if (v?.raw) {
    const fromRaw = extractFromText(v.raw);
    if (fromRaw) return fromRaw;
  }

  // Fall back to recent login output (success line streams during the OAuth flow).
  if (!login.running && login.output) {
    const fromLogin = extractFromText(login.output);
    if (fromLogin?.state === "signed-in") return fromLogin;
  }

  return { state: "unknown", user: null };
}

export const authSignedIn: Readable<AuthSignedInState> = derived(
  cli,
  ($cli) => deriveAuthSignedIn($cli),
);

const OUTPUT_CAP = 64 * 1024;

const inflight = new Map<string, SectionKey>(); // rpc id -> section
let unlisten: UnlistenFn | null = null;
let listenerInstalled = false;

function patch(key: SectionKey, mut: (s: SectionState) => SectionState): void {
  cli.update((state) => {
    const next = { ...state.sections, [key]: mut(state.sections[key]) };
    return { ...state, sections: next };
  });
}

function appendOutput(key: SectionKey, chunk: string): void {
  patch(key, (s) => {
    let out = s.output + chunk;
    if (out.length > OUTPUT_CAP) {
      out = out.slice(out.length - OUTPUT_CAP);
    }
    return { ...s, output: out };
  });
}

function uuid(): string {
  return crypto.randomUUID();
}

async function ensureListener(): Promise<void> {
  if (listenerInstalled) return;
  listenerInstalled = true;
  unlisten = await safeListen<{
    id: string;
    type: string;
    [k: string]: unknown;
  }>("sidecar-event", (e) => {
    const ev = e.payload;
    if (!ev || typeof ev !== "object") return;

    // Unsolicited cli_status broadcast (id="sys") from the sidecar's
    // boot-time probe or any claude_path RPC reply. Keep the cli store
    // + systemStatus.cliFound in sync without needing a panel-driven
    // refreshClaudePath() round-trip. This is the primary mechanism that
    // unsticks the "cli missing" banner once PATH inheritance lands.
    if (ev.type === "cli_status") {
      const path = (ev.path as string | null | undefined) ?? null;
      const searched = (ev.searched as string[] | undefined) ?? [];
      cli.update((s) => ({
        ...s,
        binaryPath: path,
        searched,
        resolved: true,
      }));
      setCliFound(!!path);
      return;
    }

    const key = inflight.get(ev.id);
    if (!key) return;

    if (ev.type === "cli_progress") {
      const chunk = String(ev.chunk ?? "");
      appendOutput(key, chunk);
      return;
    }
    if (ev.type === "cli_done") {
      const ok = Boolean(ev.ok);
      const exit = (ev.exit as number | null) ?? null;
      const error = ok ? null : (ev.error as string | undefined) ?? null;
      const value = ev.value ?? null;
      patch(key, (s) => ({
        ...s,
        running: false,
        rpcId: null,
        exit,
        error,
        value,
        finishedAt: Date.now(),
      }));
      inflight.delete(ev.id);
      return;
    }
    if (ev.type === "result") {
      patch(key, (s) => ({
        ...s,
        running: false,
        rpcId: null,
        value: ev.value ?? null,
        finishedAt: Date.now(),
      }));
      inflight.delete(ev.id);
      return;
    }
    if (ev.type === "error") {
      patch(key, (s) => ({
        ...s,
        running: false,
        rpcId: null,
        error: String(ev.error ?? "unknown error"),
        finishedAt: Date.now(),
      }));
      inflight.delete(ev.id);
      return;
    }
  });
}

async function send(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  await ensureListener();
  const id = uuid();
  await safeInvoke("send_to_sidecar", {
    payload: JSON.stringify({ id, type, ...payload }),
  });
  return id;
}

async function startSection(
  key: SectionKey,
  type: string,
  payload: Record<string, unknown> = {},
  resetOutput = true,
): Promise<void> {
  // abort prior inflight for the same section if any
  const prior = get(cli).sections[key];
  if (prior.running && prior.rpcId) {
    try {
      await abortCli(prior.rpcId);
    } catch {
      /* ignore */
    }
    inflight.delete(prior.rpcId);
  }
  const id = await send(type, payload);
  inflight.set(id, key);
  patch(key, (s) => ({
    ...empty(),
    output: resetOutput ? "" : s.output,
    running: true,
    rpcId: id,
    startedAt: Date.now(),
  }));
}

export async function refreshClaudePath(): Promise<void> {
  // Graceful no-op when running in browser preview — without Tauri there's
  // no sidecar to query, so we mark the CLI as missing rather than spamming
  // the console with __TAURI_INTERNALS__ errors.
  if (!isTauri()) {
    cli.update((s) => ({ ...s, binaryPath: null, resolved: true }));
    setCliFound(false);
    return;
  }
  // The shared listener (ensureListener) already handles unsolicited
  // cli_status broadcasts from the sidecar (boot probe + any claude_path
  // RPC reply). Make sure it's installed so we don't miss the result.
  await ensureListener();
  const id = uuid();
  // Attach a one-shot listener BEFORE sending — otherwise sidecar can
  // respond before safeListen() returns and we miss the event.
  const done = new Promise<void>(async (resolve) => {
    const off = await safeListen<{
      id: string;
      type: string;
      [k: string]: unknown;
    }>("sidecar-event", (e) => {
      const ev = e.payload;
      if (!ev || ev.id !== id) return;
      if (ev.type === "result") {
        const v = ev.value as { path: string | null; searched: string[] };
        cli.update((s) => ({
          ...s,
          binaryPath: v?.path ?? null,
          searched: v?.searched ?? [],
          resolved: true,
        }));
        setCliFound(!!v?.path);
        off();
        resolve();
      } else if (ev.type === "error") {
        // Do NOT mark resolved=true here — an early-boot RPC failure
        // (sidecar still spawning) must remain retryable so the boot
        // cli_status broadcast or a later panel open can recover.
        setCliFound(false);
        off();
        resolve();
      }
    });
  });
  const sent = await safeInvoke("send_to_sidecar", {
    payload: JSON.stringify({ id, type: "claude_path" }),
  });
  if (sent === null) {
    // Sidecar IPC not yet available (transient — e.g. probed before sidecar
    // finished spawning). Leave `resolved` false so subsequent callers
    // (panel mount, sidecar boot cli_status broadcast) can re-attempt.
    // Do NOT call setCliFound(false) permanently — that froze the banner.
    return;
  }
  await done;
}

export async function authStatus(): Promise<void> {
  await startSection("auth", "auth_status");
}

export async function authLogin(): Promise<void> {
  await startSection("authLogin", "auth_login");
}

export async function authLogout(): Promise<void> {
  await startSection("authLogout", "auth_logout");
}

export async function setupToken(): Promise<void> {
  await startSection("setupToken", "setup_token");
}

export async function doctorRun(): Promise<void> {
  await startSection("doctor", "doctor_run");
}

export async function updateCheck(): Promise<void> {
  await startSection("updateCheck", "update_check");
}

export async function updateApply(): Promise<void> {
  await startSection("updateApply", "update_apply");
}

export async function ultrareviewRun(target?: string): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (target && target.trim()) payload.target = target.trim();
  await startSection("ultrareview", "ultrareview_run", payload);
}

export async function abortCli(rpcId: string): Promise<void> {
  const id = uuid();
  await safeInvoke("send_to_sidecar", {
    payload: JSON.stringify({ id, type: "cli_abort", target_id: rpcId }),
  });
}

export async function abortSection(key: SectionKey): Promise<void> {
  const s = get(cli).sections[key];
  if (s.running && s.rpcId) {
    await abortCli(s.rpcId);
  }
}

export function disposeCli(): void {
  unlisten?.();
  unlisten = null;
  listenerInstalled = false;
  inflight.clear();
}
