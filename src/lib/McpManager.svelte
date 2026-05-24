<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { type UnlistenFn } from "@tauri-apps/api/event";
  import { safeInvoke, safeListen } from "./safeInvoke";
  import { onMount, onDestroy } from "svelte";
  import { settings, patchSettings } from "./settings";
  import { X, Check } from "./icons";

  export let open = false;
  export let embedded = false;

  type Transport = "stdio" | "http" | "sse";
  type StdioCfg = {
    type?: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
  type HttpCfg = { type: "http"; url: string; headers?: Record<string, string> };
  type SseCfg = { type: "sse"; url: string; headers?: Record<string, string> };
  type ServerCfg = StdioCfg | HttpCfg | SseCfg;
  type ServersMap = Record<string, ServerCfg>;

  type TestResult =
    | { state: "idle" }
    | { state: "running" }
    | { state: "ok"; tools: { name: string; description?: string }[] }
    | { state: "error"; error: string };

  const dispatch = createEventDispatcher<{ close: void; "edit-raw": void }>();

  let servers: ServersMap = {};
  let selected: string | null = null;
  let showRawJson = false;
  let rawJsonDraft = "";
  let rawJsonErr = "";
  let testResults: Record<string, TestResult> = {};
  let addingTransport: Transport | null = null;
  let newName = "";
  let unlistenEvent: UnlistenFn | null = null;
  let pendingTests = new Map<string, string>(); // rpc id → server name

  // ------------ load / save bridge -----------------------------------------
  $: parseServersFrom($settings.mcpServersJson);

  function parseServersFrom(json: string) {
    try {
      const parsed = JSON.parse(json || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Only update if changed (avoid input flicker while typing).
        const incoming = parsed as ServersMap;
        if (JSON.stringify(incoming) !== JSON.stringify(servers)) {
          servers = incoming;
          if (selected && !(selected in servers)) selected = null;
          if (!selected) {
            const keys = Object.keys(servers);
            if (keys.length) selected = keys[0];
          }
        }
      }
    } catch {
      /* leave servers as-is when raw JSON is mid-edit */
    }
  }

  function persist() {
    patchSettings({ mcpServersJson: JSON.stringify(servers, null, 2) });
  }

  function transportOf(cfg: ServerCfg): Transport {
    if ("type" in cfg && (cfg.type === "http" || cfg.type === "sse")) return cfg.type;
    return "stdio";
  }

  // ------------ secrets masking -------------------------------------------
  const SECRET_RE = /(_TOKEN|_KEY|_SECRET|_PASSWORD)$/i;
  function isSecret(name: string): boolean {
    return SECRET_RE.test(name);
  }

  // ------------ CRUD ------------------------------------------------------
  function addServer() {
    const name = (newName || "").trim();
    if (!name) return;
    if (name in servers) {
      alert(`Server "${name}" already exists`);
      return;
    }
    let cfg: ServerCfg;
    if (addingTransport === "http") {
      cfg = { type: "http", url: "" };
    } else if (addingTransport === "sse") {
      cfg = { type: "sse", url: "" };
    } else {
      cfg = { command: "", args: [] };
    }
    servers = { ...servers, [name]: cfg };
    selected = name;
    addingTransport = null;
    newName = "";
    persist();
  }

  function deleteServer(name: string) {
    if (!confirm(`Delete server "${name}"?`)) return;
    const { [name]: _gone, ...rest } = servers;
    servers = rest;
    if (selected === name) {
      const keys = Object.keys(servers);
      selected = keys[0] ?? null;
    }
    persist();
  }

  function duplicateServer(name: string) {
    let copy = `${name}-copy`;
    let i = 2;
    while (copy in servers) copy = `${name}-copy${i++}`;
    servers = { ...servers, [copy]: structuredClone(servers[name]) };
    selected = copy;
    persist();
  }

  function renameServer(oldName: string) {
    const next = prompt(`Rename "${oldName}" to:`, oldName)?.trim();
    if (!next || next === oldName) return;
    if (next in servers) {
      alert(`"${next}" already exists`);
      return;
    }
    const entries = Object.entries(servers).map(([k, v]) =>
      k === oldName ? [next, v] as const : [k, v] as const,
    );
    servers = Object.fromEntries(entries);
    selected = next;
    persist();
  }

  // ------------ field updaters -------------------------------------------
  function updateSelected(mut: (cfg: ServerCfg) => ServerCfg) {
    if (!selected) return;
    const next = mut(structuredClone(servers[selected]));
    servers = { ...servers, [selected]: next };
    persist();
  }

  function setEnvKey(oldKey: string, newKey: string) {
    if (!selected) return;
    updateSelected((cfg) => {
      if (transportOf(cfg) !== "stdio") return cfg;
      const stdio = cfg as StdioCfg;
      const env = { ...(stdio.env ?? {}) };
      const v = env[oldKey] ?? "";
      delete env[oldKey];
      env[newKey] = v;
      stdio.env = env;
      return stdio;
    });
  }

  function setEnvValue(key: string, value: string) {
    updateSelected((cfg) => {
      if (transportOf(cfg) !== "stdio") return cfg;
      const stdio = cfg as StdioCfg;
      stdio.env = { ...(stdio.env ?? {}), [key]: value };
      return stdio;
    });
  }

  function deleteEnv(key: string) {
    updateSelected((cfg) => {
      if (transportOf(cfg) !== "stdio") return cfg;
      const stdio = cfg as StdioCfg;
      const env = { ...(stdio.env ?? {}) };
      delete env[key];
      stdio.env = env;
      return stdio;
    });
  }

  function addEnvRow() {
    updateSelected((cfg) => {
      if (transportOf(cfg) !== "stdio") return cfg;
      const stdio = cfg as StdioCfg;
      const env = { ...(stdio.env ?? {}) };
      let key = "NEW_VAR";
      let n = 1;
      while (key in env) key = `NEW_VAR_${n++}`;
      env[key] = "";
      stdio.env = env;
      return stdio;
    });
  }

  function setHeaderKey(oldKey: string, newKey: string) {
    updateSelected((cfg) => {
      if (transportOf(cfg) === "stdio") return cfg;
      const t = cfg as HttpCfg | SseCfg;
      const h = { ...(t.headers ?? {}) };
      const v = h[oldKey] ?? "";
      delete h[oldKey];
      h[newKey] = v;
      t.headers = h;
      return t;
    });
  }

  function setHeaderValue(key: string, value: string) {
    updateSelected((cfg) => {
      if (transportOf(cfg) === "stdio") return cfg;
      const t = cfg as HttpCfg | SseCfg;
      t.headers = { ...(t.headers ?? {}), [key]: value };
      return t;
    });
  }

  function deleteHeader(key: string) {
    updateSelected((cfg) => {
      if (transportOf(cfg) === "stdio") return cfg;
      const t = cfg as HttpCfg | SseCfg;
      const h = { ...(t.headers ?? {}) };
      delete h[key];
      t.headers = h;
      return t;
    });
  }

  function addHeaderRow() {
    updateSelected((cfg) => {
      if (transportOf(cfg) === "stdio") return cfg;
      const t = cfg as HttpCfg | SseCfg;
      const h = { ...(t.headers ?? {}) };
      let key = "X-Header";
      let n = 1;
      while (key in h) key = `X-Header-${n++}`;
      h[key] = "";
      t.headers = h;
      return t;
    });
  }

  // ------------ args (string[] tags) -------------------------------------
  let argInput = "";
  function addArg() {
    const v = argInput.trim();
    if (!v) return;
    updateSelected((cfg) => {
      if (transportOf(cfg) !== "stdio") return cfg;
      const stdio = cfg as StdioCfg;
      stdio.args = [...(stdio.args ?? []), v];
      return stdio;
    });
    argInput = "";
  }
  function removeArg(idx: number) {
    updateSelected((cfg) => {
      if (transportOf(cfg) !== "stdio") return cfg;
      const stdio = cfg as StdioCfg;
      const next = [...(stdio.args ?? [])];
      next.splice(idx, 1);
      stdio.args = next;
      return stdio;
    });
  }

  // ------------ raw json import/export -----------------------------------
  function openRaw() {
    rawJsonDraft = JSON.stringify(servers, null, 2);
    rawJsonErr = "";
    showRawJson = true;
  }

  function applyRaw() {
    try {
      const parsed = JSON.parse(rawJsonDraft || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        rawJsonErr = "Top level must be an object";
        return;
      }
      servers = parsed as ServersMap;
      persist();
      showRawJson = false;
    } catch (e) {
      rawJsonErr = e instanceof Error ? e.message : String(e);
    }
  }

  // ------------ test connection (sidecar RPC) ----------------------------
  function uuid() {
    return crypto.randomUUID();
  }

  async function testServer(name: string) {
    if (!(name in servers)) return;
    const id = uuid();
    pendingTests.set(id, name);
    testResults = { ...testResults, [name]: { state: "running" } };
    try {
      await safeInvoke("send_to_sidecar", {
        payload: JSON.stringify({
          id,
          type: "mcp_test",
          name,
          config: servers[name],
        }),
      });
    } catch (err) {
      pendingTests.delete(id);
      testResults = {
        ...testResults,
        [name]: {
          state: "error",
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  onMount(async () => {
    unlistenEvent = await safeListen<{
      id: string;
      type: string;
      value?: unknown;
      error?: string;
    }>("sidecar-event", (e) => {
      const ev = e.payload;
      const name = pendingTests.get(ev.id);
      if (!name) return;
      if (ev.type === "result") {
        const r = ev.value as
          | { ok: true; tools?: { name: string; description?: string }[] }
          | { ok: false; error?: string }
          | undefined;
        if (r?.ok) {
          testResults = {
            ...testResults,
            [name]: { state: "ok", tools: r.tools ?? [] },
          };
        } else {
          testResults = {
            ...testResults,
            [name]: {
              state: "error",
              error: r?.error ?? "unknown error",
            },
          };
        }
        pendingTests.delete(ev.id);
      } else if (ev.type === "error") {
        testResults = {
          ...testResults,
          [name]: { state: "error", error: ev.error ?? "unknown error" },
        };
        pendingTests.delete(ev.id);
      }
    });
  });

  onDestroy(() => {
    unlistenEvent?.();
  });

  // ------------ derived ---------------------------------------------------
  $: serverNames = Object.keys(servers);
  $: activeCfg = selected ? servers[selected] : null;
  $: activeTransport = activeCfg ? transportOf(activeCfg) : null;
</script>

{#if open || embedded}
  {#if !embedded}
    <button class="scrim" on:click={() => dispatch("close")} aria-label="Close MCP manager"
    ></button>
  {/if}

  <div class="panel" class:embedded role="dialog" aria-modal={embedded ? undefined : "true"} aria-label="MCP servers">
    <header class="head">
      <div class="title">
        <span class="eyebrow">CONFIG · MCP</span>
        <h2>MCP servers</h2>
      </div>
      <div class="head-right">
        <label class="strict">
          <input
            type="checkbox"
            checked={$settings.strictMcpConfig}
            on:change={(e) =>
              patchSettings({
                strictMcpConfig: (e.target as HTMLInputElement).checked,
              })}
          />
          <span class="mono">strict</span>
        </label>
        <button class="ghost mono" on:click={openRaw}>raw json</button>
        <button class="close" on:click={() => dispatch("close")} aria-label="Close"><X size={14} stroke={1.8} /></button>
      </div>
    </header>

    <div class="body">
      <!-- LEFT: server list -->
      <div class="list">
        <div class="list-head">
          <span class="eyebrow">SERVERS</span>
          <span class="count mono">{serverNames.length}</span>
        </div>

        <ul class="rows">
          {#each serverNames as name}
            {@const t = transportOf(servers[name])}
            <li>
              <button
                class="row"
                class:active={selected === name}
                on:click={() => (selected = name)}
              >
                <span class="row-name">{name}</span>
                <span class="badge mono badge-{t}">{t}</span>
              </button>
            </li>
          {:else}
            <li class="empty mono">no servers configured</li>
          {/each}
        </ul>

        <div class="add">
          {#if addingTransport}
            <div class="add-form">
              <span class="eyebrow">NEW · {addingTransport}</span>
              <input
                class="mono"
                placeholder="server name"
                bind:value={newName}
                on:keydown={(e) => {
                  if (e.key === "Enter") addServer();
                  if (e.key === "Escape") {
                    addingTransport = null;
                    newName = "";
                  }
                }}
              />
              <div class="add-actions">
                <button class="ghost mono" on:click={() => { addingTransport = null; newName = ""; }}>cancel</button>
                <button class="primary mono" on:click={addServer}>add</button>
              </div>
            </div>
          {:else}
            <span class="eyebrow">ADD</span>
            <div class="add-row">
              <button class="ghost mono" on:click={() => (addingTransport = "stdio")}>+ stdio</button>
              <button class="ghost mono" on:click={() => (addingTransport = "http")}>+ http</button>
              <button class="ghost mono" on:click={() => (addingTransport = "sse")}>+ sse</button>
            </div>
          {/if}
        </div>
      </div>

      <!-- RIGHT: form -->
      <div class="form">
        {#if !selected || !activeCfg}
          <div class="placeholder mono">select a server (or add one)</div>
        {:else}
          {@const sel = selected}
          {@const result = testResults[sel] ?? { state: "idle" }}
          <header class="form-head">
            <div class="form-title">
              <h3 class="server-name">{sel}</h3>
              <span class="badge mono badge-{activeTransport}">{activeTransport}</span>
            </div>
            <div class="form-actions">
              <button class="ghost mono" on:click={() => renameServer(sel)}>rename</button>
              <button class="ghost mono" on:click={() => duplicateServer(sel)}>duplicate</button>
              <button class="danger mono" on:click={() => deleteServer(sel)}>delete</button>
            </div>
          </header>

          <div class="form-body">
            {#if activeTransport === "stdio"}
              {@const stdio = activeCfg as StdioCfg}
              <section class="row-field">
                <span class="lbl">command</span>
                <input
                  class="mono"
                  placeholder="npx"
                  value={stdio.command ?? ""}
                  on:input={(e) =>
                    updateSelected((cfg) => {
                      const s = cfg as StdioCfg;
                      s.command = (e.target as HTMLInputElement).value;
                      return s;
                    })}
                />
              </section>

              <section class="row-field">
                <span class="lbl">args</span>
                <div class="tags">
                  {#each stdio.args ?? [] as arg, i}
                    <span class="tag mono">
                      {arg}
                      <button class="x" on:click={() => removeArg(i)}>×</button>
                    </span>
                  {/each}
                  <input
                    class="tag-input mono"
                    placeholder={(stdio.args ?? []).length ? "" : "add arg…"}
                    bind:value={argInput}
                    on:keydown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addArg();
                      }
                    }}
                    on:blur={addArg}
                  />
                </div>
              </section>

              <section class="row-field">
                <div class="lbl-row">
                  <span class="lbl">env</span>
                  <button class="ghost mono small" on:click={addEnvRow}>+ row</button>
                </div>
                <div class="kv">
                  {#each Object.entries(stdio.env ?? {}) as [k, v] (k)}
                    <div class="kv-row">
                      <input
                        class="mono kv-key"
                        value={k}
                        on:change={(e) => setEnvKey(k, (e.target as HTMLInputElement).value)}
                      />
                      <input
                        class="mono kv-val"
                        type={isSecret(k) ? "password" : "text"}
                        value={v}
                        on:input={(e) => setEnvValue(k, (e.target as HTMLInputElement).value)}
                      />
                      {#if isSecret(k)}
                        <span class="lock mono" title="masked">•••</span>
                      {/if}
                      <button class="x" on:click={() => deleteEnv(k)}>×</button>
                    </div>
                  {/each}
                  {#if !Object.keys(stdio.env ?? {}).length}
                    <div class="empty mono">no env vars</div>
                  {/if}
                </div>
              </section>
            {:else}
              {@const httpCfg = activeCfg as HttpCfg | SseCfg}
              <section class="row-field">
                <span class="lbl">url</span>
                <input
                  class="mono"
                  placeholder="https://example.com/mcp"
                  value={httpCfg.url ?? ""}
                  on:input={(e) =>
                    updateSelected((cfg) => {
                      const t = cfg as HttpCfg | SseCfg;
                      t.url = (e.target as HTMLInputElement).value;
                      return t;
                    })}
                />
              </section>

              <section class="row-field">
                <div class="lbl-row">
                  <span class="lbl">headers</span>
                  <button class="ghost mono small" on:click={addHeaderRow}>+ row</button>
                </div>
                <div class="kv">
                  {#each Object.entries(httpCfg.headers ?? {}) as [k, v] (k)}
                    <div class="kv-row">
                      <input
                        class="mono kv-key"
                        value={k}
                        on:change={(e) => setHeaderKey(k, (e.target as HTMLInputElement).value)}
                      />
                      <input
                        class="mono kv-val"
                        type={isSecret(k) ? "password" : "text"}
                        value={v}
                        on:input={(e) => setHeaderValue(k, (e.target as HTMLInputElement).value)}
                      />
                      {#if isSecret(k)}
                        <span class="lock mono" title="masked">•••</span>
                      {/if}
                      <button class="x" on:click={() => deleteHeader(k)}>×</button>
                    </div>
                  {/each}
                  {#if !Object.keys(httpCfg.headers ?? {}).length}
                    <div class="empty mono">no headers</div>
                  {/if}
                </div>
              </section>
            {/if}
          </div>

          <footer class="form-foot">
            <button
              class="primary mono"
              disabled={result.state === "running"}
              on:click={() => testServer(sel)}
            >
              {result.state === "running" ? "testing…" : "test connection"}
            </button>
            <div class="result mono">
              {#if result.state === "idle"}
                <span class="muted">not tested</span>
              {:else if result.state === "running"}
                <span class="muted">spawning server…</span>
              {:else if result.state === "ok"}
                <span class="ok"><Check size={12} stroke={2} /> {result.tools.length} tool{result.tools.length === 1 ? "" : "s"}</span>
              {:else}
                <span class="bad"><X size={12} stroke={2} /> {result.error}</span>
              {/if}
            </div>
            {#if result.state === "ok" && result.tools.length}
              <ul class="tools">
                {#each result.tools as tool}
                  <li><span class="tname mono">{tool.name}</span>
                    {#if tool.description}<span class="tdesc">— {tool.description}</span>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </footer>
        {/if}
      </div>
    </div>

    {#if showRawJson}
      <div class="raw-overlay">
        <div class="raw-card">
          <header class="raw-head">
            <h3>Raw JSON</h3>
            <button class="close" on:click={() => (showRawJson = false)}><X size={14} stroke={1.8} /></button>
          </header>
          <textarea class="mono" rows="20" bind:value={rawJsonDraft}></textarea>
          {#if rawJsonErr}
            <div class="raw-err mono">{rawJsonErr}</div>
          {/if}
          <footer class="raw-foot">
            <button class="ghost mono" on:click={() => (showRawJson = false)}>cancel</button>
            <button class="primary mono" on:click={applyRaw}>apply</button>
          </footer>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: oklch(0 0 0 / 0.55);
    backdrop-filter: blur(4px);
    z-index: 60;
    border: 0;
    padding: 0;
    cursor: pointer;
    animation: fade-in var(--dur-2) var(--ease);
  }
  .panel.embedded {
    position: relative;
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
  .panel {
    position: fixed;
    inset: 24px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-3);
    box-shadow: var(--shadow-lg);
    display: grid;
    grid-template-rows: auto 1fr;
    z-index: 61;
    overflow: hidden;
    animation: slide-up var(--dur-2) var(--ease);
  }

  .head {
    display: flex;
    align-items: center;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border);
    gap: 12px;
  }
  .title h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 21.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12.5px;
    color: var(--fg-4);
    font-family: var(--font-mono);
  }
  .head-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .strict { display: inline-flex; align-items: center; gap: 6px; font-size: 14.5px; color: var(--fg-2); }
  .close {
    width: 32px;
    height: 32px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg-2);
    border-radius: var(--r-2);
    cursor: pointer;
    font-size: 17px;
  }
  .close:hover { color: var(--fg); border-color: var(--border-hi); }

  .body {
    display: grid;
    grid-template-columns: 280px 1fr;
    min-height: 0;
    overflow: hidden;
  }

  /* LIST */
  .list {
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 8px;
  }
  .count {
    font-size: 13.5px;
    color: var(--fg-3);
    background: var(--elevated);
    padding: 1px 6px;
    border-radius: var(--r-1);
  }
  .rows {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0 8px 8px;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 9px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-2);
    color: var(--fg-2);
    font: inherit;
    font-size: 16px;
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .row:hover { background: var(--elevated); color: var(--fg); }
  .row.active {
    background: var(--elevated);
    color: var(--fg);
    border-color: var(--accent-line);
  }
  .row-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge {
    font-size: 12.5px;
    padding: 1px 6px;
    border-radius: var(--r-1);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg-3);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }
  .badge-stdio { color: var(--accent); border-color: var(--accent-line); }
  .badge-http  { color: var(--success); }
  .badge-sse   { color: var(--warning); }

  .add {
    border-top: 1px solid var(--border);
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .add-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .add-form { display: flex; flex-direction: column; gap: 8px; }
  .add-form input {
    background: transparent;
    color: var(--fg);
    border: 0;
    border-bottom: 1px solid var(--border);
    padding: 6px 0;
    font: inherit;
    font-family: var(--font-mono);
    font-size: 16px;
  }
  .add-form input:focus { outline: none; border-bottom-color: var(--accent); }
  .add-actions { display: flex; gap: 6px; justify-content: flex-end; }

  /* FORM */
  .form {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .placeholder {
    margin: auto;
    padding: 40px;
    color: var(--fg-4);
    font-size: 16px;
  }
  .form-head {
    display: flex;
    align-items: center;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    gap: 12px;
  }
  .form-title { display: flex; align-items: center; gap: 10px; }
  .server-name { margin: 0; font-size: 18.5px; font-weight: 600; }
  .form-actions { margin-left: auto; display: flex; gap: 6px; }
  .form-body {
    overflow-y: auto;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .form-foot {
    border-top: 1px solid var(--border);
    padding: 14px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface);
  }
  .form-foot > .primary { align-self: flex-start; }
  .result { font-size: 15.5px; }
  .result .ok { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); }
  .result .bad { display: inline-flex; align-items: center; gap: 4px; color: var(--danger); }
  .result .muted { color: var(--fg-3); }
  .tools {
    margin: 4px 0 0;
    padding: 0 0 0 18px;
    list-style: disc;
    color: var(--fg-2);
    font-size: 15.5px;
    max-height: 140px;
    overflow-y: auto;
  }
  .tools .tname { color: var(--fg); }
  .tools .tdesc { color: var(--fg-3); }

  .row-field { display: flex; flex-direction: column; gap: 6px; }
  .lbl-row { display: flex; align-items: center; justify-content: space-between; }
  .lbl {
    font-size: 14.5px;
    color: var(--fg-3);
    font-family: var(--font-mono);
    text-transform: lowercase;
    letter-spacing: 0.06em;
  }
  .row-field input {
    background: transparent;
    color: var(--fg);
    border: 0;
    border-bottom: 1px solid var(--border);
    padding: 6px 0;
    font: inherit;
    font-family: var(--font-mono);
    font-size: 16px;
    width: 100%;
  }
  .row-field input:focus { outline: none; border-bottom-color: var(--accent); }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    align-items: center;
    min-height: 32px;
  }
  .tags:focus-within { border-bottom-color: var(--accent); }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 2px 6px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    font-size: 15.5px;
    color: var(--fg);
  }
  .tag .x, .kv-row .x {
    background: transparent;
    color: var(--fg-3);
    border: 0;
    padding: 0 2px;
    font-size: 17px;
    line-height: 1;
    cursor: pointer;
  }
  .tag .x:hover, .kv-row .x:hover { color: var(--danger); }
  .tag-input {
    flex: 1;
    min-width: 80px;
    background: transparent;
    border: 0;
    color: var(--fg);
    padding: 2px 0;
    font-size: 15.5px;
  }
  .tag-input:focus { outline: none; }

  .kv { display: flex; flex-direction: column; gap: 4px; }
  .kv-row {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.4fr) auto auto;
    gap: 6px;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
  }
  .kv-row input { border-bottom: 0; padding: 4px 0; }
  .lock {
    font-size: 13.5px;
    color: var(--fg-4);
  }

  .empty {
    padding: 10px;
    font-size: 14.5px;
    color: var(--fg-4);
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: var(--r-2);
  }

  .ghost {
    background: transparent;
    color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 5px 10px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 14.5px;
  }
  .ghost:hover { color: var(--fg); border-color: var(--border-hi); }
  .ghost.small { padding: 2px 6px; font-size: 13.5px; }

  .danger {
    background: transparent;
    color: var(--danger);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 5px 10px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 14.5px;
  }
  .danger:hover { border-color: var(--danger); }

  .primary {
    background: var(--accent);
    color: oklch(0.16 0.04 75);
    border: 0;
    border-radius: var(--r-2);
    padding: 7px 14px;
    cursor: pointer;
    font-weight: 600;
    font-size: 15.5px;
    transition: filter var(--dur-1) var(--ease);
  }
  .primary:hover:not(:disabled) { filter: brightness(1.08); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }

  /* raw json overlay */
  .raw-overlay {
    position: absolute;
    inset: 0;
    background: oklch(0 0 0 / 0.55);
    z-index: 5;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .raw-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    width: min(720px, 100%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
  }
  .raw-head { display: flex; align-items: center; }
  .raw-head h3 { margin: 0; font-size: 17.5px; }
  .raw-head .close { margin-left: auto; }
  .raw-card textarea {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--r-1);
    padding: 10px;
    font-family: var(--font-mono);
    font-size: 15.5px;
    resize: vertical;
  }
  .raw-err {
    color: var(--danger);
    font-size: 14.5px;
  }
  .raw-foot { display: flex; justify-content: flex-end; gap: 8px; }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
