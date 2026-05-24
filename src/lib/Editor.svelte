<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher, tick } from "svelte";
  import { EditorState, Compartment } from "@codemirror/state";
  import { EditorView, keymap, highlightActiveLine, lineNumbers } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
  import {
    syntaxHighlighting,
    defaultHighlightStyle,
    bracketMatching,
    indentOnInput,
  } from "@codemirror/language";
  import { oneDark } from "@codemirror/theme-one-dark";

  import {
    editorTabs,
    loadLanguage,
    type EditorTab,
  } from "./editorTabs";
  import { settings } from "./settings";

  const dispatch = createEventDispatcher<{ toast: string }>();

  let host: HTMLDivElement;
  let view: EditorView | null = null;
  /** Cached EditorState per tab so we preserve history/cursor across switches. */
  const stateCache = new Map<string, EditorState>();
  /** The path currently mounted in `view`. */
  let mountedPath: string | null = null;
  /** Tracks tabs we've ever seen, to clean up cached state when closed. */
  const knownPaths = new Set<string>();

  // Theme compartment so we can hot-swap on settings change.
  const themeCompartment = new Compartment();
  // Language compartment lets us swap the language extension lazily after the
  // chunk for `lang-<x>` finishes loading, without rebuilding EditorState.
  const languageCompartment = new Compartment();

  $: state = $editorTabs;
  $: activeTab = state.openTabs.find((t) => t.path === state.activeTab) ?? null;

  function readThemeTokens() {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    return {
      bg: cs.getPropertyValue("--bg").trim() || "#1e1e1e",
      surface: cs.getPropertyValue("--surface").trim() || "#252525",
      fg: cs.getPropertyValue("--fg").trim() || "#e6e6e6",
      fg3: cs.getPropertyValue("--fg-3").trim() || "#888",
      fg4: cs.getPropertyValue("--fg-4").trim() || "#666",
      accent: cs.getPropertyValue("--accent").trim() || "#88c",
      border: cs.getPropertyValue("--border").trim() || "#333",
    };
  }

  function buildThemeExtension() {
    const t = readThemeTokens();
    const overrides = EditorView.theme(
      {
        "&": {
          backgroundColor: t.bg,
          color: t.fg,
          height: "100%",
        },
        ".cm-scroller": {
          fontFamily:
            "var(--font-mono, 'JetBrains Mono', SF Mono, Menlo, monospace)",
          fontSize: "13px",
          lineHeight: "1.5",
        },
        ".cm-content": {
          caretColor: t.accent,
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: t.accent,
        },
        ".cm-gutters": {
          backgroundColor: t.bg,
          color: t.fg4,
          border: "none",
          borderRight: `1px solid ${t.border}`,
        },
        ".cm-activeLine": {
          backgroundColor: t.surface,
        },
        ".cm-activeLineGutter": {
          backgroundColor: t.surface,
          color: t.fg3,
        },
        "&.cm-focused .cm-selectionBackground, ::selection, .cm-selectionBackground": {
          backgroundColor: `color-mix(in srgb, ${t.accent} 22%, transparent)`,
        },
      },
      { dark: true },
    );
    return [oneDark, overrides];
  }

  function baseExtensions(tab: EditorTab) {
    return [
      lineNumbers(),
      history(),
      bracketMatching(),
      indentOnInput(),
      highlightActiveLine(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      // Start with no language; `applyLanguage` swaps in the lazy chunk when ready.
      languageCompartment.of([]),
      themeCompartment.of(buildThemeExtension()),
      keymap.of([
        // Cmd/Ctrl+S to save (handled here so it works while editor is focused)
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void handleSave();
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && mountedPath) {
          editorTabs.updateContent(mountedPath, u.state.doc.toString());
        }
      }),
      EditorView.lineWrapping,
    ];
  }

  /** Last language we asked the compartment to render, per mounted path. */
  const appliedLanguage = new Map<string, string>();

  /**
   * Load the language chunk for `tab` (if not already cached) and apply it
   * to the live EditorView via the language compartment. Safe to call
   * repeatedly; the load result is cached in `editorTabs.loadLanguage`.
   */
  async function applyLanguage(tab: EditorTab) {
    const lang = tab.language;
    const already = appliedLanguage.get(tab.path);
    if (already === lang) return;
    const ext = await loadLanguage(lang);
    // The user may have switched tabs while the chunk was loading; only apply
    // if the same tab is still mounted with the same language.
    if (mountedPath !== tab.path) return;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.reconfigure(ext ?? []),
    });
    appliedLanguage.set(tab.path, lang);
  }

  function buildState(tab: EditorTab): EditorState {
    return EditorState.create({
      doc: tab.content,
      extensions: baseExtensions(tab),
    });
  }

  function mountTab(tab: EditorTab) {
    if (!host) return;
    if (mountedPath === tab.path) return;
    // Save the current state for the previously mounted tab.
    if (view && mountedPath) {
      stateCache.set(mountedPath, view.state);
    }
    if (!view) {
      view = new EditorView({
        state: stateCache.get(tab.path) ?? buildState(tab),
        parent: host,
      });
      stateCache.set(tab.path, view.state);
      mountedPath = tab.path;
      knownPaths.add(tab.path);
      void applyLanguage(tab);
      return;
    }
    const cached = stateCache.get(tab.path) ?? buildState(tab);
    view.setState(cached);
    stateCache.set(tab.path, view.state);
    mountedPath = tab.path;
    knownPaths.add(tab.path);
    void applyLanguage(tab);
  }

  function unmount() {
    if (view) {
      view.destroy();
      view = null;
    }
    mountedPath = null;
  }

  async function handleSave() {
    try {
      const result = await editorTabs.saveActive();
      if (result) dispatch("toast", `Saved ${result.name}`);
    } catch (err) {
      dispatch(
        "toast",
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Reactively mount the active tab when it becomes loaded.
  // We also clean up cached states for tabs that have been closed.
  $: if (host && activeTab && activeTab.loaded && !activeTab.error) {
    if (mountedPath !== activeTab.path) {
      mountTab(activeTab);
    }
  }

  // If the active tab no longer exists (all tabs closed), tear down the view.
  $: if (host && !activeTab && view) {
    unmount();
  }

  // Prune cached state for tabs no longer open.
  $: {
    const openSet = new Set(state.openTabs.map((t) => t.path));
    for (const p of [...knownPaths]) {
      if (!openSet.has(p)) {
        stateCache.delete(p);
        knownPaths.delete(p);
        appliedLanguage.delete(p);
      }
    }
  }

  // Re-apply theme when the user changes themes via settings.
  let lastTheme: string | undefined;
  $: if (view && $settings.theme && $settings.theme !== lastTheme) {
    // Wait one tick so the [data-theme] attribute is applied to the document.
    lastTheme = $settings.theme;
    void tick().then(() => {
      view?.dispatch({
        effects: themeCompartment.reconfigure(buildThemeExtension()),
      });
    });
  }

  // Global keyboard shortcut so Cmd/Ctrl+S works even when the editor isn't focused.
  function onWindowKeydown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === "s" || e.key === "S")) {
      // Only intercept when an editor tab is active; otherwise let other handlers see it.
      if (activeTab) {
        e.preventDefault();
        void handleSave();
      }
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onWindowKeydown, true);
  });

  onDestroy(() => {
    window.removeEventListener("keydown", onWindowKeydown, true);
    unmount();
    stateCache.clear();
    knownPaths.clear();
    appliedLanguage.clear();
  });
