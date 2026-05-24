<script lang="ts">
  /**
   * Onboarding.svelte — first-run UI tour overlay.
   *
   * Highlights the 8 main UI regions of ClawdUI for new users. Targets
   * existing elements via `data-tour` and `data-tour-item` attributes —
   * does NOT add new chrome.
   *
   * Trigger: shown on first launch when `settings.onboardingCompleted`
   * is false. Re-triggerable via Help pane "Replay tour".
   *
   * Skip / Esc / final "Done" all set onboardingCompleted=true and close.
   */
  import { onMount } from "svelte";
  import { patchSettings } from "./settings";

  // Persistence of onboardingCompleted lives in the unified settings
  // store (`src/lib/settings.ts`), which writes settings.json under
  // the OS app-data dir. The parent's `onClose` callback patches the
  // store and flushes the write before unmounting this component.
  // The patchSettings() call below is the in-memory update — the
  // disk write is handled by settings.ts subscribe + flushSettings.
  // It is the source of truth for cross-launch
  // persistence.

  type StepPlacement = "right" | "left" | "below" | "above" | "center";

  type TourStep = {
    /** querySelector for the target element. */
    selector: string;
    title: string;
    body: string;
    /** Preferred tooltip placement; auto-flips when off-screen. */
    prefer: StepPlacement;
  };

  const STEPS: TourStep[] = [
    {
      selector: '[data-tour="left-activity-bar"]',
      title: "Left dock",
      body: "Navigation up top — Workspace, Sessions, Worktrees, Skills. Settings + Donate anchor the bottom. Hover any icon for its keyboard shortcut.",
      prefer: "right",
    },
    {
      selector: '[data-tour="composer"]',
      title: "Composer",
      body: "Type here. ↵ sends, Shift/Ctrl+↵ for newline, / opens skills, drop / paste files to attach.",
      prefer: "above",
    },
    {
      selector: '[data-tour="readout"], [data-tour="model-picker"]',
      title: "Model · Permission · Cost",
      body: "Below the input: live token + cost on the left, model + permission pickers on the right. They stay reachable through the whole session.",
      prefer: "above",
    },
    {
      selector: '[data-tour="master-row"]',
      title: "Main row",
      body: "The orchestrator tab plus the live UPTIME / LATENCY / TURN I/O readout. Pulsing dot = main agent is running.",
      prefer: "below",
    },
    {
      selector: '[data-tour="agent-drawer"]',
      title: "Child-agent drawer",
      body: "The main agent surfaces child agents here when it delegates. Click the strip to expand; each child gets its own transcript tab.",
      prefer: "above",
    },
    {
      selector: '[data-tour="right-activity-bar"]',
      title: "Right dock",
      body: "Tools at the top: Terminal, Ultrareview. Account row at the bottom: Pair mobile, Sign in (green dot = signed in), Doctor, Update, Help.",
      prefer: "left",
    },
    {
      selector: '[data-tour="right-activity-bar"] [data-tour-item="auth"]',
      title: "Sign in to Claude",
      body: "Status badge sits on the icon: green = signed in, red = signed out. The panel auto-polls during OAuth and closes when it succeeds.",
      prefer: "left",
    },
    {
      selector: '[data-tour="left-activity-bar"] [data-tour-item="donate"]',
      title: "Beating heart",
      body: "Click → opens buymeacoffee.com/slrsoft.ca and thanks you. Honor system. After your first tip the heart calms to a slow pulse.",
      prefer: "right",
    },
    {
      selector: '[data-tour="left-activity-bar"] [data-tour-item="settings"]',
      title: "Settings",
      body: "Theme, MCPs, hooks, plugins, environment, and the locked master orchestrator prompt.",
      prefer: "right",
    },
  ];

  type Props = { open: boolean; onClose: () => void | Promise<void> };
  let { open, onClose }: Props = $props();

  let stepIndex = $state(0);
  let rect = $state<DOMRect | null>(null);
  let tooltipEl = $state<HTMLDivElement | null>(null);
  let resolvedPlacement = $state<StepPlacement>("right");

  const total = STEPS.length;
  const currentStep = $derived(STEPS[stepIndex]);

  // Recompute target rect on step change, on resize, and on a short
  // animation frame chase (some targets fade in).
  function updateRect(): void {
    if (!open) return;
    const step = STEPS[stepIndex];
    if (!step) return;
    const el = document.querySelector(step.selector) as HTMLElement | null;
    if (!el) {
      rect = null;
      return;
    }
    rect = el.getBoundingClientRect();
  }

  $effect(() => {
    if (!open) return;
    // touch step index so this re-runs on advance
    void stepIndex;
    updateRect();
    const id = requestAnimationFrame(() => updateRect());
    const onResize = () => updateRect();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  });

  // Tooltip placement with auto-flip.
  let tipStyle = $state<string>("");
  $effect(() => {
    if (!open || !rect || !tooltipEl) {
      tipStyle = "";
      return;
    }
    const TIP_W = 320;
    const TIP_H = tooltipEl.offsetHeight || 140;
    const GAP = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = rect;
    let placement: StepPlacement = currentStep.prefer;

    function fits(p: StepPlacement): boolean {
      if (p === "right") return r.right + GAP + TIP_W <= vw;
      if (p === "left") return r.left - GAP - TIP_W >= 0;
      if (p === "below") return r.bottom + GAP + TIP_H <= vh;
      if (p === "above") return r.top - GAP - TIP_H >= 0;
      return true;
    }

    if (placement !== "center" && !fits(placement)) {
      const order: StepPlacement[] = ["right", "left", "below", "above"];
      placement = order.find(fits) ?? "center";
    }
    resolvedPlacement = placement;

    let top = 0;
    let left = 0;
    if (placement === "right") {
      left = r.right + GAP;
      top = Math.max(8, Math.min(vh - TIP_H - 8, r.top + r.height / 2 - TIP_H / 2));
    } else if (placement === "left") {
      left = r.left - GAP - TIP_W;
      top = Math.max(8, Math.min(vh - TIP_H - 8, r.top + r.height / 2 - TIP_H / 2));
    } else if (placement === "below") {
      top = r.bottom + GAP;
      left = Math.max(8, Math.min(vw - TIP_W - 8, r.left + r.width / 2 - TIP_W / 2));
    } else if (placement === "above") {
      top = r.top - GAP - TIP_H;
      left = Math.max(8, Math.min(vw - TIP_W - 8, r.left + r.width / 2 - TIP_W / 2));
    } else {
      top = vh / 2 - TIP_H / 2;
      left = vw / 2 - TIP_W / 2;
    }
    tipStyle = `top: ${Math.round(top)}px; left: ${Math.round(left)}px; width: ${TIP_W}px;`;
  });

  async function complete(): Promise<void> {
    // In-memory mirror so other UI in the same session sees the new
    // value immediately. Cross-launch persistence is owned by the
    // parent's onClose handler (settings.json flush — see App.svelte
    // and src/lib/settings.ts).
    patchSettings({ onboardingCompleted: true });
    stepIndex = 0;
    await onClose();
  }

  function next(): void {
    if (stepIndex < total - 1) {
      stepIndex += 1;
    } else {
      void complete();
    }
  }

  function prev(): void {
    if (stepIndex > 0) stepIndex -= 1;
  }

  function skip(): void {
    void complete();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void complete();
    } else if (e.key === "Enter" || e.key === "ArrowRight") {
      e.preventDefault();
      next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      prev();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });

  // Reset stepIndex when re-opened (Replay tour).
  $effect(() => {
    if (open) {
      stepIndex = 0;
    }
  });
