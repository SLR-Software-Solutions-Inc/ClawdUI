import { writable, get } from "svelte/store";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Extension } from "@codemirror/state";
// `lang-javascript` is kept eager so the most common file types (ts/js/tsx/jsx)
// have syntax highlighting on first paint without an extra network round-trip.
import { javascript } from "@codemirror/lang-javascript";

export type EditorLanguage =
  | "javascript"
  | "typescript"
  | "rust"
  | "python"
  | "html"
  | "css"
  | "json"
  | "markdown"
  | "plain";

export interface EditorTab {
  path: string;
  name: string;
  /** Current in-editor buffer. Diverges from `original` while user types. */
  content: string;
  /** Last-saved (or last-loaded) content. Used to compute `dirty`. */
  original: string;
  dirty: boolean;
  language: EditorLanguage;
  /** Set true the first time the file is read, so the editor can mount. */
  loaded: boolean;
  error: string | null;
}

export interface EditorState {
  openTabs: EditorTab[];
  activeTab: string | null;
}

const STORAGE_KEY = "clawdui.editor.v1";
const MAX_TABS = 24;

interface PersistShape {
  paths: string[];
  active: string | null;
}

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

export function detectLanguage(path: string): EditorLanguage {
  const lower = path.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "rs":
      return "rust";
    case "py":
    case "pyi":
      return "python";
    case "html":
    case "htm":
    case "svelte":
    case "vue":
      return "html";
    case "css":
    case "scss":
    case "sass":
    case "less":
      return "css";
    case "json":
    case "jsonc":
      return "json";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    default:
      return "plain";
  }
}

/**
 * Lazy-load the CodeMirror language extension for a given logical language.
 *
 * Each non-JS lang lives in its own dynamically-imported chunk so the editor
 * payload stays small until a file of that type is actually opened. Results
 * are cached so re-activating a previously-opened tab is instantaneous.
 *
 * Returns `null` for `plain` (no syntax highlighting needed).
 */
const langCache = new Map<EditorLanguage, Extension | null>();

export async function loadLanguage(
  lang: EditorLanguage,
): Promise<Extension | null> {
  if (langCache.has(lang)) return langCache.get(lang) ?? null;
  let ext: Extension | null = null;
  switch (lang) {
    case "typescript":
      ext = javascript({ typescript: true, jsx: true });
      break;
    case "javascript":
      ext = javascript({ jsx: true });
      break;
    case "rust": {
      const m = await import("@codemirror/lang-rust");
      ext = m.rust();
      break;
    }
    case "python": {
      const m = await import("@codemirror/lang-python");
      ext = m.python();
      break;
    }
    case "html": {
      const m = await import("@codemirror/lang-html");
      ext = m.html();
      break;
    }
    case "css": {
      const m = await import("@codemirror/lang-css");
      ext = m.css();
      break;
    }
    case "json": {
      const m = await import("@codemirror/lang-json");
      ext = m.json();
      break;
    }
    case "markdown": {
      const m = await import("@codemirror/lang-markdown");
      ext = m.markdown();
      break;
    }
    default:
      ext = null;
  }
  langCache.set(lang, ext);
  return ext;
}

function loadPersisted(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { paths: [], active: null };
    const parsed = JSON.parse(raw);
    return {
      paths: Array.isArray(parsed.paths)
        ? parsed.paths.filter((p: unknown): p is string => typeof p === "string")
        : [],
      active: typeof parsed.active === "string" ? parsed.active : null,
    };
  } catch {
    return { paths: [], active: null };
  }
}

function persist(state: EditorState): void {
  try {
    const data: PersistShape = {
      paths: state.openTabs.map((t) => t.path),
      active: state.activeTab,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

const store = writable<EditorState>({ openTabs: [], activeTab: null });

store.subscribe((s) => persist(s));

function makeTabSkeleton(path: string): EditorTab {
  return {
    path,
    name: basename(path) || path,
    content: "",
    original: "",
    dirty: false,
    language: detectLanguage(path),
    loaded: false,
    error: null,
  };
}

async function loadFile(path: string): Promise<{ content: string; error: string | null }> {
  try {
    const content = await readTextFile(path);
    return { content, error: null };
  } catch (err) {
    return {
      content: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Open a file in a new tab (or focus the existing tab).
 * Reads the file from disk; on error the tab is created with `error` set.
 */
export async function openFile(path: string): Promise<void> {
  const current = get(store);
  const existing = current.openTabs.find((t) => t.path === path);
  if (existing) {
    store.update((s) => ({ ...s, activeTab: path }));
    return;
  }
  const skeleton = makeTabSkeleton(path);
  // Insert immediately so user sees the tab while we read.
  store.update((s) => {
    const next = [...s.openTabs, skeleton];
    // Cap pathological states; drop oldest non-active, non-dirty if needed.
    if (next.length > MAX_TABS) {
      const idx = next.findIndex((t) => t.path !== path && !t.dirty);
      if (idx >= 0) next.splice(idx, 1);
    }
    return { openTabs: next, activeTab: path };
  });
  const { content, error } = await loadFile(path);
  store.update((s) => {
    const tabs = s.openTabs.map((t) =>
      t.path === path
        ? { ...t, content, original: content, error, loaded: true, dirty: false }
        : t,
    );
    return { ...s, openTabs: tabs };
  });
}

export function switchTab(path: string): void {
  store.update((s) =>
    s.openTabs.some((t) => t.path === path) ? { ...s, activeTab: path } : s,
  );
}

export function closeTab(path: string): void {
  store.update((s) => {
    const idx = s.openTabs.findIndex((t) => t.path === path);
    if (idx < 0) return s;
    const next = s.openTabs.slice();
    next.splice(idx, 1);
    let active = s.activeTab;
    if (active === path) {
      active =
        next[idx]?.path ?? next[idx - 1]?.path ?? next[next.length - 1]?.path ?? null;
    }
    return { openTabs: next, activeTab: active };
  });
}

export function updateContent(path: string, content: string): void {
  store.update((s) => {
    const tabs = s.openTabs.map((t) => {
      if (t.path !== path) return t;
      const dirty = t.loaded ? content !== t.original : false;
      return { ...t, content, dirty };
    });
    return { ...s, openTabs: tabs };
  });
}

/** Mark a tab as dirty without changing its content (rare; e.g. external delete). */
export function markDirty(path: string, dirty: boolean): void {
  store.update((s) => {
    const tabs = s.openTabs.map((t) => (t.path === path ? { ...t, dirty } : t));
    return { ...s, openTabs: tabs };
  });
}

/** Save the active tab to disk. Returns the saved path or null if no active tab. */
export async function saveActive(): Promise<{ path: string; name: string } | null> {
  const state = get(store);
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab || !tab.loaded) return null;
  await writeTextFile(tab.path, tab.content);
  store.update((s) => ({
    ...s,
    openTabs: s.openTabs.map((t) =>
      t.path === tab.path ? { ...t, original: t.content, dirty: false } : t,
    ),
  }));
  return { path: tab.path, name: tab.name };
}

/** Re-open tabs persisted to localStorage. Call once on app mount. */
export async function restorePersisted(): Promise<void> {
  const persisted = loadPersisted();
  if (persisted.paths.length === 0) return;
  for (const p of persisted.paths) {
    await openFile(p);
  }
  if (persisted.active) {
    switchTab(persisted.active);
  }
}

export const editorTabs = {
  subscribe: store.subscribe,
  openFile,
  closeTab,
  switchTab,
  updateContent,
  saveActive,
  markDirty,
  restorePersisted,
};
