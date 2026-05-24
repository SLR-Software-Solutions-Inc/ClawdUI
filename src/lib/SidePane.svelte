<script lang="ts">
  export let title: string = "";
  export let position: "left" | "right" = "left";
  export let width: number = 320;
</script>

<aside
  class="sidepane"
  data-side={position}
  style="width: {width}px; flex: 0 0 {width}px;"
  aria-label="{position} side bar"
>
  {#if title}
    <header class="head">
      <span class="eyebrow mono">{title}</span>
    </header>
  {/if}
  <div class="body">
    <slot />
  </div>
</aside>

<style>
  .sidepane {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  .sidepane[data-side="right"] {
    border-right: none;
    border-left: 1px solid var(--border);
  }
  .head {
    flex: 0 0 auto;
    padding: 10px 14px 8px;
    border-bottom: 1px solid var(--line);
  }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12.5px;
    color: var(--fg-4);
    font-family: var(--font-mono);
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    /* Reserve a fixed gutter so the scrollbar never overlaps content. */
    scrollbar-gutter: stable;
    position: relative;
  }
</style>
