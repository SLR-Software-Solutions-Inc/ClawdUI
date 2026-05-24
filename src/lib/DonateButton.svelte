<script lang="ts">
  import { settings } from "./settings";
  import { patchSettings } from "./settings";
  import { openDonatePage, ATTRIBUTION } from "./donate";

  export let variant: "topbar" | "inline" = "topbar";

  let confirmOpen = false;

  $: donated = $settings.donated;

  function clickedDonate(): void {
    openDonatePage();
    confirmOpen = true;
  }

  function markDonated(): void {
    patchSettings({ donated: true });
    confirmOpen = false;
  }

  function dismiss(): void {
    confirmOpen = false;
  }

  function revert(): void {
    patchSettings({ donated: false });
  }
</script>

{#if donated}
  <span class="thanks {variant}" title="{ATTRIBUTION} — thank you">
    <span class="heart" aria-hidden="true">♥</span>
    <span class="copy mono">Thank you</span>
    <button
      type="button"
      class="undo mono"
      on:click={revert}
      title="Undo — show the Donate button again"
    >undo</button>
  </span>
{:else}
  <button
    type="button"
    class="donate {variant}"
    on:click={clickedDonate}
    title="Support {ATTRIBUTION} — opens buymeacoffee.com"
  >
    <span class="heart" aria-hidden="true">♥</span>
    <span class="copy mono">Donate</span>
  </button>
{/if}

{#if confirmOpen}
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Donation confirmation">
    <div class="modal">
      <p class="lead">Thanks for considering a tip toward {ATTRIBUTION}.</p>
      <p class="sub mono">
        Once you've donated, hit "I've donated" — the button will hide and a
        thank-you appears instead. Honor system, no verification.
      </p>
      <div class="row">
        <button type="button" class="btn primary" on:click={markDonated}>
          I've donated
        </button>
        <button type="button" class="btn ghost" on:click={dismiss}>
          Maybe later
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .donate {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--accent-soft);
    color: var(--fg);
    border: 1px solid var(--accent-line);
    border-radius: var(--r-2);
    font-size: 13.5px;
    cursor: pointer;
    transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
  }
  .donate:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .donate.inline {
    padding: 6px 14px;
    font-size: 14.5px;
  }
  .donate .heart {
    color: var(--danger);
    font-size: 14px;
  }
  .donate .copy {
    letter-spacing: 0.04em;
  }

  .thanks {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--surface);
    color: var(--fg-2);
    border: 1px dashed var(--border-hi);
    border-radius: var(--r-2);
    font-size: 12.5px;
  }
  .thanks .heart {
    color: var(--danger);
  }
  .thanks .undo {
    background: transparent;
    border: 0;
    color: var(--fg-4);
    font-size: 11.5px;
    cursor: pointer;
    padding: 0 0 0 4px;
    text-decoration: underline dotted;
  }
  .thanks .undo:hover {
    color: var(--fg-3);
  }

  .overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border-hi);
    border-radius: var(--r-3);
    padding: 22px 24px;
    max-width: 420px;
    box-shadow: var(--shadow-lg);
    color: var(--fg);
  }
  .lead {
    font-size: 17px;
    margin: 0 0 8px 0;
    color: var(--fg);
  }
  .sub {
    font-size: 13px;
    color: var(--fg-3);
    margin: 0 0 16px 0;
    line-height: 1.5;
  }
  .row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .btn {
    padding: 6px 14px;
    border-radius: var(--r-2);
    font-size: 13.5px;
    cursor: pointer;
    border: 1px solid var(--border-hi);
    background: var(--elevated);
    color: var(--fg);
  }
  .btn.primary {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--fg);
  }
  .btn.ghost {
    background: transparent;
  }
  .btn:hover {
    border-color: var(--accent);
  }
</style>
