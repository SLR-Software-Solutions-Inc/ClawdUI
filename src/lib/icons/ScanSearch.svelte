<!-- ScanSearch — review/ultrareview -->
<script lang="ts">
  export let size: number = 16;
  export let stroke: number = 1.5;
  export let title: string | undefined = undefined;
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={title} aria-hidden={title ? undefined : true}>
  <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
  <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
  <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
  <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
  <circle cx="12" cy="12" r="3"/>
  <path d="m16 16-1.9-1.9"/>
</svg>
