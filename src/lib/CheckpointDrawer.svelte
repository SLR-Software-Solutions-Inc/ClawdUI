<script lang="ts">
  // Worker Z: small overlay listing checkpoints for the active session.
  // Opened from the topbar (button wired in App.svelte) or via the
  // `/checkpoints` slash command.

  import {
    checkpoints,
    listCheckpoints,
    rewindToCheckpoint,
    createCheckpoint,
    forkSession,
    getActiveSessionId,
    relativeTime,
    type Checkpoint,
  } from "./checkpoints";
  import { X as XIcon } from "./icons";

  export let open = false;

  // Re-render every 30s so "Ns ago" labels stay roughly fresh.
  let nowTick = Date.now();
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  $: if (open && !tickTimer) {
    tickTimer = setInterval(() => (nowTick = Date.now()), 30_000);
  }
  $: if (!open && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  // Subscribe to the store so the list re-renders on create/rewind.
  $: rows = (function () {
    void $checkpoints;
    return listCheckpoints();
  })();
  $: sid = getActiveSessionId();

  let newLabel = "";
  function onCreate(): void {
    const cp = createCheckpoint(newLabel || undefined);
    if (cp) newLabel = "";
  }
  function onRewind(cp: Checkpoint): void {
    if (rewindToCheckpoint(cp.id)) open = false;
  }
  function onFork(cp: Checkpoint): void {
    forkSession(cp.id);
    open = false;
  }
  function close(): void {
    open = false;
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" on:click={close}></div>
  <aside class="drawer" role="dialog" aria-label="Checkpoints">
    <header>
      <h2>Checkpoints</h2>
      <button class="icon-btn" on:click={close} title="Close (Esc)">
        <XIcon size={14} stroke={1.7} />
      </button>
    </header>

    {#if !sid}
      <p class="empty">No active session — start a chat to create checkpoints.</p>
    {:else}
      <form class="create" on:submit|preventDefault={onCreate}>
        <input
          type="text"
          placeholder="Label (optional)"
          bind:value={newLabel}
          maxlength="60"
        />
        <button type="submit">Save now</button>
      </form>

      {#if rows.length === 0}
        <p class="empty">No checkpoints yet for this session.</p>
      {:else}
        <ul class="list">
          {#each rows as cp (cp.id)}
            <li>
              <div class="meta">
                <span class="ts">{relativeTime(cp.createdAt, nowTick)}</span>
                {#if cp.label}
                  <span class="label">{cp.label}</span>
                {/if}
                <span class="idx" title="message index">@{cp.messageIndex}</span>
              </div>
              <div class="actions">
                <button on:click={() => onRewind(cp)} title="Truncate transcript to here">
                  Rewind
                </button>
                <button on:click={() => onFork(cp)} title="Fork session at this checkpoint">
                  Fork
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </aside>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 80;
  }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(420px, 92vw);
    background: var(--bg);
    border-left: 1px solid var(--border, #2a2a2a);
    z-index: 81;
    display: flex;
    flex-direction: column;
    padding: 14px 14px 18px;
    overflow-y: auto;
    color: var(--fg);
    font-size: 13px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted, #888);
  }
  .icon-btn {
    background: transparent;
    border: 1px solid var(--border, #2a2a2a);
    color: var(--fg);
    padding: 3px 6px;
    border-radius: 4px;
    cursor: pointer;
  }
  .icon-btn:hover { border-color: var(--accent, #888); }

  .create {
    display: flex;
    gap: 6px;
    margin-bottom: 12px;
  }
  .create input {
    flex: 1;
    background: var(--bg-elev, #1a1a1a);
    border: 1px solid var(--border, #2a2a2a);
    color: var(--fg);
    padding: 5px 8px;
    border-radius: 4px;
    font: inherit;
  }
  .create button {
    background: var(--accent, #6aa);
    color: var(--bg, #000);
    border: 0;
    padding: 5px 10px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }

  .empty {
    color: var(--muted, #888);
    font-style: italic;
    margin: 8px 0;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 4px;
    background: var(--bg-elev, #1a1a1a);
  }
  .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ts { font-weight: 600; }
  .label { color: var(--muted, #aaa); font-size: 12px; }
  .idx { color: var(--muted, #666); font-size: 11px; font-family: ui-monospace, monospace; }
  .actions { display: flex; gap: 4px; flex-shrink: 0; }
  .actions button {
    background: transparent;
    border: 1px solid var(--border, #2a2a2a);
    color: var(--fg);
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .actions button:hover { border-color: var(--accent, #6aa); color: var(--accent, #6aa); }
</style>
