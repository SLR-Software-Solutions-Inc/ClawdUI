import { writable, get } from "svelte/store";

export type AttachmentStatus = "uploading" | "ready" | "error";

export type Attachment = {
  /** local stable id used by the UI before/after upload */
  localId: string;
  /** path on disk (absolute when known) */
  path?: string;
  /** display name */
  name: string;
  /** size in bytes */
  size: number;
  /** mime type, best-effort */
  mime?: string;
  /** SDK file id, populated once upload completes */
  fileId?: string;
  /** base64 bytes cached locally for clipboard pastes; uploaded at send-time */
  pendingBase64?: string;
  status: AttachmentStatus;
  error?: string;
};

export const MAX_FILES = 10;
export const WARN_BYTES = 10 * 1024 * 1024;

function newLocalId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createStore() {
  const { subscribe, update, set } = writable<Attachment[]>([]);

  function add(a: Omit<Attachment, "localId" | "status"> & Partial<Pick<Attachment, "localId" | "status">>): Attachment {
    const item: Attachment = {
      localId: a.localId ?? newLocalId(),
      status: a.status ?? "uploading",
      ...a,
    } as Attachment;
    update((list) => {
      if (list.length >= MAX_FILES) return list;
      return [...list, item];
    });
    return item;
  }

  function patch(localId: string, patch: Partial<Attachment>): void {
    update((list) =>
      list.map((a) => (a.localId === localId ? { ...a, ...patch } : a)),
    );
  }

  function remove(localId: string): void {
    update((list) => list.filter((a) => a.localId !== localId));
  }

  function clear(): void {
    set([]);
  }

  function readyFileIds(): string[] {
    return get({ subscribe })
      .filter((a) => a.status === "ready" && !!a.fileId)
      .map((a) => a.fileId!) as string[];
  }

  function count(): number {
    return get({ subscribe }).length;
  }

  return { subscribe, add, patch, remove, clear, readyFileIds, count };
}

export const attachments = createStore();

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
