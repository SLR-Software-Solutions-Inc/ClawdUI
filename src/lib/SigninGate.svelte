<script lang="ts">
  /**
   * Full-screen boot-time gate: shown when the local Claude Code CLI has
   * no credentials in the keychain (or the credentials are stale). The
   * canonical sign-in path is `claude /login` in a terminal — we can't
   * run that interactive flow inside the Tauri webview, so we just walk
   * the user through it and let them re-check.
   *
   * State source: `authSignedIn` store (derived from the `auth_status`
   * CLI section). The parent wires onMount to call `authStatus()` once
   * the sidecar pong arrives, and watches `$authSignedIn.state` to
   * decide whether to mount this component.
   */
  import { authSignedIn, authStatus, cli } from "./cli";

  const cmd = "claude /login";

  let checking = $state(false);
  let toast = $state<string | null>(null);

  // Bridge the existing Svelte `writable` store into a rune so the
  // template re-renders on every status update.
  let signedInState = $state<"signed-in" | "signed-out" | "unknown">("unknown");
  $effect(() => {
    const off = authSignedIn.subscribe((v) => {
      signedInState = v.state;
    });
    return off;
  });
  let authSection = $state<{ running: boolean; error: string | null }>({
    running: false,
    error: null,
  });
  $effect(() => {
    const off = cli.subscribe((v) => {
      const s = v.sections.auth;
      authSection = { running: s.running, error: s.error };
    });
    return off;
  });

  async function copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(cmd);
      toast = "Copied — paste into a terminal";
    } catch {
      toast = "Copy failed — type the command manually";
    }
    setTimeout(() => (toast = null), 2500);
  }

  async function recheck(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      await authStatus();
    } finally {
      // authStatus streams via the cli store; finishedAt flips when done.
      // Keep checking=true until the next status arrives, then settle.
      setTimeout(() => (checking = false), 800);
    }
  }
</script>

<!-- Render the gate only while signed-out. The boot screen is `unknown`
     until the first auth_status RPC settles; we treat unknown as
     "not yet checked, show nothing" to avoid a flash on fast boots. -->
{#if signedInState === "signed-out"}
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="signin-title">
    <div class="card">
      <h1 id="signin-title" class="title">Sign in to Claude Code</h1>
      <p class="body">
        ClawdUI uses your local Claude Code login. Run this in a terminal,
        then click <strong>I&rsquo;ve signed in</strong>.
      </p>
      <div class="cmd-row mono">
        <code class="cmd">{cmd}</code>
        <button
          type="button"
          class="copy"
          onclick={copyCommand}
          title="Copy command to clipboard"
          aria-label="Copy command"
        >
          copy
        </button>
      </div>
      <div class="actions">
        <button
          type="button"
          class="primary"
          onclick={recheck}
          disabled={checking || authSection.running}
        >
          {checking || authSection.running ? "Checking..." : "I've signed in"}
        </button>
      </div>
      {#if authSection.error}
        <p class="error mono">{authSection.error}</p>
      {/if}
      {#if toast}
        <p class="toast mono">{toast}</p>
      {/if}
      <p class="hint mono">
        Tip: if <code>claude</code> isn&rsquo;t on your PATH, install it with
        <code>npm install -g @anthropic-ai/claude-code</code>.
      </p>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: color-mix(in oklch, var(--bg) 92%, transparent);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    width: min(520px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 24px 24px 20px;
    box-shadow: 0 14px 48px rgba(0, 0, 0, 0.35);
  }
  .title {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 8px;
    color: var(--fg);
  }
  .body {
    margin: 0 0 14px;
    color: var(--fg-2);
    font-size: 13.5px;
    line-height: 1.5;
  }
  .cmd-row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 14px;
  }
  .cmd {
    flex: 1;
    font-family: inherit;
    font-size: 13px;
    color: var(--fg);
    user-select: all;
  }
  .copy {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-2);
    border-radius: 4px;
    padding: 4px 6px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }
  .copy:hover {
    background: var(--border-hi);
    color: var(--fg);
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  .primary {
    background: var(--accent);
    color: #0a0a0a;
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .error {
    color: var(--danger);
    font-size: 12px;
    margin: 6px 0 0;
  }
  .toast {
    color: var(--success);
    font-size: 12px;
    margin: 6px 0 0;
  }
  .hint {
    color: var(--fg-3);
    font-size: 11.5px;
    margin: 12px 0 0;
    line-height: 1.5;
  }
  .hint code {
    background: var(--elevated);
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid var(--border);
  }
</style>
