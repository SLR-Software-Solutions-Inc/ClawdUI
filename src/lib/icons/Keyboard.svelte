<!-- Keyboard — kbd hints in menus -->
<script lang="ts">
  export let size: number = 16;
  export let stroke: number = 1.5;
  export let title: string | undefined = undefined;
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={title} aria-hidden={title ? undefined : true}>
  <rect width="20" height="14" x="2" y="5" rx="2"/>
  <path d="M6 9h.01"/>
  <path d="M10 9h.01"/>
  <path d="M14 9h.01"/>
  <path d="M18 9h.01"/>
  <path d="M6 13h.01"/>
  <path d="M18 13h.01"/>
  <path d="M10 13h4"/>
</svg>
