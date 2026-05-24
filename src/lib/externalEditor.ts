import { safeInvoke } from "./safeInvoke";
import { getSettings } from "./settings";

export type ExternalEditorChoice =
  | "system"
  | "vscode"
  | "zed"
  | "neovim"
  | "custom";

export interface ExternalEditorTarget {
  path: string;
  line?: number;
  col?: number;
}

interface ResolvedCommand {
  exec: string;
  args: string[];
}

/**
 * Token substitution in args. Tokens are matched whole-word inside an arg, e.g.
 * "{path}:{line}:{col}" -> "/abs/file.txt:12:3"
 */
function substituteTokens(
  template: string,
  target: ExternalEditorTarget,
): string {
  const line = target.line ?? 1;
  const col = target.col ?? 1;
  return template
    .replaceAll("{path}", target.path)
    .replaceAll("{line}", String(line))
    .replaceAll("{col}", String(col));
}

function detectPlatform(): "macos" | "windows" | "linux" {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent || "";
  const platform = (navigator as { platform?: string }).platform || "";
  const p = (platform + " " + ua).toLowerCase();
  if (p.includes("mac")) return "macos";
  if (p.includes("win")) return "windows";
  return "linux";
}

function systemOpenCommand(target: ExternalEditorTarget): ResolvedCommand {
  const plat = detectPlatform();
  if (plat === "macos") return { exec: "open", args: [target.path] };
  if (plat === "windows") {
    // `cmd /c start "" <path>` — empty title arg avoids start treating path as title.
    return { exec: "cmd", args: ["/c", "start", "", target.path] };
  }
  return { exec: "xdg-open", args: [target.path] };
}

function profileCommand(
  choice: ExternalEditorChoice,
  target: ExternalEditorTarget,
): ResolvedCommand | null {
  switch (choice) {
    case "vscode":
      return {
        exec: "code",
        args: [
          "--goto",
          substituteTokens("{path}:{line}:{col}", target),
        ],
      };
    case "zed":
      return {
        exec: "zed",
        args: [substituteTokens("{path}:{line}:{col}", target)],
      };
    case "neovim":
      // Best-effort: invoke nvim directly. Caller's terminal must already exist
      // for nvim to be useful; otherwise fall back to system handler.
      return {
        exec: "nvim",
        args: [substituteTokens("+{line}", target), target.path],
      };
    case "system":
      return systemOpenCommand(target);
    default:
      return null;
  }
}

/**
 * Tokenize a custom args string into argv. Handles double-quoted segments so
 * users can express paths with spaces. Whitespace outside quotes splits.
 * Single-token-per-arg substitution then happens after splitting.
 */
function tokenizeArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function resolveCommand(
  target: ExternalEditorTarget,
): ResolvedCommand {
  const s = getSettings();
  const choice = (s.externalEditorChoice ?? "system") as ExternalEditorChoice;

  if (choice === "custom") {
    const exec = (s.externalEditorCustomPath ?? "").trim();
    if (!exec) {
      // Custom selected but no path — fall back to system handler.
      return systemOpenCommand(target);
    }
    const argTemplate =
      (s.externalEditorCustomArgs ?? "").trim() || "{path}";
    const args = tokenizeArgs(argTemplate).map((tok) =>
      substituteTokens(tok, target),
    );
    return { exec, args };
  }

  return profileCommand(choice, target) ?? systemOpenCommand(target);
}

/**
 * Open the given file in the user's configured external editor.
 * Throws on spawn failure.
 */
export async function openFile(
  target: ExternalEditorTarget,
): Promise<void> {
  const { exec, args } = resolveCommand(target);
  // safeInvoke returns null in browser preview; openFile() is user-initiated
  // so the safeInvoke toast already surfaces a "command unavailable" hint.
  await safeInvoke("open_in_external_editor", {
    path: target.path,
    line: target.line ?? null,
    col: target.col ?? null,
    exec,
    args,
  });
}
