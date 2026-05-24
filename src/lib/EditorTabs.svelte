<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { editorTabs, type EditorTab } from "./editorTabs";
  import { openFile as openInExternalEditor } from "./externalEditor";

  const dispatch = createEventDispatcher<{ toast: string }>();

  $: state = $editorTabs;

  function handleClose(tab: EditorTab, e: MouseEvent | KeyboardEvent) {
    e.stopPropagation();
    if (tab.dirty) {
      const ok = confirm(`"${tab.name}" has unsaved changes. Close anyway?`);
      if (!ok) return;
    }
    editorTabs.closeTab(tab.path);
  }

  function handleAuxClick(tab: EditorTab, e: MouseEvent) {
    if (e.button === 1) {
      // Middle-click closes (with confirm if dirty)
      handleClose(tab, e);
    }
  }

  async function handleExternal(tab: EditorTab, e: MouseEvent | KeyboardEvent) {
    e.stopPropagation();
    try {
      await openInExternalEditor({ path: tab.path });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch("toast", `External editor failed: ${msg}`);
    }
  }
</script>

{#if state.openTabs.length > 0}
  <div class="tab-strip" role="tablist" aria-label="Open files">
    {#each state.openTabs as tab (tab.path)}
      {@const active = tab.path === state.activeTab}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        class="tab"
        class:active
        class:dirty={tab.dirty}
        title={tab.path}
        on:click={() => editorTabs.switchTab(tab.path)}
        on:auxclick={(e) => handleAuxClick(tab, e)}
      >
        <span class="name">{tab.name}</span>
        {#if tab.dirty}
          <span class="dirty-dot" aria-label="unsaved" title="Unsaved changes">●</span>
        {/if}
        <span
          class="ext"
          role="button"
          tabindex="-1"
          aria-label={`Open ${tab.name} in external editor`}
          title="Open in external editor"
          on:click={(e) => void handleExternal(tab, e)}
          on:keydown={(e) => {
            if (e.key === "Enter" || e.key === " ") void handleExternal(tab, e);
          }}
        >
          ↗
        </span>
        <span
          class="close"
          role="button"
          tabindex="-1"
          aria-label={`Close ${tab.name}`}
          title="Close"
          on:click={(e) => handleClose(tab, e)}
          on:keydown={(e) => {
            if (e.key === "Enter" || e.key === " ") handleClose(tab, e);
          }}
        >
          ×
        </span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .tab-strip {
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    padding: 0 4px;
    gap: 1px;
    flex: 0 0 auto;
    scrollbar-width: thin;
  }
  .tab-strip::-webkit-scrollbar {
    height: 4px;
  }
  .tab-strip::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 2px;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px 6px 12px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--line);
    color: var(--fg-3);
    font: inherit;
    font-size: 15.5px;
    font-family: var(--font-mono);
    cursor: pointer;
    max-width: 220px;
    flex: 0 0 auto;
    transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
    border-bottom: 2px solid transparent;
  }
  .tab:hover {
    background: var(--elevated);
    color: var(--fg-2);
  }
  .tab.active {
    color: var(--fg);
    background: var(--bg);
    border-bottom-color: var(--accent);
  }
  .tab.active.dirty {
    color: var(--fg);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .dirty-dot {
    color: var(--accent);
    font-size: 12.5px;
    line-height: 1;
  }

  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: var(--fg-4);
    border-radius: var(--r-1);
    font-size: 17px;
    line-height: 1;
    cursor: pointer;
    transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .close:hover {
    color: var(--fg);
    background: var(--border);
  }

  .ext {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: var(--fg-4);
    border-radius: var(--r-1);
    font-size: 14.5px;
    line-height: 1;
    cursor: pointer;
    transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .ext:hover {
    color: var(--fg);
    background: var(--border);
  }
</style>
