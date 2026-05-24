<!--
  Command Palette (⌘K). One overlay, one search box, every navigation +
  action in the app. Parent owns the action list so the palette can stay
  generic (no direct coupling to settings, panes, sidecar state).

  Keyboard: ↑/↓ move, Enter run, Esc close. Type to filter (substring
  match across title + keywords).
-->
<script context="module" lang="ts">
  export type Command = {
    id: string;
    title: string;
    /** Short description / location, shown right-aligned. */
    detail?: string;
    /** Keyword list (lowercased) for fuzzy filtering. */
    keywords?: string[];
    /** Keyboard shortcut display string (e.g. "⌘N"). */
    shortcut?: string;
    /** Executed on Enter / click. Receives no args. */
    run: () => void | Promise<void>;
  };
</script>

<script lang="ts">
  import { onDestroy, tick } from "svelte";

  export let open = false;
  export let commands: Command[] = [];
  export let onClose: () => void = () => {};

  let query = "";
  let activeIdx = 0;
  let inputEl: HTMLInputElement;

  $: filtered = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const haystack = [
        c.title,
        c.detail ?? "",
        ...(c.keywords ?? []),
      ]
        .join(" ")
        .toLowerCase();
      // Substring across token boundaries
      return q.split(/\s+/).every((tok) => haystack.includes(tok));
    });
  })();
  $: if (activeIdx >= filtered.length) activeIdx = Math.max(0, filtered.length - 1);

  $: if (open) {
    query = "";
    activeIdx = 0;
    void tick().then(() => inputEl?.focus());
  }

  function close(): void {
    open = false;
    onClose();
  }
  function run(c: Command): void {
    close();
    void Promise.resolve().then(() => c.run());
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = filtered.length === 0 ? 0 : (activeIdx + 1) % filtered.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = filtered.length === 0
        ? 0
        : (activeIdx - 1 + filtered.length) % filtered.length;
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[activeIdx];
      if (target) run(target);
      return;
    }
  }

  onDestroy(() => { /* nothing — outer key listener handles open toggle */ });
</script>

{#if open}
  <button class="scrim" type="button" aria-label="Close command palette" on:click={close}></button>
  <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="search">
      <span class="pfx mono">⌘K ›</span>
      <input
        bind:this={inputEl}
        bind:value={query}
        on:keydown={onKey}
        type="text"
        placeholder="Search commands, panels, actions…"
        autocomplete="off"
        spellcheck="false"
      />
      <span class="kbd mono">Esc</span>
    </div>
    <ul class="results" role="listbox" aria-label="Command results">
      {#if filtered.length === 0}
        <li class="empty mono">No matches.</li>
      {:else}
        {#each filtered as c, i (c.id)}
          <li>
            <button
              type="button"
              class="row"
              class:active={i === activeIdx}
              role="option"
              aria-selected={i === activeIdx}
              on:mouseenter={() => (activeIdx = i)}
              on:click={() => run(c)}
            >
              <span class="row-title">{c.title}</span>
              {#if c.detail}<span class="row-detail mono">{c.detail}</span>{/if}
              {#if c.shortcut}<span class="row-kbd mono">{c.shortcut}</span>{/if}
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    border: 0;
    cursor: default;
    z-index: 1000;
  }
  .palette {
    position: fixed;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(640px, 92vw);
    background: var(--surface);
    border: 1px solid var(--accent-line);
    border-radius: var(--r-3);
    box-shadow: var(--shadow-lg);
    z-index: 1001;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 70vh;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .pfx {
    color: var(--accent);
    font-size: 12.5px;
    letter-spacing: 0.06em;
  }
  .search input {
    flex: 1;
    background: transparent;
    border: 0;
    color: var(--fg);
    font: inherit;
    font-size: 16px;
    outline: none;
  }
  .kbd {
    font-size: 11px;
    color: var(--fg-4);
    border: 1px solid var(--border-hi);
    padding: 2px 6px;
    border-radius: var(--r-1);
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    background: transparent;
    border: 0;
    text-align: left;
    color: var(--fg);
    padding: 8px 10px;
    border-radius: var(--r-2);
    cursor: pointer;
    font: inherit;
    font-size: 14px;
  }
  .row.active {
    background: var(--accent-soft);
    color: var(--fg);
  }
  .row-title { flex: 1 1 auto; }
  .row-detail {
    color: var(--fg-3);
    font-size: 12px;
  }
  .row-kbd {
    color: var(--fg-3);
    font-size: 11px;
    border: 1px solid var(--border);
    padding: 2px 6px;
    border-radius: var(--r-1);
  }
  .empty {
    color: var(--fg-4);
    padding: 16px;
    text-align: center;
    font-size: 13px;
  }
</style>
