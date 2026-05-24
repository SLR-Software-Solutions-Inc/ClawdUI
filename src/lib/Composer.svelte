<script lang="ts">
  import { createEventDispatcher, tick, onMount, onDestroy } from "svelte";
  import { skills, filterSkills, type Skill } from "./skills";
  import { BUILTIN_COMMANDS, filterBuiltins, type SlashCommand } from "./slashCommands";
  import {
    attachments,
    type Attachment,
    MAX_FILES,
    WARN_BYTES,
    formatSize,
  } from "./attachments";
  import { rpcCall } from "./sidecarRpc";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import { Check, X, Send, Sparkles } from "./icons";

  export let disabled = false;
  export let busy = false;
  export let placeholder = "Ask Claude.  ↵ send · ⇧↵ newline · / skills";
  /** Optional reason surfaced as a title/tooltip when send is disabled. */
  export let disabledReason: string | null = null;

  const dispatch = createEventDispatcher<{
    send: { text: string; files: { fileId: string; mime?: string; name?: string }[] };
    interrupt: void;
    slashCommand: { command: string; args: string };
  }>();

  /** Recognized builtin slash-command ids — intercepted before falling back to Send. */
  const BUILTIN_IDS = new Set(BUILTIN_COMMANDS.map((c) => c.id));

  let value = "";
  let textarea: HTMLTextAreaElement;
  let composerEl: HTMLDivElement;
  let dragOver = false;
  let warnNote: string | null = null;
  let unlistenDrop: UnlistenFn | null = null;

  // Worker X: voice input (Web Speech API) ------------------------------
  // Minimal type shim — SpeechRecognition is not in the default DOM lib.
  interface SRResultAlt { transcript: string }
  interface SRResult { 0: SRResultAlt; isFinal: boolean; length: number }
  interface SRResultList { length: number; [i: number]: SRResult }
  interface SREvent { resultIndex: number; results: SRResultList }
  interface SRErrorEvent { error: string }
  interface SRInstance {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((e: SREvent) => void) | null;
    onerror: ((e: SRErrorEvent) => void) | null;
    onend: (() => void) | null;
  }
  type SRCtor = new () => SRInstance;
  const SR: SRCtor | null =
    (typeof window !== "undefined" &&
      ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) ||
    null;
  const voiceSupported = SR !== null;
  let recognizing = false;
  let interim = "";
  let recognizer: SRInstance | null = null;

  function startVoice(): void {
    if (!SR || recognizing) return;
    try {
      const r = new SR();
      r.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
      r.continuous = true;
      r.interimResults = true;
      let finalBuf = "";
      r.onresult = (e: SREvent) => {
        interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const txt = res[0]?.transcript ?? "";
          if (res.isFinal) finalBuf += txt;
          else interim += txt;
        }
        if (finalBuf) {
          const sep = value && !/\s$/.test(value) ? " " : "";
          value = value + sep + finalBuf.trim();
          finalBuf = "";
          void tick().then(() => autosize());
        }
      };
      r.onerror = (e: SRErrorEvent) => {
        recognizing = false;
        interim = "";
        const msg =
          e.error === "not-allowed" || e.error === "service-not-allowed"
            ? "Microphone permission denied."
            : e.error === "no-speech"
              ? null
              : `Voice input error: ${e.error}`;
        if (msg) {
          warnNote = msg;
          setTimeout(() => (warnNote = null), 4000);
        }
      };
      r.onend = () => {
        recognizing = false;
        interim = "";
      };
      recognizer = r;
      r.start();
      recognizing = true;
    } catch (err) {
      recognizing = false;
      warnNote = `Voice input failed: ${err instanceof Error ? err.message : String(err)}`;
      setTimeout(() => (warnNote = null), 4000);
    }
  }

  function stopVoice(): void {
    if (!recognizer || !recognizing) return;
    try {
      recognizer.stop();
    } catch {
      // ignore
    }
  }

  function toggleVoice(): void {
    if (recognizing) stopVoice();
    else startVoice();
  }

  // ----- shell-style history recall --------------------------------------
  const HISTORY_KEY = "clawdui.composer.history";
  const HISTORY_CAP = 200;
  let history: string[] = [];
  let historyIndex: number | null = null; // null = drafting, else index into history
  let savedDraft = "";
  /** True while we're programmatically setting `value` from history; suppresses
   *  the input handler's "user typed → exit history" behavior. */
  let recallInFlight = false;

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        history = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // ignore corrupted storage
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      // storage may be full / blocked; ignore
    }
  }

  function pushHistory(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (history[0] === trimmed) return;
    history = [trimmed, ...history].slice(0, HISTORY_CAP);
    saveHistory();
  }

  function moveCursorToEnd(ta: HTMLTextAreaElement | undefined) {
    if (!ta) return;
    const pos = ta.value.length;
    ta.setSelectionRange(pos, pos);
    ta.scrollTop = ta.scrollHeight;
  }

  function recallUp() {
    if (history.length === 0) return;
    if (historyIndex === null) {
      savedDraft = value;
      historyIndex = 0;
    } else if (historyIndex < history.length - 1) {
      historyIndex += 1;
    } else {
      return; // already at oldest
    }
    recallInFlight = true;
    value = history[historyIndex];
    void tick().then(() => {
      autosize();
      moveCursorToEnd(textarea);
      recallInFlight = false;
    });
  }

  function recallDown() {
    if (historyIndex === null) return;
    if (historyIndex > 0) {
      historyIndex -= 1;
      recallInFlight = true;
      value = history[historyIndex];
    } else {
      historyIndex = null;
      recallInFlight = true;
      value = savedDraft;
      savedDraft = "";
    }
    void tick().then(() => {
      autosize();
      moveCursorToEnd(textarea);
      recallInFlight = false;
    });
  }

  function exitHistory() {
    if (historyIndex === null) return;
    historyIndex = null;
    recallInFlight = true;
    value = savedDraft;
    savedDraft = "";
    void tick().then(() => {
      autosize();
      moveCursorToEnd(textarea);
      recallInFlight = false;
    });
  }

  /** True iff the caret is on the first visual line of the textarea
   *  (no newline character precedes the caret). */
  function isCursorAtTop(ta: HTMLTextAreaElement): boolean {
    const before = ta.value.slice(0, ta.selectionStart ?? 0);
    return !before.includes("\n");
  }

  /** True iff caret sits at the bottom (no newline after caret). */
  function isCursorAtBottom(ta: HTMLTextAreaElement): boolean {
    const after = ta.value.slice(ta.selectionEnd ?? ta.value.length);
    return !after.includes("\n");
  }

  // ----- attachments -----------------------------------------------------

  function pointerInside(el: HTMLElement | undefined, x: number, y: number): boolean {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function attachPath(filePath: string, displayName?: string): void {
    const name = displayName ?? filePath.split(/[\\/]/).pop() ?? filePath;
    attachments.add({
      path: filePath,
      name,
      size: 0,
      status: "ready",
    });
  }

  function attachBytes(name: string, mime: string, base64: string): void {
    attachments.add({
      name,
      size: Math.floor((base64.length * 3) / 4),
      mime,
      pendingBase64: base64,
      status: "ready",
    });
  }

  async function uploadAttachment(att: Attachment): Promise<void> {
    attachments.patch(att.localId, { status: "uploading", error: undefined });
    try {
      const res = (
        att.pendingBase64
          ? await rpcCall("upload_bytes", {
              name: att.name,
              mime: att.mime ?? "application/octet-stream",
              base64: att.pendingBase64,
            })
          : await rpcCall("upload_file", { path: att.path })
      ) as { fileId: string; name: string; size: number; mime: string };
      if (res.size > WARN_BYTES) {
        warnNote = `${res.name} is ${formatSize(res.size)} — large files inflate context cost.`;
        setTimeout(() => (warnNote = null), 6000);
      }
      attachments.patch(att.localId, {
        fileId: res.fileId,
        name: res.name,
        size: res.size,
        mime: res.mime,
        status: "ready",
        pendingBase64: undefined,
      });
    } catch (err) {
      attachments.patch(att.localId, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleDroppedPaths(paths: string[]): Promise<void> {
    const room = MAX_FILES - attachments.count();
    if (room <= 0) {
      warnNote = `Max ${MAX_FILES} files per message.`;
      setTimeout(() => (warnNote = null), 4000);
      return;
    }
    const subset = paths.slice(0, room);
    if (paths.length > room) {
      warnNote = `Only first ${room} of ${paths.length} files queued (cap ${MAX_FILES}).`;
      setTimeout(() => (warnNote = null), 5000);
    }
    for (const p of subset) attachPath(p);
  }

  function removeAttachment(att: Attachment): void {
    if (att.fileId) {
      // best-effort delete on the API
      void rpcCall("discard_file", { fileId: att.fileId }).catch(() => {});
    }
    attachments.remove(att.localId);
  }

  async function retryAttachment(att: Attachment): Promise<void> {
    if (!att.path && !att.pendingBase64) {
      attachments.remove(att.localId);
      return;
    }
    await uploadAttachment(att);
  }

  async function onPaste(e: ClipboardEvent): Promise<void> {
    if (!e.clipboardData) return;
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter((it) => it.kind === "file");
    // Suppress default paste when ANY item looks like an image, even if the
    // browser exposes it as kind:"string" with type:"image/..." or alongside
    // an HTML/text alternative — otherwise base64 data URLs / binary text
    // fallbacks leak into the textarea on paste.
    const hasImageLike = items.some((it) => it.type?.startsWith("image/"));
    if (fileItems.length === 0 && !hasImageLike) return;
    e.preventDefault();
    if (fileItems.length === 0) return;
    // Clipboard often exposes the same image as multiple MIME representations
    // (e.g. image/png + image/tiff from macOS screenshot). Dedupe to a single
    // upload per paste — prefer image/png, else first image type, else first.
    const pngItem = fileItems.find((it) => it.type === "image/png");
    const imageItem = fileItems.find((it) => it.type?.startsWith("image/"));
    const chosen = pngItem ?? imageItem ?? fileItems[0];
    const file = chosen.getAsFile();
    if (!file) return;
    if (attachments.count() >= MAX_FILES) {
      warnNote = `Max ${MAX_FILES} files per message.`;
      setTimeout(() => (warnNote = null), 4000);
      return;
    }
    const buf = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    attachBytes(file.name || "pasted", file.type || "application/octet-stream", base64);
  }

  onMount(async () => {
    loadHistory();
    try {
      unlistenDrop = await getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") {
          dragOver = pointerInside(composerEl, p.position.x, p.position.y);
        } else if (p.type === "leave") {
          dragOver = false;
        } else if (p.type === "drop") {
          const inside = pointerInside(composerEl, p.position.x, p.position.y);
          dragOver = false;
          if (inside && Array.isArray(p.paths) && p.paths.length > 0) {
            void handleDroppedPaths(p.paths);
          }
        }
      });
    } catch {
      // running outside Tauri context (tests, dev preview) — drag-drop disabled.
    }
  });

  onDestroy(() => {
    unlistenDrop?.();
    unlistenDrop = null;
    // Worker X: stop any in-flight voice recognition on unmount.
    if (recognizer && recognizing) {
      try { recognizer.abort(); } catch { /* ignore */ }
    }
    recognizer = null;
    recognizing = false;
  });

  // slash-autocomplete state
  let menuOpen = false;
  let menuQuery = "";
  let menuIndex = 0;

  type BuiltinRow = { kind: "builtin"; cmd: SlashCommand };
  type SkillRow = { kind: "skill"; skill: Skill };
  type HeaderRow = { kind: "header"; label: string };
  type FlatRow = BuiltinRow | SkillRow | HeaderRow;

  // Selectable rows (no headers) — used for keyboard navigation.
  $: filteredBuiltins = menuOpen ? filterBuiltins(menuQuery).slice(0, 12) : [];
  $: filteredSkills = menuOpen ? filterSkills(menuQuery, $skills).slice(0, 12) : [];

  // Flat render list: header → builtins → header → skills.
  $: flatRows = (() => {
    if (!menuOpen) return [] as FlatRow[];
    const rows: FlatRow[] = [];
    if (filteredBuiltins.length > 0) {
      rows.push({ kind: "header", label: "BUILTIN" });
      for (const cmd of filteredBuiltins) rows.push({ kind: "builtin", cmd });
    }
    if (filteredSkills.length > 0) {
      rows.push({ kind: "header", label: "SKILLS" });
      for (const skill of filteredSkills) rows.push({ kind: "skill", skill });
    }
    return rows;
  })();

  $: selectableIndices = flatRows
    .map((r, i) => (r.kind === "header" ? -1 : i))
    .filter((i) => i >= 0);

  $: hasMatches = selectableIndices.length > 0;

  // Clamp menuIndex to a valid selectable row index.
  $: if (menuOpen) {
    if (selectableIndices.length === 0) menuIndex = 0;
    else if (!selectableIndices.includes(menuIndex)) menuIndex = selectableIndices[0];
  }

  async function send(): Promise<void> {
    const v = value.trim();
    const anyUploading = $attachments.some((a) => a.status === "uploading");
    if (anyUploading) return;
    const hasFiles = $attachments.some((a) => a.status === "ready" || a.status === "error");
    if (!v && !hasFiles) return;
    if (disabled) return;

    // Intercept builtin slash commands ("/clear", "/model haiku", ...) and
    // dispatch as slashCommand events for the host to route. Anything that
    // doesn't match a known builtin is sent verbatim to the model (legacy
    // skills, free-form prompts starting with "/", etc.).
    if (v.startsWith("/") && !hasFiles) {
      const space = v.indexOf(" ");
      const command = (space === -1 ? v.slice(1) : v.slice(1, space)).trim();
      const args = (space === -1 ? "" : v.slice(space + 1)).trim();
      if (command && BUILTIN_IDS.has(command)) {
        dispatch("slashCommand", { command, args });
        pushHistory(v);
        historyIndex = null;
        savedDraft = "";
        value = "";
        closeMenu();
        autosize();
        return;
      }
    }
    // NOTE: busy is no longer a hard block. Parent App.svelte routes the
    // dispatched send event into a queue when busy=true, so the user can
    // pile up follow-up prompts without waiting for the current turn.

    // Upload any locally-attached files (paste/drop) on demand. Nothing hits
    // Claude's Files API until Send — paste alone is fully local.
    const pending = $attachments.filter(
      (a) => a.status === "ready" && !a.fileId && (a.pendingBase64 || a.path),
    );
    if (pending.length > 0) {
      for (const att of pending) await uploadAttachment(att);
      const anyFailed = $attachments.some((a) => a.status === "error");
      if (anyFailed) {
        warnNote = "One or more attachments failed to upload.";
        setTimeout(() => (warnNote = null), 4000);
        return;
      }
    }

    const files = $attachments
      .filter((a) => a.status === "ready" && !!a.fileId)
      .map((a) => ({ fileId: a.fileId!, mime: a.mime, name: a.name }));
    dispatch("send", { text: v, files });
    pushHistory(v);
    historyIndex = null;
    savedDraft = "";
    value = "";
    attachments.clear();
    closeMenu();
    autosize();
  }

  /** Programmatic insert at the cursor. Used by message hover-toolbar's
   *  "quote" action and any external panel that wants to prefill text. */
  export function insertText(text: string) {
    const cursor = textarea?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    value = before + text + after;
    void tick().then(() => {
      if (!textarea) return;
      const pos = (before + text).length;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
      autosize();
    });
  }

  /** Programmatic insert from external panel: drop "/<id> " into the textarea. */
  export function insertSkillCommand(id: string) {
    const cursor = textarea?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    const insertText = `/${id} `;
    value = before + insertText + after;
    void tick().then(() => {
      if (!textarea) return;
      const pos = (before + insertText).length;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
      autosize();
      updateMenuFromCursor();
    });
  }

  function closeMenu() {
    menuOpen = false;
    menuQuery = "";
    menuIndex = 0;
  }

  /** Menu opens iff textarea starts with `/` and cursor is inside the first token (no whitespace before cursor). */
  function updateMenuFromCursor() {
    if (!textarea) return;
    const cursor = textarea.selectionStart ?? 0;
    const pre = value.slice(0, cursor);
    if (!pre.startsWith("/")) {
      closeMenu();
      return;
    }
    if (/\s/.test(pre)) {
      closeMenu();
      return;
    }
    menuOpen = true;
    menuQuery = pre.slice(1);
  }

  function pickSkill(item: Skill) {
    if (!textarea) return;
    const cursor = textarea.selectionStart ?? value.length;
    // replace the leading "/<query>" token with "/<id> "
    const after = value.slice(cursor);
    const insertText = `/${item.id} `;
    value = insertText + after;
    void tick().then(() => {
      if (!textarea) return;
      const pos = insertText.length;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
      autosize();
    });
    closeMenu();
  }

  function pickBuiltin(cmd: SlashCommand) {
    if (!textarea) return;
    // Commands with args (e.g. /model <name>) leave caret in textarea so user
    // can type the argument. Parameterless commands fire immediately.
    if (cmd.argsHint) {
      const insertText = `/${cmd.id} `;
      value = insertText;
      void tick().then(() => {
        if (!textarea) return;
        const pos = insertText.length;
        textarea.focus();
        textarea.setSelectionRange(pos, pos);
        autosize();
      });
      closeMenu();
      return;
    }
    // Parameterless → dispatch directly (same path as Composer's send-time
    // interception, so host App.svelte routes consistently).
    dispatch("slashCommand", { command: cmd.id, args: "" });
    pushHistory(`/${cmd.id}`);
    historyIndex = null;
    savedDraft = "";
    value = "";
    closeMenu();
    autosize();
  }

  function pickFlatRow(idx: number) {
    const row = flatRows[idx];
    if (!row || row.kind === "header") return;
    if (row.kind === "builtin") pickBuiltin(row.cmd);
    else pickSkill(row.skill);
  }

  function moveSelection(delta: 1 | -1) {
    if (selectableIndices.length === 0) return;
    const cur = selectableIndices.indexOf(menuIndex);
    const base = cur === -1 ? (delta === 1 ? -1 : 0) : cur;
    const next = (base + delta + selectableIndices.length) % selectableIndices.length;
    menuIndex = selectableIndices[next];
  }

  function onKeydown(e: KeyboardEvent) {
    if (menuOpen && hasMatches) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !(e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        pickFlatRow(menuIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        return;
      }
    } else if (menuOpen && e.key === "Escape") {
      // "no matches" state — esc still dismisses.
      e.preventDefault();
      closeMenu();
      return;
    }

    // Enter = send. Shift / Ctrl / Cmd / Alt + Enter = newline. Matches
    // chat clients (ChatGPT, Slack) so a press doesn't accidentally hold
    // text mid-paragraph.
    if (e.key === "Enter" && !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) {
      e.preventDefault();
      send();
      return;
    }
    // Cmd/Ctrl + Enter is kept as an alias for muscle memory.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
      return;
    }

    // Shell-style history recall — only when slash-menu is NOT open.
    const plainArrow =
      !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (plainArrow && e.key === "ArrowUp" && textarea && isCursorAtTop(textarea)) {
      if (history.length === 0) return;
      e.preventDefault();
      recallUp();
      return;
    }
    if (plainArrow && e.key === "ArrowDown" && historyIndex !== null && textarea && isCursorAtBottom(textarea)) {
      e.preventDefault();
      recallDown();
      return;
    }
    if (e.key === "Escape" && historyIndex !== null) {
      e.preventDefault();
      exitHistory();
      return;
    }
  }

  function onInput() {
    // If user types while in history-recall mode, treat current text as a
    // fresh draft: drop the recall index but keep what's in the textarea.
    if (historyIndex !== null && !recallInFlight) {
      historyIndex = null;
      savedDraft = "";
    }
    autosize();
    updateMenuFromCursor();
  }

  function onSelect() {
    updateMenuFromCursor();
  }

  function autosize() {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 240) + "px";
  }
