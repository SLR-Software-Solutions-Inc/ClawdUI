<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import {
    cli,
    updateCheck,
    updateApply,
    refreshClaudePath,
    abortSection,
  } from "./cli";
  import { X } from "./icons";

  export let open = false;
  export let embedded = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  $: check = $cli.sections.updateCheck;
  $: apply = $cli.sections.updateApply;
  $: binaryPath = $cli.binaryPath;
  $: searched = $cli.searched;
  $: resolved = $cli.resolved;

  $: parsed = check.value as
    | { current: string | null; latest: string | null; available: boolean; raw: string }
    | null;

  onMount(() => {
    void (async () => {
      if (!resolved) await refreshClaudePath();
    })();
  });
</script>

{#if open || embedded}
  {#if !embedded}
    <button class="scrim" on:click={() => dispatch("close")} aria-label="Close update"></button>
  {/if}
  <div class="panel" class:embedded role="dialog" aria-modal={embedded ? undefined : "true"} aria-label="Updates">
    <header class="head">
      <div class="title">
        <span class="eyebrow">CLI · UPDATE</span>
        <h2>Updates</h2>
      </div>
      <div class="head-right">
        {#if check.running || apply.running}
          <button class="ghost mono" on:click={() => {
            void abortSection(check.running ? "updateCheck" : "updateApply");
          }}>cancel</button>
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
            {#each searched as p}<li class="mono">{p}</li>{/each}
          </ul>
          <p class="muted">Install: <code class="mono">npm install -g @anthropic-ai/claude-code</code></p>
        </div>
      {:else}
        <section class="card">
          <header class="card-h">
            <span class="eyebrow">VERSIONS</span>
          </header>
          <div class="versions">
            <div class="ver">
              <span class="muted mono">current</span>
              <span class="mono v">{parsed?.current ?? "—"}</span>
            </div>
            <div class="ver">
              <span class="muted mono">latest</span>
              <span class="mono v">{parsed?.latest ?? "—"}</span>
            </div>
            <div class="ver">
              <span class="muted mono">status</span>
              <span class="mono v">
                {#if check.running}
                  checking…
                {:else if !parsed}
                  unknown
                {:else if parsed.available}
                  <span class="warn">update available</span>
                {:else}
                  <span class="ok">up to date</span>
                {/if}
              </span>
            </div>
          </div>
          <div class="actions">
            <button
              class="ghost mono"
              disabled={check.running}
              on:click={() => void updateCheck()}
            >
              {check.running ? "checking…" : "Check for updates"}
            </button>
            <button
              class="primary mono"
              disabled={apply.running || (parsed != null && !parsed.available)}
              on:click={() => void updateApply()}
              title={parsed && !parsed.available ? "already up to date" : ""}
            >
              {apply.running ? "Updating…" : "Update now"}
            </button>
          </div>
        </section>

        {#if check.error}
          <pre class="err">{check.error}</pre>
        {/if}
        {#if check.output}
          <details>
            <summary class="mono">check output</summary>
            <pre class="console">{check.output}</pre>
          </details>
        {/if}

        {#if apply.output || apply.error}
          <section class="card">
            <header class="card-h">
              <span class="eyebrow">INSTALL OUTPUT</span>
              {#if apply.exit !== null}
                <span class="muted mono">exit: {apply.exit}</span>
              {/if}
            </header>
            {#if apply.error}
              <pre class="err">{apply.error}</pre>
            {/if}
            <pre class="console">{apply.output}</pre>
          </section>
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
    margin: 0; font-family: var(--font-display);
    font-size: 21.5px; font-weight: 600;
  }
  .eyebrow {
    text-transform: uppercase; letter-spacing: 0.12em;
    font-size: 12.5px; color: var(--fg-4);
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
  .card {
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 14px 16px;
    background: var(--bg);
    display: flex; flex-direction: column; gap: 12px;
  }
  .card-h { display: flex; align-items: center; gap: 10px; }

  .versions {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px;
  }
  .ver { display: flex; flex-direction: column; gap: 4px; }
  .ver .v { font-size: 17px; color: var(--fg); }

  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .ghost {
    background: transparent; color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 6px 12px; cursor: pointer;
    font-family: var(--font-mono); font-size: 14.5px;
  }
  .ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--border-hi); }
  .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  .primary {
    background: var(--accent); color: oklch(0.16 0.04 75);
    border: 0; border-radius: var(--r-2);
    padding: 7px 14px; cursor: pointer;
    font-weight: 600; font-size: 15.5px;
  }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .primary:hover:not(:disabled) { filter: brightness(1.08); }

  .muted { color: var(--fg-3); font-size: 15px; }
  .ok { color: var(--accent); }
  .bad { color: var(--danger); }
  .warn { color: var(--warning, var(--accent)); }

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
