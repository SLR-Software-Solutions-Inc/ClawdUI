import { writable, get, derived } from "svelte/store";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { safeInvoke, safeListen } from "./safeInvoke";
import { settings, patchSettings } from "./settings";

export type PluginCounts = {
  skills: number;
  commands: number;
  hooks: number;
  agents: number;
};

export type PluginInfo = {
  path: string;
  exists: boolean;
  name: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
  counts: PluginCounts;
};

type PluginEvent =
  | { id: string; type: "result"; value: unknown }
  | { id: string; type: "error"; error: string };

type WaitingResolver = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

const pending = new Map<string, WaitingResolver>();
let unlisten: UnlistenFn | null = null;

async function ensureListener(): Promise<void> {
  if (unlisten) return;
  unlisten = await safeListen<PluginEvent>("sidecar-event", (e) => {
    const ev = e.payload;
    if (ev && (ev.type === "result" || ev.type === "error")) {
      const w = pending.get(ev.id);
      if (!w) return;
      pending.delete(ev.id);
      if (ev.type === "result") w.resolve(ev.value);
      else w.reject(new Error(ev.error));
    }
  });
}

function uuid(): string {
  return crypto.randomUUID();
}

async function rpcCall<T>(payload: { type: string; [k: string]: unknown }): Promise<T> {
  await ensureListener();
  const id = uuid();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject,
    });
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`plugin RPC timeout: ${payload.type}`));
      }
    }, 8000);
    void safeInvoke("send_to_sidecar", {
      payload: JSON.stringify({ id, ...payload }),
    })
      .then((res) => {
        // Browser-preview: safeInvoke returns null and the sidecar event
        // will never fire. Resolve with empty so callers don't hang.
        if (res === null && pending.has(id)) {
          clearTimeout(timer);
          pending.delete(id);
          resolve(null as unknown as T);
        }
      })
      .catch((e) => {
        clearTimeout(timer);
        if (pending.has(id)) {
          pending.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
  });
}

export const pluginsCache = writable<Record<string, PluginInfo>>({});
export const discovered = writable<PluginInfo[]>([]);
export const pluginsLoading = writable<boolean>(false);
export const pluginsError = writable<string | null>(null);

export const installedPlugins = derived(
  [settings, pluginsCache],
  ([$s, $cache]) => {
    return ($s.pluginDirs ?? []).map<PluginInfo>((p) => {
      return (
        $cache[p] ?? {
          path: p,
          exists: false,
          name: null,
          description: null,
          version: null,
          author: null,
          counts: { skills: 0, commands: 0, hooks: 0, agents: 0 },
        }
      );
    });
  },
);

export async function refresh(): Promise<void> {
  const paths = get(settings).pluginDirs ?? [];
  pluginsLoading.set(true);
  pluginsError.set(null);
  try {
    const list = await rpcCall<PluginInfo[]>({ type: "list_plugins", paths });
    const map: Record<string, PluginInfo> = {};
    for (const p of list ?? []) map[p.path] = p;
    pluginsCache.set(map);
  } catch (e) {
    pluginsError.set(e instanceof Error ? e.message : String(e));
  } finally {
    pluginsLoading.set(false);
  }
}

export async function discoverFromClaudeCache(): Promise<void> {
  pluginsError.set(null);
  try {
    const list = await rpcCall<PluginInfo[]>({ type: "discover_plugins" });
    discovered.set(list ?? []);
  } catch (e) {
    pluginsError.set(e instanceof Error ? e.message : String(e));
  }
}

export function addPluginPath(p: string): boolean {
  const trimmed = p.trim();
  if (!trimmed) return false;
  const current = get(settings).pluginDirs ?? [];
  if (current.includes(trimmed)) return false;
  patchSettings({ pluginDirs: [...current, trimmed] });
  void refresh();
  return true;
}

export function removePluginPath(p: string): void {
  const s = get(settings);
  patchSettings({
    pluginDirs: (s.pluginDirs ?? []).filter((x) => x !== p),
    disabledPluginPaths: (s.disabledPluginPaths ?? []).filter((x) => x !== p),
  });
  pluginsCache.update((m) => {
    const { [p]: _drop, ...rest } = m;
    return rest;
  });
}

export function togglePluginEnabled(p: string): void {
  const s = get(settings);
  const disabled = s.disabledPluginPaths ?? [];
  const next = disabled.includes(p)
    ? disabled.filter((x) => x !== p)
    : [...disabled, p];
  patchSettings({ disabledPluginPaths: next });
}

export function isPluginEnabled(p: string): boolean {
  return !(get(settings).disabledPluginPaths ?? []).includes(p);
}

export async function copyPath(p: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(p);
  } catch {
    /* ignore */
  }
}
