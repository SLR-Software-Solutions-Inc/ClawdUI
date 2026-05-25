// GlitchTip / Sentry-compatible crash reporting for the sidecar process.
// MUST run before any other init so unhandled errors at module-load time
// (e.g. an exception inside one of the imports below) are still captured.
// DSN is supplied at runtime by the Tauri host via env GLITCHTIP_DSN, which is
// itself plumbed in from the build env at bundle time. No DSN => SDK is a
// no-op, so local-dev sidecar runs are unaffected.
import * as Sentry from "@sentry/node";
{
  const dsn = process.env.GLITCHTIP_DSN;
  if (dsn && !dsn.includes("REPLACE_ME")) {
    Sentry.init({
      dsn,
      tracesSampleRate: 0,
      sendDefaultPii: false,
      release: process.env.CLAWDUI_VERSION,
      environment: process.env.NODE_ENV || "production",
      beforeSend(event) {
        if (event.user) {
          delete event.user.email;
          delete event.user.ip_address;
        }
        if (event.request?.cookies) delete event.request.cookies;
        return event;
      },
    });
  }
}

import {
  query,
  type CanUseTool,
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type HookInput,
  type HookJSONOutput,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import readline from "node:readline";
import { promises as fsp, createReadStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { RelayClient, type RelayState } from "./relay.js";
import { getClaudeAccessToken } from "./oauth.js";
import { runHeadless } from "./headless.js";
import { resolveClaudeBinary, searchedClaudePaths } from "./resolveBinary.js";
import { inheritUserPath } from "./userShellEnv.js";

// Inherit the user's login-shell PATH ASAP. macOS GUI launches give us
// launchd's minimal PATH (/usr/bin:/bin:...), which hides `claude`, `git`,
// MCP servers installed in homebrew / .npm-global / .claude/local etc.
// `inheritUserPath` is idempotent + 5s-bounded; we await once at startup
// so every child process below (including the headless branch) sees the
// real PATH.
await inheritUserPath();

// Headless one-shot mode: short-circuit BEFORE the rest of the sidecar
// wires up readline/relay/etc. Triggered when the Tauri host parses a
// `-p`/`--prompt` arg and spawns us with CLAWDUI_HEADLESS=1. We use
// top-level await + process.exit so the JSON-RPC loop below never wires up.
const __HEADLESS__ = process.env.CLAWDUI_HEADLESS === "1";
if (__HEADLESS__) {
  try {
    const code = await runHeadless();
    process.exit(code);
  } catch (e) {
    process.stderr.write(
      `clawdui headless fatal: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  }
}

type McpServerSpec =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

// Options is the upstream SDK Options shape. The full object is built by the
// frontend (src/lib/settings.ts settingsToSDKOptions) and forwarded verbatim
// here, so any field added to that builder (effort, agents, hooks,
// includeHookEvents, plugins, sessionId, title, persistSession, debug,
// excludeDynamicSections via systemPrompt, env.CLAUDE_CODE_SIMPLE for bare
// mode, ...) flows straight through to query() without transformation.

type PermissionDecision =
  | {
      behavior: "allow";
      remember?: "session" | "always";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
    }
  | { behavior: "deny"; message?: string };

type InboundMessage =
  | { id: string; type: "ping" }
  | { id: string; type: "start_session"; options?: Options }
  | { id: string; type: "send_message"; content: string | ContentBlock[] }
  | { id: string; type: "interrupt" }
  | { id: string; type: "set_permission_mode"; mode: PermissionMode }
  | { id: string; type: "set_model"; model?: string }
  | { id: string; type: "set_max_thinking_tokens"; value: number | null }
  | { id: string; type: "supported_models" }
  | { id: string; type: "supported_commands" }
  | { id: string; type: "mcp_status" }
  | { id: string; type: "account_info" }
  | { id: string; type: "permission_response"; request_id: string; decision: PermissionDecision }
  | { id: string; type: "list_skills"; pluginDirs?: string[]; cwd?: string }
  | { id: string; type: "list_plugins"; paths: string[] }
  | { id: string; type: "discover_plugins" }
  | { id: string; type: "mcp_test"; name: string; config: McpServerSpec }
  | {
      id: string;
      type: "hook_test_run";
      command: string;
      env?: Record<string, string>;
      timeout?: number;
    }
  | { id: string; type: "hooks_reload"; cwd?: string }
  | { id: string; type: "end_session" }
  | { id: string; type: "list_sessions"; cwd: string }
  | { id: string; type: "read_session"; session_id: string; cwd: string }
  | {
      id: string;
      type: "fetch_session_window";
      session_id: string;
      cwd: string;
      before_seq: number;
      limit: number;
    }
  | { id: string; type: "delete_session"; session_id: string; cwd: string }
  | { id: string; type: "write_file"; path: string; content: string }
  | { id: string; type: "git_branch"; cwd: string }
  | { id: string; type: "git_status"; cwd: string }
  | {
      id: string;
      type: "git_commit";
      cwd: string;
      // CommitModal sends `subject` + `body`; allow either combined `message` or these two.
      message?: string;
      subject?: string;
      body?: string;
      // CommitModal sends `paths`; task spec calls it `files`. Accept both.
      files?: string[];
      paths?: string[];
      signoff?: boolean;
    }
  | { id: string; type: "claude_path" }
  | { id: string; type: "auth_status" }
  | { id: string; type: "auth_login" }
  | { id: string; type: "auth_logout" }
  | { id: string; type: "setup_token" }
  | { id: string; type: "doctor_run" }
  | { id: string; type: "update_check" }
  | { id: string; type: "update_apply" }
  | { id: string; type: "ultrareview_run"; target?: string }
  | { id: string; type: "cli_abort"; target_id: string }
  | { id: string; type: "upload_file"; path: string }
  | {
      id: string;
      type: "upload_bytes";
      name: string;
      mime?: string;
      base64: string;
    }
  | {
      id: string;
      type: "attach_files_to_next_message";
      files: Array<{ fileId: string; mime?: string; name?: string }>;
    }
  | { id: string; type: "discard_file"; fileId: string }
  | {
      id: string;
      type: "list_pull_requests";
      cwd: string;
      remoteType: "forgejo" | "github" | "gitlab" | "bitbucket" | "other";
      hostBaseUrl: string;
      token?: string;
    }
  | {
      id: string;
      type: "format_pr_context";
      cwd: string;
      remoteType: "forgejo" | "github" | "gitlab" | "bitbucket" | "other";
      hostBaseUrl: string;
      token?: string;
      prNumber: number;
      prTitle: string;
      prBranch: string;
      prBody?: string;
    }
  | {
      id: string;
      type: "fetch_pr_by_url";
      url?: string;
      provider: "github" | "forgejo" | "gitlab" | "bitbucket";
      host: string;
      hostBaseUrl: string;
      owner: string;
      repo: string;
      prNumber: number;
      token?: string;
    }
  | {
      id: string;
      type: "checkout_pr_branch";
      /** User-picked folder ROOT (where the repo should live, NOT inside the repo). */
      chosenFolder: string;
      provider: "github" | "forgejo" | "gitlab" | "bitbucket";
      prNumber: number;
      branch?: string;
      /** Head clone URL (https). */
      cloneUrl?: string;
      /** Head clone URL (ssh). */
      sshUrl?: string;
      /** Repo dir name to create under chosenFolder (e.g. "ClawdUI"). */
      repoName: string;
      /** PR base branch (e.g. "main") — used as wt --base. */
      baseBranch?: string;
    }
  | {
      id: string;
      type: "create_worktree";
      baseRepoPath: string;
      branch: string;
      baseBranch?: string;
    }
  | { id: string; type: "list_worktrees"; baseRepoPath: string }
  | { id: string; type: "git_init"; path: string }
  | {
      id: string;
      type: "set_remote_control";
      enabled: boolean;
      relayUrl?: string;
      sessionName?: string;
      authToken?: string;
    }
  | { id: string; type: "remote_control_status" }
  | { id: string; type: "pair_mobile"; session_id?: string }
  | {
      id: string;
      type: "connect_remote_control_direct";
      org_uuid: string;
      base_url?: string;
    }
  | {
      id: string;
      type: "spawn_child";
      parent_id?: string;
      prompt: string;
      options?: Partial<Options>;
    }
  | { id: string; type: "child_status"; session_id: string }
  | { id: string; type: "cancel_child"; session_id: string };

type OutboundEvent =
  | { id: string; type: "pong"; session_id?: string }
  | { id: string; type: "ack"; session_id?: string }
  | { id: string; type: "session_started"; session_id?: string }
  | { id: string; type: "session_id"; session_id: string }
  | { id: string; type: "message"; message: unknown; session_id?: string }
  | { id: string; type: "session_ended"; session_id?: string }
  | { id: string; type: "result"; value: unknown; session_id?: string }
  | { id: string; type: "error"; error: string; session_id?: string }
  | {
      id: string;
      type: "child_done";
      session_id: string;
      parent_id: string;
      summary: string;
      total_cost_usd: number;
      message_count: number;
    }
  | {
      id: string;
      type: "child_status_result";
      session_id: string;
      alive: boolean;
      last_event_at: number;
      message_count: number;
      total_cost_usd: number;
    }
  | {
      id: string;
      type: "permission_request";
      request_id: string;
      tool_name: string;
      input: Record<string, unknown>;
      suggestions?: PermissionUpdate[];
      tool_use_id?: string;
      session_id: string | null;
      title?: string;
      description?: string;
      blocked_path?: string;
    }
  | {
      id: string;
      type: "hook_test_result";
      stdout?: string;
      stderr?: string;
      exit?: number;
      error?: string;
    }
  | {
      id: string;
      type: "cli_progress";
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      id: string;
      type: "cli_done";
      ok: boolean;
      exit: number | null;
      stdout: string;
      stderr: string;
      value?: unknown;
      error?: string;
    }
  | {
      // Unsolicited broadcast of the resolved `claude` binary state. Sent at
      // sidecar boot (after inheritUserPath finishes) and on every
      // claude_path RPC reply, so the frontend can keep cliFound in sync
      // without polling. id is always "sys" for boot-time emissions.
      id: string;
      type: "cli_status";
      path: string | null;
      searched: string[];
    }
  | {
      id: string;
      type: "remote_control_state";
      state: "disconnected" | "connecting" | "live" | "error";
      sessionName?: string;
      forwarded: number;
      error?: string;
    }
  | {
      id: string;
      type: "mobile_pair_url";
      session_id: string;
      url: string;
      /** Path used: "slash" = /remote-control CLI; "sdk" = direct SDK call. */
      via?: "slash" | "sdk";
    }
  | {
      id: string;
      type: "mobile_pair_error";
      session_id: string;
      error: string;
      via?: "slash" | "sdk";
    }
  | {
      id: string;
      type: "agent_tokens";
      /** Agent / session id the usage delta applies to. "master" for the root session. */
      session_id: string;
      input: number;
      output: number;
      cache_read?: number;
      cache_creation?: number;
    }
  | {
      /**
       * Per-hook firing event. Consumed by HooksDebugger.svelte. Flat shape
       * (not nested under `hook:`) to match the UI contract documented in
       * HooksDebugger.svelte's leading comment block.
       */
      id: string;
      type: "hook-event";
      event: string;
      matcher?: string;
      command: string;
      ts: number;
      exitCode?: number;
      output?: string;
      cwd?: string;
      durationMs?: number;
    };

let relay: RelayClient | null = null;

/**
 * In-memory cache for the Claude access token. Never persisted, never logged.
 * Cleared on 401 from the SDK so the next call re-fetches from the keystore.
 */
type CachedToken = { value: string; fetchedAt: number };
let cachedAccessToken: CachedToken | null = null;
const TOKEN_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
let activeRemoteControlTeardown: (() => Promise<void> | void) | null = null;

/**
 * Canonical path for the same on-disk log file that Rust's SidecarLogger
 * appends to. Must match the Tauri app_log_dir resolution so probe lines and
 * regular stdout/stderr mirror lines land in ONE place. macOS-first; Linux
 * and Windows match Tauri's default app_log_dir convention.
 *
 * macOS:   ~/Library/Logs/ca.slrsoft.clawdui/sidecar.log
 * Linux:   ~/.config/ca.slrsoft.clawdui/logs/sidecar.log
 *          (Tauri app_log_dir on Linux = $XDG_DATA_HOME/<id>/logs, but the
 *          fallback $HOME/.config/<id>/logs is what users without XDG_*
 *          end up with — keeping a single, predictable fallback path.)
 * Windows: %LOCALAPPDATA%\ca.slrsoft.clawdui\logs\sidecar.log
 */
const TAURI_APP_ID = "ca.slrsoft.clawdui";
function sidecarLogPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Logs", TAURI_APP_ID, "sidecar.log");
  }
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ??
      path.join(home, "AppData", "Local");
    return path.join(base, TAURI_APP_ID, "logs", "sidecar.log");
  }
  // linux / other unix
  const xdg = process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  return path.join(xdg, TAURI_APP_ID, "logs", "sidecar.log");
}

/**
 * Diagnostic-only writer. SPAWN_PROBE lines must NEVER leak through stderr —
 * Rust forwards stderr to the UI's "Show sidecar log" panel and the noise
 * looks like a stuck session to end users. Append directly to the same file
 * Rust's SidecarLogger writes to, with a matching `[ts] [probe] ...` shape.
 * Best-effort: a log failure must NEVER block the session.
 */
function logProbe(line: string): void {
  try {
    const p = sidecarLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const ts = new Date().toISOString();
    const clean = line.replace(/\n+$/, "");
    fs.appendFileSync(p, `[${ts}] [probe] ${clean}\n`);
  } catch {
    // ignore — diagnostic only
  }
}

// Hard cap on a single emitted line. The Tauri host reads stdout via
// BufReader::lines() which allocates a String per line; multi-MB lines
// quintuple memory + stall the reader thread on the subsequent
// serde_json::from_str. The frontend never renders payloads this large
// (>256KB), so truncating defensively before write is safe.
//
// Empirically the runtime hang reproduces with resume of large jsonls
// where the SDK replays many large `message` records back-to-back: the
// kernel pipe buffer (~64KB on macOS) fills, the kernel blocks
// process.stdout.write, Node's internal Writable queues bytes in V8
// heap, and the event loop is starved by GC long before the Rust
// reader thread drains. Truncation keeps individual writes well below
// the pipe HWM so backpressure stays bounded.
const MAX_EMIT_BYTES = 256 * 1024; // 256 KB per line
// Hooks can emit very large captured stdout/stderr blobs (e.g. a hook
// that dumps a build log). The UI only renders the head/tail in the
// HooksDebugger panel — anything past a few KB is wasted bandwidth.
const MAX_HOOK_OUTPUT_BYTES = 8 * 1024;

/**
 * Trim an emitted event in-place so the serialized JSON line stays
 * under MAX_EMIT_BYTES. We mutate a shallow copy so the original record
 * (used elsewhere — e.g. forwarded to the relay below) is untouched.
 */
function truncateEventForStdout(ev: OutboundEvent): OutboundEvent {
  // Cheap path: small events skip the JSON.stringify cost.
  try {
    const probe = JSON.stringify(ev);
    if (probe.length <= MAX_EMIT_BYTES) return ev;
  } catch {
    return ev;
  }
  // Mutable shallow copy keyed only when type matches a known heavy event.
  const shallow: Record<string, unknown> = { ...(ev as unknown as Record<string, unknown>) };
  if (shallow.type === "hook-event") {
    const out = (shallow.output as string | undefined) ?? "";
    if (typeof out === "string" && out.length > MAX_HOOK_OUTPUT_BYTES) {
      shallow.output =
        out.slice(0, MAX_HOOK_OUTPUT_BYTES) + `\n[truncated ${out.length - MAX_HOOK_OUTPUT_BYTES} bytes]`;
    }
  } else if (shallow.type === "message") {
    // Deep-replace any oversized text/content blocks inside the SDK
    // message envelope. We don't validate the SDK schema here — best
    // effort serialize-with-replacer fallback below.
    try {
      const serialized = JSON.stringify(shallow.message);
      if (serialized.length > MAX_EMIT_BYTES) {
        shallow.message = {
          __truncated: true,
          __originalBytes: serialized.length,
          preview: serialized.slice(0, MAX_EMIT_BYTES / 2),
          note: "payload truncated by sidecar IPC guard",
        };
      }
    } catch {
      /* leave as-is */
    }
  }
  return shallow as unknown as OutboundEvent;
}

/**
 * Backpressure-aware stdout write. Returns a Promise that resolves once
 * the kernel pipe has accepted the bytes (or once the next 'drain' fires
 * if the Writable's internal buffer is full). emit() awaits this so a
 * stalled Tauri reader can't blow up V8 heap with queued writes.
 */
function writeStdoutLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    const ok = process.stdout.write(line);
    if (ok) {
      resolve();
    } else {
      process.stdout.once("drain", () => resolve());
    }
  });
}

// Single-flight queue so emit() callers never interleave partial lines
// on stdout when one is awaiting drain. Each enqueue waits for the
// previous write to clear. Failures are swallowed — losing a line is
// preferable to hanging the SDK consume loop.
let emitQueue: Promise<void> = Promise.resolve();

function emit(ev: OutboundEvent): void {
  // [DIAG] outbound event trace — keep until session-resume flow stabilized.
  try {
    const anyEv = ev as Record<string, unknown>;
    const sid = anyEv.session_id;
    const summary =
      ev.type === "message" || ev.type === "result"
        ? "<elided>"
        : JSON.stringify(ev).slice(0, 200);
    console.error(
      `[DIAG-OUT] id=${(ev as { id?: string }).id} type=${ev.type} sid=${sid} ${summary}`,
    );
  } catch {
    /* never let diag break emit */
  }
  const safe = truncateEventForStdout(ev);
  const line = JSON.stringify(safe) + "\n";
  emitQueue = emitQueue.then(() => writeStdoutLine(line)).catch(() => {
    /* never let one failed write stall the queue */
  });
  // Tee to relay so remote peers see the same event stream as the local UI.
  // Skip relay-state events themselves to avoid feedback loops.
  if (relay && ev.type !== "remote_control_state") {
    relay.forward("event", ev);
  }
}

function emitRelayState(): void {
  if (!relay) {
    emit({
      id: "rc",
      type: "remote_control_state",
      state: "disconnected",
      forwarded: 0,
    });
    return;
  }
  const s = relay.state;
  emit({
    id: "rc",
    type: "remote_control_state",
    state: s.kind === "error" ? "error" : s.kind,
    forwarded: relay.forwardedCount,
    error: s.kind === "error" ? s.error : undefined,
  });
}

type PluginInfo = {
  path: string;
  exists: boolean;
  name: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
  counts: { skills: number; commands: number; hooks: number; agents: number };
};

function safeReadDirCount(p: string): number {
  try {
    if (!fs.existsSync(p)) return 0;
    const st = fs.statSync(p);
    if (!st.isDirectory()) return 0;
    return fs.readdirSync(p).filter((n) => !n.startsWith(".")).length;
  } catch {
    return 0;
  }
}

function readManifest(dir: string): {
  name: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
} {
  const candidates = [
    path.join(dir, ".claude-plugin", "plugin.json"),
    path.join(dir, "plugin.json"),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      const author =
        typeof parsed.author === "string"
          ? parsed.author
          : parsed.author && typeof parsed.author === "object"
            ? parsed.author.name ?? null
            : null;
      return {
        name: typeof parsed.name === "string" ? parsed.name : null,
        description:
          typeof parsed.description === "string" ? parsed.description : null,
        version: typeof parsed.version === "string" ? parsed.version : null,
        author,
      };
    } catch {
      /* fall through */
    }
  }
  return { name: null, description: null, version: null, author: null };
}

function inspectPlugin(p: string): PluginInfo {
  const exists = fs.existsSync(p) && fs.statSync(p).isDirectory();
  if (!exists) {
    return {
      path: p,
      exists: false,
      name: null,
      description: null,
      version: null,
      author: null,
      counts: { skills: 0, commands: 0, hooks: 0, agents: 0 },
    };
  }
  const manifest = readManifest(p);
  // hooks may be defined as a directory of scripts OR declared in plugin.json
  let hookCount = safeReadDirCount(path.join(p, "hooks"));
  try {
    const file = path.join(p, ".claude-plugin", "plugin.json");
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed.hooks && typeof parsed.hooks === "object") {
        // count distinct hook events (SessionStart, UserPromptSubmit, ...)
        hookCount = Math.max(hookCount, Object.keys(parsed.hooks).length);
      }
    }
  } catch {
    /* ignore */
  }
  return {
    path: p,
    exists: true,
    ...manifest,
    counts: {
      skills: safeReadDirCount(path.join(p, "skills")),
      commands: safeReadDirCount(path.join(p, "commands")),
      hooks: hookCount,
      agents: safeReadDirCount(path.join(p, "agents")),
    },
  };
}

function discoverPluginsRoot(): PluginInfo[] {
  const root = path.join(os.homedir(), ".claude", "plugins", "cache");
  if (!fs.existsSync(root)) return [];
  const out: PluginInfo[] = [];
  // layout: cache/<owner>/<plugin>/<version>/...
  for (const owner of fs.readdirSync(root)) {
    const ownerDir = path.join(root, owner);
    if (!fs.statSync(ownerDir).isDirectory()) continue;
    for (const pluginName of fs.readdirSync(ownerDir)) {
      const pluginDir = path.join(ownerDir, pluginName);
      if (!fs.statSync(pluginDir).isDirectory()) continue;
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(pluginDir);
      } catch {
        continue;
      }
      // Each version subdir is a candidate root
      for (const version of entries) {
        const versionDir = path.join(pluginDir, version);
        try {
          if (!fs.statSync(versionDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const info = inspectPlugin(versionDir);
        const hasContent =
          info.name ||
          info.counts.skills +
            info.counts.commands +
            info.counts.hooks +
            info.counts.agents >
            0;
        if (hasContent) out.push(info);
      }
    }
  }
  return out;
}

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private waiters: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    const next = this.waiters.shift();
    if (next) {
      next({ value: msg, done: false });
      return;
    }
    this.pending.push(msg);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const head = this.pending.shift();
        if (head) {
          return Promise.resolve({ value: head, done: false });
        }
        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as SDKUserMessage,
            done: true,
          });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type PendingPermission = {
  resolve: (result: PermissionResult) => void;
  suggestions?: PermissionUpdate[];
};

/**
 * Sanitize an absolute cwd into Claude SDK's project-directory naming.
 * Rule (matches observed contents of ~/.claude/projects/):
 *   - replace every non-alphanumeric character (including `/` and `.`)
 *     with `-`. Examples:
 *     "/Users/<you>/dev/tools/clawdui" → "-Users--you--dev-tools-clawdui"
 *     "/Users/<you>/.claude-mem/observer-sessions"
 *       → "-Users--you---claude-mem-observer-sessions" (note `---` from `/.`)
 */
function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Validate that an `opts.cwd` actually exists and is a directory.
 *
 * Why this exists: when posix_spawn(command, ..., chdir(cwd)) is invoked with
 * a non-existent cwd, the kernel returns ENOENT (errno=-2) — but Node attaches
 * the COMMAND path to the error, not the cwd. The Claude Agent SDK then
 * surfaces "Claude Code native binary not found at <command>" which is
 * completely misleading: the binary is fine, the workspace path is stale.
 *
 * Returns `null` on success, or a short human-readable reason on failure.
 * Non-string / empty cwd is treated as success (caller falls back to
 * process.cwd()).
 */
function validateCwd(cwd: unknown): string | null {
  if (typeof cwd !== "string" || !cwd) return null;
  try {
    const st = fs.statSync(cwd);
    if (!st.isDirectory()) return `path is not a directory: ${cwd}`;
    return null;
  } catch {
    return `workspace path does not exist: ${cwd}`;
  }
}

function projectsDir(cwd: string): string {
  return path.join(os.homedir(), ".claude", "projects", sanitizeCwd(cwd));
}

type SessionSummary = {
  id: string;
  /** First 8 chars of id — for compact display. */
  idShort: string;
  /** Display title: customName ?? firstUserPrompt ?? idShort. */
  title: string;
  /** User-set name via /name (custom-title record) — null if absent. */
  customName: string | null;
  /** First real user prompt (skips <local-command-caveat> preamble), trimmed to 80 chars. */
  firstUserPrompt: string;
  firstMessage: string;
  lastMessage: string;
  messageCount: number;
  totalCostUsd: number;
  model?: string;
  mtime: number;
  /** cwd recorded on the session's first user event. */
  cwd?: string;
  /** Last 2 path segments of cwd (e.g. apps/heartbeat-for-couple). */
  cwdTail?: string;
};

function tailSegments(p: string, n: number): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts.slice(-n).join("/");
}

function isPreamble(text: string): boolean {
  const t = text.trimStart();
  if (!t) return true;
  // System / harness preambles that should not surface as "first user prompt".
  return (
    t.startsWith("<local-command-caveat>") ||
    t.startsWith("<command-name>") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<system-reminder>") ||
    t.startsWith("Caveat:") ||
    t.startsWith("[Request interrupted")
  );
}

function stripLeadingHeading(text: string): string {
  return text.replace(/^\s*#{1,6}\s+/, "");
}

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
    return parts.join(" ");
  }
  return "";
}

async function readFirstAndLastLines(
  filePath: string,
  headN: number,
  tailN: number,
): Promise<{ head: string[]; tail: string[]; total: number }> {
  // Stream once, keep first N and last N lines, count total.
  return new Promise((resolve, reject) => {
    const head: string[] = [];
    const tail: string[] = [];
    let total = 0;
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line) return;
      total++;
      if (head.length < headN) head.push(line);
      tail.push(line);
      if (tail.length > tailN) tail.shift();
    });
    rl.on("close", () => resolve({ head, tail, total }));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

function safeParse(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function summarizeSession(
  filePath: string,
  id: string,
): Promise<SessionSummary | null> {
  try {
    const stat = await fsp.stat(filePath);
    // Pull more head lines so we can scan past system preambles
    // (`<local-command-caveat>`, `<command-name>`, etc.) before locking onto
    // the first real user prompt. Sidechain detection lives on the first
    // user/attachment event near the top of the file.
    const { head, tail, total } = await readFirstAndLastLines(filePath, 25, 5);
    const all = [...head, ...tail];

    let firstUserText = "";
    let firstUserPromptText = "";
    let lastAssistantText = "";
    let model: string | undefined;
    let totalCostUsd = 0;
    let customName: string | null = null;
    let cwd: string | undefined;
    let isChild = false;

    for (const line of all) {
      const obj = safeParse(line);
      if (!obj) continue;
      // Detect child / sub-agent sessions. These exist when the CLI was
      // spawned by a parent session's Task tool. Filtering at list level
      // only — resume of a known id still works.
      if (obj.isSidechain === true) isChild = true;
      if (typeof obj.parentToolUseId === "string" && obj.parentToolUseId) {
        isChild = true;
      }
      if (typeof obj.parent_tool_use_id === "string" && obj.parent_tool_use_id) {
        isChild = true;
      }
      // custom-title record carries the user-supplied /name value.
      if (obj.type === "custom-title" && typeof obj.customTitle === "string") {
        customName = obj.customTitle.trim() || null;
      }
      if (!cwd && typeof obj.cwd === "string") cwd = obj.cwd;
      // SDK records can be at top-level or nested under "message"
      const role =
        (obj.role as string | undefined) ??
        ((obj.message as Record<string, unknown> | undefined)?.role as
          | string
          | undefined);
      const content =
        (obj.content as unknown) ??
        (obj.message as Record<string, unknown> | undefined)?.content;
      const text = extractText(content);
      if (!firstUserText && (obj.type === "user" || role === "user") && text) {
        firstUserText = text;
      }
      // Skip system / harness preambles when picking the "first user prompt"
      // to display. We keep scanning until we find a real user message.
      if (
        !firstUserPromptText &&
        (obj.type === "user" || role === "user") &&
        text &&
        !isPreamble(text)
      ) {
        firstUserPromptText = stripLeadingHeading(text);
      }
      if (
        (obj.type === "assistant" || role === "assistant") &&
        text &&
        text.trim()
      ) {
        lastAssistantText = text;
      }
      const m =
        ((obj.message as Record<string, unknown> | undefined)?.model as
          | string
          | undefined) ??
        (obj.model as string | undefined);
      if (m) model = m;
      const cost = obj.total_cost_usd;
      if (typeof cost === "number") totalCostUsd = cost;
    }

    if (isChild) return null;

    const truncate = (s: string, n: number): string =>
      s.length <= n ? s : s.slice(0, n - 1) + "…";

    const cleanPrompt = firstUserPromptText
      ? truncate(firstUserPromptText.replace(/\s+/g, " ").trim(), 80)
      : "";
    const idShort = id.slice(0, 8);
    const title = customName || cleanPrompt || idShort;

    return {
      id,
      idShort,
      title,
      customName,
      firstUserPrompt: cleanPrompt,
      firstMessage: truncate(firstUserText, 240),
      lastMessage: truncate(lastAssistantText, 240),
      messageCount: total,
      totalCostUsd,
      model,
      mtime: stat.mtimeMs,
      cwd,
      cwdTail: cwd ? tailSegments(cwd, 2) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve which `~/.claude/projects/<dir>` buckets are relevant for a given cwd.
 *
 * The CLI always writes to `~/.claude/projects/<sanitizeCwd(cwd-at-spawn)>/`.
 * In a bare-repo + worktrees layout the user often opens the parent
 * `worktrees/` folder as the workspace — but the CLI was spawned from one of
 * the inner `worktrees/<branch>/` dirs, or from the project root itself, so
 * the jsonl files live in a DIFFERENT bucket than `sanitizeCwd(cwd)` would
 * produce. Aggregate buckets so the panel surfaces existing CLI history.
 *
 * Buckets returned, in priority order:
 *   1. exact cwd
 *   2. descendants of cwd (project dirs whose sanitized name starts with
 *      `sanitizeCwd(cwd) + "-"`)
 *   3. parent of cwd when basename is `worktrees` (bare-repo container)
 */
function sessionBucketsFor(cwd: string): string[] {
  const buckets = new Set<string>();
  const root = path.join(os.homedir(), ".claude", "projects");
  buckets.add(projectsDir(cwd));
  // descendants
  try {
    const prefix = sanitizeCwd(cwd) + "-";
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && ent.name.startsWith(prefix)) {
        buckets.add(path.join(root, ent.name));
      }
    }
  } catch {
    /* projects dir may not exist yet */
  }
  // parent-when-worktrees container
  if (path.basename(cwd) === "worktrees") {
    buckets.add(projectsDir(path.dirname(cwd)));
  }
  return [...buckets];
}

async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const buckets = sessionBucketsFor(cwd);
  const out: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const dir of buckets) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.replace(/\.jsonl$/, "");
      if (seen.has(id)) continue;
      seen.add(id);
      const full = path.join(dir, name);
      const summary = await summarizeSession(full, id);
      if (summary) out.push(summary);
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Locate the bucket dir that actually contains `<sessionId>.jsonl`. Falls back
 * to `projectsDir(cwd)` so callers always get a usable path even when the
 * session is missing (the resulting fs op will surface the real ENOENT).
 */
function findSessionBucket(cwd: string, sessionId: string): string {
  const file = `${sessionId}.jsonl`;
  for (const dir of sessionBucketsFor(cwd)) {
    try {
      if (fs.existsSync(path.join(dir, file))) return dir;
    } catch {
      /* skip */
    }
  }
  return projectsDir(cwd);
}

async function readSession(
  cwd: string,
  sessionId: string,
): Promise<unknown[]> {
  const file = path.join(findSessionBucket(cwd, sessionId), `${sessionId}.jsonl`);
  const text = await fsp.readFile(file, "utf8");
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const obj = safeParse(line);
    if (obj) out.push(obj);
  }
  return out;
}

/**
 * Paginated session window read.
 *
 * Returns up to `limit` jsonl entries whose 0-based index is in
 * `[beforeSeq - limit, beforeSeq)`. Pass `beforeSeq <= 0` for "no upper
 * bound" — used by the initial resume call which wants the LAST `limit`
 * entries. The returned `total` is the full transcript length so callers
 * can derive `oldestSeq = total - returned.length` on first call.
 *
 * Implementation: full read + slice. Cheaper than building a positional
 * index since the worst-case file is ~120 MB which Node parses in <500ms
 * on an M-series Mac. If we hit larger transcripts we can switch to a
 * streaming line-counter with a tail buffer.
 */
async function fetchSessionWindow(
  cwd: string,
  sessionId: string,
  beforeSeq: number,
  limit: number,
): Promise<{ messages: unknown[]; startSeq: number; total: number; hasMore: boolean }> {
  const file = path.join(findSessionBucket(cwd, sessionId), `${sessionId}.jsonl`);
  const text = await fsp.readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  const all: unknown[] = [];
  for (const line of lines) {
    if (!line) continue;
    const obj = safeParse(line);
    if (obj) all.push(obj);
  }
  const total = all.length;
  const cap = Math.max(1, Math.min(limit | 0, 5000));
  // beforeSeq <= 0 means "from end". Treat as `total`.
  const upper = beforeSeq <= 0 ? total : Math.min(beforeSeq | 0, total);
  const lower = Math.max(0, upper - cap);
  const slice = all.slice(lower, upper);
  return {
    messages: slice,
    startSeq: lower,
    total,
    hasMore: lower > 0,
  };
}

async function deleteSession(
  cwd: string,
  sessionId: string,
): Promise<{ trashed: string }> {
  const dir = findSessionBucket(cwd, sessionId);
  const file = path.join(dir, `${sessionId}.jsonl`);
  const trashDir = path.join(dir, ".trash");
  await fsp.mkdir(trashDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(trashDir, `${sessionId}.${ts}.jsonl`);
  await fsp.rename(file, target);
  return { trashed: target };
}

async function writeFile(p: string, content: string): Promise<{ path: string }> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content, "utf8");
  return { path: p };
}

type GitStatusFile = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  /** Legacy compound code retained for the CommitModal UI (e.g. " M", "??"). */
  status: string;
};

type GitStatusResult = {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  // CommitModal currently consumes `entries: [{path, status}]` — provide both
  // shapes from one RPC to avoid a UI refactor.
  entries: Array<{ path: string; status: string }>;
};

/**
 * Run `git status --porcelain=v2 --branch -z` and parse into a structured
 * response. Uses spawn (not shell exec) to avoid injection on cwd content.
 */
async function gitStatus(cwd: string): Promise<GitStatusResult> {
  const empty: GitStatusResult = {
    branch: null,
    ahead: 0,
    behind: 0,
    files: [],
    entries: [],
  };
  if (!cwd || typeof cwd !== "string") return empty;
  const res = await runCmd(
    "git",
    ["-C", cwd, "status", "--porcelain=v2", "--branch", "-z"],
    {},
  );
  if (res.code !== 0) return empty;
  const out: GitStatusResult = { branch: null, ahead: 0, behind: 0, files: [], entries: [] };
  // `-z` uses NUL separators. Rename/copy entries (prefix "2 ") consume an
  // extra NUL-delimited field for the old path; the parser handles that.
  const records = res.stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    if (rec.startsWith("# ")) {
      // Branch headers, e.g. "# branch.head main", "# branch.ab +1 -0".
      const parts = rec.split(" ");
      if (parts[1] === "branch.head") {
        out.branch = parts.slice(2).join(" ") || null;
      } else if (parts[1] === "branch.ab" && parts.length >= 4) {
        const ahead = parseInt(parts[2], 10);
        const behind = parseInt(parts[3], 10);
        if (Number.isFinite(ahead)) out.ahead = Math.abs(ahead);
        if (Number.isFinite(behind)) out.behind = Math.abs(behind);
      }
      continue;
    }
    if (rec.startsWith("1 ")) {
      // Ordinary changed entry: "1 XY sub mH mI mW hH hI path"
      const fields = rec.split(" ");
      const xy = fields[1] ?? "..";
      const path = fields.slice(8).join(" ");
      if (path) out.files.push(makeStatusFile(path, xy));
    } else if (rec.startsWith("2 ")) {
      // Rename/copy: "2 XY sub mH mI mW hH hI Rscore path"; orig path follows
      // in the NEXT NUL-delimited record.
      const fields = rec.split(" ");
      const xy = fields[1] ?? "..";
      const path = fields.slice(9).join(" ");
      // consume the orig-path slot to keep the index aligned
      i += 1;
      if (path) out.files.push(makeStatusFile(path, xy));
    } else if (rec.startsWith("? ")) {
      // Untracked: "? path"
      const path = rec.slice(2);
      if (path) out.files.push(makeStatusFile(path, "??"));
    } else if (rec.startsWith("u ")) {
      // Unmerged: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
      const fields = rec.split(" ");
      const xy = fields[1] ?? "UU";
      const path = fields.slice(10).join(" ");
      if (path) out.files.push(makeStatusFile(path, xy));
    }
  }
  out.entries = out.files.map((f) => ({ path: f.path, status: f.status }));
  return out;
}

function makeStatusFile(path: string, xy: string): GitStatusFile {
  const index = xy[0] ?? ".";
  const worktree = xy[1] ?? ".";
  const staged = index !== "." && index !== "?" && index !== " ";
  // Compose the legacy two-char code the UI expects (e.g. " M", "??", "A ").
  const legacy = xy === "??" ? "??" : `${index === "." ? " " : index}${worktree === "." ? " " : worktree}`;
  return {
    path,
    indexStatus: index,
    worktreeStatus: worktree,
    staged,
    status: legacy,
  };
}

type GitCommitInput = {
  cwd: string;
  message?: string;
  subject?: string;
  body?: string;
  files?: string[];
  paths?: string[];
  signoff?: boolean;
};

type GitCommitResult = {
  ok: boolean;
  sha?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Stage the requested paths (or `-u` if none given), then run `git commit`.
 * Uses spawn — no shell interpolation, so paths containing whitespace or
 * shell metacharacters are safe.
 */
async function gitCommit(req: GitCommitInput): Promise<GitCommitResult> {
  const cwd = req.cwd;
  if (!cwd || typeof cwd !== "string") {
    return { ok: false, stdout: "", stderr: "missing cwd", exitCode: -1 };
  }
  // Compose final commit message — prefer explicit `message`, else
  // subject+body joined with a blank line.
  const subj = (req.subject ?? "").trim();
  const body = (req.body ?? "").trim();
  let message = (req.message ?? "").trim();
  if (!message) {
    message = body ? `${subj}\n\n${body}` : subj;
  }
  if (!message) {
    return { ok: false, stdout: "", stderr: "empty commit message", exitCode: -1 };
  }
  const files = (req.files ?? req.paths ?? []).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );

  // Stage: explicit paths if provided, otherwise stage all tracked modifications.
  const addArgs = files.length > 0
    ? ["-C", cwd, "add", "--", ...files]
    : ["-C", cwd, "add", "-u"];
  const addRes = await runCmd("git", addArgs, {});
  if (addRes.code !== 0) {
    return {
      ok: false,
      stdout: addRes.stdout,
      stderr: addRes.stderr || `git add exited ${addRes.code}`,
      exitCode: addRes.code,
    };
  }

  const commitArgs = ["-C", cwd, "commit", "-m", message];
  if (req.signoff) commitArgs.push("--signoff");
  const commitRes = await runCmd("git", commitArgs, {});
  if (commitRes.code !== 0) {
    return {
      ok: false,
      stdout: commitRes.stdout,
      stderr: commitRes.stderr || `git commit exited ${commitRes.code}`,
      exitCode: commitRes.code,
    };
  }

  // Resolve the new SHA (best-effort — failure here doesn't fail the commit).
  let sha: string | undefined;
  const revRes = await runCmd("git", ["-C", cwd, "rev-parse", "HEAD"], {});
  if (revRes.code === 0) {
    const trimmed = revRes.stdout.trim();
    if (trimmed) sha = trimmed;
  }

  return {
    ok: true,
    sha,
    stdout: commitRes.stdout,
    stderr: commitRes.stderr,
    exitCode: 0,
  };
}

async function gitBranch(cwd: string): Promise<{ branch: string | null }> {
  if (!cwd || typeof cwd !== "string") return { branch: null };
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, "branch", "--show-current"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (b) => {
      out += b.toString("utf8");
    });
    child.on("error", () => resolve({ branch: null }));
    child.on("close", (code) => {
      if (code === 0) {
        const branch = out.trim();
        resolve({ branch: branch.length ? branch : null });
      } else {
        resolve({ branch: null });
      }
    });
  });
}

// ----- PR picker -----

type PullRequest = {
  number: number;
  title: string;
  branch: string;
  author: string;
  url: string;
  updatedAt: string;
  body?: string;
  /** Head HTTPS clone URL (provider's clone_url / http_url_to_repo). */
  cloneUrl?: string;
  /** Head SSH clone URL (provider's ssh_url / ssh_url_to_repo). */
  sshUrl?: string;
  /** PR base branch (the branch the PR targets, e.g. "main"). */
  baseBranch?: string;
  /** Short repo name (e.g. "ClawdUI"). Used to compute target dir name. */
  repoName?: string;
};

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `git exited ${code}`));
    });
  });
}

type WorktreeEntry = {
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
};

type CreateWorktreeResult = {
  path: string;
  branch: string;
  baseBranch: string;
  tool: "wt" | "git-worktree";
};

function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      resolve({ code: typeof code === "number" ? code : -1, stdout, stderr });
    });
  });
}

type PendingFile = { fileId: string; mime: string; name: string };

/**
 * Parse `owner/repo` from a git remote URL. Supports SSH and HTTPS forms:
 *   git@host:owner/repo(.git)
 *   ssh://git@host[:port]/owner/repo(.git)
 *   https://host/owner/repo(.git)
 */
function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  let s = remoteUrl.trim();
  if (s.endsWith(".git")) s = s.slice(0, -4);

  // SSH shorthand: git@host:owner/repo
  const sshMatch = s.match(/^[^@]+@[^:]+:([^/]+)\/(.+)$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // ssh:// or https://
  try {
    const u = new URL(s);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length >= 2) {
      return { owner: segs[segs.length - 2], repo: segs[segs.length - 1] };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function findOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = (process.env.PATH ?? "").split(sep);
  // Common Homebrew/asdf locations on macOS not always in PATH from Tauri.
  const extra =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".cargo", "bin")]
      : [];
  for (const d of [...dirs, ...extra]) {
    if (!d) continue;
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

async function detectRepoFromCwd(cwd: string): Promise<{ owner: string; repo: string }> {
  const remote = await runGit(cwd, ["config", "--get", "remote.origin.url"]);
  const parsed = parseOwnerRepo(remote);
  if (!parsed) throw new Error(`could not parse remote.origin.url: ${remote}`);
  return parsed;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": "clawdui", ...headers } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 240)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response: ${text.slice(0, 240)}`);
  }
}

/**
 * @deprecated Use `fetchPrByUrl` (URL-driven, no cwd-remote sniffing).
 * Kept for backwards compatibility with any callers that still use the
 * `list_pull_requests` RPC. New code should not call this — when the local
 * remote uses an SSH host alias, `detectRepoFromCwd` cannot reverse-resolve
 * it to a Forgejo/GitHub API host, producing HTTP 404s.
 */
async function listPullRequests(req: {
  cwd: string;
  remoteType: "forgejo" | "github" | "gitlab" | "bitbucket" | "other";
  hostBaseUrl: string;
  token?: string;
}): Promise<PullRequest[]> {
  const { owner, repo } = await detectRepoFromCwd(req.cwd);
  const host = req.hostBaseUrl.replace(/\/+$/, "").replace(/^https?:\/\//, "");
  const token = req.token ?? "";

  if (req.remoteType === "forgejo") {
    const url = `https://${host}/api/v1/repos/${owner}/${repo}/pulls?state=open&limit=50`;
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `token ${token}`;
    const data = (await fetchJson(url, headers)) as Array<Record<string, unknown>>;
    return data.map((p) => ({
      number: Number(p.number),
      title: String(p.title ?? ""),
      branch: String((p.head as Record<string, unknown> | undefined)?.ref ?? ""),
      author: String((p.user as Record<string, unknown> | undefined)?.login ?? ""),
      url: String(p.html_url ?? ""),
      updatedAt: String(p.updated_at ?? ""),
      body: typeof p.body === "string" ? p.body : undefined,
    }));
  }

  if (req.remoteType === "github") {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=50`;
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const data = (await fetchJson(url, headers)) as Array<Record<string, unknown>>;
    return data.map((p) => ({
      number: Number(p.number),
      title: String(p.title ?? ""),
      branch: String((p.head as Record<string, unknown> | undefined)?.ref ?? ""),
      author: String((p.user as Record<string, unknown> | undefined)?.login ?? ""),
      url: String(p.html_url ?? ""),
      updatedAt: String(p.updated_at ?? ""),
      body: typeof p.body === "string" ? p.body : undefined,
    }));
  }

  if (req.remoteType === "gitlab") {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const url = `https://${host}/api/v4/projects/${projectId}/merge_requests?state=opened&per_page=50`;
    const headers: Record<string, string> = {};
    if (token) headers["PRIVATE-TOKEN"] = token;
    const data = (await fetchJson(url, headers)) as Array<Record<string, unknown>>;
    return data.map((p) => ({
      number: Number(p.iid),
      title: String(p.title ?? ""),
      branch: String(p.source_branch ?? ""),
      author: String((p.author as Record<string, unknown> | undefined)?.username ?? ""),
      url: String(p.web_url ?? ""),
      updatedAt: String(p.updated_at ?? ""),
      body: typeof p.description === "string" ? p.description : undefined,
    }));
  }

  if (req.remoteType === "bitbucket") {
    const url = `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/pullrequests?state=OPEN&pagelen=50`;
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const data = (await fetchJson(url, headers)) as { values?: Array<Record<string, unknown>> };
    const list = data.values ?? [];
    return list.map((p) => {
      const src = p.source as Record<string, unknown> | undefined;
      const branchObj = src?.branch as Record<string, unknown> | undefined;
      const author = p.author as Record<string, unknown> | undefined;
      const links = p.links as Record<string, unknown> | undefined;
      const html = links?.html as Record<string, unknown> | undefined;
      return {
        number: Number(p.id),
        title: String(p.title ?? ""),
        branch: String(branchObj?.name ?? ""),
        author: String(author?.display_name ?? author?.nickname ?? ""),
        url: String(html?.href ?? ""),
        updatedAt: String(p.updated_on ?? ""),
        body: typeof p.description === "string" ? p.description : undefined,
      };
    });
  }

  throw new Error(`unsupported remote type: ${req.remoteType}`);
}

/**
 * Build a system-prompt preamble describing the PR. The frontend appends this
 * to settings.appendSystemPrompt before starting the new session, replacing
 * the legacy --from-pr CLI flag.
 */
async function formatPrContext(req: {
  cwd: string;
  remoteType: "forgejo" | "github" | "gitlab" | "bitbucket" | "other";
  hostBaseUrl: string;
  token?: string;
  prNumber: number;
  prTitle: string;
  prBranch: string;
  prBody?: string;
}): Promise<{ preamble: string; title: string }> {
  // Body wasn't passed (or was truncated); try to fetch a fuller version.
  let body = req.prBody ?? "";
  if (!body) {
    try {
      const { owner, repo } = await detectRepoFromCwd(req.cwd);
      const host = req.hostBaseUrl.replace(/\/+$/, "").replace(/^https?:\/\//, "");
      const token = req.token ?? "";
      let url = "";
      const headers: Record<string, string> = {};
      if (req.remoteType === "forgejo") {
        url = `https://${host}/api/v1/repos/${owner}/${repo}/pulls/${req.prNumber}`;
        if (token) headers["Authorization"] = `token ${token}`;
      } else if (req.remoteType === "github") {
        url = `https://api.github.com/repos/${owner}/${repo}/pulls/${req.prNumber}`;
        headers.Accept = "application/vnd.github+json";
        if (token) headers["Authorization"] = `Bearer ${token}`;
      } else if (req.remoteType === "gitlab") {
        const projectId = encodeURIComponent(`${owner}/${repo}`);
        url = `https://${host}/api/v4/projects/${projectId}/merge_requests/${req.prNumber}`;
        if (token) headers["PRIVATE-TOKEN"] = token;
      }
      if (url) {
        const data = (await fetchJson(url, headers)) as Record<string, unknown>;
        body =
          (typeof data.body === "string" ? data.body : "") ||
          (typeof data.description === "string" ? data.description : "") ||
          "";
      }
    } catch {
      /* ignore — preamble still useful without body */
    }
  }

  const lines = [
    `## Resumed from PR #${req.prNumber}`,
    `- title: ${req.prTitle}`,
    `- branch: ${req.prBranch}`,
    body ? `\n${body.trim()}` : "",
  ].filter(Boolean);
  const preamble = lines.join("\n");
  const title = `PR #${req.prNumber}: ${req.prTitle}`.slice(0, 120);
  return { preamble, title };
}

/**
 * URL-first PR fetch. Parses caller-supplied {provider, host, owner, repo, n}
 * — does NOT consult cwd's git remote, so it works even when the local repo
 * has a host-aliased SSH remote (which broke the old listPullRequests path).
 */
async function fetchPrByUrl(req: {
  provider: "github" | "forgejo" | "gitlab" | "bitbucket";
  host: string;
  hostBaseUrl: string;
  owner: string;
  repo: string;
  prNumber: number;
  token?: string;
}): Promise<PullRequest> {
  const { provider, owner, repo, prNumber } = req;
  const base = req.hostBaseUrl.replace(/\/+$/, "");
  const token = req.token ?? "";

  if (provider === "forgejo") {
    const url = `${base}/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`;
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `token ${token}`;
    const p = (await fetchJson(url, headers)) as Record<string, unknown>;
    const head = p.head as Record<string, unknown> | undefined;
    const headRepo = head?.repo as Record<string, unknown> | undefined;
    const baseObj = p.base as Record<string, unknown> | undefined;
    return {
      number: Number(p.number ?? prNumber),
      title: String(p.title ?? ""),
      branch: String(head?.ref ?? ""),
      author: String((p.user as Record<string, unknown> | undefined)?.login ?? ""),
      url: String(p.html_url ?? ""),
      updatedAt: String(p.updated_at ?? ""),
      body: typeof p.body === "string" ? p.body : undefined,
      cloneUrl: typeof headRepo?.clone_url === "string" ? (headRepo.clone_url as string) : undefined,
      sshUrl: typeof headRepo?.ssh_url === "string" ? (headRepo.ssh_url as string) : undefined,
      baseBranch: typeof baseObj?.ref === "string" ? (baseObj.ref as string) : undefined,
      repoName: typeof headRepo?.name === "string" ? (headRepo.name as string) : repo,
    };
  }

  if (provider === "github") {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const p = (await fetchJson(url, headers)) as Record<string, unknown>;
    const head = p.head as Record<string, unknown> | undefined;
    const headRepo = head?.repo as Record<string, unknown> | undefined;
    const baseObj = p.base as Record<string, unknown> | undefined;
    return {
      number: Number(p.number ?? prNumber),
      title: String(p.title ?? ""),
      branch: String(head?.ref ?? ""),
      author: String((p.user as Record<string, unknown> | undefined)?.login ?? ""),
      url: String(p.html_url ?? ""),
      updatedAt: String(p.updated_at ?? ""),
      body: typeof p.body === "string" ? p.body : undefined,
      cloneUrl: typeof headRepo?.clone_url === "string" ? (headRepo.clone_url as string) : undefined,
      sshUrl: typeof headRepo?.ssh_url === "string" ? (headRepo.ssh_url as string) : undefined,
      baseBranch: typeof baseObj?.ref === "string" ? (baseObj.ref as string) : undefined,
      repoName: typeof headRepo?.name === "string" ? (headRepo.name as string) : repo,
    };
  }

  if (provider === "gitlab") {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const url = `${base}/api/v4/projects/${projectId}/merge_requests/${prNumber}`;
    const headers: Record<string, string> = {};
    if (token) headers["PRIVATE-TOKEN"] = token;
    const p = (await fetchJson(url, headers)) as Record<string, unknown>;
    // GitLab needs a second hit on the source project to get clone URLs;
    // best-effort — fall back to constructing the URL from host + path.
    const sourceProjectId = p.source_project_id;
    let cloneUrl: string | undefined;
    let sshUrl: string | undefined;
    let repoName: string | undefined = repo;
    if (typeof sourceProjectId === "number" || typeof sourceProjectId === "string") {
      try {
        const projUrl = `${base}/api/v4/projects/${encodeURIComponent(String(sourceProjectId))}`;
        const proj = (await fetchJson(projUrl, headers)) as Record<string, unknown>;
        cloneUrl = typeof proj.http_url_to_repo === "string" ? (proj.http_url_to_repo as string) : undefined;
        sshUrl = typeof proj.ssh_url_to_repo === "string" ? (proj.ssh_url_to_repo as string) : undefined;
        if (typeof proj.path === "string") repoName = proj.path as string;
      } catch {
        /* ignore — frontend will fall back to constructed URL */
      }
    }
    return {
      number: Number(p.iid ?? prNumber),
      title: String(p.title ?? ""),
      branch: String(p.source_branch ?? ""),
      author: String((p.author as Record<string, unknown> | undefined)?.username ?? ""),
      url: String(p.web_url ?? ""),
      updatedAt: String(p.updated_at ?? ""),
      body: typeof p.description === "string" ? p.description : undefined,
      cloneUrl,
      sshUrl,
      baseBranch: typeof p.target_branch === "string" ? (p.target_branch as string) : undefined,
      repoName,
    };
  }

  if (provider === "bitbucket") {
    const url = `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/pullrequests/${prNumber}`;
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const p = (await fetchJson(url, headers)) as Record<string, unknown>;
    const src = p.source as Record<string, unknown> | undefined;
    const srcRepo = src?.repository as Record<string, unknown> | undefined;
    const srcLinks = srcRepo?.links as Record<string, unknown> | undefined;
    const cloneArr = srcLinks?.clone as Array<Record<string, unknown>> | undefined;
    const cloneHttps = cloneArr?.find((c) => c.name === "https")?.href as string | undefined;
    const cloneSsh = cloneArr?.find((c) => c.name === "ssh")?.href as string | undefined;
    const branchObj = src?.branch as Record<string, unknown> | undefined;
    const dest = p.destination as Record<string, unknown> | undefined;
    const destBranch = dest?.branch as Record<string, unknown> | undefined;
    const author = p.author as Record<string, unknown> | undefined;
    const links = p.links as Record<string, unknown> | undefined;
    const html = links?.html as Record<string, unknown> | undefined;
    return {
      number: Number(p.id ?? prNumber),
      title: String(p.title ?? ""),
      branch: String(branchObj?.name ?? ""),
      author: String(author?.display_name ?? author?.nickname ?? ""),
      url: String(html?.href ?? ""),
      updatedAt: String(p.updated_on ?? ""),
      body: typeof p.description === "string" ? p.description : undefined,
      cloneUrl: cloneHttps,
      sshUrl: cloneSsh,
      baseBranch: typeof destBranch?.name === "string" ? (destBranch.name as string) : undefined,
      repoName: typeof srcRepo?.name === "string" ? (srcRepo.name as string) : repo,
    };
  }

  throw new Error(`unsupported provider: ${provider}`);
}

/**
 * Locally fetch + check out a PR head branch. Uses the canonical refspec for
 * each provider so we don't need to know the remote's PR fork URL:
 *   GitHub / Forgejo / Gitea: refs/pull/<n>/head
 *   GitLab:                   refs/merge-requests/<n>/head
 *   Bitbucket:                no universal refspec — fall back to branch fetch
 *
 * Surfaces git auth failures (exit 128 + permission / authentication / could
 * not read Username) as a clear "Git credentials missing" error.
 */
/**
 * Detect the layout of a repo directory.
 *
 * Returns one of:
 *  - "bare-worktrees": canonical layout — bare repo at root with
 *    checked-out worktrees under `worktrees/<branch>/`. Detected by either:
 *      (a) `<dir>/worktrees/` subdir exists, OR
 *      (b) `<dir>/HEAD` exists AND no `<dir>/.git/` AND no working-tree
 *          marker files (package.json, src/, Cargo.toml, etc).
 *  - "regular": standard clone — `<dir>/.git/` exists AND working tree.
 *  - "unknown": neither — caller falls back to in-place fetch + checkout
 *    and logs a warning.
 */
async function detectRepoLayout(
  dir: string,
): Promise<"bare-worktrees" | "regular" | "unknown"> {
  const fileExists = async (p: string): Promise<boolean> => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  };
  const worktreesDir = path.join(dir, "worktrees");
  const gitDir = path.join(dir, ".git");
  const headFile = path.join(dir, "HEAD");

  const hasWorktreesSubdir = await fileExists(worktreesDir);
  const hasGitDir = await fileExists(gitDir);
  const hasHead = await fileExists(headFile);

  // Bare+worktrees layout: worktrees/ subdir present.
  if (hasWorktreesSubdir) return "bare-worktrees";

  // Pure bare repo: HEAD at root, no .git/, no working-tree files.
  if (hasHead && !hasGitDir) {
    const workMarkers = ["package.json", "src", "Cargo.toml", "go.mod", "pyproject.toml"];
    const anyWork = await Promise.all(workMarkers.map((m) => fileExists(path.join(dir, m))));
    if (!anyWork.some(Boolean)) return "bare-worktrees";
  }

  if (hasGitDir) return "regular";
  return "unknown";
}

/** Resolve `wt` on PATH. Returns absolute path or null if not installed. */
async function findWtBinary(): Promise<string | null> {
  const res = await runCmd("sh", ["-c", "command -v wt"], {});
  if (res.code !== 0) return null;
  const p = res.stdout.trim();
  return p.length ? p : null;
}

type CheckoutStrategy = "wt" | "git";

async function checkoutPrBranch(req: {
  chosenFolder: string;
  provider: "github" | "forgejo" | "gitlab" | "bitbucket";
  prNumber: number;
  branch?: string;
  cloneUrl?: string;
  sshUrl?: string;
  repoName: string;
  baseBranch?: string;
}): Promise<{
  ok: true;
  localBranch: string;
  strategy: CheckoutStrategy;
  reason: string;
  finalCwd: string;
}> {
  const { chosenFolder, provider, prNumber, repoName } = req;

  if (!chosenFolder || typeof chosenFolder !== "string") {
    throw new Error("No folder chosen for PR checkout.");
  }
  if (!repoName) {
    throw new Error("PR metadata is missing the repository name — cannot pick target dir.");
  }

  const targetDir = path.join(chosenFolder, repoName);

  // Step 1: clone if missing.
  let cloned = false;
  try {
    await fsp.access(targetDir);
  } catch {
    // Doesn't exist — clone.
    const cloneSource = req.cloneUrl || req.sshUrl;
    if (!cloneSource) {
      throw new Error(
        `Repo dir missing at ${targetDir} and PR metadata has no clone URL — cannot clone.`,
      );
    }
    // Ensure the parent folder exists.
    try {
      await fsp.mkdir(chosenFolder, { recursive: true });
    } catch {
      /* ignore — likely already exists */
    }
    const cloneRes = await runCmd("git", ["clone", cloneSource, targetDir], {});
    if (cloneRes.code !== 0) {
      const out = `${cloneRes.stdout}\n${cloneRes.stderr}`.toLowerCase();
      const isAuth =
        out.includes("authentication failed") ||
        out.includes("could not read username") ||
        out.includes("permission denied") ||
        out.includes("publickey") ||
        out.includes("403") ||
        out.includes("401");
      if (isAuth) {
        throw new Error(
          `git clone failed: credentials missing. Configure GIT_TOKEN or SSH keys for ${cloneSource}.`,
        );
      }
      throw new Error(
        `git clone ${cloneSource} failed (exit ${cloneRes.code}): ${cloneRes.stderr.trim().slice(0, 240)}`,
      );
    }
    cloned = true;
  }

  // Step 2: detect layout.
  const layout = await detectRepoLayout(targetDir);

  // Compute local branch name + refspec (used by git-fetch path).
  let localBranch: string;
  let refspec: string;
  if (provider === "github" || provider === "forgejo") {
    localBranch = `pr-${prNumber}`;
    refspec = `pull/${prNumber}/head:${localBranch}`;
  } else if (provider === "gitlab") {
    localBranch = `mr-${prNumber}`;
    refspec = `merge-requests/${prNumber}/head:${localBranch}`;
  } else {
    // Bitbucket: no stable PR refspec — fall back to branch fetch if known.
    if (!req.branch) {
      throw new Error(
        `Bitbucket PR checkout requires a branch name. (PR head branch was empty.)`,
      );
    }
    localBranch = `pr-${prNumber}`;
    refspec = `${req.branch}:${localBranch}`;
  }

  // Step 3: check wt availability.
  const wtPath = await findWtBinary();

  // Step 4: pick strategy.
  const baseBranch = req.baseBranch || "main";
  const useWt = layout === "bare-worktrees" && wtPath !== null;

  if (useWt) {
    // wt switch --create pr-<N> --base <baseBranch>, run inside targetDir.
    // Per wt's convention, the resulting worktree lives at
    // <targetDir>/worktrees/<branch>/.
    const wtRes = await runCmd(
      wtPath!,
      ["switch", "--create", localBranch, "--base", baseBranch],
      { cwd: targetDir },
    );
    if (wtRes.code !== 0) {
      // Fall back to git-fetch path in-place + record fallback reason.
      const wtErr = (wtRes.stderr || wtRes.stdout || "").trim().slice(0, 240);
      const gitResult = await gitFetchCheckoutInPlace(targetDir, refspec, localBranch);
      return {
        ok: true,
        localBranch,
        strategy: "git",
        reason:
          `wt switch failed (exit ${wtRes.code}: ${wtErr}); fell back to git fetch+checkout in-place` +
          (cloned ? " (repo was just cloned)" : ""),
        finalCwd: gitResult.finalCwd,
      };
    }
    const finalCwd = path.join(targetDir, "worktrees", localBranch);
    return {
      ok: true,
      localBranch,
      strategy: "wt",
      reason:
        `bare+worktrees layout detected and wt CLI present — used wt switch --create ${localBranch} --base ${baseBranch}` +
        (cloned ? " (after fresh clone)" : ""),
      finalCwd,
    };
  }

  // Strategy: git fetch + checkout in-place.
  const gitResult = await gitFetchCheckoutInPlace(targetDir, refspec, localBranch);
  let reason: string;
  if (layout === "bare-worktrees" && !wtPath) {
    reason =
      `bare+worktrees layout detected but wt CLI not installed — used git fetch+checkout in-place. ` +
      `Install wt for the worktree workflow (e.g. \`brew install worktrunk\`).`;
  } else if (layout === "regular") {
    reason = `regular clone layout detected — used git fetch+checkout in-place`;
  } else {
    reason =
      `unknown repo layout at ${targetDir} — fell back to git fetch+checkout in-place. ` +
      `Verify the target dir is a valid git repository.`;
  }
  if (cloned) reason += " (after fresh clone)";
  return {
    ok: true,
    localBranch,
    strategy: "git",
    reason,
    finalCwd: gitResult.finalCwd,
  };
}

/** Run `git fetch origin +<refspec>` then `git checkout <localBranch>` in `cwd`. */
async function gitFetchCheckoutInPlace(
  cwd: string,
  refspec: string,
  localBranch: string,
): Promise<{ finalCwd: string }> {
  const fetchRes = await runCmd("git", ["-C", cwd, "fetch", "origin", "+" + refspec], {});
  if (fetchRes.code !== 0) {
    const out = `${fetchRes.stdout}\n${fetchRes.stderr}`.toLowerCase();
    const isAuth =
      out.includes("authentication failed") ||
      out.includes("could not read username") ||
      out.includes("permission denied") ||
      out.includes("publickey") ||
      out.includes("403") ||
      out.includes("401");
    if (isAuth) {
      throw new Error(
        "Git credentials missing. Configure GIT_TOKEN or SSH keys to fetch the PR branch.",
      );
    }
    throw new Error(
      `git fetch ${refspec} failed (exit ${fetchRes.code}): ${fetchRes.stderr.trim().slice(0, 240)}`,
    );
  }
  const coRes = await runCmd("git", ["-C", cwd, "checkout", localBranch], {});
  if (coRes.code !== 0) {
    throw new Error(
      `git checkout ${localBranch} failed (exit ${coRes.code}): ${coRes.stderr.trim().slice(0, 240)}`,
    );
  }
  return { finalCwd: cwd };
}

function slugBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

type ListWorktreesResult =
  | { kind: "ok"; entries: WorktreeEntry[] }
  | { kind: "non_git" }
  | { kind: "error"; error: string };

async function listWorktrees(baseRepoPath: string): Promise<ListWorktreesResult> {
  // Probe: does the folder live inside a git repo? If not, return a tagged
  // result so the UI can offer a friendly init flow instead of rendering a
  // raw "fatal: not a git repository" string.
  const probe = await runCmd("git", [
    "-C",
    baseRepoPath,
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (probe.code !== 0) {
    return { kind: "non_git" };
  }
  const { code, stdout, stderr } = await runCmd(
    "git",
    ["-C", baseRepoPath, "worktree", "list", "--porcelain"],
  );
  if (code !== 0) {
    return {
      kind: "error",
      error: `git worktree list failed: ${stderr.trim() || `exit ${code}`}`,
    };
  }
  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> & { path?: string } = {};
  const flush = () => {
    if (cur.path) {
      out.push({
        path: cur.path,
        branch: cur.branch ?? null,
        head: cur.head ?? null,
        locked: !!cur.locked,
      });
    }
    cur = {};
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      if (cur.path) flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (cur.path) flush();
      cur.path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      // "branch refs/heads/<name>"
      const ref = line.slice("branch ".length).trim();
      cur.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    } else if (line === "locked" || line.startsWith("locked ")) {
      cur.locked = true;
    } else if (line === "detached") {
      cur.branch = null;
    }
  }
  if (cur.path) flush();
  return { kind: "ok", entries: out };
}

async function gitInit(targetPath: string): Promise<{ ok: true }> {
  const r = await runCmd("git", ["init", "-b", "main", targetPath]);
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || r.stdout.trim() || `git init exited ${r.code}`);
  }
  return { ok: true };
}

/**
 * Detect a created worktree path from `wt switch --create` stdout.
 * Worktrunk prints lines like:
 *   "✓ Created branch <b> from <base> and worktree @ <path>"
 *   or "✓ Switched to worktree @ <path>"
 */
function parseWtPath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  // Search bottom-up for the most recent "@ <path>" mention.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/@\s+(\S.+?)\s*$/);
    if (m) {
      const candidate = m[1].trim();
      // Expand ~ to home for parser convenience.
      if (candidate.startsWith("~")) {
        return path.join(os.homedir(), candidate.slice(1));
      }
      return candidate;
    }
  }
  return null;
}

