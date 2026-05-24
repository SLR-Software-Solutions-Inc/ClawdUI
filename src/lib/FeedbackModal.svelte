<script lang="ts">
  // Worker U: /feedback modal.
  //
  // Quick textarea → opens a prefilled GitHub-style issue in the user's
  // browser (Tauri `open_external` command in native, `window.open` fallback
  // in the browser preview).
  import { createEventDispatcher } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { isTauri } from "./systemStatus";

  export let open = false;

  const dispatch = createEventDispatcher<{
    close: void;
    toast: { message: string; kind?: "info" | "error" };
  }>();

  const ISSUES_URL = "https://github.com/SLR-Software-Solutions-Inc/ClawdUI/issues";

  let text = "";
  let title = "";
  let submitting = false;

  $: if (open) {
    text = "";
    title = "";
  }

  function close(): void {
    dispatch("close");
  }

  async function submit(): Promise<void> {
    submitting = true;
    try {
      const params = new URLSearchParams();
      if (title.trim()) params.set("title", title.trim());
      if (text.trim()) params.set("body", text.trim());
      const url = params.toString() ? `${ISSUES_URL}?${params.toString()}` : ISSUES_URL;
      if (isTauri()) {
        try {
          await invoke("open_external", { url });
        } catch (err) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      dispatch("toast", { message: "feedback form opened", kind: "info" });
      close();
    } finally {
      submitting = false;
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === "Escape") close();
  }
</script>

<svelte:window on:keydown={onKey} />

{#if open}
  <div class="backdrop" on:mousedown={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation">
    <div class="panel" role="dialog" aria-modal="true" aria-label="Send feedback">
      <header class="hdr">
        <div class="title-block">
          <span class="eyebrow">FEEDBACK</span>
          <h2>Send feedback</h2>
        </div>
        <button class="close mono" type="button" on:click={close} title="Close (Esc)">×</button>
      </header>

      <section class="body">
        <label class="lbl mono" for="fb-title">Title (optional)</label>
        <input
          id="fb-title"
          class="text"
          type="text"
          bind:value={title}
          placeholder="Short summary"
        />
        <label class="lbl mono" for="fb-body">Details</label>
        <textarea
          id="fb-body"
          class="text body-text"
          bind:value={text}
          rows="8"
          placeholder="What happened? What did you expect? Repro steps?"
        ></textarea>
        <p class="muted">Opens a new issue on GitHub with this content pre-filled.</p>
      </section>

      <footer class="actions">
        <button class="ghost mono" type="button" on:click={close}>Cancel</button>
        <button
          class="primary mono"
          type="button"
          disabled={submitting || !text.trim()}
          on:click={() => void submit()}
        >
          {submitting ? "Opening…" : "Open issue"}
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
    padding-top: 12vh;
  }
  .panel {
    width: min(520px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border-hi);
    border-radius: var(--r-3, 8px);
    box-shadow: var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.5));
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .hdr {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
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
  }
  .close {
    background: transparent;
    border: 0;
    color: var(--fg-3);
    font-size: 19px;
    cursor: pointer;
  }
  .body {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .lbl { font-size: 12px; color: var(--fg-4); text-transform: uppercase; letter-spacing: 0.1em; }
  .text {
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
  .text:focus { outline: 1px solid var(--accent-line); }
  .body-text { resize: vertical; min-height: 120px; }
  .muted { color: var(--fg-4); font-size: 12px; }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-3);
    border-radius: var(--r-1);
    padding: 5px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  .ghost:hover { background: var(--elevated); color: var(--fg); }
  .primary {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: #000;
    border-radius: var(--r-1);
    padding: 5px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .primary:not(:disabled):hover { filter: brightness(1.05); }
</style>
