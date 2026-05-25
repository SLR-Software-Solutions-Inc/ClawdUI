<script lang="ts">
  import {
    drawerOpen,
    drawerActiveId,
    drawerEventLog,
    getChildren,
    setDrawerActiveId,
    getAgent,
    type Agent,
  } from "./agents.svelte";
  import { ChevronDown } from "./icons";
  import MessageBlock from "./MessageBlock.svelte";
  import { get, writable } from "svelte/store";

  // Debug HUD is opt-in. Persisted in localStorage so the choice
  // survives reloads. Toggled by the small `?` button on the strip.
  const DEBUG_KEY = "clawdui.drawer.debug";
  const initialDebug =
    typeof localStorage !== "undefined" && localStorage.getItem(DEBUG_KEY) === "1";
  const debugVisible = writable<boolean>(initialDebug);
  debugVisible.subscribe((v) => {
    try {
      localStorage.setItem(DEBUG_KEY, v ? "1" : "0");
    } catch {}
  });
  function toggleDebug(e: Event): void {
    e.stopPropagation();
    debugVisible.update((v) => !v);
  }

  // Persisted body height. Free-drag — no snapping — but expand/collapse
  // button cycles through presets.
  const HEIGHT_KEY = "clawdui.agentdrawer.height.v1";
  const DEFAULT_HEIGHT = 200;
  const MIN_HEIGHT = 80; // body min when expanded (header always visible)
  function readStoredHeight(): number {
    try {
      const raw = localStorage.getItem(HEIGHT_KEY);
      if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= MIN_HEIGHT) return n;
      }
    } catch {}
    return DEFAULT_HEIGHT;
  }
  let bodyHeight = $state<number>(readStoredHeight());
  let dragging = $state<boolean>(false);
  let animating = $state<boolean>(false);

  function maxHeight(): number {
    return typeof window !== "undefined"
      ? Math.floor(window.innerHeight * 0.8)
      : 800;
  }
  function expandedHeight(): number {
    return typeof window !== "undefined"
      ? Math.floor(window.innerHeight * 0.6)
      : 600;
  }
  function persistHeight(h: number): void {
    try {
      localStorage.setItem(HEIGHT_KEY, String(Math.round(h)));
    } catch {}
  }
  function clampHeight(h: number): number {
    return Math.max(MIN_HEIGHT, Math.min(maxHeight(), h));
  }

  // Pointer drag on the top edge of the drawer. Drawer grows UP, so
  // dragging up (smaller clientY) must INCREASE bodyHeight.
  let dragStartY = 0;
  let dragStartHeight = 0;
  function onHandlePointerDown(e: PointerEvent): void {
    // If drawer is closed, opening drag also opens it.
    if (!get(drawerOpen)) drawerOpen.set(true);
    dragging = true;
    dragStartY = e.clientY;
    dragStartHeight = bodyHeight;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onHandlePointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const dy = dragStartY - e.clientY; // up = positive
    bodyHeight = clampHeight(dragStartHeight + dy);
  }
  function onHandlePointerUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    persistHeight(bodyHeight);
  }

  // Cycle: collapsed (closed) -> default -> expanded -> collapsed.
  function cyclePreset(e: Event): void {
    e.stopPropagation();
    const open = get(drawerOpen);
    const exp = expandedHeight();
    animating = true;
    setTimeout(() => (animating = false), 220);
    if (!open) {
      bodyHeight = DEFAULT_HEIGHT;
      drawerOpen.set(true);
    } else if (bodyHeight < exp - 8) {
      bodyHeight = exp;
    } else {
      drawerOpen.set(false);
    }
    persistHeight(bodyHeight);
  }

  // Toggle via the store directly. `$drawerOpen` in the template
  // auto-subscribes — guaranteed reactivity in bundled WebKit, no
  // dependence on cross-module $state proxy tracking.
  function toggle(): void {
    const next = !get(drawerOpen);
    try {
      // eslint-disable-next-line no-console
      console.log("[DRAWER]", { toggle: next, totalCount });
    } catch {}
    drawerOpen.set(next);
  }

  function statusClass(s: Agent["status"]): string {
    switch (s) {
      case "done":
        return "dot done";
      case "error":
        return "dot error";
      default:
        return "dot running";
    }
  }

  // Drawer is INDEPENDENT of the main view's active agent. We include the
  // master ("Main") tab FIRST, then children. The master tab is essential
  // because the main chat hides tool_use / tool_result / thinking blocks —
  // without it, the master agent's mechanics had nowhere to surface.
  // Default selection: master when no children, otherwise the most recent
  // child (so a working solo session naturally opens to master's tools).
  let children = $derived(getChildren());
  let master = $derived(getAgent("master"));
  let agents = $derived<Agent[]>(
    master ? [master, ...children] : [...children],
  );
  let runningCount = $derived(
    children.filter((a) => a.status === "running").length,
  );
  // Count children only — "main" is always present, not a meaningful tally.
  let totalCount = $derived(children.length);
  let activeId = $derived.by(() => {
    const cur = $drawerActiveId;
    if (cur && agents.some((a) => a.id === cur)) return cur;
    if (children.length > 0) return children[children.length - 1].id;
    return master ? master.id : null;
  });
  let activeAgent = $derived(activeId ? getAgent(activeId) : undefined);
