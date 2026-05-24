<script lang="ts">
  // Worker U: /init project wizard.
  //
  // Right-pane overlay (modal anchored to the right edge) that walks the
  // user through bootstrapping a project:
  //   1. confirm cwd
  //   2. preview / edit a CLAUDE.md template
  //   3. pick a default model
  //   4. pick which skills to enable
  //   5. save → write CLAUDE.md via Tauri writeTextFile + patch settings
  import { createEventDispatcher, onMount } from "svelte";
  import { writeTextFile } from "@tauri-apps/plugin-fs";
  import { getSettings, patchSettings, settings } from "./settings";
  import { skills as skillsStore, refreshSkills } from "./skills";

  export let open = false;

  const dispatch = createEventDispatcher<{
    close: void;
    toast: { message: string; kind?: "info" | "error" };
  }>();

  type Step = "cwd" | "template" | "model" | "skills" | "save";
  const STEPS: { id: Step; label: string }[] = [
    { id: "cwd", label: "Workspace" },
    { id: "template", label: "CLAUDE.md" },
    { id: "model", label: "Model" },
    { id: "skills", label: "Skills" },
    { id: "save", label: "Save" },
  ];

  let stepIndex = 0;
  $: step = STEPS[stepIndex].id;

  let cwd = "";
  let template = "";
  let model = "";
  let enabledSkills = new Set<string>();
  let saving = false;
  let saveError: string | null = null;
  let saveDone = false;

  const MODELS = [
    { id: "sonnet", label: "claude-sonnet (balanced)" },
    { id: "opus", label: "claude-opus (max reasoning)" },
    { id: "haiku", label: "claude-haiku (fast)" },
  ];

  function defaultTemplate(workspace: string): string {
    const name = workspace.split("/").filter(Boolean).pop() ?? "project";
    return `# ${name}

## Overview
Brief description of this project.

## Conventions
- Code style:
- Test framework:
- Build command:

## Notes for Claude
- Prefer minimal diffs.
- Surface tradeoffs before refactors.
`;
  }

  // Hydrate state when the wizard first opens.
  let hydrated = false;
  $: if (open && !hydrated) {
    hydrated = true;
    const s = getSettings();
    cwd = s.cwd ?? "";
    model = s.model ?? "sonnet";
    template = defaultTemplate(cwd);
    stepIndex = 0;
    saveDone = false;
    saveError = null;
    void refreshSkills();
  }
  $: if (!open) hydrated = false;

  function next(): void {
    if (stepIndex < STEPS.length - 1) stepIndex += 1;
  }
  function prev(): void {
    if (stepIndex > 0) stepIndex -= 1;
  }

  function toggleSkill(id: string): void {
    const n = new Set(enabledSkills);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    enabledSkills = n;
  }

  async function finish(): Promise<void> {
    saving = true;
    saveError = null;
    try {
      if (!cwd) throw new Error("cwd required");
      const target = `${cwd.replace(/\/+$/, "")}/CLAUDE.md`;
      await writeTextFile(target, template);
      patchSettings({ cwd, model });
      saveDone = true;
      dispatch("toast", { message: `wrote ${target}`, kind: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      saveError = msg;
      dispatch("toast", { message: `init failed: ${msg}`, kind: "error" });
    } finally {
      saving = false;
    }
  }

  function close(): void {
    dispatch("close");
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === "Escape") close();
  }

  onMount(() => {});
</script>

<svelte:window on:keydown={onKey} />

{#if open}
  <div class="backdrop" on:mousedown={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation">
    <aside class="pane" role="dialog" aria-modal="true" aria-label="Initialize project">
      <header class="hdr">
        <div class="title-block">
          <span class="eyebrow">PROJECT · INIT</span>
          <h2>Initialize project</h2>
        </div>
        <button class="close mono" type="button" on:click={close} title="Close (Esc)">×</button>
      </header>

      <nav class="steps mono">
        {#each STEPS as s, i (s.id)}
          <button
            class="step"
            class:active={i === stepIndex}
            class:done={i < stepIndex}
            type="button"
            on:click={() => (stepIndex = i)}
          >
            <span class="step-num">{i + 1}</span>
            <span class="step-lbl">{s.label}</span>
          </button>
        {/each}
      </nav>

      <section class="body">
        {#if step === "cwd"}
          <label class="lbl mono" for="init-cwd">Workspace directory</label>
          <input
            id="init-cwd"
            class="text"
            type="text"
            bind:value={cwd}
            placeholder="/Users/you/dev/project"
          />
          <p class="muted">CLAUDE.md will be written here.</p>
        {:else if step === "template"}
          <label class="lbl mono" for="init-template">CLAUDE.md template</label>
          <textarea
            id="init-template"
            class="text body-text"
            rows="14"
            bind:value={template}
          ></textarea>
          <p class="muted">Edit before saving — this becomes your project memory.</p>
        {:else if step === "model"}
          <label class="lbl mono" for="init-model">Default model</label>
          <select id="init-model" class="text" bind:value={model}>
            {#each MODELS as m (m.id)}
              <option value={m.id}>{m.label}</option>
            {/each}
          </select>
          <p class="muted">Stored in settings.model.</p>
        {:else if step === "skills"}
          <p class="lbl mono">Skills to enable</p>
          {#if $skillsStore.length === 0}
            <p class="muted">No skills discovered (refresh from Skills panel after init).</p>
          {:else}
            <div class="skill-list">
              {#each $skillsStore as sk (sk.id)}
                <label class="skill-row">
                  <input
                    type="checkbox"
                    checked={enabledSkills.has(sk.id)}
                    on:change={() => toggleSkill(sk.id)}
                  />
                  <span class="skill-name mono">{sk.name}</span>
                  <span class="skill-desc">{sk.description}</span>
                </label>
              {/each}
            </div>
            <p class="muted">Selection is informational — enable globally in the Skills panel.</p>
          {/if}
        {:else if step === "save"}
          <p class="lbl mono">Review</p>
          <ul class="review mono">
            <li>cwd: <b>{cwd || "—"}</b></li>
            <li>model: <b>{model}</b></li>
            <li>skills picked: <b>{enabledSkills.size}</b></li>
            <li>CLAUDE.md size: <b>{template.length} chars</b></li>
          </ul>
          {#if saveError}
            <p class="err mono">{saveError}</p>
          {/if}
          {#if saveDone}
            <p class="ok mono">✓ CLAUDE.md written</p>
          {/if}
        {/if}
      </section>

      <footer class="actions">
        <button class="ghost mono" type="button" disabled={stepIndex === 0} on:click={prev}>← Back</button>
        {#if step === "save"}
          <button
            class="primary mono"
            type="button"
            disabled={saving || saveDone || !cwd}
            on:click={() => void finish()}
          >
            {saving ? "Saving…" : saveDone ? "Done" : "Save"}
          </button>
        {:else}
          <button class="primary mono" type="button" on:click={next}>Next →</button>
        {/if}
      </footer>
    </aside>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in oklab, var(--bg) 70%, transparent);
    backdrop-filter: blur(4px);
    z-index: 90;
    display: flex;
    justify-content: flex-end;
  }
  .pane {
    width: min(520px, 96vw);
    height: 100vh;
    background: var(--surface);
    border-left: 1px solid var(--border-hi);
    box-shadow: -8px 0 32px rgba(0,0,0,0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .hdr {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 12px 16px 8px;
    border-bottom: 1px solid var(--border);
  }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12px;
    color: var(--fg-4);
    font-family: var(--font-mono);
  }
  .title-block h2 {
    margin: 4px 0 0;
    font-size: 17px;
    font-weight: 500;
    color: var(--fg);
  }
  .close {
    background: transparent;
    border: 0;
    color: var(--fg-3);
    font-size: 19px;
    cursor: pointer;
  }
  .close:hover { color: var(--fg); }
  .steps {
    display: flex;
    gap: 4px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .step {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-3);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 12.5px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .step.active { border-color: var(--accent); color: var(--accent); }
  .step.done { color: var(--fg-2); }
  .step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--bg);
    border: 1px solid currentColor;
    font-size: 10.5px;
  }
  .body {
    flex: 1;
    overflow: auto;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .lbl { font-size: 12px; color: var(--fg-4); text-transform: uppercase; letter-spacing: 0.1em; }
  .text {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--r-1);
    padding: 6px 8px;
    font-size: 14px;
    font-family: var(--font-mono);
    width: 100%;
    box-sizing: border-box;
  }
  .text:focus { outline: 1px solid var(--accent-line); }
  .body-text { resize: vertical; min-height: 180px; }
  .muted { color: var(--fg-4); font-size: 12.5px; }
  .skill-list { display: flex; flex-direction: column; gap: 4px; }
  .skill-row {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 8px;
    align-items: center;
    padding: 4px 6px;
    border-radius: var(--r-1);
  }
  .skill-row:hover { background: var(--elevated); }
  .skill-name { font-size: 13px; color: var(--fg-2); }
  .skill-desc { font-size: 12.5px; color: var(--fg-4); }
  .review { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--fg-3); }
  .review b { color: var(--fg); font-weight: 500; }
  .err { color: var(--danger); font-size: 13px; }
  .ok { color: var(--success, #4ade80); font-size: 13px; }
  .actions {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-3);
    border-radius: var(--r-1);
    padding: 5px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  .ghost:hover:not(:disabled) { background: var(--elevated); color: var(--fg); }
  .ghost:disabled { opacity: 0.4; cursor: not-allowed; }
  .primary {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: #000;
    border-radius: var(--r-1);
    padding: 5px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .primary:not(:disabled):hover { filter: brightness(1.05); }
</style>