async function createWorktree(
  baseRepoPath: string,
  branch: string,
  baseBranch: string,
): Promise<CreateWorktreeResult> {
  if (!branch || !branch.trim()) throw new Error("branch is required");
  if (!baseRepoPath) throw new Error("baseRepoPath is required");

  // Try Worktrunk first.
  const wtBin = findOnPath("wt");
  if (wtBin) {
    // Bypass shell-fn wrapper: spawn binary directly.
    // wt expects to be invoked from inside the repo; use cwd = baseRepoPath.
    const tmpCd = await fsp.mkdtemp(path.join(os.tmpdir(), "clawdui-wt-"));
    const cdFile = path.join(tmpCd, "cd");
    const execFile = path.join(tmpCd, "exec");
    try {
      const res = await runCmd(
        wtBin,
        ["switch", "--create", branch, "--base", baseBranch],
        {
          cwd: baseRepoPath,
          env: {
            WORKTRUNK_DIRECTIVE_CD_FILE: cdFile,
            WORKTRUNK_DIRECTIVE_EXEC_FILE: execFile,
          },
        },
      );
      if (res.code === 0) {
        let resolved: string | null = null;
        try {
          if (fs.existsSync(cdFile)) {
            const t = fs.readFileSync(cdFile, "utf8").trim();
            if (t) resolved = t;
          }
        } catch {
          /* ignore */
        }
        if (!resolved) resolved = parseWtPath(res.stdout);
        if (!resolved) {
          throw new Error(
            `wt succeeded but worktree path not detected; stdout:\n${res.stdout}`,
          );
        }
        return {
          path: resolved,
          branch,
          baseBranch,
          tool: "wt",
        };
      }
      // wt failed — surface its error if it's a real failure (not "wt not on PATH").
      const msg = (res.stderr || res.stdout).trim();
      throw new Error(`wt switch --create failed (exit ${res.code}): ${msg}`);
    } finally {
      try {
        await fsp.rm(tmpCd, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // Fallback: plain git worktree.
  const repoName = path.basename(baseRepoPath.replace(/[\\/]+$/, ""));
  const slug = slugBranch(branch);
  const target = path.resolve(baseRepoPath, "..", `${repoName}-${slug}`);
  if (fs.existsSync(target)) {
    throw new Error(`worktree path already exists: ${target}`);
  }
  const res = await runCmd(
    "git",
    [
      "-C",
      baseRepoPath,
      "worktree",
      "add",
      target,
      "-b",
      branch,
      baseBranch,
    ],
  );
  if (res.code !== 0) {
    throw new Error(
      `git worktree add failed: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  return { path: target, branch, baseBranch, tool: "git-worktree" };
}

class Session {
  readonly streamId: string;
  /** Logical id used to tag events. "master" for the parent session;
   * generated id (e.g. "child_xxx") for children. */
  readonly sessionKey: string;
  readonly parentKey: string | null;
  readonly query: Query;
  readonly queue: MessageQueue;
  sessionId: string | null = null;
  readonly pending = new Map<string, PendingPermission>();
  /** files staged to ride along with the next user message */
  pendingFiles: PendingFile[] = [];
  /** stored options so children can inherit (cwd/model/etc.) */
  readonly options: Options;
  /** observability counters used by child_done / child_status */
  alive: boolean = true;
  messageCount: number = 0;
  totalCostUsd: number = 0;
  lastEventAt: number = Date.now();
  lastAssistantText: string = "";
  /** child completion hook; resolves with one-paragraph summary */
  doneResolvers: Array<(summary: string) => void> = [];
  /** When true, scan assistant text for a claude.ai pairing URL.
   * Reset to false once a URL has been emitted (or an error). */
  pairingActive: boolean = false;

  constructor(
    streamId: string,
    options: Options | undefined,
    sessionKey: string = "master",
    parentKey: string | null = null,
  ) {
    this.streamId = streamId;
    this.sessionKey = sessionKey;
    this.parentKey = parentKey;
    this.queue = new MessageQueue();
    const merged: Options = { ...(options ?? {}) };
    merged.canUseTool = this.canUseTool;
    this.options = merged;
    this.query = query({
      prompt: this.queue,
      options: merged,
    });
    void this.consume();
  }

  private canUseTool: CanUseTool = (toolName, input, opts) => {
    return new Promise<PermissionResult>((resolve) => {
      const requestId = `perm_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const onAbort = () => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        resolve({ behavior: "deny", message: "user interrupted" });
      };

      if (opts.signal.aborted) {
        resolve({ behavior: "deny", message: "user interrupted" });
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });

      this.pending.set(requestId, {
        resolve: (result) => {
          opts.signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        suggestions: opts.suggestions,
      });

      emit({
        id: this.streamId,
        type: "permission_request",
        request_id: requestId,
        tool_name: toolName,
        input,
        suggestions: opts.suggestions,
        tool_use_id: opts.toolUseID,
        session_id: this.sessionKey,
        title: opts.title,
        description: opts.description,
        blocked_path: opts.blockedPath,
      });
    });
  };

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);

    if (decision.behavior === "allow") {
      const updatedPermissions =
        decision.remember === "session" && pending.suggestions
          ? pending.suggestions
          : decision.updatedPermissions;
      const allowResult: PermissionResult = {
        behavior: "allow",
        ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
        ...(updatedPermissions ? { updatedPermissions } : {}),
      };
      pending.resolve(allowResult);
    } else {
      pending.resolve({
        behavior: "deny",
        message: decision.message ?? "denied by user",
      });
    }
    return true;
  }

  private async consume(): Promise<void> {
    try {
      for await (const msg of this.query) {
        this.lastEventAt = Date.now();
        this.messageCount++;
        const sid = (msg as { session_id?: string }).session_id;
        if (sid && this.sessionId !== sid) {
          this.sessionId = sid;
          emit({
            id: this.streamId,
            type: "session_id",
            session_id: sid,
          });
        }
        // Track cost from result-style records.
        const rec = msg as Record<string, unknown>;
        const cost = rec.total_cost_usd;
        if (typeof cost === "number") this.totalCostUsd = cost;
        // Track last assistant text for child summary.
        const role =
          (rec.role as string | undefined) ??
          ((rec.message as Record<string, unknown> | undefined)?.role as
            | string
            | undefined);
        if (rec.type === "assistant" || role === "assistant") {
          const content =
            (rec.content as unknown) ??
            (rec.message as Record<string, unknown> | undefined)?.content;
          const text = extractText(content);
          if (text && text.trim()) this.lastAssistantText = text;
          if (this.pairingActive && text) {
            // Look for a claude.ai pairing URL emitted by /remote-control.
            const m = text.match(/https:\/\/claude\.ai\/[^\s"'`<>]*/i);
            if (m) {
              this.pairingActive = false;
              emit({
                id: this.streamId,
                type: "mobile_pair_url",
                session_id: this.sessionKey,
                url: m[0],
                via: "slash",
              });
            } else {
              // Detect common error/auth refusals and surface them.
              const lc = text.toLowerCase();
              if (
                lc.includes("requires") &&
                (lc.includes("auth") || lc.includes("login") || lc.includes("plan") || lc.includes("subscription"))
              ) {
                this.pairingActive = false;
                emit({
                  id: this.streamId,
                  type: "mobile_pair_error",
                  session_id: this.sessionKey,
                  error: text.slice(0, 500).trim(),
                  via: "slash",
                });
              } else if (
                /not (supported|available)|rate limit|unauthor/i.test(text) &&
                /remote[- ]control|claude\.ai/i.test(text)
              ) {
                this.pairingActive = false;
                emit({
                  id: this.streamId,
                  type: "mobile_pair_error",
                  session_id: this.sessionKey,
                  error: text.slice(0, 500).trim(),
                  via: "slash",
                });
              }
            }
          }
        }
        emit({
          id: this.streamId,
          type: "message",
          message: msg,
          session_id: this.sessionKey,
        });
        // Per-agent token usage. Surfaces in the Fleet View token counter and
        // any other consumer that wants a per-child breakdown. We pull from
        // the same `usage` shape the master path already normalizes
        // (input_tokens / output_tokens / cache_*); the frontend store
        // accumulates the delta.
        const usage = ((rec.message as Record<string, unknown> | undefined)?.usage
          ?? rec.usage) as Record<string, unknown> | undefined;
        if (usage && typeof usage === "object") {
          const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          const input = n(usage.input_tokens);
          const output = n(usage.output_tokens);
          const cacheRead = n(usage.cache_read_input_tokens);
          const cacheCreation = n(usage.cache_creation_input_tokens);
          if (input || output || cacheRead || cacheCreation) {
            emit({
              id: this.streamId,
              type: "agent_tokens",
              session_id: this.sessionKey,
              input,
              output,
              cache_read: cacheRead,
              cache_creation: cacheCreation,
            });
          }
        }
      }
    } catch (err) {
      emit({
        id: this.streamId,
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        session_id: this.sessionKey,
      });
    } finally {
      this.alive = false;
      const summary = (this.lastAssistantText || "").slice(0, 1000);
      // Notify any awaiters (spawn_child returns first response).
      for (const r of this.doneResolvers) r(summary);
      this.doneResolvers = [];
      // Emit child_done if this is a child session.
      if (this.parentKey) {
        emit({
          id: this.streamId,
          type: "child_done",
          session_id: this.sessionKey,
          parent_id: this.parentKey,
          summary,
          total_cost_usd: this.totalCostUsd,
          message_count: this.messageCount,
        });
      }
    }
  }

  /** Awaited by spawn_child to relay a summary back as the tool result. */
  whenDone(): Promise<string> {
    if (!this.alive) {
      return Promise.resolve(this.lastAssistantText.slice(0, 1000));
    }
    return new Promise((r) => this.doneResolvers.push(r));
  }

  send(content: string | ContentBlock[]): void {
    // Promote pending file uploads into content blocks so they ride
    // alongside the user's text/images. Images and PDFs get first-class
    // blocks; other types degrade to a textual mention.
    const fileBlocks = this.pendingFiles.map((f) => fileToBlock(f));
    this.pendingFiles = [];

    let merged: string | unknown[];
    if (fileBlocks.length === 0) {
      merged = typeof content === "string" ? content : (content as unknown[]);
    } else if (typeof content === "string") {
      const text = content.trim();
      merged = text
        ? [...fileBlocks, { type: "text", text }]
        : fileBlocks;
    } else {
      merged = [...fileBlocks, ...(content as unknown[])];
    }

    const userMsg: SDKUserMessage = {
      type: "user",
      session_id: this.sessionId ?? "",
      message: {
        role: "user",
        content: merged as SDKUserMessage["message"]["content"],
      },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage;
    this.queue.push(userMsg);
  }

  end(): void {
    for (const [, p] of this.pending) {
      p.resolve({ behavior: "deny", message: "session ended" });
    }
    this.pending.clear();
    this.queue.close();
  }
}

type SkillInfo = {
  id: string;
  source: string;
  name: string;
  description: string;
  plugin?: string;
  path: string;
};

function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  const block = text.slice(3, end);
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function parseSkillFile(filePath: string): { name: string; description: string } | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  // fallback: derive name from directory
  const name = fm.name ?? path.basename(path.dirname(filePath));
  const description = fm.description ?? "";
  return { name, description };
}

function collectFromSkillsDir(
  skillsDir: string,
  source: string,
  plugin: string | undefined,
  out: SkillInfo[],
  seen: Set<string>,
): void {
  for (const dirName of safeReaddir(skillsDir)) {
    const skillPath = path.join(skillsDir, dirName, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const meta = parseSkillFile(skillPath);
    if (!meta) continue;
    const id = plugin ? `${plugin}:${meta.name}` : meta.name;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      source,
      name: meta.name,
      description: meta.description,
      plugin,
      path: skillPath,
    });
  }
}

function listSkills(extraPluginDirs: string[], cwd?: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  const home = os.homedir();

  // 0) project-local: <cwd>/.claude/skills/<name>/SKILL.md — registered FIRST
  //    so project skills win on id collision (the `seen` set blocks later
  //    duplicates from the user-global scope).
  if (cwd) {
    collectFromSkillsDir(
      path.join(cwd, ".claude", "skills"),
      "project",
      undefined,
      out,
      seen,
    );
  }

  // 1) user-installed: ~/.claude/skills/<name>/SKILL.md
  collectFromSkillsDir(
    path.join(home, ".claude", "skills"),
    "user",
    undefined,
    out,
    seen,
  );

  // 2) plugin-cached: ~/.claude/plugins/cache/<marketplace>/<plugin>/[<version>/]skills/<name>/SKILL.md
  const cacheRoot = path.join(home, ".claude", "plugins", "cache");
  for (const marketplace of safeReaddir(cacheRoot)) {
    const mpDir = path.join(cacheRoot, marketplace);
    for (const pluginName of safeReaddir(mpDir)) {
      const pluginDir = path.join(mpDir, pluginName);
      // direct skills/
      collectFromSkillsDir(
        path.join(pluginDir, "skills"),
        `plugin:${pluginName}`,
        pluginName,
        out,
        seen,
      );
      // versioned: <plugin>/<version>/skills/
      for (const ver of safeReaddir(pluginDir)) {
        if (ver === "skills") continue;
        collectFromSkillsDir(
          path.join(pluginDir, ver, "skills"),
          `plugin:${pluginName}`,
          pluginName,
          out,
          seen,
        );
      }
    }
  }

  // 3) legacy: ~/.claude/plugins/<plugin>/skills/<name>/SKILL.md
  const legacyRoot = path.join(home, ".claude", "plugins");
  for (const entry of safeReaddir(legacyRoot)) {
    if (entry === "cache" || entry === "marketplaces" || entry === "data") continue;
    const skillsDir = path.join(legacyRoot, entry, "skills");
    collectFromSkillsDir(
      skillsDir,
      `plugin:${entry}`,
      entry,
      out,
      seen,
    );
  }

  // 4) marketplaces fallback (single-skill plugins where SKILL.md sits at <plugin>/SKILL.md)
  const mpRoot = path.join(home, ".claude", "plugins", "marketplaces");
  for (const mp of safeReaddir(mpRoot)) {
    const mpDir = path.join(mpRoot, mp);
    for (const pluginName of safeReaddir(mpDir)) {
      const direct = path.join(mpDir, pluginName, "SKILL.md");
      if (fs.existsSync(direct)) {
        const meta = parseSkillFile(direct);
        if (!meta) continue;
        const id = `${mp}:${meta.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          source: `marketplace:${mp}`,
          name: meta.name,
          description: meta.description,
          plugin: mp,
          path: direct,
        });
      }
      // also nested skills
      const skillsDir = path.join(mpDir, pluginName, "skills");
      collectFromSkillsDir(
        skillsDir,
        `marketplace:${mp}`,
        pluginName,
        out,
        seen,
      );
    }
  }

  // 5) user-supplied plugin dirs from settings
  for (const dir of extraPluginDirs) {
    if (!dir) continue;
    const expanded = dir.startsWith("~")
      ? path.join(home, dir.slice(1))
      : dir;
    const skillsDir = path.join(expanded, "skills");
    collectFromSkillsDir(
      skillsDir,
      `custom:${path.basename(expanded)}`,
      path.basename(expanded),
      out,
      seen,
    );
    // and treat the dir itself as a skills root
    collectFromSkillsDir(
      expanded,
      `custom:${path.basename(expanded)}`,
      undefined,
      out,
      seen,
    );
  }

  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ---------------------------------------------------------------------------
// File uploads (Anthropic Files API, beta)
// ---------------------------------------------------------------------------

const FILES_BETA = "files-api-2025-04-14";
let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (anthropicClient) return anthropicClient;
  // Anthropic SDK auto-reads ANTHROPIC_API_KEY from env. If not set, the
  // client still constructs but `upload` will reject — surfaced to caller.
  anthropicClient = new Anthropic({
    defaultHeaders: { "anthropic-beta": FILES_BETA },
  });
  return anthropicClient;
}

function guessMime(filePath: string, fallback = "application/octet-stream"): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".html": "text/html",
    ".xml": "application/xml",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".py": "text/x-python",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
    ".sh": "text/x-shellscript",
  };
  return map[ext] ?? fallback;
}

type UploadResult = { fileId: string; name: string; size: number; mime: string };

async function uploadFileToSdk(filePath: string): Promise<UploadResult> {
  const stat = await fsp.stat(filePath);
  const name = path.basename(filePath);
  const mime = guessMime(filePath);
  const client = getAnthropicClient();
  const stream = createReadStream(filePath);
  // SDK accepts ReadStream as Uploadable.
  const meta = await client.beta.files.upload(
    { file: stream as unknown as Parameters<typeof client.beta.files.upload>[0]["file"] },
    { headers: { "anthropic-beta": FILES_BETA } },
  );
  return {
    fileId: meta.id,
    name: meta.filename ?? name,
    size: meta.size_bytes ?? stat.size,
    mime: meta.mime_type ?? mime,
  };
}

async function uploadBytesToSdk(
  name: string,
  mime: string,
  base64: string,
): Promise<UploadResult> {
  const buf = Buffer.from(base64, "base64");
  // Write to a tmp file under os.tmpdir() then stream — most portable path
  // through the SDK's Uploadable handling.
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clawdui-upload-"));
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, "_") || "pasted";
  const tmpPath = path.join(tmpDir, safeName);
  try {
    await fsp.writeFile(tmpPath, buf);
    const client = getAnthropicClient();
    const stream = createReadStream(tmpPath);
    const meta = await client.beta.files.upload(
      { file: stream as unknown as Parameters<typeof client.beta.files.upload>[0]["file"] },
      { headers: { "anthropic-beta": FILES_BETA } },
    );
    return {
      fileId: meta.id,
      name: meta.filename ?? safeName,
      size: meta.size_bytes ?? buf.length,
      mime: meta.mime_type ?? mime,
    };
  } finally {
    // best-effort cleanup
    void fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function deleteFileFromSdk(fileId: string): Promise<void> {
  const client = getAnthropicClient();
  // betas is a body/header param on this endpoint; default header is set on the client.
  await client.beta.files.delete(fileId);
}

/**
 * Convert an uploaded file into a user-message content block. Images use
 * `{type:'image', source:{type:'file', file_id}}`; PDFs use document blocks;
 * other types fall back to a text mention so the model still notices them.
 */
function fileToBlock(f: PendingFile): unknown {
  const isImage = /^image\//.test(f.mime);
  const isPdf = f.mime === "application/pdf";
  if (isImage) {
    return {
      type: "image",
      source: { type: "file", file_id: f.fileId },
    };
  }
  if (isPdf) {
    return {
      type: "document",
      source: { type: "file", file_id: f.fileId },
      title: f.name,
    };
  }
  // Fallback: mention by name + id; SDK still ingests the file via the API
  // attachment, but the model's user-visible block is text.
  return {
    type: "text",
    text: `[attached file: ${f.name} (${f.fileId})]`,
  };
}

/** All live sessions keyed by sessionKey ("master" | child id). */
const sessions = new Map<string, Session>();

/** Main session is always at the "master" key when present. */
function getMain(): Session | null {
  return sessions.get("master") ?? null;
}

/** Backward-compat shim: most existing handlers operate on the active main
 * session. Children are addressed explicitly via session_id where needed. */
function getActive(): Session | null {
  return getMain();
}

function nextChildId(): string {
  return `child_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ackOrError<T>(id: string, p: Promise<T>): void {
  p.then(() => emit({ id, type: "ack" })).catch((e) =>
    emit({ id, type: "error", error: e instanceof Error ? e.message : String(e) }),
  );
}

function resultOrError<T>(id: string, p: Promise<T>): void {
  p.then((v) => emit({ id, type: "result", value: v })).catch((e) =>
    emit({ id, type: "error", error: e instanceof Error ? e.message : String(e) }),
  );
}

function requireActive(id: string): Session | null {
  const a = getActive();
  if (!a) {
    emit({ id, type: "error", error: "no active session" });
    return null;
  }
  return a;
}

// ---------------------------------------------------------------------------
// User-configured shell hooks (settings.json)
// ---------------------------------------------------------------------------
//
// Claude Code lets users register shell-command hooks in settings.json under
// keys like PreToolUse / PostToolUse / SessionStart / UserPromptSubmit / Stop /
// SubagentStop. Each entry has a matcher (tool-name regex, or "*" / empty for
// any) and one-or-more commands run with the hook JSON piped to stdin. Exit
// code 2 = block. We register an SDK HookCallback per event in Session and
// fan out to the user-configured shell commands here.

type SettingsHook = { type?: string; command: string; timeout?: number };
type SettingsHookMatcher = { matcher?: string; hooks: SettingsHook[] };
type SettingsHooks = Partial<Record<HookEvent, SettingsHookMatcher[]>>;

const HOOK_EVENTS_WIRED: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SubagentStop",
];

/** cwd -> merged hooks config */
const hooksCache = new Map<string, SettingsHooks>();

function readJsonSafe(p: string): unknown {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractSettingsHooks(parsed: unknown): SettingsHooks {
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
    if (matchers.length > 0) (out as Record<string, SettingsHookMatcher[]>)[event] = matchers;
  }
  return out;
}

function loadHooksForCwd(cwd: string): SettingsHooks {
  const merged: SettingsHooks = {};
  const sources = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];
  for (const src of sources) {
    const parsed = readJsonSafe(src);
    const h = extractSettingsHooks(parsed);
    for (const [event, matchers] of Object.entries(h)) {
      const k = event as HookEvent;
      const existing = merged[k] ?? [];
      merged[k] = [...existing, ...matchers];
    }
  }
  return merged;
}

function getHooksFor(cwd: string): SettingsHooks {
  const key = cwd || process.cwd();
  let cached = hooksCache.get(key);
  if (!cached) {
    cached = loadHooksForCwd(key);
    hooksCache.set(key, cached);
  }
  return cached;
}

function matcherMatches(matcher: string | undefined, toolName: string | undefined): boolean {
  // Per Claude Code docs: matcher is a regex/string against tool_name for
  // PreToolUse/PostToolUse. For other events (SessionStart, Stop, etc.) the
  // matcher is typically absent or "*". Treat undefined / empty / "*" as
  // "match everything".
  if (!matcher || matcher === "*") return true;
  if (!toolName) return false;
  if (matcher === toolName) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

type UserHookExecResult = { exitCode: number; stdout: string; stderr: string; durationMs: number };

function runOneUserHook(
  cmd: string,
  cwd: string,
  inputJson: string,
  timeoutMs: number,
): Promise<UserHookExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(shell, args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, CLAUDE_HOOK_EVENT: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - started,
      });
      return;
    }
    const done = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started });
    };
    const cap = (s: string, max: number) => (s.length > max ? s.slice(0, max) + "\n…[truncated]" : s);
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
      if (stdout.length > 64_000) stdout = cap(stdout, 64_000);
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
      if (stderr.length > 64_000) stderr = cap(stderr, 64_000);
    });
    child.on("error", (err) => {
      stderr += `\n${err instanceof Error ? err.message : String(err)}`;
      done(-1);
    });
    child.on("close", (code) => done(typeof code === "number" ? code : -1));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      stderr += `\n[timeout after ${timeoutMs}ms]`;
      done(-1);
    }, timeoutMs);
    try {
      child.stdin?.end(inputJson);
    } catch {
      /* ignore */
    }
  });
}

