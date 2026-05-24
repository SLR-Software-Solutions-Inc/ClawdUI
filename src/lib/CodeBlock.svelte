<!--
  CodeBlock — fenced code with a header (language + optional filename +
  copy button) and highlight.js syntax highlighting. hljs is loaded
  dynamically on first use so the cost is paid only when the chat
  actually contains code.
-->
<script lang="ts">
  import { onMount } from "svelte";

  export let language: string = "";
  export let filename: string = "";
  export let code: string = "";

  let copied = false;
  let highlighted: string | null = null;

  async function highlight(): Promise<void> {
    try {
      const mod = await import("highlight.js");
      const hljs = mod.default;
      const lang = (language || "").toLowerCase().trim();
      if (lang && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } else {
        const auto = hljs.highlightAuto(code);
        highlighted = auto.value;
      }
    } catch {
      // hljs missing or threw — fall back to plain text render.
      highlighted = null;
    }
  }
  onMount(() => { void highlight(); });
  $: void highlight(), [code, language];

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      setTimeout(() => (copied = false), 1400);
    } catch {
      /* clipboard denied in some contexts — fall back silently */
    }
  }
</script>

<div class="cb">
  <header class="cb-head mono">
    <span class="cb-lang" aria-label="language">{language || "text"}</span>
    {#if filename}
      <span class="cb-sep" aria-hidden="true">·</span>
      <span class="cb-file" title={filename}>{filename}</span>
    {/if}
    <button
      class="cb-copy"
      type="button"
      on:click={() => void copy()}
      title="Copy code to clipboard"
    >
      {copied ? "✓ copied" : "copy"}
    </button>
  </header>
  <pre class="cb-body mono hljs"><code class="lang-{language || 'text'}">{#if highlighted}{@html highlighted}{:else}{code}{/if}</code></pre>
</div>

<style>
  .cb {
    margin: 8px 0;
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    background: var(--surface);
    overflow: hidden;
  }
  .cb-head {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--elevated);
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 11.5px;
    color: var(--fg-3);
    letter-spacing: 0.06em;
  }
  .cb-lang {
    text-transform: uppercase;
    color: var(--accent);
  }
  .cb-sep { color: var(--fg-4); }
  .cb-file {
    flex: 1 1 auto;
    color: var(--fg-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cb-copy {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border-hi);
    border-radius: 999px;
    padding: 2px 10px;
    color: var(--fg-3);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .cb-copy:hover { border-color: var(--accent); color: var(--fg); }
  .cb-body {
    margin: 0;
    padding: 12px 14px;
    color: var(--fg);
    font-size: 13.5px;
    line-height: 1.55;
    overflow-x: auto;
    white-space: pre;
  }
  .cb-body code {
    font-family: inherit;
    background: transparent;
    padding: 0;
  }
</style>
