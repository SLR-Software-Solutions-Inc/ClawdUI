<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { type UnlistenFn } from "@tauri-apps/api/event";
  import { safeInvoke, safeListen } from "./safeInvoke";
  import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import "@xterm/xterm/css/xterm.css";

  export let cwd: string | undefined = undefined;
  export let shell: string | undefined = undefined;

  let host: HTMLDivElement;
  let term: XTerm | null = null;
  let fitAddon: FitAddon | null = null;
  let sessionId: string | null = null;
  let unlistenData: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let themeObserver: MutationObserver | null = null;
  let pendingResize: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function readVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  }

  function buildTheme(): ITheme {
    return {
      background: readVar("--bg", "#0a0a0c"),
      foreground: readVar("--fg", "#e6e6e8"),
      cursor: readVar("--accent", "#7aa2f7"),
      cursorAccent: readVar("--bg", "#0a0a0c"),
      selectionBackground: readVar("--elevated", "#22222a"),
    };
  }

  function applyTheme() {
    if (!term) return;
    term.options.theme = buildTheme();
  }

  function scheduleFit() {
    if (pendingResize) clearTimeout(pendingResize);
    pendingResize = setTimeout(() => {
      pendingResize = null;
      if (!term || !fitAddon || disposed) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      if (sessionId) {
        const { rows, cols } = term;
        void safeInvoke("pty_resize", { id: sessionId, rows, cols }).catch(() => {});
      }
    }, 30);
  }

  onMount(async () => {
    term = new XTerm({
      fontFamily:
        "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: buildTheme(),
      scrollback: 5000,
      convertEol: false,
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fitAddon.fit();

    const { rows, cols } = term;
    try {
      sessionId = await safeInvoke<string>("pty_spawn", {
        rows,
        cols,
        cwd,
        shell,
      });
    } catch (err) {
      term.write(`\r\n\x1b[31mpty_spawn failed: ${err}\x1b[0m\r\n`);
      return;
    }
    if (!sessionId) {
      term.write(
        `\r\n\x1b[2m[terminal unavailable in browser preview]\x1b[0m\r\n`,
      );
      return;
    }

    unlistenData = await safeListen<{ data: string }>(
      `pty-data:${sessionId}`,
      (e) => {
        term?.write(e.payload.data);
      },
    );
    unlistenExit = await safeListen<{ code: number | null }>(
      `pty-exit:${sessionId}`,
      (e) => {
        const code = e.payload.code;
        term?.write(
          `\r\n\x1b[2m[process exited${
            code === null ? "" : ` with code ${code}`
          }]\x1b[0m\r\n`,
        );
        sessionId = null;
      },
    );

    term.onData((data) => {
      if (!sessionId) return;
      void safeInvoke("pty_write", { id: sessionId, data }).catch(() => {});
    });

    resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(host);

    // React to theme switches by re-reading CSS variables.
    themeObserver = new MutationObserver(() => applyTheme());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });

    term.focus();
  });

  onDestroy(() => {
    disposed = true;
    if (pendingResize) clearTimeout(pendingResize);
    unlistenData?.();
    unlistenExit?.();
    resizeObserver?.disconnect();
    themeObserver?.disconnect();
    if (sessionId) {
      void safeInvoke("pty_kill", { id: sessionId }).catch(() => {});
      sessionId = null;
    }
    term?.dispose();
    term = null;
  });

  export function focus() {
    term?.focus();
  }

  export function refit() {
    scheduleFit();
  }
</script>

<div class="terminal-host" bind:this={host}></div>

<style>
  .terminal-host {
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--bg);
    padding: 8px 10px;
    box-sizing: border-box;
    overflow: hidden;
  }
  .terminal-host :global(.xterm) {
    height: 100%;
    width: 100%;
  }
  .terminal-host :global(.xterm-viewport) {
    background: transparent !important;
  }
</style>
