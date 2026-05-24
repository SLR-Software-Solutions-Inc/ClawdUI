<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { readDir } from "@tauri-apps/plugin-fs";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { openFile as openInExternalEditor } from "./externalEditor";
  import { ChevronDown, ChevronRight, Folder } from "./icons";

  export let path: string;
  export let showHidden = true;

  // Context-menu state (right-click on a file row).
  let menuOpen = false;
  let menuX = 0;
  let menuY = 0;
  let menuPath: string | null = null;

  function openMenu(e: MouseEvent, nodePath: string, kind: EntryKind) {
    if (kind !== "file") return;
    e.preventDefault();
    e.stopPropagation();
    menuPath = nodePath;
    menuX = e.clientX;
    menuY = e.clientY;
    menuOpen = true;
  }

  function closeMenu() {
    menuOpen = false;
    menuPath = null;
  }

  async function handleOpenExternal() {
    if (!menuPath) return;
    const target = menuPath;
    closeMenu();
    try {
      await openInExternalEditor({ path: target });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("external editor open failed", msg);
    }
  }

  onMount(() => {
    const onDocClick = () => closeMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);

    // Refresh trigger A: re-fetch when window or webview regains focus.
    // Covers the common "user deleted/added files in Finder, then tabs back".
    const onWinFocus = () => { void refreshAll(); };
    window.addEventListener("focus", onWinFocus);

    let unlistenTauri: (() => void) | null = null;
    (async () => {
      try {
        const w = getCurrentWindow();
        const u = await w.onFocusChanged(({ payload: focused }) => {
          if (focused) void refreshAll();
        });
        unlistenTauri = u;
      } catch {
        // Non-Tauri context (e.g. SSR / tests): silently ignore.
      }
    })();

    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onWinFocus);
      if (unlistenTauri) unlistenTauri();
    };
  });

  type EntryKind = "dir" | "file";
  interface Node {
    name: string;
    path: string;
    kind: EntryKind;
    expanded: boolean;
    loaded: boolean;
    loading: boolean;
    error: string | null;
    children: Node[];
  }

  const dispatch = createEventDispatcher<{ fileSelected: { path: string } }>();

  let root: Node | null = null;
  let rootError: string | null = null;
  let rootLoading = false;
  // In-flight guard for refreshAll() so focus events that fire while a
  // refresh is mid-walk don't stack up duplicate readDir calls.
  let refreshing = false;
  let refreshQueued = false;

  function joinPath(parent: string, name: string): string {
    if (parent.endsWith("/") || parent.endsWith("\\")) return parent + name;
    // Use forward slash; Tauri normalizes both on Windows.
    const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
    return parent + sep + name;
  }

  function basename(p: string): string {
    const cleaned = p.replace(/[\\/]+$/, "");
    const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
    return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
  }

  function makeNode(name: string, fullPath: string, kind: EntryKind): Node {
    return {
      name,
      path: fullPath,
      kind,
      expanded: false,
      loaded: false,
      loading: false,
      error: null,
      children: [],
    };
  }

  function sortNodes(nodes: Node[]): Node[] {
    return [...nodes].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }

  function filterHidden(nodes: Node[]): Node[] {
    if (showHidden) return nodes;
    return nodes.filter((n) => !n.name.startsWith("."));
  }

  // Live filter — typed into the input above the tree. Matches case-
  // insensitively against the node name OR any descendant name, so a hit
  // deep in the tree still shows its ancestor chain.
  let filterQuery = "";
  function nodeMatches(node: Node, q: string): boolean {
    if (!q) return true;
    if (node.name.toLowerCase().includes(q)) return true;
    if (node.kind === "dir" && node.children.length > 0) {
      return node.children.some((c) => nodeMatches(c, q));
    }
    return false;
  }
  function applyFilter(nodes: Node[], q: string): Node[] {
    const norm = q.trim().toLowerCase();
    if (!norm) return nodes;
    return nodes.filter((n) => nodeMatches(n, norm));
  }

  async function loadChildren(node: Node): Promise<void> {
    node.loading = true;
    node.error = null;
    root = root; // trigger
    try {
      const entries = await readDir(node.path);
      const children: Node[] = entries
        .filter((e) => e.name && e.name !== "." && e.name !== "..")
        .map((e) => {
          const kind: EntryKind = e.isDirectory ? "dir" : "file";
          return makeNode(e.name, joinPath(node.path, e.name), kind);
        });
      node.children = sortNodes(children);
      node.loaded = true;
    } catch (err) {
      node.error = err instanceof Error ? err.message : String(err);
    } finally {
      node.loading = false;
      root = root;
    }
  }

  async function toggle(node: Node): Promise<void> {
    if (node.kind === "file") {
      dispatch("fileSelected", { path: node.path });
      return;
    }
    if (!node.expanded) {
      node.expanded = true;
      if (!node.loaded) {
        await loadChildren(node);
      } else {
        root = root;
      }
    } else {
      node.expanded = false;
      root = root;
    }
  }

  async function refreshRoot(): Promise<void> {
    rootError = null;
    rootLoading = true;
    const node = makeNode(basename(path) || path, path, "dir");
    node.expanded = true;
    try {
      await loadChildren(node);
      root = node;
    } catch (err) {
      rootError = err instanceof Error ? err.message : String(err);
      root = null;
    } finally {
      rootLoading = false;
    }
  }

  // Re-list a single directory node IN PLACE: merge new entries with the
  // existing children so expanded subdirectories keep their open state +
  // already-loaded grandchildren. Entries gone from disk are dropped.
  async function reloadNodeInPlace(node: Node): Promise<void> {
    let fresh: { name: string; isDirectory: boolean }[];
    try {
      const entries = await readDir(node.path);
      fresh = entries
        .filter((e) => e.name && e.name !== "." && e.name !== "..")
        .map((e) => ({ name: e.name as string, isDirectory: !!e.isDirectory }));
      node.error = null;
    } catch (err) {
      node.error = err instanceof Error ? err.message : String(err);
      node.children = [];
      node.loaded = true;
      return;
    }
    const byName = new Map(node.children.map((c) => [c.name, c]));
    const merged: Node[] = [];
    for (const e of fresh) {
      const kind: EntryKind = e.isDirectory ? "dir" : "file";
      const prev = byName.get(e.name);
      if (prev && prev.kind === kind) {
        // Same entry — keep expansion / children; recursion handled below.
        merged.push(prev);
      } else {
        merged.push(makeNode(e.name, joinPath(node.path, e.name), kind));
      }
    }
    node.children = sortNodes(merged);
    node.loaded = true;
    // Recurse into still-expanded dirs.
    for (const child of node.children) {
      if (child.kind === "dir" && child.expanded && child.loaded) {
        await reloadNodeInPlace(child);
      }
    }
  }

  // Refresh trigger (focus + manual button). Re-fetches the root and walks
  // every currently-expanded subdirectory. In-flight protected so rapid
  // focus events don't stack.
  async function refreshAll(): Promise<void> {
    if (!root || !path) return;
    if (refreshing) { refreshQueued = true; return; }
    refreshing = true;
    try {
      do {
        refreshQueued = false;
        await reloadNodeInPlace(root);
        root = root; // trigger reactivity
      } while (refreshQueued);
    } catch (err) {
      // Surface as root error only if nothing else is showing.
      if (!rootError) rootError = err instanceof Error ? err.message : String(err);
    } finally {
      refreshing = false;
    }
  }

  // Re-load when the workspace path changes.
  $: if (path) void refreshRoot();
