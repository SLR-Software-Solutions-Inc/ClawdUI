<script lang="ts">
  import { settings, patchSettings } from "./settings";
  import type { PermissionMode } from "./types";
  import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
  import {
    DefaultBadge,
    Check,
    AlertTriangle,
    ListTree,
    ChevronDown,
    Keyboard,
  } from "./icons";
  import type { ComponentType, SvelteComponent } from "svelte";

  /**
   * Modern, futuristic inline permission picker.
   *
   * Mirrors ModelPicker's visual language:
   * - Capsule pill trigger with status dot color-coded by mode
   *   (default=accent grey, acceptEdits=green, bypassPermissions=red, plan=amber).
   * - Glass menu (backdrop-blur, alpha bg) with badge + label + sub-label.
   * - Slide + fade open/close (200ms ease-out).
   * - Keyboard: ⌘P opens, ↑↓ navigate, Enter/Space select, Esc close.
   *
   * Emits an `apply` event with the new permissionMode. Parent wires this to
   * `liveApply("permissionMode", value)`.
   */

  // Visual variant — "pill" matches the topbar StatusPill, "cell" sits inside
  // the EmptyState readout grid where a label is already shown above.
  export let variant: "pill" | "cell" = "pill";
  export let disabled = false;
  // Worker U: overlay mode. When `overlayOpen` is bound true by a parent,
  // the picker renders a centered modal listbox (independent of the inline
  // pill). Used by the /permissions slash command.
  export let overlayOpen: boolean = false;

  type Family = "default" | "acceptEdits" | "bypassPermissions" | "plan";
  type FamilyIcon = ComponentType<SvelteComponent<{ size?: number; stroke?: number; title?: string }>>;
  type Preset = {
    id: PermissionMode;
    label: string;
    sub: string;
    family: Family;
  };

  const PRESETS: Preset[] = [
    { id: "default",           label: "default",      sub: "ask before tools",         family: "default" },
    { id: "acceptEdits",       label: "accept edits", sub: "auto-confirm Edit/Write",  family: "acceptEdits" },
    { id: "bypassPermissions", label: "bypass",       sub: "no prompts (dangerous)",   family: "bypassPermissions" },
    { id: "plan",              label: "plan",         sub: "no execution, plan only",  family: "plan" },
  ];

  const FAMILY_ICON: Record<Family, FamilyIcon> = {
    default: DefaultBadge,
    acceptEdits: Check,
    bypassPermissions: AlertTriangle,
    plan: ListTree,
  };

  const dispatch = createEventDispatcher<{ apply: PermissionMode }>();

  let open = false;
  let triggerEl: HTMLButtonElement | null = null;
  let menuEl: HTMLDivElement | null = null;
  let activeIndex = 0;
  let pulseDot = false;
  let positionAbove = false;
  const MENU_HEIGHT_EST = 280;

  $: triggerFamily = ($settings.permissionMode ?? "default") as Family;
  $: triggerPreset = PRESETS.find((p) => p.id === $settings.permissionMode) ?? PRESETS[0];
  $: triggerLabel = triggerPreset.label;

  function currentSelectionIndex(): number {
    const cur = $settings.permissionMode;
    const idx = PRESETS.findIndex((p) => p.id === cur);
    return idx >= 0 ? idx : 0;
  }

  async function toggle(): Promise<void> {
    if (disabled) return;
    open = !open;
    if (open) {
      activeIndex = currentSelectionIndex();
      if (typeof window !== "undefined" && triggerEl) {
        const rect = triggerEl.getBoundingClientRect();
        const below = window.innerHeight - rect.bottom;
        const above = rect.top;
        positionAbove = below < MENU_HEIGHT_EST && above > below;
      }
      await tick();
      if (typeof window !== "undefined" && triggerEl && menuEl) {
        const rect = triggerEl.getBoundingClientRect();
        const mh = menuEl.offsetHeight || MENU_HEIGHT_EST;
        const below = window.innerHeight - rect.bottom;
        const above = rect.top;
        positionAbove = below < mh + 12 && above > below;
      }
      menuEl?.focus();
    }
  }

  function close(): void {
    open = false;
    triggerEl?.focus();
  }

  function pulse(): void {
    pulseDot = false;
    requestAnimationFrame(() => {
      pulseDot = true;
      window.setTimeout(() => (pulseDot = false), 700);
    });
  }

  function pick(preset: Preset): void {
    patchSettings({ permissionMode: preset.id });
    dispatch("apply", preset.id);
    pulse();
    open = false;
    triggerEl?.focus();
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % PRESETS.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + PRESETS.length) % PRESETS.length;
    } else if (e.key === "Home") {
      e.preventDefault();
      activeIndex = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      activeIndex = PRESETS.length - 1;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(PRESETS[activeIndex]);
    }
  }

  function onDocPointerDown(e: PointerEvent): void {
    if (!open) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (menuEl && menuEl.contains(t)) return;
    if (triggerEl && triggerEl.contains(t)) return;
    open = false;
  }

  function onGlobalKey(e: KeyboardEvent): void {
    if (disabled) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "P")) {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tgt?.isContentEditable) return;
      e.preventDefault();
      void toggle();
    }
  }

  onMount(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("pointerdown", onDocPointerDown, true);
      window.addEventListener("keydown", onGlobalKey);
    }
  });
  onDestroy(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("pointerdown", onDocPointerDown, true);
      window.removeEventListener("keydown", onGlobalKey);
    }
  });
