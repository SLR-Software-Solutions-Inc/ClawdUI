<script lang="ts">
  /**
   * Recursive agent tree node for Fleet View.
   *
   * Renders one agent row + its children (any depth). Indentation is
   * controlled by `depth` prop. Collapsible via local $state.
   *
   * Props (Svelte 5 snippet-free runes API):
   *   - agent: Agent
   *   - depth: number — indentation level (0 = top)
   *   - onCancel: (id) => void
   *   - onErrorOpen: (agent) => void
   *   - onSelect: (id) => void   // surface this agent's transcript elsewhere
   *   - selectedId: string | null
   */
  import type { Agent } from "./agents.svelte";
  import { getChildrenOf, getAgentTokens } from "./agents.svelte";
  import { summarizeToolUse } from "./toolSummary";
  import { ChevronDown, ChevronRight, X as XIcon, Bot } from "./icons";
  import Self from "./AgentTreeNode.svelte";

  interface Props {
    agent: Agent;
    depth: number;
    onCancel: (id: string) => void;
    onErrorOpen: (a: Agent) => void;
    onSelect: (id: string) => void;
    selectedId: string | null;
    now: number;
  }

  let { agent, depth, onCancel, onErrorOpen, onSelect, selectedId, now }: Props =
    $props();

  let expanded = $state(true);

  let children = $derived(getChildrenOf(agent.id));
  let hasChildren = $derived(children.length > 0);

  // Walk transcript blocks → list of tool_use chips.
  type ToolChip = { id: string; name: string; label: string; idx: number };
  let toolChips = $derived.by<ToolChip[]>(() => {
    const out: ToolChip[] = [];
    let idx = 0;
    for (const m of agent.transcript) {
      if (!Array.isArray(m.blocks)) continue;
      for (const b of m.blocks) {
        if (b && (b as { type?: string }).type === "tool_use") {
          const tb = b as { id: string; name: string; input: unknown };
          const summary = summarizeToolUse(tb.name, tb.input);
          out.push({
            id: tb.id,
            name: tb.name,
            label: summary ?? tb.name,
            idx: idx++,
          });
        }
      }
    }
    // Show last 6 — the strip would otherwise scroll forever on long runs.
    return out.slice(-6);
  });

  let currentTool = $derived(toolChips.length > 0 ? toolChips[toolChips.length - 1] : null);

  let elapsed = $derived.by(() => {
    const end = agent.endedAt ?? now;
    return Math.max(0, end - agent.startedAt);
  });

  function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m < 60) return `${m}m ${r.toString().padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
  }

  let tokens = $derived(getAgentTokens(agent.id));
  let tokensTotal = $derived(tokens.input + tokens.output);

  function statusLabel(s: Agent["status"]): string {
    return s;
  }

  function onRowClick(): void {
    onSelect(agent.id);
  }
</script>

<div
  class="node"
  style="--depth: {depth};"
  data-status={agent.status}
  class:selected={selectedId === agent.id}
>
  <div class="row mono">
    <span class="indent" aria-hidden="true">
      {#each Array(depth) as _, i (i)}
        <span class="indent-rail"></span>
      {/each}
    </span>

    <button
      type="button"
      class="caret-btn"
      onclick={(e) => {
        e.stopPropagation();
        expanded = !expanded;
      }}
      aria-label={expanded ? "Collapse" : "Expand"}
      disabled={!hasChildren}
    >
      {#if hasChildren}
        {#if expanded}
          <ChevronDown size={11} stroke={1.7} />
        {:else}
          <ChevronRight size={11} stroke={1.7} />
        {/if}
      {:else}
        <span class="caret-leaf"></span>
      {/if}
    </button>

    <button type="button" class="row-main" onclick={onRowClick}>
      <span class="bot-icon" aria-hidden="true"><Bot size={12} stroke={1.7} /></span>
      <span class="pill" data-status={agent.status}>
        <span class="dot" data-status={agent.status} aria-hidden="true"></span>
        <span class="pill-label">{agent.label}</span>
      </span>

      <span class="meta">
        <span class="meta-cell">
          <span class="meta-key">t</span>
          <span class="meta-val num">{fmtElapsed(elapsed)}</span>
        </span>
        <span class="meta-cell">
          <span class="meta-key">tok</span>
          <span class="meta-val num">{tokensTotal.toLocaleString()}</span>
        </span>
        <span class="meta-cell">
          <span class="meta-key">tool</span>
          <span class="meta-val truncate">{currentTool ? currentTool.label : "—"}</span>
        </span>
        <span class="meta-cell">
          <span class="meta-key">status</span>
          <span class="meta-val" data-status={agent.status}>{statusLabel(agent.status)}</span>
        </span>
      </span>
    </button>

    <span class="actions">
      {#if agent.status === "error"}
        <button
          type="button"
          class="act-btn err"
          title="Show error details"
          onclick={(e) => {
            e.stopPropagation();
            onErrorOpen(agent);
          }}
        >drill</button>
      {/if}
      {#if agent.status === "running" && agent.id !== "master"}
        <button
          type="button"
          class="act-btn kill"
          title="Cancel agent"
          onclick={(e) => {
            e.stopPropagation();
            onCancel(agent.id);
          }}
        >
          <XIcon size={11} stroke={2} />
        </button>
      {/if}
    </span>
  </div>

  {#if toolChips.length > 0}
    <div class="chip-strip mono" style="--depth: {depth};">
      {#each toolChips as c (c.idx)}
        <span class="chip" title={c.label}>{c.label}</span>
      {/each}
    </div>
  {/if}

  {#if expanded && hasChildren}
    <div class="children">
      {#each children as child (child.id)}
        <Self
          agent={child}
          depth={depth + 1}
          {onCancel}
          {onErrorOpen}
          {onSelect}
          {selectedId}
          {now}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .node {
    display: flex;
    flex-direction: column;
    transition: background 160ms var(--ease, ease);
  }
  .node.selected > .row {
    background: color-mix(in oklch, var(--accent) 14%, transparent);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px 5px calc(8px + var(--depth) * 18px);
    border-bottom: 1px solid color-mix(in oklch, var(--border) 35%, transparent);
    font-size: 11.5px;
    color: var(--fg-2);
    position: relative;
    transition: padding-left 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
  }
  .row::before {
    /* Glow accent on running rows — futuristic mission-control vibe. */
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: transparent;
    transition: background 160ms var(--ease, ease);
  }
  .node[data-status="running"] > .row::before {
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent);
  }
  .node[data-status="error"] > .row::before {
    background: var(--danger);
  }
  .node[data-status="done"] > .row::before {
    background: var(--success);
    opacity: 0.7;
  }
  .row:hover {
    background: color-mix(in oklch, var(--fg) 4%, transparent);
  }

  .indent {
    display: inline-flex;
    align-items: stretch;
    height: 18px;
  }
  .indent-rail {
    width: 0;
  }

  .caret-btn {
    background: transparent;
    border: none;
    color: var(--fg-3);
    cursor: pointer;
    padding: 0;
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
  }
  .caret-btn:hover:not(:disabled) {
    color: var(--accent);
    background: color-mix(in oklch, var(--accent) 12%, transparent);
  }
  .caret-btn:disabled {
    cursor: default;
    opacity: 0.4;
  }
  .caret-leaf {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--fg-3);
    opacity: 0.4;
  }

  .row-main {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
    padding: 0;
    font: inherit;
  }

  .bot-icon {
    color: var(--fg-3);
    display: inline-flex;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: color-mix(in oklch, var(--surface) 70%, transparent);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    color: var(--fg);
    font-size: 11px;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .pill[data-status="error"] {
    border-color: var(--danger);
    color: var(--danger);
  }
  .pill[data-status="done"] {
    border-color: color-mix(in oklch, var(--success) 60%, var(--border));
  }
  .pill-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--fg-3);
  }
  .dot[data-status="running"] {
    background: var(--accent);
    box-shadow: 0 0 5px var(--accent);
    animation: fleet-pulse 1.4s var(--ease, ease) infinite;
  }
  .dot[data-status="done"] {
    background: var(--success);
  }
  .dot[data-status="error"] {
    background: var(--danger);
  }
  @keyframes fleet-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in oklch, var(--accent) 60%, transparent); }
    70%  { box-shadow: 0 0 0 6px color-mix(in oklch, var(--accent) 0%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--accent) 0%, transparent); }
  }

  .meta {
    display: inline-flex;
    align-items: center;
    gap: 14px;
    flex: 1;
    min-width: 0;
    color: var(--fg-3);
  }
  .meta-cell {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    min-width: 0;
  }
  .meta-key {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-3);
    opacity: 0.7;
  }
  .meta-val {
    color: var(--fg-2);
    font-size: 11px;
  }
  .meta-val.num {
    font-variant-numeric: tabular-nums;
  }
  .meta-val.truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 240px;
    display: inline-block;
  }
  .meta-val[data-status="running"] {
    color: var(--accent);
  }
  .meta-val[data-status="error"] {
    color: var(--danger);
  }
  .meta-val[data-status="done"] {
    color: var(--success);
  }

  .actions {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .act-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-2);
    border-radius: 4px;
    height: 20px;
    min-width: 20px;
    padding: 0 6px;
    font-size: 10.5px;
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .act-btn:hover {
    background: color-mix(in oklch, var(--fg) 6%, transparent);
  }
  .act-btn.kill:hover {
    border-color: var(--danger);
    color: var(--danger);
  }
  .act-btn.err {
    border-color: var(--danger);
    color: var(--danger);
  }
  .act-btn.err:hover {
    background: color-mix(in oklch, var(--danger) 12%, transparent);
  }

  .chip-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 8px 6px calc(8px + var(--depth) * 18px + 36px);
    background: color-mix(in oklch, var(--bg) 50%, transparent);
    border-bottom: 1px solid color-mix(in oklch, var(--border) 25%, transparent);
  }
  .chip {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: color-mix(in oklch, var(--accent) 8%, var(--surface));
    border: 1px solid color-mix(in oklch, var(--accent) 25%, var(--border));
    color: var(--fg-2);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .children {
    display: flex;
    flex-direction: column;
  }
</style>
