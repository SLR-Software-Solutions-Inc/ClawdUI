// Worker Z: checkpoint + fork primitives backing /undo + /fork slash commands.
//
// Storage model
// -------------
// Sessions live server-side (sidecar). The chat transcript (`messages` array)
// lives only inside App.svelte. Checkpoints don't snapshot the messages
// themselves — they're cheap pointers: { id, createdAt, label, messageIndex }
// keyed by sessionId. Rewinding = truncating messages[] to messageIndex.
// Forking = telling sessions.fork() to resume + fork-on-resume; the optional
// from-checkpoint id is recorded so the post-fork newSession() can also
// truncate the replayed transcript to that point.
//
// App.svelte owns the messages[] array, so this module exposes a
// handler-registration pattern instead of mutating state directly.

import { writable, get } from "svelte/store";

const STORAGE_KEY = "clawdui.checkpoints.v1";

export type Checkpoint = {
  id: string;
  createdAt: number;
  label?: string;
  /** Truncate point — messages[0..messageIndex) are kept on rewind. */
  messageIndex: number;
};

type CheckpointMap = Record<string, Checkpoint[]>;

function loadFromDisk(): CheckpointMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as CheckpointMap) : {};
  } catch {
    return {};
  }
}

function saveToDisk(map: CheckpointMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // quota / privacy mode — non-fatal
  }
}

const _store = writable<CheckpointMap>(loadFromDisk());
export const checkpoints = _store;

function shortId(): string {
  const g = (globalThis as { crypto?: Crypto }).crypto;
  if (g?.getRandomValues) {
    const buf = new Uint8Array(8);
    g.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(16).slice(2, 18);
}

// --- handler registration (App.svelte owns the messages[] array) ---

type MessageCountProvider = () => number;
type RewindHandler = (messageIndex: number) => void;
type ForkHandler = (fromCheckpointId?: string) => void;

let _messageCount: MessageCountProvider = () => 0;
let _rewind: RewindHandler = () => {};
let _fork: ForkHandler = () => {};
let _activeSessionId: () => string | null = () => null;

export function registerCheckpointHandlers(h: {
  getMessageCount: MessageCountProvider;
  rewind: RewindHandler;
  fork: ForkHandler;
  getActiveSessionId: () => string | null;
}): void {
  _messageCount = h.getMessageCount;
  _rewind = h.rewind;
  _fork = h.fork;
  _activeSessionId = h.getActiveSessionId;
}

// --- public API consumed by Worker U's slash commands + the drawer ---

export function getActiveSessionId(): string | null {
  return _activeSessionId();
}

export function listCheckpoints(sessionId?: string | null): Checkpoint[] {
  const sid = sessionId ?? _activeSessionId();
  if (!sid) return [];
  return [...(get(_store)[sid] ?? [])].sort((a, b) => b.createdAt - a.createdAt);
}

export function createCheckpoint(label?: string): Checkpoint | null {
  const sid = _activeSessionId();
  if (!sid) return null;
  const cp: Checkpoint = {
    id: shortId(),
    createdAt: Date.now(),
    label: label && label.trim() ? label.trim() : undefined,
    messageIndex: _messageCount(),
  };
  _store.update((m) => {
    const next: CheckpointMap = { ...m };
    next[sid] = [...(next[sid] ?? []), cp];
    saveToDisk(next);
    return next;
  });
  return cp;
}

/** Auto-checkpoint after each assistant turn. De-dupes when nothing changed. */
export function autoCheckpoint(): Checkpoint | null {
  const sid = _activeSessionId();
  if (!sid) return null;
  const list = get(_store)[sid] ?? [];
  const idx = _messageCount();
  const last = list[list.length - 1];
  if (last && last.messageIndex === idx) return last;
  return createCheckpoint();
}

export function rewindToCheckpoint(checkpointId: string): boolean {
  const sid = _activeSessionId();
  if (!sid) return false;
  const cp = (get(_store)[sid] ?? []).find((c) => c.id === checkpointId);
  if (!cp) return false;
  _rewind(cp.messageIndex);
  // Drop checkpoints created AFTER this one — they pointed at messages
  // that no longer exist.
  _store.update((m) => {
    const list = m[sid] ?? [];
    const next: CheckpointMap = {
      ...m,
      [sid]: list.filter((c) => c.createdAt <= cp.createdAt),
    };
    saveToDisk(next);
    return next;
  });
  return true;
}

/** Undo to the most recent checkpoint before "now". Returns true if rewound. */
export function undoLastCheckpoint(): boolean {
  const list = listCheckpoints(); // sorted newest first
  // Skip any checkpoint that points at the current message count.
  const idx = _messageCount();
  const target = list.find((c) => c.messageIndex < idx) ?? list[1] ?? list[0];
  if (!target) return false;
  return rewindToCheckpoint(target.id);
}

/**
 * Fork the active session. If `fromCheckpointId` is given, the post-fork
 * session replays up to that checkpoint's messageIndex. Caller (App.svelte)
 * handles the actual session swap via the registered handler.
 */
export function forkSession(fromCheckpointId?: string): void {
  _fork(fromCheckpointId);
}

/** Clear all checkpoints for a session — called when its session_ended fires. */
export function clearCheckpoints(sessionId: string): void {
  _store.update((m) => {
    if (!(sessionId in m)) return m;
    const next = { ...m };
    delete next[sessionId];
    saveToDisk(next);
    return next;
  });
}

/** Format a Unix-ms timestamp as a short relative string. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
