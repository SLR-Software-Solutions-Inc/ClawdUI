<!-- LifeBuoy — help -->
<script lang="ts">
  export let size: number = 16;
  export let stroke: number = 1.5;
  export let title: string | undefined = undefined;
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={title} aria-hidden={title ? undefined : true}>
  <circle cx="12" cy="12" r="10"/>
  <path d="m4.93 4.93 4.24 4.24"/>
  <path d="m14.83 9.17 4.24-4.24"/>
  <path d="m14.83 14.83 4.24 4.24"/>
  <path d="m9.17 14.83-4.24 4.24"/>
  <circle cx="12" cy="12" r="4"/>
</svg>
