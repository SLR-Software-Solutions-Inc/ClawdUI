<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { settings } from "./settings";
  import ModelPicker from "./ModelPicker.svelte";
  import PermissionPicker from "./PermissionPicker.svelte";
  import TokenTag from "./TokenTag.svelte";

  export let model: string | undefined = undefined;
  // permissionMode is read directly inside PermissionPicker via the settings
  // store, so the prop is kept only for backward compatibility.
  export let permissionMode: string = "default";
  void permissionMode;

  $: logoStyle = $settings.logoStyle;
  $: logoSvgCustom = $settings.logoSvgCustom;

  const dispatch = createEventDispatcher<{
    "live-model": string;
    "live-permission": string;
  }>();
</script>

<div class="empty">
  <div class="logo-block">
    {#if logoStyle === "plain"}
      <h1 class="logo-plain">ClawdUI</h1>
      <p class="logo-sub mono">UI ▍ v0.1</p>
    {:else if logoStyle === "ascii-clean"}
      <pre class="ascii mono" aria-hidden="true">
 ┌─             ┐ ┬ ┬ ┬
 │  │ ┌─┐ │ │ ┌─┤ │ │ │
 └─ │ └─┤ └┴┘ └─┘ └─┘ ┴
       U I  ▍  v0.1
      </pre>
    {:else if logoStyle === "figlet"}
      <pre class="ascii mono" aria-hidden="true">
   ____ _                   _ _   _ ___
  / ___| | __ ___      ____| | | | |_ _|
 | |   | |/ _` \ \ /\ / / _` | | | || |
 | |___| | (_| |\ V  V / (_| | |_| || |
  \____|_|\__,_| \_/\_/ \__,_|\___/|___|
                                  v0.1
      </pre>
    {:else if logoStyle === "svg-custom" && logoSvgCustom.trim()}
      <div class="logo-svg">{@html logoSvgCustom}</div>
    {:else}
      <h1 class="logo-plain">ClawdUI</h1>
    {/if}
    <span class="logo-corner mono">Slr Software Solution Inc.</span>
  </div>
  <!-- Composer takes the left/main column; model + permission cells sit in
       a right rail so the input gets the full visual weight. -->
  <div class="hero-card">
    <div class="hero-main">
      <slot name="composer" />
    </div>
    <aside class="readout mono">
      <TokenTag />
      <div class="readout-pickers">
        <ModelPicker
          variant="cell"
          activeModel={model}
          on:apply={(e) => dispatch("live-model", e.detail)}
        />
        <PermissionPicker
          variant="cell"
          on:apply={(e) => dispatch("live-permission", e.detail)}
        />
      </div>
    </aside>
  </div>
</div>

<style>
  .empty {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
    padding: 60px 24px 40px;
    color: var(--fg-3);
    text-align: center;
    margin: auto 0;
    min-height: 100%;
  }
  /* Logo block anchors the company tag to its own bottom-right corner so
     the badge tracks the logo regardless of which style is selected. */
  .logo-block {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    padding: 0 0 14px;
  }
  .logo-corner {
    position: absolute;
    bottom: -2px;
    right: 0;
    font-size: 10.5px;
    color: var(--fg-4);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    pointer-events: none;
    user-select: none;
    white-space: nowrap;
  }
  .ascii {
    font-size: 17px;
    line-height: 1.1;
    color: var(--fg-2);
    white-space: pre;
    letter-spacing: 0;
    margin: 0;
  }
  .logo-plain {
    font-family: var(--font-display);
    font-size: 58px;
    font-weight: 600;
    letter-spacing: -0.04em;
    color: var(--fg);
    margin: 0;
    line-height: 1;
  }
  .logo-sub {
    font-size: 13.5px;
    color: var(--fg-3);
    letter-spacing: 0.2em;
    margin: 0;
  }
  .logo-svg { color: var(--fg); }

  .hero-card {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--accent-line);
    border-radius: var(--r-3);
    box-shadow: var(--shadow-md);
    overflow: visible;
    display: flex;
    flex-direction: column;
  }
  .hero-main { min-width: 0; }
  .hero-card :global(.frame) {
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .readout {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    border-top: 1px solid var(--border);
    padding: 10px 14px;
    background: var(--elevated);
    border-bottom-left-radius: var(--r-3);
    border-bottom-right-radius: var(--r-3);
  }
  .readout-pickers { display: flex; gap: 10px; align-items: center; }
  .tok-tag {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-3);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .rcol {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    text-align: left;
  }
  .rcol .eyebrow {
    font-size: 11px;
    letter-spacing: 0.1em;
    color: var(--fg-4);
  }
  .rval { font-size: 15.5px; color: var(--fg); }
</style>
