<!-- Puzzle — plugins -->
<script lang="ts">
  export let size: number = 16;
  export let stroke: number = 1.5;
  export let title: string | undefined = undefined;
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={title} aria-hidden={title ? undefined : true}>
  <path d="M15.39 4.39a2.5 2.5 0 1 0 1.68-4.18A2.5 2.5 0 0 0 14.5 2v2H10V2a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 1.61 2.34A2.5 2.5 0 0 0 5 4H3a1 1 0 0 0-1 1v5a2.5 2.5 0 0 0 2.5 2.5h.04A2.5 2.5 0 1 0 6 17.5v.5a1 1 0 0 0 1 1h5v-2a2.5 2.5 0 1 1 5 0v2h5a1 1 0 0 0 1-1v-5a2.5 2.5 0 0 0-2.5-2.5h-.04A2.5 2.5 0 1 0 18 6.5V6a1 1 0 0 0-1-1h-1.61Z"/>
</svg>
