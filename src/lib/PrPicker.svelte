<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import {
    fetchPrByUrl,
    checkoutPrBranch,
    formatPrContext,
    type PR,
  } from "./prList";
  import { parsePrUrl, type ParsedPrUrl } from "./prFromUrl";
  import { fmtRelative } from "./format";
  import { getSettings, patchSettings } from "./settings";
  import { GitBranch } from "./icons";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { readText as tauriReadText } from "@tauri-apps/plugin-clipboard-manager";

  export let open = false;

  const dispatch = createEventDispatcher<{
    close: void;
    pick: {
      pr: PR;
      preamble: string;
      title: string;
      mode: "resume" | "fork";
      localBranch?: string;
      /** Resolved branch dir (worktree path OR clone root) — caller pivots cwd here. */
      finalCwd?: string;
    };
    toast: string;
  }>();

  let urlInput = "";
  let parsed: ParsedPrUrl | null = null;
  let pr: PR | null = null;
  let loading = false;
  let fetchError: string | null = null;
  let busyMode: "resume" | "fork" | null = null;

  $: parsed = parsePrUrl(urlInput);

  // Auto-fetch single PR on URL input change. Empty input = silent empty state.
  let lastFetchedKey: string | null = null;
  $: void maybeFetch(parsed);
  async function maybeFetch(p: ParsedPrUrl | null): Promise<void> {
    if (!p) {
      pr = null;
      fetchError = null;
      lastFetchedKey = null;
      return;
    }
    const key = `${p.hostBaseUrl}/${p.owner}/${p.repo}/${p.prNumber}`;
    if (key === lastFetchedKey) return;
    lastFetchedKey = key;
    loading = true;
    fetchError = null;
    pr = null;
    try {
      pr = await fetchPrByUrl(p);
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  let urlInputEl: HTMLInputElement | null = null;

  // On open: read clipboard BEFORE focus so macOS native Paste suggestion
  // doesn't appear over an empty focused field. Prefill if it looks like a
  // PR URL, then focus the input (now non-empty -> no OS paste hint).
  //
  // Why Tauri native clipboard first: Tauri WebView denies
  // navigator.clipboard.readText() silently (promise rejects) — so prefill
  // never worked, input stayed empty, focus fired, macOS Sequoia rendered
  // the Paste callout sticker. The native bridge via plugin-clipboard-manager
  // bypasses WebView restrictions. We still fall back to navigator.clipboard
  // for browser-preview (`vite dev`) where Tauri isn't injected.
  async function readClipboardSafe(): Promise<string | null> {
    // Prefer Tauri native bridge — works inside the WebView.
    try {
      const text = await tauriReadText();
      if (typeof text === "string") return text;
    } catch {
      /* Tauri unavailable (browser preview) or permission denied */
    }
    // Browser-preview fallback.
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (typeof text === "string") return text;
      }
    } catch {
      /* clipboard permission denied — silent */
    }
    return null;
  }

  async function tryClipboardPrefill(): Promise<void> {
    if (urlInput) return;
    try {
      const text = await readClipboardSafe();
      if (text && parsePrUrl(text)) {
        urlInput = text.trim();
      }
    } finally {
      // Focus AFTER clipboard read settles — avoids transient empty+focused window
      requestAnimationFrame(() => urlInputEl?.focus());
    }
  }

  let openedOnce = false;
  $: if (open && !openedOnce) {
    openedOnce = true;
    void tryClipboardPrefill();
  }
  $: if (!open) {
    openedOnce = false;
  }

  async function pick(mode: "resume" | "fork"): Promise<void> {
    if (!pr || !parsed) return;
    busyMode = mode;
    let localBranch: string | undefined;
    let finalCwd: string | undefined;
    try {
      // Step 1: ask user where to clone/check out. Default = last picked
      // folder, else current workspace cwd. Persist on success.
      const s = getSettings();
      const defaultPath = s.lastPrCheckoutDir || s.cwd || undefined;
      let chosenFolder: string | null = null;
      try {
        const sel = await openDialog({
          directory: true,
          multiple: false,
          defaultPath,
          title: "Choose where to clone/check out the PR",
        });
        chosenFolder = typeof sel === "string" ? sel : null;
      } catch (err) {
        dispatch(
          "toast",
          `folder picker failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!chosenFolder) {
        // User cancelled — abort cleanly. No partial state.
        busyMode = null;
        return;
      }
      // Persist for next time.
      patchSettings({ lastPrCheckoutDir: chosenFolder });

      // Step 2: do the actual checkout. Surface auth failures as toast but
      // still proceed with metadata-only resume so the session opens with
      // PR context even if git creds aren't configured.
      try {
        const co = await checkoutPrBranch(pr, parsed, chosenFolder);
        localBranch = co.localBranch;
        finalCwd = co.finalCwd;
        dispatch("toast", `checkout: ${co.strategy} — ${co.reason}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch("toast", msg);
      }
      const { preamble, title } = await formatPrContext(pr);
      dispatch("pick", { pr, preamble, title, mode, localBranch, finalCwd });
      dispatch("close");
    } catch (err) {
      dispatch(
        "toast",
        `pr context failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busyMode = null;
    }
  }

  function onBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) dispatch("close");
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") dispatch("close");
  }

  $: settings = getSettings();
</script>

<svelte:window on:keydown={onKey} />

{#if open}
  <div class="backdrop" on:mousedown={onBackdrop} role="presentation">
    <div class="panel" role="dialog" aria-modal="true" aria-label="Resume from a pull request">
      <header class="hdr">
        <div class="title-block">
          <span class="eyebrow">FROM PR</span>
          <h2>Resume from a pull request</h2>
        </div>
        <button class="close mono" type="button" on:click={() => dispatch("close")} title="Close (Esc)">
          ×
        </button>
      </header>

      <div class="meta mono">
        <span>checkout into: <b>{settings.lastPrCheckoutDir || settings.cwd || "(will prompt)"}</b></span>
        {#if !settings.gitToken}
          <span class="hint">tip: set a git token in Settings → Advanced for private repos</span>
        {/if}
      </div>

      <div class="toolbar">
        <input
          bind:this={urlInputEl}
          class="search mono"
          type="url"
          placeholder="Paste PR URL — github.com/.../pull/N, forgejo/.../pulls/N, gitlab/.../merge_requests/N…"
          bind:value={urlInput}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          data-form-type="other"
        />
      </div>

      {#if !urlInput.trim()}
        <div class="empty mono">Paste a PR URL above to resume from a pull request.</div>
      {:else if urlInput.trim() && !parsed}
        <div class="empty mono">Not a recognised PR URL. Supported: GitHub, Forgejo/Gitea, GitLab, Bitbucket.</div>
      {:else if loading}
        <div class="empty mono">loading…</div>
      {:else if fetchError}
        <div class="empty error mono">{fetchError}</div>
      {:else if pr && parsed}
        <div class="list">
          <div class="row">
            <div class="row-head">
              <span class="num mono">#{pr.number}</span>
              <span class="title" title={pr.title}>{pr.title || "(untitled)"}</span>
              <span class="when mono">{pr.updatedAt ? fmtRelative(Date.parse(pr.updatedAt)) : ""}</span>
            </div>
            <div class="row-meta mono">
              <span title="provider">{parsed.provider}</span>
              <span title="host">{parsed.host}</span>
              <span title="branch" class="pr-branch"><GitBranch size={12} stroke={1.6} /> {pr.branch || "—"}</span>
              <span title="author">@{pr.author || "—"}</span>
              {#if pr.url}
                <a href={pr.url} target="_blank" rel="noopener noreferrer">↗</a>
              {/if}
            </div>
            <div class="row-actions">
              <button
                class="act"
                type="button"
                disabled={busyMode !== null}
                on:click={() => void pick("resume")}
                title="Resume — fetch PR branch locally + open session with PR description as context"
              >resume</button>
              <button
                class="act"
                type="button"
                disabled={busyMode !== null}
                on:click={() => void pick("fork")}
                title="Fork — same as resume, but mark as a fork session"
              >fork</button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .pr-branch { display: inline-flex; align-items: center; gap: 4px; }
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in oklab, var(--bg) 70%, transparent);
    backdrop-filter: blur(4px);
    z-index: 80;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 6vh;
  }
  .panel {
    width: min(720px, 92vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border-hi);
    border-radius: var(--r-3, 8px);
    box-shadow: var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.5));
    overflow: hidden;
  }
  .hdr {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
  }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12.5px;
    color: var(--fg-4);
    font-family: var(--font-mono);
  }
  .title-block h2 {
    margin: 4px 0 0;
    font-size: 17.5px;
    font-weight: 500;
    color: var(--fg);
  }
  .close {
    background: transparent;
    border: 0;
    color: var(--fg-3);
    font-size: 19.5px;
    cursor: pointer;
    padding: 0 4px;
  }
  .close:hover { color: var(--fg); }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 6px 16px;
    font-size: 13.5px;
    color: var(--fg-3);
    border-bottom: 1px solid var(--border);
  }
  .meta b { color: var(--fg-2); font-weight: 500; }
  .meta .hint { color: var(--fg-4); font-style: italic; }

  .toolbar {
    display: flex;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
  }
  .search {
    flex: 1;
    padding: 6px 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--r-1);
    font-size: 14.5px;
    /* Hint to WebKit that this is plain-text; suppresses some macOS native overlays. */
    -webkit-user-modify: read-write-plaintext-only;
  }
  .search:focus { outline: 1px solid var(--accent-line); }

  .empty {
    margin: 16px;
    padding: 18px;
    text-align: center;
    color: var(--fg-4);
    font-size: 14.5px;
    border: 1px dashed var(--border);
    border-radius: var(--r-2);
  }
  .empty.error { color: var(--danger); border-color: var(--danger); }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    background: var(--elevated);
    transition: border-color var(--dur-1) var(--ease);
  }
  .row:hover { border-color: var(--accent-line); }
  .row-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .num { color: var(--accent); font-size: 14.5px; flex-shrink: 0; }
  .title {
    color: var(--fg);
    font-size: 15.5px;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
    min-width: 0;
  }
  .when { font-size: 13.5px; color: var(--fg-4); flex-shrink: 0; }

  .row-meta {
    display: flex;
    gap: 10px;
    font-size: 13.5px;
    color: var(--fg-3);
    flex-wrap: wrap;
  }
  .row-meta a { color: var(--fg-3); text-decoration: none; }
  .row-meta a:hover { color: var(--accent); }

  .row-actions {
    display: flex;
    gap: 4px;
    padding-top: 2px;
  }
  .act {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-2);
    border-radius: var(--r-1);
    padding: 2px 9px;
    font-size: 13.5px;
    font-family: var(--font-mono);
    cursor: pointer;
  }
  .act:hover:not(:disabled) {
    background: var(--elevated);
    color: var(--fg);
    border-color: var(--border-hi);
  }
  .act:disabled { opacity: 0.5; cursor: progress; }
</style>
