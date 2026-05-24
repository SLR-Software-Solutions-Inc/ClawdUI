<script lang="ts">
  import { onMount } from "svelte";
  import { fmtUptime, fmtTokens, fmtUsd, fmtMs } from "./format";
  import { stats } from "./stats";

  export let startTime: number | null = null;
  export let model: string | undefined = undefined;
  export let modelAlias: string | undefined = undefined;
  export let permissionMode: string | undefined = undefined;
  export let maxBudgetUsd: number | null | undefined = null;

  let now = Date.now();
  let timer: ReturnType<typeof setInterval>;

  onMount(() => {
    timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  $: uptime = startTime ? fmtUptime(now - startTime) : "--:--:--";
  $: turn = $stats.turn;
  $: session = $stats.session;
  $: budget =
    maxBudgetUsd != null && maxBudgetUsd > 0
      ? Math.min(1, session.costUsd / maxBudgetUsd)
      : null;
  $: budgetWarn = budget != null && budget >= 0.8;
  $: budgetCrit = budget != null && budget >= 0.95;

  $: modelLabel = modelAlias ?? model ?? "—";
  $: modelFull = model && modelAlias && model !== modelAlias ? model : null;
</script>

<div class="hud" role="status" aria-label="session statistics">
  <div class="cell">
    <span class="eyebrow">UPTIME</span>
    <span class="value">{uptime}</span>
  </div>

  <span class="div"></span>

  <div class="cell">
    <span class="eyebrow">LATENCY</span>
    <span class="value">
      {fmtMs(turn.ttfMs)}
      <span class="sep">·</span>
      {fmtMs(turn.e2eMs)}
      {#if turn.streaming}
        <span class="live-dot" aria-label="streaming"></span>
      {/if}
    </span>
  </div>

  <span class="div"></span>

  <div class="cell">
    <span class="eyebrow">TURN i/o</span>
    <span class="value">
      {fmtTokens(turn.usage.input)}
      <span class="sep">/</span>
      {fmtTokens(turn.usage.output)}
      {#if turn.usage.cacheRead > 0 || turn.usage.cacheCreation > 0}
        <span class="cache" title="cache read / creation">
          <span class="sep">·</span>
          {fmtTokens(turn.usage.cacheRead)}r
          <span class="sep">/</span>
          {fmtTokens(turn.usage.cacheCreation)}w
        </span>
      {/if}
    </span>
  </div>

  <span class="div"></span>

  <div class="cell">
    <span class="eyebrow">SESSION</span>
    <span class="value">
      {fmtTokens(session.usage.input + session.usage.output)} tok
      <span class="sep">·</span>
      {fmtUsd(session.costUsd)}
    </span>
  </div>

  {#if budget != null}
    <span class="div"></span>
    <div class="cell wide">
      <span class="eyebrow">
        BUDGET
        <span class="budget-num">
          {fmtUsd(session.costUsd)} / {fmtUsd(maxBudgetUsd ?? 0)}
        </span>
      </span>
      <span
        class="bar"
        class:warn={budgetWarn}
        class:crit={budgetCrit}
      >
        <span class="fill" style="width: {(budget * 100).toFixed(1)}%"></span>
      </span>
    </div>
  {/if}

  {#if permissionMode}
    <span class="div"></span>
    <div class="cell">
      <span class="eyebrow">MODE</span>
      <span class="value pill mode-{permissionMode}">{permissionMode}</span>
    </div>
  {/if}

  {#if modelLabel && modelLabel !== "—"}
    <span class="div"></span>
    <div class="cell wide">
      <span class="eyebrow">MODEL</span>
      <span class="value model" title={modelFull ?? modelLabel}>
        <span class="alias">{modelLabel}</span>
        {#if modelFull}
          <span class="badge">{modelFull}</span>
        {/if}
      </span>
    </div>
  {/if}
</div>

<style>
  .hud {
    display: inline-flex;
    align-items: center;
    gap: 14px;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-3);
    background: var(--surface);
    font-family: var(--font-mono);
    font-feature-settings: "tnum";
  }
  .cell {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    line-height: 1.05;
    min-width: 0;
  }
  .cell.wide { max-width: 260px; }
  .value {
    font-size: 15.5px;
    color: var(--fg);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .sep {
    color: var(--fg-3);
    opacity: 0.7;
  }
  .cache { color: var(--fg-2); display: inline-flex; gap: 4px; align-items: center; }
  .value.model {
    overflow: hidden;
    color: var(--accent);
    max-width: 260px;
  }
  .alias {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 90px;
  }
  .badge {
    font-size: 13.5px;
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--fg-2);
    background: var(--bg);
    font-weight: 400;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }
  .div {
    width: 1px;
    height: 18px;
    background: var(--border);
  }

  .live-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--accent);
    margin-left: 2px;
    box-shadow: 0 0 6px var(--accent);
    animation: pulse-dot 1.2s var(--ease) infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.85); }
  }

  .pill {
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg);
    font-size: 13.5px;
    letter-spacing: 0.04em;
    text-transform: lowercase;
  }
  .mode-acceptEdits { color: var(--accent); border-color: var(--accent); }
  .mode-bypassPermissions { color: var(--danger); border-color: var(--danger); }
  .mode-plan { color: var(--fg-2); }

  .budget-num {
    margin-left: 6px;
    color: var(--fg-3);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }
  .bar {
    width: 140px;
    height: 4px;
    border-radius: 999px;
    background: var(--border);
    overflow: hidden;
    position: relative;
    display: block;
  }
  .bar .fill {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-2, 200ms) var(--ease, ease);
  }
  .bar.warn .fill { background: var(--warning); }
  .bar.crit .fill { background: var(--danger); }
</style>
