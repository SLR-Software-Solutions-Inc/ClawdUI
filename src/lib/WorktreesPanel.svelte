<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import {
    worktrees,
    list,
    create,
    initRepo,
    dismissNonGit,
    type Worktree,
  } from "./worktrees";
  import { setWorkspace } from "./workspace";
  import { settings } from "./settings";
  import { ChevronDown, ChevronRight } from "./icons";

  const dispatch = createEventDispatcher<{
    toast: string;
    "pivot-cwd": { path: string; branch: string | null };
  }>();

  let collapsed = false;
  let creating = false;
  let formOpen = false;
  let branchInput = "";
  let baseInput = "main";
  let initing = false;

  async function onInit(): Promise<void> {
    if (initing) return;
    initing = true;
    try {
      await initRepo();
      dispatch("toast", "Initialized git repo");
    } catch (err) {
      dispatch(
        "toast",
        `git init failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      initing = false;
    }
  }

  function toggle(): void {
    collapsed = !collapsed;
    if (!collapsed) void list();
  }

  function isCurrent(p: string): boolean {
    return $settings.cwd === p;
  }

  async function onCreate(): Promise<void> {
    const branch = branchInput.trim();
    if (!branch) return;
    creating = true;
    try {
      const r = await create(branch, baseInput.trim() || "main");
      // Mirror the new worktree root into the workspace store + settings.cwd
      // so the topbar/sidebar reflect the pivot and a subsequent reload
      // re-opens the correct folder. Without this, only the SDK session sees
      // the new cwd (via App.svelte's pivot-cwd → newSession thread) and the
      // UI keeps pointing at the previous workspace.
      setWorkspace(r.path);
      dispatch("toast", `Switched to worktree ${r.branch} at ${r.path}`);
      dispatch("pivot-cwd", { path: r.path, branch: r.branch });
      branchInput = "";
      formOpen = false;
    } catch (err) {
      dispatch("toast", `worktree failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      creating = false;
    }
  }

  function onSwitch(w: Worktree): void {
    if (!w.path || isCurrent(w.path)) return;
    setWorkspace(w.path);
    dispatch("toast", `Switched to ${w.branch ?? w.path}`);
    dispatch("pivot-cwd", { path: w.path, branch: w.branch });
  }
</script>

<div class="block worktrees-panel">
  <div class="hdr">
    <button
      class="toggle"
      type="button"
      on:click={toggle}
      aria-expanded={!collapsed}
    >
      <span class="caret" aria-hidden="true">
        {#if collapsed}<ChevronRight size={12} stroke={1.7} />{:else}<ChevronDown size={12} stroke={1.7} />{/if}
      </span>
      <span class="eyebrow">WORKTREES</span>
      <span class="count mono">{$worktrees.items.length}</span>
    </button>
    <div class="hdr-actions">
      <button
        class="mini mono"
        type="button"
        title="Create worktree for this session"
        on:click={() => (formOpen = !formOpen)}
      >+</button>
      <button class="mini mono" type="button" on:click={() => void list()} title="Refresh"
        >↻</button>
    </div>
  </div>

  {#if !collapsed}
    {#if formOpen}
      <div class="form">
        <input
          class="ip mono"
          type="text"
          placeholder="branch (e.g. feat/my-thing)"
          bind:value={branchInput}
          disabled={creating}
        />
        <input
          class="ip mono"
          type="text"
          placeholder="base"
          bind:value={baseInput}
          disabled={creating}
        />
        <div class="form-actions">
          <button
            class="act"
            type="button"
            on:click={() => void onCreate()}
            disabled={creating || !branchInput.trim()}
          >{creating ? "creating…" : "create + switch"}</button>
          <button
            class="act ghost"
            type="button"
            on:click={() => (formOpen = false)}
            disabled={creating}
          >cancel</button>
        </div>
      </div>
    {/if}

    {#if $worktrees.loading}
      <div class="empty mono">loading…</div>
    {:else if $worktrees.nonGit && !$worktrees.dismissed}
      <div class="empty non-git">
        <div class="ng-title mono">Not a git repository</div>
        <div class="ng-sub mono">Worktrees only apply to git-tracked projects.</div>
        <div class="ng-actions">
          <button
            class="act primary"
            type="button"
            on:click={() => void onInit()}
            disabled={initing}
            title={`Runs "git init -b main" in ${$settings.cwd ?? ""}. No commits created.`}
          >{initing ? "initializing…" : "Initialize as git"}</button>
          <button
            class="act ghost"
            type="button"
            on:click={() => dismissNonGit()}
            disabled={initing}
          >dismiss</button>
        </div>
      </div>
    {:else if $worktrees.nonGit && $worktrees.dismissed}
      <!-- silenced -->
    {:else if $worktrees.error}
      <div class="empty error mono">{$worktrees.error}</div>
    {:else if $worktrees.items.length === 0}
      <div class="empty mono">no worktrees</div>
    {:else}
      <div class="list">
        {#each $worktrees.items as w (w.path)}
          <div class="row" class:current={isCurrent(w.path)}>
            <div class="row-head">
              <span class="branch mono" title={w.branch ?? "(detached)"}
                >{w.branch ?? "(detached)"}</span>
              {#if isCurrent(w.path)}
                <span class="badge mono">here</span>
              {/if}
            </div>
            <div class="path mono" title={w.path}>{w.path}</div>
            <div class="row-actions">
              <button
                class="act"
                type="button"
                disabled={isCurrent(w.path)}
                on:click={() => onSwitch(w)}
                title="Switch session cwd to this worktree"
              >switch</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .worktrees-panel { display: flex; flex-direction: column; gap: 8px; }
  .hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
  }
  .hdr-actions { display: flex; gap: 4px; }
  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 0;
    color: var(--fg-3);
    cursor: pointer;
    padding: 0;
    font: inherit;
  }
  .toggle:hover { color: var(--fg); }
  .toggle .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12.5px;
    color: var(--fg-4);
    font-family: var(--font-mono);
  }
  .toggle .caret { display: inline-flex; align-items: center; color: var(--fg-4); }
  .count {
    font-size: 13.5px;
    color: var(--fg-4);
    border: 1px solid var(--border);
    padding: 0 5px;
    border-radius: var(--r-1);
  }

  .mini {
    background: transparent;
    border: 1px solid transparent;
    color: var(--fg-3);
    border-radius: var(--r-1);
    padding: 1px 6px;
    font-size: 14.5px;
    cursor: pointer;
  }
  .mini:hover { background: var(--elevated); color: var(--fg); border-color: var(--border); }

  .form {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 4px;
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    background: var(--elevated);
    margin: 0 4px;
  }
  .ip {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--r-1);
    padding: 4px 6px;
    font-size: 14.5px;
  }
  .ip:focus { outline: 1px solid var(--accent-line); }
  .form-actions { display: flex; gap: 4px; }

  .empty {
    margin: 0 4px;
    padding: 8px 10px;
    font-size: 14.5px;
    color: var(--fg-4);
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: var(--r-2);
  }
  .empty.error { color: var(--danger); border-color: var(--danger); }
  .empty.non-git {
    text-align: left;
    padding: 10px 12px;
    border-style: solid;
    color: var(--fg-3);
  }
  .ng-title {
    font-size: 13.5px;
    color: var(--fg);
    margin-bottom: 2px;
  }
  .ng-sub {
    font-size: 12.5px;
    color: var(--fg-4);
    margin-bottom: 8px;
  }
  .ng-actions { display: flex; gap: 6px; }
  .act.primary {
    background: var(--accent-line);
    color: var(--bg);
    border-color: var(--accent-line);
  }
  .act.primary:hover:not(:disabled) {
    background: var(--accent);
    border-color: var(--accent);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 220px;
    overflow-y: auto;
    padding: 0 4px;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    background: var(--elevated);
  }
  .row.current { border-left: 2px solid var(--accent-line); }
  .row-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
  }
  .branch {
    font-size: 14.5px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
    min-width: 0;
  }
  .badge {
    font-size: 12.5px;
    color: var(--accent);
    border: 1px solid var(--accent-line);
    padding: 0 4px;
    border-radius: var(--r-1);
  }
  .path {
    font-size: 12.5px;
    color: var(--fg-4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-actions { display: flex; gap: 4px; padding-top: 2px; }

  .act {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-2);
    border-radius: var(--r-1);
    padding: 2px 7px;
    font: inherit;
    font-size: 13.5px;
    font-family: var(--font-mono);
    cursor: pointer;
  }
  .act:hover:not(:disabled) {
    background: var(--elevated);
    color: var(--fg);
    border-color: var(--border-hi);
  }
  .act:disabled { opacity: 0.4; cursor: default; }
  .act.ghost { color: var(--fg-4); }
</style>
