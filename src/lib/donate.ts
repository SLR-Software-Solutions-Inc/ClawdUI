/**
 * Honor-system tip jar.
 *
 * The button stays visible until the user self-reports a donation in
 * Settings. There is no server check — a forker can flip the flag or strip
 * the UI; this is intentional. Trust + visibility, not enforcement.
 */
import { invoke } from "@tauri-apps/api/core";

export const DONATE_URL = "https://buymeacoffee.com/slrsoft.ca";
export const ATTRIBUTION = "ClawdUI by SlrSoft";

export async function openDonatePage(): Promise<void> {
  try {
    await invoke("open_external", { url: DONATE_URL });
  } catch {
    // Outside Tauri (web preview) — fall back to window.open.
    window.open(DONATE_URL, "_blank", "noopener,noreferrer");
  }
}
