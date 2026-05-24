<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { settings, patchSettings } from "./settings";
  import { randomHex } from "./types";

  export let open = false;
  export let embedded = false;
  /** Last reported relay state from the sidecar (driven by App.svelte). */
  export let state: "disconnected" | "connecting" | "live" | "error" =
    "disconnected";
  export let forwardedCount = 0;
  export let lastError: string | null = null;
  /** Optional user-hosted web client base used to build the join URL.
   *  We don't ship one — leave blank and the panel surfaces the raw params. */
  export let webClientBase = "";

  const dispatch = createEventDispatcher<{
    apply: void;
    disconnect: void;
    close: void;
  }>();

  let tokenRevealed = false;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;

  function revealToken() {
    tokenRevealed = true;
    if (revealTimer) clearTimeout(revealTimer);
    // auto-mask after 30s for safety
    revealTimer = setTimeout(() => {
      tokenRevealed = false;
    }, 30_000);
  }

  function maskToken() {
    tokenRevealed = false;
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
  }

  function regenerateToken() {
    patchSettings({ remoteControlAuthToken: randomHex(32) });
    tokenRevealed = false;
  }

  function regenerateSession() {
    patchSettings({ remoteControlSessionName: randomHex(4) });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  }

  $: joinUrl = (() => {
    const s = $settings;
    const base = (webClientBase || "").trim() || "https://example.invalid/";
    const u = new URL(base);
    u.searchParams.set("relay", s.remoteControlRelayUrl);
    u.searchParams.set("session", s.remoteControlSessionName);
    u.searchParams.set("token", s.remoteControlAuthToken);
    return u.toString();
  })();

  /** Tiny textual "QR" — we render the raw join URL inside a monospaced box.
   *  A real QR matrix would require shipping a QR lib; spec allows textual
   *  fallback. The user can paste/scan via any external QR generator. */
  function close() {
    dispatch("close");
  }

  onDestroy(() => {
    if (revealTimer) clearTimeout(revealTimer);
  });

  onMount(() => {
    // ensure session/token are set (older saved settings may lack them)
    const s = $settings;
    if (!s.remoteControlSessionName)
      patchSettings({ remoteControlSessionName: randomHex(4) });
    if (!s.remoteControlAuthToken)
      patchSettings({ remoteControlAuthToken: randomHex(32) });
  });

  $: stateLabel =
    state === "live"
      ? "live"
      : state === "connecting"
        ? "connecting…"
        : state === "error"
          ? "error"
          : "disconnected";
</script>

