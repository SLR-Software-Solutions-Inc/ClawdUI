<!--
  MobilePair.svelte — small topbar button + modal that pairs ClawdUI's
  active session with the Claude mobile app via Anthropic's hosted relay.

  Flow:
    1. User clicks "Pair with mobile" (only enabled when a session is live).
    2. Sidecar receives `pair_mobile` RPC; sends `/remote-control` into the
       active SDK session.
    3. CLI emits a https://claude.ai/... pairing URL as assistant text.
    4. Sidecar parses + re-emits as `mobile_pair_url`; this component
       renders an inline QR + the URL itself for fallback.
    5. User scans the QR (or opens the URL on their phone) and approves
       the pairing in the Claude mobile app.

  The Anthropic-hosted relay requires `claude auth login` (claude.ai
  option) plus a Pro/Max/Team/Enterprise plan on the user's account.
  Errors surfaced from the CLI (auth/plan/etc.) are shown verbatim.
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import QRCode from "qrcode";
  import { settings } from "./settings";

  export let sessionStarted: boolean = false;
  export let rpc: (payload: unknown) => Promise<void>;
  /** Subscribe to sidecar events; returns an unsubscribe fn. */
  export let onSidecarEvent:
    | ((cb: (ev: any) => void) => () => void)
    | null = null;
  /** When true, render only the pairing modal — caller drives `openPair()`
   *  from outside (e.g. ActivityBar). */
  export let headless: boolean = false;
  /** Programmatic entry — call via `bind:this={mp}` then `mp.openPair()`. */
  export function openPair(): void { void start(); }

  let open = false;
  let url: string | null = null;
  let error: string | null = null;
  let via: "slash" | "sdk" | null = null;
  let qrSvg: string = "";
  let copied = false;
  let unsub: (() => void) | null = null;
  let sdkAttempted = false;

  function uuid(): string {
    return (
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? (crypto as any).randomUUID()
        : Math.random().toString(36).slice(2)
    );
  }

  async function startSlash() {
    sdkAttempted = false;
    via = "slash";
    try {
      await rpc({ id: uuid(), type: "pair_mobile" });
    } catch (e) {
      error = `pair_mobile RPC failed: ${e}`;
    }
  }

  async function start() {
    open = true;
    url = null;
    error = null;
    via = null;
    qrSvg = "";
    copied = false;
    sdkAttempted = false;

    const orgUuid = ($settings.claudeOrgUuid ?? "").trim();
    if (orgUuid) {
      // Try direct SDK path first; fall back to slash-command on error.
      sdkAttempted = true;
      via = "sdk";
      try {
        await rpc({
          id: uuid(),
          type: "connect_remote_control_direct",
          org_uuid: orgUuid,
        });
        return;
      } catch (e) {
        // Fall through to slash-command path below.
        // eslint-disable-next-line no-console
        console.warn("[MobilePair] direct SDK RPC failed, falling back:", e);
      }
    }
    await startSlash();
  }

  function close() {
    open = false;
    url = null;
    error = null;
    qrSvg = "";
    via = null;
    sdkAttempted = false;
  }

  async function renderQr(value: string) {
    try {
      qrSvg = await QRCode.toString(value, {
        type: "svg",
        margin: 1,
        width: 220,
        errorCorrectionLevel: "M",
      });
    } catch (e) {
      // QR render failure is non-fatal — URL is still copyable.
      qrSvg = "";
    }
  }

  async function copyUrl() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // ignore — user can long-press the textbox
    }
  }

  onMount(() => {
    if (!onSidecarEvent) return;
    unsub = onSidecarEvent((ev) => {
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "mobile_pair_url" && typeof ev.url === "string") {
        url = ev.url;
        error = null;
        if (typeof ev.via === "string") via = ev.via as "slash" | "sdk";
        void renderQr(ev.url);
      } else if (ev.type === "mobile_pair_error") {
        // If the direct SDK path failed and we haven't yet retried via the
        // slash-command path, automatically fall back so the user keeps a
        // working pairing flow even when their token is unrecoverable.
        if (sdkAttempted && ev.via === "sdk" && sessionStarted) {
          sdkAttempted = false;
          // eslint-disable-next-line no-console
          console.warn("[MobilePair] direct SDK path failed, falling back to /remote-control:", ev.error);
          void startSlash();
          return;
        }
        error = ev.error || "pairing failed";
        url = null;
        qrSvg = "";
        if (typeof ev.via === "string") via = ev.via as "slash" | "sdk";
      }
    });
  });

  onDestroy(() => {
    unsub?.();
  });

  // ESC dismisses the pairing modal. `<svelte:window>` must live at the
  // top level of the component (Svelte 5 forbids it inside conditional
  // blocks), so the handler self-guards on `open`.
  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if !headless}
  <button
    class="mobile-pair-btn"
    on:click={start}
    disabled={!sessionStarted && !($settings.claudeOrgUuid ?? "").trim()}
    title={sessionStarted || ($settings.claudeOrgUuid ?? "").trim()
      ? "Pair this session with the Claude mobile app"
      : "Start a session, or set Claude organization UUID in Settings → Advanced"}
  >
    <span class="mp-icon" aria-hidden="true">📱</span>
    <span>Pair mobile</span>
  </button>
{/if}

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="mp-backdrop" on:click={close}>
    <div class="mp-modal" on:click|stopPropagation>
      <header>
        <h3>Pair with Claude mobile</h3>
        <button class="mp-close" on:click={close} aria-label="Close">×</button>
      </header>

      {#if via}
        <div class="mp-via" title="Pairing path used by the sidecar">
          {via === "sdk" ? "via Anthropic SDK (direct)" : "via /remote-control"}
        </div>
      {/if}

      {#if error}
        <div class="mp-error">
          <strong>Pairing failed</strong>
          <pre>{error}</pre>
          <p class="muted">
            Anthropic's hosted relay requires <code>claude auth login</code>
            (claude.ai option) and a Pro / Max / Team / Enterprise plan.
          </p>
        </div>
      {:else if !url}
        <div class="mp-pending">
          <div class="spinner" aria-hidden="true"></div>
          <p>Waiting for pairing URL from Claude…</p>
          <p class="muted">
            ClawdUI is sending <code>/remote-control</code> to the active
            session. This usually takes a few seconds.
          </p>
        </div>
      {:else}
        <div class="mp-pair">
          <p>Open <strong>Claude</strong> on your phone and scan this QR:</p>
          {#if qrSvg}
            <div class="mp-qr">{@html qrSvg}</div>
          {:else}
            <p class="muted">
              QR rendering failed — paste the URL on your phone instead.
            </p>
          {/if}
          <div class="mp-url">
            <input
              type="text"
              readonly
              value={url}
              on:focus={(e) => (e.target as HTMLInputElement).select()}
            />
            <button on:click={copyUrl}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p class="muted">
            Requires <code>claude auth login</code> + Pro/Max/Team/Enterprise.
          </p>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .mobile-pair-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg);
    font-size: 12px;
    cursor: pointer;
  }
  .mobile-pair-btn:hover {
    background: var(--elevated);
  }
  .mobile-pair-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .mp-icon { font-size: 13px; }

  .mp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mp-modal {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 20px;
    width: min(420px, calc(100vw - 32px));
    box-shadow: var(--shadow-lg);
  }
  .mp-modal header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .mp-modal h3 { margin: 0; font-size: 15px; }
  .mp-close {
    background: none;
    border: none;
    color: inherit;
    font-size: 22px;
    cursor: pointer;
    line-height: 1;
  }

  .mp-pending,
  .mp-pair,
  .mp-error {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
    text-align: center;
  }
  .mp-error pre {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    margin: 0;
    font-size: 12px;
    white-space: pre-wrap;
    text-align: left;
    width: 100%;
    max-height: 160px;
    overflow: auto;
  }

  .mp-qr {
    background: #fff;
    padding: 8px;
    border-radius: 8px;
    line-height: 0;
  }
  .mp-qr :global(svg) {
    display: block;
    width: 220px;
    height: 220px;
  }

  .mp-url {
    display: flex;
    gap: 6px;
    width: 100%;
  }
  .mp-url input {
    flex: 1;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: inherit;
    font-family: monospace;
    font-size: 11px;
  }
  .mp-url button {
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: inherit;
    cursor: pointer;
  }

  .muted {
    color: var(--fg-3);
    font-size: 12px;
  }

  .mp-via {
    margin: -4px 0 8px;
    font-size: 11px;
    color: var(--fg-3);
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