/**
 * Run all matching user-configured shell hooks for a given SDK hook event,
 * emit one `hook-event` per execution, and aggregate into an SDK
 * HookJSONOutput. If any hook exits with code 2, returns
 * `{continue:false, stopReason:<stderr>}` to signal a block to the SDK.
 */
async function runUserHooks(
  emitId: string,
  event: HookEvent,
  cwd: string,
  input: HookInput,
): Promise<HookJSONOutput> {
  const matchers = getHooksFor(cwd)[event] ?? [];
  if (matchers.length === 0) return { continue: true };
  const toolName = (input as { tool_name?: string }).tool_name;
  const payload = JSON.stringify(input);
  let blocked = false;
  let blockReason = "";
  for (const m of matchers) {
    if (!matcherMatches(m.matcher, toolName)) continue;
    for (const h of m.hooks) {
      const timeoutMs = Math.min(
        typeof h.timeout === "number" && h.timeout > 0 ? h.timeout * 1000 : 30_000,
        5 * 60 * 1000,
      );
      const res = await runOneUserHook(h.command, cwd, payload, timeoutMs);
      emit({
        id: emitId,
        type: "hook-event",
        event,
        matcher: m.matcher,
        command: h.command,
        ts: Date.now(),
        exitCode: res.exitCode,
        output: res.stdout || res.stderr,
        cwd,
        durationMs: res.durationMs,
      });
      if (res.exitCode === 2) {
        blocked = true;
        blockReason = (res.stderr || res.stdout || "blocked by user hook").trim();
      }
    }
  }
  if (blocked) {
    return { continue: false, stopReason: blockReason, decision: "block", reason: blockReason };
  }
  return { continue: true };
}