</script>

<div class="tree" role="tree" aria-label="Workspace file tree">
  <div class="tree-header">
    <span class="tree-title mono" title={path}>{basename(path) || path}</span>
    <button
      type="button"
      class="refresh-btn"
      title="Refresh file tree"
      aria-label="Refresh file tree"
      on:click={() => void refreshAll()}
      disabled={refreshing || rootLoading}
    >
      <span class="refresh-glyph" class:spin={refreshing}>↻</span>
    </button>
  </div>
  <input
    class="tree-filter mono"
    type="text"
    bind:value={filterQuery}
    placeholder="filter files…"
    aria-label="Filter file tree"
    spellcheck="false"
    autocomplete="off"
  />
  {#if rootLoading}
    <div class="muted mono">loading…</div>
  {:else if rootError}
    <div class="error mono">{rootError}</div>
  {:else if root}
    {@const visible = applyFilter(filterHidden(root.children), filterQuery)}
    {#if visible.length === 0}
      <div class="muted mono">{filterQuery ? "no match" : "empty"}</div>
    {:else}
      <ul class="tree-list" role="group">
        {#each visible as node (node.path)}
          {@render renderNode(node, 0)}
        {/each}
      </ul>
    {/if}
  {/if}
</div>

{#if menuOpen && menuPath}
  <div
    class="ctx-menu"
    role="menu"
    style="left: {menuX}px; top: {menuY}px"
    on:click|stopPropagation
    on:keydown={(e) => {
      if (e.key === "Escape") closeMenu();
    }}
    tabindex="-1"
  >
    <button
      type="button"
      class="ctx-item"
      role="menuitem"
      on:click={() => void handleOpenExternal()}
    >
      Open in external editor
    </button>
  </div>
{/if}

{#snippet renderNode(node: Node, depth: number)}
  {@const padding = 6 + depth * 12}
  {@const forceExpand = filterQuery.trim().length > 0 && node.kind === "dir" && node.loaded}
  <li
    role="treeitem"
    aria-expanded={node.kind === "dir" ? node.expanded : undefined}
    aria-selected="false"
  >
    <button
      type="button"
      class="row {node.kind}"
      style="padding-left: {padding}px"
      on:click={() => void toggle(node)}
      on:contextmenu={(e) => openMenu(e, node.path, node.kind)}
      title={node.path}
    >
      <span class="caret" aria-hidden="true">
        {#if node.kind === "dir"}
          {#if node.expanded}<ChevronDown size={11} stroke={1.7} />{:else}<ChevronRight size={11} stroke={1.7} />{/if}
        {:else}
          <span class="dot">·</span>
        {/if}
      </span>
      <span class="name">{node.name}</span>
      {#if node.loading}
        <span class="hint mono">…</span>
      {/if}
    </button>
    {#if node.kind === "dir" && (node.expanded || forceExpand)}
      {#if node.error}
        <div class="error mono" style="padding-left: {padding + 14}px">
          {node.error}
        </div>
      {:else}
        {@const visible = applyFilter(filterHidden(node.children), filterQuery)}
        {#if visible.length === 0 && node.loaded && !node.loading}
          <div class="muted mono" style="padding-left: {padding + 14}px">{filterQuery ? "no match" : "empty"}</div>
        {:else}
          <ul role="group">
            {#each visible as child (child.path)}
              {@render renderNode(child, depth + 1)}
            {/each}
          </ul>
        {/if}
      {/if}
    {/if}
  </li>
{/snippet}

<style>
  .tree {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    font-size: 15.5px;
  }
  .tree-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 4px;
  }
  .tree-filter {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 5px 10px;
    border-radius: var(--r-2);
    margin: 6px 4px 8px;
    font: inherit;
    font-size: 12.5px;
    outline: none;
  }
  .tree-filter:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .tree-title {
    color: var(--fg-2);
    font-size: 14.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .refresh-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    color: var(--fg-3);
    cursor: pointer;
    transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
    flex-shrink: 0;
  }
  .refresh-btn:hover:not(:disabled) {
    background: var(--elevated);
    color: var(--fg);
  }
  .refresh-btn:disabled { opacity: 0.5; cursor: default; }
  .refresh-glyph {
    font-size: 14px;
    line-height: 1;
    display: inline-block;
  }
  .refresh-glyph.spin {
    animation: refresh-spin 0.8s linear infinite;
  }
  @keyframes refresh-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .hidden-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 13.5px;
    color: var(--fg-3);
    cursor: pointer;
    user-select: none;
  }
  .hidden-toggle input { accent-color: var(--accent); }

  .tree-list,
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    color: var(--fg-2);
    font: inherit;
    font-size: 15.5px;
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
    overflow: hidden;
  }
  .row:hover { background: var(--elevated); color: var(--fg); }
  .row.file { color: var(--fg-2); }
  .row.dir { color: var(--fg); }

  .caret {
    width: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-4);
    flex-shrink: 0;
  }
  .caret .dot { font-size: 13.5px; line-height: 1; }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .hint {
    margin-left: auto;
    color: var(--fg-4);
    font-size: 13.5px;
  }

  .muted {
    padding: 4px 6px;
    color: var(--fg-4);
    font-size: 13.5px;
  }
  .error {
    padding: 4px 6px;
    color: var(--accent);
    font-size: 13.5px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ctx-menu {
    position: fixed;
    z-index: 1000;
    min-width: 200px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    font-size: 15.5px;
  }
  .ctx-item {
    display: block;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: var(--r-1);
    color: var(--fg);
    font: inherit;
    font-size: 15.5px;
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-1) var(--ease);
  }
  .ctx-item:hover { background: var(--elevated); }
</style>