</script>

<div class="pp-wrap">
  <button
    bind:this={triggerEl}
    type="button"
    class="pp-trigger {variant}"
    class:open
    data-family={triggerFamily}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label="Permission mode: {triggerLabel}. Press ⌘P to change."
    title={`Permission mode: ${triggerLabel} — ⌘P to change`}
    {disabled}
    on:click={toggle}
    on:keydown={(e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        if (!open) {
          e.preventDefault();
          void toggle();
        }
      }
    }}
  >
    <span class="pp-dot" class:pulse={pulseDot} aria-hidden="true"></span>
    <span class="pp-eyebrow">PERM</span>
    <span class="pp-badge" aria-hidden="true">
      <svelte:component this={FAMILY_ICON[triggerPreset.family]} size={12} stroke={1.7} />
    </span>
    <span class="pp-alias">{triggerLabel}</span>
    <span class="pp-caret" aria-hidden="true"><ChevronDown size={12} stroke={1.8} /></span>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      bind:this={menuEl}
      class="pp-menu"
      class:position-above={positionAbove}
      role="listbox"
      aria-label="Choose permission mode"
      tabindex="-1"
      on:keydown={onKey}
    >
      <div class="pp-menu-head">
        <span class="pp-menu-eyebrow">PERMISSION MODE</span>
        <span class="pp-menu-kbd mono"><Keyboard size={11} stroke={1.6} /> ⌘P</span>
      </div>
      {#each PRESETS as it, i (it.id)}
        <button
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          class="pp-item"
          class:active={i === activeIndex}
          class:current={$settings.permissionMode === it.id}
          data-family={it.family}
          on:mouseenter={() => (activeIndex = i)}
          on:click={() => pick(it)}
        >
          <span class="pp-item-bar" aria-hidden="true"></span>
          <span class="pp-item-badge" aria-hidden="true">
            <svelte:component this={FAMILY_ICON[it.family]} size={14} stroke={1.7} />
          </span>
          <span class="pp-item-label">{it.label}</span>
          <span class="pp-item-sub mono">{it.sub}</span>
          {#if $settings.permissionMode === it.id}
            <span class="pp-check" aria-hidden="true"><Check size={13} stroke={2} /></span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<!-- Worker U: overlay variant (centered modal) — used by /permissions. -->
{#if overlayOpen}
  <div
    class="pp-overlay"
    role="presentation"
    on:mousedown={(e) => { if (e.target === e.currentTarget) overlayOpen = false; }}
  >
    <div
      class="pp-overlay-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Choose permission mode"
    >
      <header class="pp-overlay-hdr">
        <span class="pp-menu-eyebrow">PERMISSION MODE</span>
        <button
          class="pp-overlay-close mono"
          type="button"
          on:click={() => (overlayOpen = false)}
          title="Close (Esc)"
        >×</button>
      </header>
      <div class="pp-overlay-list" role="listbox" aria-label="Permission modes">
        {#each PRESETS as it (it.id)}
          <button
            type="button"
            role="option"
            aria-selected={$settings.permissionMode === it.id}
            class="pp-item"
            class:current={$settings.permissionMode === it.id}
            data-family={it.family}
            on:click={() => {
              patchSettings({ permissionMode: it.id });
              dispatch("apply", it.id);
              overlayOpen = false;
            }}
          >
            <span class="pp-item-bar" aria-hidden="true"></span>
            <span class="pp-item-badge" aria-hidden="true">
              <svelte:component this={FAMILY_ICON[it.family]} size={14} stroke={1.7} />
            </span>
            <span class="pp-item-label">{it.label}</span>
            <span class="pp-item-sub mono">{it.sub}</span>
            {#if $settings.permissionMode === it.id}
              <span class="pp-check" aria-hidden="true"><Check size={13} stroke={2} /></span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

<svelte:window on:keydown={(e) => { if (overlayOpen && e.key === "Escape") overlayOpen = false; }} />

<style>
  .pp-wrap {
    position: relative;
    display: inline-flex;
  }

  /* ---- trigger pill ---- */
  .pp-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px 5px 10px;
    border: 1px solid var(--border-hi);
    border-radius: 999px;
    background: linear-gradient(
      180deg,
      color-mix(in oklab, var(--surface) 92%, var(--accent) 0%),
      color-mix(in oklab, var(--surface) 78%, transparent)
    );
    color: var(--fg-2);
    font-family: var(--font-body);
    font-size: 12.5px;
    line-height: 1.05;
    cursor: pointer;
    transition:
      border-color var(--dur-1, 120ms) var(--ease, ease),
      color var(--dur-1, 120ms) var(--ease, ease),
      background var(--dur-2, 240ms) var(--ease, ease),
      box-shadow var(--dur-2, 240ms) var(--ease, ease);
  }
  .pp-trigger.cell {
    width: auto;
    max-width: 100%;
    min-width: 0;
    flex-shrink: 1;
    justify-content: center;
    padding: 10px 16px;
    border-radius: 999px;
    border-color: var(--border-hi);
    background: var(--surface);
    font-size: 14px;
  }
  @media (max-width: 1000px) {
    .pp-trigger.cell { padding: 8px 10px; font-size: 13px; gap: 6px; }
  }
  .pp-trigger.cell:hover:not(:disabled),
  .pp-trigger.cell.open {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .pp-trigger:hover:not(:disabled),
  .pp-trigger.open {
    border-color: var(--accent-line);
    color: var(--fg);
    box-shadow: 0 0 0 2px var(--accent-soft), 0 4px 14px rgba(0, 0, 0, 0.25);
  }
  .pp-trigger:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .pp-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-line);
    flex: 0 0 auto;
  }
  /* mode-specific dot colors — match permission semantics */
  .pp-trigger[data-family="default"]           .pp-dot { background: var(--fg-3); box-shadow: none; }
  .pp-trigger[data-family="acceptEdits"]       .pp-dot { background: oklch(0.78 0.17 145); box-shadow: 0 0 8px oklch(0.78 0.17 145 / 0.55); }
  .pp-trigger[data-family="bypassPermissions"] .pp-dot { background: oklch(0.65 0.22 25);  box-shadow: 0 0 8px oklch(0.65 0.22 25 / 0.60); }
  .pp-trigger[data-family="plan"]              .pp-dot { background: oklch(0.80 0.16 80);  box-shadow: 0 0 8px oklch(0.80 0.16 80 / 0.55); }

  .pp-dot.pulse { animation: pp-pulse 0.7s var(--ease) 1; }
  @keyframes pp-pulse {
    0%   { transform: scale(1); }
    50%  { transform: scale(1.6); box-shadow: 0 0 12px 2px var(--accent); }
    100% { transform: scale(1); }
  }

  .pp-eyebrow {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.16em;
    color: var(--fg-3);
    text-transform: uppercase;
  }
  .pp-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-2);
    line-height: 1;
  }
  .pp-trigger[data-family="acceptEdits"]       .pp-badge { color: oklch(0.78 0.17 145); }
  .pp-trigger[data-family="bypassPermissions"] .pp-badge { color: oklch(0.70 0.22 25);  }
  .pp-trigger[data-family="plan"]              .pp-badge { color: oklch(0.80 0.16 80);  }

  .pp-alias {
    color: var(--accent);
    font-weight: 600;
    letter-spacing: 0.02em;
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pp-trigger[data-family="acceptEdits"]       .pp-alias { color: oklch(0.82 0.17 145); }
  .pp-trigger[data-family="bypassPermissions"] .pp-alias { color: oklch(0.75 0.22 25);  }
  .pp-trigger[data-family="plan"]              .pp-alias { color: oklch(0.85 0.16 80);  }

  .pp-caret {
    display: inline-flex;
    align-items: center;
    color: var(--fg-3);
    margin-left: -2px;
    transition: transform var(--dur-1, 120ms) var(--ease, ease);
  }
  .pp-trigger.open .pp-caret { transform: rotate(180deg); color: var(--accent); }

  /* ---- menu ---- */
  .pp-menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 280px;
    padding: 6px;
    border: 1px solid var(--border-hi);
    border-radius: var(--r-3, 10px);
    background: color-mix(in oklab, var(--surface) 78%, transparent);
    backdrop-filter: blur(10px) saturate(1.2);
    -webkit-backdrop-filter: blur(10px) saturate(1.2);
    box-shadow: var(--shadow-md);
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 1px;
    outline: none;
    transform-origin: top right;
    animation: pp-menu-in 200ms var(--ease, cubic-bezier(0.16, 1, 0.3, 1));
  }
  @keyframes pp-menu-in {
    from { opacity: 0; transform: translateY(-6px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .pp-menu.position-above {
    top: auto;
    bottom: calc(100% + 8px);
    transform-origin: bottom right;
    animation: pp-menu-in-up 200ms var(--ease, cubic-bezier(0.16, 1, 0.3, 1));
  }
  @keyframes pp-menu-in-up {
    from { opacity: 0; transform: translateY(6px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  .pp-menu-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .pp-menu-eyebrow {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.18em;
    color: var(--fg-3);
    text-transform: uppercase;
  }
  .pp-menu-kbd {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10.5px;
    color: var(--fg-3);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--bg);
  }

  /* ---- item rows ---- */
  .pp-item {
    position: relative;
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-rows: auto auto;
    column-gap: 10px;
    align-items: center;
    padding: 8px 10px 8px 14px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--fg-2);
    text-align: left;
    cursor: pointer;
    font-family: var(--font-body);
    transition:
      background var(--dur-1, 120ms) var(--ease, ease),
      color var(--dur-1, 120ms) var(--ease, ease);
  }
  .pp-item-bar {
    position: absolute;
    left: 4px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 2px;
    background: transparent;
    transition: background var(--dur-1, 120ms) var(--ease, ease);
  }
  .pp-item:hover,
  .pp-item.active {
    background: linear-gradient(
      90deg,
      color-mix(in oklab, var(--accent) 10%, transparent) 0%,
      color-mix(in oklab, var(--accent) 0%, transparent) 100%
    );
    color: var(--fg);
  }
  .pp-item.active .pp-item-bar { background: var(--accent-line); }
  .pp-item.current { color: var(--fg); }
  .pp-item.current .pp-item-bar { background: var(--accent); }
  .pp-item.current .pp-item-label { font-weight: 600; color: var(--fg); }

  .pp-item-badge {
    grid-column: 1;
    grid-row: 1 / span 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-3);
    width: 18px;
  }
  .pp-item[data-family="default"]           .pp-item-badge { color: var(--fg-3); }
  .pp-item[data-family="acceptEdits"]       .pp-item-badge { color: oklch(0.78 0.17 145); }
  .pp-item[data-family="bypassPermissions"] .pp-item-badge { color: oklch(0.70 0.22 25);  }
  .pp-item[data-family="plan"]              .pp-item-badge { color: oklch(0.80 0.16 80);  }

  .pp-item-label {
    grid-column: 2;
    grid-row: 1;
    letter-spacing: 0.01em;
    font-size: 14.5px;
  }
  .pp-item-sub {
    grid-column: 2 / span 2;
    grid-row: 2;
    font-size: 11.5px;
    color: var(--fg-3);
    letter-spacing: 0.02em;
    margin-top: 1px;
  }
  .pp-check {
    grid-column: 3;
    grid-row: 1;
    display: inline-flex;
    align-items: center;
    color: var(--accent);
    align-self: center;
  }

  /* Worker U: overlay variant */
  .pp-overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in oklab, var(--bg) 70%, transparent);
    backdrop-filter: blur(4px);
    z-index: 90;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
  }
  .pp-overlay-panel {
    width: min(420px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border-hi);
    border-radius: var(--r-3, 8px);
    box-shadow: var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.5));
    overflow: hidden;
  }
  .pp-overlay-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  .pp-overlay-close {
    background: transparent;
    border: 0;
    color: var(--fg-3);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
  }
  .pp-overlay-close:hover { color: var(--fg); }
  .pp-overlay-list {
    display: flex;
    flex-direction: column;
    padding: 6px;
    gap: 2px;
  }
</style>
