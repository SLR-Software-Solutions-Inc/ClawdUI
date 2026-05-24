<script lang="ts">
  import {
    getAgents,
    getActiveAgentId,
    setActiveAgentId,
    type Agent,
  } from "./agents.svelte";

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

  // Main view tab strip is pinned to the root agent only — children live in
  // the bottom AgentDrawer. Keeps the main pane clutter-free per directive.
  let masterAgent = $derived(getAgents().find((a) => a.id === "master"));
</script>

<nav class="agent-tabs mono" aria-label="Agent tabs">
  {#if masterAgent}
    <button
      type="button"
      class="tab master"
      class:active={masterAgent.id === getActiveAgentId()}
      onclick={() => setActiveAgentId(masterAgent.id)}
      title={`Main orchestrator — ${masterAgent.status}`}
    >
      <span
        class={statusClass(masterAgent.status)}
        aria-label={`status: ${masterAgent.status}`}
      >
        {#if masterAgent.status === "done"}✓{:else if masterAgent.status === "error"}!{/if}
      </span>
      <span class="label">{masterAgent.label}</span>
    </button>
  {/if}
</nav>

<style>
  .agent-tabs {
    display: flex;
    align-items: stretch;
    gap: 4px;
    padding: 4px 8px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
    min-height: 30px;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--elevated);
    color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 12.5px;
    cursor: pointer;
    transition: background 0.1s;
    white-space: nowrap;
  }
  .tab:hover {
    background: var(--border-hi);
  }
  .tab.active {
    background: var(--accent-soft);
    color: var(--fg);
    border-color: var(--accent);
  }
  .tab.master {
    font-weight: 600;
  }
  /* Shape + glyph distinguishes status for color-blind users: pulsing dot
     for running, ✓ on green circle for done, ! on red triangle for error. */
  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    color: #0a0a0a;
  }
  .dot.running {
    width: 8px;
    height: 8px;
    background: var(--accent);
    box-shadow: 0 0 4px var(--accent);
    animation: pulse-ring 1.5s var(--ease) infinite;
  }
  .dot.done {
    background: var(--success);
  }
  .dot.error {
    background: var(--danger);
    border-radius: 2px;
    transform: rotate(45deg);
    color: var(--bg);
  }
  .dot.error::before {
    /* Counter-rotate the glyph so "!" reads upright on the rotated square (diamond). */
    content: "!";
    transform: rotate(-45deg);
    line-height: 1;
  }
  .dot.error { font-size: 0; } /* hide the slot ! */
  @keyframes pulse-ring {
    0%   { box-shadow: 0 0 0 0 color-mix(in oklch, var(--accent) 55%, transparent); }
    70%  { box-shadow: 0 0 0 6px color-mix(in oklch, var(--accent) 0%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--accent) 0%, transparent); }
  }
  .label {
    font-family: inherit;
  }
</style>