{#if open || embedded}
  <div
    class="overlay"
    class:embedded
    role="dialog"
    aria-modal={embedded ? undefined : "true"}
    aria-label="Remote control"
    on:click|self={(e) => { if (!embedded) close(); }}
    on:keydown={(e) => e.key === "Escape" && !embedded && close()}
  >
    <div class="sheet">
      <header class="head">
        <div>
          <div class="eyebrow mono">REMOTE CONTROL · SELF-HOSTED (ADVANCED)</div>
          <h2>Drive this session from another device</h2>
          <p class="advanced-note">
            Custom self-hosted relay (advanced). For most users, use the
            <strong>Pair with mobile</strong> button in the topbar — it uses
            Anthropic's hosted relay and pairs directly with the Claude
            mobile app. Self-host only if you have an API-key-only setup
            or need a non-claude.ai bridge.
          </p>
        </div>
        <button class="x" on:click={close} aria-label="Close">×</button>
      </header>

      <div class="body">
        <section class="row state-row" data-state={state}>
          <div class="state-dot" aria-hidden="true"></div>
          <div class="state-text">
            <div class="state-label mono">{stateLabel}</div>
            {#if lastError && state === "error"}
              <div class="state-err mono">{lastError}</div>
            {:else if state === "live"}
              <div class="state-sub">
                Forwarded {forwardedCount} frames since connect
              </div>
            {:else}
              <div class="state-sub">
                {state === "disconnected"
                  ? "Toggle the switch below to connect."
                  : "Negotiating with relay…"}
              </div>
            {/if}
          </div>
          <label class="switch">
            <input
              type="checkbox"
              checked={$settings.remoteControlEnabled}
              on:change={(e) => {
                patchSettings({
                  remoteControlEnabled: (e.target as HTMLInputElement).checked,
                });
                dispatch("apply");
              }}
            />
            <span class="slider"></span>
          </label>
        </section>

        <section class="row">
          <label class="lbl">Relay URL</label>
          <input
            class="input mono"
            type="text"
            placeholder="wss://relay.example.com"
            bind:value={$settings.remoteControlRelayUrl}
          />
          <button
            class="btn-mini"
            on:click={() => copy($settings.remoteControlRelayUrl)}
            title="Copy">copy</button
          >
        </section>

        <section class="row">
          <label class="lbl">Session name</label>
          <input
            class="input mono"
            type="text"
            bind:value={$settings.remoteControlSessionName}
          />
          <button class="btn-mini" on:click={regenerateSession} title="Regenerate"
            >new</button
          >
          <button
            class="btn-mini"
            on:click={() => copy($settings.remoteControlSessionName)}
            title="Copy">copy</button
          >
        </section>

        <section class="row">
          <label class="lbl">Auth token</label>
          <input
            class="input mono token"
            type={tokenRevealed ? "text" : "password"}
            bind:value={$settings.remoteControlAuthToken}
          />
          {#if tokenRevealed}
            <button class="btn-mini" on:click={maskToken} title="Hide"
              >hide</button
            >
          {:else}
            <button class="btn-mini" on:click={revealToken} title="Show for 30s"
              >show</button
            >
          {/if}
          <button class="btn-mini" on:click={regenerateToken} title="Regenerate"
            >new</button
          >
          <button
            class="btn-mini"
            on:click={() => copy($settings.remoteControlAuthToken)}
            title="Copy">copy</button
          >
        </section>

        <section class="row qr-row">
          <label class="lbl">Join URL</label>
          <div class="qr-box mono" title="Paste into any QR generator">
            {joinUrl}
          </div>
          <button class="btn-mini" on:click={() => copy(joinUrl)} title="Copy"
            >copy</button
          >
        </section>

        <section class="actions-row">
          <button
            class="btn"
            disabled={!$settings.remoteControlEnabled || state === "disconnected"}
            on:click={() => {
              patchSettings({ remoteControlEnabled: false });
              dispatch("disconnect");
            }}>Disconnect</button
          >
          <button
            class="btn primary"
            on:click={() => dispatch("apply")}
            title="Reconnect with current settings"
          >
            {state === "live" ? "Reapply" : "Connect"}
          </button>
        </section>

        <p class="hint">
          The user is responsible for hosting (or trusting) the relay server. Reference
          implementation: <code class="mono">docs/REMOTE_CONTROL_PROTOCOL.md</code>.
        </p>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    display: grid;
    place-items: center;
    backdrop-filter: blur(4px);
  }
  .overlay.embedded {
    position: relative;
    inset: auto;
    z-index: auto;
    background: transparent;
    backdrop-filter: none;
    width: 100%;
    height: 100%;
    place-items: stretch;
  }
  .overlay.embedded .sheet {
    width: 100%;
    max-height: none;
    height: 100%;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .sheet {
    width: min(680px, 92vw);
    max-height: 86vh;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-3);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: column;
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 18px 22px 12px;
    border-bottom: 1px solid var(--line);
  }
  .head h2 {
    margin: 4px 0 0;
    font-size: 19.5px;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--fg);
  }
  .advanced-note {
    margin: 8px 0 0;
    max-width: 56ch;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--fg-3);
  }
  .advanced-note strong {
    color: var(--fg);
  }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12.5px;
    color: var(--fg-4);
  }
  .x {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    color: var(--fg-3);
    font-size: 18.5px;
    width: 28px;
    height: 28px;
    cursor: pointer;
  }
  .x:hover {
    color: var(--fg);
    border-color: var(--accent-line);
  }

  .body {
    padding: 14px 22px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row {
    display: grid;
    grid-template-columns: 110px 1fr auto auto auto auto;
    align-items: center;
    gap: 8px;
  }
  .lbl {
    font-size: 15px;
    color: var(--fg-3);
    font-family: var(--font-mono);
  }
  .input {
    grid-column: 2 / 3;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    color: var(--fg);
    padding: 6px 10px;
    font-size: 16px;
  }
  .input:focus {
    outline: none;
    border-color: var(--accent-line);
  }
  .input.token {
    letter-spacing: 0.05em;
  }
  .btn-mini {
    background: var(--elevated);
    border: 1px solid var(--border);
    color: var(--fg-3);
    padding: 4px 8px;
    border-radius: var(--r-1);
    font-size: 13.5px;
    font-family: var(--font-mono);
    cursor: pointer;
    letter-spacing: 0.06em;
  }
  .btn-mini:hover {
    color: var(--fg);
    border-color: var(--accent-line);
  }

  .state-row {
    grid-template-columns: 14px 1fr auto;
    padding: 10px 12px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    margin-bottom: 4px;
  }
  .state-dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--fg-4);
  }
  .state-row[data-state="live"] .state-dot {
    background: var(--accent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .state-row[data-state="connecting"] .state-dot {
    background: var(--accent);
    animation: pulse-ring 1.4s ease-in-out infinite;
  }
  .state-row[data-state="error"] .state-dot {
    background: var(--danger);
  }
  .state-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .state-label {
    font-size: 15.5px;
    color: var(--fg);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .state-sub,
  .state-err {
    font-size: 14.5px;
    color: var(--fg-3);
  }
  .state-err {
    color: var(--danger);
    word-break: break-word;
  }

  .switch {
    position: relative;
    width: 36px;
    height: 20px;
    display: inline-block;
  }
  .switch input {
    opacity: 0;
    width: 100%;
    height: 100%;
    cursor: pointer;
    position: absolute;
    inset: 0;
    z-index: 1;
  }
  .slider {
    position: absolute;
    inset: 0;
    background: var(--border);
    border-radius: 999px;
    transition: background var(--dur-1) var(--ease);
  }
  .slider::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 999px;
    background: var(--fg);
    transition: transform var(--dur-1) var(--ease);
  }
  .switch input:checked + .slider {
    background: var(--accent);
  }
  .switch input:checked + .slider::after {
    transform: translateX(16px);
  }

  .qr-row {
    grid-template-columns: 110px 1fr auto;
    align-items: stretch;
  }
  .qr-box {
    grid-column: 2 / 3;
    background: var(--bg);
    border: 1px dashed var(--border);
    color: var(--fg-2);
    padding: 10px 12px;
    border-radius: var(--r-2);
    font-size: 13.5px;
    word-break: break-all;
    line-height: 1.45;
  }

  .actions-row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
  }
  .btn {
    background: var(--elevated);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 7px 14px;
    border-radius: var(--r-2);
    font-size: 15.5px;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--accent-line);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
  }
  .btn.primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .hint {
    margin: 6px 0 0;
    font-size: 14.5px;
    color: var(--fg-4);
  }
  .hint code {
    color: var(--fg-2);
    background: var(--elevated);
    padding: 1px 5px;
    border-radius: var(--r-1);
  }
</style>
