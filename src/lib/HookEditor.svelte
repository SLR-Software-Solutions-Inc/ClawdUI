<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import {
    HOOK_EVENTS,
    TOOL_MATCHER_EVENTS,
    hooksModel,
    parseHooksJson,
    stringifyHooks,
    type HookEvent,
    type HookMap,
    type HookEntry,
    type HookCommand,
  } from "./hooks";
  import { patchSettings } from "./settings";
  import { X } from "./icons";

  /**
   * Set-and-forget Hooks editor.
   *
   * Layout: one card per hook event. Toggle the event ON to add matchers
   * (each matcher = a tool-name regex + N shell commands). The 3-pane
   * EVENTS / MATCHERS / COMMAND split has been removed: each event card
   * now hosts its own matcher rows inline.
   *
   * The component still consumes/produces the canonical `settings.hooksJson`
   * shape. All edits are persisted immediately (no Apply button).
   */

  // Compat shim — the old `embedded` / `open` props are no-ops now (we only
  // render embedded-style). Kept so legacy mounts still type-check.
  export let open = false;
  export let embedded = false;
  // suppress "unused export" warnings while preserving the public API
  void open;
  void embedded;

  const dispatch = createEventDispatcher<{
    "test-run": {
      command: string;
      timeout?: number;
      env?: Record<string, string>;
    };
  }>();

  const EVENT_DESCRIPTIONS: Record<HookEvent, string> = {
    PreToolUse: "Before any tool runs. Match by tool name; can block.",
    PostToolUse: "After a tool runs. Inspect input + output.",
    UserPromptSubmit: "Right after the user sends a message.",
    Stop: "When Claude finishes responding (final turn).",
    SubagentStop: "When a child / Task subagent finishes.",
    SessionStart: "Once, when a new session begins.",
    SessionEnd: "Once, when the session ends.",
    Notification: "When the agent surfaces a permission prompt.",
    PreCompact: "Before transcript auto-compaction.",
  };

  let working: HookMap = {};
  let parseErr: string | null = null;
  let rawOpen = false;
  let rawDraft = "";
  let rawErr: string | null = null;

  // Sync from settings.hooksJson reactively.
  $: {
    const r = $hooksModel;
    if (r.ok) {
      working = JSON.parse(JSON.stringify(r.map));
      parseErr = null;
    } else {
      parseErr = r.error;
    }
  }

  // Test-run UI state, keyed by `${event}:${matcherIdx}:${cmdIdx}`.
  let testKey: string | null = null;
  let testOut: string | null = null;
  let testRunning = false;

  function persist(map: HookMap) {
    working = map;
    patchSettings({ hooksJson: stringifyHooks(map) });
  }

  function clone<T>(x: T): T {
    return JSON.parse(JSON.stringify(x));
  }

  function isEnabled(ev: HookEvent): boolean {
    return Array.isArray(working[ev]) && (working[ev]?.length ?? 0) > 0;
  }

  function commandCount(ev: HookEvent): number {
    let n = 0;
    for (const e of working[ev] ?? []) n += e.hooks.length;
    return n;
  }

  function toggleEvent(ev: HookEvent) {
    const m = clone(working);
    if (isEnabled(ev)) {
      delete m[ev];
    } else {
      const entry: HookEntry = { hooks: [{ type: "command", command: "" }] };
      if (TOOL_MATCHER_EVENTS.includes(ev)) entry.matcher = "";
      m[ev] = [entry];
    }
    persist(m);
  }

  function addMatcher(ev: HookEvent) {
    const m = clone(working);
    const entry: HookEntry = { hooks: [{ type: "command", command: "" }] };
    if (TOOL_MATCHER_EVENTS.includes(ev)) entry.matcher = "";
    m[ev] = [...(m[ev] ?? []), entry];
    persist(m);
  }

  function removeMatcher(ev: HookEvent, idx: number) {
    const m = clone(working);
    const arr = m[ev] ?? [];
    arr.splice(idx, 1);
    if (!arr.length) delete m[ev];
    else m[ev] = arr;
    persist(m);
  }

  function setMatcherPattern(ev: HookEvent, idx: number, value: string) {
    const m = clone(working);
    const e = m[ev]?.[idx];
    if (!e) return;
    if (value === "") delete e.matcher;
    else e.matcher = value;
    persist(m);
  }

  function setCommand(ev: HookEvent, idx: number, cmdIdx: number, patch: Partial<HookCommand>) {
    const m = clone(working);
    const e = m[ev]?.[idx];
    if (!e) return;
    const cur = e.hooks[cmdIdx];
    if (!cur) return;
    const next: HookCommand = { ...cur, ...patch, type: "command" };
    if (next.timeout === undefined || (typeof next.timeout === "number" && Number.isNaN(next.timeout))) {
      delete next.timeout;
    }
    if (next.run_in_background === false || next.run_in_background === undefined) {
      delete next.run_in_background;
    }
    e.hooks[cmdIdx] = next;
    persist(m);
  }

  function addCommand(ev: HookEvent, idx: number) {
    const m = clone(working);
    const e = m[ev]?.[idx];
    if (!e) return;
    e.hooks.push({ type: "command", command: "" });
    persist(m);
  }

  function removeCommand(ev: HookEvent, idx: number, cmdIdx: number) {
    const m = clone(working);
    const e = m[ev]?.[idx];
    if (!e) return;
    e.hooks.splice(cmdIdx, 1);
    if (!e.hooks.length) {
      // dropping the last command of a matcher implicitly drops the matcher
      const arr = m[ev] ?? [];
      arr.splice(idx, 1);
      if (!arr.length) delete m[ev];
      else m[ev] = arr;
    }
    persist(m);
  }

  // -------- raw JSON overflow menu --------
  function openRaw() {
    rawDraft = stringifyHooks(working);
    rawErr = null;
    rawOpen = true;
  }

  function applyRaw() {
    const r = parseHooksJson(rawDraft);
    if (!r.ok) {
      rawErr = r.error;
      return;
    }
    rawErr = null;
    rawOpen = false;
    patchSettings({ hooksJson: stringifyHooks(r.map) });
  }

  async function exportClipboard() {
    try {
      await navigator.clipboard.writeText(stringifyHooks(working));
    } catch {
      /* ignore */
    }
  }

  function fixToEmpty() {
    patchSettings({ hooksJson: "{}" });
  }

  // -------- test runner ---------------
  function runTest(ev: HookEvent, idx: number, cmdIdx: number, dryRun: boolean) {
    const cmd = working[ev]?.[idx]?.hooks[cmdIdx];
    if (!cmd || !cmd.command.trim()) {
      testOut = "(no command)";
      testKey = `${ev}:${idx}:${cmdIdx}`;
      return;
    }
    testKey = `${ev}:${idx}:${cmdIdx}`;
    testRunning = true;
    testOut = "running…";
    const env: Record<string, string> = {};
    if (dryRun) env.CLAWDUI_DRY_RUN = "1";
    dispatch("test-run", {
      command: cmd.command,
      timeout: cmd.timeout,
      env,
    });
  }

  function onTestResult(e: Event) {
    const d = (e as CustomEvent).detail as {
      stdout?: string;
      stderr?: string;
      exit?: number;
      error?: string;
    };
    testRunning = false;
    if (d.error) {
      testOut = `error: ${d.error}`;
      return;
    }
    const parts: string[] = [];
    if (typeof d.exit === "number") parts.push(`exit=${d.exit}`);
    if (d.stdout) parts.push(`--- stdout ---\n${d.stdout}`);
    if (d.stderr) parts.push(`--- stderr ---\n${d.stderr}`);
    testOut = parts.join("\n") || "(no output)";
  }

  // We listen continuously; the page may re-mount this component and the
  // window event still hits.
  $: {
    if (typeof window !== "undefined") {
      window.removeEventListener("clawdui:hook-test-result", onTestResult);
      window.addEventListener("clawdui:hook-test-result", onTestResult);
    }
  }
