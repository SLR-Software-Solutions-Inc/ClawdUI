<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { X } from "./icons";
  import {
    cli,
    authSignedIn,
    authStatus,
    authLogin,
    authLogout,
    setupToken,
    refreshClaudePath,
    abortSection,
  } from "./cli";

  export let open = false;
  export let embedded = false;

  const dispatch = createEventDispatcher<{ close: void; toast: string }>();

  $: status = $cli.sections.auth;
  $: login = $cli.sections.authLogin;
  $: logout = $cli.sections.authLogout;
  $: token = $cli.sections.setupToken;
  $: binaryPath = $cli.binaryPath;
  $: searched = $cli.searched;
  $: resolved = $cli.resolved;
  $: signedIn = $authSignedIn;

  onMount(() => {
    void (async () => {
      if (!resolved) await refreshClaudePath();
      if ($cli.binaryPath && !status.running && !status.value && !status.error) {
        await authStatus();
      }
    })();
  });

  // Auto-refresh status after login completes (running -> not running).
  // Also auto-refresh after logout completes so the panel reflects the new state.
  let prevLoginRunning = false;
  let prevLogoutRunning = false;
  let prevSignedInState: "signed-in" | "signed-out" | "unknown" = "unknown";
  $: {
    if (prevLoginRunning && !login.running) {
      // login finished — refresh status (best-effort).
      if (binaryPath) void authStatus();
    }
    prevLoginRunning = login.running;
  }
  $: {
    if (prevLogoutRunning && !logout.running) {
      if (binaryPath) void authStatus();
    }
    prevLogoutRunning = logout.running;
  }
  // Toast + auto-close on signed-out -> signed-in transition. The panel was
  // previously left open after the OAuth browser tab confirmed login, forcing
  // the user to manually dismiss it and guess whether anything worked.
  $: {
    const cur = signedIn.state;
    if (
      cur === "signed-in" &&
      prevSignedInState !== "signed-in" &&
      prevSignedInState !== "unknown"
    ) {
      dispatch(
        "toast",
        signedIn.user
          ? `✓ Signed in as ${signedIn.user}`
          : "✓ Signed in to Claude",
      );
      if (!embedded) {
        // Brief delay so the user sees the green status flip before the
        // panel disappears, then close so they land back in the chat.
        setTimeout(() => dispatch("close"), 900);
      }
    }
    prevSignedInState = cur;
  }

  // After kicking off `claude auth login`, poll `authStatus` every 3s while
  // the OAuth flow is happening in the browser. The CLI's own stdout doesn't
  // re-fire when the user completes login in the browser; polling is what
  // turns the green pill on. Stops automatically once we reach signed-in or
  // the login section is no longer running.
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  $: {
    const shouldPoll =
      (login.running || (login.value && signedIn.state !== "signed-in")) &&
      !!binaryPath;
    if (shouldPoll && !pollTimer) {
      pollTimer = setInterval(() => {
        if (signedIn.state === "signed-in") {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          return;
        }
        void authStatus();
      }, 3000);
    } else if (!shouldPoll && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  $: parsedStatus = (() => {
    const v = status.value as
      | { json?: unknown; raw?: string }
      | null
      | undefined;
    if (!v) return null;
    return v.json ?? null;
  })();

  $: rawStatus = (() => {
    const v = status.value as
      | { json?: unknown; raw?: string }
      | null
      | undefined;
    return v?.raw ?? "";
  })();

  function urlsIn(text: string): string[] {
    if (!text) return [];
    const re = /https?:\/\/[^\s'"<>]+/g;
    return Array.from(new Set(text.match(re) ?? []));
  }
</script>

{#if open || embedded}
  {#if !embedded}
    <button class="scrim" on:click={() => dispatch("close")} aria-label="Close auth"></button>
  {/if}
  <div class="panel" class:embedded role="dialog" aria-modal={embedded ? undefined : "true"} aria-label="Authentication">
    <header class="head">
      <div class="title">
        <span class="eyebrow">CLI · AUTH</span>
        <h2>Authentication</h2>
      </div>
      <div class="head-right">
        <button class="ghost mono" on:click={() => void authStatus()} disabled={!binaryPath || status.running}>
          {status.running ? "checking…" : "refresh"}
        </button>
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
        {#if signedIn.state !== "signed-in"}
          <p class="hint mono" role="note">
            Click the Auth icon (right side) → Sign in → follow browser flow.
          </p>
        {/if}

        <section class="card">
          <header class="card-h">
            <span class="eyebrow">STATUS</span>
            {#if status.running}
              <span class="muted mono">checking…</span>
            {:else if signedIn.state === "signed-in"}
              <span class="ok mono">
                <span class="dot ok-dot" aria-hidden="true"></span>
                signed in
              </span>
            {:else if signedIn.state === "signed-out"}
              <span class="bad mono">
                <span class="dot bad-dot" aria-hidden="true"></span>
                signed out
              </span>
            {:else if status.error}
              <span class="bad mono">error</span>
            {:else if parsedStatus}
              <span class="ok mono">ok</span>
            {/if}
          </header>

          {#if signedIn.state === "signed-in"}
            <p class="ok mono ack">
              {signedIn.user
                ? `Signed in as ${signedIn.user}`
                : "Signed in to Claude"}
            </p>
          {:else if signedIn.state === "signed-out" && !status.running}
            <p class="muted">Not signed in. Click "Sign in" below to start the browser flow.</p>
          {/if}

          {#if status.error}
            <pre class="err">{status.error}</pre>
          {:else if parsedStatus}
            <details>
              <summary class="mono">raw status</summary>
              <pre class="json">{JSON.stringify(parsedStatus, null, 2)}</pre>
            </details>
          {:else if rawStatus}
            <details>
              <summary class="mono">raw status</summary>
              <pre class="raw">{rawStatus}</pre>
            </details>
          {:else if !status.running && signedIn.state === "unknown"}
            <p class="muted">no status yet</p>
          {/if}
        </section>

        <section class="card">
          <header class="card-h">
            <span class="eyebrow">LOGIN</span>
            {#if login.running}
              <button class="ghost mono" on:click={() => void abortSection("authLogin")}>cancel</button>
            {/if}
          </header>
          <div class="actions">
            {#if signedIn.state === "signed-in"}
              <button
                class="ghost mono"
                disabled={logout.running}
                on:click={() => void authLogout()}
              >
                {logout.running ? "Logging out…" : "Sign out"}
              </button>
            {:else}
              <button
                class="primary mono"
                disabled={login.running}
                on:click={() => void authLogin()}
              >
                {login.running ? "Logging in…" : "Sign in"}
              </button>
            {/if}
            <button
              class="ghost mono"
              disabled={token.running}
              on:click={() => void setupToken()}
            >
              {token.running ? "Generating…" : "Setup long-lived token"}
            </button>
          </div>

          {#if login.output || login.error}
            <details open>
              <summary class="mono">login output</summary>
              {#if urlsIn(login.output).length > 0}
                <div class="urls">
                  <span class="muted">browser url(s):</span>
                  {#each urlsIn(login.output) as u}
                    <a class="mono" href={u} target="_blank" rel="noreferrer">{u}</a>
                  {/each}
                </div>
              {/if}
              <pre class="console">{login.output}{login.error ? "\n[error] " + login.error : ""}</pre>
            </details>
          {/if}

          {#if logout.output || logout.error || logout.value}
            <details open>
              <summary class="mono">logout output</summary>
              <pre class="console">{(logout.value as { stdout?: string } | null)?.stdout ?? logout.output}{logout.error ? "\n[error] " + logout.error : ""}</pre>
            </details>
          {/if}

          {#if token.output || token.error}
            <details open>
              <summary class="mono">setup-token output</summary>
              {#if urlsIn(token.output).length > 0}
                <div class="urls">
                  <span class="muted">browser url(s):</span>
                  {#each urlsIn(token.output) as u}
                    <a class="mono" href={u} target="_blank" rel="noreferrer">{u}</a>
                  {/each}
                </div>
              {/if}
              <pre class="console">{token.output}{token.error ? "\n[error] " + token.error : ""}</pre>
            </details>
          {/if}
        </section>
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
    letter-spacing: -0.01em;
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

  .body {
    overflow: auto;
    padding: 18px 20px;
    display: flex; flex-direction: column; gap: 16px;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 14px 16px;
    background: var(--bg);
    display: flex; flex-direction: column; gap: 12px;
  }
  .card-h { display: flex; align-items: center; gap: 10px; }
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
    background: var(--accent);
    color: oklch(0.16 0.04 75);
    border: 0; border-radius: var(--r-2);
    padding: 7px 14px; cursor: pointer;
    font-weight: 600; font-size: 15.5px;
    transition: filter var(--dur-1) var(--ease);
  }
  .primary:hover:not(:disabled) { filter: brightness(1.08); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }

  pre.json, pre.raw, pre.console, pre.err {
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 15px;
    margin: 0;
    overflow: auto;
    max-height: 280px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg);
  }
  pre.err { color: var(--danger); }
  .muted { color: var(--fg-3); font-size: 15px; }
  .ok { color: var(--accent); }
  .bad { color: var(--danger); }
  details { font-size: 15.5px; }
  details summary { cursor: pointer; color: var(--fg-3); padding: 4px 0; }
  .urls { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; font-size: 15.5px; }
  .urls a { color: var(--accent); word-break: break-all; }
  .notfound { padding: 16px; }
  .paths { padding-left: 20px; font-size: 15px; }

  .hint {
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--r-1);
    background: color-mix(in oklch, var(--accent) 8%, var(--bg));
    color: var(--fg-2);
    font-size: 14px;
    line-height: 1.4;
  }
  .ack {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: 1px;
  }
  .ok-dot {
    background: var(--accent);
    box-shadow: 0 0 6px color-mix(in oklch, var(--accent) 70%, transparent);
  }
  .bad-dot {
    background: var(--danger);
  }

  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
</style>