</script>

<div class="editor-root">
  {#if !activeTab}
    <div class="empty mono">
      <span class="hint">No file open</span>
      <span class="sub">Open a file from the workspace tree to begin editing.</span>
    </div>
  {:else if activeTab.error}
    <div class="error mono">
      Failed to load <strong>{activeTab.name}</strong>: {activeTab.error}
    </div>
  {:else if !activeTab.loaded}
    <div class="empty mono">
      <span class="hint">loading {activeTab.name}…</span>
    </div>
  {/if}
  <div
    class="cm-host"
    class:hidden={!activeTab || !activeTab.loaded || !!activeTab.error}
    bind:this={host}
  ></div>
</div>

<style>
  .editor-root {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    overflow: hidden;
    background: var(--bg);
  }
  .cm-host {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
  }
  .cm-host.hidden {
    display: none;
  }
  /* CodeMirror itself is positioned by its own layout; we just need it to fill. */
  :global(.cm-host > .cm-editor) {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    width: 100%;
    height: 100%;
  }

  .empty,
  .error {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--fg-3);
    font-size: 15.5px;
    padding: 24px;
    text-align: center;
  }
  .empty .sub {
    color: var(--fg-4);
    font-size: 14.5px;
  }
  .error {
    color: var(--danger, var(--accent));
  }
</style>