</script>

{#if open}
  <div
    class="onboarding-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="onboarding-title"
  >
    <!-- four backdrop quadrants leaving the highlight ring un-dimmed -->
    {#if rect}
      {@const PAD = 6}
      {@const x = Math.max(0, rect.left - PAD)}
      {@const y = Math.max(0, rect.top - PAD)}
      {@const w = rect.width + PAD * 2}
      {@const h = rect.height + PAD * 2}
      <div class="backdrop top" style="height: {y}px;"></div>
      <div
        class="backdrop left"
        style="top: {y}px; height: {h}px; width: {x}px;"
      ></div>
      <div
        class="backdrop right"
        style="top: {y}px; height: {h}px; left: {x + w}px;"
      ></div>
      <div
        class="backdrop bottom"
        style="top: {y + h}px;"
      ></div>
      <div
        class="ring"
        style="top: {y}px; left: {x}px; width: {w}px; height: {h}px;"
        aria-hidden="true"
      ></div>
    {:else}
      <div class="backdrop full"></div>
    {/if}

    <div
      bind:this={tooltipEl}
      class="tooltip"
      data-placement={resolvedPlacement}
      style={tipStyle || "top: 50%; left: 50%; transform: translate(-50%, -50%); width: 320px;"}
    >
      <div class="head">
        <span class="counter mono">{stepIndex + 1} / {total}</span>
        <button
          type="button"
          class="x"
          onclick={skip}
          aria-label="Skip tour"
        >✕</button>
      </div>
      <h3 id="onboarding-title">{currentStep.title}</h3>
      <p>{currentStep.body}</p>
      <div class="buttons">
        <button
          type="button"
          class="btn ghost"
          onclick={skip}
        >Skip</button>
        <div class="spacer"></div>
        <button
          type="button"
          class="btn"
          onclick={prev}
          disabled={stepIndex === 0}
        >Prev</button>
        <button
          type="button"
          class="btn primary"
          onclick={next}
        >{stepIndex === total - 1 ? "Done" : "Next"}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .onboarding-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    pointer-events: none;
  }
  .backdrop {
    position: absolute;
    background: rgba(0, 0, 0, 0.55);
    pointer-events: auto;
  }
  .backdrop.full {
    inset: 0;
  }
  .backdrop.top {
    top: 0;
    left: 0;
    right: 0;
  }
  .backdrop.left {
    left: 0;
  }
  .backdrop.right {
    right: 0;
  }
  .backdrop.bottom {
    left: 0;
    right: 0;
    bottom: 0;
  }
  .ring {
    position: absolute;
    border: 2px solid var(--accent);
    border-radius: 8px;
    box-shadow:
      0 0 0 2px var(--accent-soft),
      0 0 24px 4px var(--accent-line);
    pointer-events: none;
    transition:
      top 180ms ease-out,
      left 180ms ease-out,
      width 180ms ease-out,
      height 180ms ease-out;
  }
  .tooltip {
    position: absolute;
    background: var(--surface);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px 12px;
    box-shadow: var(--shadow-lg);
    pointer-events: auto;
    transition:
      top 180ms ease-out,
      left 180ms ease-out;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .counter {
    font-size: 12px;
    color: var(--fg-3);
    letter-spacing: 0.08em;
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--fg-3);
    cursor: pointer;
    font-size: 16px;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .x:hover {
    background: var(--accent-soft);
    color: var(--fg);
  }
  h3 {
    margin: 0 0 6px;
    font-family: var(--font-display, inherit);
    font-size: 16px;
    font-weight: 600;
    color: var(--fg);
  }
  p {
    margin: 0 0 12px;
    font-size: 14px;
    line-height: 1.45;
    color: var(--fg-2);
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .btn {
    background: var(--elevated);
    color: var(--fg);
    border: 1px solid var(--border);
    padding: 6px 12px;
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    transition:
      background 120ms ease-out,
      border-color 120ms ease-out;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
    font-weight: 600;
  }
  .btn.primary:hover {
    filter: brightness(1.08);
  }
  .btn.ghost {
    background: transparent;
    color: var(--fg-3);
  }
  .btn.ghost:hover {
    color: var(--fg);
  }
</style>
