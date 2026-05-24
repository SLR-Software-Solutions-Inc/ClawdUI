<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { skills, skillsLoading, refreshSkills, filterSkills, type Skill } from "./skills";
  import { safeInvoke } from "./safeInvoke";

  export let open = false;
  export let embedded = false;
  /** Read-only mode: hides the Insert button. Used by the Settings → Skills tab. */
  export let readOnly = false;

  const dispatch = createEventDispatcher<{
    close: void;
    insert: string;
  }>();

  let q = "";
  let expanded: string | null = null;

  $: filtered = filterSkills(q, $skills);
  $: grouped = groupBySource(filtered);

  function groupBySource(list: Skill[]): { source: string; items: Skill[] }[] {
    const map = new Map<string, Skill[]>();
    for (const s of list) {
      const arr = map.get(s.source) ?? [];
      arr.push(s);
      map.set(s.source, arr);
    }
    return Array.from(map.entries())
      .map(([source, items]) => ({ source, items }))
      .sort((a, b) => a.source.localeCompare(b.source));
  }

  function close() {
    dispatch("close");
  }

  function insert(skill: Skill) {
    dispatch("insert", skill.id);
  }

  function toggleExpand(id: string) {
    expanded = expanded === id ? null : id;
  }

  async function openInFinder(path: string) {
    if (!path) return;
    // The Tauri shell plugin is not bundled; we reuse the external-editor
    // command (which spawns an arbitrary exec) to invoke the OS-native
    // file-manager opener on the parent folder. Falls back to clipboard.
    const dir = path.replace(/\/[^/]+$/, "") || path;
    const platform =
      typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)
        ? "macos"
        : /Win/i.test(navigator.userAgent ?? "")
          ? "windows"
          : "linux";
    const exec =
      platform === "macos" ? "open" : platform === "windows" ? "explorer" : "xdg-open";
    try {
      const res = await safeInvoke("open_in_external_editor", {
        path: dir,
        exec,
        args: [dir],
      });
      if (res === null) {
        // Browser-preview: copy path to clipboard as a graceful fallback.
        try {
          await navigator.clipboard.writeText(dir);
        } catch {
          /* ignore */
        }
      }
    } catch {
      try {
        await navigator.clipboard.writeText(dir);
      } catch {
        /* ignore */
      }
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!open || embedded) return;
    if (e.key === "Escape") close();
  }
</script>

<svelte:window on:keydown={onKey} />

