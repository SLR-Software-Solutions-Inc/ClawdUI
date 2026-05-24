<script lang="ts">
  export let state:
    | "idle"
    | "connecting"
    | "connected"
    | "error"
    | "ok"
    | "warn" = "idle";
  export let label = "";
  export let size: "default" | "sm" = "default";
  export let title: string | undefined = undefined;
</script>

<span class="pill {state}" class:sm={size === "sm"} {title}>
  <span class="dot"></span>
  <span class="label mono">{label}</span>
</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 14px 0 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    font-family: var(--font-mono);
    font-size: 14px;
    line-height: 1;
    color: var(--fg-2);
    transition: border-color var(--dur-1) var(--ease);
  }
  .label { letter-spacing: 0.04em; }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--fg-4);
    position: relative;
    flex-shrink: 0;
  }

  .pill.connecting { border-color: oklch(0.40 0.10 75); color: var(--accent); }
  .pill.connecting .dot { background: var(--accent); color: var(--accent); animation: pulse-ring 1.5s var(--ease) infinite; }

  .pill.connected { border-color: oklch(0.30 0.08 155); color: var(--success); }
  .pill.connected .dot { background: var(--success); color: var(--success); animation: pulse-ring 2.4s var(--ease) infinite; }

  .pill.error { border-color: oklch(0.40 0.15 25); color: var(--danger); }
  .pill.error .dot { background: var(--danger); }

  .pill.idle .dot { background: var(--fg-4); }

  /* Aliases used by the statusbar summary row. */
  .pill.ok { border-color: oklch(0.30 0.08 155); color: var(--success); }
  .pill.ok .dot { background: var(--success); }
  .pill.warn { border-color: oklch(0.40 0.10 75); color: var(--accent); }
  .pill.warn .dot { background: var(--accent); }

  /* Compact variant for the inline trio in the topbar. */
  .pill.sm {
    height: 22px;
    padding: 0 8px 0 7px;
    font-size: 11.5px;
    gap: 6px;
  }
  .pill.sm .dot { width: 6px; height: 6px; }
</style>