/**
 * Build an SDK HookCallback for a given event that delegates to the user's
 * configured shell hooks and emits `hook-event` telemetry to the UI.
 */
function makeSdkHookCallback(emitId: string, event: HookEvent, cwd: string): HookCallback {
  return async (input) => runUserHooks(emitId, event, cwd, input);
}

/**
 * Build the SDK `Options.hooks` map for a Session by registering one matcher
 * per wired event. We use a single matcher with no `matcher` field so the SDK
 * always calls us; per-hook matcher filtering happens inside runUserHooks.
 */
function buildSdkHooksOption(
  emitId: string,
  cwd: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const ev of HOOK_EVENTS_WIRED) {
    out[ev] = [{ hooks: [makeSdkHookCallback(emitId, ev, cwd)] }];
  }
  return out;
}

/** Merge two SDK hooks maps without losing user-supplied callbacks. */
function mergeSdkHooks(
  a: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
  b: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  const keys = new Set<HookEvent>([
    ...((Object.keys(a ?? {}) as HookEvent[])),
    ...((Object.keys(b) as HookEvent[])),
  ]);
  for (const k of keys) {
    out[k] = [...((a?.[k] ?? [])), ...((b[k] ?? []))];
  }
  return out;
}

function runHookTest(req: {
  id: string;
  command: string;
  env?: Record<string, string>;
  timeout?: number;
}): void {
  const id = req.id;
  const command = (req.command ?? "").trim();
  if (!command) {
    emit({ id, type: "hook_test_result", error: "empty command", exit: -1 });
    return;
  }
  const timeoutMs =
    typeof req.timeout === "number" && req.timeout > 0
      ? Math.min(req.timeout * 1000, 5 * 60 * 1000)
      : 30 * 1000;
  const childEnv = { ...process.env, ...(req.env ?? {}) };
  let stdout = "";
  let stderr = "";
  let settled = false;

  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

  const child = spawn(shell, args, {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const cap = (s: string, max: number) => (s.length > max ? s.slice(0, max) + "\n…[truncated]" : s);

  child.stdout.on("data", (b: Buffer) => {
    stdout += b.toString("utf8");
  });
  child.stderr.on("data", (b: Buffer) => {
    stderr += b.toString("utf8");
  });

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    emit({
      id,
      type: "hook_test_result",
      stdout: cap(stdout, 16_000),
      stderr: cap(stderr, 16_000),
      error: `timeout after ${timeoutMs}ms`,
      exit: -1,
    });
  }, timeoutMs);

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    emit({
      id,
      type: "hook_test_result",
      stdout: cap(stdout, 16_000),
      stderr: cap(stderr, 16_000),
      error: err instanceof Error ? err.message : String(err),
      exit: -1,
    });
  });

  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    emit({
      id,
      type: "hook_test_result",
      stdout: cap(stdout, 16_000),
      stderr: cap(stderr, 16_000),
      exit: typeof code === "number" ? code : -1,
    });
  });
}

