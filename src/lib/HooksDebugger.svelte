<script lang="ts">
  /**
   * HooksDebugger — right-side overlay listing all configured hooks from
   * settings.hooksJson and showing the most recent firing of each.
   *
   * Hook activity comes from a sidecar event named "hook-event" with shape:
   *   { type: "hook-event", event: string, matcher?: string, command: string,
   *     ts: number, exitCode?: number, output?: string }
   *
   * TODO(sidecar): the sidecar does NOT currently emit "hook-event". When
   * wiring this up, fire one event per hook invocation (PreToolUse,
   * PostToolUse, Stop, etc.) with the fields above. Until then this panel
   * renders the configured hooks but shows "No hook activity yet" under
   * each one.
   */
  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import { X } from "./icons";
  import { hooksModel, HOOK_EVENTS, type HookEvent, type HookEntry } from "./hooks";

  export let open = false;
  /**
   * Subscribe to sidecar events. Same shape as MobilePair's prop — callers
   * pass the App-level fanout so we receive every event.
   */
  export let onSidecarEvent:
    | ((cb: (ev: any) => void) => () => void)
    | null = null;

  const dispatch = createEventDispatcher<{ close: void }>();

  type Activity = {
    ts: number;
    exitCode?: number;
    output?: string;
    matcher?: string;
  };
  /** Keyed by `${event}::${matcher ?? "*"}::${command}` */
  let activity: Record<string, Activity[]> = {};
  /** Per-row UI expand state for the output blob. */
  let expanded: Record<string, boolean> = {};
  let unsub: (() => void) | null = null;

  function keyFor(ev: string, matcher: string | undefined, command: string): string {
    return `${ev}::${matcher ?? "*"}::${command}`;
  }

  function pushActivity(ev: any): void {
    if (!ev || typeof ev !== "object") return;
    if (ev.type !== "hook-event") return;
    const k = keyFor(String(ev.event ?? ""), ev.matcher, String(ev.command ?? ""));
    const entry: Activity = {
      ts: typeof ev.ts === "number" ? ev.ts : Date.now(),
      exitCode: typeof ev.exitCode === "number" ? ev.exitCode : undefined,
      output: typeof ev.output === "string" ? ev.output : undefined,
      matcher: typeof ev.matcher === "string" ? ev.matcher : undefined,
    };
    const arr = activity[k] ? [...activity[k]] : [];
    arr.unshift(entry);
    activity = { ...activity, [k]: arr.slice(0, 10) }; // cap history per row
  }

  $: parsed = $hooksModel;

  // Stable shape for rendering: list of rows per event.
  type Row = { ev: HookEvent; matcher?: string; command: string; key: string };
  $: rows = (() => {
    if (!parsed.ok) return [] as Row[];
    const out: Row[] = [];
    for (const ev of HOOK_EVENTS) {
      const entries: HookEntry[] | undefined = parsed.map[ev];
      if (!entries) continue;
      for (const entry of entries) {
        for (const c of entry.hooks) {
          out.push({
            ev,
            matcher: entry.matcher,
            command: c.command,
            key: keyFor(ev, entry.matcher, c.command),
          });
        }
      }
    }
    return out;
  })();

  function fmtTs(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function close(): void {
    open = false;
    dispatch("close");
  }

  function onKeydown(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  onMount(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", onKeydown);
    }
    if (onSidecarEvent) unsub = onSidecarEvent(pushActivity);
  });
  onDestroy(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", onKeydown);
    }
    unsub?.();
  });
</script>

{#if open}
  <button class="scrim" on:click={close} aria-label="Close hooks debugger"></button>
  <aside class="panel" role="dialog" aria-modal="true" aria-label="Hooks debugger">
    <header class="head">
      <div class="title">
        <span class="eyebrow">HOOKS</span>
        <h2>Hooks debugger</h2>
      </div>
      <button class="close" on:click={close} aria-label="Close">
        <X size={14} stroke={1.8} />
      </button>
    </header>

    <div class="body">
      {#if !parsed.ok}
        <p class="placeholder mono">hooksJson parse error: {parsed.error}</p>
      {:else if rows.length === 0}
        <p class="placeholder">No hooks configured. Add them in Settings → Hooks.</p>
      {:else}
        <ul class="rows">
          {#each rows as r (r.key)}
            {@const acts = activity[r.key] ?? []}
            {@const last = acts[0]}
            <li class="row">
              <div class="row-head">
                <span class="ev-pill mono">{r.ev}</span>
                {#if r.matcher}<span class="matcher mono">{r.matcher}</span>{/if}
                <span class="cmd mono" title={r.command}>{r.command || "(no command)"}</span>
              </div>
              <div class="row-meta mono">
                {#if last}
                  <span class="ts">last {fmtTs(last.ts)}</span>
                  {#if last.exitCode !== undefined}
                    <span class={"exit " + (last.exitCode === 0 ? "ok" : "bad")}
                      >exit {last.exitCode}</span>
                  {/if}
                  {#if last.output}
                    <button
                      class="toggle"
                      type="button"
                      on:click={() => (expanded = { ...expanded, [r.key]: !expanded[r.key] })}
                    >{expanded[r.key] ? "hide output" : "show output"}</button>
                  {/if}
                {:else}
                  <span class="ts muted">No hook activity yet</span>
                {/if}
              </div>
              {#if last?.output && expanded[r.key]}
                <pre class="output mono">{last.output}</pre>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: oklch(0 0 0 / 0.45);
    backdrop-filter: blur(3px);
    z-index: 50;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(520px, 92vw);
    background: var(--surface);
    border-left: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    display: grid;
    grid-template-rows: auto 1fr;
    z-index: 51;
    animation: slide-in var(--dur-2) var(--ease);
  }
  @keyframes slide-in {
    from { transform: translateX(100%); }
    to   { transform: translateX(0); }
  }
  .head {
    display: flex;
    align-items: center;
    padding: 14px 18px 10px;
    border-bottom: 1px solid var(--border);
  }
  .title h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--fg-4);
  }
  .close {
    margin-left: auto;
    width: 30px;
    height: 30px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg-2);
    border-radius: var(--r-2);
    cursor: pointer;
  }
  .close:hover { color: var(--fg); border-color: var(--border-hi); }

  .body {
    overflow-y: auto;
    padding: 12px 16px 22px;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row {
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 8px 10px;
    background: var(--bg);
  }
  .row-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ev-pill {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 999px;
    border: 1px solid var(--border-hi, var(--border));
    color: var(--fg);
  }
  .matcher {
    font-size: 11px;
    color: var(--fg-3);
  }
  .cmd {
    font-size: 12px;
    color: var(--fg-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .row-meta {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11.5px;
    color: var(--fg-3);
  }
  .row-meta .muted { color: var(--fg-4); }
  .exit.ok { color: var(--success, #6ce28a); }
  .exit.bad { color: var(--danger, #ff7070); }
  .toggle {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    color: var(--fg-2);
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 1px 6px;
    cursor: pointer;
  }
  .toggle:hover { color: var(--fg); border-color: var(--border-hi); }
  .output {
    margin: 6px 0 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 6px 8px;
    font-size: 11.5px;
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg-2);
  }
  .placeholder {
    color: var(--fg-3);
    font-size: 13px;
    padding: 8px 0;
  }
</style>
