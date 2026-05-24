<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import {
    cli,
    ultrareviewRun,
    refreshClaudePath,
    abortSection,
  } from "./cli";
  import { settings } from "./settings";
  import { X, AlertTriangle } from "./icons";

  export let open = false;
  export let embedded = false;
  export let initialTarget: string | undefined = undefined;

  const dispatch = createEventDispatcher<{ close: void }>();

  $: section = $cli.sections.ultrareview;
  $: binaryPath = $cli.binaryPath;
  $: searched = $cli.searched;
  $: resolved = $cli.resolved;

  let target = "";
  let confirmOpen = false;

  // When the panel is opened with an initialTarget, prefill the input.
  // If `ultrareviewAutoRun` setting is enabled, immediately kick off the
  // (billed) review without showing the confirm modal.
  let lastSeenInitial: string | undefined = undefined;
  $: if (open && initialTarget !== lastSeenInitial) {
    lastSeenInitial = initialTarget;
    if (initialTarget && initialTarget.trim()) {
      target = initialTarget;
      if ($settings.ultrareviewAutoRun && !section.running) {
        void ultrareviewRun(target);
      }
    }
  }
  $: if (!open) {
    lastSeenInitial = undefined;
  }

  onMount(() => {
    void (async () => {
      if (!resolved) await refreshClaudePath();
    })();
  });

  async function handleRun(): Promise<void> {
    confirmOpen = false;
    await ultrareviewRun(target);
  }
</script>

{#if open || embedded}
  {#if !embedded}
    <button class="scrim" on:click={() => dispatch("close")} aria-label="Close ultrareview"></button>
  {/if}
  <div class="panel" class:embedded role="dialog" aria-modal={embedded ? undefined : "true"} aria-label="Ultrareview">
    <header class="head">
      <div class="title">
        <span class="eyebrow">CLI · ULTRAREVIEW</span>
        <h2>Cloud multi-agent review</h2>
      </div>
      <div class="head-right">
        {#if section.running}
          <button class="ghost mono" on:click={() => void abortSection("ultrareview")}>cancel</button>
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
        <section class="card warn-card">
          <p class="warn-title mono"><span class="warn-ico" aria-hidden="true"><AlertTriangle size={12} stroke={1.8} /></span> BILLED — runs in Anthropic cloud</p>
          <p class="muted">
            <code class="mono">claude ultrareview</code> spawns a multi-agent review against your
            current branch (or a PR / base branch) and consumes API credits.
          </p>
        </section>

        <section class="card">
          <header class="card-h">
            <span class="eyebrow">TARGET</span>
            <span class="muted mono">optional · PR# / branch / base ref</span>
          </header>
          <input
            class="mono target-input"
            placeholder="leave empty to review current branch"
            bind:value={target}
            disabled={section.running}
          />
          <div class="actions">
            <button
              class="primary mono"
              disabled={section.running}
              on:click={() => (confirmOpen = true)}
            >
              {section.running ? "Running…" : "Run review"}
            </button>
          </div>
        </section>

        {#if section.error}
          <pre class="err">{section.error}</pre>
        {/if}

        {#if section.output || section.running}
          <section class="card">
            <header class="card-h">
              <span class="eyebrow">FINDINGS</span>
              {#if section.exit !== null}
                <span class="muted mono">exit: {section.exit}</span>
              {/if}
            </header>
            <pre class="findings">{section.output || (section.running ? "waiting for output…" : "")}</pre>
          </section>
        {/if}
      {/if}
    </div>
  </div>

  {#if confirmOpen}
    <div class="confirm-scrim">
      <div class="confirm-card">
        <h3>Confirm cloud review</h3>
        <p class="muted">
          This runs <code class="mono">claude ultrareview{target ? ` ${target}` : ""}</code>
          which is billed against your Anthropic account. Continue?
        </p>
        <div class="confirm-actions">
          <button class="ghost mono" on:click={() => (confirmOpen = false)}>cancel</button>
          <button class="primary mono" on:click={() => void handleRun()}>Run anyway</button>
        </div>
      </div>
    </div>
  {/if}
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
    display: flex; flex-direction: column; gap: 10px;
  }
  .warn-card { border-color: var(--warning, var(--accent)); }
  .warn-title { color: var(--warning, var(--accent)); font-size: 15.5px; display: inline-flex; align-items: center; gap: 6px; }
  .warn-ico { display: inline-flex; align-items: center; }
  .card-h { display: flex; align-items: center; gap: 10px; }

  .target-input {
    background: transparent; color: var(--fg);
    border: 0;
    border-bottom: 1px solid var(--border);
    padding: 6px 0;
    font-family: var(--font-mono); font-size: 16px;
    width: 100%;
  }
  .target-input:focus { outline: none; border-bottom-color: var(--accent); }
  .target-input:disabled { opacity: 0.6; }

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
  .bad { color: var(--danger); }

  .findings, .err {
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 15px;
    margin: 0;
    overflow: auto;
    max-height: 480px;
    white-space: pre-wrap;
    color: var(--fg);
  }
  .err { color: var(--danger); }

  .notfound { padding: 16px; }
  .paths { padding-left: 20px; font-size: 15px; }

  /* confirm modal */
  .confirm-scrim {
    position: fixed; inset: 0;
    background: oklch(0 0 0 / 0.65);
    z-index: 70;
    display: grid; place-items: center;
    padding: 24px;
    animation: fade-in var(--dur-2) var(--ease);
  }
  .confirm-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 18px;
    width: min(480px, 100%);
    display: flex; flex-direction: column; gap: 12px;
  }
  .confirm-card h3 { margin: 0; font-size: 18.5px; }
  .confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }

  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
</style>