// ---------------------------------------------------------------------------
// Claude CLI subcommands (auth / setup-token / doctor / update / ultrareview)
// ---------------------------------------------------------------------------

const CLI_BUFFER_CAP = 64 * 1024; // 64 KB per stream
// `resolveClaudeBinary` / `searchedClaudePaths` live in ./resolveBinary.ts so
// headless mode (sidecar/headless.ts) can reuse the same resolution logic.

const activeChildren = new Map<string, ChildProcess>();

function clampBuffer(s: string): string {
  if (s.length <= CLI_BUFFER_CAP) return s;
  return s.slice(0, CLI_BUFFER_CAP) + "\n…[truncated]";
}

type RunOpts = {
  id: string;
  args: string[];
  stream: boolean;
  timeoutMs?: number;
  parseResult?: (stdout: string, stderr: string, exit: number | null) => unknown;
};

async function runClaudeCli(opts: RunOpts): Promise<void> {
  const bin = await resolveClaudeBinary();
  if (!bin) {
    emit({
      id: opts.id,
      type: "error",
      error: `claude binary not found. Searched: which claude, ${searchedClaudePaths().join(
        ", ",
      )}. Install with: npm install -g @anthropic-ai/claude-code`,
    });
    return;
  }

  let stdout = "";
  let stderr = "";
  let settled = false;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  const child = spawn(bin, opts.args, {
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.set(opts.id, child);

  const finish = (
    ok: boolean,
    exit: number | null,
    error?: string,
    value?: unknown,
  ) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    activeChildren.delete(opts.id);
    if (opts.stream) {
      emit({
        id: opts.id,
        type: "cli_done",
        ok,
        exit,
        stdout: clampBuffer(stdout),
        stderr: clampBuffer(stderr),
        ...(value !== undefined ? { value } : {}),
        ...(error ? { error } : {}),
      });
    } else {
      if (!ok) {
        emit({
          id: opts.id,
          type: "error",
          error: error ?? `claude exited with code ${exit ?? "unknown"}`,
        });
      } else {
        emit({
          id: opts.id,
          type: "result",
          value:
            value !== undefined
              ? value
              : { exit, stdout: clampBuffer(stdout), stderr: clampBuffer(stderr) },
        });
      }
    }
  };

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    finish(false, null, `claude command timed out after ${timeoutMs}ms`);
  }, timeoutMs);

  child.stdout.on("data", (b: Buffer) => {
    const chunk = b.toString("utf8");
    if (stdout.length < CLI_BUFFER_CAP) stdout += chunk;
    if (opts.stream) {
      emit({ id: opts.id, type: "cli_progress", stream: "stdout", chunk });
    }
  });
  child.stderr.on("data", (b: Buffer) => {
    const chunk = b.toString("utf8");
    if (stderr.length < CLI_BUFFER_CAP) stderr += chunk;
    if (opts.stream) {
      emit({ id: opts.id, type: "cli_progress", stream: "stderr", chunk });
    }
  });
  child.on("error", (err) => {
    finish(false, null, err instanceof Error ? err.message : String(err));
  });
  child.on("close", (code) => {
    const exit = typeof code === "number" ? code : null;
    let parsed: unknown;
    let parseErr: string | undefined;
    if (opts.parseResult) {
      try {
        parsed = opts.parseResult(stdout, stderr, exit);
      } catch (e) {
        parseErr = e instanceof Error ? e.message : String(e);
      }
    }
    finish(exit === 0, exit, parseErr, parsed);
  });
}

