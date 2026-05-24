<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { cli, doctorRun, refreshClaudePath, abortSection } from "./cli";
  import { X, Check } from "./icons";

  export let open = false;
  export let embedded = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  $: section = $cli.sections.doctor;
  $: binaryPath = $cli.binaryPath;
  $: searched = $cli.searched;
  $: resolved = $cli.resolved;

  $: parsed = section.value as
    | { raw: string; items: { name: string; ok: boolean; detail?: string }[] }
    | null;

  onMount(() => {
    void (async () => {
      if (!resolved) await refreshClaudePath();
    })();
  });
</script>

{#if open || embedded}
  {#if !embedded}
    <button class="scrim" on:click={() => dispatch("close")} aria-label="Close doctor"></button>
  {/if}
  <div class="panel" class:embedded role="dialog" aria-modal={embedded ? undefined : "true"} aria-label="Doctor">
    <header class="head">
      <div class="title">
        <span class="eyebrow">CLI · DOCTOR</span>
        <h2>Health check</h2>
      </div>
      <div class="head-right">
        {#if section.running}
          <button class="ghost mono" on:click={() => void abortSection("doctor")}>cancel</button>
        {/if}
        <button class="close" on:click={() => dispatch("close")} aria-label="Close"><X size={14} stroke={1.8} /></button>
      </div>
    </header>

    <div class="body">
      {#if !binaryPath && resolved}
        <div class="notfound">
          <p class="bad">Claude CLI not found.</p>
          <p class="muted">Searched paths:</p>
          <ul class="paths">
            {#each searched as p}
              <li class="mono">{p}</li>
            {/each}
          </ul>
          <p class="muted">Install: <code class="mono">npm install -g @anthropic-ai/claude-code</code></p>
        </div>
      {:else}
        <div class="actions">
          <button
            class="primary mono"
            disabled={section.running}
            on:click={() => void doctorRun()}
          >
            {section.running ? "Running…" : parsed ? "Re-run check" : "Run check"}
          </button>
          {#if section.exit !== null}
            <span class="muted mono">exit: {section.exit}</span>
          {/if}
        </div>

        {#if section.error}
          <pre class="err">{section.error}</pre>
        {/if}

        {#if parsed && parsed.items.length > 0}
          <ul class="checklist">
            {#each parsed.items as it}
              <li class="check {it.ok ? 'ok' : 'bad'}">
                <span class="icon" aria-hidden="true">
                  {#if it.ok}<Check size={13} stroke={2} />{:else}<X size={13} stroke={2} />{/if}
                </span>
                <div class="ck-body">
                  <div class="ck-name">{it.name}</div>
                  {#if it.detail}
                    <div class="ck-detail mono">{it.detail}</div>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}

        {#if section.output}
          <details open={!parsed || parsed.items.length === 0}>
            <summary class="mono">raw output</summary>
            <pre class="console">{section.output}</pre>
          </details>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed; inset: 0;
    background: oklch(0 0 0 / 0.55);
    backdrop-filter: blur(4px);
    z-index: 60; border: 0; padding: 0; cursor: pointer;
    animation: fade-in var(--dur-2) var(--ease);
  }
  .panel.embedded {
    position: relative;
    inset: auto;
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    z-index: auto;
    animation: none;
  }
  .panel.embedded :global(.close) { display: none; }
  .panel {
    position: fixed; inset: 24px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-3);
    box-shadow: var(--shadow-lg);
    display: grid;
    grid-template-rows: auto 1fr;
    z-index: 61;
    overflow: hidden;
    animation: slide-up var(--dur-2) var(--ease);
  }
  .head {
    display: flex; align-items: center;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border);
    gap: 12px;
  }
  .title h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 21.5px; font-weight: 600;
  }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12.5px;
    color: var(--fg-4);
    font-family: var(--font-mono);
  }
  .head-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .close {
    width: 32px; height: 32px;
    border: 1px solid var(--border);
    background: transparent; color: var(--fg-2);
    border-radius: var(--r-2); cursor: pointer; font-size: 17px;
  }
  .close:hover { color: var(--fg); border-color: var(--border-hi); }

  .body { overflow: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }

  .actions { display: flex; align-items: center; gap: 12px; }
  .ghost {
    background: transparent; color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 6px 12px; cursor: pointer;
    font-family: var(--font-mono); font-size: 14.5px;
  }
  .ghost:hover { color: var(--fg); border-color: var(--border-hi); }
  .primary {
    background: var(--accent); color: oklch(0.16 0.04 75);
    border: 0; border-radius: var(--r-2);
    padding: 7px 14px; cursor: pointer;
    font-weight: 600; font-size: 15.5px;
  }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .primary:hover:not(:disabled) { filter: brightness(1.08); }
  .muted { color: var(--fg-3); font-size: 15px; }
  .bad { color: var(--danger); }

  .checklist { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  .check {
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    background: var(--bg);
  }
  .check.ok .icon { color: var(--accent); }
  .check.bad .icon { color: var(--danger); }
  .check.bad { border-color: var(--danger); }
  .ck-name { font-size: 16px; color: var(--fg); }
  .ck-detail { font-size: 14.5px; color: var(--fg-3); margin-top: 2px; }

  pre.console, pre.err {
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 15px;
    margin: 0;
    overflow: auto;
    max-height: 320px;
    white-space: pre-wrap;
    color: var(--fg);
  }
  pre.err { color: var(--danger); }
  details summary { cursor: pointer; color: var(--fg-3); font-size: 15px; padding: 4px 0; }

  .notfound { padding: 16px; }
  .paths { padding-left: 20px; font-size: 15px; }

  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
</style>
