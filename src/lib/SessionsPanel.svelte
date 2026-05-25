<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import {
    sessions,
    refresh,
    resume,
    fork,
    deleteSession,
    exportMarkdown,
    exportJson,
    sessionBranch,
    type SessionSummary,
  } from "./sessions";
  import { fmtRelative, fmtUsd } from "./format";
  import { worktrees, create as createWorktree, list as listWorktrees } from "./worktrees";
  import { setWorkspace } from "./workspace";
  import { settings } from "./settings";
  import { ChevronDown, ChevronRight, GitBranch } from "./icons";

  const dispatch = createEventDispatcher<{
    "session-action": { kind: "resume" | "fork"; id: string };
    "open-review": { target: string; sessionId: string };
    "open-pr-picker": void;
    toast: string;
    "pivot-cwd": { path: string; branch: string | null };
  }>();

  let collapsed = false;
  let query = "";
  let openExportFor: string | null = null;
  let confirmDeleteFor: string | null = null;
  let reviewBusyFor: string | null = null;
  let openWorktreeFor: string | null = null;
  let wtMode: "" | "create" | "switch" = "";
  let wtBranchInput = "";
  let wtBaseInput = "main";
  let wtBusy = false;

  function toggle(): void {
    collapsed = !collapsed;
    if (!collapsed) void refresh();
  }

  function modelAlias(model: string | undefined): string {
    if (!model) return "—";
    // Strip provider prefix like "claude-" and date suffix.
    const m = model.match(/^(?:claude-)?([a-z0-9]+(?:-[a-z0-9]+)*?)(?:-\d{8})?$/i);
    return m?.[1] ?? model;
  }

  function filtered(list: SessionSummary[], q: string): SessionSummary[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (s) =>
        s.title.toLowerCase().includes(needle) ||
        s.firstMessage.toLowerCase().includes(needle) ||
        (s.customName ?? "").toLowerCase().includes(needle) ||
        (s.firstUserPrompt ?? "").toLowerCase().includes(needle) ||
        (s.cwdTail ?? "").toLowerCase().includes(needle),
    );
  }

  function primaryLabel(s: SessionSummary): string {
    return s.customName || s.firstUserPrompt || "<no prompt yet>";
  }

  function fmtAbsTime(ms: number): string {
    try {
      return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
    } catch {
      return "";
    }
  }

  function tooltipFor(s: SessionSummary): string {
    const parts = [
      `id: ${s.id}`,
      s.cwd ? `cwd: ${s.cwd}` : null,
      `time: ${fmtAbsTime(s.mtime)}`,
      s.firstMessage ? `first: ${s.firstMessage}` : null,
    ].filter(Boolean) as string[];
    return parts.join("\n");
  }

  async function onResume(s: SessionSummary): Promise<void> {
    resume(s.id);
    dispatch("session-action", { kind: "resume", id: s.id });
  }

  async function onFork(s: SessionSummary): Promise<void> {
    fork(s.id);
    dispatch("session-action", { kind: "fork", id: s.id });
  }

  async function onDelete(s: SessionSummary): Promise<void> {
    if (confirmDeleteFor !== s.id) {
      confirmDeleteFor = s.id;
      return;
    }
    try {
      await deleteSession(s.id);
      dispatch("toast", `Session ${s.id.slice(0, 8)} moved to .trash/`);
    } catch (err) {
      dispatch("toast", `delete failed: ${err}`);
    } finally {
      confirmDeleteFor = null;
    }
  }

  async function onReview(s: SessionSummary): Promise<void> {
    if (reviewBusyFor) return;
    reviewBusyFor = s.id;
    try {
      const branch = await sessionBranch(s);
      if (!branch) {
        dispatch("toast", "could not resolve branch for session");
        return;
      }
      dispatch("open-review", { target: branch, sessionId: s.id });
    } catch (err) {
      dispatch("toast", `review failed: ${err}`);
    } finally {
      reviewBusyFor = null;
    }
  }

  async function onExport(s: SessionSummary, kind: "md" | "json"): Promise<void> {
    openExportFor = null;
    try {
      const target =
        kind === "md" ? await exportMarkdown(s.id) : await exportJson(s.id);
      dispatch("toast", `exported → ${target}`);
    } catch (err) {
      dispatch("toast", `export failed: ${err}`);
    }
  }

  function openWorktreeMenu(s: SessionSummary): void {
    if (openWorktreeFor === s.id) {
      openWorktreeFor = null;
      wtMode = "";
      return;
    }
    openWorktreeFor = s.id;
    wtMode = "";
    wtBranchInput = "";
    wtBaseInput = "main";
    void listWorktrees();
  }

  async function onCreateWorktree(s: SessionSummary): Promise<void> {
    const branch = wtBranchInput.trim();
    if (!branch) return;
    wtBusy = true;
    try {
      const r = await createWorktree(branch, wtBaseInput.trim() || "main");
      // Mirror new worktree root into workspace store + settings.cwd. The
      // parent's pivot-cwd handler also threads the path into newSession()
      // for race-free SDK boot; this call keeps the UI surfaces in sync.
      setWorkspace(r.path);
      // Re-resume this session in the new cwd: settings already has resume
      // configured if the user clicked resume previously; here we just set
      // resume to this session id and pivot. The parent will call newSession.
      resume(s.id);
      dispatch("toast", `Switched to worktree ${r.branch} at ${r.path}`);
      dispatch("pivot-cwd", { path: r.path, branch: r.branch });
      openWorktreeFor = null;
      wtMode = "";
    } catch (err) {
      dispatch("toast", `worktree failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      wtBusy = false;
    }
  }

  function onSwitchToWorktree(s: SessionSummary, path: string, branch: string | null): void {
    setWorkspace(path);
    resume(s.id);
    dispatch("toast", `Switched to ${branch ?? path}`);
    dispatch("pivot-cwd", { path, branch });
    openWorktreeFor = null;
    wtMode = "";
  }
</script>

<div class="block sessions-panel">
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
      <span class="eyebrow">SESSIONS</span>
      <span class="count mono">{$sessions.sessions.length}</span>
    </button>
    <div class="hdr-actions">
      <button
        class="from-pr mono"
        type="button"
        on:click={() => dispatch("open-pr-picker")}
        title="Start a session pre-loaded with PR context"
      >From PR</button>
      <button class="refresh mono" type="button" on:click={() => void refresh()} title="Refresh">
        ↻
      </button>
    </div>
  </div>

  {#if !collapsed}
    <input
      class="search mono"
      type="search"
      placeholder="search…"
      bind:value={query}
    />

    {#if $sessions.loading}
      <div class="empty mono">loading…</div>
    {:else if $sessions.error}
      <div class="empty error mono">{$sessions.error}</div>
    {:else if $sessions.sessions.length === 0}
      <div class="empty mono">no sessions in cwd</div>
    {:else}
      <div class="list">
        {#each filtered($sessions.sessions, query) as s (s.id)}
          <div class="row">
            <div class="row-head">
              <span class="title" title={tooltipFor(s)}>{primaryLabel(s)}</span>
              <span class="when mono" title={fmtAbsTime(s.mtime)}>{fmtRelative(s.mtime)}</span>
            </div>
            <div class="row-meta mono">
              {#if s.cwdTail}
                <span class="cwd-tail" title={s.cwd ?? ""}>{s.cwdTail}</span>
              {/if}
              <span>{s.messageCount} msg</span>
              <span>{fmtUsd(s.totalCostUsd)}</span>
              <span title={s.model ?? ""}>{modelAlias(s.model)}</span>
            </div>
            <div class="row-actions">
              <button
                class="act"
                type="button"
                on:click={() => void onResume(s)}
                title="Resume this session on next New Session"
              >resume</button>
              <button
                class="act"
                type="button"
                on:click={() => void onFork(s)}
                title="Fork — branches a new session id"
              >fork</button>
              <button
                class="act"
                type="button"
                disabled={reviewBusyFor === s.id}
                on:click={() => void onReview(s)}
                title="Open Ultrareview prefilled with this session's branch (BILLED on run)"
              >{reviewBusyFor === s.id ? "…" : "review"}</button>
              <div class="exp">
                <button
                  class="act"
                  type="button"
                  on:click={() =>
                    (openExportFor = openExportFor === s.id ? null : s.id)}
                ><span class="act-row">export <ChevronDown size={11} stroke={1.7} /></span></button>
                {#if openExportFor === s.id}
                  <div class="menu">
                    <button type="button" on:click={() => void onExport(s, "md")}
                      >Markdown</button>
                    <button type="button" on:click={() => void onExport(s, "json")}
                      >JSON</button>
                  </div>
                {/if}
              </div>
              <div class="exp">
                <button
                  class="act"
                  type="button"
                  title="Create worktree or switch session cwd"
                  on:click={() => openWorktreeMenu(s)}
                ><span class="act-row"><GitBranch size={12} stroke={1.7} /> <ChevronDown size={11} stroke={1.7} /></span></button>
                {#if openWorktreeFor === s.id}
                  <div class="menu wt-menu">
                    {#if wtMode === ""}
                      <button type="button" on:click={() => (wtMode = "create")}
                        >Create worktree for this branch</button>
                      <button type="button" on:click={() => (wtMode = "switch")}
                        >Switch to existing worktree…</button>
                    {:else if wtMode === "create"}
                      <div class="wt-form">
                        <input
                          class="ip mono"
                          type="text"
                          placeholder="branch (e.g. feat/x)"
                          bind:value={wtBranchInput}
                          disabled={wtBusy}
                        />
                        <input
                          class="ip mono"
                          type="text"
                          placeholder="base"
                          bind:value={wtBaseInput}
                          disabled={wtBusy}
                        />
                        <div class="wt-form-actions">
                          <button
                            type="button"
                            on:click={() => void onCreateWorktree(s)}
                            disabled={wtBusy || !wtBranchInput.trim()}
                          >{wtBusy ? "creating…" : "create + switch"}</button>
                          <button
                            type="button"
                            on:click={() => (wtMode = "")}
                            disabled={wtBusy}
                          >back</button>
                        </div>
                      </div>
                    {:else if wtMode === "switch"}
                      {#if $worktrees.items.length === 0}
                        <div class="wt-empty mono">no worktrees</div>
                      {:else}
                        {#each $worktrees.items as w (w.path)}
                          <button
                            type="button"
                            class="wt-row"
                            disabled={$settings.cwd === w.path}
                            on:click={() => onSwitchToWorktree(s, w.path, w.branch)}
                          >
                            <span class="wt-branch mono"
                              >{w.branch ?? "(detached)"}{$settings.cwd === w.path ? " · here" : ""}</span>
                            <span class="wt-path mono">{w.path}</span>
                          </button>
                        {/each}
                      {/if}
                      <button type="button" on:click={() => (wtMode = "")}>back</button>
                    {/if}
                  </div>
                {/if}
              </div>
              <button
                class="act danger"
                class:confirm={confirmDeleteFor === s.id}
                type="button"
                on:click={() => void onDelete(s)}
                on:blur={() => (confirmDeleteFor = null)}
              >{confirmDeleteFor === s.id ? "confirm?" : "del"}</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .act-row { display: inline-flex; align-items: center; gap: 4px; }
  .caret { display: inline-flex; align-items: center; }
  .sessions-panel { display: flex; flex-direction: column; gap: 8px; }
  .hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
  }
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
  .toggle .caret { font-size: 13.5px; color: var(--fg-4); }
  .count {
    font-size: 13.5px;
    color: var(--fg-4);
    border: 1px solid var(--border);
    padding: 0 5px;
    border-radius: var(--r-1);
  }
  .hdr-actions { display: flex; align-items: center; gap: 4px; }
  .refresh {
    background: transparent;
    border: 1px solid transparent;
    color: var(--fg-3);
    border-radius: var(--r-1);
    padding: 2px 6px;
    font-size: 14.5px;
    cursor: pointer;
  }
  .refresh:hover { background: var(--elevated); color: var(--fg); }
  .from-pr {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-2);
    border-radius: var(--r-1);
    padding: 2px 7px;
    font-size: 13.5px;
    cursor: pointer;
  }
  .from-pr:hover {
    background: var(--elevated);
    color: var(--fg);
    border-color: var(--accent-line);
  }

  .search {
    margin: 0 4px;
    padding: 5px 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--r-1);
    font-size: 14.5px;
  }
  .search:focus { outline: 1px solid var(--accent-line); }

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

  .list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 4px;
    /* No inner scroll — SidePane already scrolls. Inner overflow:auto here
       would clip the position:absolute export / worktree menus. */
    overflow: visible;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 7px 8px;
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    background: var(--elevated);
    transition: border-color var(--dur-1) var(--ease);
  }
  .row:hover { border-color: var(--accent-line); }

  .row-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 6px;
  }
  .title {
    color: var(--fg);
    font-size: 15px;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
    min-width: 0;
  }
  .when { font-size: 13.5px; color: var(--fg-4); flex-shrink: 0; }

  .row-meta {
    display: flex;
    gap: 8px;
    font-size: 13.5px;
    color: var(--fg-3);
  }
  .row-meta span { white-space: nowrap; }
  .row-meta .cwd-tail {
    color: var(--fg-2);
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
  }

  .row-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    padding-top: 2px;
    opacity: 0.55;
    transition: opacity var(--dur-1) var(--ease);
  }
  .row:hover .row-actions { opacity: 1; }

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
  .act:hover { background: var(--elevated); color: var(--fg); border-color: var(--border-hi); }
  .act.danger { color: var(--danger); }
  .act.danger.confirm {
    background: var(--danger);
    color: var(--bg);
    border-color: var(--danger);
  }

  .exp { position: relative; }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    min-width: 140px;
    background: var(--elevated);
    color: var(--fg);
    border: 1px solid var(--accent-line);
    border-radius: var(--r-2);
    overflow: hidden;
    box-shadow: var(--shadow-lg);
  }
  .menu button {
    background: transparent;
    border: 0;
    color: var(--fg);
    padding: 8px 14px;
    text-align: left;
    font: inherit;
    font-size: 14.5px;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }
  .menu button:last-child { border-bottom: none; }
  .menu button:hover { background: var(--accent-soft); color: var(--fg); }

  .wt-menu { min-width: 220px; max-width: 280px; }
  .wt-form { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; }
  .wt-form-actions { display: flex; gap: 4px; }
  .wt-form-actions button {
    padding: 3px 6px;
    font-size: 13.5px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
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
  .wt-row {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 5px 10px;
    text-align: left;
    border-bottom: 1px solid var(--line);
  }
  .wt-row:disabled { opacity: 0.5; }
  .wt-branch { font-size: 14.5px; color: var(--fg); }
  .wt-path {
    font-size: 12.5px;
    color: var(--fg-4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wt-empty {
    padding: 8px 10px;
    font-size: 14.5px;
    color: var(--fg-4);
    text-align: center;
  }
</style>
