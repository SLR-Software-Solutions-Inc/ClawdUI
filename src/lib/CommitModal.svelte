<script lang="ts">
  // Worker U: /commit modal.
  //
  // Shows current git status (best-effort: tries the sidecar `git_status` RPC
  // first, falls back to a toast if the sidecar doesn't expose it yet).
  // User can pick which files to stage, edit the message body, toggle a
  // sign-off line, and shell out to `git commit` via the sidecar.
  import { createEventDispatcher, onMount } from "svelte";
  import { rpcCall } from "./sidecarRpc";
  import { getSettings } from "./settings";
  import { GitBranch } from "./icons";

  export let open = false;
  /** Pre-fill the commit subject. Caller derives this from the last
   *  assistant message summary or similar. */
  export let suggestedMessage = "";

  const dispatch = createEventDispatcher<{
    close: void;
    toast: { message: string; kind?: "info" | "error" };
  }>();

  type StatusEntry = { path: string; status: string };

  let entries: StatusEntry[] = [];
  let selected = new Set<string>();
  let subject = "";
  let body = "";
  let signOff = true;
  let loading = false;
  let committing = false;
  let loadError: string | null = null;
  let resultText: string | null = null;

  $: cwd = getSettings().cwd ?? null;

  function emitToast(message: string, kind: "info" | "error" = "info"): void {
    dispatch("toast", { message, kind });
  }

  async function loadStatus(): Promise<void> {
    loadError = null;
    resultText = null;
    if (!cwd) {
      loadError = "no cwd configured — pick a workspace first";
      return;
    }
    loading = true;
    try {
      // Sidecar RPC may not exist yet — handle both shapes.
      // TODO(worker-U): add a real `git_status` RPC in the sidecar.
      const res = await rpcCall<{ entries?: StatusEntry[] }>("git_status", { cwd })
        .catch((err: unknown) => {
          loadError = `git_status unavailable: ${err instanceof Error ? err.message : String(err)}`;
          return null;
        });
      if (res && Array.isArray(res.entries)) {
        entries = res.entries;
        selected = new Set(entries.map((e) => e.path));
      } else if (!loadError) {
        loadError = "git_status returned no entries (RPC may be a stub)";
      }
    } catch (err) {
      loadError = `git_status failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      loading = false;
    }
  }

  function toggleFile(path: string): void {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selected = next;
  }

  function toggleAll(): void {
    selected = selected.size === entries.length
      ? new Set<string>()
      : new Set(entries.map((e) => e.path));
  }

  async function doCommit(): Promise<void> {
    if (!cwd) {
      emitToast("no cwd configured", "error");
      return;
    }
    const subj = subject.trim();
    if (!subj) {
      emitToast("commit message required", "error");
      return;
    }
    const paths = Array.from(selected);
    if (paths.length === 0) {
      emitToast("select at least one file", "error");
      return;
    }
    committing = true;
    resultText = null;
    try {
      const fullBody = signOff
        ? `${body.trim()}${body.trim() ? "\n\n" : ""}Signed-off-by: clawdui`
        : body.trim();
      // TODO(worker-U): add real `git_commit` RPC. Until then, this resolves
      // gracefully via the catch and surfaces a toast.
      const res = await rpcCall<{ stdout?: string; stderr?: string; ok?: boolean }>(
        "git_commit",
        { cwd, paths, subject: subj, body: fullBody },
      ).catch((err: unknown) => {
        throw err;
      });
      resultText = (res?.stdout ?? "") + (res?.stderr ? `\n${res.stderr}` : "");
      if (res?.ok === false) {
        emitToast("commit failed — see panel", "error");
      } else {
        emitToast(`committed ${paths.length} file(s)`, "info");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resultText = `git_commit failed: ${msg}`;
      emitToast(`commit failed: ${msg}`, "error");
    } finally {
      committing = false;
    }
  }

  function close(): void {
    dispatch("close");
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === "Escape") close();
  }

  // When the modal is opened, refresh status + seed the subject.
  $: if (open) {
    subject = suggestedMessage.split("\n")[0]?.slice(0, 72) ?? "";
    body = "";
    void loadStatus();
  }

  onMount(() => {});
</script>

<svelte:window on:keydown={onKey} />

{#if open}
  <div class="backdrop" on:mousedown={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation">
    <div class="panel" role="dialog" aria-modal="true" aria-label="Commit changes">
      <header class="hdr">
        <div class="title-block">
          <span class="eyebrow">GIT · COMMIT</span>
          <h2><GitBranch size={14} stroke={1.6} /> Commit changes</h2>
        </div>
        <button class="close mono" type="button" on:click={close} title="Close (Esc)">×</button>
      </header>

      <div class="meta mono">
        <span>cwd: <b>{cwd ?? "—"}</b></span>
      </div>

      <section class="files">
        <div class="files-hdr mono">
          <span>Files</span>
          <button class="ghost mono" type="button" on:click={toggleAll}>
            {selected.size === entries.length && entries.length > 0 ? "none" : "all"}
          </button>
          <button class="ghost mono" type="button" on:click={() => void loadStatus()}>↻</button>
        </div>
        {#if loading}
          <div class="empty mono">loading…</div>
        {:else if loadError}
          <div class="empty error mono">{loadError}</div>
        {:else if entries.length === 0}
          <div class="empty mono">no changes</div>
        {:else}
          <div class="list">
            {#each entries as e (e.path)}
              <label class="row">
                <input
                  type="checkbox"
                  checked={selected.has(e.path)}
                  on:change={() => toggleFile(e.path)}
                />
                <span class="status mono" data-st={e.status}>{e.status}</span>
                <span class="path mono">{e.path}</span>
              </label>
            {/each}
          </div>
        {/if}
      </section>

      <section class="msg">
        <label class="lbl mono" for="commit-subject">Subject</label>
        <input
          id="commit-subject"
          class="subj"
          type="text"
          bind:value={subject}
          maxlength="72"
          placeholder="short summary (≤72 chars)"
        />
        <label class="lbl mono" for="commit-body">Body</label>
        <textarea
          id="commit-body"
          class="body"
          bind:value={body}
          rows="4"
          placeholder="extended description (optional)"
        ></textarea>
        <label class="signoff mono">
          <input type="checkbox" bind:checked={signOff} />
          <span>append sign-off</span>
        </label>
      </section>

      {#if resultText}
        <pre class="result mono">{resultText}</pre>
      {/if}

      <footer class="actions">
        <button class="ghost mono" type="button" on:click={close}>Cancel</button>
        <button
          class="primary mono"
          type="button"
          disabled={committing || loading || !subject.trim() || selected.size === 0}
          on:click={() => void doCommit()}
        >
          {committing ? "Committing…" : "Commit"}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in oklab, var(--bg) 70%, transparent);
    backdrop-filter: blur(4px);
    z-index: 90;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 6vh;
  }
  .panel {
    width: min(640px, 92vw);
    max-height: 86vh;
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
    justify-content: space-between;
    align-items: flex-start;
    padding: 12px 16px 8px;
    border-bottom: 1px solid var(--border);
  }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12px;
    color: var(--fg-4);
    font-family: var(--font-mono);
  }
  .title-block h2 {
    margin: 4px 0 0;
    font-size: 17px;
    font-weight: 500;
    color: var(--fg);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .close {
    background: transparent;
    border: 0;
    color: var(--fg-3);
    font-size: 19px;
    cursor: pointer;
    padding: 0 4px;
  }
  .close:hover { color: var(--fg); }
  .meta {
    padding: 6px 16px;
    font-size: 13px;
    color: var(--fg-3);
    border-bottom: 1px solid var(--border);
  }
  .meta b { color: var(--fg-2); font-weight: 500; }
  .files {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    overflow: auto;
    max-height: 30vh;
  }
  .files-hdr {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12.5px;
    color: var(--fg-4);
    margin-bottom: 4px;
  }
  .files-hdr > span { flex: 1; }
  .ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-3);
    border-radius: var(--r-1);
    padding: 2px 8px;
    font-size: 13px;
    cursor: pointer;
  }
  .ghost:hover { background: var(--elevated); color: var(--fg); }
  .list { display: flex; flex-direction: column; gap: 2px; }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .row:hover { background: var(--elevated); }
  .status {
    font-size: 12px;
    color: var(--fg-3);
    width: 36px;
    text-transform: uppercase;
  }
  .status[data-st*="M"] { color: var(--warning); }
  .status[data-st*="A"] { color: var(--success, #4ade80); }
  .status[data-st*="D"] { color: var(--danger); }
  .status[data-st*="?"] { color: var(--accent); }
  .path { font-size: 13px; color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty {
    padding: 12px;
    text-align: center;
    color: var(--fg-4);
    font-size: 13px;
    border: 1px dashed var(--border);
    border-radius: var(--r-2);
  }
  .empty.error { color: var(--danger); border-color: var(--danger); }
  .msg {
    padding: 10px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-bottom: 1px solid var(--border);
  }
  .lbl { font-size: 12px; color: var(--fg-4); text-transform: uppercase; letter-spacing: 0.1em; }
  .subj, .body {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--r-1);
    padding: 6px 8px;
    font-size: 14px;
    font-family: var(--font-mono);
    width: 100%;
    box-sizing: border-box;
  }
  .subj:focus, .body:focus { outline: 1px solid var(--accent-line); }
  .body { resize: vertical; min-height: 64px; }
  .signoff {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--fg-3);
  }
  .result {
    margin: 6px 16px;
    padding: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    max-height: 12vh;
    overflow: auto;
    font-size: 12px;
    color: var(--fg-2);
    white-space: pre-wrap;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
  }
  .primary {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: #000;
    border-radius: var(--r-1);
    padding: 5px 14px;
    font-size: 13.5px;
    cursor: pointer;
  }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .primary:not(:disabled):hover { filter: brightness(1.05); }
</style>
