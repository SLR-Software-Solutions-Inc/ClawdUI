/**
 * oauth.ts — cross-platform reader for the Claude Code OAuth access token
 * stored by the official Claude CLI.
 *
 * Confirmed paths (Anthropic docs + CLI binary strings + live keychain probe):
 *   macOS   : Keychain generic password, service "Claude Code-credentials",
 *             account = login user. Value is JSON: {claudeAiOauth:{accessToken}}.
 *   Linux   : ~/.claude/.credentials.json (mode 0600). Same JSON shape.
 *   Windows : %USERPROFILE%\.claude\.credentials.json. Same JSON shape.
 *   Override: CLAUDE_CONFIG_DIR replaces ~/.claude (Anthropic-documented).
 *
 * Used by the `connect_remote_control_direct` RPC to call the SDK's
 * `connectRemoteControl({ getAccessToken })` without prompting the user.
 *
 * NEVER log the returned token. NEVER persist it outside the in-memory
 * cache held by index.ts.
 */
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

type ClaudeCreds = { claudeAiOauth?: { accessToken?: string } };

async function macToken(): Promise<string | null> {
  try {
    const user = os.userInfo().username;
    const { stdout } = await exec(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-a",
        user,
        "-w",
      ],
      { timeout: 3000 },
    );
    const raw = stdout.trim();
    if (!raw) return null;
    const parsed: ClaudeCreds = JSON.parse(raw);
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function credsPath(): string {
  // Honor CLAUDE_CONFIG_DIR if set; else ~/.claude/.credentials.json
  const dir = process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), ".claude");
  return path.join(dir, ".credentials.json");
}

async function fileToken(): Promise<string | null> {
  try {
    const txt = await fsp.readFile(credsPath(), "utf8");
    const parsed: ClaudeCreds = JSON.parse(txt);
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function getClaudeAccessToken(): Promise<string | null> {
  if (process.platform === "darwin") {
    // macOS Keychain primary; CLAUDE_CONFIG_DIR override falls back to file path.
    if (process.env.CLAUDE_CONFIG_DIR) {
      const t = await fileToken();
      if (t) return t;
    }
    return macToken();
  }
  // Linux + Windows: flat JSON file at ~/.claude/.credentials.json
  return fileToken();
}
