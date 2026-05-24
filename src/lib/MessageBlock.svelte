<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fmtAbsolute, fmtRelative } from "./format";
  import { permissions } from "./permissions.svelte";
  import {
    setDrawerActiveId,
    setDrawerOpen,
    isSpawnToolUseId,
    getSpawnChildId,
  } from "./agents.svelte";
  import type { ChatMessage } from "./types";
  import { CornerDownRight, Check } from "./icons";
  import { parseTextSegments, parseInline } from "./markdownSegments";

  // Cells that are purely numeric (incl. %, $, commas, decimals, sign) get
  // right-aligned + monospaced so number columns line up.
  const NUMERIC_RE = /^[-+]?[$]?\d{1,3}(?:[,\d]*)(?:\.\d+)?%?$/;
  function isNumeric(s: string): boolean {
    return NUMERIC_RE.test(s.trim());
  }
  import CodeBlock from "./CodeBlock.svelte";
  import InlinePermissionCard from "./InlinePermissionCard.svelte";
  import { summarizeToolUse } from "./toolSummary";

  export let message: ChatMessage;
  // "master" hides spawn-child tool noise (Agent / spawn_child / Task) and
  // replaces it with a single delegation chip. "child" shows everything.
  export let view: "master" | "child" = "master";

  const dispatch = createEventDispatcher();

  // Tool names whose tool_use / tool_result blocks should NOT appear in the
  // master transcript — they belong to the child agent's view.
  const SPAWN_TOOL_NAMES = new Set(["Agent", "spawn_child", "Task"]);

  function copy(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  /**
   * Aggregate every block in this message back to plain text for the
   * hover-toolbar actions (Copy, Quote, Regenerate). Text + thinking get
   * inlined; tool_use / tool_result render as short summaries so a copied
   * transcript stays useful.
   */
  function messageAsText(): string {
    const parts: string[] = [];
    for (const b of message.blocks) {
      if (b.type === "text") parts.push(b.text);
      else if (b.type === "thinking") parts.push(`(thinking)\n${b.text}`);
      else if (b.type === "tool_use") {
        const sum = summarizeToolUse(b.name, b.input);
        parts.push(`▸ ${sum ?? `${b.name}(${safeJson(b.input)})`}`);
      } else if (b.type === "tool_result") {
        parts.push(`◂ ${b.content}`);
      }
    }
    return parts.join("\n\n").trim();
  }

  function quote(): void {
    const t = messageAsText();
    if (!t) return;
    const quoted = t.split("\n").map((l) => `> ${l}`).join("\n");
    dispatch("quote", { text: `${quoted}\n\n` });
  }
  function copyAll(): void {
    const t = messageAsText();
    if (t) copy(t);
  }
  function regenerate(): void {
    dispatch("regenerate", undefined);
  }
  function userMessageText(): string {
    return message.blocks
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
  }
  function edit(): void {
    const t = userMessageText();
    if (!t) return;
    dispatch("edit", { text: t });
  }
  function resend(): void {
    const t = userMessageText();
    if (!t) return;
    dispatch("resend", { text: t });
  }
  let copiedAll = false;
  function onCopyAll(): void {
    copyAll();
    copiedAll = true;
    setTimeout(() => (copiedAll = false), 1400);
  }

  function safeJson(v: unknown): string {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  function shortText(v: unknown, max = 80): string {
    const s = typeof v === "string" ? v : safeJson(v);
    const oneLine = s.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
  }

  function spawnDescription(input: unknown): string {
    const i = (input ?? {}) as Record<string, unknown>;
    const desc =
      (typeof i.description === "string" && i.description) ||
      (typeof i.subagent_type === "string" && i.subagent_type) ||
      (typeof i.prompt === "string" && i.prompt) ||
      "child task";
    return shortText(desc, 90);
  }

  // Build a tool_use_id → child_id map for the "Agent" / "spawn_child" calls
  // in this message so the corresponding result chip can link to the child.
  function spawnIdsInMessage(): Map<string, string | undefined> {
    const m = new Map<string, string | undefined>();
    for (const b of message.blocks) {
      if (b.type === "tool_use" && SPAWN_TOOL_NAMES.has(b.name)) {
        const i = (b.input ?? {}) as Record<string, unknown>;
        const cid =
          (typeof i.child_id === "string" && i.child_id) ||
          (typeof i.session_id === "string" && i.session_id) ||
          undefined;
        m.set(b.id, cid);
      }
    }
    return m;
  }

  function focusChild(childId: string | undefined): void {
    if (!childId) {
      setDrawerOpen(true);
      return;
    }
    setDrawerActiveId(childId);
    setDrawerOpen(true);
  }
</script>

<article class="msg {message.role}" data-role={message.role}>
  <div class="msg-toolbar mono" role="toolbar" aria-label="Message actions">
    <button
      type="button"
      class="msg-tool"
      title="Copy message"
      on:click={onCopyAll}
    >{copiedAll ? "✓ copied" : "copy"}</button>
    <button
      type="button"
      class="msg-tool"
      title="Quote in composer"
      on:click={quote}
    >quote</button>
    {#if message.role === "user"}
      <button
        type="button"
        class="msg-tool"
        title="Edit this prompt in the composer (drops everything after)"
        on:click={edit}
      >edit</button>
      <button
        type="button"
        class="msg-tool"
        title="Resend this prompt as-is (drops everything after)"
        on:click={resend}
      >resend</button>
    {:else if message.role === "assistant"}
      <button
        type="button"
        class="msg-tool"
        title="Regenerate (resend previous user prompt)"
        on:click={regenerate}
      >regen</button>
    {/if}
  </div>
  <div class="rail" aria-hidden="true"></div>
  <div class="head">
    <span class="role mono">{message.role}</span>
    <span class="ts mono" title={fmtAbsolute(message.timestamp)}>{fmtRelative(message.timestamp)}</span>
    {#if message.queued}
      <span class="queued mono">QUEUED</span>
      <button
        type="button"
        class="queue-cancel mono"
        title="Cancel this queued prompt"
        on:click={() => dispatch("cancel-queued", { queueId: message.queueId })}
      >×</button>
    {/if}
  </div>
  <div class="body">
    {#each message.blocks as block, i (i)}
      {#if block.type === "text"}
        <div class="text">
          {#each parseTextSegments(block.text, { streaming: !!message.streaming }) as seg, j (j)}
            {#if seg.kind === "code"}
              <CodeBlock language={seg.lang} filename={seg.filename} code={seg.code} />
            {:else if seg.kind === "table"}
              <div class="md-table-wrap">
                <table class="md-table">
                  <thead>
                    <tr>
                      {#each seg.header as h, hi (hi)}
                        <th class:num={isNumeric(h)}>
                          {#each parseInline(h) as run, ri (ri)}
                            {#if run.kind === "strong"}<strong>{run.text}</strong>
                            {:else if run.kind === "em"}<em>{run.text}</em>
                            {:else if run.kind === "code"}<code class="inline-code">{run.text}</code>
                            {:else}{run.text}{/if}
                          {/each}
                        </th>
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each seg.rows as row, rri (rri)}
                      <tr>
                        {#each row as c, ci (ci)}
                          <td class:num={isNumeric(c)}>
                            {#each parseInline(c) as run, ri (ri)}
                              {#if run.kind === "strong"}<strong>{run.text}</strong>
                              {:else if run.kind === "em"}<em>{run.text}</em>
                              {:else if run.kind === "code"}<code class="inline-code">{run.text}</code>
                              {:else}{run.text}{/if}
                            {/each}
                          </td>
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <span class="prose">{#each seg.inline as run, ri (ri)}{#if run.kind === "strong"}<strong>{run.text}</strong>{:else if run.kind === "em"}<em>{run.text}</em>{:else if run.kind === "code"}<code class="inline-code">{run.text}</code>{:else}{run.text}{/if}{/each}</span>
            {/if}
          {/each}{#if message.streaming && i === message.blocks.length - 1}<span class="cursor">▌</span>{/if}
        </div>
      {:else if block.type === "thinking"}
        <details class="block thinking">
          <summary><span class="block-tag mono">THINKING</span></summary>
          <pre class="mono">{block.text}</pre>
        </details>
      {:else if block.type === "tool_use" && view === "master" && SPAWN_TOOL_NAMES.has(block.name)}
        <button
          type="button"
          class="delegate-chip mono"
          on:click={() => focusChild(spawnIdsInMessage().get(block.id))}
          title="Open child transcript in drawer"
        >
          <span class="chip-icon" aria-hidden="true"><CornerDownRight size={13} stroke={1.7} /></span>
          <span class="chip-tag">DELEGATED</span>
          <span class="chip-desc">{spawnDescription(block.input)}</span>
        </button>
        <!-- Hoist the permission card out of the collapsed delegate chip too —
             a spawn-tool ask is no different than any other tool ask: the user
             must see it or the agent stalls. -->
        <InlinePermissionCard toolUseId={block.id} />
      {:else if block.type === "tool_result" && view === "master" && isSpawnToolUseId(block.tool_use_id)}
        <button
          type="button"
          class="delegate-chip mono returned"
          on:click={() => focusChild(getSpawnChildId(block.tool_use_id))}
          title="Open child transcript in drawer"
        >
          <span class="chip-icon" aria-hidden="true"><Check size={13} stroke={1.9} /></span>
          <span class="chip-tag">CHILD RETURNED</span>
          <span class="chip-desc">{shortText(block.content, 100)}</span>
        </button>
      {:else if block.type === "tool_use"}
        {@const summary = summarizeToolUse(block.name, block.input)}
        <details class="block tool-use" class:denied={!!permissions.denied[block.id]}>
          <summary>
            <span class="block-tag mono">TOOL</span>
            {#if summary}
              <span class="tool-summary mono">{summary}</span>
            {:else}
              <span class="tool-name mono">{block.name}</span>
            {/if}
            {#if permissions.denied[block.id]}
              <span
                class="deny-tag mono"
                title={permissions.denied[block.id]}
              >BLOCKED</span>
            {/if}
            <button
              class="copy mono"
              type="button"
              on:click|stopPropagation={() => copy(safeJson(block.input))}
            >copy</button>
          </summary>
          <pre class="mono">{safeJson(block.input)}</pre>
          {#if permissions.denied[block.id]}
            <p class="deny-reason mono">denied: {permissions.denied[block.id]}</p>
          {/if}
        </details>
        <!-- Pending permission ask attached to this tool call — replaces the
             full-screen modal for everything except bypassPermissions mode. -->
        <InlinePermissionCard toolUseId={block.id} />
      {:else if block.type === "tool_result"}
        <details class="block tool-result">
          <summary>
            <span class="block-tag mono">RESULT</span>
            <button
              class="copy mono"
              type="button"
              on:click|stopPropagation={() => copy(block.content)}
            >copy</button>
          </summary>
          <pre class="mono">{block.content}</pre>
        </details>
      {/if}
    {/each}
  </div>
</article>

<style>
  .msg {
    position: relative;
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 14px;
    /* extra top padding gives the lifted .msg-toolbar (top: -14px) clear
       vertical space so it doesn't overlap the previous message. */
    padding: 18px 0 8px;
    animation: slide-up var(--dur-2) var(--ease);
  }
  /* Hover toolbar — copy / quote / regen pinned to the top-right of each
     message; only revealed on hover or focus-within so it doesn't add
     visual noise to the transcript.
     Anchored OUTSIDE the header row (negative top) so the pills never
     overlap the role / timestamp / STREAMING / QUEUED elements that live
     in .head — those right-aligned tags previously rendered underneath
     the pills, causing visible bleed-through. */
  .msg-toolbar {
    position: absolute;
    top: -14px;
    right: 4px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transform: translateY(-2px);
    transition: opacity var(--dur-1) var(--ease), transform var(--dur-1) var(--ease);
    pointer-events: none;
    z-index: 3;
    background: var(--bg);
    padding: 2px;
    border-radius: 999px;
  }
  .msg:hover .msg-toolbar,
  .msg:focus-within .msg-toolbar {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }
  .msg-tool {
    background: var(--elevated);
    border: 1px solid var(--border);
    color: var(--fg-2);
    padding: 3px 8px;
    border-radius: 999px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    letter-spacing: 0.04em;
  }
  .msg-tool:hover { border-color: var(--accent); color: var(--fg); }
  .rail {
    width: 2px;
    background: var(--border);
    border-radius: 999px;
    align-self: stretch;
    margin-left: 6px;
  }
  .msg.user .rail { background: var(--fg-3); }
  .msg.assistant .rail { background: var(--accent-line); }
  .msg.tool .rail { background: var(--warning); opacity: 0.6; }
  .msg.system .rail { background: var(--danger); opacity: 0.6; }

  .head {
    grid-column: 2;
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 14.5px;
    color: var(--fg-3);
    margin-bottom: 4px;
  }
  .role {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--fg-2);
  }
  .msg.user .role { color: var(--fg); }
  .msg.assistant .role { color: var(--accent); }
  .msg.tool .role { color: var(--warning); }
  .msg.system .role { color: var(--danger); }
  .ts { color: var(--fg-4); }
  .streaming {
    color: var(--accent);
    font-size: 12.5px;
    letter-spacing: 0.1em;
    animation: blink 1.2s ease-in-out infinite;
    margin-left: auto;
  }
  .queued {
    color: var(--warning);
    font-size: 11.5px;
    letter-spacing: 0.12em;
    border: 1px solid var(--warning);
    border-radius: 999px;
    padding: 1px 8px;
    margin-left: auto;
  }
  .queue-cancel {
    background: transparent;
    border: 0;
    color: var(--fg-3);
    font-size: 14px;
    line-height: 1;
    padding: 0 4px;
    cursor: pointer;
  }
  .queue-cancel:hover { color: var(--danger); }

  .body {
    grid-column: 2;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .text {
    word-break: break-word;
    font-size: 17.5px;
    line-height: 1.6;
  }
  /* prose segments keep the original pre-wrap whitespace handling; code
     fence segments render via <CodeBlock> with their own pre styling. */
  .text .prose {
    white-space: pre-wrap;
    display: inline;
  }
  .cursor {
    display: inline-block;
    color: var(--accent);
    margin-left: 2px;
    animation: blink 1s steps(2, start) infinite;
  }

  /* Inline markdown formatting inside prose. */
  .text :global(strong) {
    font-weight: 700;
    color: var(--fg);
  }
  .text :global(em) {
    font-style: italic;
  }
  .text :global(.inline-code) {
    font-family: var(--font-mono);
    background: var(--elevated);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 1px 5px;
    border-radius: var(--r-1);
    font-size: 0.92em;
  }

  /* GFM-style tables — compact, dark-theme aware, horizontal scroll on
     overflow so wide tables don't blow out the message column. */
  .md-table-wrap {
    max-width: 100%;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    margin: 4px 0;
  }
  .md-table {
    border-collapse: collapse;
    font-size: 14.5px;
    width: 100%;
  }
  .md-table th,
  .md-table td {
    padding: 4px 10px;
    border: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
    color: var(--fg-2);
  }
  .md-table thead th {
    background: var(--elevated);
    color: var(--fg);
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .md-table th.num,
  .md-table td.num {
    font-family: var(--font-mono);
    text-align: right;
    color: var(--fg);
  }

  .block {
    border: 1px solid var(--border);
    border-left: 2px solid var(--border-hi);
    border-radius: var(--r-2);
    background: var(--surface);
    overflow: hidden;
  }
  .block summary {
    list-style: none;
    cursor: pointer;
    padding: 7px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
    transition: background var(--dur-1) var(--ease);
  }
  .block summary::-webkit-details-marker { display: none; }
  .block summary:hover { background: var(--elevated); }
  .block-tag {
    font-size: 12.5px;
    letter-spacing: 0.1em;
    padding: 1px 5px;
    border-radius: var(--r-1);
    background: var(--elevated);
    color: var(--fg-3);
    font-weight: 600;
  }
  .tool-use { border-left-color: var(--accent-line); }
  .tool-use.denied { border-left-color: var(--danger); }
  .tool-use .block-tag { background: var(--accent-soft); color: var(--accent); }
  .tool-use.denied .block-tag { background: color-mix(in oklab, var(--danger) 18%, transparent); color: var(--danger); }
  .tool-name { font-size: 15.5px; color: var(--fg); }
  .tool-summary {
    font-size: 14px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
    min-width: 0;
  }
  .deny-tag {
    margin-left: 4px;
    font-size: 12.5px;
    letter-spacing: 0.16em;
    padding: 1px 6px;
    border-radius: 3px;
    color: var(--danger);
    border: 1px solid var(--danger);
  }
  .deny-reason {
    margin: 6px 0 0;
    color: var(--danger);
    font-size: 14.5px;
    padding: 0 12px 6px;
  }
  .tool-result { border-left-color: oklch(0.50 0.15 50); }
  .tool-result .block-tag { background: oklch(0.50 0.15 50 / 0.15); color: var(--warning); }
  .thinking { border-left-color: var(--fg-3); }

  pre {
    margin: 0;
    padding: 8px 10px 10px;
    background: var(--bg);
    color: var(--fg-2);
    font-size: 15.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    border-top: 1px solid var(--border);
  }
  .copy {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-3);
    border-radius: var(--r-1);
    padding: 1px 6px;
    font-size: 13.5px;
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .block summary:hover .copy { opacity: 1; }
  .copy:hover { color: var(--fg); border-color: var(--border-hi); }

  .delegate-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--accent-soft, var(--surface));
    border: 1px solid var(--accent-line, var(--border));
    border-left: 2px solid var(--accent, var(--border-hi));
    color: var(--fg);
    padding: 6px 10px;
    border-radius: var(--r-2);
    font-size: 11.5px;
    cursor: pointer;
    text-align: left;
    max-width: 100%;
    transition: border-color var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
  }
  .delegate-chip:hover {
    border-color: var(--accent);
  }
  .delegate-chip.returned {
    border-left-color: var(--success, oklch(0.50 0.15 155));
    background: color-mix(in oklab, var(--success, oklch(0.50 0.15 155)) 12%, transparent);
  }
  .chip-icon {
    display: inline-flex;
    align-items: center;
    color: var(--accent);
  }
  .delegate-chip.returned .chip-icon { color: var(--success); }
  .chip-tag {
    font-size: 9.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }
  .delegate-chip.returned .chip-tag { color: var(--success); }
  .chip-desc {
    color: var(--fg-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
</style>