{#if open || embedded}
  {#if !embedded}
    <div class="backdrop" on:click={close} role="presentation"></div>
  {/if}
  <aside
    class="panel"
    class:embedded
    aria-label="Skills"
    role={embedded ? undefined : "dialog"}
    aria-modal={embedded ? undefined : "true"}
  >
    <header class="head">
      <div>
        <span class="eyebrow">SKILLS</span>
        <h2>Available Skills</h2>
        <p class="sub">{$skills.length} discovered · click to insert <code>/&lt;name&gt;</code></p>
      </div>
      <div class="actions">
        <button class="ghost" on:click={() => void refreshSkills()} disabled={$skillsLoading}>
          {$skillsLoading ? "…" : "Refresh"}
        </button>
        <button class="ghost" on:click={close}>Close</button>
      </div>
    </header>

    <div class="search">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        placeholder="Search skills…"
        bind:value={q}
        autofocus
      />
    </div>

    <div class="list">
      {#if $skillsLoading && $skills.length === 0}
        <div class="empty">Loading…</div>
      {:else if filtered.length === 0}
        <div class="empty">No skills match "{q}"</div>
      {:else}
        {#each grouped as group (group.source)}
          <div class="group">
            <div class="group-head mono">{group.source} <span class="cnt">{group.items.length}</span></div>
            {#each group.items as s (s.id)}
              {@const isExp = expanded === s.id}
              <article class="item" class:expanded={isExp}>
                <button class="item-main" on:click={() => readOnly ? toggleExpand(s.id) : insert(s)}>
                  <div class="id mono">{s.id}</div>
                  {#if s.description}
                    <div class="desc" class:clamp={!isExp}>{s.description}</div>
                  {/if}
                </button>
                {#if readOnly}
                  <button class="row-action mono" on:click={() => toggleExpand(s.id)} title={isExp ? "Collapse" : "Expand"}>
                    {isExp ? "▴" : "▾"}
                  </button>
                  {#if isExp && s.path}
                    <button class="row-action mono" on:click={() => void openInFinder(s.path)} title="Open in Finder">
                      ↗
                    </button>
                  {/if}
                {:else}
                  <button class="insert" on:click={() => insert(s)} title="Insert /{s.id}">
                    Insert
                  </button>
                {/if}
              </article>
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  </aside>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: oklch(0 0 0 / 0.45);
    z-index: 50;
    animation: fade var(--dur-2) var(--ease);
  }
  @keyframes fade { from { opacity: 0 } to { opacity: 1 } }

  .panel.embedded {
    position: relative;
    top: auto;
    right: auto;
    bottom: auto;
    inset: auto;
    width: 100%;
    height: 100%;
    border-left: 0;
    border-radius: 0;
    box-shadow: none;
    z-index: auto;
    animation: none;
  }
  .panel.embedded :global(.close) { display: none; }
  .panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(520px, 92vw);
    background: var(--bg);
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-lg, var(--shadow-md));
    z-index: 51;
    display: grid;
    grid-template-rows: auto auto 1fr;
    animation: slide-in var(--dur-2) var(--ease);
  }
  @keyframes slide-in {
    from { transform: translateX(20px); opacity: 0 }
    to { transform: translateX(0); opacity: 1 }
  }

  .head {
    padding: 18px 22px 12px;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .head h2 {
    margin: 2px 0 4px;
    font-family: var(--font-display);
    font-size: 21.5px;
    font-weight: 500;
    letter-spacing: -0.02em;
    color: var(--fg);
  }
  .head .sub {
    margin: 0;
    color: var(--fg-3);
    font-size: 15.5px;
  }
  .head code {
    font-family: var(--font-mono);
    font-size: 14.5px;
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .actions { display: flex; gap: 8px; }
  .ghost {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--fg-2);
    padding: 6px 12px;
    border-radius: var(--r-2);
    font: inherit;
    font-size: 15.5px;
    cursor: pointer;
    transition: border-color var(--dur-1) var(--ease);
  }
  .ghost:hover:not(:disabled) { border-color: var(--accent-line); }
  .ghost:disabled { opacity: 0.5; cursor: progress; }

  .search {
    padding: 10px 22px;
    border-bottom: 1px solid var(--line);
  }
  .search input {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    color: var(--fg);
    font: inherit;
    font-size: 16px;
    padding: 8px 12px;
    transition: border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease);
  }
  .search input:focus {
    outline: none;
    border-color: var(--accent-line);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .list {
    overflow-y: auto;
    padding: 8px 0 22px;
  }
  .empty {
    padding: 32px 22px;
    color: var(--fg-3);
    font-size: 16px;
    text-align: center;
  }

  .group { padding: 8px 0; }
  .group-head {
    padding: 8px 22px 4px;
    color: var(--fg-4);
    font-size: 13.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .item {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 8px;
    padding: 10px 22px;
    border-top: 1px solid var(--line);
    align-items: flex-start;
  }
  .item:hover { background: var(--surface); }
  .item.expanded { background: var(--surface); }
  .item-main {
    min-width: 0;
    background: transparent;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .id {
    font-size: 16px;
    color: var(--fg);
    font-weight: 600;
    word-break: break-word;
  }
  .desc {
    margin-top: 4px;
    color: var(--fg-3);
    font-size: 15.5px;
    line-height: 1.45;
  }
  .desc.clamp {
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .row-action {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--fg-3);
    border-radius: var(--r-1);
    padding: 4px 8px;
    cursor: pointer;
    font-size: 14px;
  }
  .row-action:hover { color: var(--fg); border-color: var(--accent-line, var(--accent)); }
  .group-head .cnt {
    color: var(--fg-3);
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 0 6px;
    border-radius: var(--r-1);
    margin-left: 4px;
  }
  .insert {
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent-line);
    padding: 5px 11px;
    border-radius: var(--r-2);
    font: inherit;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: filter var(--dur-1) var(--ease);
  }
  .insert:hover { filter: brightness(1.15); }
</style>