</script>

<div class="hook-editor">
  <header class="header">
    <div class="lead">
      <h3>Hook events</h3>
      <p class="muted">
        Toggle an event ON to wire up matchers and shell commands. ClawdUI
        only runs hooks via Test — Claude Code itself fires them at runtime.
      </p>
    </div>
    <div class="overflow">
      <button class="ghost" type="button" on:click={openRaw}>Raw JSON…</button>
      <button class="ghost" type="button" on:click={() => void exportClipboard()}>Copy</button>
    </div>
  </header>

  {#if parseErr}
    <div class="banner">
      <span class="mono">hooksJson is invalid: {parseErr}</span>
      <button class="ghost" type="button" on:click={fixToEmpty}>Reset to {`{}`}</button>
    </div>
  {/if}

  <div class="cards">
    {#each HOOK_EVENTS as ev (ev)}
      {@const enabled = isEnabled(ev)}
      {@const cmds = commandCount(ev)}
      {@const matchers = working[ev] ?? []}
      <article class="card" class:on={enabled}>
        <header class="card-head">
          <label class="toggle">
            <input
              type="checkbox"
              checked={enabled}
              on:change={() => toggleEvent(ev)}
            />
            <span class="title mono">{ev}</span>
          </label>
          <span class="desc">{EVENT_DESCRIPTIONS[ev]}</span>
          {#if enabled}
            <span class="chip mono">{matchers.length} matcher · {cmds} cmd</span>
          {/if}
        </header>

        {#if enabled}
          <div class="matchers">
            {#each matchers as entry, i}
              <div class="matcher">
                <div class="matcher-head">
                  {#if TOOL_MATCHER_EVENTS.includes(ev)}
                    <input
                      class="pat mono"
                      type="text"
                      placeholder="Tool name regex (e.g. Bash | Edit|Write). Empty = any tool."
                      value={entry.matcher ?? ""}
                      on:input={(e) =>
                        setMatcherPattern(ev, i, (e.target as HTMLInputElement).value)}
                    />
                  {:else}
                    <span class="pat-inline mono">applies on every {ev}</span>
                  {/if}
                  <button
                    class="x"
                    type="button"
                    title="Remove matcher"
                    on:click={() => removeMatcher(ev, i)}
                  >
                    <X size={12} stroke={1.8} />
                  </button>
                </div>

                {#each entry.hooks as cmd, ci}
                  {@const k = `${ev}:${i}:${ci}`}
                  <div class="cmd">
                    <textarea
                      class="cmd-text mono"
                      rows="2"
                      placeholder='echo "tool=$CLAUDE_TOOL_NAME"'
                      value={cmd.command}
                      on:input={(e) =>
                        setCommand(ev, i, ci, {
                          command: (e.target as HTMLTextAreaElement).value,
                        })}
                    ></textarea>
                    <div class="cmd-row">
                      <label class="field mono">
                        timeout (s)
                        <input
                          type="number"
                          min="0"
                          value={cmd.timeout ?? ""}
                          on:input={(e) => {
                            const v = (e.target as HTMLInputElement).value;
                            setCommand(ev, i, ci, {
                              timeout: v === "" ? undefined : Number(v),
                            });
                          }}
                        />
                      </label>
                      <label class="field bg-toggle mono">
                        <input
                          type="checkbox"
                          checked={cmd.run_in_background === true}
                          on:change={(e) =>
                            setCommand(ev, i, ci, {
                              run_in_background: (e.target as HTMLInputElement).checked,
                            })}
                        />
                        run in background
                      </label>
                      <button
                        class="ghost mini"
                        type="button"
                        on:click={() => runTest(ev, i, ci, false)}
                        disabled={testRunning}
                      >
                        Test
                      </button>
                      <button
                        class="ghost mini"
                        type="button"
                        on:click={() => runTest(ev, i, ci, true)}
                        disabled={testRunning}
                        title="Sets CLAWDUI_DRY_RUN=1"
                      >
                        Test (dry-run)
                      </button>
                      <button
                        class="ghost mini danger"
                        type="button"
                        on:click={() => removeCommand(ev, i, ci)}
                        title="Remove command"
                      >
                        ✕
                      </button>
                    </div>
                    {#if testKey === k && testOut !== null}
                      <pre class="test-out mono">{testOut}</pre>
                    {/if}
                  </div>
                {/each}

                <button
                  class="ghost mini add-cmd"
                  type="button"
                  on:click={() => addCommand(ev, i)}
                >
                  + command
                </button>
              </div>
            {/each}

            <button
              class="ghost add-matcher"
              type="button"
              on:click={() => addMatcher(ev)}
            >
              + matcher
            </button>
          </div>
        {/if}
      </article>
    {/each}
  </div>

  {#if rawOpen}
    <div class="raw-overlay">
      <div class="raw-card">
        <header class="raw-head">
          <span class="eyebrow mono">RAW HOOKS JSON</span>
          <button class="ghost" type="button" on:click={() => (rawOpen = false)}>cancel</button>
        </header>
        <textarea class="mono" rows="14" bind:value={rawDraft}></textarea>
        {#if rawErr}
          <span class="raw-err mono">{rawErr}</span>
        {/if}
        <footer class="raw-foot">
          <button class="primary" type="button" on:click={applyRaw}>Apply</button>
        </footer>
      </div>
    </div>
  {/if}
</div>

<style>
  .hook-editor {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
  }
  .header {
    display: flex;
    align-items: flex-start;
    gap: 16px;
  }
  .lead { flex: 1 1 auto; min-width: 0; }
  .lead h3 { margin: 0 0 4px; font-family: var(--font-display); font-size: 17px; font-weight: 600; }
  .muted { margin: 0; color: var(--fg-3); font-size: 14.5px; line-height: 1.45; }
  .overflow { display: flex; gap: 6px; flex-shrink: 0; }

  .banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border: 1px solid var(--danger);
    background: oklch(0.32 0.16 25 / 0.18);
    color: var(--fg);
    border-radius: var(--r-2);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    background: var(--surface);
    transition: border-color var(--dur-1) var(--ease);
  }
  .card.on { border-color: var(--accent-line, var(--accent)); }

  .card-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    flex-wrap: wrap;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  .toggle input { cursor: pointer; }
  .title { font-size: 15.5px; color: var(--fg); font-weight: 600; }
  .desc {
    color: var(--fg-3);
    font-size: 14px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .chip {
    font-size: 12.5px;
    color: var(--fg-3);
    background: var(--elevated);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: var(--r-1);
  }

  .matchers {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0 14px 12px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .matcher {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
  }
  .matcher-head { display: flex; align-items: center; gap: 6px; }
  .pat {
    flex: 1 1 auto;
    background: transparent;
    color: var(--fg);
    border: 0;
    border-bottom: 1px solid var(--border);
    padding: 5px 0;
    font-family: var(--font-mono);
    font-size: 14.5px;
  }
  .pat:focus { outline: none; border-bottom-color: var(--accent); }
  .pat-inline {
    flex: 1 1 auto;
    color: var(--fg-4);
    font-size: 13.5px;
  }
  .x {
    background: transparent;
    color: var(--fg-3);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 2px 6px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }
  .x:hover { color: var(--danger); border-color: var(--danger); }

  .cmd { display: flex; flex-direction: column; gap: 6px; }
  .cmd-text {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 14.5px;
    resize: vertical;
  }
  .cmd-text:focus { outline: none; border-color: var(--accent); }

  .cmd-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .field {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-3);
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .field input[type="number"] {
    background: transparent;
    color: var(--fg);
    border: 0;
    border-bottom: 1px solid var(--border);
    padding: 2px 0;
    font-family: var(--font-mono);
    font-size: 14px;
    width: 60px;
    text-transform: none;
    letter-spacing: 0;
  }
  .field input[type="number"]:focus { outline: none; border-bottom-color: var(--accent); }
  .bg-toggle { text-transform: none; letter-spacing: 0; font-size: 13.5px; }

  .ghost {
    background: transparent;
    color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 4px 10px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 13.5px;
  }
  .ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--border-hi); }
  .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost.mini { padding: 3px 8px; font-size: 13px; }
  .ghost.danger:hover { color: var(--danger); border-color: var(--danger); }
  .add-cmd { align-self: flex-start; }
  .add-matcher { align-self: flex-start; }

  .test-out {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 8px 10px;
    font-size: 13.5px;
    max-height: 200px;
    overflow: auto;
    white-space: pre-wrap;
    margin: 0;
  }

  .primary {
    background: var(--accent);
    color: oklch(0.16 0.04 75);
    border: 0;
    border-radius: var(--r-2);
    padding: 6px 14px;
    cursor: pointer;
    font-weight: 600;
    font-size: 14.5px;
  }
  .primary:hover { filter: brightness(1.08); }

  /* raw json overlay */
  .raw-overlay {
    position: fixed;
    inset: 0;
    background: oklch(0 0 0 / 0.55);
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .raw-card {
    width: min(680px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-3);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .raw-head { display: flex; align-items: center; justify-content: space-between; }
  .raw-card textarea {
    width: 100%;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 10px;
    font-family: var(--font-mono);
    font-size: 14.5px;
    resize: vertical;
  }
  .raw-card textarea:focus { outline: none; border-color: var(--accent); }
  .raw-foot { display: flex; justify-content: flex-end; gap: 8px; }
  .raw-err { color: var(--danger); font-size: 14px; }
  .eyebrow {
    font-size: 12.5px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--fg-4);
    font-family: var(--font-mono);
  }
</style>
