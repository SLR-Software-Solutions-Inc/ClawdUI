<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
  import {
    OpusBadge,
    SonnetBadge,
    HaikuBadge,
    DefaultBadge,
    CustomBadge,
    Check,
    ChevronDown,
    Keyboard,
  } from "./icons";
  import type { ComponentType, SvelteComponent } from "svelte";

  /**
   * Modern, futuristic inline model picker.
   *
   * - Capsule pill trigger with status dot + family badge + alias + chevron.
   * - Glass menu (backdrop-blur, alpha bg) with family badge per row,
   *   sub-label (full id), accent left-bar on active row, kbd shortcut hint.
   * - Slide + fade open/close (200ms ease-out).
   * - Keyboard: ⌘M opens, ↑↓ navigate, Enter/Space select, Esc close.
   *
   * Emits a `select` event with the new model id (string). Empty string = SDK default.
   * Parent wires this to `liveApply("model", value)` and `patchSettings({ model })`.
   */

  export let model: string | undefined = undefined;
  export let activeModel: string | undefined = undefined;
  export let disabled = false;
  export let variant: "pill" | "cell" = "pill";

  type Family = "opus" | "sonnet" | "haiku" | "default" | "custom";
  type FamilyIcon = ComponentType<SvelteComponent<{ size?: number; stroke?: number; title?: string }>>;
  type Preset = {
    id: string;
    label: string;
    sub?: string;
    family: Family;
  };

  const PRESETS: Preset[] = [
    { id: "opus",   label: "Opus",    sub: "claude-opus-4-7",   family: "opus" },
    { id: "sonnet", label: "Sonnet",  sub: "claude-sonnet-4-6", family: "sonnet" },
    { id: "haiku",  label: "Haiku",   sub: "claude-haiku-4-5",  family: "haiku" },
    { id: "",       label: "Default", sub: "SDK chooses",       family: "default" },
  ];

  const FAMILY_ICON: Record<Family, FamilyIcon> = {
    opus: OpusBadge,
    sonnet: SonnetBadge,
    haiku: HaikuBadge,
    default: DefaultBadge,
    custom: CustomBadge,
  };

  const CUSTOM_SENTINEL = "__custom__";

  const dispatch = createEventDispatcher<{ apply: string }>();

  /**
   * Bindable `open` so parents (e.g. App.svelte slash-command handler) can
   * imperatively show the picker. Two-way binding keeps internal trigger /
   * keyboard / outside-click behavior working unchanged — those paths
   * mutate the same variable that's bound externally.
   */
  export let open = false;
  let triggerEl: HTMLButtonElement | null = null;
  let menuEl: HTMLDivElement | null = null;
  let activeIndex = 0;
  let pulseDot = false;
  let positionAbove = false;
  const MENU_HEIGHT_EST = 320;

  $: items = [
    ...PRESETS,
    { id: CUSTOM_SENTINEL, label: "Custom…", sub: "Enter full model id", family: "custom" as Family },
  ];

  function familyOf(id: string | undefined): Family {
    const raw = (id ?? "").trim().toLowerCase();
    if (!raw) return "default";
    if (/(^|-)opus/.test(raw)) return "opus";
    if (/(^|-)sonnet/.test(raw)) return "sonnet";
    if (/(^|-)haiku/.test(raw)) return "haiku";
    return "custom";
  }

  function shortAlias(id: string | undefined, fallback: string | undefined): string {
    const raw = (id ?? "").trim();
    if (!raw) {
      const fb = (fallback ?? "").trim();
      if (!fb) return "default";
      return shortAlias(fb, undefined);
    }
    const m = raw.match(/^claude-(opus|sonnet|haiku)/i);
    if (m) return m[1].toLowerCase();
    if (raw.length <= 14) return raw;
    return raw.slice(0, 12) + "…";
  }

  $: triggerLabel = shortAlias(model, activeModel);
  $: triggerFamily = familyOf(model ?? activeModel);

  function currentSelectionIndex(): number {
    const cur = (model ?? "").trim();
    const idx = PRESETS.findIndex((p) => p.id === cur);
    return idx >= 0 ? idx : items.length - 1; // Custom row
  }

  // Track previous open state so we can run open-init logic exactly once
  // per open transition, no matter who flipped the flag (trigger click,
  // ⌘M, or parent `bind:open`).
  let lastOpen = false;
  $: if (open !== lastOpen) {
    lastOpen = open;
    if (open) {
      void onOpened();
    }
  }

  async function onOpened() {
    if (disabled) return;
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

  async function toggle() {
    if (disabled) return;
    open = !open;
    // Open-init (positioning, focus, activeIndex) is handled by the
    // `$: if (open !== lastOpen)` watcher above, which fires for both
    // toggle()-driven and parent-bound opens.
  }

  function close() {
    open = false;
    triggerEl?.focus();
  }

  function pulse() {
    pulseDot = false;
    requestAnimationFrame(() => {
      pulseDot = true;
      window.setTimeout(() => (pulseDot = false), 700);
    });
  }

  function pick(item: { id: string; label: string }) {
    if (item.id === CUSTOM_SENTINEL) {
      const cur = model ?? "";
      const v = window.prompt("Custom model id (full string, e.g. claude-sonnet-4-6):", cur);
      if (v == null) {
        close();
        return;
      }
      const trimmed = v.trim();
      dispatch("apply", trimmed);
    } else {
      dispatch("apply", item.id);
    }
    pulse();
    open = false;
    triggerEl?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
    } else if (e.key === "Home") {
      e.preventDefault();
      activeIndex = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      activeIndex = items.length - 1;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(items[activeIndex]);
    }
  }

  function onDocPointerDown(e: PointerEvent) {
    if (!open) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (menuEl && menuEl.contains(t)) return;
    if (triggerEl && triggerEl.contains(t)) return;
    open = false;
  }

  function onGlobalKey(e: KeyboardEvent) {
    if (disabled) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === "m" || e.key === "M")) {
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

<div class="mp-wrap">
  <button
    bind:this={triggerEl}
    type="button"
    class="mp-trigger {variant}"
    class:open
    data-family={triggerFamily}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label="Model: {triggerLabel}. Press ⌘M to change."
    title={`Model: ${model || activeModel || "default"} — ⌘M to change`}
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
    <span class="mp-dot" class:pulse={pulseDot} aria-hidden="true"></span>
    <span class="mp-eyebrow">MODEL</span>
    <span class="mp-badge" aria-hidden="true">
      <svelte:component this={FAMILY_ICON[triggerFamily]} size={12} stroke={1.6} />
    </span>
    <span class="mp-alias">{triggerLabel}</span>
    <span class="mp-caret" aria-hidden="true"><ChevronDown size={12} stroke={1.8} /></span>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      bind:this={menuEl}
      class="mp-menu"
      class:position-above={positionAbove}
      role="listbox"
      aria-label="Choose model"
      tabindex="-1"
      on:keydown={onKey}
    >
      <div class="mp-menu-head">
        <span class="mp-menu-eyebrow">SELECT MODEL</span>
        <span class="mp-menu-kbd mono"><Keyboard size={11} stroke={1.6} /> ⌘M</span>
      </div>
      {#each items as it, i (it.id)}
        <button
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          class="mp-item"
          class:active={i === activeIndex}
          class:current={(model ?? "") === it.id && it.id !== CUSTOM_SENTINEL}
          data-family={it.family}
          on:mouseenter={() => (activeIndex = i)}
          on:click={() => pick(it)}
        >
          <span class="mp-item-bar" aria-hidden="true"></span>
          <span class="mp-item-badge" aria-hidden="true">
            <svelte:component this={FAMILY_ICON[it.family]} size={14} stroke={1.6} />
          </span>
          <span class="mp-item-label">{it.label}</span>
          {#if it.sub}
            <span class="mp-item-sub mono">{it.sub}</span>
          {/if}
          {#if (model ?? "") === it.id && it.id !== CUSTOM_SENTINEL}
            <span class="mp-check" aria-hidden="true"><Check size={13} stroke={2} /></span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .mp-wrap {
    position: relative;
    display: inline-flex;
  }

  /* ---- trigger pill ---- */
  .mp-trigger {
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
  .mp-trigger:hover:not(:disabled),
  .mp-trigger.open {
    border-color: var(--accent-line);
    color: var(--fg);
    box-shadow: 0 0 0 2px var(--accent-soft), 0 4px 14px rgba(0, 0, 0, 0.25);
  }
  .mp-trigger:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  /* Cell variant — used inside the hero card. Matches PermissionPicker.cell
     so the two pickers read as siblings. Full width, rounded, no pill chrome. */
  .mp-trigger.cell {
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
    .mp-trigger.cell { padding: 8px 10px; font-size: 13px; gap: 6px; }
  }
  .mp-trigger.cell:hover:not(:disabled),
  .mp-trigger.cell.open {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .mp-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-line);
    flex: 0 0 auto;
  }
  .mp-trigger[data-family="opus"]    .mp-dot { background: oklch(0.78 0.18 285); box-shadow: 0 0 8px oklch(0.78 0.18 285 / 0.55); }
  .mp-trigger[data-family="sonnet"]  .mp-dot { background: oklch(0.80 0.16 200); box-shadow: 0 0 8px oklch(0.80 0.16 200 / 0.55); }
  .mp-trigger[data-family="haiku"]   .mp-dot { background: oklch(0.80 0.17 145); box-shadow: 0 0 8px oklch(0.80 0.17 145 / 0.55); }
  .mp-trigger[data-family="default"] .mp-dot { background: var(--fg-3); box-shadow: none; }
  .mp-trigger[data-family="custom"]  .mp-dot { background: var(--warning); box-shadow: 0 0 8px color-mix(in oklab, var(--warning) 50%, transparent); }

  .mp-dot.pulse { animation: mp-pulse 0.7s var(--ease) 1; }
  @keyframes mp-pulse {
    0%   { transform: scale(1); }
    50%  { transform: scale(1.6); box-shadow: 0 0 12px 2px var(--accent); }
    100% { transform: scale(1); }
  }

  .mp-eyebrow {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.16em;
    color: var(--fg-3);
    text-transform: uppercase;
  }
  .mp-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-2);
    line-height: 1;
  }
  .mp-trigger[data-family="opus"]    .mp-badge { color: oklch(0.78 0.18 285); }
  .mp-trigger[data-family="sonnet"]  .mp-badge { color: oklch(0.80 0.16 200); }
  .mp-trigger[data-family="haiku"]   .mp-badge { color: oklch(0.80 0.17 145); }
  .mp-trigger[data-family="default"] .mp-badge { color: var(--fg-3); }
  .mp-trigger[data-family="custom"]  .mp-badge { color: var(--warning); }
  .mp-alias {
    color: var(--accent);
    font-weight: 600;
    letter-spacing: 0.02em;
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mp-caret {
    display: inline-flex;
    align-items: center;
    color: var(--fg-3);
    margin-left: -2px;
    transition: transform var(--dur-1, 120ms) var(--ease, ease);
  }
  .mp-trigger.open .mp-caret { transform: rotate(180deg); color: var(--accent); }

  /* ---- menu ---- */
  .mp-menu {
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
    animation: mp-menu-in 200ms var(--ease, cubic-bezier(0.16, 1, 0.3, 1));
  }
  @keyframes mp-menu-in {
    from { opacity: 0; transform: translateY(-6px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .mp-menu.position-above {
    top: auto;
    bottom: calc(100% + 8px);
    transform-origin: bottom right;
    animation: mp-menu-in-up 200ms var(--ease, cubic-bezier(0.16, 1, 0.3, 1));
  }
  @keyframes mp-menu-in-up {
    from { opacity: 0; transform: translateY(6px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  .mp-menu-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .mp-menu-eyebrow {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.18em;
    color: var(--fg-3);
    text-transform: uppercase;
  }
  .mp-menu-kbd {
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
  .mp-item {
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
  .mp-item-bar {
    position: absolute;
    left: 4px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 2px;
    background: transparent;
    transition: background var(--dur-1, 120ms) var(--ease, ease);
  }
  .mp-item:hover,
  .mp-item.active {
    background: linear-gradient(
      90deg,
      color-mix(in oklab, var(--accent) 10%, transparent) 0%,
      color-mix(in oklab, var(--accent) 0%, transparent) 100%
    );
    color: var(--fg);
  }
  .mp-item.active .mp-item-bar { background: var(--accent-line); }
  .mp-item.current { color: var(--fg); }
  .mp-item.current .mp-item-bar { background: var(--accent); }
  .mp-item.current .mp-item-label { font-weight: 600; color: var(--fg); }

  .mp-item-badge {
    grid-column: 1;
    grid-row: 1 / span 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-3);
    width: 18px;
  }
  .mp-item[data-family="opus"]   .mp-item-badge { color: oklch(0.78 0.18 285); }
  .mp-item[data-family="sonnet"] .mp-item-badge { color: oklch(0.80 0.16 200); }
  .mp-item[data-family="haiku"]  .mp-item-badge { color: oklch(0.80 0.17 145); }
  .mp-item[data-family="custom"] .mp-item-badge { color: var(--warning); }

  .mp-item-label {
    grid-column: 2;
    grid-row: 1;
    letter-spacing: 0.01em;
    font-size: 14.5px;
  }
  .mp-item-sub {
    grid-column: 2 / span 2;
    grid-row: 2;
    font-size: 11.5px;
    color: var(--fg-3);
    letter-spacing: 0.02em;
    margin-top: 1px;
  }
  .mp-check {
    grid-column: 3;
    grid-row: 1;
    display: inline-flex;
    align-items: center;
    color: var(--accent);
    align-self: center;
  }
</style>
