<script lang="ts">
  /**
   * Error drill-down modal — opened from Fleet View when user clicks an
   * error pill. Shows the agent's last 20 transcript lines + best-effort
   * extracted error text.
   */
  import type { Agent } from "./agents.svelte";
  import { X as XIcon } from "./icons";

  interface Props {
    agent: Agent;
    onClose: () => void;
  }
  let { agent, onClose }: Props = $props();

  function blockToText(b: unknown): string {
    if (!b || typeof b !== "object") return "";
    const r = b as { type?: string; text?: string; content?: string; name?: string };
    if (r.type === "text") return r.text ?? "";
    if (r.type === "thinking") return `[thinking] ${r.text ?? ""}`;
    if (r.type === "tool_use") return `→ tool: ${r.name ?? "?"}`;
    if (r.type === "tool_result") return `← result: ${(r.content ?? "").toString().slice(0, 240)}`;
    return "";
  }

  let lines = $derived.by<string[]>(() => {
    const out: string[] = [];
    for (const m of agent.transcript) {
      const prefix = `[${m.role}]`;
      if (!Array.isArray(m.blocks)) continue;
      for (const b of m.blocks) {
        const t = blockToText(b);
        if (t) out.push(`${prefix} ${t.replace(/\s+/g, " ").trim()}`);
      }
    }
    return out.slice(-20);
  });

  // Best-effort error extraction: scan transcript for "error" / "Error" /
  // tool_result with is_error / RuntimeError / Traceback. Surface the
  // most-relevant line at the top.
  let primaryError = $derived.by<string | null>(() => {
    for (let i = agent.transcript.length - 1; i >= 0; i--) {
      const m = agent.transcript[i];
      if (!Array.isArray(m.blocks)) continue;
      for (const b of m.blocks) {
        if (!b || typeof b !== "object") continue;
        const r = b as { type?: string; content?: unknown; text?: string };
        if (r.type === "tool_result" && typeof r.content === "string") {
          if (/error|exception|traceback|enoent|failed/i.test(r.content)) {
            return r.content.slice(0, 600);
          }
        }
        if (r.type === "text" && r.text && /error|exception|traceback/i.test(r.text)) {
          return r.text.slice(0, 600);
        }
      }
    }
    return null;
  });

  function onBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) onClose();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onBackdrop} role="dialog" aria-modal="true" aria-label="Agent error details" tabindex="-1">
  <div class="modal mono">
    <header class="head">
      <div class="head-left">
        <span class="badge">ERROR</span>
        <span class="title">{agent.label}</span>
        <span class="sub">id={agent.id.slice(0, 14)}</span>
      </div>
      <button type="button" class="close" onclick={onClose} aria-label="Close">
        <XIcon size={14} stroke={2} />
      </button>
    </header>

    {#if primaryError}
      <section class="primary">
        <div class="label">Primary error</div>
        <pre class="err-text">{primaryError}</pre>
      </section>
    {/if}

    <section class="lines">
      <div class="label">Last {lines.length} transcript line{lines.length === 1 ? "" : "s"}</div>
      {#if lines.length === 0}
        <div class="empty">no transcript</div>
      {:else}
        <pre class="lines-text">{lines.join("\n")}</pre>
      {/if}
    </section>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: oklch(0 0 0 / 0.55);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 1000;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .modal {
    width: min(720px, 100%);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: color-mix(in oklch, var(--surface) 92%, transparent);
    border: 1px solid var(--danger);
    border-radius: 8px;
    box-shadow: 0 24px 80px oklch(0 0 0 / 0.6);
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: color-mix(in oklch, var(--danger) 18%, var(--elevated));
    border-bottom: 1px solid var(--border);
  }
  .head-left {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
  .badge {
    font-size: 10px;
    letter-spacing: 0.12em;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--danger);
    color: var(--bg);
    font-weight: 700;
  }
  .title {
    font-size: 13px;
    color: var(--fg);
  }
  .sub {
    font-size: 10.5px;
    color: var(--fg-3);
  }
  .close {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-2);
    width: 24px;
    height: 24px;
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .close:hover {
    color: var(--fg);
    border-color: var(--accent);
  }
  .primary {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in oklch, var(--danger) 6%, transparent);
  }
  .lines {
    padding: 12px 14px;
    overflow: auto;
    flex: 1;
  }
  .label {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--fg-3);
    margin-bottom: 6px;
  }
  .err-text,
  .lines-text {
    margin: 0;
    font-size: 11.5px;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .err-text {
    color: var(--danger);
  }
  .empty {
    color: var(--fg-3);
    font-size: 12px;
  }
</style>
