<!-- Stethoscope — doctor -->
<script lang="ts">
  export let size: number = 16;
  export let stroke: number = 1.5;
  export let title: string | undefined = undefined;
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={title} aria-hidden={title ? undefined : true}>
  <path d="M11 2v2"/>
  <path d="M5 2v2"/>
  <path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/>
  <path d="M8 15a6 6 0 0 0 12 0v-3"/>
  <circle cx="20" cy="10" r="2"/>
</svg>
