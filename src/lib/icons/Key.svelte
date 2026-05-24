<!-- Key — auth -->
<script lang="ts">
  export let size: number = 16;
  export let stroke: number = 1.5;
  export let title: string | undefined = undefined;
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={title} aria-hidden={title ? undefined : true}>
  <path d="m21 2-9.6 9.6"/>
  <circle cx="7.5" cy="15.5" r="5.5"/>
  <path d="m21 2-3 3"/>
  <path d="m18 5 3 3"/>
  <path d="m15 8 3 3"/>
</svg>
