<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { type UnlistenFn } from "@tauri-apps/api/event";
  import { safeInvoke, safeListen } from "./lib/safeInvoke";
  import SystemBanner from "./lib/SystemBanner.svelte";
  import {
    setSidecarState,
    pills as systemPills,
    bannerNotice,
  } from "./lib/systemStatus";

  import ActivityBar from "./lib/ActivityBar.svelte";
  import type { ActivityItem } from "./lib/activity";
  import SidePane from "./lib/SidePane.svelte";
  import WorkspacePanel from "./lib/WorkspacePanel.svelte";
  import SessionsPanel from "./lib/SessionsPanel.svelte";
  import WorktreesPanel from "./lib/WorktreesPanel.svelte";
  import SettingsPanel from "./lib/SettingsPanel.svelte";
  import MemoryViewer from "./lib/MemoryViewer.svelte";
  // Worker T: hooks debugger overlay.
  import HooksDebugger from "./lib/HooksDebugger.svelte";
  import AuthPanel from "./lib/AuthPanel.svelte";
  import DoctorPanel from "./lib/DoctorPanel.svelte";
  import UpdatePanel from "./lib/UpdatePanel.svelte";
  import UltrareviewPanel from "./lib/UltrareviewPanel.svelte";
  import HUD from "./lib/HUD.svelte";
  import ModelPicker from "./lib/ModelPicker.svelte";
  import PermissionPicker from "./lib/PermissionPicker.svelte";
  import Composer from "./lib/Composer.svelte";
  import EmptyState from "./lib/EmptyState.svelte";
  import MessageBlock from "./lib/MessageBlock.svelte";
  import Terminal from "./lib/Terminal.svelte";
  import PermissionPrompt from "./lib/PermissionPrompt.svelte";
  import SkillsPanel from "./lib/SkillsPanel.svelte";
  import EditorTabs from "./lib/EditorTabs.svelte";
  import Editor from "./lib/Editor.svelte";
  import PrPicker from "./lib/PrPicker.svelte";
  import RemoteControlPanel from "./lib/RemoteControlPanel.svelte";
  import MobilePair from "./lib/MobilePair.svelte";
  import AgentTabs from "./lib/AgentTabs.svelte";
  import AgentDrawer from "./lib/AgentDrawer.svelte";
  import FleetView from "./lib/FleetView.svelte";
  import Onboarding from "./lib/Onboarding.svelte";
  import SigninGate from "./lib/SigninGate.svelte";
  import DonateButton from "./lib/DonateButton.svelte";
  import TokenTag from "./lib/TokenTag.svelte";
  import CommandPalette from "./lib/CommandPalette.svelte";
  import type { ThemeId } from "./lib/themes";
  type Command = {
    id: string;
    title: string;
    detail?: string;
    keywords?: string[];
    shortcut?: string;
    run: () => void | Promise<void>;
  };
  import { openDonatePage } from "./lib/donate";
  import {
    Sparkles,
    Terminal as TerminalIcon,
    ChevronDown,
    ChevronRight,
    X as XIcon,
    Folder,
    MessageSquare,
    GitBranch,
    Settings as SettingsIcon,
    Key,
    Stethoscope,
    Download,
    ScanSearch,
    Radio,
    LifeBuoy,
    Plus,
    Heart,
    ListTree,
    Webhook,
  } from "./lib/icons";
  import {
    addAgent,
    setAgentStatus,
    setTranscript,
    resetAgents,
    getAgent,
    registerSpawnToolUse,
    isSpawnToolUseId,
    getSpawnChildId,
    registerSdkAgentToolUse,
    completeSdkAgentToolUse,
    setDrawerActiveId,
    setDrawerOpen,
    getDrawerOpen,
    onAgentCancelRequested,
    updateAgentTokens,
  } from "./lib/agents.svelte";
  import { rpcCall } from "./lib/sidecarRpc";

  import { authSignedIn, authStatus, refreshClaudePath } from "./lib/cli";
  import { editorTabs } from "./lib/editorTabs";
  import {
    settings,
    settingsLoaded,
    getSettings,
    settingsToSDKOptions,
    hydrateSettings,
    flushSettings,
    patchSettings,
  } from "./lib/settings";
  import type { PR } from "./lib/prList";
  import {
    addUsage,
    endSessionStats,
    markFirstAssistantToken,
    markTurnSent,
    normalizeSdkUsage,
    resetSessionStats,
    settleTurn,
    stats,
  } from "./lib/stats";
  import {
    contextWindowFor,
    hydrateModelContextWindows,
    modelContextWindows,
    recordModelContextWindows,
  } from "./lib/modelContextWindow";
  import { permissions, type PermissionDecision } from "./lib/permissions.svelte";
  import { refreshSkills } from "./lib/skills";
  import { refresh as refreshSessions, fork as forkSessionRpc } from "./lib/sessions";
  import {
    chatWindow,
    resetChatWindow,
    loadInitialWindow,
    loadMoreWindow,
  } from "./lib/chat-window";
  // Worker Z: checkpoint + fork primitives. CheckpointDrawer is the UI;
  // registerCheckpointHandlers wires the messages[] array (owned here)
  // to the public API consumed by Worker U's /undo + /fork slash commands.
  import CheckpointDrawer from "./lib/CheckpointDrawer.svelte";
  import {
    registerCheckpointHandlers,
    autoCheckpoint,
    clearCheckpoints,
    undoLastCheckpoint,
    forkSession as forkSessionCheckpoint,
  } from "./lib/checkpoints";
  // Worker U: surfaces for /commit, /init, /feedback slash commands.
  import CommitModal from "./lib/CommitModal.svelte";
  import InitWizard from "./lib/InitWizard.svelte";
  import FeedbackModal from "./lib/FeedbackModal.svelte";
  import { list as refreshWorktrees } from "./lib/worktrees";
  import { SETTING_FIELDS, type SettingField, type ChatMessage } from "./lib/types";

  type PermissionRequestEvent = {
    id: string;
    type: "permission_request";
    request_id: string;
    tool_name: string;
    input: Record<string, unknown>;
    suggestions?: unknown[];
    tool_use_id?: string;
    session_id: string | null;
    title?: string;
    description?: string;
    blocked_path?: string;
  };

  type SidecarEvent =
    | { id: string; type: "pong"; session_id?: string }
    | { id: string; type: "ack"; session_id?: string }
    | { id: string; type: "session_started"; session_id?: string }
    | { id: string; type: "session_id"; session_id: string }
    | { id: string; type: "message"; message: any; session_id?: string }
    | { id: string; type: "session_ended"; session_id?: string }
    | { id: string; type: "result"; value: unknown; session_id?: string }
    | {
        id: string;
        type: "hook_test_result";
        stdout?: string;
        stderr?: string;
        exit?: number;
        error?: string;
      }
    | {
        id: string;
        type: "remote_control_state";
        state: "disconnected" | "connecting" | "live" | "error";
        sessionName?: string;
        forwarded: number;
        error?: string;
      }
    | {
        id: string;
        type: "mobile_pair_url";
        session_id: string;
        url: string;
        via?: "slash" | "sdk";
      }
    | {
        id: string;
        type: "mobile_pair_error";
        session_id: string;
        error: string;
        via?: "slash" | "sdk";
      }
    | { id: string; type: "error"; error: string; session_id?: string }
    | {
        id: string;
        type: "child_done";
        session_id: string;
        parent_id: string;
        summary: string;
        total_cost_usd: number;
        message_count: number;
      }
    | {
        id: string;
        type: "agent_tokens";
        session_id: string;
        input: number;
        output: number;
        cache_read?: number;
        cache_creation?: number;
      }
    | PermissionRequestEvent;

  let messages: ChatMessage[] = [];
  // Main-chat visibility gate. The main scrollback renders only the
  // "natural conversation":
  //   - user prompts (always — even empty/preamble-only prompts still
  //     produce a "user-said" bubble so legitimate sends aren't hidden)
  //   - assistant turns that contain at least one text block (so a
  //     tool-only turn doesn't render an empty bubble; the "agent
  //     working · MM:SS" pill covers that visual state)
  // Tool calls, results, thinking, hooks, DELEGATED / CHILD-RETURNED
  // chips all live in the bottom AgentDrawer / FleetView instead.
  function isVisibleInMainChat(msg: ChatMessage): boolean {
    if (msg.role === "user") return true;
    if (msg.role === "assistant") {
      // Streaming assistant turns can have an empty text block briefly
      // before the first chunk arrives — still keep the bubble so
      // streaming text appears as it comes in. We accept any text block
      // (empty or not) here, but reject turns with zero text blocks.
      return (msg.blocks ?? []).some((b) => b.type === "text");
    }
    return false; // drop system + tool-only role rows from main chat
  }
  let busy = false;
  // Phase B paginated lazy load. On resume the sidecar streams the LAST
  // INITIAL_LIMIT (500) jsonl entries into `resumeBuffer`. Once committed,
  // older history is fetched on demand via fetch_session_window when the
  // user scrolls to the top sentinel (chat-window store + IntersectionObserver
  // — see loadMoreOlder() / setupTopObserver() below). No background
  // backfill; the DOM grows only as the user scrolls. This replaces the
  // Phase A "RESUME_BACKFILL_CHUNK + setTimeout(0)" eager-prefetch model
  // which couldn't keep up on 33k-msg sessions.
  let resumeBuffering = false;
  let resumeBuffer: ChatMessage[] = [];
  const RESUME_INITIAL_LIMIT = 500;
  const RESUME_OLDER_PAGE_LIMIT = 100;
  /** Active write target — flipped during resume replay. */
  function msgsTarget(): ChatMessage[] {
    return resumeBuffering ? resumeBuffer : messages;
  }
  // When non-null, the next send() rewrites messages[editingIndex] with the
  // composer text (and drops everything after) instead of appending a new
  // user message. Lets the user revise a prior prompt without restarting
  // the session.
  let editingIndex: number | null = null;

  // Pending follow-up prompts entered while a turn is in flight. Drained
  // FIFO on every finalize() until empty. Each entry has a stable id so
  // the visible queued bubble's cancel button can remove the right one.
  type QueuedPrompt = {
    id: string;
    text: string;
    files: { fileId: string; mime?: string; name?: string }[];
  };
  let promptQueue: QueuedPrompt[] = [];
  // Context-window compaction trigger. Limit is derived per-model so 1M
  // variants (Opus 4.7, Sonnet 4.6) don't get nudged at <20% of real
  // capacity. At 90% we *ask* master to compact (send a prompt). At ≥98%
  // we *force* it by sending `/compact` directly. One-shot per session.
  //
  // Source of truth: SDK `result.modelUsage[<id>].contextWindow`, harvested
  // by recordModelContextWindows() into the modelContextWindows store. The
  // hardcoded fallback table in modelContextWindow.ts is only consulted
  // until the first turn lands for a given model.
  function contextLimitForModel(modelId: string | undefined): number {
    return contextWindowFor(modelId);
  }
  let compactSuggested = false;
  let compactForced = false;
  let sessionStarted = false;
  let sessionId: string | null = null;
  let sessionStartedAt: number | null = null;
  let sidecarState: "idle" | "connecting" | "connected" | "error" = "idle";
  // Mirror into the shared systemStatus store so the SystemBanner +
  // statusbar pills react to lifecycle changes without each component
  // listening to sidecar-event directly.
  $: setSidecarState(sidecarState);
  // Worker AN: collapsed health surface for the topbar. Renders nothing when
  // sidecar is connected AND CLI is detected (the silent-green default).
  // Otherwise picks the worst signal and presents a single compact pill that
  // opens the Doctor pane for per-condition detail + actions. The tauri pill
  // is intentionally omitted: SystemBanner already shouts about browser-preview
  // mode, and in the native build the answer is always "yes".
  $: healthIssue = (() => {
    const sc = $systemPills.sidecar.state;
    const cli = $systemPills.cli.state;
    // ok=healthy, idle=not-yet-probed (silent), warn/error=surface
    let scBad = sc === "warn" || sc === "error";
    let cliBad = cli === "warn" || cli === "error";
    // Dedupe with the top SystemBanner: if the banner is currently
    // shouting about the SAME signal (sidecarOffline / cliMissing), drop
    // it from the pill so the topbar doesn't double-report. The banner
    // is more discoverable (text + Install/Diagnose action), so it wins;
    // the pill is a silent at-a-glance fallback for conditions the
    // banner isn't currently surfacing (e.g. user dismissed it, or
    // banner is showing a higher-priority notice).
    const bannerKey = $bannerNotice?.key;
    if (bannerKey === "sidecarOffline") scBad = false;
    if (bannerKey === "cliMissing") cliBad = false;
    if (!scBad && !cliBad) return null;
    // Worst-signal selection: sidecar error > cli error > sidecar warn > cli warn.
    const tone: "amber" | "red" =
      (scBad && sc === "error") || (cliBad && cli === "error") ? "red" : "amber";
    const parts: string[] = [];
    if (scBad) parts.push(`Sidecar ${$systemPills.sidecar.label}`);
    if (cliBad) parts.push(`CLI ${cli === "error" ? "missing" : "?"}`);
    const label = parts.length === 1 ? parts[0] : "issues";
    return {
      tone,
      label,
      aria: `System status: ${parts.join(", ")}. Open Doctor for detail.`,
      title: parts.join(" · ") + " — click to open Doctor.",
    };
  })();
  // Human-readable explanation shown when the composer is disabled — surfaces
  // through the textarea + send button title attributes. Without this the
  // input greys out with zero context (the original ui_test_log complaint).
  $: composerDisabledReason = !sessionStarted
    ? sidecarState === "error"
      ? "Sidecar offline — chat unavailable. Open Doctor to diagnose."
      : sidecarState === "connecting"
        ? "Sidecar connecting — chat available once the session starts."
        : sidecarState === "idle"
          ? $systemPills.tauri.state === "warn"
            ? "Browser preview mode — chat requires the native build."
            : "Sidecar not connected — chat unavailable."
          : "Session not started yet."
    : null;
  let stderrLines: string[] = [];

  // Watchdog: track per-turn timing so we can show elapsed time and surface
  // a Force-stop escape after a long idle. We DON'T call this "stalled" in
  // the UI any more — long-running tool chains are normal in agent work and
  // alarming language confused users. The threshold (>60s idle) only gates
  // the Force-stop button + sidecar-log toggle; the elapsed timer reads
  // "agent working · MM:SS" the whole time.
  let turnStartAt: number | null = null;
  let lastEventAt: number | null = null;
  let nowTick: number = Date.now();
  let stalledOpen = false;
  const STALL_MS = 60_000;
  $: busyMs = busy && turnStartAt ? nowTick - turnStartAt : 0;
  $: idleMs = busy && lastEventAt ? nowTick - lastEventAt : 0;
  function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
  }

  // VS Code-style activity bar state
  // Default: workspace pane open on first launch so the chrome is visible.
  let leftActive: string | null = "workspace";
  let rightActive: string | null = null;
  // Fleet View — promoted multi-agent surface. When true, the main pane's
  // chat-stack is replaced by the FleetView mission-control dashboard.
  // Main chat is preserved (toggle off to return). AgentDrawer remains
  // available regardless of this flag.
  let fleetView = false;
  let ultrareviewTarget: string | undefined = undefined;
  let prPickerOpen = false;
  // legacy modal flags retained where still used as overlays.
  let skillsOpen = false;
  let commandPaletteOpen = false;
  // Settings opens as a full-window overlay (not as a side pane).
  let settingsOpen = false;
  // Worker AE: responsive — on mobile (<=640px) the activity bars are hidden by
  // default and surface as overlay drawers via a hamburger button in the topbar.
  // `mobileNav` controls which overlay is visible: "left" | "right" | null.
  let mobileNav: "left" | "right" | null = null;
  // Memory viewer + bindable ModelPicker open (driven by /memory and /model
  // slash commands respectively).
  let memoryOpen = false;
  let modelPickerOpen = false;
  // Worker T: HooksDebugger overlay (opened via /hooks slash + left activity bar).
  let hooksDebuggerOpen = false;
  // Worker Z: CheckpointDrawer open state (opened via topbar button + /checkpoints).
  let checkpointDrawerOpen = false;
  // Worker U: state for the new slash-command surfaces.
  let planMode = false;
  let permissionsOpen = false;
  let initWizardOpen = false;
  let commitOpen = false;
  let feedbackOpen = false;
  // Derive a one-line summary of the last assistant message; used to
  // pre-fill the commit modal's subject so the user doesn't start blank.
  $: commitSuggestion = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const txt = m.blocks
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text as string)
        .join(" ")
        .trim();
      if (txt) return txt.split(/\r?\n/)[0].slice(0, 72);
    }
    return "";
  })();
  let rcState: "disconnected" | "connecting" | "live" | "error" =
    "disconnected";
  let rcForwarded = 0;
  let rcError: string | null = null;
  type ToastItem = {
    id: number;
    msg: string;
    kind: "info" | "error";
    timer: ReturnType<typeof setTimeout> | null;
  };
  let toasts: ToastItem[] = [];
  let nextToastId = 1;
  let toastsExpanded = false;
  const MAX_VISIBLE_TOASTS = 5;
  $: visibleToasts = toastsExpanded
    ? toasts
    : toasts.slice(-MAX_VISIBLE_TOASTS);
  $: hiddenToastCount = Math.max(0, toasts.length - visibleToasts.length);
  // First-run onboarding tour overlay state.
  let onboardingOpen = false;
  let scrollEl: HTMLDivElement;
  let composer: Composer;
  let mobilePair: MobilePair | null = null;

  let activeModel: string | undefined = undefined;

  let unlistenEvent: UnlistenFn | null = null;
  let unlistenStderr: UnlistenFn | null = null;

  // Lightweight pub/sub for components (e.g. MobilePair) that want to
  // observe sidecar events without each component reaching into Tauri's
  // global listener.
  type SidecarEventListener = (ev: SidecarEvent) => void;
  const sidecarEventBus: Set<SidecarEventListener> = new Set();
  function subscribeSidecarEvent(cb: SidecarEventListener): () => void {
    sidecarEventBus.add(cb);
    return () => sidecarEventBus.delete(cb);
  }
  function fanoutSidecarEvent(ev: SidecarEvent): void {
    for (const cb of sidecarEventBus) {
      try { cb(ev); } catch { /* ignore listener errors */ }
    }
  }

  // --- Native terminal pane ---
  let terminalOpen = false;
  let terminalHeight = getSettings().terminalHeight ?? 260; // px
  let dragStartY = 0;
  let dragStartHeight = 0;
  let dragging = false;

  // --- Editor pane / chat split ---
  // editorRatio = fraction of vertical chat-area space that the editor occupies
  // when at least one file is open. 0.55 → editor 55%, chat 45%.
  let editorRatio = getSettings().editorRatio ?? 0.55;
  let splitDragStartY = 0;
  let splitStartRatio = 0.55;
  let splitDragging = false;
  let chatColEl: HTMLDivElement;

  // Persist layout tweaks back to settings.json (debounced via patchSettings).
  // Only fires once settings are hydrated to avoid clobbering on-disk
  // values with the in-memory defaults during boot.
  let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let layoutHydrated = false;
  $: if ($settingsLoaded && !layoutHydrated) {
    if (typeof $settings.terminalHeight === "number") terminalHeight = $settings.terminalHeight;
    if (typeof $settings.editorRatio === "number") editorRatio = $settings.editorRatio;
    layoutHydrated = true;
  }
  function persistLayout(): void {
    if (!layoutHydrated) return;
    if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
    layoutPersistTimer = setTimeout(() => {
      patchSettings({ terminalHeight, editorRatio });
    }, 400);
  }
  $: { terminalHeight; editorRatio; persistLayout(); }

  /**
   * Context-window watchdog.
   *
   * Reads the MOST RECENT assistant message's usage (`lastMessageUsage`) —
   * NOT the per-turn cumulative `usage`. Each assistant message's
   * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
   * represents the FULL prompt size at that step. A turn with N tool-call
   * steps would produce N such messages; summing them overcounts the real
   * context footprint by ~Nx and made the pill read 127% after one turn.
   *
   * Thresholds (compared against per-model contextLimit):
   *   ≥ 0.90 → prompt master to summarize / `/compact` proactively.
   *   ≥ 0.98 → send `/compact` directly so the next turn isn't truncated.
   *
   * Each threshold fires once per session; reset on newSession().
   */
  $: contextUsedTokens =
    ($stats.turn.lastMessageUsage.input ?? 0) +
    ($stats.turn.lastMessageUsage.cacheRead ?? 0) +
    ($stats.turn.lastMessageUsage.cacheCreation ?? 0);
  // Prefer the model id the sidecar reports for the current session; fall
  // back to the configured model so the limit is right before first turn.
  // The `$modelContextWindows && …` guard subscribes to the store so the
  // limit updates the moment the SDK reports a real value via
  // recordModelContextWindows() (store object is always truthy; the read
  // is purely to establish the reactive dependency).
  $: contextLimit =
    $modelContextWindows && contextLimitForModel(activeModel || $settings.model);
  $: contextFraction = contextUsedTokens / contextLimit;
  // Worker T pill — derive display strings reactively (was {@const} but those need block-parent in Svelte 5)
  $: compactPillTokK = contextUsedTokens > 0 ? (contextUsedTokens / 1000).toFixed(contextUsedTokens >= 10000 ? 0 : 1) : null;
  $: compactPillLimK = (contextLimit / 1000).toFixed(0);
  $: compactPillPct = contextLimit > 0 ? Math.round(contextFraction * 100) : 0;
  $: compactPillTone = compactPillPct >= 85 ? "red" : compactPillPct >= 60 ? "amber" : "green";
  $: if (sessionStarted && !busy && contextFraction >= 0.98 && !compactForced) {
    compactForced = true;
    compactSuggested = true;
    showToast(
      `Context ≥ 98% (${Math.round(contextFraction * 100)}%). Auto-running /compact to summarize prior turns.`,
      "error",
    );
    void send({ text: "/compact", files: [] });
  } else if (
    sessionStarted &&
    !busy &&
    contextFraction >= 0.9 &&
    !compactSuggested
  ) {
    compactSuggested = true;
    showToast(
      `Context at ${Math.round(contextFraction * 100)}%. Suggesting compaction.`,
      "info",
    );
    void send({
      text: "Conversation is approaching the context limit. Please run /compact to summarize earlier turns before continuing.",
      files: [],
    });
  }

  $: editorOpen = $editorTabs.openTabs.length > 0;

  function onSplitDown(e: MouseEvent) {
    if (!editorOpen) return;
    splitDragging = true;
    splitDragStartY = e.clientY;
    splitStartRatio = editorRatio;
    window.addEventListener("mousemove", onSplitMove);
    window.addEventListener("mouseup", onSplitUp);
    e.preventDefault();
  }
  function onSplitMove(e: MouseEvent) {
    if (!splitDragging || !chatColEl) return;
    const rect = chatColEl.getBoundingClientRect();
    const delta = (e.clientY - splitDragStartY) / Math.max(rect.height, 1);
    editorRatio = Math.max(0.15, Math.min(0.85, splitStartRatio + delta));
  }
  function onSplitUp() {
    splitDragging = false;
    window.removeEventListener("mousemove", onSplitMove);
    window.removeEventListener("mouseup", onSplitUp);
  }

  function toggleTerminal() {
    terminalOpen = !terminalOpen;
  }

  function onDividerDown(e: MouseEvent) {
    if (!terminalOpen) return;
    dragging = true;
    dragStartY = e.clientY;
    dragStartHeight = terminalHeight;
    window.addEventListener("mousemove", onDividerMove);
    window.addEventListener("mouseup", onDividerUp);
    e.preventDefault();
  }
  function onDividerMove(e: MouseEvent) {
    if (!dragging) return;
    const delta = dragStartY - e.clientY;
    const next = Math.max(120, Math.min(window.innerHeight - 200, dragStartHeight + delta));
    terminalHeight = next;
  }
  function onDividerUp() {
    dragging = false;
    window.removeEventListener("mousemove", onDividerMove);
    window.removeEventListener("mouseup", onDividerUp);
  }

  function uuid(): string {
    return crypto.randomUUID();
  }

  async function rpc(payload: unknown): Promise<void> {
    await safeInvoke("send_to_sidecar", { payload: JSON.stringify(payload) });
  }

  /**
   * Surface a notification.
   * - `info` (default): auto-dismisses after 5s with an outer-edge glow.
   * - `error`: sticky until the user clicks the close (×) button. Lets the
   *   user actually read what went wrong instead of it sliding off.
   *
   * Errors are auto-detected when the message starts with "error" or
   * contains "fail" / "failed" so existing call sites (showToast(`error: ...`)
   * and (showToast(`X failed: ...`)) light up as errors without churn.
   */
  function showToast(msg: string, kind?: "info" | "error") {
    const resolvedKind: "info" | "error" =
      kind ?? (/^error[:\s]|fail(ed)?\b/i.test(msg) ? "error" : "info");
    const id = nextToastId++;
    const item: ToastItem = { id, msg, kind: resolvedKind, timer: null };
    if (resolvedKind === "info") {
      item.timer = setTimeout(() => dismissToast(id), 5000);
    }
    toasts = [...toasts, item];
  }
  function dismissToast(id: number) {
    const t = toasts.find((x) => x.id === id);
    if (t?.timer) clearTimeout(t.timer);
    toasts = toasts.filter((x) => x.id !== id);
    if (toasts.length === 0) toastsExpanded = false;
  }
  function dismissAllToasts() {
    for (const t of toasts) if (t.timer) clearTimeout(t.timer);
    toasts = [];
    toastsExpanded = false;
  }
  function onSafeInvokeToast(e: Event): void {
    const detail = (e as CustomEvent<{ message: string; kind?: "info" | "error" }>).detail;
    if (!detail || typeof detail.message !== "string") return;
    showToast(detail.message, detail.kind ?? "info");
  }

  // Worker U: marker for the plan-mode system-prompt fragment. Used so we
  // can add/remove our injection idempotently without nuking whatever the
  // user (or other features) put in `appendSystemPrompt`.
  const PLAN_MODE_PROMPT =
    "[PLAN MODE] Use brainstorming/planning skills. Don't write code until I approve.";
  function applyPlanModeSystemPrompt(on: boolean): void {
    const cur = getSettings().appendSystemPrompt ?? "";
    if (on) {
      if (cur.includes(PLAN_MODE_PROMPT)) return;
      const next = cur ? `${PLAN_MODE_PROMPT}\n\n${cur}` : PLAN_MODE_PROMPT;
      patchSettings({ appendSystemPrompt: next });
    } else {
      if (!cur.includes(PLAN_MODE_PROMPT)) return;
      const next = cur
        .replace(`${PLAN_MODE_PROMPT}\n\n`, "")
        .replace(PLAN_MODE_PROMPT, "")
        .replace(/^\s+/, "");
      patchSettings({ appendSystemPrompt: next || undefined });
    }
  }

  /** Route slash-command menu picks from the Composer. Reuses existing
   *  open/toggle handlers; falls back to a toast for commands that don't
   *  have a host action yet (plan, compact, memory). */
  function handleSlashCommand(detail: { command: string; args: string }): void {
    const { command, args } = detail;
    switch (command) {
      case "clear":
        void newSession();
        break;
      case "model": {
        const id = args.trim();
        if (id) {
          void liveApply(
            SETTING_FIELDS.find((f) => f.key === "model")!,
            id,
          );
        } else {
          // No arg → open the inline ModelPicker via its bindable `open` prop.
          modelPickerOpen = true;
        }
        break;
      }
      case "agents":
        fleetView = !fleetView;
        break;
      case "mcp":
        // McpManager lives inside SettingsPanel; open settings as the entry point.
        settingsOpen = true;
        break;
      case "permissions":
        // Worker U: open the PermissionPicker overlay (modal listbox) so
        // /permissions has a real surface, not just a toast.
        permissionsOpen = true;
        break;
      case "worktree":
        if (leftActive !== "worktrees") toggleLeft("worktrees");
        break;
      case "plan":
        // Worker U: real plan-mode toggle. Adds a topbar pill + prepends a
        // planning prompt to `appendSystemPrompt` for the next turn.
        planMode = !planMode;
        applyPlanModeSystemPrompt(planMode);
        showToast(
          planMode ? "plan mode ON — no code until approved" : "plan mode OFF",
          "info",
        );
        break;
      // Worker U: /init project wizard (right-pane overlay).
      case "init":
        initWizardOpen = true;
        break;
      // Worker U: /commit modal.
      case "commit":
        commitOpen = true;
        break;
      // Worker U: /pr — reuses the existing PrPicker.
      case "pr":
        prPickerOpen = true;
        break;
      // Worker U: /feedback modal → opens prefilled issue URL.
      case "feedback":
        feedbackOpen = true;
        break;
      // Worker U: /undo — delegates to Worker Z's checkpoint API.
      case "undo": {
        const ok = undoLastCheckpoint();
        showToast(ok ? "undid last turn" : "nothing to undo", "info");
        break;
      }
      // Worker U: /fork — delegates to Worker Z's checkpoint API.
      case "fork":
        forkSessionCheckpoint();
        showToast("forking session…", "info");
        break;
      case "compact":
        // Pipe through to Claude as a literal /compact prompt — the runtime
        // handles summarization. Mirrors the command-palette "compact" entry.
        void send({ text: "/compact", files: [] });
        break;
      case "resume":
        if (leftActive !== "sessions") toggleLeft("sessions");
        break;
      case "help":
        if (rightActive !== "help") toggleRight("help");
        break;
      case "memory":
        memoryOpen = true;
        break;
      // Worker T: open the hooks debugger overlay.
      case "hooks":
        hooksDebuggerOpen = true;
        break;
      // Worker Z: open the checkpoint browser (also bound to topbar button).
      case "checkpoints":
        checkpointDrawerOpen = true;
        break;
      default:
        showToast(`Unknown command: /${command}`, "error");
        break;
    }
  }

  function ensureChildAgent(id: string, parentId: string) {
    // Idempotent: addAgent skips dupes via id when caller checks; we check here.
    const existing = (window as any).__clawdui_agents_seen?.has?.(id);
    if (!existing) {
      const wasEmpty = !((window as any).__clawdui_agents_seen?.size > 0);
      addAgent({
        id,
        parentId,
        label: `child ${id.slice(-6)}`,
        status: "running",
      } as any);
      (window as any).__clawdui_agents_seen ??= new Set<string>();
      (window as any).__clawdui_agents_seen.add(id);
      // Auto-open the drawer on the 0 -> 1 child transition so the user
      // sees the body without having to click. Subsequent children don't
      // re-trigger — only the first.
      if (wasEmpty && parentId === "master" && !getDrawerOpen()) {
        try {
          // eslint-disable-next-line no-console
          console.log("[DRAWER]", { autoOpen: "first child arrived", id });
        } catch {}
        setDrawerOpen(true);
      }
    }
  }

  function pushChildMessage(
    agentId: string,
    role: ChatMessage["role"],
    text: string,
  ) {
    ensureChildAgent(agentId, "master");
    const a = getAgent(agentId);
    if (!a) return;
    const last = a.transcript[a.transcript.length - 1];
    if (last && last.role === role && last.streaming) {
      const blk = last.blocks[last.blocks.length - 1];
      if (blk && blk.type === "text") {
        blk.text += text;
        setTranscript(agentId, [...a.transcript]);
        return;
      }
      last.blocks.push({ type: "text", text });
      setTranscript(agentId, [...a.transcript]);
      return;
    }
    setTranscript(agentId, [
      ...a.transcript,
      {
        role,
        blocks: [{ type: "text", text }],
        streaming: true,
        timestamp: Date.now(),
      },
    ]);
  }

  function pushChildBlock(
    agentId: string,
    role: ChatMessage["role"],
    block: ChatMessage["blocks"][number],
  ) {
    ensureChildAgent(agentId, "master");
    const a = getAgent(agentId);
    if (!a) return;
    const last = a.transcript[a.transcript.length - 1];
    if (last && last.role === role && last.streaming) {
      last.blocks.push(block);
      setTranscript(agentId, [...a.transcript]);
      return;
    }
    setTranscript(agentId, [
      ...a.transcript,
      { role, blocks: [block], streaming: true, timestamp: Date.now() },
    ]);
  }

  /**
   * Render a tool_result.content payload into a human-readable string for
   * chat display.
   *
   * SDK tool_results from sub-agents (Agent / Task) arrive as an ARRAY of
   * content blocks like [{type:"text", text:"…"}, {type:"image", …}].
   * If we JSON.stringify the whole array, the chat shows the literal
   * `[{"text":"…","type":"text"}]` blob.
   *
   * Strategy:
   * - string  → as-is
   * - array   → concat all text-typed blocks; non-text blocks become a
   *             one-line placeholder (e.g. "[image]").
   * - other   → JSON.stringify fallback so we never silently drop data.
   */
  function renderToolResultContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const b of content as Array<Record<string, unknown>>) {
        if (!b || typeof b !== "object") continue;
        const ty = (b as { type?: unknown }).type;
        if (ty === "text" && typeof (b as { text?: unknown }).text === "string") {
          parts.push((b as { text: string }).text);
        } else if (typeof ty === "string") {
          parts.push(`[${ty}]`);
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  function appendText(role: ChatMessage["role"], text: string) {
    if (resumeBuffering) {
      // Mutate the non-reactive buffer in place — no reactive bump needed,
      // commitResumeBuffer() will hand a fresh slice to `messages` later.
      const last = resumeBuffer[resumeBuffer.length - 1];
      if (last && last.role === role && last.streaming) {
        const block = last.blocks[last.blocks.length - 1];
        if (block && block.type === "text") {
          block.text += text;
          return;
        }
        last.blocks.push({ type: "text", text });
        return;
      }
      resumeBuffer.push({
        role,
        blocks: [{ type: "text", text }],
        streaming: true,
        timestamp: Date.now(),
      });
      return;
    }
    const last = messages[messages.length - 1];
    if (last && last.role === role && last.streaming) {
      const block = last.blocks[last.blocks.length - 1];
      if (block && block.type === "text") {
        block.text += text;
        messages = messages;
        return;
      }
      last.blocks.push({ type: "text", text });
      messages = messages;
      return;
    }
    messages = [
      ...messages,
      { role, blocks: [{ type: "text", text }], streaming: true, timestamp: Date.now() },
    ];
  }

  function pushBlock(role: ChatMessage["role"], block: ChatMessage["blocks"][number]) {
    if (resumeBuffering) {
      const last = resumeBuffer[resumeBuffer.length - 1];
      if (last && last.role === role && last.streaming) {
        last.blocks.push(block);
        return;
      }
      resumeBuffer.push({ role, blocks: [block], streaming: true, timestamp: Date.now() });
      return;
    }
    const last = messages[messages.length - 1];
    if (last && last.role === role && last.streaming) {
      last.blocks.push(block);
      messages = messages;
      return;
    }
    messages = [
      ...messages,
      { role, blocks: [block], streaming: true, timestamp: Date.now() },
    ];
  }

  /**
   * Phase B: commit the initial window (last 500 entries) to `messages`.
   *
   * The buffer holds the converted ChatMessage shape — built by handleSdkMessage
   * during replay of the raw jsonl entries returned by fetch_session_window.
   * Hand it to `messages` as a single assignment so Svelte does one render pass
   * instead of N. The chat-window store already records oldestSeq / totalSeq /
   * done from the sidecar response; older pages come in via loadMoreOlder()
   * when the top sentinel intersects the viewport. No background backfill.
   */
  function commitResumeBuffer(): void {
    messages = resumeBuffer;
    resumeBuffer = [];
    resumeBuffering = false;
    console.log(
      `[DIAG-FE] resume commit — ${messages.length} messages rendered (Phase B initial window)`,
    );
    queueMicrotask(() => {
      scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
      // Sentinel-driven older-page loading kicks in once the user scrolls up.
      setupTopObserver();
    });
  }

  /**
   * Top sentinel + IntersectionObserver wiring for the Phase B lazy
   * paginated resume. Re-created on every commit (and after end_session
   * cleanup) so it tracks the current scrollEl. The sentinel element is
   * the first .message DOM node — we observe THAT directly rather than
   * inserting a 1px stub, so we don't fight the existing layout / sticky
   * chip CSS.
   *
   * Threshold is 0 (any pixel intersection) with rootMargin "200px 0 0 0"
   * so the next fetch fires slightly BEFORE the user hits the literal top
   * — masks the round-trip and keeps the scroll feeling continuous.
   */
  let topObserver: IntersectionObserver | null = null;
  let topSentinelEl: Element | null = null;
  function teardownTopObserver(): void {
    if (topObserver) {
      try { topObserver.disconnect(); } catch { /* ignore */ }
      topObserver = null;
    }
    topSentinelEl = null;
  }
  function setupTopObserver(): void {
    teardownTopObserver();
    if (!scrollEl) return;
    const cw = $chatWindow;
    if (cw.done) return;
    const first = scrollEl.querySelector(".messages > [data-msg-row]:first-child");
    if (!first) return;
    topSentinelEl = first;
    topObserver = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (ent.isIntersecting) {
            void loadMoreOlder();
          }
        }
      },
      { root: scrollEl, rootMargin: "200px 0px 0px 0px", threshold: 0 },
    );
    topObserver.observe(first);
  }

  /**
   * Fetch the next page of older entries from the sidecar, convert them
   * via handleSdkMessage into a temporary buffer, then prepend to messages
   * while preserving the user's scroll position.
   *
   * Scroll preservation strategy: record `scrollHeight - scrollTop`
   * BEFORE the splice → apply messages mutation → in the next animation
   * frame, restore `scrollTop = scrollHeight - savedDistFromBottom`. The
   * relative distance from the bottom stays constant; visually nothing
   * jumps even though the document height grew.
   */
  async function loadMoreOlder(): Promise<void> {
    const cwd = getSettings().cwd;
    if (!cwd) return;
    const cw0 = $chatWindow;
    if (cw0.fetching || cw0.done || !cw0.sessionId) return;
    const el = scrollEl;
    const distFromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    const entries = await loadMoreWindow(cwd, RESUME_OLDER_PAGE_LIMIT);
    if (entries.length === 0) {
      // Either nothing returned or we're done. Tear down observer if done.
      if ($chatWindow.done) teardownTopObserver();
      return;
    }
    // Convert raw jsonl entries → ChatMessage shape using the same
    // replay path used for the initial window. Route into a fresh
    // buffer (NOT the live `messages`) by flipping resumeBuffering.
    resumeBuffer = [];
    resumeBuffering = true;
    for (const entry of entries) {
      if (entry && typeof entry === "object") {
        handleSdkMessage(entry as Record<string, unknown>);
      }
    }
    for (const m of resumeBuffer) {
      if (m.streaming) m.streaming = false;
    }
    const prepend = resumeBuffer;
    resumeBuffer = [];
    resumeBuffering = false;
    messages = [...prepend, ...messages];
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - distFromBottom;
      // Re-attach observer to the NEW first .message row, since the old
      // sentinel is now in the middle of the list.
      setupTopObserver();
    });
  }

  function finalize() {
    // Clear streaming on ALL in-flight messages, not just the last one. When a
    // turn ends with a tool_result (role: "tool") arriving AFTER the final
    // assistant message, the prior assistant message keeps streaming=true and
    // the STREAMING blink runs forever. Sweeping the whole array is O(n) but
    // n is bounded by the current session's message count — cheap.
    let dirty = false;
    for (const m of messages) {
      if (m.streaming) {
        m.streaming = false;
        dirty = true;
      }
    }
    if (dirty) messages = messages;
    busy = false;
    // Worker Z: auto-checkpoint after each completed assistant turn.
    // Cheap — just records messageIndex; rewind/fork operate against it.
    try { autoCheckpoint(); } catch { /* non-fatal */ }
    // Drain next queued prompt (if any) once the busy flag flushes.
    if (promptQueue.length > 0) {
      void Promise.resolve().then(drainQueue);
    }
  }

  function queuePrompt(
    text: string,
    files: { fileId: string; mime?: string; name?: string }[],
  ): void {
    const id = uuid();
    promptQueue = [...promptQueue, { id, text, files }];
    const blocks: { type: "text"; text: string }[] = [];
    if (files.length > 0) {
      const fileNames = files.map((f) => f.name ?? f.fileId).join(", ");
      blocks.push({ type: "text", text: `📎 ${fileNames}` });
    }
    if (text) blocks.push({ type: "text", text });
    messages = [
      ...messages,
      {
        role: "user",
        blocks,
        queued: true,
        queueId: id,
        timestamp: Date.now(),
      },
    ];
  }

  function cancelQueuedPrompt(queueId: string): void {
    promptQueue = promptQueue.filter((p) => p.id !== queueId);
    messages = messages.filter((m) => m.queueId !== queueId);
  }

  function drainQueue(): void {
    if (busy || promptQueue.length === 0) return;
    const next = promptQueue[0];
    promptQueue = promptQueue.slice(1);
    messages = messages.filter((m) => m.queueId !== next.id);
    void send({ text: next.text, files: next.files });
  }

  function handleSdkMessage(msg: any) {
    if (!msg || typeof msg !== "object") return;
    const t = msg.type;
    if (t === "system" && msg.subtype === "init") {
      activeModel = msg.model ?? activeModel;
      return;
    }
    if (t === "assistant" && msg.message?.content) {
      activeModel = msg.message.model ?? activeModel;
      // First assistant chunk for this turn → record TTFT
      markFirstAssistantToken();
      for (const block of msg.message.content) {
        if (block.type === "text") {
          appendText("assistant", block.text);
        } else if (block.type === "thinking") {
          pushBlock("assistant", { type: "thinking", text: block.thinking ?? "" });
        } else if (block.type === "tool_use") {
          const isSdkSpawn = block.name === "Agent" || block.name === "Task";
          const isRpcSpawn = block.name === "spawn_child";
          if (isSdkSpawn || isRpcSpawn) {
            // Main spawn keeps the main view tidy via MessageBlock's
            // spawn-id suppression. Full prompt + reply mirror into the child
            // entry so the bottom drawer carries the conversation.
            registerSpawnToolUse(block.id, block.id);
            if (isSdkSpawn) {
              // SDK Agent/Task: synthetic drawer entry with a label derived
              // from the tool input (description / subagent_type / prompt).
              registerSdkAgentToolUse(block.id, block.name, block.input, "master");
            } else {
              // sidecar-driven spawn_child: generic placeholder until the
              // first sidecar event arrives with richer metadata.
              ensureChildAgent(block.id, "master");
            }
            const input = block.input as Record<string, unknown> | undefined;
            const promptText =
              (input && (input.prompt as string)) ||
              (input && (input.description as string)) ||
              "";
            if (promptText) {
              pushChildMessage(block.id, "user", promptText);
            }
          }
          pushBlock("assistant", {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
      addUsage(normalizeSdkUsage(msg.message?.usage));
      return;
    }
    if (t === "user" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result") {
          const content = renderToolResultContent(block.content);
          // Mirror spawn-tool results into the child agent's transcript so
          // the drawer carries the full reply. Main pane keeps a one-line
          // chip via MessageBlock's spawn-id suppression. setAgentStatus
          // also clears any in-flight streaming flags on the child.
          if (isSpawnToolUseId(block.tool_use_id)) {
            const childId = getSpawnChildId(block.tool_use_id);
            if (childId) {
              pushChildMessage(childId, "assistant", content);
              setAgentStatus(childId, block.is_error ? "error" : "done");
            }
          } else {
            // Safety net for SDK Agent/Task tool_results that were not
            // routed through the spawn map (defensive — shouldn't happen
            // after the tool_use branch above, but keeps PR#72's path).
            completeSdkAgentToolUse(block.tool_use_id, !!block.is_error);
          }
          pushBlock("tool", {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            content,
          });
        }
      }
      return;
    }
    if (t === "result") {
      // Harvest SDK-reported context window per model — source of truth
      // for compaction thresholds. SDK populates modelUsage[<id>].contextWindow
      // on every result event with the real limit it's enforcing (handles
      // 1M beta extensions, future models, etc).
      recordModelContextWindows(msg.modelUsage);
      // Some result events also carry final usage totals — fold them in if
      // the assistant message didn't already capture them.
      const u = normalizeSdkUsage(msg.usage);
      if (u && (u.input || u.output || u.cacheRead || u.cacheCreation)) {
        // result.usage is typically the cumulative for THIS turn; only add
        // the delta we haven't already counted via assistant messages.
        // To stay safe (no double-count), we ignore it here — assistant
        // messages already provide per-chunk usage. Keep this branch for
        // future use if SDK behavior changes.
      }
      settleTurn(
        typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
      );
      finalize();
    }
  }

  async function startSession() {
    if (sessionStarted) return;
    sidecarState = "connecting";
    const opts = settingsToSDKOptions(getSettings());
    // [DIAG] frontend start_session payload trace.
    try {
      const o = opts as Record<string, unknown>;
      // eslint-disable-next-line no-console
      console.error(
        `[DIAG-FE] startSession cwd=${o.cwd} resume=${o.resume} continue=${o.continue} forkSession=${o.forkSession} sessionId=${o.sessionId}`,
      );
    } catch {
      /* swallow */
    }
    try {
      await rpc({ id: uuid(), type: "start_session", options: opts });
    } catch (err) {
      sidecarState = "error";
      showToast(`start_session failed: ${err}`);
    }
  }

  /**
   * Defensive cleanup for the "session already active" handshake.
   * The sidecar process outlives the webview (HMR reloads, app re-open
   * after crash), so a stale master session can block start_session. When
   * we see that error, end_session + wait + retry start once.
   */
  let staleRecoverPending = false;
  async function recoverFromStaleSession(): Promise<void> {
    if (staleRecoverPending) return;
    staleRecoverPending = true;
    try {
      const ended = waitForSessionEnded(3000);
      await rpc({ id: uuid(), type: "end_session" });
      await ended;
      sessionStarted = false;
      await startSession();
    } catch (err) {
      showToast(`recover failed: ${err}`);
    } finally {
      staleRecoverPending = false;
    }
  }

  async function endSession() {
    if (!sessionStarted) return;
    try {
      await rpc({ id: uuid(), type: "end_session" });
    } catch (err) {
      showToast(`end_session failed: ${err}`);
    }
  }

  /**
   * Replaces the legacy CLI `--from-pr` flag.
   * Patches settings so the next session starts with the PR description as
   * appended system prompt + a derived session title, then triggers newSession.
   */
  async function startFromPr(detail: {
    pr: PR;
    preamble: string;
    title: string;
    mode: "resume" | "fork";
    localBranch?: string;
    finalCwd?: string;
  }): Promise<void> {
    const cur = getSettings();
    const append = cur.appendSystemPrompt
      ? `${cur.appendSystemPrompt}\n\n${detail.preamble}`
      : detail.preamble;
    patchSettings({
      appendSystemPrompt: append,
      sessionTitle: detail.title,
      forkSession: detail.mode === "fork",
      // Clear any prior resume id — PR start is always a fresh session.
      resume: undefined,
      continueLatest: false,
    });
    const suffix = detail.localBranch ? ` (on ${detail.localBranch})` : "";
    showToast(`Starting from PR #${detail.pr.number}${suffix}…`);
    // Pivot workspace cwd to the resolved branch dir (worktree path OR clone
    // root). Falls back to current cwd if checkout failed/skipped.
    await newSession(detail.finalCwd ?? undefined);
  }

  function waitForSessionEnded(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
      const off = subscribeSidecarEvent((ev) => {
        if (ev.type === "session_ended") {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
  }

  async function newSession(overrideCwd?: string | null) {
    // [DIAG] newSession entry trace — keep until session-resume flow stabilized.
    // eslint-disable-next-line no-console
    console.error(
      `[DIAG-FE] newSession overrideCwd=${overrideCwd} priorCwd=${getSettings().cwd} priorResume=${getSettings().resume} sessionStarted=${sessionStarted}`,
    );
    // Pivot guarantee: when a workspace/worktree handler passes an explicit
    // cwd, write it into settings BEFORE end+start so the SDK reads the new
    // value verbatim. Without this, any race against patchSettings or any
    // residual on-disk cwd could leak the OLD cwd into the next session and
    // the agent would silently operate in the wrong folder.
    if (typeof overrideCwd === "string" && overrideCwd.length > 0) {
      patchSettings({ cwd: overrideCwd });
    } else if (overrideCwd === null) {
      patchSettings({ cwd: undefined });
    }
    if (sessionStarted) {
      // Wait for the actual session_ended event before starting a new one —
      // otherwise the sidecar still has the master session bound and start
      // returns "session already active". Falls back to a 5s timeout in case
      // the sidecar drops the event.
      const ended = waitForSessionEnded();
      await endSession();
      await ended;
      // If session_ended never arrived within the timeout, sessionStarted is
      // still true and startSession() would silently early-return. Force it
      // false so the new session boots with the new cwd — recoverFromStale
      // covers the "session already active" reply if the sidecar's master is
      // somehow still alive.
      sessionStarted = false;
    }
    messages = [];
    sessionId = null;
    sessionStartedAt = null;
    activeModel = undefined;
    resetSessionStats();
    resetAgents();
    compactSuggested = false;
    compactForced = false;
    editingIndex = null;
    teardownTopObserver();
    resetChatWindow();
    (window as any).__clawdui_agents_seen = new Set<string>();

    // If resuming a prior session, replay its on-disk transcript into the
    // chat view so the user sees the historical context that the SDK is
    // about to continue from. Failures are silent unless the workspace
    // actually has a cwd to read from — the SDK still attempts the resume
    // server-side regardless.
    //
    // Phase B: pull only the LAST RESUME_INITIAL_LIMIT (500) entries via
    // fetch_session_window. The chat-window store records totalSeq /
    // oldestSeq so older history can be lazily fetched when the user
    // scrolls to the top sentinel. See commitResumeBuffer() and
    // loadMoreOlder() below.
    const resumeId = getSettings().resume;
    const resumeCwd = getSettings().cwd;
    if (resumeId && resumeCwd) {
      try {
        resumeBuffering = true;
        resumeBuffer = [];
        resetChatWindow();
        console.log(
          `[DIAG-FE] resume(${resumeId}) — fetching initial window (limit=${RESUME_INITIAL_LIMIT})`,
        );
        const raw = await loadInitialWindow(resumeCwd, resumeId, RESUME_INITIAL_LIMIT);
        console.log(
          `[DIAG-FE] resume(${resumeId}) — replaying ${raw.length} jsonl entries into buffer`,
        );
        for (const entry of raw) {
          if (entry && typeof entry === "object") {
            handleSdkMessage(entry as Record<string, unknown>);
          }
        }
        // Settle streaming flags inside the buffer before commit.
        for (const m of resumeBuffer) {
          if (m.streaming) m.streaming = false;
        }
        console.log(
          `[DIAG-FE] resume(${resumeId}) — buffer holds ${resumeBuffer.length} msgs, committing`,
        );
        commitResumeBuffer();
      } catch (err) {
        resumeBuffering = false;
        resumeBuffer = [];
        resetChatWindow();
        // Stale resume id — likely the session file was deleted. Clear so
        // the next newSession() starts fresh instead of replaying ghosts.
        patchSettings({ resume: undefined });
        showToast(`could not load session history: ${err}`, "error");
      }
    }

    await startSession();
  }

  async function send(payload: {
    text: string;
    files: { fileId: string; mime?: string; name?: string }[];
  } | string) {
    // Back-compat: callers may still pass a bare string.
    const prompt = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "string" ? [] : payload.files;
    if (!sessionStarted) return;
    if (!prompt && files.length === 0) return;
    // If a turn is already in flight, queue the prompt + render a placeholder
    // user bubble flagged `queued`. drainQueue() picks it up on finalize.
    if (busy) {
      queuePrompt(prompt, files);
      return;
    }
    busy = true;
    turnStartAt = Date.now();
    lastEventAt = Date.now();
    nowTick = Date.now();
    stalledOpen = false;

    const blocks: { type: "text"; text: string }[] = [];
    if (files.length > 0) {
      const fileNames = files.map((f) => f.name ?? f.fileId).join(", ");
      blocks.push({ type: "text", text: `📎 ${fileNames}` });
    }
    if (prompt) blocks.push({ type: "text", text: prompt });

    if (editingIndex != null && editingIndex >= 0 && editingIndex < messages.length) {
      // Rewrite the prior user message in place + drop everything after it.
      const keep = messages.slice(0, editingIndex);
      messages = [
        ...keep,
        {
          role: "user",
          blocks,
          timestamp: Date.now(),
        },
      ];
      editingIndex = null;
    } else {
      messages = [
        ...messages,
        {
          role: "user",
          blocks,
          timestamp: Date.now(),
        },
      ];
    }
    markTurnSent();
    await tick();
    scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
    try {
      if (files.length > 0) {
        await rpc({
          id: uuid(),
          type: "attach_files_to_next_message",
          files,
        });
      }
      await rpc({
        id: uuid(),
        type: "send_message",
        content: prompt || " ",
      });
    } catch (err) {
      showToast(`send failed: ${err}`);
      busy = false;
    }
  }

  /**
   * Regenerate the assistant reply at `index` by re-sending the most recent
   * preceding user message verbatim. The current assistant turn (and any
   * tool blocks beneath it) is dropped from the visible transcript so the
   * regenerated answer can take its place.
   */
  async function regenerateLastTurn(index: number) {
    if (busy) return;
    // Find the closest preceding user message.
    let userIdx = -1;
    for (let i = Math.min(index, messages.length - 1); i >= 0; i--) {
      if (messages[i].role === "user") { userIdx = i; break; }
    }
    if (userIdx < 0) {
      showToast("No prior user message to regenerate from.", "error");
      return;
    }
    const userMsg = messages[userIdx];
    const text = userMsg.blocks
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    if (!text) {
      showToast("Prior user message has no text to regenerate.", "error");
      return;
    }
    // Trim the transcript back to just before the user msg; the send() call
    // below will re-push the user message at the bottom.
    messages = messages.slice(0, userIdx);
    await send({ text, files: [] });
  }

  /**
   * Edit: load this user message's text into the composer and mark the
   * index for in-place replacement on the next send. Transcript remains
   * untouched until send — clicking edit doesn't reset to an empty view.
   * Pressing Enter rewrites the original entry and drops anything below.
   */
  function editUserMessage(index: number, text: string): void {
    if (busy) {
      showToast("Stop the current turn before editing prior messages.", "error");
      return;
    }
    editingIndex = index;
    composer?.insertText(text);
    showToast(`Editing message #${index + 1}. Press Enter to replace.`, "info");
  }

  /**
   * Resend: truncate transcript back to before this user message and
   * re-send the same text immediately.
   */
  async function resendUserMessage(index: number, text: string): Promise<void> {
    if (busy) {
      showToast("Stop the current turn before resending.", "error");
      return;
    }
    if (!text.trim()) {
      showToast("Empty message — nothing to resend.", "error");
      return;
    }
    messages = messages.slice(0, index);
    await send({ text, files: [] });
  }

  async function interrupt() {
    if (!sessionStarted) return;
    try {
      await rpc({ id: uuid(), type: "interrupt" });
      showToast("Interrupt requested");
    } catch (err) {
      showToast(`interrupt failed: ${err}`);
    }
  }

  async function respondPermission(
    requestId: string,
    decision: PermissionDecision,
  ) {
    try {
      await rpc({
        id: uuid(),
        type: "permission_response",
        request_id: requestId,
        decision,
      });
    } catch (err) {
      showToast(`permission response failed: ${err}`);
    }
  }

  async function applyRemoteControl() {
    const s = getSettings();
    // Belt-and-braces: never start the self-hosted relay unless the
    // user has opted in. The sidecar honours `enabled: false` by tearing
    // down any active connection.
    const enabled = s.customRelayEnabled && s.remoteControlEnabled;
    try {
      await rpc({
        id: uuid(),
        type: "set_remote_control",
        enabled,
        relayUrl: s.remoteControlRelayUrl,
        sessionName: s.remoteControlSessionName,
        authToken: s.remoteControlAuthToken,
      });
    } catch (err) {
      showToast(`remote control failed: ${err}`);
    }
  }

  async function liveApply(field: SettingField, value: unknown) {
    if (!sessionStarted) return;
    try {
      if (field.liveApply === "permissionMode") {
        await rpc({
          id: uuid(),
          type: "set_permission_mode",
          mode: value,
        });
      } else if (field.liveApply === "model") {
        await rpc({ id: uuid(), type: "set_model", model: value });
      } else if (field.liveApply === "maxThinkingTokens") {
        await rpc({
          id: uuid(),
          type: "set_max_thinking_tokens",
          value,
        });
      }
      showToast(`Applied: ${field.label}`);
    } catch (err) {
      showToast(`live apply failed: ${err}`);
    }
  }

  function toggleLeft(id: string) {
    leftActive = leftActive === id ? null : id;
  }
  function toggleRight(id: string) {
    rightActive = rightActive === id ? null : id;
  }

  function onGlobalKeydown(e: KeyboardEvent) {
    // ESC closes the active SidePane (left/right activity-bar surfaces)
    // and the Skills overlay. Modal components own their own ESC
    // handling — this only runs when no input/textarea is focused so
    // typed Escape inside the composer doesn't blow up the layout.
    if (e.key === "Escape") {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      const editable = t?.isContentEditable === true;
      if (tag === "input" || tag === "textarea" || tag === "select" || editable) {
        // let the focused control handle it (e.g. clear search)
      } else if (skillsOpen) {
        e.preventDefault();
        skillsOpen = false;
        return;
      } else if (leftActive) {
        e.preventDefault();
        leftActive = null;
        return;
      } else if (rightActive) {
        e.preventDefault();
        rightActive = null;
        return;
      }
    }
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    if (e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      commandPaletteOpen = !commandPaletteOpen;
      return;
    }
    if (e.key === ",") {
      e.preventDefault();
      settingsOpen = true;
    } else if (e.key.toLowerCase() === "n") {
      e.preventDefault();
      void newSession();
    } else if (e.key === "`") {
      e.preventDefault();
      toggleTerminal();
    } else if (e.key.toLowerCase() === "h" && e.shiftKey) {
      e.preventDefault();
      // Hooks moved into Settings tab — open Settings overlay at the hooks tab.
      try {
        localStorage.setItem("clawdui.settings.activeGroup", "hooks");
        window.dispatchEvent(new CustomEvent("clawdui:settings-tab", { detail: "hooks" }));
      } catch { /* ignore */ }
      settingsOpen = true;
    } else if (e.key.toLowerCase() === "b" && e.altKey) {
      // Cmd+Alt+B → right side bar
      e.preventDefault();
      rightActive = rightActive ? null : "auth";
    } else if (e.key.toLowerCase() === "b") {
      // Cmd+B → left side bar
      e.preventDefault();
      leftActive = leftActive ? null : "workspace";
    }
  }

  // Activity bar item lists
  // Skills / MCP / Hooks / Plugins moved into Settings tabs (set-and-forget).
  // leftItemsTop is reactive so the Fleet item can show a status dot
  // reflecting whether the main pane is currently in fleet mode.
  $: leftItemsTop = ([
    { id: "workspace", icon: Folder, label: "Workspace", shortcut: "⌘B" },
    { id: "sessions", icon: MessageSquare, label: "Sessions" },
    { id: "worktrees", icon: GitBranch, label: "Worktrees" },
    { id: "skills", icon: Sparkles, label: "Skills", groupBreak: true },
    // Worker T: hooks debugger overlay trigger.
    { id: "hooks", icon: Webhook, label: "Hooks debugger" },
    // Fleet View: mission-control multi-agent dashboard. Click flips the
    // main pane between Chat (default) and Fleet. Status dot = on/off.
    {
      id: "fleet",
      icon: ListTree,
      label: fleetView ? "Fleet View · ON" : "Fleet View · multi-agent",
      status: fleetView ? "ok" : undefined,
      statusLabel: fleetView ? "active" : undefined,
    },
  ]) as ActivityItem[];
  // The settings entry sits in the bottom group of the left activity bar
  // but does NOT toggle a SidePane. Its click opens a full-window overlay.
  // Donate sits directly below settings; click opens the BMC link + the
  // honor-system "I've donated" confirmation overlay.
  $: leftItemsBottom = ([
    { id: "settings", icon: SettingsIcon, label: "Settings", shortcut: "⌘,", position: "bottom" as const },
    {
      id: "donate",
      icon: Heart,
      label: $settings.donated ? "Thank you — Donate again" : "Donate · Buy me a coffee",
      position: "bottom" as const,
    },
  ]) as ActivityItem[];
  $: leftItems = [...leftItemsTop, ...leftItemsBottom];

  // Right-side activity bar. The "remote" entry only appears when the
  // user has explicitly turned on the legacy self-hosted relay; for most
  // users, the topbar "Pair mobile" button replaces it.
  // Map auth signed-in state to a small status dot on the Auth icon.
  // ok = green (signed in), bad = red (signed out), neutral = grey (unknown).
  $: authDot =
    $authSignedIn.state === "signed-in"
      ? { status: "ok" as const, label: "signed in" }
      : $authSignedIn.state === "signed-out"
        ? { status: "bad" as const, label: "signed out" }
        : { status: "neutral" as const, label: "status unknown" };

  // Right-side ActivityBar: primary tools at top (Ultrareview, remote control),
  // system / account / help items anchored to the bottom — mirrors VS Code's
  // account-row placement so users learn where to look.
  $: rightItems = ([
    { id: "terminal", icon: TerminalIcon, label: "Terminal", shortcut: "⌘`" },
    { id: "review", icon: ScanSearch, label: "Ultrareview" },
    ...($settings.customRelayEnabled
      ? [{ id: "remote", icon: Radio, label: "Remote control (self-hosted)" }]
      : []),
    { id: "pair", icon: Radio, label: "Pair with Claude mobile", position: "bottom" as const, groupBreak: true },
    {
      id: "auth",
      icon: Key,
      label: "Authentication",
      status: authDot.status,
      statusLabel: authDot.label,
      position: "bottom" as const,
    },
    { id: "doctor", icon: Stethoscope, label: "Doctor", position: "bottom" as const },
    { id: "update", icon: Download, label: "Update", position: "bottom" as const },
    { id: "help", icon: LifeBuoy, label: "Help & docs", position: "bottom" as const },
  ]) as ActivityItem[];

  // If the user disables custom relay while its pane is open, close it.
  $: if (!$settings.customRelayEnabled && rightActive === "remote") {
    rightActive = null;
  }

  const MODEL_PRESETS = [
    { id: "opus",   label: "Opus",    sub: "claude-opus-4-7" },
    { id: "sonnet", label: "Sonnet",  sub: "claude-sonnet-4-6" },
    { id: "haiku",  label: "Haiku",   sub: "claude-haiku-4-5" },
    { id: "",       label: "Default", sub: "SDK chooses" },
  ];
  const PERMISSION_PRESETS = [
    { id: "default",           label: "default",      sub: "ask before tools" },
    { id: "acceptEdits",       label: "accept edits", sub: "auto-confirm Edit/Write" },
    { id: "bypassPermissions", label: "bypass",       sub: "no prompts (dangerous)" },
    { id: "plan",              label: "plan",         sub: "no execution, plan only" },
  ];
  const THEME_PRESETS: { id: ThemeId; label: string }[] = [
    { id: "console",              label: "Console (warm dark)" },
    { id: "nord",                 label: "Nord" },
    { id: "catppuccin-mocha",     label: "Catppuccin Mocha" },
    { id: "catppuccin-macchiato", label: "Catppuccin Macchiato" },
    { id: "catppuccin-frappe",    label: "Catppuccin Frappé" },
    { id: "catppuccin-latte",     label: "Catppuccin Latte (light)" },
  ];

  $: paletteCommands = ([
    { id: "new-session", title: "New session", detail: "Restart with current settings",
      keywords: ["new", "restart", "fresh"], shortcut: "⌘N",
      run: () => void newSession() },
    // Model presets — every preset gets its own row so the user can type
    // "opus" / "sonnet" / "haiku" and hit Enter.
    ...MODEL_PRESETS.map((p) => ({
      id: `model:${p.id || "default"}`,
      title: `Model: ${p.label}`,
      detail: p.sub,
      keywords: ["model", "switch", p.label.toLowerCase(), p.sub.toLowerCase()],
      run: () => void liveApply(SETTING_FIELDS.find((f) => f.key === "model")!, p.id || undefined),
    })),
    // Permission modes
    ...PERMISSION_PRESETS.map((p) => ({
      id: `perm:${p.id}`,
      title: `Permission: ${p.label}`,
      detail: p.sub,
      keywords: ["permission", "mode", p.label.toLowerCase()],
      run: () => void liveApply(SETTING_FIELDS.find((f) => f.key === "permissionMode")!, p.id),
    })),
    // Theme presets
    ...THEME_PRESETS.map((t) => ({
      id: `theme:${t.id}`,
      title: `Theme: ${t.label}`,
      keywords: ["theme", "color", "palette"],
      run: () => patchSettings({ theme: t.id }),
    })),
    { id: "settings", title: "Open Settings", detail: "Theme, MCPs, hooks, plugins",
      keywords: ["preferences", "config"], shortcut: "⌘,",
      run: () => (settingsOpen = true) },
    { id: "workspace", title: "Toggle Workspace pane", keywords: ["files", "tree", "folder"],
      shortcut: "⌘B", run: () => toggleLeft("workspace") },
    { id: "sessions", title: "Toggle Sessions pane", keywords: ["history", "resume"],
      run: () => toggleLeft("sessions") },
    { id: "worktrees", title: "Toggle Worktrees pane", keywords: ["git", "branch"],
      run: () => toggleLeft("worktrees") },
    { id: "skills", title: "Browse Skills", keywords: ["slash", "commands"],
      run: () => (skillsOpen = true) },
    { id: "terminal", title: "Toggle Terminal", keywords: ["shell", "console"],
      shortcut: "⌘`", run: () => toggleTerminal() },
    { id: "review", title: "Open Ultrareview", keywords: ["scan", "audit", "pr"],
      run: () => toggleRight("review") },
    { id: "pair-mobile", title: "Pair Claude mobile", keywords: ["phone", "qr"],
      run: () => mobilePair?.openPair() },
    { id: "auth", title: "Open Authentication", keywords: ["sign", "login", "logout"],
      run: () => toggleRight("auth") },
    { id: "doctor", title: "Open Doctor", keywords: ["diagnose", "health"],
      run: () => toggleRight("doctor") },
    { id: "update", title: "Open Update", keywords: ["upgrade", "version"],
      run: () => toggleRight("update") },
    { id: "help", title: "Open Help & docs", keywords: ["support", "tour", "docs"],
      run: () => toggleRight("help") },
    { id: "donate", title: $settings.donated ? "Donate again — Buy me a coffee" : "Donate — Buy me a coffee",
      keywords: ["tip", "bmc", "support"],
      run: () => {
        void openDonatePage();
        patchSettings({ donated: true });
        showToast("♥ Thank you. ClawdUI is sustained by tips like yours.", "info");
      } },
    { id: "compact", title: "Compact conversation", detail: "/compact — summarize prior turns",
      keywords: ["summary", "history", "context"],
      run: () => void send({ text: "/compact", files: [] }) },
    { id: "tour", title: "Replay onboarding tour", keywords: ["help", "walkthrough"],
      run: () => (onboardingOpen = true) },
  ]) as Command[];

  function leftPaneTitle(id: string | null): string {
    switch (id) {
      case "workspace": return "WORKSPACE";
      case "sessions": return "SESSIONS";
      case "worktrees": return "WORKTREES";
      default: return "";
    }
  }
  function rightPaneTitle(id: string | null): string {
    switch (id) {
      case "auth": return "AUTH";
      case "doctor": return "DOCTOR";
      case "update": return "UPDATE";
      case "review": return "ULTRAREVIEW";
      case "remote": return "REMOTE CONTROL";
      case "help": return "HELP";
      default: return "";
    }
  }

  async function runHookTest(detail: {
    command: string;
    timeout?: number;
    env?: Record<string, string>;
  }) {
    try {
      await rpc({
        id: uuid(),
        type: "hook_test_run",
        command: detail.command,
        timeout: detail.timeout,
        env: detail.env ?? {},
      });
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent("clawdui:hook-test-result", {
          detail: { error: String(err) },
        }),
      );
    }
  }

  // Holds the unsubscribe fn returned by onAgentCancelRequested(). Bound in
  // onMount, called in onDestroy.
  let unsubscribeAgentCancel: (() => void) | null = null;

  onMount(async () => {
    // Disable WebKit context menu globally — right-click is a no-op in
    // production. Web Inspector stays reachable via ⌘⌥I when the Tauri
    // devtools feature is compiled in.
    window.addEventListener("contextmenu", (e) => e.preventDefault());

    // Phase B: composer-focus pause is no longer needed — older messages
    // are fetched on demand (scroll-up), not on a setTimeout chunk loop,
    // so keystrokes can't compete with backfill anymore.

    // Worker Z: wire the checkpoints store to the local messages[] array.
    // checkpoints.ts can't touch messages[] directly (lives in this script
    // block), so it calls back through the handlers registered here.
    registerCheckpointHandlers({
      getActiveSessionId: () => sessionId,
      getMessageCount: () => messages.length,
      rewind: (messageIndex: number) => {
        const cap = Math.max(0, Math.min(messageIndex, messages.length));
        messages = messages.slice(0, cap);
        // Cancel any pending edit cursor that pointed past the new tail.
        if (editingIndex != null && editingIndex >= cap) editingIndex = null;
        showToast(`Rewound to ${cap} message${cap === 1 ? "" : "s"}.`, "info");
      },
      fork: (fromCheckpointId?: string) => {
        // Reuse sessions.fork() — it sets resume + forkSession=true, and
        // newSession() picks them up to spawn a forked sidecar session.
        if (!sessionId) {
          showToast("No active session to fork.", "error");
          return;
        }
        forkSessionRpc(sessionId);
        showToast(
          `Forking session${fromCheckpointId ? " at checkpoint" : ""}…`,
          "info",
        );
        void newSession();
      },
    });

    // Fleet View's Kill button calls requestCancel(id) in agents.svelte;
    // we forward that to the sidecar's cancel_child handler. The handler
    // interrupts the child's SDK query (or, for SDK Agent/Task tools that
    // run inside master's stream, interrupts master). The agents store
    // already flips the local status optimistically; child_done will
    // confirm. Errors are surfaced as a toast but don't block — the worst
    // case is the child finishes on its own.
    unsubscribeAgentCancel = onAgentCancelRequested((id) => {
      if (id === "master") return; // never cancel master via this path
      void rpcCall("cancel_child", { session_id: id }).catch((e) => {
        console.error("[cancel] rpc cancel_child failed", e);
        showToast(
          `cancel failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      });
    });

    // Hydrate persistent settings BEFORE any UI logic that reads them
    // (theme application, sidecar startup with SDK options, onboarding
    // gate). The store remains DEFAULT_SETTINGS until this completes;
    // disk writes are also disabled until hydration finishes.
    await hydrateSettings();

    // Restore any cached model context windows so the compaction pill
    // shows the right limit immediately on relaunch (no need to wait for
    // the first turn of the new session).
    hydrateModelContextWindows();

    // Register the sidecar responder so InlinePermissionCard's resolve()
    // (and PermissionPrompt's) both send permission_response to sidecar via
    // a single path. Previously only PermissionPrompt's dispatched event
    // routed to respondPermission, so inline button clicks left the
    // sidecar waiting on canUseTool forever.
    permissions.setResponder((requestId, decision) => {
      void respondPermission(requestId, decision);
    });

    // safeInvoke() fires a "safe-invoke-toast" CustomEvent when an IPC
    // call is short-circuited in browser preview. Surface it through the
    // existing toast stack instead of letting the bare error reach the
    // console.
    window.addEventListener("safe-invoke-toast", onSafeInvokeToast);

    unlistenEvent = await safeListen<SidecarEvent>("sidecar-event", (e) => {
      const ev = e.payload;
      // Watchdog heartbeat — any event from the sidecar resets the stall
      // timer, so a long but progressing turn doesn't trip the warning.
      lastEventAt = Date.now();
      nowTick = Date.now();
      fanoutSidecarEvent(ev);
      switch (ev.type) {
        case "session_started":
          sessionStarted = true;
          sidecarState = "connected";
          sessionStartedAt = Date.now();
          resetSessionStats(sessionStartedAt);
          break;
        case "session_id":
          sessionId = ev.session_id;
          break;
        case "message": {
          const sk = ev.session_id ?? "master";
          if (sk === "master" || !sk) {
            handleSdkMessage(ev.message);
            // Keep master agent's transcript in sync for the drawer.
            setTranscript("master", messages);
          } else {
            // Child event — surface a transcript line in the agents store.
            const m = ev.message as any;
            if (m && typeof m === "object") {
              if (m.type === "assistant" && m.message?.content) {
                for (const b of m.message.content) {
                  if (b.type === "text") {
                    pushChildMessage(sk, "assistant", b.text);
                  } else if (b.type === "tool_use") {
                    pushChildBlock(sk, "assistant", {
                      type: "tool_use",
                      id: b.id,
                      name: b.name,
                      input: b.input,
                    });
                  }
                }
              } else if (m.type === "user" && m.message?.content) {
                for (const b of m.message.content) {
                  if (b.type === "tool_result") {
                    const content = renderToolResultContent(b.content);
                    pushChildBlock(sk, "tool", {
                      type: "tool_result",
                      tool_use_id: b.tool_use_id,
                      content,
                    });
                  }
                }
              }
            }
          }
          break;
        }
        case "child_done": {
          // Ensure agent exists (may not have been registered if the child
          // emitted nothing observable before completion).
          ensureChildAgent(ev.session_id, ev.parent_id);
          setAgentStatus(ev.session_id, "done");
          // Append a synthesized summary line so the drawer shows closure.
          if (ev.summary) {
            pushChildMessage(ev.session_id, "assistant", `\n— done: ${ev.summary}`);
          }
          showToast(`child ${ev.session_id.slice(0, 12)} done`);
          break;
        }
        case "agent_tokens": {
          // Per-child token delta from the sidecar. Fleet View reads via
          // getAgentTokens(id). The master session's own usage is still
          // also tracked through addUsage() in handleSdkMessage so the
          // session-wide stats panel keeps working — this is purely the
          // per-agent breakdown.
          updateAgentTokens(ev.session_id, {
            input: ev.input,
            output: ev.output,
          });
          break;
        }
        case "session_ended":
          // Worker Z: drop this session's checkpoints — message indices are
          // meaningless once the transcript is gone, and a fresh session
          // gets a new sessionId anyway.
          if (sessionId) {
            try { clearCheckpoints(sessionId); } catch { /* non-fatal */ }
          }
          sessionStarted = false;
          sessionId = null;
          sessionStartedAt = null;
          sidecarState = "idle";
          busy = false;
          endSessionStats();
          permissions.clear();
          break;
        case "permission_request": {
          const auto = permissions.enqueue({
            request_id: ev.request_id,
            tool_name: ev.tool_name,
            input: ev.input,
            suggestions: ev.suggestions,
            tool_use_id: ev.tool_use_id,
            session_id: ev.session_id,
            title: ev.title,
            description: ev.description,
            blocked_path: ev.blocked_path,
            received_at: Date.now(),
          });
          if (auto) {
            // tier-2 (session) or tier-3 (persistent) hit — auto-respond
            void respondPermission(ev.request_id, auto);
            const why = permissions.lastAutoAllowDescription;
            if (why) {
              permissions.lastAutoAllowDescription = null;
              showToast(`auto-allowed: ${why}`);
            }
          } else if (
            ev.tool_use_id
            && ev.session_id
            && sessionId
            && ev.session_id !== sessionId
            && !getDrawerOpen()
          ) {
            // Child-agent permission with no inline anchor in the visible
            // master transcript. Pop the drawer so the inline card under
            // the child's tool_use block is reachable. PermissionPrompt
            // only falls back to its modal if the drawer ends up open on
            // a different child — opening it on this request keeps the
            // inline card flow. AgentDrawer auto-selects the most recent
            // child when drawerActiveId is null.
            setDrawerActiveId(null);
            setDrawerOpen(true);
          }
          break;
        }
        case "error":
          // Auto-recover from the "session already active" handshake — the
          // sidecar still holds a master session from a prior page load.
          if (/session already active/i.test(ev.error)) {
            void recoverFromStaleSession();
            break;
          }
          // Stale resume id pointing at a deleted Claude session. Clear it
          // and start a fresh session so the user is unblocked. One toast,
          // not the raw 500-char SDK error.
          if (/no conversation found with session id/i.test(ev.error)) {
            patchSettings({ resume: undefined, continueLatest: false });
            showToast("Previous session no longer exists — starting fresh.", "info");
            sessionStarted = false;
            void startSession();
            break;
          }
          showToast(`error: ${ev.error}`);
          // Errors with an id are RPC replies (e.g. upload_bytes auth failure);
          // the rpcCall promise already rejects so callers handle them locally.
          // Only chat-append global session errors (no id).
          if (!ev.id) {
            appendText("system", ev.error);
            finalize();
          }
          if (!sessionStarted) sidecarState = "error";
          break;
        case "hook_test_result":
          window.dispatchEvent(
            new CustomEvent("clawdui:hook-test-result", {
              detail: {
                stdout: ev.stdout,
                stderr: ev.stderr,
                exit: ev.exit,
                error: ev.error,
              },
            }),
          );
          break;
        case "remote_control_state":
          rcState = ev.state;
          rcForwarded = ev.forwarded;
          rcError = ev.error ?? null;
          break;
        case "mobile_pair_url":
        case "mobile_pair_error":
          // Delivered to MobilePair via the event bus; nothing else to do.
          break;
        case "ack":
        case "pong":
        case "result":
          break;
      }
      queueMicrotask(() => scrollEl?.scrollTo({ top: scrollEl.scrollHeight }));
    });
    unlistenStderr = await safeListen<{ line: string }>("sidecar-stderr", (e) => {
      stderrLines = [...stderrLines, e.payload.line].slice(-100);
    });
    window.addEventListener("keydown", onGlobalKeydown);
    await startSession();
    // populate skills once the sidecar is up
    void refreshSkills();
    void refreshSessions();
    void refreshWorktrees();
    // Boot-time auth probe — fires the auth_status CLI command so the
    // SigninGate has a definitive signed-in/signed-out result. Without
    // this, the `auth` section stays in its unknown initial state and
    // session_start fails silently with "Not logged in".
    void authStatus();
    // Boot-time CLI probe — guarantees cliFound is resolved even if the
    // sidecar's unsolicited cli_status broadcast was missed (e.g. fired
    // before the frontend listener attached). The shared listener also
    // catches the broadcast, so this is a belt-and-braces safety net.
    void refreshClaudePath();
    // restore previously open editor tabs
    void editorTabs.restorePersisted();

    // First-run onboarding tour. The completion flag is now part of the
    // unified settings store (already hydrated above). webview
    // localStorage is unreliable across re-installs and gets wiped
    // when the WebKit data dir is cleared, which was making the tour
    // re-trigger on every launch.
    const completed = getSettings().onboardingCompleted === true;
    // eslint-disable-next-line no-console
    console.log(`[onboarding] auto-trigger: completed=${completed}`);
    if (!completed) {
      await tick();
      requestAnimationFrame(() => {
        onboardingOpen = true;
      });
    }
  });

  // Drives the elapsed-time readout while the agent is busy. Cheap — a
  // single 1Hz tick that only mutates state during an active turn.
  const watchdogTimer = setInterval(() => {
    if (busy) nowTick = Date.now();
  }, 1000);

  onDestroy(() => {
    unlistenEvent?.();
    unlistenStderr?.();
    unsubscribeAgentCancel?.();
    unsubscribeAgentCancel = null;
    clearInterval(watchdogTimer);
    window.removeEventListener("keydown", onGlobalKeydown);
    window.removeEventListener("safe-invoke-toast", onSafeInvokeToast);
    teardownTopObserver();
    for (const t of toasts) {
      if (t.timer) clearTimeout(t.timer);
    }
  });
</script>

<div class="atmosphere"></div>

{#if !$settingsLoaded}
  <div class="settings-hydrating" aria-busy="true" aria-label="Loading settings"></div>
{:else}
<div class="page">
<SystemBanner
  on:action={(e) => {
    if (e.detail === "open-doctor") {
      rightActive = "doctor";
    } else if (e.detail === "open-in-app") {
      showToast(
        "Launch the Tauri build via `npm run tauri dev` to enable native features.",
        "info",
      );
    }
  }}
/>
<main class="shell">
  <div
    class="left-bar-wrap"
    class:donated={$settings.donated}
    class:mobile-open={mobileNav === "left"}
  >
  <ActivityBar
    position="left"
    tourId="left-activity-bar"
    items={leftItems}
    activeId={leftActive}
    on:toggle={(e) => {
      if (e.detail.id === "settings") {
        // Settings opens as a full-window overlay, not a side pane.
        settingsOpen = true;
      } else if (e.detail.id === "donate") {
        openDonatePage();
        patchSettings({ donated: true });
        showToast("♥ Thank you. ClawdUI is sustained by tips like yours.", "info");
      } else if (e.detail.id === "skills") {
        skillsOpen = true;
      } else if (e.detail.id === "hooks") {
        // Worker T: open the hooks debugger overlay.
        hooksDebuggerOpen = true;
      } else if (e.detail.id === "fleet") {
        // Fleet View is a main-pane mode, not a side pane. Toggle it
        // independently of leftActive so the workspace pane state survives.
        fleetView = !fleetView;
      } else {
        toggleLeft(e.detail.id);
      }
      // Worker AE: on mobile, dismiss the activity-bar overlay after a pick.
      if (typeof window !== "undefined" && window.innerWidth <= 640) {
        mobileNav = null;
      }
    }}
  />
  </div>

  {#if leftActive}
    <div class="side-pane-wrap left">
    <SidePane
      position="left"
      title={leftPaneTitle(leftActive)}
      width={leftActive === "sessions" || leftActive === "worktrees" ? 400 : 320}
    >
      {#if leftActive === "workspace"}
        <WorkspacePanel
          on:file-selected={(e) => {
            void editorTabs.openFile(e.detail.path).catch((err) =>
              showToast(`open failed: ${err}`),
            );
          }}
          on:pivot-cwd={(e) => void newSession((e as CustomEvent).detail?.cwd ?? getSettings().cwd ?? null)}
        />
      {:else if leftActive === "sessions"}
        <div class="pane-pad">
          <SessionsPanel
            on:session-action={(e) => {
              const action = e.detail.kind;
              showToast(
                `${action === "resume" ? "Resuming session" : "Forking session"} ${e.detail.id.slice(0, 8)}…`,
              );
              void newSession();
            }}
            on:open-review={(e) => {
              ultrareviewTarget = e.detail.target;
              rightActive = "review";
              showToast(`Ultrareview prefilled → ${e.detail.target}`);
            }}
            on:open-pr-picker={() => (prPickerOpen = true)}
            on:toast={(e) => showToast(e.detail)}
            on:pivot-cwd={(e) => void newSession((e as CustomEvent).detail?.path ?? null)}
          />
        </div>
      {:else if leftActive === "worktrees"}
        <div class="pane-pad">
          <WorktreesPanel
            on:toast={(e) => showToast(e.detail)}
            on:pivot-cwd={(e) => void newSession((e as CustomEvent).detail?.path ?? null)}
          />
        </div>
      {/if}
    </SidePane>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="side-pane-close" on:click={() => (leftActive = null)} aria-label="Close panel"></div>
    </div>
  {/if}

  <section class="pane">
    <header class="topbar">
      <button
        type="button"
        class="hamburger-btn"
        aria-label="Open navigation"
        aria-expanded={mobileNav === "left"}
        on:click={() => (mobileNav = mobileNav === "left" ? null : "left")}
      >
        <span class="hamburger-lines" aria-hidden="true">
          <span></span><span></span><span></span>
        </span>
      </button>
      <div class="title-block">
        <span class="eyebrow">CHAT · STREAMING SESSION</span>
        <h1>{$settings.model || activeModel || "Claude"}</h1>
      </div>
      <div class="topbar-right">
        <button
          type="button"
          class="hamburger-btn hamburger-btn-right"
          aria-label="Open tools"
          aria-expanded={mobileNav === "right"}
          on:click={() => (mobileNav = mobileNav === "right" ? null : "right")}
        >
          <span class="hamburger-lines" aria-hidden="true">
            <span></span><span></span><span></span>
          </span>
        </button>
        <!-- Worker U: PLAN MODE indicator. Click to toggle off. -->
        {#if planMode}
          <button
            type="button"
            class="plan-pill"
            title="Plan mode is ON — click to disable"
            on:click={() => {
              planMode = false;
              applyPlanModeSystemPrompt(false);
              showToast("plan mode OFF", "info");
            }}
          >
            <span class="plan-dot" aria-hidden="true"></span>
            <span>PLAN MODE</span>
          </button>
        {/if}
        {#if busy}
          <button
            class="skills-btn stop-btn"
            on:click={() => void interrupt()}
            title="Stop streaming (Esc)"
          >
            <span class="stop-icon" aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
              </svg>
            </span>
            <span>Stop</span>
          </button>
        {/if}
        <button
          class="skills-btn primary-btn"
          on:click={() => void newSession()}
          title="New Session (⌘N)"
        >
          <span class="skills-icon" aria-hidden="true"><Plus size={14} stroke={1.7} /></span>
          <span>New</span>
        </button>
        <!-- Worker Z: opens CheckpointDrawer overlay. -->
        <button
          class="skills-btn"
          on:click={() => (checkpointDrawerOpen = true)}
          title="Checkpoints (/checkpoints)"
        >
          <span>Checkpoints</span>
        </button>
        <!-- Worker T: context-window utilization pill. Click → /compact. -->
        <button
          class="compact-pill mono tone-{compactPillTone}"
          type="button"
          title={contextUsedTokens > 0
            ? `Context: ${contextUsedTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens. Click to /compact.`
            : "Context unknown — click to /compact anyway."}
          on:click={() => handleSlashCommand({ command: "compact", args: "" })}
        >
          {#if compactPillTokK}{compactPillTokK}k{:else}—{/if} / {compactPillLimK}k · {compactPillPct}%
        </button>
        <!-- Worker AN: collapsed health surface. Hidden when everything is healthy;
             surfaces a single pill when sidecar/CLI is degraded. Click → Doctor pane. -->
        {#if healthIssue}
          <button
            type="button"
            class="health-issue mono tone-{healthIssue.tone}"
            on:click={() => (rightActive = "doctor")}
            aria-label={healthIssue.aria}
            title={healthIssue.title}
          >
            <span class="dot {healthIssue.tone}"></span>
            <span>{healthIssue.label}</span>
          </button>
        {/if}
      </div>
    </header>

    <div class="work-area" bind:this={chatColEl}>
      {#if resumeBuffering}
        <div class="resume-spinner-overlay" role="status" aria-live="polite">
          <div class="resume-spinner-card">
            <div class="resume-spinner-ring" aria-hidden="true"></div>
            <div class="resume-spinner-label">Loading session history…</div>
            <div class="resume-spinner-sub mono">
              Reading transcript from disk
            </div>
          </div>
        </div>
      {/if}
      {#if editorOpen}
        <section
          class="editor-stack"
          style="flex: {editorRatio} 1 0; min-height: 0;"
          aria-label="Code editor"
        >
          <EditorTabs />
          <Editor on:toast={(e) => showToast(e.detail)} />
        </section>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="split-divider"
          role="separator"
          aria-orientation="horizontal"
          tabindex="0"
          aria-label="Resize editor / chat"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Math.round(editorRatio * 100)}
          on:mousedown={onSplitDown}
          on:keydown={(e) => {
            if (e.key === "ArrowUp") {
              editorRatio = Math.max(0.15, editorRatio - 0.04);
              e.preventDefault();
            } else if (e.key === "ArrowDown") {
              editorRatio = Math.min(0.85, editorRatio + 0.04);
              e.preventDefault();
            } else if (e.key === "Home") {
              editorRatio = 0.15;
              e.preventDefault();
            } else if (e.key === "End") {
              editorRatio = 0.85;
              e.preventDefault();
            }
          }}
        ></div>
      {/if}
      {#if fleetView}
        <section
          class="chat-stack fleet-host"
          style={editorOpen ? `flex: ${1 - editorRatio} 1 0; min-height: 0;` : ""}
          aria-label="Fleet View"
        >
          <FleetView />
        </section>
      {:else}
      <section
        class="chat-stack"
        style={editorOpen ? `flex: ${1 - editorRatio} 1 0; min-height: 0;` : ""}
        aria-label="Chat"
      >
        <div class="master-row" data-tour="master-row">
          <AgentTabs />
          <div class="master-row-stats">
            <HUD
              startTime={sessionStartedAt}
              model={activeModel}
              modelAlias={$settings.model}
              permissionMode={$settings.permissionMode}
              maxBudgetUsd={$settings.maxBudgetUsd}
            />
          </div>
        </div>
        <div class="messages" class:centered={messages.length === 0} bind:this={scrollEl}>
          {#if $chatWindow.sessionId && messages.length > 0 && $chatWindow.totalSeq > RESUME_INITIAL_LIMIT}
            {#if $chatWindow.fetching}
              <div class="resume-backfill-chip mono" role="status" aria-live="polite">
                <span class="spinner-dot"></span>
                Loading older messages…
              </div>
            {:else if $chatWindow.done}
              <div class="resume-backfill-chip mono done" role="status" aria-live="polite">
                Beginning of conversation
              </div>
            {:else}
              <div class="resume-backfill-chip mono idle" role="status" aria-live="polite">
                Scroll up to load older messages ({$chatWindow.oldestSeq.toLocaleString()} earlier)
              </div>
            {/if}
          {/if}
          {#if messages.length === 0}
            <div class="hero">
              <EmptyState
                model={activeModel}
                permissionMode={$settings.permissionMode}
                on:live-model={(e) =>
                  void liveApply(
                    SETTING_FIELDS.find((f) => f.key === "model")!,
                    e.detail,
                  )}
                on:live-permission={(e) =>
                  void liveApply(
                    SETTING_FIELDS.find((f) => f.key === "permissionMode")!,
                    e.detail,
                  )}
              >
                <div class="hero-composer" slot="composer" data-tour="composer">
                  <Composer
                    bind:this={composer}
                    disabled={!sessionStarted}
                    disabledReason={composerDisabledReason}
                    {busy}
                    on:send={(e) => void send(e.detail)}
                    on:interrupt={() => void interrupt()}
                    on:slashCommand={(e) => handleSlashCommand(e.detail)}
                  />
                </div>
              </EmptyState>
            </div>
          {:else}
            {#each messages as msg, i (i)}
              {#if isVisibleInMainChat(msg)}
                <div data-msg-row class="msg-row">
                  <MessageBlock
                    message={msg}
                    view="chat"
                    on:quote={(e) => composer?.insertText(e.detail.text)}
                    on:regenerate={() => void regenerateLastTurn(i)}
                    on:edit={(e) => editUserMessage(i, e.detail.text)}
                    on:resend={(e) => void resendUserMessage(i, e.detail.text)}
                    on:cancel-queued={(e) => cancelQueuedPrompt(e.detail.queueId)}
                  />
                </div>
              {/if}
            {/each}
            {#if busy}
              <div class="thinking-row mono">
                <span class="dot"></span>
                <span>agent working · {fmtElapsed(busyMs)}</span>
                <span class="cursor">▌</span>
                {#if idleMs > STALL_MS}
                  <!-- Idle escape hatch: after 60s with no sidecar event the
                       Force-stop button + sidecar-log toggle appear so a user
                       can actually kill a genuinely stuck turn. We keep the
                       LANGUAGE non-alarming — long tool chains are normal. -->
                  <button class="diag-btn" type="button" on:click={() => void interrupt()}>
                    Force stop
                  </button>
                  <button class="diag-btn" type="button" on:click={() => (stalledOpen = !stalledOpen)}>
                    {stalledOpen ? "Hide" : "Show"} sidecar log
                  </button>
                {/if}
              </div>
              {#if idleMs > STALL_MS && stalledOpen}
                <pre class="stderr-block mono">{stderrLines.length > 0 ? stderrLines.slice(-30).join("\n") : "(no stderr captured — sidecar is silent)"}</pre>
              {/if}
            {/if}
          {/if}
        </div>

        {#if messages.length > 0}
          <div class="active-composer" data-tour="composer">
            <Composer
              bind:this={composer}
              disabled={!sessionStarted}
              disabledReason={composerDisabledReason}
              {busy}
              on:send={(e) => void send(e.detail)}
              on:interrupt={() => void interrupt()}
              on:slashCommand={(e) => handleSlashCommand(e.detail)}
            />
            <div class="active-readout mono" data-tour="readout">
              <span data-tour="token-tag"><TokenTag /></span>
              <div class="active-pickers">
                <ModelPicker
                  variant="cell"
                  activeModel={activeModel}
                  bind:open={modelPickerOpen}
                  on:apply={(e) =>
                    void liveApply(
                      SETTING_FIELDS.find((f) => f.key === "model")!,
                      e.detail,
                    )}
                />
                <PermissionPicker
                  variant="cell"
                  on:apply={(e) =>
                    void liveApply(
                      SETTING_FIELDS.find((f) => f.key === "permissionMode")!,
                      e.detail,
                    )}
                />
              </div>
            </div>
          </div>
        {/if}
      </section>
      {/if}
    </div>

    <AgentDrawer />

    {#if terminalOpen}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="term-divider"
        role="separator"
        aria-orientation="horizontal"
        tabindex="0"
        title="Drag to resize terminal · Arrow keys when focused"
        aria-label="Resize terminal"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(
          (terminalHeight / Math.max(1, typeof window !== "undefined" ? window.innerHeight : 1000)) * 100,
        )}
        on:mousedown={onDividerDown}
        on:keydown={(e) => {
          const maxH = typeof window !== "undefined" ? window.innerHeight - 200 : 1000;
          if (e.key === "ArrowUp") {
            terminalHeight = Math.min(maxH, terminalHeight + 16);
            e.preventDefault();
          } else if (e.key === "ArrowDown") {
            terminalHeight = Math.max(120, terminalHeight - 16);
            e.preventDefault();
          } else if (e.key === "Home") {
            terminalHeight = 120;
            e.preventDefault();
          } else if (e.key === "End") {
            terminalHeight = maxH;
            e.preventDefault();
          }
        }}
      ></div>
      <section
        class="term-pane"
        style="height: {terminalHeight}px"
        aria-label="Terminal"
      >
        <header class="term-header">
          <span class="eyebrow">TERMINAL</span>
          <button class="term-close" on:click={toggleTerminal} title="Close (Ctrl/Cmd+`)">
            <XIcon size={14} stroke={1.8} />
          </button>
        </header>
        <div class="term-body">
          {#key terminalOpen}
            <Terminal />
          {/key}
        </div>
      </section>
    {/if}
  </section>

  {#if rightActive}
    <div class="side-pane-wrap right">
    <SidePane position="right" title={rightPaneTitle(rightActive)} width={rightActive === "remote" || rightActive === "review" ? 480 : 360}>
      {#if rightActive === "auth"}
        <AuthPanel embedded on:toast={(e) => showToast(e.detail)} />
      {:else if rightActive === "doctor"}
        <DoctorPanel embedded />
      {:else if rightActive === "update"}
        <UpdatePanel embedded />
      {:else if rightActive === "review"}
        <UltrareviewPanel embedded initialTarget={ultrareviewTarget} />
      {:else if rightActive === "remote" && $settings.customRelayEnabled}
        <RemoteControlPanel
          embedded
          state={rcState}
          forwardedCount={rcForwarded}
          lastError={rcError}
          on:apply={() => void applyRemoteControl()}
          on:disconnect={() => void applyRemoteControl()}
        />
      {:else if rightActive === "help"}
        <div class="pane-pad help-pane">
          <h3>Help & docs</h3>
          <button
            type="button"
            class="replay-tour"
            on:click={() => {
              onboardingOpen = true;
            }}
          >Replay tour</button>
          <p class="muted">External links</p>
          <ul>
            <li><a href="https://docs.anthropic.com/claude/docs" target="_blank" rel="noreferrer">Claude docs</a></li>
            <li><a href="https://github.com/anthropics/claude-code" target="_blank" rel="noreferrer">claude-code on GitHub</a></li>
          </ul>
        </div>
      {/if}
    </SidePane>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="side-pane-close" on:click={() => (rightActive = null)} aria-label="Close panel"></div>
    </div>
  {/if}

  <div class="right-bar-wrap" class:mobile-open={mobileNav === "right"}>
  <ActivityBar
    position="right"
    tourId="right-activity-bar"
    items={rightItems}
    activeId={rightActive}
    on:toggle={(e) => {
      if (e.detail.id === "review") ultrareviewTarget = undefined;
      if (e.detail.id === "terminal") {
        toggleTerminal();
        return;
      }
      if (e.detail.id === "pair") {
        mobilePair?.openPair();
        return;
      }
      toggleRight(e.detail.id);
      // On mobile, dismiss the overlay after a tool selection.
      if (typeof window !== "undefined" && window.innerWidth <= 640) {
        mobileNav = null;
      }
    }}
  />
  </div>
  {#if mobileNav}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="mobile-backdrop"
      on:click={() => (mobileNav = null)}
    ></div>
  {/if}
</main>
</div>
{/if}

<!-- Headless MobilePair: only the dialog renders; trigger is the right
     ActivityBar "pair" item which calls openPair() via bind:this. -->
<MobilePair
  bind:this={mobilePair}
  headless={true}
  {sessionStarted}
  {rpc}
  onSidecarEvent={subscribeSidecarEvent}
/>

<CommandPalette
  bind:open={commandPaletteOpen}
  commands={paletteCommands}
  onClose={() => (commandPaletteOpen = false)}
/>

<!-- Skills overlay still available via the legacy "Skills" pill in topbar
     (and Cmd+B → activity bar Skills). Keep small overlay version. -->
<SkillsPanel
  open={skillsOpen}
  on:close={() => (skillsOpen = false)}
  on:insert={(e) => {
    composer?.insertSkillCommand(e.detail);
    skillsOpen = false;
  }}
/>

<!-- Settings overlay: full-window modal, not a side pane.
     Triggered by the gear in the left activity bar or Cmd+, -->
<SettingsPanel
  embedded={false}
  open={settingsOpen}
  on:close={() => (settingsOpen = false)}
  on:restart={() => {
    settingsOpen = false;
    void newSession();
  }}
  on:live-apply={(e) => void liveApply(e.detail.field, e.detail.value)}
  on:hook-test-run={(e) => void runHookTest(e.detail)}
/>

<!-- Memory viewer overlay — opened by /memory. Read-only view of the
     project auto-memory + user-global + project CLAUDE.md files. -->
<MemoryViewer bind:open={memoryOpen} on:close={() => (memoryOpen = false)} />

<!-- Worker T: hooks debugger overlay — opened by /hooks and left activity bar. -->
<HooksDebugger
  bind:open={hooksDebuggerOpen}
  onSidecarEvent={subscribeSidecarEvent}
  on:close={() => (hooksDebuggerOpen = false)}
/>

<!-- Worker Z: checkpoint browser overlay. Opens via topbar button or
     /checkpoints. Backing store: src/lib/checkpoints.ts. -->
<CheckpointDrawer bind:open={checkpointDrawerOpen} />

<PermissionPrompt />
<!-- Sidecar responses are routed via permissions.setResponder() registered in
     onMount so InlinePermissionCard and PermissionPrompt share a single path. -->


<PrPicker
  open={prPickerOpen}
  on:close={() => (prPickerOpen = false)}
  on:pick={(e) => void startFromPr(e.detail)}
  on:toast={(e) => showToast(e.detail)}
/>

<!-- Worker U: surfaces backing /permissions, /commit, /init, /feedback. -->
<PermissionPicker bind:overlayOpen={permissionsOpen} />
<CommitModal
  bind:open={commitOpen}
  suggestedMessage={commitSuggestion}
  on:close={() => (commitOpen = false)}
  on:toast={(e) => showToast(e.detail.message, e.detail.kind ?? "info")}
/>
<InitWizard
  bind:open={initWizardOpen}
  on:close={() => (initWizardOpen = false)}
  on:toast={(e) => showToast(e.detail.message, e.detail.kind ?? "info")}
/>
<FeedbackModal
  bind:open={feedbackOpen}
  on:close={() => (feedbackOpen = false)}
  on:toast={(e) => showToast(e.detail.message, e.detail.kind ?? "info")}
/>

<!-- Boot-time auth gate. Renders itself only when authSignedIn===signed-out,
     so it stays invisible during boot/check and after login. -->
<SigninGate />

<Onboarding
  open={onboardingOpen}
  onClose={async () => {
    // Persist completion BEFORE flipping the in-memory flag so a
    // user quitting the app on the very same frame as Done/Esc does
    // not lose the write. flushSettings() bypasses the 150ms debounce.
    patchSettings({ onboardingCompleted: true });
    await flushSettings();
    onboardingOpen = false;
  }}
/>


{#if toasts.length > 0}
  <div class="toast-stack" aria-live="polite">
    {#if hiddenToastCount > 0 && !toastsExpanded}
      <button
        class="toast-more mono"
        type="button"
        on:click={() => (toastsExpanded = true)}
        title="Show {hiddenToastCount} older notification{hiddenToastCount === 1 ? '' : 's'}"
      >+{hiddenToastCount} more</button>
    {/if}
    {#each visibleToasts as t (t.id)}
      <div
        class="toast mono"
        class:err={t.kind === "error"}
        class:info={t.kind === "info"}
        role={t.kind === "error" ? "alert" : "status"}
      >
        <span class="toast-msg">{t.msg}</span>
        <button
          class="toast-close"
          type="button"
          title={t.kind === "error" ? "Dismiss" : "Close early"}
          aria-label="Close notification"
          on:click={() => dismissToast(t.id)}
        >×</button>
      </div>
    {/each}
    {#if toasts.length > 1}
      <button
        class="toast-clear-all mono"
        type="button"
        on:click={dismissAllToasts}
        title="Clear all notifications"
      >Clear all</button>
    {/if}
  </div>
{/if}

<style>
  .settings-hydrating {
    /* Invisible mount-gate placeholder. Holds layout while
       settings.json is read so the UI does not flash with default
       values then re-render. */
    position: fixed;
    inset: 0;
    background: transparent;
    pointer-events: none;
  }
  .page {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  .shell {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: row;
    width: 100%;
    overflow: hidden;
  }
  .pane-pad {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .help-pane h3 {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-weight: 500;
  }
  .help-pane ul {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .help-pane a {
    color: var(--accent);
    text-decoration: none;
  }
  .help-pane a:hover { text-decoration: underline; }
  .help-pane .muted { color: var(--fg-3); font-size: 14px; }
  .help-pane .replay-tour {
    display: inline-flex;
    align-items: center;
    background: var(--surface);
    color: var(--fg);
    border: 1px solid var(--border, var(--line));
    border-radius: var(--r-2);
    padding: 6px 12px;
    font: inherit;
    font-size: 14px;
    cursor: pointer;
    margin-bottom: 8px;
    transition: border-color 120ms ease-out, color 120ms ease-out;
  }
  .help-pane .replay-tour:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  /* Wrapper used purely as a data-tour anchor. Must be inline so it
     doesn't break the topbar pill row layout. */
  :global(.tour-anchor) {
    display: inline-flex;
    align-items: center;
  }

  .pane {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
  }
  /* Worker AN: replaces the legacy .status-trio. Single compact pill, only
     rendered when sidecar/CLI is degraded. Silent-green default keeps the
     topbar clean. */
  .health-issue {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px;
    margin-left: 4px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg-2);
    font-family: var(--font-mono);
    font-size: 12.5px;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition: border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .health-issue:hover { color: var(--fg); border-color: var(--border-hi); }
  .health-issue.tone-amber { border-color: oklch(0.40 0.10 75); color: var(--accent, #e0a050); }
  .health-issue.tone-red   { border-color: oklch(0.40 0.15 25); color: var(--danger, #ff7070); }
  .health-issue .dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: currentColor;
    box-shadow: 0 0 6px currentColor;
  }
  /* Worker T: context-window compaction pill. */
  .compact-pill {
    display: inline-flex;
    align-items: center;
    height: 32px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg-2);
    font-family: var(--font-mono);
    font-size: 12.5px;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition: border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .compact-pill:hover { color: var(--fg); border-color: var(--border-hi); }
  .compact-pill.tone-green { border-color: oklch(0.30 0.08 155); color: var(--success, #6ce28a); }
  .compact-pill.tone-amber { border-color: oklch(0.40 0.10 75);  color: var(--accent, #e0a050); }
  .compact-pill.tone-red   { border-color: oklch(0.40 0.15 25);  color: var(--danger, #ff7070); }
  .pane > :global(:not(.work-area):not(.term-pane)) {
    flex: 0 0 auto;
  }
  .work-area {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* anchor for .resume-spinner-overlay (position: absolute) */
    position: relative;
  }
  .editor-stack {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    border-bottom: none;
  }
  .chat-stack {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1 1 auto;
    overflow: hidden;
  }
  .split-divider {
    flex: 0 0 4px;
    cursor: row-resize;
    background: var(--line);
    transition: background var(--dur-1) var(--ease);
  }
  .split-divider:hover {
    background: var(--accent-line, var(--accent));
  }
  .split-divider:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    background: var(--accent-line, var(--accent));
  }
  .messages {
    flex: 1 1 auto;
  }
  .term-pane {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-top: 1px solid var(--border, var(--line));
    background: var(--bg);
  }
  .term-divider {
    flex: 0 0 8px;
    cursor: row-resize;
    background: var(--line);
    transition: background var(--dur-1) var(--ease);
    position: relative;
  }
  /* Grip dots so the handle is discoverable instead of looking like a
     decorative line. Centered horizontally on the divider. */
  .term-divider::before {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 36px;
    height: 3px;
    border-radius: 999px;
    background: var(--fg-4);
    opacity: 0.4;
    transition: opacity var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
  }
  .term-divider:hover {
    background: var(--accent-soft, var(--accent-line));
  }
  .term-divider:hover::before {
    background: var(--accent);
    opacity: 0.9;
  }
  .term-divider:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    background: var(--accent-soft);
  }
  .term-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    border-bottom: 1px solid var(--line);
    flex: 0 0 auto;
  }
  .term-header .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12.5px;
    color: var(--fg-4);
    font-family: var(--font-mono);
  }
  .term-close {
    background: transparent;
    border: 1px solid var(--border, var(--line));
    color: var(--fg-3);
    padding: 0 8px;
    border-radius: var(--r-1);
    cursor: pointer;
    font-size: 17px;
    line-height: 1.6;
  }
  .term-close:hover { color: var(--fg); border-color: var(--accent-line, var(--accent)); }
  .term-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .term-toggle {
    position: fixed;
    right: 14px;
    bottom: 14px;
    z-index: 50;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--surface);
    color: var(--fg-2);
    border: 1px solid var(--border, var(--line));
    border-radius: var(--r-2);
    padding: 6px 10px;
    font-size: 14.5px;
    cursor: pointer;
    letter-spacing: 0.08em;
    box-shadow: var(--shadow-sm, none);
    transition: color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
  }
  .tt-ico { display: inline-flex; align-items: center; }
  .term-toggle:hover { color: var(--fg); border-color: var(--accent-line, var(--accent)); }
  .term-toggle.active { color: var(--accent); border-color: var(--accent-line, var(--accent)); }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 22px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .title-block { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .title-block h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 23.5px;
    font-weight: 500;
    letter-spacing: -0.02em;
    color: var(--fg);
    line-height: 1.1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  /* Worker U: plan-mode topbar pill. Bordered accent + pulsing dot. */
  .plan-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--accent);
    background: color-mix(in oklab, var(--accent) 18%, var(--surface));
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.08em;
    cursor: pointer;
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .plan-pill:hover { filter: brightness(1.1); }
  .plan-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: plan-pulse 1.6s ease-in-out infinite;
  }
  @keyframes plan-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .skills-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--fg-2);
    height: 32px;
    padding: 0 14px;
    border-radius: 999px;
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    transition: border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .skills-btn:hover {
    border-color: var(--accent-line);
    color: var(--fg);
  }
  .skills-icon {
    display: inline-flex;
    align-items: center;
    color: var(--accent);
  }
  .primary-btn {
    background: var(--accent-soft);
    border-color: var(--accent-line);
    color: var(--fg);
  }
  .primary-btn:hover { border-color: var(--accent); }
  .stop-btn {
    background: var(--surface);
    border-color: var(--danger);
    color: var(--danger);
  }
  .stop-btn:hover {
    border-color: var(--danger);
    color: var(--danger);
    filter: brightness(1.1);
  }
  .stop-icon {
    display: inline-flex;
    align-items: center;
    color: var(--danger);
  }

  .topbar-more {
    position: relative;
  }
  .topbar-more > summary {
    list-style: none;
    cursor: pointer;
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--fg-3);
    font-size: 15px;
    line-height: 1;
    user-select: none;
  }
  .topbar-more > summary::-webkit-details-marker { display: none; }
  .topbar-more > summary:hover { color: var(--fg); border-color: var(--accent-line); }
  .topbar-more[open] > summary { color: var(--accent); border-color: var(--accent); }
  .topbar-more-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    background: var(--elevated);
    border: 1px solid var(--accent-line);
    border-radius: var(--r-2);
    padding: 12px 14px;
    min-width: 480px;
    max-width: 560px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: var(--shadow-lg);
    z-index: 60;
  }
  .more-pickers {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .more-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .more-mobile { flex: 1 1 auto; }
  .more-mobile :global(button) { width: 100%; }
  .more-row {
    background: transparent;
    border: 1px solid var(--border);
    padding: 6px 10px;
    border-radius: 999px;
    color: var(--fg);
    text-align: left;
    font: inherit;
    font-size: 13px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .more-row:hover { border-color: var(--accent); background: var(--accent-soft); }
  .more-stats {
    border-top: 1px solid var(--border);
    padding-top: 10px;
    overflow: hidden;
  }
  /* HUD inside the more menu: 3-col compact grid spanning full width, no
     wasted left padding, ellipsis on long values like model name. */
  .more-stats :global(.hud) {
    display: grid !important;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px 14px;
    padding: 0;
    border: 0;
    background: transparent;
    width: 100%;
  }
  .more-stats :global(.hud .div) { display: none; }
  .more-stats :global(.hud .cell) {
    min-width: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
  }
  .more-stats :global(.hud .eyebrow) {
    font-size: 10px;
    letter-spacing: 0.12em;
    color: var(--fg-4);
  }
  .more-stats :global(.hud .value) {
    font-size: 12.5px;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  /* Hide the MODE cell — permission mode is already shown via the PERM
     picker right under the composer; no need to duplicate it in the HUD. */
  .more-stats :global(.hud .cell.wide) { display: none; }

  /* Empty-state hero: composer + readout centered on the chat surface, the
     way a search page lays out before the first query. After the first send
     this branch unmounts and the conventional bottom composer takes over. */
  .messages.centered {
    justify-content: center;
    align-items: center;
    padding: 18px 22px;
  }
  .hero {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 26px;
    width: 100%;
    margin: auto 0;
  }
  .hero-composer { width: 100%; }
  .messages.centered {
    padding: 18px 22px;
    align-items: stretch;
  }

  /* Main row hosts the agent tab AND the live session stats inline so the
     user sees uptime / latency / turn I/O without opening a menu. The
     SESSION + MODE cells are hidden because they're already in the input
     readout (token tag + PERM picker). */
  .master-row {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 4px 12px;
  }
  /* Strip the inner tab strip background so the outer master-row owns it. */
  .master-row :global(.agent-tabs) {
    background: transparent;
    border-bottom: 0;
    padding: 0;
    min-height: 0;
  }
  .master-row :global(.tab.master) {
    background: transparent;
    border-color: var(--border);
  }
  .master-row :global(.tab.master.active) {
    background: var(--accent-soft);
  }
  .master-row-stats {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    justify-content: flex-end;
  }
  .master-row-stats :global(.hud) {
    border: 0;
    background: transparent;
    padding: 0 6px;
    gap: 16px;
  }
  /* Show only UPTIME, LATENCY, TURN I/O — drop SESSION/MODE/MODEL/BUDGET
     since those live next to the input instead. */
  .master-row-stats :global(.hud > div:nth-of-type(n+4)) { display: none; }
  .master-row-stats :global(.hud > span:nth-of-type(n+3)) { display: none; }
  .master-row-stats :global(.hud .eyebrow) {
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--fg-4);
  }
  .master-row-stats :global(.hud .value) { font-size: 12.5px; }

  /* Active conversation: composer plus a thin model/perm rail directly under
     it so the two controls stay reachable without re-opening any menu. */
  .active-composer {
    display: flex;
    flex-direction: column;
  }
  .active-readout {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    row-gap: 8px;
    gap: 14px;
    padding: 8px 22px 14px;
    background: var(--bg);
    border-top: 1px solid var(--border);
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
  }
  .active-readout > :global(*) { min-width: 0; }
  .active-pickers {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    min-width: 0;
    max-width: 100%;
  }
  .active-pickers > :global(*) { min-width: 0; flex-shrink: 1; }
  @media (max-width: 1000px) {
    .active-readout { padding: 8px 14px 12px; gap: 8px; }
    .active-pickers { gap: 6px; }
  }
  .tok-tag {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-3);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .messages {
    overflow-y: auto;
    padding: 18px 22px 22px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
  }

  .thinking-row {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--fg-3);
    font-size: 13.5px;
    padding: 6px 12px;
    margin: 4px 18px 0;
    width: max-content;
    max-width: calc(100% - 36px);
    border-radius: 999px;
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .thinking-row .dot {
    width: 7px; height: 7px;
    border-radius: 999px;
    background: var(--accent);
    animation: pulse-ring 1.5s var(--ease) infinite;
    color: var(--accent);
    flex: 0 0 auto;
  }
  .diag-btn {
    background: transparent;
    border: 1px solid var(--danger);
    color: var(--danger);
    padding: 2px 8px;
    border-radius: var(--r-1);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .diag-btn:hover { background: var(--danger); color: var(--bg); }
  .stderr-block {
    margin: 4px 18px 12px;
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--danger);
    border-radius: var(--r-2);
    color: var(--fg-2);
    font-size: 12.5px;
    line-height: 1.4;
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
  }
  .cursor {
    color: var(--accent);
    animation: blink 1s steps(2, start) infinite;
  }

  .toast-stack {
    position: fixed;
    top: 18px;
    right: 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    z-index: 60;
    pointer-events: none;
    align-items: flex-end;
  }
  .toast-stack .toast { pointer-events: auto; }
  .toast-more, .toast-clear-all {
    pointer-events: auto;
    background: var(--elevated);
    border: 1px solid var(--border-hi);
    color: var(--fg-2);
    font: inherit;
    font-size: 11.5px;
    letter-spacing: 0.06em;
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    box-shadow: var(--shadow-sm);
  }
  .toast-more:hover, .toast-clear-all:hover {
    border-color: var(--accent);
    color: var(--fg);
  }
  .toast-clear-all {
    margin-top: 2px;
    color: var(--fg-3);
  }
  .toast {
    background: var(--surface);
    border: 1px solid var(--border-hi);
    color: var(--fg);
    padding: 10px 14px 10px 16px;
    border-radius: var(--r-3);
    box-shadow: var(--shadow-md);
    font-size: 16px;
    z-index: 60;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: min(720px, 90vw);
    animation: slide-in-right var(--dur-2) var(--ease);
  }
  @keyframes slide-in-right {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: none; }
  }
  .toast-msg {
    flex: 1 1 auto;
    line-height: 1.4;
    word-break: break-word;
  }
  .toast-close {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    color: var(--fg-3);
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 2px 8px;
  }
  .toast-close:hover {
    color: var(--fg);
    border-color: var(--border);
  }
  .toast.info {
    border-color: var(--accent-line);
    box-shadow:
      var(--shadow-md),
      0 0 18px 1px color-mix(in oklch, var(--accent) 30%, transparent);
    animation:
      slide-in-right var(--dur-2) var(--ease),
      glow-pulse 5s ease-out forwards;
  }
  .toast.err {
    border-color: var(--danger);
    background: color-mix(in oklch, var(--danger) 14%, var(--surface));
    color: var(--fg);
    box-shadow:
      var(--shadow-md),
      0 0 22px 2px color-mix(in oklch, var(--danger) 45%, transparent);
  }
  .toast.err .toast-close {
    color: var(--danger);
    border-color: var(--danger);
  }
  .toast.err .toast-close:hover {
    background: var(--danger);
    color: var(--bg);
  }
  .donate-overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .donate-modal {
    background: var(--surface);
    border: 1px solid var(--border-hi);
    border-radius: var(--r-3);
    padding: 22px 24px;
    max-width: 420px;
    box-shadow: var(--shadow-lg);
    color: var(--fg);
  }
  .donate-lead { font-size: 17px; margin: 0 0 8px; color: var(--fg); }
  .donate-sub { font-size: 13px; color: var(--fg-3); margin: 0 0 16px; line-height: 1.5; }
  .donate-row { display: flex; gap: 8px; justify-content: flex-end; }
  .donate-btn {
    padding: 6px 14px;
    border-radius: var(--r-2);
    font-size: 13.5px;
    cursor: pointer;
    border: 1px solid var(--border-hi);
    background: var(--elevated);
    color: var(--fg);
  }
  .donate-btn.primary {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .donate-btn.ghost { background: transparent; }
  .donate-btn:hover { border-color: var(--accent); }
  /* Donate icon: red beating heart at ~72 bpm before the user has donated;
     calms to one beat every 4s after — gratitude pulse, not a nag. */
  :global(.activity-bar .ic[data-tour-item="donate"]) {
    color: #ff5a6b;
  }
  :global(.activity-bar .ic[data-tour-item="donate"]:hover) {
    color: #ff4053;
  }
  :global(.activity-bar .ic[data-tour-item="donate"] .glyph) {
    animation: heart-beat 0.833s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    filter: drop-shadow(0 0 0 transparent);
  }
  :global(.activity-bar .ic[data-tour-item="donate"] .glyph svg) {
    fill: currentColor;
    fill-opacity: 0.18;
  }
  :global(.left-bar-wrap.donated .activity-bar .ic[data-tour-item="donate"] .glyph) {
    animation: heart-beat 4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
  :global(.left-bar-wrap.donated .activity-bar .ic[data-tour-item="donate"] .glyph svg) {
    fill-opacity: 0.45;
  }
  @keyframes heart-beat {
    0%   { transform: scale(1);    filter: drop-shadow(0 0 0 rgba(255, 90, 107, 0)); }
    14%  { transform: scale(1.18); filter: drop-shadow(0 0 9px rgba(255, 90, 107, 0.85)); }
    28%  { transform: scale(1);    filter: drop-shadow(0 0 2px rgba(255, 90, 107, 0.35)); }
    42%  { transform: scale(1.10); filter: drop-shadow(0 0 6px rgba(255, 90, 107, 0.55)); }
    70%  { transform: scale(1);    filter: drop-shadow(0 0 0 rgba(255, 90, 107, 0)); }
    100% { transform: scale(1);    filter: drop-shadow(0 0 0 rgba(255, 90, 107, 0)); }
  }
  @keyframes glow-pulse {
    0% { box-shadow: var(--shadow-md), 0 0 18px 1px color-mix(in oklch, var(--accent) 30%, transparent); }
    20% { box-shadow: var(--shadow-md), 0 0 26px 3px color-mix(in oklch, var(--accent) 55%, transparent); }
    100% { box-shadow: var(--shadow-md), 0 0 0 0 transparent; }
  }

  /* =====================================================================
     Worker AE — responsive layout (phones, small tablets, large screens)
     ===================================================================== */

  /* Hamburger button: hidden on desktop, surfaces only at mobile. */
  .hamburger-btn {
    display: none;
    width: 44px;
    height: 44px;
    background: transparent;
    border: 1px solid var(--border, var(--line));
    border-radius: var(--r-2);
    color: var(--fg-2);
    cursor: pointer;
    padding: 0;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
  }
  .hamburger-btn:hover { color: var(--fg); border-color: var(--accent-line, var(--accent)); }
  .hamburger-lines {
    display: inline-flex;
    flex-direction: column;
    gap: 4px;
    width: 18px;
  }
  .hamburger-lines > span {
    display: block;
    height: 2px;
    background: currentColor;
    border-radius: 2px;
  }

  /* Mobile backdrop behind activity-bar overlays and side-pane overlays. */
  .mobile-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    z-index: 90;
    animation: fade-in 140ms ease-out;
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

  /* Wrappers around the right ActivityBar so we can apply mobile rules. */
  .right-bar-wrap {
    display: contents;
  }
  .side-pane-wrap {
    display: contents;
  }
  /* Close-tap hit-target on the unused half of the screen when a side-pane is
     opened as a mobile overlay. Hidden on desktop. */
  .side-pane-close {
    display: none;
  }

  /* -------------------- Tablet: 641px – 1023px -------------------- */
  @media (max-width: 1023px) and (min-width: 641px) {
    .topbar {
      padding: 10px 14px;
      gap: 10px;
    }
    .title-block h1 { font-size: 19px; }
    /* Side panes shrink so chat keeps breathing room. */
    :global(.sidepane) {
      max-width: 280px;
    }
    :global(.sidepane[data-side="left"]) {
      width: 260px !important;
      flex: 0 0 260px !important;
    }
    :global(.sidepane[data-side="right"]) {
      width: 280px !important;
      flex: 0 0 280px !important;
    }
  }

  /* -------------------- Mobile: ≤640px -------------------- */
  @media (max-width: 640px) {
    /* Hamburger surfaces, activity bars hide unless toggled open. */
    .hamburger-btn {
      display: inline-flex;
    }
    .left-bar-wrap,
    .right-bar-wrap {
      position: fixed;
      top: 0;
      bottom: 0;
      z-index: 100;
      background: var(--surface);
      transition: transform 220ms cubic-bezier(0.2, 0, 0, 1);
      box-shadow: var(--shadow-lg, 0 8px 30px rgba(0, 0, 0, 0.45));
    }
    .left-bar-wrap {
      left: 0;
      transform: translateX(-100%);
    }
    .right-bar-wrap {
      right: 0;
      transform: translateX(100%);
    }
    .left-bar-wrap.mobile-open,
    .right-bar-wrap.mobile-open {
      transform: translateX(0);
    }

    /* Side panes (workspace / sessions / etc.) become full-screen overlays. */
    .side-pane-wrap {
      position: fixed;
      inset: 0;
      z-index: 95;
      display: flex;
      pointer-events: none;
    }
    .side-pane-wrap.left { justify-content: flex-start; }
    .side-pane-wrap.right { justify-content: flex-end; }
    .side-pane-wrap :global(.sidepane) {
      pointer-events: auto;
      width: 88vw !important;
      max-width: 360px;
      flex: 0 0 auto !important;
      height: 100vh;
      box-shadow: var(--shadow-lg, 0 8px 30px rgba(0, 0, 0, 0.5));
    }
    .side-pane-close {
      display: block;
      flex: 1 1 auto;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.42);
    }

    .mobile-backdrop {
      display: block;
    }

    /* Topbar collapses padding, status pills wrap. */
    .topbar {
      padding: 8px 10px;
      gap: 8px;
      flex-wrap: nowrap;
    }
    .topbar > :global(*) { min-width: 0; }
    .title-block { flex: 1 1 auto; min-width: 0; }
    .title-block h1 { font-size: 16.5px; }
    .title-block .eyebrow { font-size: 10.5px; }
    .topbar-right {
      gap: 6px;
      flex-shrink: 0;
    }
    /* Hide non-essential status pills on phones; the right-hand drawer + the
       "more" menu carry their actions. */
    .topbar-right > :global(.health-issue),
    .topbar-right > :global(.compact-pill),
    .topbar-right > :global(.plan-pill) {
      display: none;
    }

    /* Make sure the shell uses the full width — no extra side gutters. */
    .shell { width: 100vw; }
    .page { width: 100vw; overflow-x: hidden; }

    /* Touch-friendly hit targets. */
    :global(.activity-bar .ic) { height: 48px; min-height: 44px; }
    :global(.topbar .skills-btn),
    :global(.topbar .stop-btn) { min-height: 40px; }

    /* AgentDrawer behaves naturally — it is already bottom-pinned. Give it
       a safe-area inset on phones with rounded corners / notches. */
    :global(.drawer) {
      padding-bottom: env(safe-area-inset-bottom);
    }
    /* Composer: edge-to-edge on phones. */
    :global(.composer) {
      padding-left: 8px;
      padding-right: 8px;
    }
  }

  /* Desktop hamburger always hidden (already display:none by default). */
  @media (min-width: 1024px) {
    .hamburger-btn { display: none; }
  }

  /* Resume — full-screen spinner overlay (phase 1) */
  .resume-spinner-overlay {
    position: absolute;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklab, var(--surface) 78%, transparent);
    backdrop-filter: blur(14px) saturate(120%);
    -webkit-backdrop-filter: blur(14px) saturate(120%);
    pointer-events: auto;
    animation: resume-overlay-in 180ms ease-out;
  }
  @keyframes resume-overlay-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .resume-spinner-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 28px 36px;
    border-radius: 16px;
    background: color-mix(in oklab, var(--surface) 88%, transparent);
    border: 1px solid color-mix(in oklab, var(--accent) 22%, transparent);
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
  }
  .resume-spinner-ring {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 2.5px solid color-mix(in oklab, var(--accent) 18%, transparent);
    border-top-color: var(--accent);
    animation: resume-ring-spin 0.9s linear infinite;
  }
  @keyframes resume-ring-spin {
    to { transform: rotate(360deg); }
  }
  .resume-spinner-label {
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--fg);
  }
  .resume-spinner-sub {
    font-size: 0.75rem;
    opacity: 0.55;
  }

  /* Resume — backfill chip (phase 2, lives inside .messages) */
  .resume-backfill-chip {
    position: sticky;
    top: 6px;
    align-self: center;
    z-index: 5;
    margin: 6px auto;
    padding: 4px 12px;
    font-size: 0.72rem;
    border-radius: 999px;
    background: color-mix(in oklab, var(--surface) 86%, transparent);
    border: 1px solid color-mix(in oklab, var(--accent) 20%, transparent);
    color: var(--fg);
    opacity: 0.92;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: max-content;
    pointer-events: none;
  }
  .resume-backfill-chip .spinner-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid color-mix(in oklab, var(--accent) 30%, transparent);
    border-top-color: var(--accent);
    animation: resume-ring-spin 0.9s linear infinite;
  }
</style>
