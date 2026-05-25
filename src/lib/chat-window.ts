/**
 * Paginated session-resume chat window (Phase B).
 *
 * Replaces the Phase A "load full transcript → render last 100 → backfill
 * the rest in setTimeout chunks" model. The new flow:
 *
 *   1. On resume: ask sidecar for the LAST `INITIAL_LIMIT` (500) jsonl
 *      entries via `fetch_session_window(beforeSeq=0, limit=500)`. The
 *      response includes `total` (full transcript length) and
 *      `startSeq` (index of first returned entry).
 *   2. Hydrate `messages` with the returned entries; `oldestSeq` =
 *      startSeq; `totalSeq` = total. `done` = (startSeq === 0).
 *   3. When the user scrolls to the top sentinel, fetch the next
 *      `WINDOW_LIMIT` (100) entries with `beforeSeq = oldestSeq`. Prepend
 *      and update `oldestSeq`. Stop when `done`.
 *
 * The store stays UI-agnostic: it tracks raw jsonl entries indexed by
 * seq, plus loading flags. The Svelte caller is responsible for feeding
 * entries through `handleSdkMessage(entry)` to convert them to
 * ChatMessage shape, preserving scroll position, and binding the
 * IntersectionObserver. This keeps the message-conversion path single-
 * sourced (App.svelte handleSdkMessage) without forking shape logic.
 */
import { writable, get } from "svelte/store";
import { rpcCall } from "./sidecarRpc";

export const INITIAL_LIMIT = 500;
export const WINDOW_LIMIT = 100;

export type ChatWindowState = {
  /** Lowest 0-based jsonl index currently loaded. */
  oldestSeq: number;
  /** Total jsonl entries in session. */
  totalSeq: number;
  /** True while a fetch_session_window call is in flight. */
  fetching: boolean;
  /** True when oldestSeq === 0 (no more older history to load). */
  done: boolean;
  /** Active session id; null when no session is being windowed. */
  sessionId: string | null;
};

const initial: ChatWindowState = {
  oldestSeq: 0,
  totalSeq: 0,
  fetching: false,
  done: true,
  sessionId: null,
};

export const chatWindow = writable<ChatWindowState>({ ...initial });

export function resetChatWindow(): void {
  chatWindow.set({ ...initial });
}

type WindowResponse = {
  messages: unknown[];
  startSeq: number;
  total: number;
  hasMore: boolean;
};

/**
 * Initial resume load — fetches the last INITIAL_LIMIT entries.
 *
 * Returns the raw jsonl entries so the caller can feed them through
 * the existing SDK-message conversion path. Updates the store as a
 * side effect.
 */
export async function loadInitialWindow(
  cwd: string,
  sessionId: string,
  limit: number = INITIAL_LIMIT,
): Promise<unknown[]> {
  chatWindow.set({
    oldestSeq: 0,
    totalSeq: 0,
    fetching: true,
    done: false,
    sessionId,
  });
  console.log(
    `[DIAG-FE] chat-window initial — session=${sessionId} limit=${limit}`,
  );
  const resp = await rpcCall<WindowResponse>("fetch_session_window", {
    cwd,
    session_id: sessionId,
    before_seq: 0, // 0 → "from end"
    limit,
  });
  const entries = Array.isArray(resp?.messages) ? resp.messages : [];
  chatWindow.set({
    oldestSeq: resp.startSeq | 0,
    totalSeq: resp.total | 0,
    fetching: false,
    done: !resp.hasMore || (resp.startSeq | 0) === 0,
    sessionId,
  });
  console.log(
    `[DIAG-FE] chat-window initial loaded — total=${resp.total} startSeq=${resp.startSeq} hasMore=${resp.hasMore} count=${entries.length}`,
  );
  return entries;
}

/**
 * Fetch the next batch of older entries. No-op if already fetching, done,
 * or no session bound. Returns the raw entries to prepend (may be empty).
 */
export async function loadMoreWindow(
  cwd: string,
  limit: number = WINDOW_LIMIT,
): Promise<unknown[]> {
  const cur = get(chatWindow);
  if (!cur.sessionId || cur.fetching || cur.done || cur.oldestSeq <= 0) {
    return [];
  }
  chatWindow.update((s) => ({ ...s, fetching: true }));
  const beforeSeq = cur.oldestSeq;
  console.log(
    `[DIAG-FE] chat-window loadMore — session=${cur.sessionId} beforeSeq=${beforeSeq} limit=${limit}`,
  );
  try {
    const resp = await rpcCall<WindowResponse>("fetch_session_window", {
      cwd,
      session_id: cur.sessionId,
      before_seq: beforeSeq,
      limit,
    });
    const entries = Array.isArray(resp?.messages) ? resp.messages : [];
    const newOldest = resp.startSeq | 0;
    chatWindow.update((s) => ({
      ...s,
      oldestSeq: newOldest,
      totalSeq: resp.total | 0,
      fetching: false,
      done: !resp.hasMore || newOldest === 0 || entries.length === 0,
    }));
    console.log(
      `[DIAG-FE] chat-window loadMore got — count=${entries.length} newOldest=${newOldest} done=${!resp.hasMore || newOldest === 0}`,
    );
    return entries;
  } catch (e) {
    chatWindow.update((s) => ({ ...s, fetching: false }));
    console.error(`[DIAG-FE] chat-window loadMore failed:`, e);
    return [];
  }
}
