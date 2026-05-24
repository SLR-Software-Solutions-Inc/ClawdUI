<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { SettingField } from "./types";

  export let field: SettingField;
  export let value: any;

  const dispatch = createEventDispatcher<{ change: any }>();

  let tagInput = "";

  function commit(v: any) {
    dispatch("change", v);
  }

  function addTag(arr: string[]) {
    const t = tagInput.trim();
    if (!t) return;
    if (arr.includes(t)) {
      tagInput = "";
      return;
    }
    commit([...arr, t]);
    tagInput = "";
  }

  function removeTag(arr: string[], t: string) {
    commit(arr.filter((x) => x !== t));
  }

  function onTagKeydown(e: KeyboardEvent, arr: string[]) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(arr);
    } else if (e.key === "Backspace" && tagInput === "" && arr.length) {
      commit(arr.slice(0, -1));
    }
  }

  function onJsonChange(v: string) {
    commit(v);
  }

  $: jsonValid = (() => {
    if (field.control !== "json") return true;
    try {
      JSON.parse(value || "{}");
      return true;
    } catch {
      return false;
    }
  })();
</script>

<div class="field" class:mono={field.monospace}>
  {#if field.control === "text"}
    <input
      type="text"
      class:mono={field.monospace}
      class:readonly={field.readonly}
      placeholder={field.placeholder ?? ""}
      value={value ?? ""}
      readonly={field.readonly ? true : undefined}
      on:input={(e) => commit((e.target as HTMLInputElement).value || undefined)}
    />
  {:else if field.control === "password"}
    <input
      type="password"
      class:mono={field.monospace}
      class:readonly={field.readonly}
      autocomplete="off"
      spellcheck="false"
      placeholder={field.placeholder ?? ""}
      value={value ?? ""}
      readonly={field.readonly ? true : undefined}
      on:input={(e) => commit((e.target as HTMLInputElement).value)}
    />
  {:else if field.control === "textarea"}
    <textarea
      rows="4"
      class:mono={field.monospace}
      class:readonly={field.readonly}
      placeholder={field.placeholder ?? ""}
      value={value ?? ""}
      readonly={field.readonly ? true : undefined}
      on:input={(e) => commit((e.target as HTMLTextAreaElement).value)}
    ></textarea>
  {:else if field.control === "number"}
    <input
      type="number"
      class="mono"
      value={value ?? ""}
      on:input={(e) => {
        const v = (e.target as HTMLInputElement).value;
        commit(v === "" ? null : Number(v));
      }}
    />
  {:else if field.control === "boolean"}
    <button
      class="toggle mono"
      class:on={value === true}
      type="button"
      on:click={() => commit(!value)}
    >
      <span class="track"><span class="thumb"></span></span>
      <span class="state">{value ? "ON" : "OFF"}</span>
    </button>
  {:else if field.control === "select"}
    <div class="select">
      <select
        class="mono"
        class:readonly={field.readonly}
        value={value ?? ""}
        disabled={field.readonly ? true : undefined}
        on:change={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          commit(v === "" ? undefined : v);
        }}
      >
        {#each field.options ?? [] as opt}
          <option value={opt}>{opt === "" ? "—" : opt}</option>
        {/each}
      </select>
    </div>
  {:else if field.control === "tags" || field.control === "directories"}
    <div class="tags">
      {#each (value as string[]) ?? [] as tag}
        <span class="tag mono">
          {tag}
          <button type="button" class="x" on:click={() => removeTag(value as string[], tag)}>×</button>
        </span>
      {/each}
      <input
        class="tag-input mono"
        bind:value={tagInput}
        on:keydown={(e) => onTagKeydown(e, value as string[])}
        on:blur={() => addTag(value as string[])}
        placeholder={(value as string[])?.length ? "" : (field.placeholder ?? "add…")}
      />
    </div>
  {:else if field.control === "json"}
    <textarea
      rows="6"
      class="mono"
      class:invalid={!jsonValid}
      value={value ?? ""}
      on:input={(e) => onJsonChange((e.target as HTMLTextAreaElement).value)}
    ></textarea>
    {#if !jsonValid}
      <span class="json-err mono">invalid JSON</span>
    {/if}
  {/if}
</div>

<style>
  .field { display: flex; flex-direction: column; gap: 4px; }

  input[type="text"],
  input[type="number"],
  textarea,
  select {
    background: transparent;
    color: var(--fg);
    border: 0;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    padding: 6px 0;
    font: inherit;
    width: 100%;
    transition: border-color var(--dur-1) var(--ease);
  }
  input.mono, textarea.mono, select.mono { font-family: var(--font-mono); font-size: 16px; }
  input:focus, textarea:focus, select:focus {
    outline: none;
    border-bottom-color: var(--accent);
  }
  textarea { resize: vertical; }
  textarea.invalid { border-bottom-color: var(--danger); }
  input.readonly,
  textarea.readonly,
  select.readonly,
  select:disabled {
    color: var(--fg-3);
    cursor: not-allowed;
    opacity: 0.85;
  }
  input.readonly:focus,
  textarea.readonly:focus,
  select.readonly:focus { border-bottom-color: var(--border); }
  .json-err { color: var(--danger); font-size: 14.5px; margin-top: 2px; }

  .select { position: relative; }
  .select::after {
    content: "▾";
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    color: var(--fg-3);
    font-size: 13.5px;
  }
  select { appearance: none; padding-right: 18px; }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: pointer;
    color: var(--fg-2);
    font-size: 14.5px;
    letter-spacing: 0.06em;
  }
  .track {
    width: 32px;
    height: 16px;
    border: 1px solid var(--border-hi);
    border-radius: 999px;
    position: relative;
    transition: all var(--dur-1) var(--ease);
  }
  .thumb {
    position: absolute;
    top: 1px; left: 1px;
    width: 12px; height: 12px;
    background: var(--fg-3);
    border-radius: 999px;
    transition: all var(--dur-1) var(--ease);
  }
  .toggle.on .track { border-color: var(--accent); background: var(--accent-soft); }
  .toggle.on .thumb { left: 17px; background: var(--accent); }
  .toggle.on .state { color: var(--accent); }

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
  .tag .x {
    background: transparent;
    color: var(--fg-3);
    border: 0;
    padding: 0 2px;
    font-size: 17px;
    line-height: 1;
    cursor: pointer;
  }
  .tag .x:hover { color: var(--danger); }
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
</style>
