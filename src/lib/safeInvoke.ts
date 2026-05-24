// Tauri IPC wrapper that gracefully degrades in browser preview mode.
//
// Bare `invoke(...)` throws with an opaque "window.__TAURI_INTERNALS__ is
// undefined" stack when the page is loaded via `vite dev` instead of
// `tauri dev`. We swallow that, surface a one-off toast through the
// `safe-invoke-toast` window event (App.svelte listens), and return
// `null` so callers can fall back without try/catch noise.
//
// Real Tauri builds get the original error propagation — only the
// "no Tauri" path is special-cased.

import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./systemStatus";

// In-session set so the toast isn't fired once per call.
const warnedCmds = new Set<string>();

function emitToast(message: string, kind: "info" | "error" = "info"): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("safe-invoke-toast", { detail: { message, kind } }),
    );
  } catch {
    /* ignore */
  }
}

export async function safeInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauri()) {
    if (!warnedCmds.has(cmd)) {
      warnedCmds.add(cmd);
      emitToast(`${cmd} unavailable in browser preview`, "info");
    }
    return null;
  }
  try {
    return (await invoke<T>(cmd, args)) as T;
  } catch (err) {
    // Detect the "no Tauri" runtime error even when isTauri() was true
    // (rare HMR edge case where the API is partially loaded).
    const msg = err instanceof Error ? err.message : String(err);
    if (/__TAURI_INTERNALS__|window\.__TAURI/.test(msg)) {
      if (!warnedCmds.has(cmd)) {
        warnedCmds.add(cmd);
        emitToast(`${cmd} unavailable in browser preview`, "info");
      }
      return null;
    }
    throw err;
  }
}

// Same browser-preview shim for `listen`. Bare listen() throws a
// `transformCallback` error when window.__TAURI_INTERNALS__ is missing
// (vite dev). We return a no-op unlisten so callers can store it
// unconditionally.
export async function safeListen<T = unknown>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  const noop: UnlistenFn = () => {};
  if (!isTauri()) {
    if (!warnedCmds.has(`listen:${event}`)) {
      warnedCmds.add(`listen:${event}`);
      emitToast(`event '${event}' unavailable in browser preview`, "info");
    }
    return noop;
  }
  try {
    return await listen<T>(event, handler);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/__TAURI_INTERNALS__|window\.__TAURI|transformCallback/.test(msg)) {
      if (!warnedCmds.has(`listen:${event}`)) {
        warnedCmds.add(`listen:${event}`);
        emitToast(`event '${event}' unavailable in browser preview`, "info");
      }
      return noop;
    }
    throw err;
  }
}