</script>

<div class="drawer" class:open={$drawerOpen} data-tour="agent-drawer">
  <!-- On-screen debug HUD — opt-in via the small `?` button on the strip.
       Off by default; persists in localStorage. -->
  {#if $debugVisible}
    <div class="drawer-debug mono">
      <div class="debug-line"><b>DRAWER</b> open={String($drawerOpen)} · children={totalCount} · h={bodyHeight}px</div>
      {#each $drawerEventLog as line, i (i)}
        <div class="debug-line">{line}</div>
      {/each}
    </div>
  {/if}
  <button
    type="button"
    class="strip mono"
    onclick={toggle}
    aria-expanded={$drawerOpen}
    title="Toggle child-agent drawer"
  >
    <span class="strip-label">
      {#if totalCount === 0}
        main + no children yet
      {:else}
        main + {totalCount} child{totalCount === 1 ? "" : "ren"} · {runningCount} running
      {/if}
    </span>
    <span class="caret" aria-hidden="true">
      <span class="caret-rotate" class:up={!$drawerOpen}><ChevronDown size={12} stroke={1.7} /></span>
    </span>
  </button>
  <!-- Expand/collapse cycle button — sibling of strip (HTML disallows
       nested buttons). Cycles closed -> default -> expanded -> closed. -->
  <button
    type="button"
    class="expand-toggle"
    title="Cycle drawer size"
    aria-label="Cycle drawer size"
    onclick={cyclePreset}
  >↑↓</button>
  <!-- Debug toggle is a sibling of the strip, not a child — buttons can't
       nest in HTML. Positioned absolutely so it sits inside the strip
       visually without breaking the click target. -->
  <button
    type="button"
    class="debug-toggle"
    class:active={$debugVisible}
    title={$debugVisible ? "Hide drawer debug" : "Show drawer debug"}
    onclick={toggleDebug}
  >?</button>

  {#if $drawerOpen}
    <div
      class="body"
      class:animating
      class:dragging
      style="height: {bodyHeight}px"
    >
      <!-- Drag handle: thin row at the top of the body. row-resize cursor.
           Pointer events; pointer capture keeps drag alive over the iframe-y
           transcript area. -->
      <div
        class="drag-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize agent drawer"
        onpointerdown={onHandlePointerDown}
        onpointermove={onHandlePointerMove}
        onpointerup={onHandlePointerUp}
        onpointercancel={onHandlePointerUp}
      ></div>
      {#if agents.length === 0}
        <div class="empty mono">
          The main agent will surface child agents here when it delegates.
        </div>
      {:else}
        <nav class="inner-tabs mono" aria-label="Drawer agents">
          <!-- Master ("Main") first; children after in most-recent-first order
               so the freshest delegation is next to Main. -->
          {#each agents.slice(0, 1) as a (a.id)}
            <button
              type="button"
              class="inner-tab is-master"
              class:active={a.id === activeId}
              onclick={() => setDrawerActiveId(a.id)}
              title={`Main agent — ${a.status}`}
            >
              <span
                class={statusClass(a.status)}
                aria-label={`status: ${a.status}`}
              >
                {#if a.status === "done"}✓{:else if a.status === "error"}!{/if}
              </span>
              <span>Main</span>
            </button>
          {/each}
          {#each [...children].reverse() as a (a.id)}
            <button
              type="button"
              class="inner-tab"
              class:active={a.id === activeId}
              onclick={() => setDrawerActiveId(a.id)}
              title={`${a.label} — ${a.status}`}
            >
              <span
                class={statusClass(a.status)}
                aria-label={`status: ${a.status}`}
              >
                {#if a.status === "done"}✓{:else if a.status === "error"}!{/if}
              </span>
              <span>{a.label}</span>
            </button>
          {/each}
        </nav>
        <div class="transcript">
          {#if activeAgent && activeAgent.transcript.length > 0}
            {#each activeAgent.transcript as msg, i (i)}
              <MessageBlock message={msg} view="child" />
            {/each}
          {:else}
            <div class="empty mono">no messages yet</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .drawer {
    /* Strip sits visually BELOW the body but appears FIRST in DOM so
       keyboard tab order reaches the toggle before the panel content.
       column-reverse swaps visual order without re-ordering markup.
       In-flow body (not absolute) so opening the drawer SHRINKS the
       chat area above instead of overlaying the composer. */
    position: relative;
    display: flex;
    flex-direction: column-reverse;
    background: var(--surface);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    min-height: 0;
  }
  .strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 12px;
    background: var(--elevated);
    color: var(--fg-2);
    border: none;
    border-top: 1px solid var(--border);
    cursor: pointer;
    font-size: 12.5px;
    width: 100%;
    text-align: left;
  }
  .strip:hover {
    background: var(--border-hi);
  }
  .strip-label {
    font-family: inherit;
  }
  .caret {
    display: inline-flex;
    align-items: center;
    color: var(--accent);
  }
  /* Debug HUD: pinned above the strip, narrow column, dim text. */
  .drawer-debug {
    position: absolute;
    right: 8px;
    bottom: 40px;
    max-width: 360px;
    background: oklch(0 0 0 / 0.6);
    border: 1px solid var(--accent-line, var(--border));
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 10.5px;
    color: var(--fg-3);
    z-index: 30;
    pointer-events: none;
  }
  .drawer-debug .debug-line {
    line-height: 1.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .drawer-debug b {
    color: var(--accent);
    margin-right: 6px;
  }
  .debug-toggle {
    position: absolute;
    right: 36px;
    bottom: 7px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-3);
    font-family: inherit;
    font-size: 10.5px;
    line-height: 1;
    width: 18px;
    height: 18px;
    border-radius: 9px;
    cursor: pointer;
    padding: 0;
    z-index: 25;
  }
  .debug-toggle:hover {
    color: var(--fg);
    border-color: var(--accent-line, var(--accent));
  }
  .debug-toggle.active {
    color: var(--accent);
    border-color: var(--accent);
  }
  /* Expand-cycle button — sits left of the `?` toggle. Same visual
     vocab; arrow glyph signals size cycling. */
  .expand-toggle {
    position: absolute;
    right: 60px;
    bottom: 7px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-3);
    font-family: inherit;
    font-size: 9px;
    line-height: 1;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    cursor: pointer;
    z-index: 25;
    letter-spacing: -0.5px;
  }
  .expand-toggle:hover {
    color: var(--fg);
    border-color: var(--accent-line, var(--accent));
  }
  /* Drawer expands UPWARD, so the caret should point up when closed
     (invites expansion) and down when open (invites collapse). One
     icon + rotation keeps the bundle small and the affordance consistent. */
  .caret-rotate {
    display: inline-flex;
    transition: transform var(--dur-1, 120ms) var(--ease, ease);
  }
  .caret-rotate.up {
    transform: rotate(180deg);
  }
  .body {
    /* In normal flex flow above the strip (column-reverse on parent).
       Height is driven by `style="height: Npx"` (free-drag). Smooth
       transition kicks in only during preset-cycle (avoids fighting
       the per-frame pointer updates while dragging). */
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-top: 1px solid var(--border-hi);
    overflow: hidden;
    position: relative;
  }
  .body.animating {
    transition: height 200ms var(--ease, ease);
  }
  .body.dragging {
    user-select: none;
  }
  /* Top-edge resize affordance. 6px hit area, 1px visible line that
     thickens + brightens on hover for discoverability. Sits above
     inner content via z-index so pointer events always land here. */
  .drag-handle {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 6px;
    cursor: row-resize;
    z-index: 20;
    background: transparent;
    transition: background 120ms var(--ease, ease);
  }
  .drag-handle::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 1px;
    background: var(--border-hi);
    transition: background 120ms var(--ease, ease), height 120ms var(--ease, ease);
  }
  .drag-handle:hover::after,
  .body.dragging .drag-handle::after {
    background: var(--accent);
    height: 2px;
  }
  .inner-tabs {
    display: flex;
    gap: 4px;
    padding: 4px 8px;
    background: var(--elevated);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
    /* Leave room for the drag handle on top. */
    margin-top: 6px;
  }
  .inner-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    background: var(--surface);
    color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 11.5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .inner-tab.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--fg);
  }
  /* Master ("Main") tab — distinguished by a left accent bar so the user
     knows root-level. Stays visually distinct whether active or not. */
  .inner-tab.is-master {
    border-left: 3px solid var(--accent);
    padding-left: 6px;
    font-weight: 600;
  }
  /* Shape + glyph distinguishes status for color-blind users — matches AgentTabs. */
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    color: #0a0a0a;
  }
  .dot.running {
    width: 7px;
    height: 7px;
    background: var(--accent);
    box-shadow: 0 0 4px var(--accent);
    animation: drawer-pulse 1.5s var(--ease) infinite;
    color: transparent;
    font-size: 0;
  }
  .dot.done {
    background: var(--success);
  }
  .dot.error {
    background: var(--danger);
    border-radius: 2px;
    transform: rotate(45deg);
    color: var(--bg);
    font-size: 0;
  }
  .dot.error::before {
    content: "!";
    transform: rotate(-45deg);
    font-size: 9px;
    line-height: 1;
  }
  @keyframes drawer-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in oklch, var(--accent) 55%, transparent); }
    70%  { box-shadow: 0 0 0 5px color-mix(in oklch, var(--accent) 0%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--accent) 0%, transparent); }
  }
  .transcript {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;
  }
  .empty {
    color: var(--fg-3);
    font-size: 12.5px;
    padding: 8px 0;
  }
</style>
