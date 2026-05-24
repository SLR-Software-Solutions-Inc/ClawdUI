<!--
  InlinePermissionCard — renders the Allow / Deny ask directly under the
  tool_use block that triggered it, instead of a full-screen modal.

  Props:
    toolUseId — the tool_use block's id; we look for a queued permission
                request matching this id and render only when one exists.

  When `permissionMode === "bypassPermissions"` we render nothing here so
  PermissionPrompt's modal can take the foreground (those requests are
  intentionally disruptive).
-->
<script lang="ts">
  import {
    permissions,
    type PermissionDecision,
  } from "./permissions.svelte";
  import { settings } from "./settings";

  export let toolUseId: string;

  // Permissions store is a tagged-state class — read via .queue. Reactive
  // re-evaluates every store update.
  $: queue = permissions.queue;
  $: req = queue.find((r) => r.tool_use_id === toolUseId);
  $: bypassMode = $settings.permissionMode === "bypassPermissions";

  function decide(decision: PermissionDecision) {
    if (!req) return;
    permissions.resolve(req.request_id, decision);
  }
</script>

{#if req && !bypassMode}
  <div class="ipc mono" role="alertdialog" aria-label={`Permission required for ${req.tool_name}`}>
    <div class="ipc-head">
      <span class="ipc-eyebrow">PERMISSION ASK</span>
      <span class="ipc-tool">{req.tool_name}</span>
    </div>
    {#if req.title}
      <p class="ipc-title">{req.title}</p>
    {/if}
    {#if req.description}
      <p class="ipc-desc">{req.description}</p>
    {/if}
    {#if req.blocked_path}
      <p class="ipc-path">{req.blocked_path}</p>
    {/if}
    <div class="ipc-actions">
      <button
        type="button"
        class="ipc-btn allow"
        on:click={() => decide({ behavior: "allow" })}
        title="Allow this single call"
      >Allow once</button>
      <button
        type="button"
        class="ipc-btn allow-session"
        on:click={() => decide({ behavior: "allow", remember: "session" })}
        title="Allow this exact call for the rest of the session"
      >Allow for session</button>
      <button
        type="button"
        class="ipc-btn deny"
        on:click={() => decide({ behavior: "deny", message: "denied by user" })}
        title="Deny and tell the agent why"
      >Deny</button>
    </div>
  </div>
{/if}

<style>
  .ipc {
    margin: 6px 0 8px;
    padding: 10px 12px;
    border: 1px solid var(--warning);
    background: color-mix(in oklch, var(--warning) 8%, var(--surface));
    border-radius: var(--r-2);
    box-shadow: var(--shadow-sm);
    font-size: 12.5px;
    color: var(--fg);
  }
  .ipc-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .ipc-eyebrow {
    font-size: 10.5px;
    letter-spacing: 0.12em;
    color: var(--warning);
  }
  .ipc-tool {
    font-size: 11px;
    color: var(--fg-3);
  }
  .ipc-title { margin: 0 0 4px; font-size: 13.5px; color: var(--fg); font-family: var(--font-display); }
  .ipc-desc { margin: 0 0 4px; font-size: 12.5px; color: var(--fg-2); line-height: 1.45; }
  .ipc-path { margin: 0 0 6px; font-size: 12px; color: var(--fg-3); word-break: break-all; }
  .ipc-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .ipc-btn {
    background: transparent;
    border: 1px solid var(--border-hi);
    border-radius: 999px;
    color: var(--fg);
    padding: 4px 12px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .ipc-btn:hover { border-color: var(--accent); }
  .ipc-btn.allow { border-color: var(--success); color: var(--success); }
  .ipc-btn.allow:hover { background: var(--success); color: var(--bg); }
  .ipc-btn.allow-session { border-color: var(--accent); color: var(--accent); }
  .ipc-btn.allow-session:hover { background: var(--accent); color: var(--bg); }
  .ipc-btn.deny { border-color: var(--danger); color: var(--danger); }
  .ipc-btn.deny:hover { background: var(--danger); color: var(--bg); }
</style>
