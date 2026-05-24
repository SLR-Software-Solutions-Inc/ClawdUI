<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import FileTree from "./FileTree.svelte";
  import {
    workspace,
    openWorkspace,
    closeWorkspace,
    setWorkspace,
    removeRecent,
    addAdditionalDirectory,
    removeAdditionalDirectory,
  } from "./workspace";
  import { settings } from "./settings";

  const dispatch = createEventDispatcher<{
    "file-selected": { path: string };
    "pivot-cwd": { cwd: string | null };
  }>();

  let recentOpen = false;

  async function handleOpen(): Promise<void> {
    try {
      const picked = await openWorkspace();
      if (picked) dispatch("pivot-cwd", { cwd: picked });
    } catch (err) {
      console.error("openWorkspace failed", err);
    }
  }

  function handleClose(): void {
    closeWorkspace();
    dispatch("pivot-cwd", { cwd: null });
  }

  async function handleAdd(): Promise<void> {
    try {
      const added = await addAdditionalDirectory();
      // Adding an extra folder does NOT change primary cwd — pass the current
      // workspace so the parent restarts the session with the same root +
      // the freshly-extended additionalDirectories list (the SDK reads it
      // from settings via settingsToSDKOptions).
      if (added) dispatch("pivot-cwd", { cwd: $workspace.current ?? null });
    } catch (err) {
      console.error("addAdditionalDirectory failed", err);
    }
  }

  function handleRemoveAdditional(p: string): void {
    removeAdditionalDirectory(p);
    dispatch("pivot-cwd", { cwd: $workspace.current ?? null });
  }

  $: additional = ($settings.additionalDirectories ?? []) as string[];

  function handleRecent(p: string): void {
    setWorkspace(p);
    recentOpen = false;
    dispatch("pivot-cwd", { cwd: p });
  }

  function basename(p: string): string {
    const cleaned = p.replace(/[\\/]+$/, "");
    const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
    return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
  }
</script>

<div class="ws">
  <div class="ws-actions">
    <button class="ws-btn" type="button" on:click={() => void handleOpen()}>
      Open folder…
    </button>
    {#if $workspace.recent.length > 0}
      <div class="recent">
        <button
          class="recent-toggle mono"
          type="button"
          on:click={() => (recentOpen = !recentOpen)}
          aria-expanded={recentOpen}
        >
          {recentOpen ? "▾" : "▸"} recent ({$workspace.recent.length})
        </button>
        {#if recentOpen}
          <ul class="recent-list">
            {#each $workspace.recent as p (p)}
              <li class="recent-row">
                <button
                  class="recent-item"
                  type="button"
                  title={p}
                  on:click={() => handleRecent(p)}
                >
                  <span class="recent-name">{basename(p)}</span>
                  <span class="recent-path mono">{p}</span>
                </button>
                <button
                  class="recent-x mono"
                  type="button"
                  title="Forget"
                  on:click={() => removeRecent(p)}
                >
                  ×
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    {#if $workspace.current}
      <div class="ws-current">
        <button
          class="ws-close mono"
          type="button"
          title="Close workspace"
          on:click={() => handleClose()}
        >
          close workspace
        </button>
      </div>
    {/if}
  </div>

  {#if $workspace.current}
    <div class="ws-tree">
      <FileTree
        path={$workspace.current}
        on:fileSelected={(e) => dispatch("file-selected", e.detail)}
      />
    </div>

    <div class="ws-extra">
      <div class="ws-extra-head">
        <span class="ws-extra-eyebrow mono">ADDITIONAL FOLDERS</span>
        <button
          class="ws-extra-add mono"
          type="button"
          title="Open another folder for the agent to work across"
          on:click={() => void handleAdd()}
        >+ add folder</button>
      </div>
      {#if additional.length > 0}
        {#each additional as p (p)}
          <div class="ws-extra-card">
            <div class="ws-extra-row">
              <span class="ws-extra-name" title={p}>{basename(p)}</span>
              <button
                class="ws-extra-x mono"
                type="button"
                title="Remove from workspace"
                on:click={() => handleRemoveAdditional(p)}
              >×</button>
            </div>
            <div class="ws-extra-tree">
              <FileTree
                path={p}
                on:fileSelected={(e) => dispatch("file-selected", e.detail)}
              />
            </div>
          </div>
        {/each}
      {:else}
        <div class="ws-extra-empty mono">no extras — agent only sees the primary folder</div>
      {/if}
    </div>
  {:else}
    <div class="empty mono">no workspace</div>
  {/if}
</div>

<style>
  .ws {
    padding: 10px 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .ws-actions { display: flex; flex-direction: column; gap: 6px; }
  .ws-btn {
    padding: 6px 8px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    color: var(--fg);
    font: inherit;
    font-size: 15.5px;
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
  }
  .ws-btn:hover { background: var(--surface); border-color: var(--accent-line); }
  .recent { display: flex; flex-direction: column; gap: 2px; }
  .recent-toggle {
    background: transparent;
    border: none;
    padding: 4px 4px;
    text-align: left;
    color: var(--fg-3);
    font-size: 13.5px;
    cursor: pointer;
    letter-spacing: 0.04em;
  }
  .recent-toggle:hover { color: var(--fg); }
  .recent-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .recent-row { display: flex; align-items: stretch; gap: 2px; }
  .recent-item {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 4px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    color: var(--fg-2);
    font: inherit;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
  }
  .recent-item:hover {
    background: var(--elevated);
    color: var(--fg);
    border-color: var(--border);
  }
  .recent-name {
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent-path {
    font-size: 12.5px;
    color: var(--fg-4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent-x {
    width: 22px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    color: var(--fg-4);
    cursor: pointer;
    font-size: 15.5px;
  }
  .recent-x:hover { color: var(--accent); border-color: var(--border); }
  .ws-current { padding: 4px 0 0; }
  .ws-close {
    background: transparent;
    border: none;
    color: var(--fg-4);
    font-size: 13.5px;
    padding: 0 4px;
    cursor: pointer;
    letter-spacing: 0.04em;
  }
  .ws-close:hover { color: var(--accent); }
  .ws-tree {
    margin: 0 8px 8px;
    padding: 8px 4px;
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    background: var(--bg);
    max-height: 60vh;
    overflow-y: auto;
  }
  .empty {
    padding: 10px;
    margin: 0 8px;
    font-size: 14.5px;
    color: var(--fg-4);
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: var(--r-2);
  }

  .ws-extra {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 4px 8px 8px;
  }
  .ws-extra-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 2px 0;
  }
  .ws-extra-eyebrow {
    font-size: 11.5px;
    color: var(--fg-4);
    letter-spacing: 0.12em;
  }
  .ws-extra-add {
    background: transparent;
    border: 1px dashed var(--border-hi);
    border-radius: var(--r-1);
    color: var(--accent);
    font: inherit;
    font-size: 12.5px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .ws-extra-add:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .ws-extra-card {
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    background: var(--bg);
    overflow: hidden;
  }
  .ws-extra-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 8px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .ws-extra-name {
    font-size: 13.5px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ws-extra-x {
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    color: var(--fg-4);
    font-size: 14.5px;
    padding: 0 6px;
    cursor: pointer;
  }
  .ws-extra-x:hover { color: var(--accent); border-color: var(--border); }
  .ws-extra-tree {
    padding: 6px 4px;
    max-height: 30vh;
    overflow-y: auto;
  }
  .ws-extra-empty {
    padding: 8px;
    font-size: 12px;
    color: var(--fg-4);
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: var(--r-1);
  }
</style>
