// Centralised system-health state surfaced by the top banner + statusbar
// pills. Owns three flags:
//   - tauriAvailable: is the @tauri-apps/api/core IPC reachable
//   - sidecarState:   replicates App.svelte's local sidecarState
//   - cliFound:       does the `claude` binary exist on $PATH (resolved by
//                     cli.ts via refreshClaudePath)
//
// Components / helpers update slices via the setters below. UI consumers
// subscribe to the derived `bannerNotice` and `pills` for rendering.

import { writable, derived, get, type Readable } from "svelte/store";

export type SidecarState = "idle" | "connecting" | "connected" | "error";

export type SystemStatus = {
  tauriAvailable: boolean;
  sidecarState: SidecarState;
  cliFound: boolean | null; // null = unknown / not probed
  dismissed: {
    browserPreview: boolean;
    sidecarOffline: boolean;
    cliMissing: boolean;
  };
};

const initial: SystemStatus = {
  // Inferred once at module load. Tauri injects `__TAURI_INTERNALS__` on
  // the window before any user code runs; absence means we're in a plain
  // browser preview (`npm run dev` without `tauri dev`).
  tauriAvailable:
    typeof window !== "undefined" &&
    // both keys exist on real Tauri builds; checking either is enough.
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window)),
  sidecarState: "idle",
  cliFound: null,
  dismissed: {
    browserPreview: false,
    sidecarOffline: false,
    cliMissing: false,
  },
};

export const systemStatus = writable<SystemStatus>(initial);

export function isTauri(): boolean {
  return get(systemStatus).tauriAvailable;
}

export function setSidecarState(state: SidecarState): void {
  systemStatus.update((s) =>
    s.sidecarState === state ? s : { ...s, sidecarState: state },
  );
}

export function setCliFound(found: boolean): void {
  systemStatus.update((s) =>
    s.cliFound === found ? s : { ...s, cliFound: found },
  );
}

export function dismissNotice(
  key: keyof SystemStatus["dismissed"],
): void {
  systemStatus.update((s) => ({
    ...s,
    dismissed: { ...s.dismissed, [key]: true },
  }));
}

export type BannerNotice = {
  key: keyof SystemStatus["dismissed"];
  kind: "warn" | "error" | "info";
  message: string;
  action?: { label: string; href?: string; cmd?: string };
};

/**
 * Highest-priority notice that should appear in the top banner, or null
 * when everything is healthy / the user has dismissed the active issue.
 * Priority order: browser preview > sidecar offline > CLI missing.
 */
export const bannerNotice: Readable<BannerNotice | null> = derived(
  systemStatus,
  ($s) => {
    if (!$s.tauriAvailable && !$s.dismissed.browserPreview) {
      return {
        key: "browserPreview" as const,
        kind: "info" as const,
        message:
          "Browser preview mode — native features (file picker, sidecar, native menus) are disabled.",
        action: { label: "Open in app", cmd: "open-in-app" },
      };
    }
    if (
      $s.tauriAvailable &&
      ($s.sidecarState === "error" || $s.sidecarState === "idle") &&
      !$s.dismissed.sidecarOffline
    ) {
      return {
        key: "sidecarOffline" as const,
        kind: "error" as const,
        message:
          $s.sidecarState === "error"
            ? "Sidecar offline — chat unavailable."
            : "Sidecar not yet connected — chat unavailable.",
        action: { label: "Diagnose", cmd: "open-doctor" },
      };
    }
    if (
      $s.tauriAvailable &&
      $s.cliFound === false &&
      !$s.dismissed.cliMissing
    ) {
      return {
        key: "cliMissing" as const,
        kind: "warn" as const,
        message: "Claude CLI not detected on PATH.",
        action: {
          label: "Install",
          href: "https://docs.anthropic.com/claude/docs/claude-code",
        },
      };
    }
    return null;
  },
);

export type PillState = "ok" | "warn" | "error" | "idle";

export type PillSummary = {
  tauri: { state: PillState; label: string };
  sidecar: { state: PillState; label: string };
  cli: { state: PillState; label: string };
};

export const pills: Readable<PillSummary> = derived(systemStatus, ($s) => {
  const tauri: PillSummary["tauri"] = $s.tauriAvailable
    ? { state: "ok", label: "tauri" }
    : { state: "warn", label: "browser" };
  let sidecarState: PillState = "idle";
  if ($s.sidecarState === "connected") sidecarState = "ok";
  else if ($s.sidecarState === "error") sidecarState = "error";
  else if ($s.sidecarState === "connecting") sidecarState = "warn";
  const sidecar = { state: sidecarState, label: $s.sidecarState };
  let cliState: PillState = "idle";
  let cliLabel = "cli ?";
  if ($s.cliFound === true) {
    cliState = "ok";
    cliLabel = "cli";
  } else if ($s.cliFound === false) {
    cliState = "error";
    cliLabel = "cli missing";
  }
  return { tauri, sidecar, cli: { state: cliState, label: cliLabel } };
});