</script>

<div
  class="composer"
  class:disabled
  class:drag-over={dragOver}
  data-tour="composer"
  bind:this={composerEl}
>
  {#if $attachments.length > 0}
    <div class="chips" role="list" aria-label="Attached files">
      {#each $attachments as att (att.localId)}
        <div
          class="chip"
          class:err={att.status === "error"}
          class:ok={att.status === "ready"}
          role="listitem"
        >
          {#if att.status === "uploading"}
            <span class="spinner" aria-hidden="true"></span>
          {:else if att.status === "ready"}
            <span class="check" aria-hidden="true"><Check size={12} stroke={2} /></span>
          {:else}
            <span class="cross" aria-hidden="true"><X size={12} stroke={2} /></span>
          {/if}
          <span class="name" title={att.error ?? att.name}>{att.name}</span>
          <span class="size mono">{att.size ? formatSize(att.size) : ""}</span>
          {#if att.status === "error"}
            <button class="retry" on:click={() => void retryAttachment(att)} title="Retry">↻</button>
          {/if}
          <button
            class="remove"
            on:click={() => removeAttachment(att)}
            title="Remove"
            aria-label="Remove {att.name}"
          ><X size={12} stroke={1.8} /></button>
        </div>
      {/each}
    </div>
  {/if}
  {#if warnNote}
    <div class="warn mono">{warnNote}</div>
  {/if}
  {#if dragOver}
    <div class="drop-hint mono">Drop files to attach</div>
  {/if}
  <div class="frame">
    <div class="rail"></div>
    <textarea
      bind:this={textarea}
      bind:value
      on:keydown={onKeydown}
      on:input={onInput}
      on:click={onSelect}
      on:keyup={onSelect}
      on:paste={(e) => void onPaste(e)}
      on:blur={() => setTimeout(closeMenu, 120)}
      {placeholder}
      rows="2"
      {disabled}
      title={disabled && disabledReason ? disabledReason : undefined}
      aria-disabled={disabled}
    ></textarea>

    {#if menuOpen}
      <div
        class="menu glass"
        role="listbox"
        aria-label="Slash commands"
        aria-activedescendant={hasMatches ? `slash-row-${menuIndex}` : undefined}
      >
        {#if hasMatches}
          {#each flatRows as row, i (i)}
            {#if row.kind === "header"}
              <div class="menu-head mono" role="presentation">
                {#if row.label === "BUILTIN"}
                  <span class="menu-head-dot" aria-hidden="true">/</span>
                {:else}
                  <span class="menu-head-ico" aria-hidden="true"><Sparkles size={11} stroke={1.7} /></span>
                {/if}
                <span class="menu-head-label">{row.label}</span>
                <span class="menu-head-rule" aria-hidden="true"></span>
              </div>
            {:else if row.kind === "builtin"}
              <button
                id={`slash-row-${i}`}
                type="button"
                class="menu-item"
                class:active={i === menuIndex}
                role="option"
                aria-selected={i === menuIndex}
                on:mousedown|preventDefault={() => pickBuiltin(row.cmd)}
                on:mouseenter={() => (menuIndex = i)}
              >
                <span class="m-id mono">
                  /{row.cmd.id}{#if row.cmd.argsHint}<span class="m-args mono"> {row.cmd.argsHint}</span>{/if}
                </span>
                <span class="m-desc">{row.cmd.description}</span>
                <span class="m-kbd mono" aria-hidden="true">{row.cmd.argsHint ? "tab" : "↵"}</span>
              </button>
            {:else}
              <button
                id={`slash-row-${i}`}
                type="button"
                class="menu-item"
                class:active={i === menuIndex}
                role="option"
                aria-selected={i === menuIndex}
                on:mousedown|preventDefault={() => pickSkill(row.skill)}
                on:mouseenter={() => (menuIndex = i)}
              >
                <span class="m-id mono">/{row.skill.id}</span>
                {#if row.skill.description}
                  <span class="m-desc">{row.skill.description}</span>
                {:else}
                  <span class="m-desc"></span>
                {/if}
                <span class="m-kbd mono" aria-hidden="true">tab</span>
              </button>
            {/if}
          {/each}
          <div class="menu-foot mono" aria-hidden="true">
            <span>↑↓ navigate</span><span class="sep">·</span>
            <span>⏎ select</span><span class="sep">·</span>
            <span>esc close</span>
          </div>
        {:else}
          <div class="menu-empty mono" role="status">
            no matches for <span class="m-q">/{menuQuery}</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
  {#if recognizing && interim}
    <!-- Worker X: live interim voice transcript -->
    <div class="voice-interim mono" aria-live="polite">{interim}</div>
  {/if}
  <div class="row">
    <span class="hint mono"></span>
    {#if voiceSupported}
      <!-- Worker X: voice input toggle -->
      <button
        class="mic"
        class:recording={recognizing}
        type="button"
        on:click={toggleVoice}
        title={recognizing ? "Stop voice input" : "Start voice input"}
        aria-label={recognizing ? "Stop voice input" : "Start voice input"}
        aria-pressed={recognizing}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3"></rect>
          <path d="M5 11a7 7 0 0 0 14 0"></path>
          <line x1="12" y1="18" x2="12" y2="21"></line>
          <line x1="9" y1="21" x2="15" y2="21"></line>
        </svg>
      </button>
    {:else}
      <!-- Worker X: voice unsupported placeholder for tooltip discoverability -->
      <span class="mic mic-unsupported" title="Voice input unsupported" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="3" width="6" height="11" rx="3"></rect>
          <path d="M5 11a7 7 0 0 0 14 0"></path>
          <line x1="4" y1="4" x2="20" y2="20"></line>
        </svg>
      </span>
    {/if}
    <button
      class="send"
      class:queue-mode={busy}
      type="button"
      on:click={send}
      disabled={disabled
        || (!value.trim() && attachments.readyFileIds().length === 0)
        || $attachments.some((a) => a.status === "uploading")}
      title={disabled
        ? (disabledReason ?? "Send unavailable")
        : !value.trim() && attachments.readyFileIds().length === 0
          ? "No prompt entered"
          : $attachments.some((a) => a.status === "uploading")
            ? "Waiting for attachment upload"
            : busy
              ? "Queue this prompt — runs after current turn settles"
              : "Send"}
    >
      <span>{busy ? "Queue" : "Send"}</span>
      <span class="send-ico" aria-hidden="true"><Send size={14} stroke={1.8} /></span>
    </button>
  </div>
</div>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 22px 18px;
    background: var(--bg);
    border-top: 1px solid var(--line);
    position: relative;
    z-index: 2;
  }
  .frame {
    display: grid;
    grid-template-columns: 4px 1fr;
    gap: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-3);
    padding: 12px 14px;
    transition: border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease);
    position: relative;
  }
  .frame:focus-within {
    border-color: var(--accent-line);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .rail {
    background: var(--border);
    border-radius: 999px;
    align-self: stretch;
  }
  .frame:focus-within .rail { background: var(--accent); }
  textarea {
    background: transparent;
    border: 0;
    color: var(--fg);
    font: inherit;
    font-size: 17.5px;
    line-height: 1.55;
    resize: none;
    width: 100%;
    min-height: 44px;
    max-height: 240px;
    overflow-y: auto;
  }
  textarea::placeholder { color: var(--fg-4); }
  textarea:focus { outline: none; }

  .menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    right: 0;
    background: var(--surface);
    border: 1px solid var(--border-hi);
    border-radius: var(--r-3);
    box-shadow: var(--shadow-md), 0 24px 60px -24px rgba(0, 0, 0, 0.55);
    max-height: 360px;
    overflow-y: auto;
    z-index: 10;
    padding: 6px 0 0;
    animation: menu-fade-in 120ms var(--ease) both;
  }
  .menu.glass {
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    background: color-mix(in oklab, var(--surface) 82%, transparent);
  }
  @keyframes menu-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .menu-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 6px;
    font-size: 12.5px;
    color: var(--fg-4);
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  .menu-head + .menu-head { margin-top: 4px; }
  .menu-head-ico { display: inline-flex; align-items: center; color: var(--accent); }
  .menu-head-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 700;
    font-size: 11px;
    line-height: 1;
  }
  .menu-head-label { font-weight: 600; }
  .menu-head-rule {
    flex: 1;
    height: 1px;
    background: linear-gradient(to right, var(--line), transparent);
  }
  .menu-item {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    color: var(--fg);
    padding: 8px 14px;
    cursor: pointer;
    display: grid;
    grid-template-columns: minmax(140px, max-content) 1fr max-content;
    gap: 14px;
    font: inherit;
    font-size: 16px;
    align-items: baseline;
    transition: background var(--dur-1) var(--ease);
    position: relative;
  }
  .menu-item:hover, .menu-item.active {
    background: var(--accent-soft);
  }
  .menu-item.active {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .m-id {
    color: var(--accent);
    font-weight: 600;
    font-size: 15.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m-args {
    color: var(--fg-4);
    font-weight: 400;
  }
  .m-desc {
    color: var(--fg-3);
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
  .m-kbd {
    font-size: 11.5px;
    color: var(--fg-4);
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    line-height: 1.4;
    opacity: 0.7;
    transition: opacity var(--dur-1) var(--ease);
  }
  .menu-item.active .m-kbd {
    opacity: 1;
    color: var(--accent);
    border-color: var(--accent-line);
  }
  .menu-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    margin-top: 4px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--fg-4);
    letter-spacing: 0.04em;
  }
  .menu-foot .sep { color: var(--fg-4); opacity: 0.5; }
  .menu-empty {
    padding: 18px 14px;
    font-size: 14px;
    color: var(--fg-3);
    text-align: center;
  }
  .menu-empty .m-q { color: var(--accent); font-weight: 600; }

  .row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 6px;
  }
  .hint { font-size: 14.5px; color: var(--fg-3); display: inline-flex; gap: 4px; align-items: center; flex-wrap: wrap; }
  .hint-sep { color: var(--fg-4); margin: 0 4px; }

  /* Worker X: mic button + recording pulse */
  .mic {
    margin-left: auto;
    background: var(--surface);
    color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
  }
  .mic:hover:not(.mic-unsupported) {
    background: var(--elevated);
    color: var(--fg);
  }
  .mic.recording {
    background: color-mix(in oklab, #e53935 18%, transparent);
    border-color: #e53935;
    color: #e53935;
    animation: mic-pulse 1.2s ease-in-out infinite;
  }
  .mic.mic-unsupported {
    opacity: 0.45;
    cursor: not-allowed;
  }
  @keyframes mic-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(229, 57, 53, 0.35); }
    50% { box-shadow: 0 0 0 6px rgba(229, 57, 53, 0); }
  }
  .voice-interim {
    padding: 0 6px;
    font-size: 14px;
    color: var(--fg-4);
    font-style: italic;
    opacity: 0.8;
  }

  .send {
    border: 0;
    border-radius: var(--r-2);
    padding: 8px 16px;
    font: inherit;
    font-weight: 600;
    font-size: 16px;
    cursor: pointer;
    transition: filter var(--dur-1) var(--ease);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--accent);
    color: oklch(0.16 0.04 75);
  }
  .send:hover:not(:disabled) { filter: brightness(1.08); }
  .send:disabled { opacity: 0.4; cursor: not-allowed; background: var(--elevated); color: var(--fg-3); }

  .composer.drag-over .frame {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .drop-hint {
    position: absolute;
    top: 8px;
    right: 22px;
    font-size: 14.5px;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 3px 8px;
    border-radius: var(--r-2);
    pointer-events: none;
    z-index: 3;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    font-size: 15.5px;
    color: var(--fg-2);
    max-width: 280px;
  }
  .chip.ok { border-color: var(--accent-line); }
  .chip.err { border-color: var(--danger); color: var(--danger); }
  .chip .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }
  .chip .size {
    color: var(--fg-4);
    font-size: 13.5px;
  }
  .chip .check { display: inline-flex; align-items: center; color: var(--accent); }
  .chip .cross { display: inline-flex; align-items: center; color: var(--danger); }
  .send-ico { display: inline-flex; align-items: center; }
  .chip .retry, .chip .remove {
    background: transparent;
    border: 0;
    color: var(--fg-3);
    cursor: pointer;
    padding: 0 2px;
    font: inherit;
    font-size: 16px;
    line-height: 1;
  }
  .chip .retry:hover, .chip .remove:hover { color: var(--fg); }
  .spinner {
    width: 10px;
    height: 10px;
    border: 1.5px solid var(--border-hi);
    border-top-color: var(--accent);
    border-radius: 50%;
    display: inline-block;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .warn {
    font-size: 14.5px;
    color: var(--fg-3);
    padding: 0 6px;
  }
</style>
