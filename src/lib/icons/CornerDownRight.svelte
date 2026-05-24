<!-- CornerDownRight — child agent indicator -->
<script lang="ts">
  export let size: number = 16;
  export let stroke: number = 1.5;
  export let title: string | undefined = undefined;
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={title} aria-hidden={title ? undefined : true}>
  <polyline points="15 10 20 15 15 20"/>
  <path d="M4 4v7a4 4 0 0 0 4 4h12"/>
</svg>
