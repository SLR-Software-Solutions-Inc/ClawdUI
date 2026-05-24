import { writable, get } from "svelte/store";
import { rpcCall } from "./sidecarRpc";
import { settings, getSettings, patchSettings } from "./settings";

export type SessionSummary = {
  id: string;
  title: string;
  firstMessage: string;
  lastMessage: string;
  messageCount: number;
  totalCostUsd: number;
  model?: string;
  mtime: number;
  /** Branch the session was running on, if available in metadata. */
  branch?: string | null;
};

type SessionsState = {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  cwd: string | null;
};

const initial: SessionsState = {
  sessions: [],
  loading: false,
  error: null,
  cwd: null,
};

export const sessions = writable<SessionsState>(initial);

function effectiveCwd(): string | null {
  const s = getSettings();
  return s.cwd ?? null;
}

export async function refresh(): Promise<void> {
  const cwd = effectiveCwd();
  sessions.update((st) => ({ ...st, loading: true, error: null, cwd }));
  if (!cwd) {
    sessions.update((st) => ({ ...st, loading: false, sessions: [] }));
    return;
  }
  try {
    const list = await rpcCall<SessionSummary[]>("list_sessions", { cwd });
    sessions.update((st) => ({
      ...st,
      loading: false,
      sessions: Array.isArray(list) ? list : [],
    }));
  } catch (err) {
    sessions.update((st) => ({
      ...st,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
      sessions: [],
    }));
  }
}

export function resume(id: string): void {
  patchSettings({ resume: id, forkSession: false, continueLatest: false });
}

export function fork(id: string): void {
  patchSettings({ resume: id, forkSession: true, continueLatest: false });
}

export async function deleteSession(id: string): Promise<void> {
  const cwd = effectiveCwd();
  if (!cwd) return;
  await rpcCall("delete_session", { cwd, session_id: id });
  await refresh();
}

function safeFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

function blockToMarkdown(block: any): string {
  if (!block || typeof block !== "object") return "";
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "thinking":
      return (block.thinking ?? block.text ?? "")
        .toString()
        .split("\n")
        .map((l: string) => `> ${l}`)
        .join("\n");
    case "tool_use":
      return [
        "```json",
        JSON.stringify(
          { tool: block.name, id: block.id, input: block.input },
          null,
          2,
        ),
        "```",
      ].join("\n");
    case "tool_result": {
      const content =
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content, null, 2);
      return ["```", content, "```"].join("\n");
    }
    default:
      return "";
  }
}

function rawToMarkdown(records: unknown[]): string {
  const out: string[] = [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, any>;
    const type = r.type;
    const message = r.message;
    if (type === "user" && message?.content) {
      const content = message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map(blockToMarkdown).filter(Boolean).join("\n\n")
            : "";
      if (text) out.push(`## User\n\n${text}\n`);
    } else if (type === "assistant" && message?.content) {
      const content = message.content;
      const parts = Array.isArray(content)
        ? content.map(blockToMarkdown).filter(Boolean)
        : typeof content === "string"
          ? [content]
          : [];
      if (parts.length) out.push(`## Assistant\n\n${parts.join("\n\n")}\n`);
    }
  }
  return out.join("\n");
}

async function readRaw(id: string): Promise<unknown[]> {
  const cwd = effectiveCwd();
  if (!cwd) throw new Error("no cwd configured");
  return await rpcCall<unknown[]>("read_session", { cwd, session_id: id });
}

export async function loadSessionRaw(id: string): Promise<unknown[]> {
  return readRaw(id);
}

function summary(id: string): SessionSummary | undefined {
  return get(sessions).sessions.find((s) => s.id === id);
}

export async function exportMarkdown(id: string): Promise<string> {
  const cwd = effectiveCwd();
  if (!cwd) throw new Error("no cwd configured");
  const records = await readRaw(id);
  const sum = summary(id);
  const header = [
    `# Session ${id}`,
    "",
    sum ? `- **title:** ${sum.title}` : "",
    sum ? `- **messages:** ${sum.messageCount}` : "",
    sum ? `- **cost:** $${sum.totalCostUsd.toFixed(4)}` : "",
    sum?.model ? `- **model:** ${sum.model}` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = rawToMarkdown(records);
  const md = `${header}\n${body}`;
  const name = sum ? `${safeFilename(sum.title)}-${id.slice(0, 8)}.md` : `${id}.md`;
  const target = `${cwd}/${name}`;
  await rpcCall("write_file", { path: target, content: md });
  return target;
}

export async function exportJson(id: string): Promise<string> {
  const cwd = effectiveCwd();
  if (!cwd) throw new Error("no cwd configured");
  const records = await readRaw(id);
  const sum = summary(id);
  const name = sum ? `${safeFilename(sum.title)}-${id.slice(0, 8)}.json` : `${id}.json`;
  const target = `${cwd}/${name}`;
  await rpcCall("write_file", {
    path: target,
    content: JSON.stringify(records, null, 2),
  });
  return target;
}

/**
 * Resolve the git branch associated with a session. Prefers the branch stored
 * in the session metadata (when present); falls back to running
 * `git -C <cwd> branch --show-current` via the sidecar `git_branch` RPC.
 *
 * Returns null if no branch can be determined (e.g. cwd unset, not a git
 * repo, or detached HEAD).
 */
export async function sessionBranch(s: SessionSummary): Promise<string | null> {
  if (s.branch && s.branch.trim()) return s.branch.trim();
  const cwd = effectiveCwd();
  if (!cwd) return null;
  try {
    const res = await rpcCall<{ branch: string | null }>("git_branch", { cwd });
    const b = res?.branch;
    return b && b.trim() ? b.trim() : null;
  } catch {
    return null;
  }
}

// Auto-refresh when cwd changes.
let lastCwd: string | undefined = undefined;
settings.subscribe((s) => {
  if (s.cwd !== lastCwd) {
    lastCwd = s.cwd;
    void refresh();
  }
});
