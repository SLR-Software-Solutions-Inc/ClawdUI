<!-- Webhook — hooks -->
<script lang="ts">
  export let size: number = 16;
  export let stroke: number = 1.5;
  export let title: string | undefined = undefined;
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={title} aria-hidden={title ? undefined : true}>
  <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/>
  <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1A4 4 0 1 1 15.66 6"/>
  <path d="m12 8 3.13 5.78c.53.97 1.66 1.45 2.69 1.22A4 4 0 1 1 16 21.99"/>
</svg>
