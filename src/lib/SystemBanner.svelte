<script lang="ts">
  // Thin top-of-shell banner. Renders only when systemStatus exposes a
  // notice and the user hasn't already dismissed it for the current
  // session. Priority handled inside the store.
  import { createEventDispatcher } from "svelte";
  import { bannerNotice, dismissNotice } from "./systemStatus";

  const dispatch = createEventDispatcher<{ action: string }>();

  function onAction(cmd: string | undefined): void {
    if (!cmd) return;
    dispatch("action", cmd);
  }
</script>

{#if $bannerNotice}
  {@const n = $bannerNotice}
  <div class="banner {n.kind}" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true"></span>
    <span class="msg">{n.message}</span>
    {#if n.action}
      {#if n.action.href}
        <a
          class="action"
          href={n.action.href}
          target="_blank"
          rel="noreferrer"
        >{n.action.label}</a>
      {:else}
        <button
          class="action"
          type="button"
          on:click={() => onAction(n.action?.cmd)}
        >{n.action.label}</button>
      {/if}
    {/if}
    <button
      class="close"
      type="button"
      title="Dismiss"
      aria-label="Dismiss notice"
      on:click={() => dismissNotice(n.key)}
    >×</button>
  </div>
{/if}

<style>
  .banner {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.2;
    border-bottom: 1px solid var(--border);
    background: var(--elevated);
    color: var(--fg-2);
    z-index: 5;
  }
  .banner.warn {
    background: oklch(0.30 0.08 75 / 0.6);
    color: var(--fg);
    border-bottom-color: oklch(0.40 0.10 75);
  }
  .banner.error {
    background: oklch(0.28 0.12 25 / 0.7);
    color: var(--fg);
    border-bottom-color: oklch(0.40 0.15 25);
  }
  .banner.info {
    background: oklch(0.28 0.05 240 / 0.5);
    color: var(--fg);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: currentColor;
    opacity: 0.75;
    flex-shrink: 0;
  }
  .msg {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid currentColor;
    color: inherit;
    border-radius: 4px;
    padding: 2px 8px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    text-decoration: none;
    transition: background 120ms ease-out;
  }
  .action:hover {
    background: oklch(1 0 0 / 0.08);
  }
  .close {
    flex: 0 0 auto;
    background: transparent;
    border: none;
    color: inherit;
    opacity: 0.7;
    font-size: 16px;
    line-height: 1;
    padding: 0 4px;
    cursor: pointer;
  }
  .close:hover { opacity: 1; }
</style>
