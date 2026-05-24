<!-- ListTree — plan mode -->
<script lang="ts">
  export let size: number = 16;
  export let stroke: number = 1.5;
  export let title: string | undefined = undefined;
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={title} aria-hidden={title ? undefined : true}>
  <path d="M21 12h-8"/>
  <path d="M21 6H8"/>
  <path d="M21 18h-8"/>
  <path d="M3 6v4c0 1.1.9 2 2 2h3"/>
  <path d="M3 10v6c0 1.1.9 2 2 2h3"/>
</svg>
