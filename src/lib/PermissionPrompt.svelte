<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy, tick } from "svelte";
  import {
    permissions,
    findPrimaryStringField,
    suggestPrefix,
    type PermissionDecision,
    type PermissionRequest,
    type PermanentAllowMatchType,
  } from "./permissions.svelte";
  import { settings } from "./settings";
  import {
    getDrawerOpen,
    getDrawerActiveId,
  } from "./agents.svelte";

  const dispatch = createEventDispatcher<{
    decision: { request_id: string; decision: PermissionDecision };
  }>();

  // Modal only fronts requests that can't (or shouldn't) be answered inline:
  //  - bypassPermissions mode is dangerous, the user must see it loud
  //    (no tool_use anchoring in bypass mode at all).
  //  - tool_use_id missing → no chat anchor to attach the inline card to.
  //  - request belongs to a non-master child session AND that child's
  //    drawer view isn't currently visible — the inline card under the
  //    child's tool_use block is unreachable, fall back to modal.
  // Everything else (the common master-session case with a visible inline
  // card) flows through InlinePermissionCard under the offending tool_use
  // block in the transcript — no modal, no 2s timer.
  let bypassMode = $derived($settings.permissionMode === "bypassPermissions");

  // Visible-for(sessionId): the drawer is open AND it's currently showing
  // (or auto-selecting) the child whose session matches.
  function isDrawerVisibleFor(sessionId: string): boolean {
    if (!getDrawerOpen()) return false;
    const active = getDrawerActiveId();
    // active === null → AgentDrawer auto-selects the most recent child.
    // Treat null-active as visible: App.svelte sets it to null just
    // before opening the drawer in response to a child request.
    return active === null || active === sessionId;
  }

  // Modal-only fallback: the request has a tool_use_id but the inline
  // anchor under that tool_use block is unreachable. Today the only way
  // an anchor is unreachable is: a child-session request where the
  // drawer is open on a *different* child. The master case never trips
  // this — App.svelte leaves the drawer closed for master requests and
  // the inline card lives in the chat transcript.
  function inlineUnreachable(r: PermissionRequest): boolean {
    if (!r.session_id) return false;
    if (!getDrawerOpen()) return false; // drawer closed → master inline anchor visible
    return !isDrawerVisibleFor(r.session_id);
  }

  let head: PermissionRequest | null = $derived(
    permissions.queue.find(
      (r) =>
        bypassMode
        || !r.tool_use_id
        || inlineUnreachable(r),
    ) ?? null,
  );

  let denyReason = $state("");
  let showDenyReason = $state(false);
  let showPersistPanel = $state(false);
  let persistChoice = $state<PermanentAllowMatchType>("exact");
  let prefixInput = $state("");
  let allowBtn: HTMLButtonElement | null = $state(null);

  // Modal disabled when the user has flipped the global switch into a mode
  // that already auto-allows. Tier-3 entries are scoped to "default" mode.
  let modeIsDefault = $derived($settings.permissionMode === "default");

  // When the head request changes, recompute the inferred prefix so the
  // editable text-input has a sane default the user can shorten or extend.
  let primary = $derived(
    head ? findPrimaryStringField(head.tool_name, head.input) : null,
  );
  let canUsePrefix = $derived(primary != null);

  $effect(() => {
    // Reset persist panel + suggested prefix whenever the head changes.
    if (head) {
      showPersistPanel = false;
      persistChoice = "exact";
      prefixInput = primary ? suggestPrefix(head.tool_name, primary) : "";
    }
  });

  function safeJson(v: unknown): string {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  function decide(decision: PermissionDecision) {
    if (!head) return;
    const id = head.request_id;
    // permissions.resolve() now invokes the registered responder, which sends
    // the sidecar response. We keep the dispatch for any external listener
    // (none in App.svelte today, but kept for API stability) but route the
    // sidecar response through the store responder only.
    permissions.resolve(id, decision);
    dispatch("decision", { request_id: id, decision });
    denyReason = "";
    showDenyReason = false;
    showPersistPanel = false;
  }

  function confirmPersist() {
    if (!head) return;
    const matchType = persistChoice;
    const pattern =
      matchType === "exact"
        ? "" // resolve() will re-derive
        : matchType === "any"
          ? "*"
          : prefixInput.trim();

    if ((matchType === "prefix" || matchType === "glob") && !pattern) {
      // refuse to persist an empty rule – fall back to plain allow
      decide({ behavior: "allow" });
      return;
    }

    decide({
      behavior: "allow",
      remember: "persist",
      persistMatch: matchType,
      persistPattern: pattern,
    });
  }

  function onKey(e: KeyboardEvent) {
    if (!head) return;
    if (e.key === "Enter" && !e.shiftKey && !showDenyReason && !showPersistPanel) {
      e.preventDefault();
      decide({ behavior: "allow" });
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (showPersistPanel) {
        showPersistPanel = false;
        return;
      }
      decide({ behavior: "deny", message: "denied by user" });
    }
  }

  $effect(() => {
    if (head) {
      void tick().then(() => allowBtn?.focus());
    }
  });

  onMount(() => {
    window.addEventListener("keydown", onKey);
  });
  onDestroy(() => {
    window.removeEventListener("keydown", onKey);
  });
</script>

{#if head}
  <div class="scrim" aria-hidden="true"></div>
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="perm-title">
    <header class="head">
      <span class="eyebrow">PERMISSION REQUEST</span>
      <h2 id="perm-title">
        {head.title ?? `Allow ${head.tool_name}?`}
      </h2>
      {#if head.description}
        <p class="desc">{head.description}</p>
      {/if}
      {#if head.blocked_path}
        <p class="path mono">{head.blocked_path}</p>
      {/if}
    </header>

    <section class="body">
      <div class="meta mono">
        <span class="lbl">tool</span>
        <span class="val">{head.tool_name}</span>
      </div>
      <details class="json" open>
        <summary><span class="block-tag mono">INPUT</span></summary>
        <pre class="mono">{safeJson(head.input)}</pre>
      </details>

      {#if showPersistPanel && modeIsDefault}
        <fieldset class="persist mono">
          <legend>Persist this allow rule</legend>
          <label class="opt">
            <input type="radio" bind:group={persistChoice} value="exact" />
            <span class="opt-label">EXACT</span>
            <span class="opt-help">only this exact tool + input</span>
          </label>
          <label class="opt" class:disabled={!canUsePrefix}>
            <input
              type="radio"
              bind:group={persistChoice}
              value="prefix"
              disabled={!canUsePrefix}
            />
            <span class="opt-label">PREFIX</span>
            <span class="opt-help">
              same tool, primary field starts with…
            </span>
          </label>
          {#if persistChoice === "prefix"}
            <input
              class="prefix mono"
              type="text"
              bind:value={prefixInput}
              placeholder="/Users/<you>/dev/"
              spellcheck="false"
            />
          {/if}
          <label class="opt" class:disabled={!canUsePrefix}>
            <input
              type="radio"
              bind:group={persistChoice}
              value="glob"
              disabled={!canUsePrefix}
            />
            <span class="opt-label">GLOB</span>
            <span class="opt-help">e.g. /Users/<you>/dev/**</span>
          </label>
          {#if persistChoice === "glob"}
            <input
              class="prefix mono"
              type="text"
              bind:value={prefixInput}
              placeholder="/Users/<you>/dev/**"
              spellcheck="false"
            />
          {/if}
          <label class="opt">
            <input type="radio" bind:group={persistChoice} value="any" />
            <span class="opt-label">ANY</span>
            <span class="opt-help">same tool, any input (broadest)</span>
          </label>
          <div class="persist-actions">
            <button
              class="btn"
              type="button"
              onclick={() => (showPersistPanel = false)}
            >
              Cancel
            </button>
            <button
              class="btn allow"
              type="button"
              onclick={confirmPersist}
            >
              Allow & remember
            </button>
          </div>
        </fieldset>
      {/if}

      {#if showDenyReason}
        <label class="reason">
          <span class="lbl mono">deny reason (sent to agent)</span>
          <textarea
            class="mono"
            bind:value={denyReason}
            placeholder="explain why this is being denied…"
            rows="3"
          ></textarea>
        </label>
      {/if}

      {#if permissions.queue.length > 1}
        <div class="more mono">
          + {permissions.queue.length - 1} more queued
        </div>
      {/if}
    </section>

    <footer class="foot">
      <button
        bind:this={allowBtn}
        class="btn allow"
        type="button"
        onclick={() => decide({ behavior: "allow" })}
      >
        Allow
        <span class="kbd mono">↵</span>
      </button>
      <button
        class="btn allow-always"
        type="button"
        title="Allow this exact call again this session without prompting"
        onclick={() => decide({ behavior: "allow", remember: "session" })}
      >
        Allow always (session)
      </button>
      {#if modeIsDefault}
        <button
          class="btn allow-persist"
          type="button"
          title="Persist this rule across launches (Settings → Permissions)"
          onclick={() => (showPersistPanel = !showPersistPanel)}
        >
          Allow forever…
        </button>
      {/if}
      {#if !showDenyReason}
        <button
          class="btn deny-reason"
          type="button"
          onclick={() => (showDenyReason = true)}
        >
          Deny + reason
        </button>
      {:else}
        <button
          class="btn deny-reason primary"
          type="button"
          onclick={() =>
            decide({
              behavior: "deny",
              message: denyReason.trim() || "denied by user",
            })}
        >
          Send deny
        </button>
      {/if}
      <button
        class="btn deny"
        type="button"
        onclick={() => decide({ behavior: "deny", message: "denied by user" })}
      >
        Deny
        <span class="kbd mono">esc</span>
      </button>
    </footer>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: oklch(0 0 0 / 0.55);
    backdrop-filter: blur(4px);
    z-index: 70;
    animation: slide-up var(--dur-2) var(--ease);
  }
  .panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, 92vw);
    max-height: min(80vh, 720px);
    background: var(--surface);
    border: 1px solid var(--border-hi);
    border-radius: var(--r-3, 10px);
    box-shadow: var(--shadow-lg);
    display: grid;
    grid-template-rows: auto 1fr auto;
    z-index: 71;
    animation: slide-up var(--dur-2) var(--ease);
    overflow: hidden;
  }
  .head {
    padding: 18px 22px 12px;
    border-bottom: 1px solid var(--border);
  }
  .head .eyebrow {
    font-family: var(--font-mono);
    font-size: 13.5px;
    letter-spacing: 0.18em;
    color: var(--accent);
    text-transform: uppercase;
  }
  .head h2 {
    margin: 4px 0 0;
    font-family: var(--font-display);
    font-size: 19.5px;
    font-weight: 600;
    color: var(--fg);
    letter-spacing: -0.01em;
  }
  .head .desc {
    margin: 6px 0 0;
    color: var(--fg-3);
    font-size: 16px;
  }
  .head .path {
    margin: 6px 0 0;
    color: var(--warning);
    font-size: 15.5px;
    word-break: break-all;
  }

  .body {
    overflow-y: auto;
    padding: 14px 22px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 15.5px;
  }
  .meta .lbl {
    color: var(--fg-4);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 13.5px;
  }
  .meta .val {
    color: var(--fg);
    font-weight: 600;
  }
  .json {
    border: 1px solid var(--border);
    border-radius: var(--r-2, 6px);
    background: var(--bg);
  }
  .json summary {
    cursor: pointer;
    padding: 6px 10px;
    color: var(--fg-3);
    list-style: none;
  }
  .json summary::-webkit-details-marker { display: none; }
  .json .block-tag {
    font-size: 13.5px;
    letter-spacing: 0.16em;
    color: var(--fg-3);
  }
  .json pre {
    margin: 0;
    padding: 10px 12px;
    border-top: 1px solid var(--border);
    font-size: 15.5px;
    color: var(--fg-2);
    max-height: 260px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .reason { display: flex; flex-direction: column; gap: 6px; }
  .reason .lbl {
    color: var(--fg-4);
    font-size: 13.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .reason textarea {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--r-2, 6px);
    padding: 8px 10px;
    font-size: 16px;
    resize: vertical;
  }
  .reason textarea:focus {
    outline: none;
    border-color: var(--accent-line);
  }
  .more {
    color: var(--fg-3);
    font-size: 14.5px;
  }

  .persist {
    border: 1px solid var(--accent-line);
    border-radius: var(--r-2, 6px);
    background: var(--accent-soft);
    padding: 10px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 14.5px;
  }
  .persist legend {
    color: var(--accent);
    font-size: 13px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 0 4px;
  }
  .persist .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--fg-2);
    cursor: pointer;
  }
  .persist .opt.disabled { opacity: 0.45; cursor: not-allowed; }
  .persist .opt-label {
    font-weight: 600;
    color: var(--fg);
    min-width: 60px;
  }
  .persist .opt-help { color: var(--fg-3); font-size: 13.5px; }
  .persist input.prefix {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--r-1, 4px);
    padding: 5px 8px;
    margin-left: 28px;
    font-size: 14.5px;
  }
  .persist input.prefix:focus {
    outline: none;
    border-color: var(--accent-line);
  }
  .persist-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
    justify-content: flex-end;
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 22px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  .btn {
    font-family: inherit;
    font-size: 16px;
    padding: 8px 14px;
    border-radius: var(--r-2, 6px);
    border: 1px solid var(--border-hi);
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .btn:hover { border-color: var(--fg-3); }
  .btn:focus-visible {
    outline: none;
    border-color: var(--accent-line);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .btn .kbd {
    font-size: 13.5px;
    color: var(--fg-4);
    border: 1px solid var(--border);
    padding: 0 5px;
    border-radius: 4px;
  }
  .btn.allow {
    background: var(--accent-soft);
    border-color: var(--accent-line);
    color: var(--fg);
  }
  .btn.allow:hover { background: var(--accent-soft); border-color: var(--accent); }
  .btn.allow-always { color: var(--fg-2); }
  .btn.allow-persist { color: var(--fg-2); }
  .btn.deny { color: var(--danger); border-color: var(--danger); }
  .btn.deny:hover { background: color-mix(in oklab, var(--danger) 12%, transparent); }
  .btn.deny-reason { color: var(--fg-2); }
  .btn.deny-reason.primary {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