function abortCli(targetId: string): boolean {
  const child = activeChildren.get(targetId);
  if (!child) return false;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  // SIGKILL fallback after 2s
  setTimeout(() => {
    if (activeChildren.has(targetId)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }, 2000);
  return true;
}

function parseDoctorOutput(stdout: string, stderr: string): {
  raw: string;
  items: { name: string; ok: boolean; detail?: string }[];
} {
  const raw = stdout || stderr;
  const items: { name: string; ok: boolean; detail?: string }[] = [];
  // strip ANSI just in case (FORCE_COLOR=0/NO_COLOR=1 set, but be safe)
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/\[[0-9;]*m/g, "");
  const lines = stripped.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // common patterns: "✓ Auto-updater: enabled", "✗ Foo: bar", "[OK] ...", "[FAIL] ..."
    const m =
      line.match(/^([✓✗✔✘×!⚠])\s*(.*)$/) ??
      line.match(/^\[(OK|FAIL|WARN|ERROR|PASS)\]\s*(.*)$/i);
    if (m) {
      const sym = m[1];
      const rest = m[2];
      const ok =
        sym === "✓" ||
        sym === "✔" ||
        /^OK$/i.test(sym) ||
        /^PASS$/i.test(sym);
      const colon = rest.indexOf(":");
      const name = colon >= 0 ? rest.slice(0, colon).trim() : rest.trim();
      const detail = colon >= 0 ? rest.slice(colon + 1).trim() : undefined;
      if (name) items.push({ name, ok, detail });
    }
  }
  return { raw: stripped, items };
}

