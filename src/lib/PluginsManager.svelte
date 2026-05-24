<script lang="ts">
  import { onMount } from "svelte";
  import { settings } from "./settings";
  import {
    installedPlugins,
    discovered,
    pluginsLoading,
    pluginsError,
    refresh,
    discoverFromClaudeCache,
    addPluginPath,
    removePluginPath,
    togglePluginEnabled,
    copyPath,
    type PluginInfo,
  } from "./plugins";

  let newPath = "";
  let showDiscover = false;

  onMount(() => {
    void refresh();
  });

  function onAdd() {
    if (addPluginPath(newPath)) {
      newPath = "";
    }
  }

  function onRemove(p: string) {
    if (!confirm(`Remove plugin?\n${p}`)) return;
    removePluginPath(p);
  }

  async function onDiscover() {
    showDiscover = true;
    await discoverFromClaudeCache();
  }

  function isDisabled(p: string): boolean {
    return ($settings.disabledPluginPaths ?? []).includes(p);
  }

  function alreadyAdded(p: string): boolean {
    return ($settings.pluginDirs ?? []).includes(p);
  }

  function totalCount(c: PluginInfo["counts"]): number {
    return c.skills + c.commands + c.hooks + c.agents;
  }

  function shortPath(p: string): string {
    // Collapse a typical user home prefix to "~" without leaking the host
    // user's actual name. Matches /Users/<name>/... (macOS) and
    // /home/<name>/... (Linux). Windows paths are returned unchanged.
    const m = p.match(/^(\/(?:Users|home)\/[^/]+)(\/.*)?$/);
    return m ? "~" + (m[2] ?? "") : p;
  }
</script>

