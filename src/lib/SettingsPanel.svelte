<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import {
    DEFAULT_SETTINGS,
    SETTING_FIELDS,
    SETTING_GROUPS,
    type Settings,
    type SettingField,
    type SettingGroup,
  } from "./types";
  import { settings, patchSettings, resetSettings } from "./settings";
  import { X } from "./icons";
  import FieldControl from "./FieldControl.svelte";
  import PluginsManager from "./PluginsManager.svelte";
  import McpManager from "./McpManager.svelte";
  import HookEditor from "./HookEditor.svelte";
  import SkillsPanel from "./SkillsPanel.svelte";
  import {
    removePermanentRuleAt,
    clearPermanentRules,
  } from "./permissions.svelte";

  function fmtTime(ms: number): string {
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return String(ms);
    }
  }
  function shorten(s: string, n = 60): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
  }

  /**
   * Settings panel — left-strip tab navigation.
   *
   * Skills / MCP / Hooks / Plugins are first-class tabs alongside the
   * SETTING_GROUPS-backed forms (Appearance / Model / Permissions / Session
   * / System / Tools / Limits / Advanced). The tabs that map to a
   * SETTING_GROUPS entry render the existing field list. Skills/MCP/Hooks/
   * Plugins render the redesigned set-and-forget components, with the raw
   * JSON SETTING_FIELDS available below in a "Edit raw JSON" disclosure so
   * advanced users can still see the underlying config.
   *
   * The panel itself opens as a full-window OVERLAY (modal scrim + centered
   * card) when not embedded; embedded mode keeps the legacy in-pane layout
   * for completeness but is no longer wired in App.svelte.
   */

  export let open = false;
  export let embedded = false;

  // Esc closes the overlay form (irrelevant when embedded).
  function onKeydown(e: KeyboardEvent) {
    if (!embedded && open && e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
  $: if (typeof window !== "undefined") {
    if (!embedded && open) {
      window.addEventListener("keydown", onKeydown);
    } else {
      window.removeEventListener("keydown", onKeydown);
    }
  }
  onDestroy(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", onKeydown);
    }
  });

  const dispatch = createEventDispatcher<{
    close: void;
    restart: void;
    "live-apply": { field: SettingField; value: unknown };
    "hook-test-run": {
      command: string;
      timeout?: number;
      env?: Record<string, string>;
    };
  }>();

  const STORAGE_KEY = "clawdui.settings.activeGroup";

  let activeGroup: SettingGroup = "model";
  let dirty = false;
  // raw-json disclosure state, per tab
  const rawOpen: Record<string, boolean> = {};

  $: groupedFields = SETTING_FIELDS.reduce<Record<SettingGroup, SettingField[]>>(
    (acc, f) => {
      (acc[f.group] ||= []).push(f);
      return acc;
    },
    {} as Record<SettingGroup, SettingField[]>,
  );

  // Tabs that own a custom rich UI (rendered via embedded components).
  const RICH_TABS: SettingGroup[] = ["skills", "mcp", "hooks", "plugins"];

  function onChange(field: SettingField, value: unknown) {
    patchSettings({ [field.key]: value } as Partial<Settings>);
    dirty = true;
    if (field.liveApply) {
      dispatch("live-apply", { field, value });
    }
  }

  function close() {
    dispatch("close");
  }
  function restart() {
    dirty = false;
    dispatch("restart");
  }
  function reset() {
    if (!confirm("Reset all settings to defaults?")) return;
    resetSettings();
    dirty = true;
  }

  /** Per-field "Restore default" — only wired for systemPromptCustom right
   *  now. Resets that single key to DEFAULT_SETTINGS without nuking other
   *  user prefs. Confirms first because the textarea is large and a user
   *  may have spent time customizing the orchestrator template. */
  function restoreFieldDefault(key: keyof Settings) {
    if (!confirm(`Restore "${String(key)}" to the shipped default? Your current value will be lost.`)) {
      return;
    }
    patchSettings({ [key]: DEFAULT_SETTINGS[key] } as Partial<Settings>);
    dirty = true;
  }

  function setTab(id: SettingGroup) {
    activeGroup = id;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch { /* ignore */ }
  }

  function onExternalTabRequest(e: Event) {
    const detail = (e as CustomEvent).detail as SettingGroup | string | undefined;
    if (!detail) return;
    if ((SETTING_GROUPS as { id: SettingGroup }[]).some((g) => g.id === detail)) {
      setTab(detail as SettingGroup);
    }
  }

  onMount(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && (SETTING_GROUPS as { id: SettingGroup }[]).some((g) => g.id === saved)) {
        activeGroup = saved as SettingGroup;
      }
    } catch { /* ignore */ }
    window.addEventListener("clawdui:settings-tab", onExternalTabRequest);
  });

  onDestroy(() => {
    window.removeEventListener("clawdui:settings-tab", onExternalTabRequest);
  });
