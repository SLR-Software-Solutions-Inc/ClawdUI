<script lang="ts">
  /**
   * Fleet View — first-class multi-agent dashboard.
   *
   * Promotes the buried AgentDrawer into a mission-control grid: header
   * stats + hierarchical agent tree + side detail pane (transcript of the
   * selected agent).
   *
   * Wiring:
   *   - Reads getAgents() / getChildrenOf() from agents.svelte.ts
   *   - Calls requestCancel(id) on the Kill button
   *   - Opens ErrorDrillModal on error pill click
   *
   * Backend signals not yet plumbed (token deltas, bg-task stdout) use
   * stubs marked TODO — see agents.svelte.ts.
   */
  import { onMount, onDestroy } from "svelte";
  import {
    getAgents,
    getChildrenOf,
    getAgent,
    requestCancel,
    getAgentTokens,
    type Agent,
  } from "./agents.svelte";
  import AgentTreeNode from "./AgentTreeNode.svelte";
  import ErrorDrillModal from "./ErrorDrillModal.svelte";
  import MessageBlock from "./MessageBlock.svelte";
  import { ListTree } from "./icons";

  // Live clock — drives elapsed-time displays.
  let now = $state(Date.now());
  let tickHandle: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    tickHandle = setInterval(() => (now = Date.now()), 1000);
  });
  onDestroy(() => {
    if (tickHandle) clearInterval(tickHandle);
  });

  let all = $derived(getAgents());
  let roots = $derived(getChildrenOf(null)); // master(s)
  let runningCount = $derived(all.filter((a) => a.status === "running").length);
  let doneCount = $derived(all.filter((a) => a.status === "done").length);
  let errorCount = $derived(all.filter((a) => a.status === "error").length);
  let totalTokens = $derived.by(() => {
    let t = 0;
    for (const a of all) {
      const u = getAgentTokens(a.id);
      t += u.input + u.output;
    }
    return t;
  });

  let selectedId = $state<string | null>(null);
  let selectedAgent = $derived(selectedId ? (getAgent(selectedId) ?? null) : null);

  let errorAgent = $state<Agent | null>(null);

  function onSelect(id: string): void {
    selectedId = id;
  }
  function onCancel(id: string): void {
    requestCancel(id);
  }
  function onErrorOpen(a: Agent): void {
    errorAgent = a;
  }
  function closeError(): void {
    errorAgent = null;
  }
</script>

<section class="fleet" aria-label="Agent Fleet View">
  <header class="fleet-head mono">
    <div class="head-left">
      <span class="head-icon" aria-hidden="true"><ListTree size={16} stroke={1.7} /></span>
      <span class="head-title">AGENT FLEET</span>
      <span class="head-sub">mission-control</span>
    </div>
    <div class="stats">
      <div class="stat">
        <span class="stat-key">agents</span>
        <span class="stat-val num">{all.length}</span>
      </div>
      <div class="stat" data-tone="run">
        <span class="stat-key">running</span>
        <span class="stat-val num">{runningCount}</span>
      </div>
      <div class="stat" data-tone="ok">
        <span class="stat-key">done</span>
        <span class="stat-val num">{doneCount}</span>
      </div>
      <div class="stat" data-tone="err">
        <span class="stat-key">error</span>
        <span class="stat-val num">{errorCount}</span>
      </div>
      <div class="stat">
        <span class="stat-key">tokens</span>
        <span class="stat-val num">{totalTokens.toLocaleString()}</span>
      </div>
    </div>
  </header>

  <div class="body">
    <div class="tree" aria-label="Agent hierarchy">
      {#if roots.length === 0}
        <div class="empty mono">no agents yet</div>
      {:else}
        {#each roots as r (r.id)}
          <AgentTreeNode
            agent={r}
            depth={0}
            {onCancel}
            {onErrorOpen}
            {onSelect}
            {selectedId}
            {now}
          />
        {/each}
      {/if}
    </div>

    <aside class="detail" aria-label="Selected agent detail">
      {#if selectedAgent}
        <header class="detail-head mono">
          <span class="detail-title">{selectedAgent.label}</span>
          <span class="detail-sub">id={selectedAgent.id.slice(0, 16)} · {selectedAgent.status}</span>
        </header>
        <div class="transcript">
          {#if selectedAgent.transcript.length === 0}
            <div class="empty mono">no messages yet</div>
          {:else}
            {#each selectedAgent.transcript as msg, i (i)}
              <MessageBlock message={msg} view="child" />
            {/each}
          {/if}
        </div>
      {:else}
        <div class="detail-empty mono">
          <div class="hint">Select an agent on the left to view its transcript.</div>
        </div>
      {/if}
    </aside>
  </div>

  {#if errorAgent}
    <ErrorDrillModal agent={errorAgent} onClose={closeError} />
  {/if}
</section>

<style>
  .fleet {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background:
      radial-gradient(1200px 600px at 80% -10%, color-mix(in oklch, var(--accent) 8%, transparent), transparent 60%),
      radial-gradient(1000px 500px at -10% 110%, color-mix(in oklch, var(--accent) 6%, transparent), transparent 60%),
      var(--bg);
    color: var(--fg);
  }

  .fleet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in oklch, var(--elevated) 80%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .head-left {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .head-icon {
    color: var(--accent);
    display: inline-flex;
  }
  .head-title {
    font-size: 12px;
    letter-spacing: 0.18em;
    color: var(--fg);
    font-weight: 600;
  }
  .head-sub {
    font-size: 10px;
    letter-spacing: 0.12em;
    color: var(--fg-3);
    text-transform: uppercase;
  }

  .stats {
    display: inline-flex;
    gap: 18px;
  }
  .stat {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0;
    min-width: 56px;
  }
  .stat-key {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--fg-3);
  }
  .stat-val {
    font-size: 16px;
    color: var(--fg);
    line-height: 1.1;
  }
  .stat-val.num {
    font-variant-numeric: tabular-nums;
  }
  .stat[data-tone="run"] .stat-val { color: var(--accent); }
  .stat[data-tone="ok"]  .stat-val { color: var(--success); }
  .stat[data-tone="err"] .stat-val { color: var(--danger); }

  .body {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    min-height: 0;
  }

  .tree {
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: color-mix(in oklch, var(--surface) 70%, transparent);
  }

  .detail {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: color-mix(in oklch, var(--surface) 50%, transparent);
  }
  .detail-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--elevated);
  }
  .detail-title {
    font-size: 12.5px;
    color: var(--fg);
  }
  .detail-sub {
    font-size: 10.5px;
    color: var(--fg-3);
  }
  .transcript {
    flex: 1;
    overflow-y: auto;
    padding: 10px 14px;
  }
  .detail-empty {
    flex: 1;
    display: grid;
    place-items: center;
    color: var(--fg-3);
  }
  .hint {
    font-size: 12.5px;
    text-align: center;
    max-width: 280px;
  }

  .empty {
    padding: 16px;
    color: var(--fg-3);
    font-size: 12.5px;
  }

  @media (max-width: 900px) {
    .body {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    }
    .tree {
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
  }
</style>