<div class="plugins-manager">
  <div class="add-row">
    <input
      type="text"
      class="path-input mono"
      placeholder="/absolute/path/to/plugin"
      bind:value={newPath}
      on:keydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onAdd();
        }
      }}
    />
    <button class="btn primary" type="button" on:click={onAdd} disabled={!newPath.trim()}>
      Add
    </button>
    <button class="btn ghost" type="button" on:click={() => void refresh()}>
      Refresh
    </button>
    <button class="btn ghost" type="button" on:click={() => void onDiscover()}>
      Discover
    </button>
  </div>

  {#if $pluginsError}
    <div class="error mono">{$pluginsError}</div>
  {/if}

  {#if $installedPlugins.length === 0}
    <div class="empty mono">
      No plugins. Add a folder containing <span>commands/</span>, <span>skills/</span>,
      <span>agents/</span>, or <span>hooks/</span> — or click Discover.
    </div>
  {:else}
    <ul class="plugin-list">
      {#each $installedPlugins as p (p.path)}
        <li class="plugin-row" class:missing={!p.exists} class:off={isDisabled(p.path)}>
          <div class="plugin-head">
            <div class="plugin-id">
              <span class="plugin-name">
                {p.name || p.path.split("/").filter(Boolean).pop() || "(unnamed)"}
              </span>
              {#if p.version}
                <span class="badge mono">v{p.version}</span>
              {/if}
              {#if !p.exists}
                <span class="badge bad mono">missing</span>
              {/if}
              {#if isDisabled(p.path)}
                <span class="badge muted mono">disabled</span>
              {/if}
            </div>
            <div class="actions">
              <button
                class="btn ghost"
                type="button"
                title={isDisabled(p.path) ? "Enable" : "Disable"}
                on:click={() => togglePluginEnabled(p.path)}
              >
                {isDisabled(p.path) ? "Enable" : "Disable"}
              </button>
              <button
                class="btn ghost"
                type="button"
                title="Copy path"
                on:click={() => void copyPath(p.path)}
              >
                Copy
              </button>
              <button
                class="btn ghost danger"
                type="button"
                on:click={() => onRemove(p.path)}
              >
                Remove
              </button>
            </div>
          </div>
          {#if p.description}
            <p class="plugin-desc">{p.description}</p>
          {/if}
          <div class="plugin-meta mono">
            <span class="path" title={p.path}>{shortPath(p.path)}</span>
          </div>
          <div class="counts mono">
            {#if p.counts.skills > 0}
              <span class="count">skills <b>{p.counts.skills}</b></span>
            {/if}
            {#if p.counts.commands > 0}
              <span class="count">commands <b>{p.counts.commands}</b></span>
            {/if}
            {#if p.counts.hooks > 0}
              <span class="count">hooks <b>{p.counts.hooks}</b></span>
            {/if}
            {#if p.counts.agents > 0}
              <span class="count">agents <b>{p.counts.agents}</b></span>
            {/if}
            {#if p.exists && totalCount(p.counts) === 0}
              <span class="count dim">no skills / commands / hooks / agents</span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if showDiscover}
    <section class="discover">
      <header>
        <h3>Discovered in <span class="mono">~/.claude/plugins/cache</span></h3>
        <button class="btn ghost" type="button" on:click={() => (showDiscover = false)}>
          Hide
        </button>
      </header>
      {#if $pluginsLoading}
        <div class="empty mono">Scanning…</div>
      {:else if $discovered.length === 0}
        <div class="empty mono">No plugins found.</div>
      {:else}
        <ul class="plugin-list compact">
          {#each $discovered as p (p.path)}
            <li class="plugin-row compact">
              <div class="plugin-head">
                <div class="plugin-id">
                  <span class="plugin-name">{p.name || "(unnamed)"}</span>
                  {#if p.version}
                    <span class="badge mono">v{p.version}</span>
                  {/if}
                </div>
                <div class="actions">
                  <button
                    class="btn primary"
                    type="button"
                    disabled={alreadyAdded(p.path)}
                    on:click={() => addPluginPath(p.path)}
                  >
                    {alreadyAdded(p.path) ? "Added" : "Add"}
                  </button>
                </div>
              </div>
              {#if p.description}
                <p class="plugin-desc">{p.description}</p>
              {/if}
              <div class="plugin-meta mono">
                <span class="path" title={p.path}>{shortPath(p.path)}</span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .plugins-manager {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .add-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .path-input {
    flex: 1;
    background: transparent;
    color: var(--fg);
    border: 0;
    border-bottom: 1px solid var(--border);
    padding: 6px 0;
    font: inherit;
    font-size: 16px;
  }
  .path-input:focus { outline: none; border-bottom-color: var(--accent); }
  .path-input.mono { font-family: var(--font-mono); }

  .btn {
    border-radius: var(--r-2);
    padding: 6px 12px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 15.5px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg-2);
    transition: color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
  }
  .btn:hover:not(:disabled) { color: var(--fg); border-color: var(--border-hi); }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn.primary {
    background: var(--accent);
    color: oklch(0.16 0.04 75);
    border-color: transparent;
    font-weight: 600;
  }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
  .btn.ghost.danger:hover { color: var(--danger); border-color: var(--danger); }

  .error {
    color: var(--danger);
    font-size: 15.5px;
    background: var(--elevated);
    border: 1px solid var(--danger);
    border-radius: var(--r-1);
    padding: 6px 10px;
  }
  .empty {
    color: var(--fg-3);
    font-size: 15.5px;
    padding: 12px 0;
    border-top: 1px dashed var(--border);
    border-bottom: 1px dashed var(--border);
  }
  .empty span {
    background: var(--elevated);
    padding: 1px 5px;
    border-radius: var(--r-1);
    font-family: var(--font-mono);
    font-size: 14.5px;
    color: var(--fg-2);
  }

  .plugin-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .plugin-list.compact { gap: 6px; }
  .plugin-row {
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 12px 14px;
    background: var(--elevated);
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: border-color var(--dur-1) var(--ease), opacity var(--dur-1) var(--ease);
  }
  .plugin-row:hover { border-color: var(--border-hi); }
  .plugin-row.missing { border-color: var(--danger); }
  .plugin-row.off { opacity: 0.55; }
  .plugin-row.compact { padding: 10px 12px; }

  .plugin-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .plugin-id { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .plugin-name {
    font-weight: 600;
    font-size: 17px;
    color: var(--fg);
    font-family: var(--font-display);
  }
  .actions { margin-left: auto; display: flex; gap: 6px; }

  .badge {
    font-size: 13.5px;
    background: var(--surface);
    color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 1px 6px;
    text-transform: lowercase;
    letter-spacing: 0.04em;
  }
  .badge.bad { color: var(--danger); border-color: var(--danger); }
  .badge.muted { color: var(--fg-3); }

  .plugin-desc {
    margin: 0;
    font-size: 16px;
    color: var(--fg-2);
    line-height: 1.45;
  }
  .plugin-meta { font-size: 14.5px; color: var(--fg-3); }
  .plugin-meta .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: inline-block;
    max-width: 100%;
  }

  .counts {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 14.5px;
  }
  .count {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 1px 6px;
    color: var(--fg-3);
  }
  .count b { color: var(--accent); font-weight: 600; }
  .count.dim { font-style: italic; }

  .discover {
    margin-top: 8px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .discover header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .discover h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--fg-2);
  }
  .discover h3 span { color: var(--fg-3); font-size: 14.5px; }
</style>
