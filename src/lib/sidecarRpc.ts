import { type UnlistenFn } from "@tauri-apps/api/event";
import { safeInvoke, safeListen } from "./safeInvoke";

type RpcEvent =
  | { id: string; type: "pong" }
  | { id: string; type: "ack" }
  | { id: string; type: "result"; value: unknown }
  | { id: string; type: "error"; error: string }
  | { id: string; type: string; [k: string]: unknown };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

const pending = new Map<string, Pending>();
let installed = false;
let unlisten: UnlistenFn | null = null;

async function ensureListener(): Promise<void> {
  if (installed) return;
  installed = true;
  unlisten = await safeListen<RpcEvent>("sidecar-event", (e) => {
    const ev = e.payload;
    if (!ev || typeof ev !== "object") return;
    const id = ev.id;
    if (!id) return;
    const p = pending.get(id);
    if (!p) return;
    if (ev.type === "result") {
      pending.delete(id);
      p.resolve((ev as { value: unknown }).value);
    } else if (ev.type === "ack") {
      pending.delete(id);
      p.resolve(undefined);
    } else if (ev.type === "error") {
      pending.delete(id);
      p.reject(new Error(String((ev as { error: string }).error)));
    }
  });
}

function uuid(): string {
  return crypto.randomUUID();
}

export async function rpcCall<T = unknown>(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  await ensureListener();
  const id = uuid();
  const promise = new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Safety timeout.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`rpc timeout: ${type}`));
      }
    }, 30_000);
  });
  await safeInvoke("send_to_sidecar", {
    payload: JSON.stringify({ id, type, ...payload }),
  });
  return (await promise) as T;
}

export async function disposeRpc(): Promise<void> {
  unlisten?.();
  unlisten = null;
  installed = false;
  pending.clear();
}