</script>

{#if open || embedded}
  {#if !embedded}
    <button class="scrim" on:click={close} aria-label="Close settings"></button>
  {/if}
  <div class="panel" class:embedded role="dialog" aria-modal={embedded ? undefined : "true"} aria-label="Settings">
    <header class="head">
      <div class="title">
        <span class="eyebrow">CONFIG</span>
        <h2>Session settings</h2>
      </div>
      <button class="close" on:click={close} aria-label="Close"><X size={14} stroke={1.8} /></button>
    </header>

    <div class="layout">
      <nav class="side">
        {#each SETTING_GROUPS as g}
          <button
            class="side-tab"
            class:active={activeGroup === g.id}
            on:click={() => setTab(g.id)}
          >
            <span class="side-label">{g.label}</span>
            <span class="side-sub">{g.subtitle}</span>
          </button>
        {/each}
      </nav>

      <div class="body">
        {#if activeGroup === "skills"}
          <section class="rich">
            <header class="rich-head">
              <h3>Skills</h3>
              <p class="muted">
                Discovered from <span class="mono">~/.claude/skills</span> and your
                plugin folders. Skills are configured by editing the SKILL.md
                files outside ClawdUI — this view is read-only. Use the "↗"
                button to open a skill's folder.
              </p>
            </header>
          </section>

        {:else if activeGroup === "mcp"}
          <section class="rich">
            <header class="rich-head">
              <h3>MCP servers</h3>
              <p class="muted">
                External tool servers exposed to Claude. Add a server, then
                <em>Test connection</em> to verify it spawns. Strict mode hides
                filesystem MCP configs from the SDK.
              </p>
            </header>
            <div class="rich-mcp">
              <McpManager embedded />
            </div>
            <details class="raw" open={rawOpen["mcp"] ?? false} on:toggle={(e) => (rawOpen["mcp"] = (e.target as HTMLDetailsElement).open)}>
              <summary>Edit raw JSON</summary>
              <div class="raw-fields">
                {#each groupedFields["mcp"] ?? [] as f}
                  <section class="row">
                    <div class="meta">
                      <div class="head-row">
                        <span class="label">{f.label}</span>
                        {#if f.flag}<span class="flag mono">{f.flag}</span>{/if}
                      </div>
                      <p class="help">{f.help}</p>
                    </div>
                    <div class="control">
                      <FieldControl
                        field={f}
                        value={$settings[f.key]}
                        on:change={(e) => onChange(f, e.detail)}
                      />
                    </div>
                  </section>
                {/each}
              </div>
            </details>
          </section>

        {:else if activeGroup === "hooks"}
          <section class="rich">
            <header class="rich-head">
              <h3>Hooks</h3>
              <p class="muted">
                Toggle a hook event ON, then add matchers + shell commands.
                Claude Code fires these at runtime — ClawdUI only invokes them
                via the inline <em>Test</em> button.
              </p>
            </header>
            <div class="rich-hooks">
              <HookEditor
                embedded
                on:test-run={(e) => dispatch("hook-test-run", e.detail)}
              />
            </div>
          </section>

        {:else if activeGroup === "plugins"}
          <section class="rich">
            <header class="rich-head">
              <h3>Plugins</h3>
              <p class="muted">
                Local plugin folders. Each enabled directory feeds the SDK as
                <span class="mono">{`{ type: "local", path }`}</span>. Toggle
                disabled to skip without removing.
              </p>
            </header>
            <div class="rich-plugins">
              <PluginsManager />
            </div>
            <details class="raw" open={rawOpen["plugins"] ?? false} on:toggle={(e) => (rawOpen["plugins"] = (e.target as HTMLDetailsElement).open)}>
              <summary>Edit raw JSON</summary>
              <div class="raw-fields">
                <p class="muted small">
                  Stored under <span class="mono">settings.pluginDirs</span> and
                  <span class="mono">settings.disabledPluginPaths</span>.
                </p>
                <pre class="raw-json mono">{JSON.stringify({
                  pluginDirs: $settings.pluginDirs,
                  disabledPluginPaths: $settings.disabledPluginPaths,
                }, null, 2)}</pre>
              </div>
            </details>
          </section>

        {:else}
          {#if activeGroup === "permissions"}
            <section class="row full">
              <div class="meta">
                <div class="head-row">
                  <span class="label">Persistent allow list</span>
                  <span class="flag mono">(local)</span>
                </div>
                <p class="help">
                  Auto-allowed tool calls that survive restarts. Match types:
                  <span class="mono">exact</span> = same tool + identical input,
                  <span class="mono">prefix</span> = primary string field
                  starts with pattern, <span class="mono">glob</span> =
                  <span class="mono">*</span>/<span class="mono">**</span> match,
                  <span class="mono">any</span> = same tool, any input.
                  Only applied while <span class="mono">permissionMode = default</span>.
                </p>
              </div>
              <div class="control">
                {#if ($settings.permanentAllowList ?? []).length === 0}
                  <p class="empty mono">No persistent allow rules.</p>
                {:else}
                  <table class="rules mono">
                    <thead>
                      <tr>
                        <th>tool</th>
                        <th>match</th>
                        <th>pattern</th>
                        <th>added</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each $settings.permanentAllowList as r, i}
                        <tr>
                          <td>{r.toolName}</td>
                          <td>{r.matchType}</td>
                          <td title={r.pattern}>{shorten(r.pattern)}</td>
                          <td>{fmtTime(r.addedAt)}</td>
                          <td>
                            <button
                              class="row-btn"
                              type="button"
                              on:click={() => removePermanentRuleAt(i)}
                              aria-label="Remove rule"
                            >×</button>
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                  <button
                    class="ghost clear-all"
                    type="button"
                    on:click={() => {
                      if (confirm("Clear all persistent allow rules?")) clearPermanentRules();
                    }}
                  >Clear all</button>
                {/if}
              </div>
            </section>
          {/if}
          {#each groupedFields[activeGroup] ?? [] as f}
            <section class="row">
              <div class="meta">
                <div class="head-row">
                  <span class="label">{f.label}</span>
                  {#if f.flag}
                    <span class="flag mono">{f.flag}</span>
                  {/if}
                  {#if f.liveApply}
                    <span class="live mono">LIVE</span>
                  {/if}
                </div>
                <p class="help">{f.help}</p>
              </div>
              <div class="control">
                <FieldControl
                  field={f}
                  value={$settings[f.key]}
                  on:change={(e) => onChange(f, e.detail)}
                />
                {#if f.key === "systemPromptCustom"}
                  <button
                    type="button"
                    class="ghost field-restore"
                    on:click={() => restoreFieldDefault("systemPromptCustom")}
                    title="Replace your current text with the shipped master-orchestrator template"
                  >Restore default</button>
                {/if}
              </div>
            </section>
          {/each}
        {/if}
      </div>
    </div>

    <footer class="foot">
      <button class="ghost" on:click={reset}>Reset</button>
      <span class="dirty mono" class:hot={dirty}>{dirty ? "● UNSAVED" : "● SYNCED"}</span>
      {#if !RICH_TABS.includes(activeGroup)}
        <button class="primary" on:click={restart} disabled={!dirty}>
          Apply &amp; restart session
        </button>
      {:else}
        <span class="rich-foot mono">changes saved automatically</span>
      {/if}
    </footer>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: oklch(0 0 0 / 0.55);
    backdrop-filter: blur(4px);
    z-index: 50;
    animation: slide-up var(--dur-2) var(--ease);
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .panel.embedded {
    position: relative;
    top: auto;
    right: auto;
    inset: auto;
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    z-index: auto;
    animation: none;
  }
  .panel.embedded :global(.close) { display: none; }
  /* Overlay (modal) form: centered card over the whole window. */
  .panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(900px, 92vw);
    max-width: 900px;
    max-height: 85vh;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-3, 10px);
    box-shadow: var(--shadow-lg);
    display: grid;
    grid-template-rows: auto 1fr auto;
    z-index: 51;
    animation: slide-up var(--dur-2) var(--ease);
    overflow: hidden;
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
    font-size: 19.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .eyebrow {
    font-family: var(--font-mono);
    font-size: 12px;
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
    font-size: 16px;
  }
  .close:hover { color: var(--fg); border-color: var(--border-hi); }

  .layout {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    min-height: 0;
    overflow: hidden;
  }

  .side {
    border-right: 1px solid var(--border);
    overflow-y: auto;
    padding: 8px 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--surface);
  }
  .side-tab {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 8px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-2);
    color: var(--fg-2);
    cursor: pointer;
    text-align: left;
    transition: all var(--dur-1) var(--ease);
  }
  .side-tab:hover { background: var(--elevated); color: var(--fg); }
  .side-tab.active {
    background: var(--elevated);
    color: var(--fg);
    border-color: var(--accent-line, var(--accent));
  }
  .side-label { font-weight: 600; font-size: 14.5px; }
  .side-sub {
    font-size: 12px;
    color: var(--fg-3);
    font-family: var(--font-mono);
    text-transform: lowercase;
    letter-spacing: 0;
    line-height: 1.3;
  }

  .body {
    overflow-y: auto;
    padding: 14px 18px 24px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-height: 0;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
    gap: 18px;
    align-items: start;
  }
  .help :global(.mono) {
    font-family: var(--font-mono);
    font-size: 13.5px;
    background: var(--elevated);
    padding: 1px 5px;
    border-radius: var(--r-1);
  }
  .head-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .label { font-weight: 600; font-size: 15px; }
  .flag {
    font-size: 12.5px;
    color: var(--fg-3);
    background: var(--elevated);
    padding: 1px 6px;
    border-radius: var(--r-1);
  }
  .live {
    font-size: 11.5px;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 1px 5px;
    border-radius: var(--r-1);
    letter-spacing: 0.08em;
  }
  .help {
    margin: 4px 0 0;
    font-size: 14px;
    color: var(--fg-3);
    line-height: 1.45;
  }

  /* rich tab wrappers */
  .rich {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
  }
  .rich-head h3 {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 600;
  }
  .rich-head .muted { margin: 0; color: var(--fg-3); font-size: 14px; line-height: 1.45; }
  .rich-head .mono { font-family: var(--font-mono); font-size: 13px; background: var(--elevated); padding: 1px 5px; border-radius: var(--r-1); }
  .rich-skills, .rich-plugins, .rich-hooks {
    /* let inner panel manage its own scroll & height */
    min-height: 0;
  }
  .rich-mcp {
    /* McpManager has internal grid layout — pin to a fixed minimum */
    min-height: 460px;
    position: relative;
  }
  .rich-mcp :global(.panel) {
    position: relative !important;
    inset: auto !important;
    height: 100% !important;
    border-radius: var(--r-2) !important;
  }
  .rich-skills :global(.panel) {
    position: relative !important;
    inset: auto !important;
    width: 100% !important;
    height: auto !important;
    max-height: 60vh;
    border-radius: var(--r-2) !important;
  }

  .raw {
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 0 10px;
    background: var(--surface);
  }
  .raw > summary {
    cursor: pointer;
    padding: 8px 0;
    font-family: var(--font-mono);
    font-size: 13.5px;
    color: var(--fg-3);
    list-style: none;
  }
  .raw > summary::before { content: "▸ "; color: var(--fg-4); }
  .raw[open] > summary::before { content: "▾ "; color: var(--fg-4); }
  .raw > summary:hover { color: var(--fg); }
  .raw-fields { padding: 6px 0 12px; display: flex; flex-direction: column; gap: 10px; }
  .raw-fields .muted.small { margin: 0; font-size: 12.5px; color: var(--fg-3); }
  .raw-fields .muted .mono { background: var(--elevated); padding: 1px 4px; border-radius: var(--r-1); font-family: var(--font-mono); }
  .raw-json {
    margin: 0;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 8px 10px;
    font-size: 13px;
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 18px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  .ghost {
    background: transparent;
    color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 6px 12px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 14px;
  }
  .ghost:hover { color: var(--fg); border-color: var(--border-hi); }
  .field-restore {
    margin-top: 6px;
    align-self: flex-start;
    font-size: 12.5px;
    padding: 4px 10px;
  }

  .primary {
    margin-left: auto;
    background: var(--accent);
    color: oklch(0.16 0.04 75);
    border: 0;
    border-radius: var(--r-2);
    padding: 7px 14px;
    cursor: pointer;
    font-weight: 600;
    font-size: 14.5px;
    transition: filter var(--dur-1) var(--ease);
  }
  .primary:hover:not(:disabled) { filter: brightness(1.08); }
  .primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .dirty {
    font-size: 13.5px;
    color: var(--fg-3);
    margin-left: auto;
  }
  .dirty.hot { color: var(--warning); }
  .dirty + .primary, .dirty + .rich-foot { margin-left: 0; }
  .rich-foot {
    font-size: 12.5px;
    color: var(--fg-4);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .empty {
    color: var(--fg-3);
    font-size: 14.5px;
    margin: 0;
  }
  table.rules {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
    color: var(--fg-2);
  }
  table.rules th, table.rules td {
    border-bottom: 1px solid var(--border);
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
    word-break: break-all;
  }
  table.rules th {
    color: var(--fg-3);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 12.5px;
  }
  .row-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--danger);
    border-radius: var(--r-1);
    width: 22px;
    height: 22px;
    cursor: pointer;
    line-height: 1;
  }
  .row-btn:hover { border-color: var(--danger); }
  .clear-all { margin-top: 10px; }
</style>
