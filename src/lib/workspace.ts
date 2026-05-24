import { writable, get } from "svelte/store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getSettings, patchSettings, settingsLoaded } from "./settings";
import { isTauri } from "./systemStatus";

function emitPreviewToast(action: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("safe-invoke-toast", {
        detail: {
          message: `${action} unavailable in browser preview`,
          kind: "info",
        },
      }),
    );
  } catch {
    /* ignore */
  }
}

const STORAGE_KEY = "clawdui.workspace.v1";
const MAX_RECENT = 8;

export interface WorkspaceState {
  current: string | null;
  recent: string[];
}

function load(): WorkspaceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { current: null, recent: [] };
    const parsed = JSON.parse(raw);
    return {
      current: typeof parsed.current === "string" ? parsed.current : null,
      recent: Array.isArray(parsed.recent)
        ? parsed.recent.filter((p: unknown): p is string => typeof p === "string")
        : [],
    };
  } catch {
    return { current: null, recent: [] };
  }
}

const initial = load();
export const workspace = writable<WorkspaceState>(initial);

// Sync persisted workspace into settings.cwd on startup so the agent
// inherits the previously open workspace.
//
// Two-phase apply because this module runs at import time (before
// hydrateSettings() reads settings.json from disk). The pre-hydration patch
// gives the store a sensible default for any early reader; the
// post-hydration re-apply ensures workspace.current WINS over any stale
// settings.cwd that was persisted from a different workspace last session.
// Without the re-apply, on-disk cwd would clobber the workspace store and
// the SDK would boot in the wrong folder.
if (initial.current) {
  patchSettings({ cwd: initial.current });
}
let _appliedAfterHydration = false;
const _unsubLoaded = settingsLoaded.subscribe((loaded) => {
  if (!loaded || _appliedAfterHydration) return;
  _appliedAfterHydration = true;
  const ws = get(workspace).current;
  if (ws) {
    patchSettings({ cwd: ws });
  }
  // Drop the subscription — single-shot.
  queueMicrotask(() => _unsubLoaded());
});

workspace.subscribe((s) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
});

function pushRecent(recent: string[], path: string): string[] {
  const next = [path, ...recent.filter((p) => p !== path)];
  return next.slice(0, MAX_RECENT);
}

/**
 * Set the current workspace and mirror into settings.cwd so the agent
 * operates inside the workspace root.
 *
 * Also clears resume / continueLatest / sessionId / forkSession so the next
 * session boots fresh in the new workspace. Without this, a prior workspace's
 * continueLatest flag (or stale resume id) carries over and the SDK auto-
 * resumes the most recent jsonl in the NEW workspace's project dir — which
 * re-injects a synthetic "continued from compact" summary referencing the
 * OLD project. The agent then keeps operating on the OLD project's files
 * even though the spawn cwd is correctly the new workspace.
 */
export function setWorkspace(path: string | null): void {
  workspace.update((s) => {
    if (path === null) {
      return { current: null, recent: s.recent };
    }
    return {
      current: path,
      recent: pushRecent(s.recent, path),
    };
  });
  patchSettings({
    cwd: path ?? undefined,
    resume: undefined,
    continueLatest: false,
    sessionId: undefined,
    forkSession: false,
  });
}

/**
 * Show the OS folder picker, then activate the chosen folder.
 * Returns the chosen path, or null if the user cancelled.
 */
export async function openWorkspace(): Promise<string | null> {
  if (!isTauri()) {
    // The Tauri dialog plugin throws an opaque error in browser preview.
    // Bail with a user-visible toast so "Open folder…" no longer
    // silently no-ops.
    emitPreviewToast("Open folder…");
    return null;
  }
  const current = get(workspace).current ?? undefined;
  try {
    const result = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: current,
      title: "Open workspace folder",
    });
    if (typeof result !== "string" || !result) return null;
    setWorkspace(result);
    return result;
  } catch (err) {
    emitPreviewToast("Open folder…");
    // eslint-disable-next-line no-console
    console.warn("openDialog failed", err);
    return null;
  }
}

export function closeWorkspace(): void {
  setWorkspace(null);
}

export function removeRecent(path: string): void {
  workspace.update((s) => ({
    current: s.current,
    recent: s.recent.filter((p) => p !== path),
  }));
}

/**
 * Open a folder picker and append the chosen path to settings.additionalDirectories.
 * The agent receives every entry as part of its allowed working set, so it can
 * read / edit across multiple services in one session.
 *
 * No-ops if the user cancels or the chosen path equals the current workspace.
 * Duplicates are silently dropped.
 */
export async function addAdditionalDirectory(): Promise<string | null> {
  if (!isTauri()) {
    emitPreviewToast("Add folder…");
    return null;
  }
  const cur = get(workspace).current ?? undefined;
  try {
    const result = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: cur,
      title: "Add folder to workspace",
    });
    if (typeof result !== "string" || !result) return null;
    if (cur && result === cur) return null;
    const existing = getSettings().additionalDirectories ?? [];
    if (existing.includes(result)) return result;
    patchSettings({ additionalDirectories: [...existing, result] });
    return result;
  } catch (err) {
    emitPreviewToast("Add folder…");
    // eslint-disable-next-line no-console
    console.warn("openDialog failed", err);
    return null;
  }
}

export function removeAdditionalDirectory(path: string): void {
  const existing = getSettings().additionalDirectories ?? [];
  if (!existing.includes(path)) return;
  patchSettings({ additionalDirectories: existing.filter((p) => p !== path) });
}