function parseUpdateCheck(stdout: string, stderr: string): {
  current: string | null;
  latest: string | null;
  available: boolean;
  raw: string;
} {
  const raw = (stdout || stderr).replace(/\[[0-9;]*m/g, "");
  // heuristic regexes, e.g. "Current version: 2.1.123" / "Latest version: 2.1.150"
  const cur = raw.match(/current\s*version[:\s]+([\d.\w-]+)/i);
  const lat = raw.match(/latest\s*version[:\s]+([\d.\w-]+)/i);
  const upToDate = /up.to.date|already.+latest/i.test(raw);
  const available =
    /update available|new version|installing/i.test(raw) ||
    (cur && lat && cur[1] !== lat[1])
      ? true
      : false;
  return {
    current: cur ? cur[1] : null,
    latest: lat ? lat[1] : null,
    available: !upToDate && available,
    raw,
  };
}

function handleCliCommand(req: InboundMessage): boolean {
  switch (req.type) {
    case "claude_path": {
      void resolveClaudeBinary().then((p) => {
        emit({
          id: req.id,
          type: "result",
          value: { path: p, searched: searchedClaudePaths() },
        });
        // Also broadcast as cli_status so any subscriber (frontend system
        // status store) stays in sync without re-issuing the request.
        emit({
          id: "sys",
          type: "cli_status",
          path: p,
          searched: searchedClaudePaths(),
        });
      });
      return true;
    }
    case "auth_status": {
      void runClaudeCli({
        id: req.id,
        args: ["auth", "status", "--json"],
        stream: false,
        timeoutMs: 30_000,
        parseResult: (stdout, stderr, _exit) => {
          // try JSON first
          const text = (stdout || stderr).trim();
          try {
            const parsed = JSON.parse(text);
            return { json: parsed, raw: text };
          } catch {
            return { json: null, raw: text };
          }
        },
      });
      return true;
    }
    case "auth_login": {
      void runClaudeCli({
        id: req.id,
        args: ["auth", "login"],
        stream: true,
        timeoutMs: 10 * 60 * 1000,
      });
      return true;
    }
    case "auth_logout": {
      void runClaudeCli({
        id: req.id,
        args: ["auth", "logout"],
        stream: false,
        timeoutMs: 30_000,
      });
      return true;
    }
    case "setup_token": {
      void runClaudeCli({
        id: req.id,
        args: ["setup-token"],
        stream: true,
        timeoutMs: 10 * 60 * 1000,
      });
      return true;
    }
    case "doctor_run": {
      void runClaudeCli({
        id: req.id,
        args: ["doctor"],
        stream: true,
        timeoutMs: 2 * 60 * 1000,
        parseResult: (stdout, stderr) => parseDoctorOutput(stdout, stderr),
      });
      return true;
    }
    case "update_check": {
      // `claude update` does not document a --check flag; running it
      // performs a check and installs if available. We honor the documented
      // surface by invoking `update`; the caller treats the result as
      // current/latest/available info parsed from output.
      void runClaudeCli({
        id: req.id,
        args: ["update"],
        stream: true,
        timeoutMs: 5 * 60 * 1000,
        parseResult: (stdout, stderr) => parseUpdateCheck(stdout, stderr),
      });
      return true;
    }
    case "update_apply": {
      void runClaudeCli({
        id: req.id,
        args: ["update"],
        stream: true,
        timeoutMs: 10 * 60 * 1000,
      });
      return true;
    }
    case "ultrareview_run": {
      const args = ["ultrareview"];
      if (req.target && req.target.trim()) args.push(req.target.trim());
      void runClaudeCli({
        id: req.id,
        args,
        stream: true,
        timeoutMs: 35 * 60 * 1000,
      });
      return true;
    }
    case "cli_abort": {
      const ok = abortCli(req.target_id);
      emit({ id: req.id, type: "result", value: { ok } });
      return true;
    }
    default:
      return false;
  }
}

async function handle(req: InboundMessage): Promise<void> {
  // [DIAG] inbound RPC trace — keep until session-resume flow stabilized.
  try {
    console.error(
      `[DIAG-IN] id=${req.id} type=${req.type} ${JSON.stringify(req).slice(0, 300)}`,
    );
  } catch {
    /* never let diag break dispatch */
  }
  if (handleCliCommand(req)) return;
  switch (req.type) {
    case "ping":
      emit({ id: req.id, type: "pong" });
      return;

    case "start_session": {
      // [DIAG] log full option shape on resume path so we can correlate
      // "Previous session no longer exists" with what the SDK actually saw.
      try {
        const o = (req.options ?? {}) as Record<string, unknown>;
        console.error(
          `[DIAG] start_session entry cwd=${o.cwd} resume=${o.resume} continue=${o.continue} forkSession=${o.forkSession} sessionId=${o.sessionId}`,
        );
      } catch {
        /* swallow */
      }
      if (getMain()) {
        console.error("[DIAG] start_session rejected — getMain() already set");
        emit({ id: req.id, type: "error", error: "session already active" });
        return;
      }
      // When the sidecar is bundled (esbuild produces a single dist/index.js),
      // @anthropic-ai/claude-agent-sdk loses its dynamic require resolution
      // for the platform-specific Native CLI binary it ships under
      // node_modules/@anthropic-ai/claude-agent-sdk/cli-<platform>-<arch>.
      // Forward the locally-installed `claude` binary via
      // `pathToClaudeCodeExecutable` so the SDK never resolves its own bundled
      // fallback.
      const opts: Options = { ...(req.options ?? {}) };
      // Cross-bucket resume: when the caller passes `resume: <id>`, the SDK
      // looks up the jsonl in `~/.claude/projects/<sanitizeCwd(opts.cwd)>/`.
      // If the UI is currently focused on a different workspace cwd (e.g.
      // the user opened `worktrees/` but the session was recorded inside
      // `worktrees/<branch>/`), the SDK opens the WRONG bucket and emits
      // "No conversation found with session id …" → the frontend then shows
      // "Previous session no longer exists — starting fresh." and the new
      // session never connects.
      //
      // Resolve this sidecar-side by scanning the candidate buckets for the
      // requested session id, then patching `opts.cwd` to the cwd recorded
      // on the session's first event. Pure data lookup — no control-flow
      // change, no mutex.
      try {
        const resumeId = (opts as { resume?: unknown }).resume;
        const optCwd = (opts as { cwd?: unknown }).cwd;
        if (
          typeof resumeId === "string" &&
          resumeId.length > 0 &&
          typeof optCwd === "string" &&
          optCwd.length > 0
        ) {
          const bucket = findSessionBucket(optCwd, resumeId);
          const jsonl = path.join(bucket, `${resumeId}.jsonl`);
          if (fs.existsSync(jsonl)) {
            // Read first non-empty line → grab `cwd` field. Streaming is
            // overkill here; first lines are small.
            const head = fs.readFileSync(jsonl, "utf8").split(/\r?\n/, 5);
            let canonicalCwd: string | undefined;
            for (const line of head) {
              if (!line) continue;
              const obj = safeParse(line);
              if (obj && typeof obj.cwd === "string" && obj.cwd) {
                canonicalCwd = obj.cwd;
                break;
              }
            }
            if (canonicalCwd && canonicalCwd !== optCwd) {
              console.error(
                `[DIAG] start_session resume cwd override: ${optCwd} -> ${canonicalCwd} (session ${resumeId})`,
              );
              (opts as { cwd?: string }).cwd = canonicalCwd;
            } else {
              console.error(
                `[DIAG] start_session resume cwd OK (bucket=${bucket}, cwd=${optCwd})`,
              );
            }
          } else {
            console.error(
              `[DIAG] start_session resume: jsonl not found in any bucket for id=${resumeId} (workspace cwd=${optCwd})`,
            );
          }
        }
      } catch (e) {
        console.error(
          `[DIAG] start_session resume cwd patch threw: ${(e as Error).message}`,
        );
      }
      // Validate workspace cwd BEFORE the SDK spawns. posix_spawn returns
      // ENOENT for a missing chdir target but Node attributes the error to
      // the command path, so the SDK then mis-reports it as a missing binary.
      // Catch it here and emit a clear, actionable error instead.
      const cwdErr = validateCwd((opts as { cwd?: unknown }).cwd);
      if (cwdErr) {
        emit({
          id: req.id,
          type: "error",
          error: `cannot start session — ${cwdErr}. Pick a folder that exists in the workspace picker (left rail).`,
        });
        return;
      }
      if (!(opts as any).pathToClaudeCodeExecutable) {
        const claude = await resolveClaudeBinary();
        if (claude) {
          // Diagnostic probe: spawn the resolved `claude` binary directly with
          // the SAME cwd and env that the SDK will use, so any OS-level spawn
          // failure (ENOENT/EACCES/EPERM/ENOTSUP) leaves a structured trace
          // in sidecar.log BEFORE the SDK swallows err.code/errno/syscall and
          // surfaces a generic "Claude Code native binary not found" string.
          // Failure of the probe MUST NOT block the real session.
          try {
            const probeEnv: Record<string, string> = {
              ...(process.env as Record<string, string>),
            };
            delete probeEnv.NODE_OPTIONS;
            const probeCwd =
              (opts as { cwd?: string }).cwd ?? process.cwd();
            const envKeys = Object.keys(probeEnv).sort().join(",");
            logProbe(`cwd=${probeCwd}`);
            logProbe(`env_keys=${envKeys}`);
            logProbe(`path=${claude}`);
            await new Promise<void>((resolve) => {
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                resolve();
              };
              let child: ChildProcess;
              try {
                child = spawn(claude, ["--version"], {
                  cwd: probeCwd,
                  env: probeEnv,
                  stdio: ["ignore", "pipe", "pipe"],
                });
              } catch (e) {
                const err = e as NodeJS.ErrnoException;
                logProbe(
                  `code=${err.code} errno=${err.errno} syscall=${err.syscall} path=${err.path} message=${err.message}`,
                );
                done();
                return;
              }
              let outLen = 0;
              let errBuf = "";
              child.stdout?.on("data", (b: Buffer) => {
                outLen += b.length;
              });
              child.stderr?.on("data", (b: Buffer) => {
                errBuf += b.toString("utf8");
                if (errBuf.length > 4096) {
                  errBuf = errBuf.slice(errBuf.length - 4096);
                }
              });
              child.on("error", (e) => {
                const err = e as NodeJS.ErrnoException;
                logProbe(
                  `code=${err.code} errno=${err.errno} syscall=${err.syscall} path=${err.path} message=${err.message}`,
                );
                done();
              });
              child.on("exit", (code, sig) => {
                const tail = errBuf.slice(-200).replace(/\n/g, "\\n");
                logProbe(
                  `exit code=${code} sig=${sig} stdoutLen=${outLen} stderrTail=${tail}`,
                );
                done();
              });
              const t = setTimeout(() => {
                if (settled) return;
                try {
                  child.kill("SIGKILL");
                } catch {
                  // ignore
                }
                logProbe(`timeout after 2000ms — killed child`);
                done();
              }, 2000);
              // Ensure timeout doesn't keep the event loop alive.
              if (typeof t.unref === "function") t.unref();
            });
          } catch (e) {
            // Probe must NEVER block the real session.
            logProbe(`probe threw: ${(e as Error).message}`);
          }
          (opts as any).pathToClaudeCodeExecutable = claude;
        } else {
          emit({
            id: req.id,
            type: "error",
            error: `claude binary not found. Searched: which claude, ${searchedClaudePaths().join(
              ", ",
            )}. Install Claude Code (https://docs.claude.com/en/docs/claude-code/quickstart) and retry.`,
          });
          return;
        }
      }
      // Forward the Claude OAuth access token from the OS keystore to the
      // spawned `claude` CLI subprocess. Tauri-launched ancestry has no
      // keychain ACL grant, so the CLI's own keychain lookup fails and it
      // emits "Not logged in". The sidecar (this process) DOES have the ACL
      // because its ancestry was Terminal-initiated when the user first
      // granted access. Read here and forward via env to sidestep the
      // broken child-side lookup. The CLI prefers CLAUDE_CODE_OAUTH_TOKEN
      // env over its own keystore read.
      //
      // IMPORTANT: the SDK uses `options.env` AS-IS for the spawned CLI
      // (default `{...process.env}` only applies when env is undefined).
      // We therefore MUST spread `process.env` ourselves — otherwise the
      // CLI subprocess loses PATH, HOME, etc. and degrades to the same
      // "Not logged in" surface even though the token was forwarded.
      // NEVER log the token value.
      try {
        const token = await getClaudeAccessToken();
        if (token) {
          const envOverride = (opts as { env?: Record<string, string> }).env;
          (opts as { env?: Record<string, string> }).env = {
            ...(process.env as Record<string, string>),
            ...(envOverride ?? {}),
            CLAUDE_CODE_OAUTH_TOKEN: token,
          };
        }
      } catch {
        // Non-fatal: fall through to existing "Not logged in" surface.
      }
      // Refresh user hook config from ~/.claude + project .claude on each
      // session start so settings.json edits don't require a sidecar restart.
      const hookCwd = ((opts as { cwd?: string }).cwd ?? process.cwd()) as string;
      hooksCache.delete(hookCwd);
      const sdkHooks = buildSdkHooksOption(req.id, hookCwd);
      const existingHooks = (opts as { hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>> })
        .hooks;
      (opts as { hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>> }).hooks = mergeSdkHooks(
        existingHooks,
        sdkHooks,
      );
      const s = new Session(req.id, opts, "master", null);
      sessions.set("master", s);
      emit({ id: req.id, type: "session_started", session_id: "master" });
      return;
    }

    case "spawn_child": {
      const parentKey = (req.parent_id ?? "master").trim() || "master";
      const parent = sessions.get(parentKey);
      if (!parent) {
        emit({
          id: req.id,
          type: "error",
          error: `unknown parent session: ${parentKey}`,
        });
        return;
      }
      // Children inherit parent options unless overridden.
      const childOpts: Options = {
        ...parent.options,
        ...(req.options ?? {}),
      };
      // canUseTool is bound per-Session; let the constructor rewire it.
      delete (childOpts as { canUseTool?: unknown }).canUseTool;
      // Validate workspace cwd before the SDK spawn — same rationale as
      // start_session: an ENOENT chdir surfaces as a misleading "binary not
      // found" string through the SDK.
      const childCwdErr = validateCwd(
        (childOpts as { cwd?: unknown }).cwd,
      );
      if (childCwdErr) {
        emit({
          id: req.id,
          type: "error",
          error: `cannot spawn child — ${childCwdErr}. Pick a folder that exists in the workspace picker (left rail).`,
        });
        return;
      }
      const childKey = nextChildId();
      const childCwd = ((childOpts as { cwd?: string }).cwd ?? process.cwd()) as string;
      const childSdkHooks = buildSdkHooksOption(req.id, childCwd);
      const childExistingHooks = (
        childOpts as { hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>> }
      ).hooks;
      (childOpts as { hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>> }).hooks =
        mergeSdkHooks(childExistingHooks, childSdkHooks);
      const child = new Session(req.id, childOpts, childKey, parentKey);
      sessions.set(childKey, child);
      // Seed the child with the prompt.
      child.send(req.prompt);
      // Return the child id immediately; child_done event will follow when query() finishes.
      emit({
        id: req.id,
        type: "result",
        value: { child_id: childKey, parent_id: parentKey },
        session_id: childKey,
      });
      return;
    }

    case "child_status": {
      const s = sessions.get(req.session_id);
      if (!s) {
        emit({
          id: req.id,
          type: "error",
          error: `unknown session: ${req.session_id}`,
        });
        return;
      }
      emit({
        id: req.id,
        type: "child_status_result",
        session_id: s.sessionKey,
        alive: s.alive,
        last_event_at: s.lastEventAt,
        message_count: s.messageCount,
        total_cost_usd: s.totalCostUsd,
      });
      return;
    }

    case "cancel_child": {
      // Cancel target hierarchy:
      //   1. If session_id maps to a sidecar-managed child Session → interrupt
      //      its SDK query and end the message queue. The consume() loop will
      //      exit naturally, emit child_done, and the agents store flips to
      //      done/error via the existing handler.
      //   2. If no matching Session exists (SDK Agent/Task tool runs inside
      //      master's stream and has no dedicated Session), fall back to
      //      interrupting the master session. The master's in-flight Task
      //      tool returns control to the loop, which is the only signal we
      //      can send for SDK-managed sub-agents.
      const target = sessions.get(req.session_id);
      if (target && target.parentKey) {
        // child Session — interrupt the SDK query, then end the queue so the
        // consume() loop terminates promptly. interrupt() is async; chain end
        // after it resolves so we don't drop a frame mid-tool-call.
        const p = target.query
          .interrupt()
          .catch((e) => {
            // The SDK throws if there's nothing to interrupt; tolerate.
            console.error("[sidecar] cancel_child interrupt failed", e);
          })
          .then(() => {
            try {
              target.end();
            } catch (e) {
              console.error("[sidecar] cancel_child end failed", e);
            }
          });
        ackOrError(req.id, p);
        return;
      }
      // No dedicated child session — best effort: interrupt master so any
      // in-flight SDK Agent/Task tool returns control.
      const master = sessions.get("master");
      if (!master) {
        emit({
          id: req.id,
          type: "error",
          error: `no session to cancel for id: ${req.session_id}`,
        });
        return;
      }
      ackOrError(req.id, master.query.interrupt());
      return;
    }

    case "send_message": {
      const s = requireActive(req.id);
      if (!s) return;
      s.send(req.content);
      emit({ id: req.id, type: "ack" });
      return;
    }

    case "interrupt": {
      const s = requireActive(req.id);
      if (!s) return;
      ackOrError(req.id, s.query.interrupt());
      return;
    }

    case "set_permission_mode": {
      const s = requireActive(req.id);
      if (!s) return;
      ackOrError(req.id, s.query.setPermissionMode(req.mode));
      return;
    }

    case "set_model": {
      const s = requireActive(req.id);
      if (!s) return;
      ackOrError(req.id, s.query.setModel(req.model));
      return;
    }

    case "set_max_thinking_tokens": {
      const s = requireActive(req.id);
      if (!s) return;
      ackOrError(req.id, s.query.setMaxThinkingTokens(req.value));
      return;
    }

    case "supported_models": {
      const s = requireActive(req.id);
      if (!s) return;
      resultOrError(req.id, s.query.supportedModels());
      return;
    }

    case "supported_commands": {
      const s = requireActive(req.id);
      if (!s) return;
      resultOrError(req.id, s.query.supportedCommands());
      return;
    }

    case "mcp_status": {
      const s = requireActive(req.id);
      if (!s) return;
      resultOrError(req.id, s.query.mcpServerStatus());
      return;
    }

    case "account_info": {
      const s = requireActive(req.id);
      if (!s) return;
      resultOrError(req.id, s.query.accountInfo());
      return;
    }

    case "permission_response": {
      const s = requireActive(req.id);
      if (!s) return;
      const ok = s.resolvePermission(req.request_id, req.decision);
      if (!ok) {
        emit({
          id: req.id,
          type: "error",
          error: `unknown permission request_id: ${req.request_id}`,
        });
        return;
      }
      emit({ id: req.id, type: "ack" });
      return;
    }

    case "list_skills": {
      try {
        const skills = listSkills(req.pluginDirs ?? [], req.cwd);
        emit({ id: req.id, type: "result", value: skills });
      } catch (e) {
        emit({
          id: req.id,
          type: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    case "list_plugins": {
      try {
        const result = (req.paths ?? []).map(inspectPlugin);
        emit({ id: req.id, type: "result", value: result });
      } catch (e) {
        emit({
          id: req.id,
          type: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    case "discover_plugins": {
      try {
        emit({ id: req.id, type: "result", value: discoverPluginsRoot() });
      } catch (e) {
        emit({
          id: req.id,
          type: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    case "mcp_test": {
      resultOrError(req.id, testMcpServer(req.name, req.config));
      return;
    }

    case "hook_test_run": {
      runHookTest(req);
      return;
    }

    case "hooks_reload": {
      if (req.cwd && req.cwd.trim()) {
        hooksCache.delete(req.cwd);
      } else {
        hooksCache.clear();
      }
      emit({ id: req.id, type: "ack" });
      return;
    }

    case "end_session": {
      const s = requireActive(req.id);
      if (!s) return;
      // End master + all children.
      for (const [, sess] of sessions) sess.end();
      sessions.clear();
      emit({ id: req.id, type: "session_ended", session_id: "master" });
      return;
    }

    case "list_sessions": {
      console.error(`[DIAG] list_sessions cwd=${req.cwd}`);
      resultOrError(
        req.id,
        listSessions(req.cwd).then((list) => {
          console.error(
            `[DIAG] list_sessions returned ${list.length} entries for cwd=${req.cwd}`,
          );
          return list;
        }),
      );
      return;
    }

    case "read_session": {
      resultOrError(req.id, readSession(req.cwd, req.session_id));
      return;
    }

    case "fetch_session_window": {
      resultOrError(
        req.id,
        fetchSessionWindow(req.cwd, req.session_id, req.before_seq, req.limit),
      );
      return;
    }

    case "delete_session": {
      resultOrError(req.id, deleteSession(req.cwd, req.session_id));
      return;
    }

    case "write_file": {
      resultOrError(req.id, writeFile(req.path, req.content));
      return;
    }

    case "git_branch": {
      resultOrError(req.id, gitBranch(req.cwd));
      return;
    }

    case "git_status": {
      resultOrError(req.id, gitStatus(req.cwd));
      return;
    }

    case "git_commit": {
      resultOrError(
        req.id,
        gitCommit({
          cwd: req.cwd,
          message: req.message,
          subject: req.subject,
          body: req.body,
          files: req.files,
          paths: req.paths,
          signoff: req.signoff,
        }),
      );
      return;
    }

    case "upload_file": {
      resultOrError(req.id, uploadFileToSdk(req.path));
      return;
    }

    case "upload_bytes": {
      resultOrError(
        req.id,
        uploadBytesToSdk(req.name, req.mime ?? "application/octet-stream", req.base64),
      );
      return;
    }

    case "attach_files_to_next_message": {
      const s = requireActive(req.id);
      if (!s) return;
      const files = Array.isArray(req.files) ? req.files : [];
      const existing = new Set(s.pendingFiles.map((p) => p.fileId));
      for (const f of files) {
        if (!f || !f.fileId || existing.has(f.fileId)) continue;
        s.pendingFiles.push({
          fileId: f.fileId,
          mime: f.mime ?? "application/octet-stream",
          name: f.name ?? f.fileId,
        });
        existing.add(f.fileId);
      }
      emit({ id: req.id, type: "ack" });
      return;
    }

    case "discard_file": {
      // best-effort delete; ignore failures (file may have been GC'd already).
      resultOrError(
        req.id,
        deleteFileFromSdk(req.fileId).then(
          () => ({ ok: true }),
          (e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        ),
      );
      return;
    }

    case "list_pull_requests": {
      resultOrError(
        req.id,
        listPullRequests({
          cwd: req.cwd,
          remoteType: req.remoteType,
          hostBaseUrl: req.hostBaseUrl,
          token: req.token,
        }),
      );
      return;
    }

    case "format_pr_context": {
      resultOrError(
        req.id,
        formatPrContext({
          cwd: req.cwd,
          remoteType: req.remoteType,
          hostBaseUrl: req.hostBaseUrl,
          token: req.token,
          prNumber: req.prNumber,
          prTitle: req.prTitle,
          prBranch: req.prBranch,
          prBody: req.prBody,
        }),
      );
      return;
    }

    case "fetch_pr_by_url": {
      resultOrError(
        req.id,
        fetchPrByUrl({
          provider: req.provider,
          host: req.host,
          hostBaseUrl: req.hostBaseUrl,
          owner: req.owner,
          repo: req.repo,
          prNumber: req.prNumber,
          token: req.token,
        }),
      );
      return;
    }

    case "checkout_pr_branch": {
      resultOrError(
        req.id,
        checkoutPrBranch({
          chosenFolder: req.chosenFolder,
          provider: req.provider,
          prNumber: req.prNumber,
          branch: req.branch,
          cloneUrl: req.cloneUrl,
          sshUrl: req.sshUrl,
          repoName: req.repoName,
          baseBranch: req.baseBranch,
        }),
      );
      return;
    }

    case "create_worktree": {
      resultOrError(
        req.id,
        createWorktree(
          req.baseRepoPath,
          req.branch,
          req.baseBranch && req.baseBranch.trim() ? req.baseBranch : "main",
        ),
      );
      return;
    }

    case "list_worktrees": {
      resultOrError(req.id, listWorktrees(req.baseRepoPath));
      return;
    }

    case "git_init": {
      resultOrError(req.id, gitInit(req.path));
      return;
    }

    case "set_remote_control": {
      try {
        configureRelay(req);
        emit({ id: req.id, type: "ack" });
        emitRelayState();
      } catch (e) {
        emit({
          id: req.id,
          type: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    case "remote_control_status": {
      emitRelayState();
      emit({ id: req.id, type: "ack" });
      return;
    }

    case "pair_mobile": {
      // Send the `/remote-control` slash command into the active session.
      // The CLI emits a claude.ai pairing URL as assistant text; the URL
      // scanner re-emits it as a `mobile_pair_url` event.
      const s = req.session_id
        ? sessions.get(req.session_id)
        : getActive();
      if (!s) {
        emit({
          id: req.id,
          type: "error",
          error: "no active session for pair_mobile",
        });
        return;
      }
      s.pairingActive = true;
      try {
        s.send("/remote-control");
        emit({ id: req.id, type: "ack", session_id: s.sessionKey });
      } catch (e) {
        s.pairingActive = false;
        emit({
          id: req.id,
          type: "error",
          error: e instanceof Error ? e.message : String(e),
          session_id: s.sessionKey,
        });
      }
      return;
    }

    case "connect_remote_control_direct": {
      await handleConnectRemoteControlDirect(req);
      return;
    }
  }
}

async function handleConnectRemoteControlDirect(req: {
  id: string;
  type: "connect_remote_control_direct";
  org_uuid: string;
  base_url?: string;
}): Promise<void> {
  const orgUuid = (req.org_uuid ?? "").trim();
  const baseUrl = (req.base_url ?? "https://api.claude.ai").trim();

  if (!orgUuid) {
    emit({
      id: req.id,
      type: "mobile_pair_error",
      session_id: "master",
      error: "claudeOrgUuid is empty — set it in Settings → Advanced or use the slash-command fallback",
      via: "sdk",
    });
    return;
  }

  // Tear down any prior direct handle first (avoid duplicate registrations).
  if (activeRemoteControlTeardown) {
    try { await activeRemoteControlTeardown(); } catch { /* ignore */ }
    activeRemoteControlTeardown = null;
  }

  let sdkMod: any;
  try {
    sdkMod = await import("@anthropic-ai/claude-agent-sdk");
  } catch (e) {
    emit({
      id: req.id,
      type: "mobile_pair_error",
      session_id: "master",
      error: `failed to load @anthropic-ai/claude-agent-sdk: ${e instanceof Error ? e.message : String(e)}`,
      via: "sdk",
    });
    return;
  }
  if (typeof sdkMod.connectRemoteControl !== "function") {
    emit({
      id: req.id,
      type: "mobile_pair_error",
      session_id: "master",
      error: "SDK does not expose connectRemoteControl in this version — upgrade @anthropic-ai/claude-agent-sdk or use slash-command fallback",
      via: "sdk",
    });
    return;
  }

  // Bootstrap-fetch the token once so we can fail fast with a clear message
  // and let the caller fall back to the slash-command path on UI side.
  let firstToken: string | null = null;
  try {
    firstToken = await getClaudeAccessToken();
  } catch {
    firstToken = null;
  }
  if (!firstToken) {
    emit({
      id: req.id,
      type: "mobile_pair_error",
      session_id: "master",
      error: "no Claude access token in OS keystore — run `claude auth login` (claude.ai option) and ensure your subscription includes remote control",
      via: "sdk",
    });
    return;
  }
  cachedAccessToken = { value: firstToken, fetchedAt: Date.now() };

  const getAccessToken = (): string | undefined => {
    const c = cachedAccessToken;
    if (c && Date.now() - c.fetchedAt < TOKEN_CACHE_TTL_MS) return c.value;
    cachedAccessToken = null;
    return undefined; // force refresh on next onAuth401
  };

  const onAuth401 = async (_stale: string): Promise<boolean> => {
    cachedAccessToken = null;
    try {
      const t = await getClaudeAccessToken();
      if (!t) return false;
      cachedAccessToken = { value: t, fetchedAt: Date.now() };
      return true;
    } catch {
      return false;
    }
  };

  try {
    const result = await sdkMod.connectRemoteControl({
      dir: process.cwd(),
      baseUrl,
      orgUUID: orgUuid,
      model: "claude-sonnet-4-5",
      getAccessToken,
      onAuth401,
    });

    // Result is { ok: true, handle } | { ok: false, error }.
    if (result && result.ok === false) {
      emit({
        id: req.id,
        type: "mobile_pair_error",
        session_id: "master",
        error: `connectRemoteControl failed (${result.error?.kind ?? "unknown"}): ${result.error?.detail ?? ""}`.trim(),
        via: "sdk",
      });
      return;
    }

    const handle = result?.ok === true ? result.handle : result;
    if (!handle) {
      emit({
        id: req.id,
        type: "mobile_pair_error",
        session_id: "master",
        error: "connectRemoteControl returned no handle",
        via: "sdk",
      });
      return;
    }

    // Best-effort URL extraction; the SDK shape is @alpha and may evolve.
    const url: string | undefined =
      handle.sessionUrl ?? handle.url ?? handle.pairingUrl ?? handle.connectUrl;

    if (typeof handle.teardown === "function") {
      activeRemoteControlTeardown = () => handle.teardown();
    } else if (typeof handle.disconnect === "function") {
      activeRemoteControlTeardown = () => handle.disconnect();
    } else {
      activeRemoteControlTeardown = null;
    }

    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      emit({
        id: req.id,
        type: "mobile_pair_url",
        session_id: "master",
        url,
        via: "sdk",
      });
    } else {
      emit({
        id: req.id,
        type: "mobile_pair_error",
        session_id: "master",
        error: "connectRemoteControl returned a handle without a session URL — SDK shape may have changed",
        via: "sdk",
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({
      id: req.id,
      type: "mobile_pair_error",
      session_id: "master",
      error: msg,
      via: "sdk",
    });
  }
}

function configureRelay(req: {
  enabled: boolean;
  relayUrl?: string;
  sessionName?: string;
  authToken?: string;
}): void {
  // disable / replace existing
  if (relay) {
    relay.stop();
    relay = null;
  }
  if (!req.enabled) return;
  const url = (req.relayUrl ?? "").trim();
  const sessionName = (req.sessionName ?? "").trim();
  const authToken = (req.authToken ?? "").trim();
  if (!url || !sessionName || !authToken) {
    throw new Error("relay requires relayUrl + sessionName + authToken");
  }
  if (!/^wss?:\/\//i.test(url)) {
    throw new Error("relayUrl must be ws:// or wss://");
  }
  const client = new RelayClient({ url, sessionName, authToken });
  client.onStateChange = (_s: RelayState) => emitRelayState();
  client.onRemoteRpc = (payload: unknown) => {
    // Treat remote-originated RPC like a local stdin line.
    if (!payload || typeof payload !== "object") return;
    handle(payload as InboundMessage);
  };
  relay = client;
  client.start();
}

async function testMcpServer(
  name: string,
  config: McpServerSpec,
): Promise<{ ok: boolean; tools?: { name: string; description?: string }[]; error?: string }> {
  const TIMEOUT_MS = 8000;
  let transport:
    | StdioClientTransport
    | StreamableHTTPClientTransport
    | SSEClientTransport
    | null = null;
  let client: Client | null = null;

  const cleanup = async () => {
    try {
      await client?.close();
    } catch {}
    try {
      await transport?.close();
    } catch {}
  };

  const work = (async () => {
    const transportType =
      "type" in config && config.type ? config.type : "stdio";

    if (transportType === "stdio") {
      const cfg = config as Extract<McpServerSpec, { command: string }>;
      if (!cfg.command || typeof cfg.command !== "string") {
        throw new Error("stdio server requires a `command` string");
      }
      // Merge with PATH so users don't have to set it explicitly.
      const env: Record<string, string> = { ...(cfg.env ?? {}) };
      if (process.env.PATH && env.PATH === undefined) {
        env.PATH = process.env.PATH;
      }
      if (process.env.HOME && env.HOME === undefined) {
        env.HOME = process.env.HOME;
      }
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env,
        stderr: "pipe",
      });
    } else if (transportType === "http") {
      const cfg = config as Extract<McpServerSpec, { type: "http" }>;
      if (!cfg.url) throw new Error("http server requires a `url`");
      transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
    } else if (transportType === "sse") {
      const cfg = config as Extract<McpServerSpec, { type: "sse" }>;
      if (!cfg.url) throw new Error("sse server requires a `url`");
      transport = new SSEClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
    } else {
      throw new Error(`unknown transport type: ${String(transportType)}`);
    }

    client = new Client(
      { name: "clawdui-mcp-tester", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
    }));
    return { ok: true as const, tools };
  })();

  try {
    const result = await Promise.race<
      | { ok: true; tools: { name: string; description?: string }[] }
      | { ok: false; error: string }
    >([
      work,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`mcp_test timed out after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        ),
      ) as Promise<never>,
    ]);
    return result;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    void cleanup();
    void name; // reserved for logging
  }
}

// Boot-time CLI probe: resolve the `claude` binary once now (after
// inheritUserPath has finished enriching PATH) and broadcast the result
// as an unsolicited `cli_status` event. The frontend listens for this
// at module load so the cliFound store flips to true even if no panel
// has yet been opened — fixes the "cli missing" banner sticking after
// a successful PATH inheritance.
void resolveClaudeBinary()
  .then((path) => {
    emit({
      id: "sys",
      type: "cli_status",
      path,
      searched: searchedClaudePaths(),
    });
  })
  .catch(() => {
    // Resolution failures already return null; defensive only.
    emit({
      id: "sys",
      type: "cli_status",
      path: null,
      searched: searchedClaudePaths(),
    });
  });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let req: InboundMessage;
  try {
    req = JSON.parse(t) as InboundMessage;
  } catch {
    emit({ id: "?", type: "error", error: `bad json: ${t.slice(0, 80)}` });
    return;
  }
  // Mirror local-frontend RPCs to the relay so remote observers see them.
  // Skip relay-control RPCs themselves to keep the relay-side state clean.
  if (
    relay &&
    req.type !== "set_remote_control" &&
    req.type !== "remote_control_status"
  ) {
    relay.forward("rpc", req);
  }
  void handle(req).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[DIAG] handle() threw for id=${req.id} type=${req.type}: ${msg}`);
    emit({
      id: req.id,
      type: "error",
      error: msg,
    });
  });
});

rl.on("close", () => {
  for (const [, s] of sessions) s.end();
  sessions.clear();
  relay?.stop();
  process.exit(0);
});

// Bootstrap relay from env (used for headless smoke-testing without the UI).
// CLAWDUI_RC=1 + CLAWDUI_RC_URL + CLAWDUI_RC_SESSION + CLAWDUI_RC_TOKEN
if (process.env.CLAWDUI_RC === "1") {
  try {
    configureRelay({
      enabled: true,
      relayUrl: process.env.CLAWDUI_RC_URL,
      sessionName: process.env.CLAWDUI_RC_SESSION,
      authToken: process.env.CLAWDUI_RC_TOKEN,
    });
  } catch (e) {
    emit({
      id: "rc-boot",
      type: "error",
      error: `relay bootstrap failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

emit({ id: "boot", type: "pong" });
