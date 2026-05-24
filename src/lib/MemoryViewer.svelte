<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
  import { homeDir } from "@tauri-apps/api/path";
  import { X } from "./icons";
  import { settings } from "./settings";
  import { isTauri } from "./systemStatus";
  import { openFile } from "./externalEditor";

  /**
   * Read-only viewer for the three CLAUDE memory files the user might want
   * to inspect at a glance:
   *
   *   1. Per-project auto-memory:
   *        ~/.claude/projects/<cwd-encoded>/memory/MEMORY.md
   *      (cwd-encoded == cwd with `/` replaced by `-`)
   *
   *   2. User-global instructions:
   *        ~/.claude/CLAUDE.md
   *
   *   3. Project-checked-in instructions:
   *        <cwd>/CLAUDE.md
   *
   * Sections 2 + 3 collapse — section 1 is the primary view and stays open.
   *
   * Edits go through the existing externalEditor helper. Browser preview
   * shows a placeholder instead of attempting file reads (the safeInvoke
   * shim would toast "unavailable" on every read otherwise).
   */

  export let open = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  let memoryContent: string | null = null;
  let memoryPath = "";
  let memoryErr = "";

  let userGlobalContent: string | null = null;
  let userGlobalPath = "";
  let userGlobalErr = "";
  let userGlobalOpen = false;

  let projectContent: string | null = null;
  let projectPath = "";
  let projectErr = "";
  let projectOpen = false;

  let loading = false;
  const inBrowser = !isTauri();

  /**
   * Inline edit-mode state, keyed by section id ("memory" | "userGlobal" | "project").
   * - `editing[id]`     – true when the textarea is mounted for that section
   * - `drafts[id]`      – textarea-bound value (the unsaved buffer)
   * - `originals[id]`   – snapshot of the file content at the time edit was opened
   *                       (used to detect dirty + revert on Cancel)
   * - `savedAt[id]`     – HH:MM stamp shown briefly after a successful write
   */
  type SectionId = "memory" | "userGlobal" | "project";
  let editing: Record<SectionId, boolean> = {
    memory: false,
    userGlobal: false,
    project: false,
  };
  let drafts: Record<SectionId, string> = { memory: "", userGlobal: "", project: "" };
  let originals: Record<SectionId, string> = { memory: "", userGlobal: "", project: "" };
  let savedAt: Record<SectionId, string> = { memory: "", userGlobal: "", project: "" };
  const savedTimers: Record<SectionId, ReturnType<typeof setTimeout> | null> = {
    memory: null, userGlobal: null, project: null,
  };

  $: dirtyMap = {
    memory: editing.memory && drafts.memory !== originals.memory,
    userGlobal: editing.userGlobal && drafts.userGlobal !== originals.userGlobal,
    project: editing.project && drafts.project !== originals.project,
  } as Record<SectionId, boolean>;
  $: anyDirty = dirtyMap.memory || dirtyMap.userGlobal || dirtyMap.project;

  function pathFor(id: SectionId): string {
    return id === "memory" ? memoryPath : id === "userGlobal" ? userGlobalPath : projectPath;
  }
  function contentFor(id: SectionId): string {
    const c = id === "memory" ? memoryContent : id === "userGlobal" ? userGlobalContent : projectContent;
    return c ?? "";
  }
  function setContentFor(id: SectionId, val: string): void {
    if (id === "memory") memoryContent = val;
    else if (id === "userGlobal") userGlobalContent = val;
    else projectContent = val;
  }

  function startEdit(id: SectionId): void {
    if (inBrowser) return;
    const current = contentFor(id);
    drafts[id] = current;
    originals[id] = current;
    editing[id] = true;
    editing = { ...editing };
  }

  function cancelEdit(id: SectionId): void {
    if (dirtyMap[id]) {
      const ok = typeof window !== "undefined"
        ? window.confirm("Discard unsaved changes?")
        : true;
      if (!ok) return;
    }
    editing[id] = false;
    editing = { ...editing };
  }

  function flashSaved(id: SectionId): void {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    savedAt[id] = `${hh}:${mm}`;
    savedAt = { ...savedAt };
    if (savedTimers[id]) clearTimeout(savedTimers[id]!);
    savedTimers[id] = setTimeout(() => {
      savedAt[id] = "";
      savedAt = { ...savedAt };
    }, 3500);
  }

  async function saveEdit(id: SectionId): Promise<void> {
    const path = pathFor(id);
    if (!path) return;
    try {
      await writeTextFile(path, drafts[id]);
      setContentFor(id, drafts[id]);
      originals[id] = drafts[id];
      editing[id] = false;
      editing = { ...editing };
      flashSaved(id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[memory] save failed:", e);
      if (typeof window !== "undefined") {
        window.alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Re-load whenever the panel opens (settings.cwd may have changed since
  // the last open). We also recompute on cwd change while open.
  $: cwd = $settings.cwd ?? "";
  $: if (open) void load(cwd);

  function encodeCwd(cwd: string): string {
    // Claude's project folder convention: replace path separators with `-`.
    // Leading slash on POSIX produces a leading `-`, which is the on-disk shape.
    return cwd.replace(/[\\/]/g, "-");
  }

  async function readOrErr(path: string): Promise<{ content: string | null; err: string }> {
    try {
      if (!(await exists(path))) return { content: null, err: "(file does not exist)" };
      const c = await readTextFile(path);
      return { content: c, err: "" };
    } catch (e) {
      return { content: null, err: e instanceof Error ? e.message : String(e) };
    }
  }

  async function load(currentCwd: string) {
    if (inBrowser) return;
    loading = true;
    try {
      const home = await homeDir();
      const sep = home.endsWith("/") || home.endsWith("\\") ? "" : "/";
      const claudeRoot = `${home}${sep}.claude`;

      // 1. project auto-memory
      if (currentCwd) {
        memoryPath = `${claudeRoot}/projects/${encodeCwd(currentCwd)}/memory/MEMORY.md`;
        const r = await readOrErr(memoryPath);
        memoryContent = r.content;
        memoryErr = r.err;
      } else {
        memoryPath = "";
        memoryContent = null;
        memoryErr = "(no workspace selected)";
      }

      // 2. user global CLAUDE.md
      userGlobalPath = `${claudeRoot}/CLAUDE.md`;
      const ug = await readOrErr(userGlobalPath);
      userGlobalContent = ug.content;
      userGlobalErr = ug.err;

      // 3. project CLAUDE.md
      if (currentCwd) {
        const cwdSep = currentCwd.endsWith("/") || currentCwd.endsWith("\\") ? "" : "/";
        projectPath = `${currentCwd}${cwdSep}CLAUDE.md`;
        const p = await readOrErr(projectPath);
        projectContent = p.content;
        projectErr = p.err;
      } else {
        projectPath = "";
        projectContent = null;
        projectErr = "(no workspace selected)";
      }
    } finally {
      loading = false;
    }
  }

  function close() {
    if (anyDirty) {
      const ok = typeof window !== "undefined"
        ? window.confirm("You have unsaved memory edits. Close anyway?")
        : true;
      if (!ok) return;
    }
    // Drop edit state so the next open is clean.
    editing = { memory: false, userGlobal: false, project: false };
    open = false;
    dispatch("close");
  }

  function onKeydown(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  async function edit(path: string) {
    if (!path) return;
    try {
      await openFile({ path });
    } catch (e) {
      // openFile already routes through safeInvoke; surface unexpected failures.
      // eslint-disable-next-line no-console
      console.warn("[memory] open in editor failed:", e);
    }
  }

  onMount(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", onKeydown);
    }
  });
  onDestroy(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", onKeydown);
    }
  });
</script>

{#if open}
  <button class="scrim" on:click={close} aria-label="Close memory viewer"></button>
  <div class="panel" role="dialog" aria-modal="true" aria-label="Memory viewer">
    <header class="head">
      <div class="title">
        <span class="eyebrow">MEMORY</span>
        <h2>Claude memory &amp; instructions</h2>
      </div>
      <button class="close" on:click={close} aria-label="Close">
        <X size={14} stroke={1.8} />
      </button>
    </header>

    <div class="body">
      {#if inBrowser}
        <p class="placeholder">File access disabled in browser preview — memory editing requires the Tauri build.</p>
      {:else}
        <!-- 1. project auto-memory (primary, always expanded) -->
        <section class="file primary">
          <header class="file-head">
            <div class="file-meta">
              <span class="file-label">Project auto-memory</span>
              <span class="file-path mono" title={memoryPath}>{memoryPath || "(no workspace)"}</span>
            </div>
            <div class="file-actions">
              {#if savedAt.memory}<span class="saved mono">Saved at {savedAt.memory}</span>{/if}
              {#if editing.memory}
                <button class="ghost" type="button" on:click={() => cancelEdit("memory")}>Cancel</button>
                <button class="ghost primary-btn" type="button" disabled={!dirtyMap.memory} on:click={() => void saveEdit("memory")}>Save</button>
              {:else}
                <button class="ghost" type="button" disabled={!memoryPath} on:click={() => startEdit("memory")}>Edit</button>
                <button class="ghost" type="button" disabled={!memoryPath} on:click={() => edit(memoryPath)} title="Open in external editor">Open…</button>
              {/if}
            </div>
          </header>
          {#if loading}
            <p class="placeholder mono">loading…</p>
          {:else if editing.memory}
            <textarea class="content mono editor" bind:value={drafts.memory} spellcheck="false"></textarea>
          {:else if memoryContent != null}
            <pre class="content mono">{memoryContent}</pre>
          {:else}
            <p class="placeholder mono">{memoryErr || "(empty)"}</p>
          {/if}
        </section>

        <!-- 2. user global CLAUDE.md (collapsible) -->
        <details class="file" bind:open={userGlobalOpen}>
          <summary>
            <span class="file-label">User global instructions</span>
            <span class="file-path mono" title={userGlobalPath}>~/.claude/CLAUDE.md</span>
          </summary>
          <div class="details-body">
            <div class="details-actions">
              {#if savedAt.userGlobal}<span class="saved mono">Saved at {savedAt.userGlobal}</span>{/if}
              {#if editing.userGlobal}
                <button class="ghost" type="button" on:click={() => cancelEdit("userGlobal")}>Cancel</button>
                <button class="ghost primary-btn" type="button" disabled={!dirtyMap.userGlobal} on:click={() => void saveEdit("userGlobal")}>Save</button>
              {:else}
                <button class="ghost" type="button" disabled={!userGlobalPath} on:click={() => startEdit("userGlobal")}>Edit</button>
                <button class="ghost" type="button" disabled={!userGlobalPath} on:click={() => edit(userGlobalPath)} title="Open in external editor">Open…</button>
              {/if}
            </div>
            {#if editing.userGlobal}
              <textarea class="content mono editor" bind:value={drafts.userGlobal} spellcheck="false"></textarea>
            {:else if userGlobalContent != null}
              <pre class="content mono">{userGlobalContent}</pre>
            {:else}
              <p class="placeholder mono">{userGlobalErr || "(empty)"}</p>
            {/if}
          </div>
        </details>

        <!-- 3. project-checked-in CLAUDE.md (collapsible) -->
        <details class="file" bind:open={projectOpen}>
          <summary>
            <span class="file-label">Project CLAUDE.md</span>
            <span class="file-path mono" title={projectPath}>{projectPath || "(no workspace)"}</span>
          </summary>
          <div class="details-body">
            <div class="details-actions">
              {#if savedAt.project}<span class="saved mono">Saved at {savedAt.project}</span>{/if}
              {#if editing.project}
                <button class="ghost" type="button" on:click={() => cancelEdit("project")}>Cancel</button>
                <button class="ghost primary-btn" type="button" disabled={!dirtyMap.project} on:click={() => void saveEdit("project")}>Save</button>
              {:else}
                <button class="ghost" type="button" disabled={!projectPath} on:click={() => startEdit("project")}>Edit</button>
                <button class="ghost" type="button" disabled={!projectPath} on:click={() => edit(projectPath)} title="Open in external editor">Open…</button>
              {/if}
            </div>
            {#if editing.project}
              <textarea class="content mono editor" bind:value={drafts.project} spellcheck="false"></textarea>
            {:else if projectContent != null}
              <pre class="content mono">{projectContent}</pre>
            {:else}
              <p class="placeholder mono">{projectErr || "(empty)"}</p>
            {/if}
          </div>
        </details>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: oklch(0 0 0 / 0.55);
    backdrop-filter: blur(4px);
    z-index: 50;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(900px, 92vw);
    max-width: 900px;
    max-height: 85vh;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-3, 10px);
    box-shadow: var(--shadow-lg);
    display: grid;
    grid-template-rows: auto 1fr;
    z-index: 51;
    animation: slide-up var(--dur-2) var(--ease);
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    padding: 14px 18px 10px;
    border-bottom: 1px solid var(--border);
  }
  .title h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 19.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .eyebrow {
    font-family: var(--font-mono);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--fg-4);
  }
  .close {
    margin-left: auto;
    width: 30px;
    height: 30px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg-2);
    border-radius: var(--r-2);
    cursor: pointer;
    font-size: 16px;
  }
  .close:hover { color: var(--fg); border-color: var(--border-hi); }

  .body {
    overflow-y: auto;
    padding: 14px 18px 22px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
  }

  .file {
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    background: var(--surface);
    padding: 10px 12px;
  }
  .file.primary {
    border-color: var(--border-hi);
  }
  .file-head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }
  .file-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .file-label {
    font-weight: 600;
    font-size: 14.5px;
    color: var(--fg);
  }
  .file-path {
    font-size: 12px;
    color: var(--fg-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  details.file > summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0;
  }
  details.file > summary::before {
    content: "▸";
    color: var(--fg-4);
    margin-right: 6px;
    display: inline-block;
  }
  details.file[open] > summary::before {
    content: "▾";
  }
  details.file > summary .file-label,
  details.file > summary .file-path {
    display: inline-block;
  }
  .details-body {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .details-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }
  .file-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }
  .saved {
    font-size: 11.5px;
    color: var(--success, #6ce28a);
    margin-right: 4px;
  }
  .editor {
    width: 100%;
    min-height: 240px;
    resize: vertical;
    background: var(--bg);
    border: 1px solid var(--border-hi, var(--border));
    border-radius: var(--r-1);
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--fg);
    font-family: var(--font-mono);
    white-space: pre;
    overflow: auto;
    outline: none;
  }
  .editor:focus { border-color: var(--accent, var(--border-hi)); }
  .primary-btn {
    color: var(--accent, var(--fg));
    border-color: var(--accent, var(--border-hi));
  }

  .ghost {
    background: transparent;
    color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 4px 10px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  .ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--border-hi); }
  .ghost:disabled { opacity: 0.4; cursor: not-allowed; }

  .content {
    margin: 0;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--fg-2);
    max-height: 50vh;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .placeholder {
    color: var(--fg-3);
    font-size: 13.5px;
    margin: 0;
    padding: 6px 0;
  }
</style>
