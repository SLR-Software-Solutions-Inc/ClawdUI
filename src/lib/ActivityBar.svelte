<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { ActivityItem } from "./activity";

  export let items: ActivityItem[] = [];
  export let activeId: string | null = null;
  export let position: "left" | "right" = "left";
  /** Optional data-tour anchor id for the onboarding tour. */
  export let tourId: string | null = null;

  const dispatch = createEventDispatcher<{ toggle: { id: string } }>();

  $: top = items.filter((i) => (i.position ?? "top") === "top");
  $: bottom = items.filter((i) => i.position === "bottom");

  function onClick(id: string) {
    dispatch("toggle", { id });
  }
</script>

<nav class="activity-bar" data-side={position} data-tour={tourId} aria-label="{position} activity bar">
  <ul class="group top">
    {#each top as item (item.id)}
      <li>
        <button
          type="button"
          class="ic"
          class:active={activeId === item.id}
          class:break={item.groupBreak}
          title={[
            item.label,
            item.statusLabel ? `— ${item.statusLabel}` : null,
            item.shortcut ? `· ${item.shortcut}` : null,
          ].filter(Boolean).join(" ")}
          aria-label={item.statusLabel ? `${item.label}, ${item.statusLabel}` : item.label}
          aria-keyshortcuts={item.shortcut}
          aria-pressed={activeId === item.id}
          data-tour-item={item.id}
          on:click={() => onClick(item.id)}
        >
          <span class="glyph" aria-hidden="true">
            <svelte:component this={item.icon} size={20} stroke={1.6} />
          </span>
          {#if item.status}
            <span class="status-dot" data-status={item.status} aria-hidden="true"></span>
          {/if}
          {#if activeId === item.id}
            <span class="indicator" aria-hidden="true"></span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if bottom.length}
    <ul class="group bottom">
      {#each bottom as item (item.id)}
        <li>
          <button
            type="button"
            class="ic"
            class:active={activeId === item.id}
            class:break={item.groupBreak}
            title={[
              item.label,
              item.statusLabel ? `— ${item.statusLabel}` : null,
              item.shortcut ? `· ${item.shortcut}` : null,
            ].filter(Boolean).join(" ")}
            aria-label={item.label}
            aria-keyshortcuts={item.shortcut}
            aria-pressed={activeId === item.id}
            data-tour-item={item.id}
            on:click={() => onClick(item.id)}
          >
            <span class="glyph" aria-hidden="true">
              <svelte:component this={item.icon} size={20} stroke={1.6} />
            </span>
            {#if activeId === item.id}
              <span class="indicator" aria-hidden="true"></span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>

<style>
  .activity-bar {
    width: 48px;
    flex: 0 0 48px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    height: 100%;
    background: color-mix(in oklch, var(--surface) 90%, black);
    border-right: 1px solid var(--border);
    padding: 8px 0;
    user-select: none;
  }
  .activity-bar[data-side="right"] {
    border-right: none;
    border-left: 1px solid var(--border);
  }
  .group {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .group.top { flex: 0 0 auto; }
  .group.bottom {
    flex: 0 0 auto;
    border-top: 1px solid var(--line);
    padding-top: 6px;
    margin-top: 6px;
  }
  li { margin: 0; padding: 0; }
  /* Visual divider above an item — used to split navigation (workspace /
     sessions / worktrees) from tools (skills) inside the same top group
     without splitting the .group ul. */
  li:has(.ic.break) {
    border-top: 1px solid var(--line);
    margin-top: 8px;
    padding-top: 6px;
  }
  .ic {
    position: relative;
    width: 48px;
    height: 40px;
    background: transparent;
    border: 0;
    color: var(--fg-3);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 120ms ease-out;
  }
  .ic:hover { color: var(--fg); }
  .ic.active { color: var(--accent); }
  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    color: currentColor;
  }
  .indicator {
    position: absolute;
    top: 6px;
    bottom: 6px;
    width: 2px;
    background: var(--accent);
    border-radius: 2px;
  }
  .activity-bar[data-side="left"] .indicator { left: 0; }
  .activity-bar[data-side="right"] .indicator { right: 0; }
  .ic:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -4px;
  }
  .status-dot {
    position: absolute;
    bottom: 6px;
    right: 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid color-mix(in oklch, var(--surface) 90%, black);
    pointer-events: none;
  }
  .status-dot[data-status="ok"] {
    background: oklch(0.75 0.18 145);
    box-shadow: 0 0 4px color-mix(in oklch, oklch(0.75 0.18 145) 60%, transparent);
  }
  .status-dot[data-status="bad"] {
    background: oklch(0.65 0.22 25);
  }
  .status-dot[data-status="warn"] {
    background: oklch(0.78 0.16 80);
  }
  .status-dot[data-status="neutral"] {
    background: var(--fg-3);
  }
</style>
