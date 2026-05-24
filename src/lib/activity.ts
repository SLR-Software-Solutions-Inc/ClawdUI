// Shared types for ActivityBar and consumers.
// Kept in a .ts module so named imports work (Svelte components only
// export their default component; types declared in <script> aren't
// re-exported as module members).

import type { ComponentType, SvelteComponent } from "svelte";

/**
 * Optional small status dot rendered as an overlay on the activity icon.
 *   - "ok"      → green (signed in / healthy)
 *   - "bad"     → red   (signed out / error)
 *   - "warn"    → amber (degraded)
 *   - "neutral" → grey  (indeterminate / pending)
 */
export type ActivityStatus = "ok" | "bad" | "warn" | "neutral";

export type ActivityItem = {
  id: string;
  label: string;
  // SVG icon component from $lib/icons (Lucide-derived). Rendered via
  // <svelte:component this={item.icon} size={20} /> in ActivityBar.
  icon: ComponentType<SvelteComponent>;
  position?: "top" | "bottom";
  status?: ActivityStatus;
  /** Optional accessible label suffix appended to aria-label, e.g. "signed in". */
  statusLabel?: string;
  /** Display string for the keyboard shortcut, shown in the hover tooltip
   *  ("⌘B", "⌘`"). Cosmetic only — the actual binding lives elsewhere. */
  shortcut?: string;
  /** When true, render a thin divider ABOVE this item so the visible stack
   *  can group related entries inside the same top/bottom band without a
   *  separate group concept. */
  groupBreak?: boolean;
};
