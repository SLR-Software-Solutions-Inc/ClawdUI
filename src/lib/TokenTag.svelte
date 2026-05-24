<!--
  TokenTag — compact pill showing total tokens + cost. Click to expand a
  popover with the breakdown (input / output / cache read / cache write)
  for the current turn and cumulative session, plus a budget bar when
  `maxBudgetUsd` is set.

  Self-contained reactive read of the stats store. No props required.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { stats } from "./stats";
  import { settings } from "./settings";

  let open = false;
  let wrapEl: HTMLDivElement;
  let triggerEl: HTMLButtonElement;
  let popLeft = 0;
  let popBottom = 0;

  function positionPopover(): void {
    if (!triggerEl) return;
    const r = triggerEl.getBoundingClientRect();
    // Above the trigger, aligned to its left edge. Will clamp to viewport.
    const popWidth = 360;
    const margin = 8;
    let left = r.left;
    if (left + popWidth > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - popWidth);
    }
    popLeft = left;
    popBottom = window.innerHeight - r.top + 8;
  }

  function toggle(): void {
    if (!open) positionPopover();
    open = !open;
  }
  function close(): void {
    open = false;
  }

  // Close on outside click + Escape.
  function onDocClick(e: MouseEvent): void {
    if (!wrapEl || wrapEl.contains(e.target as Node)) return;
    open = false;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) {
      open = false;
    }
  }
  $: if (typeof document !== "undefined") {
    if (open) {
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKey);
      window.addEventListener("resize", positionPopover);
      window.addEventListener("scroll", positionPopover, true);
    } else {
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
    }
  }
  onDestroy(() => {
    if (typeof document !== "undefined") {
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    }
  });

  function fmtTok(n: number): string {
    if (!Number.isFinite(n)) return "0";
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  function fmtUsd(n: number, digits = 4): string {
    return `$${(Number.isFinite(n) ? n : 0).toFixed(digits)}`;
  }

  $: turn = $stats.turn;
  $: session = $stats.session;
  $: total =
    (session.usage.input ?? 0) +
    (session.usage.output ?? 0) +
    (session.usage.cacheRead ?? 0) +
    (session.usage.cacheCreation ?? 0);
  $: turnTotal =
    (turn.usage.input ?? 0) +
    (turn.usage.output ?? 0) +
    (turn.usage.cacheRead ?? 0) +
    (turn.usage.cacheCreation ?? 0);
  $: maxBudget = $settings.maxBudgetUsd ?? null;
  $: budgetFrac =
    maxBudget != null && maxBudget > 0
      ? Math.min(1, (session.costUsd ?? 0) / maxBudget)
      : null;
  $: budgetWarn = budgetFrac != null && budgetFrac >= 0.8;
  $: budgetCrit = budgetFrac != null && budgetFrac >= 0.95;
</script>

<div class="tt-wrap" bind:this={wrapEl}>
  <button
    bind:this={triggerEl}
    type="button"
    class="tok-tag"
    class:open
    aria-expanded={open}
    title="Click for token + cost breakdown"
    on:click={toggle}
  >
    {total.toLocaleString()} tok · {fmtUsd(session.costUsd ?? 0)}
  </button>

  {#if open}
    <div
      class="tt-pop mono"
      role="dialog"
      aria-label="Token and cost breakdown"
      style="left: {popLeft}px; bottom: {popBottom}px;"
    >
      <header>
        <span class="tt-title">Token + cost breakdown</span>
        <button class="tt-x" type="button" on:click={close} aria-label="Close">×</button>
      </header>

      <div class="tt-grid">
        <div class="tt-col">
          <span class="tt-eyebrow">LAST TURN</span>
          <dl>
            <div><dt>input</dt><dd>{fmtTok(turn.usage.input ?? 0)}</dd></div>
            <div><dt>output</dt><dd>{fmtTok(turn.usage.output ?? 0)}</dd></div>
            <div><dt>cache r</dt><dd>{fmtTok(turn.usage.cacheRead ?? 0)}</dd></div>
            <div><dt>cache w</dt><dd>{fmtTok(turn.usage.cacheCreation ?? 0)}</dd></div>
            <div class="tt-sep"><dt>total</dt><dd>{fmtTok(turnTotal)}</dd></div>
            <div><dt>cost</dt><dd>{fmtUsd(turn.costUsd ?? 0)}</dd></div>
            <div><dt>ttft</dt><dd>{turn.ttfMs != null ? `${Math.round(turn.ttfMs)}ms` : "—"}</dd></div>
            <div><dt>e2e</dt><dd>{turn.e2eMs != null ? `${Math.round(turn.e2eMs)}ms` : "—"}</dd></div>
          </dl>
        </div>
        <div class="tt-col">
          <span class="tt-eyebrow">SESSION</span>
          <dl>
            <div><dt>input</dt><dd>{fmtTok(session.usage.input ?? 0)}</dd></div>
            <div><dt>output</dt><dd>{fmtTok(session.usage.output ?? 0)}</dd></div>
            <div><dt>cache r</dt><dd>{fmtTok(session.usage.cacheRead ?? 0)}</dd></div>
            <div><dt>cache w</dt><dd>{fmtTok(session.usage.cacheCreation ?? 0)}</dd></div>
            <div class="tt-sep"><dt>total</dt><dd>{fmtTok(total)}</dd></div>
            <div><dt>cost</dt><dd>{fmtUsd(session.costUsd ?? 0)}</dd></div>
            <div><dt>turns</dt><dd>{session.turns}</dd></div>
          </dl>
        </div>
      </div>

      {#if budgetFrac != null}
        <div class="tt-budget">
          <div class="tt-budget-head">
            <span class="tt-eyebrow">BUDGET</span>
            <span class="tt-budget-num">{fmtUsd(session.costUsd ?? 0)} / {fmtUsd(maxBudget ?? 0, 2)}</span>
          </div>
          <div class="tt-bar" class:warn={budgetWarn} class:crit={budgetCrit}>
            <div class="tt-fill" style="width: {(budgetFrac * 100).toFixed(1)}%"></div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tt-wrap { position: relative; display: inline-block; }
  .tok-tag {
    background: transparent;
    border: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-3);
    letter-spacing: 0.04em;
    white-space: nowrap;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 999px;
  }
  .tok-tag:hover { color: var(--fg); background: var(--accent-soft); }
  .tok-tag.open { color: var(--accent); background: var(--accent-soft); }

  .tt-pop {
    /* Fixed positioning so the popover escapes any ancestor with
       overflow: hidden / auto. left + bottom set inline via JS. */
    position: fixed;
    width: 360px;
    background: var(--elevated);
    border: 1px solid var(--accent-line);
    border-radius: var(--r-2);
    box-shadow: var(--shadow-lg);
    padding: 12px 14px;
    z-index: 9999;
    color: var(--fg);
  }
  .tt-pop header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .tt-title { font-size: 11.5px; letter-spacing: 0.12em; color: var(--fg-4); text-transform: uppercase; }
  .tt-x {
    background: transparent;
    border: 0;
    color: var(--fg-3);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .tt-x:hover { color: var(--fg); }

  .tt-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  .tt-col { display: flex; flex-direction: column; gap: 4px; }
  .tt-eyebrow { font-size: 10px; letter-spacing: 0.12em; color: var(--fg-4); }
  dl { margin: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
  dl > div { display: flex; justify-content: space-between; align-items: baseline; }
  dl dt { color: var(--fg-3); }
  dl dd { margin: 0; color: var(--fg); font-variant-numeric: tabular-nums; }
  .tt-sep {
    border-top: 1px solid var(--border);
    padding-top: 3px;
    margin-top: 3px;
    font-weight: 600;
  }
  .tt-sep dd { color: var(--accent); }

  .tt-budget {
    margin-top: 12px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .tt-budget-head {
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .tt-budget-num { font-size: 11.5px; color: var(--fg-3); }
  .tt-bar {
    height: 6px;
    background: var(--surface);
    border-radius: 999px;
    overflow: hidden;
  }
  .tt-fill {
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-2) var(--ease);
  }
  .tt-bar.warn .tt-fill { background: var(--warning); }
  .tt-bar.crit .tt-fill { background: var(--danger); }
</style>
