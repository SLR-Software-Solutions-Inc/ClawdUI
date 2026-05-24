import { writable, derived, get } from "svelte/store";
import { DEFAULT_SETTINGS, type Settings } from "./types";
import { applyTheme } from "./themes";
import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
  remove,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";

/**
 * Cross-platform persistent settings store.
 *
 * Storage location (resolved via Tauri's `appDataDir()`):
 *   - macOS:   ~/Library/Application Support/ca.slrsoft.clawdui/settings.json
 *   - Linux:   ~/.local/share/ca.slrsoft.clawdui/settings.json
 *   - Windows: %APPDATA%\ca.slrsoft.clawdui\settings.json
 *
 * Hydration: `hydrateSettings()` is called once at app boot. UI must wait
 * on `settingsLoaded` before reading settings to avoid flashing default
 * values then re-rendering after the disk read completes.
 *
 * Migration: on first run, if `settings.json` does not exist but the
 * legacy localStorage key (`clawdui.settings.v2`) or the standalone
 * `onboarding.json` (PR #69) does, their values are folded in and the
 * legacy sources are cleared.
 *
 * Writes: every change is debounced (~150ms) to disk. The full JSON
 * is written each time — the file is small.
 */

const SETTINGS_FILENAME = "settings.json";
const LEGACY_LS_KEY = "clawdui.settings.v2";
const LEGACY_ONBOARDING_FILENAME = "onboarding.json";
const WRITE_DEBOUNCE_MS = 150;

export const settings = writable<Settings>({ ...DEFAULT_SETTINGS });

/** True once the on-disk settings have been read (or confirmed absent). UI
 *  should mount-gate on this to avoid a default-value flash. */
const _loaded = writable<boolean>(false);
export const settingsLoaded = derived(_loaded, ($l) => $l);

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let lastTheme: string | null = null;
let hydrated = false;

async function settingsFilePath(): Promise<string> {
  // Tauri's appDataDir already returns the per-app sub-folder
  // (`<appDataDir>/<bundleId>` on macOS/Linux; `%APPDATA%\<bundleId>` on
  // Windows) when the app's identifier is configured in tauri.conf.json.
  const dir = await appDataDir();
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
  return `${dir}${sep}${SETTINGS_FILENAME}`;
}

async function legacyOnboardingPath(): Promise<string> {
  const dir = await appDataDir();
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
  return `${dir}${sep}${LEGACY_ONBOARDING_FILENAME}`;
}

async function ensureAppDataDir(): Promise<void> {
  // Use BaseDirectory.AppData with an empty relative path so the plugin
  // creates the bundle-specific app data folder if missing. recursive:true
  // is a no-op when the folder already exists.
  try {
    await mkdir("", { baseDir: BaseDirectory.AppData, recursive: true });
  } catch {
    /* ignore — folder may already exist or parent may have it */
  }
}

async function readSettingsFile(): Promise<Settings | null> {
  try {
    const path = await settingsFilePath();
    const present = await exists(path);
    if (!present) return null;
    const raw = await readTextFile(path);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return { ...DEFAULT_SETTINGS, ...parsed } as Settings;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[settings] read failed; falling back to defaults:", err);
    return null;
  }
}

async function writeSettingsFile(s: Settings): Promise<void> {
  try {
    await ensureAppDataDir();
    const path = await settingsFilePath();
    await writeTextFile(path, JSON.stringify(s, null, 2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[settings] write failed:", err);
  }
}

/** Read legacy localStorage key, return parsed Settings patch or null. */
function readLegacyLocalStorage(): Partial<Settings> | null {
  try {
    const raw = localStorage.getItem(LEGACY_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Partial<Settings>;
    return null;
  } catch {
    return null;
  }
}

/** Read legacy onboarding.json (PR #69) → onboardingCompleted patch. */
async function readLegacyOnboarding(): Promise<Partial<Settings> | null> {
  try {
    const path = await legacyOnboardingPath();
    if (!(await exists(path))) return null;
    const raw = await readTextFile(path);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.completed === true) {
      return { onboardingCompleted: true };
    }
    return null;
  } catch {
    return null;
  }
}

async function deleteLegacyOnboarding(): Promise<void> {
  try {
    const path = await legacyOnboardingPath();
    if (await exists(path)) await remove(path);
  } catch {
    /* ignore */
  }
}

/**
 * Hydrate the in-memory store from disk. Call once at app boot, await
 * before unblocking UI rendering.
 *
 * Migration order (only when settings.json is absent):
 *   1. legacy localStorage `clawdui.settings.v2`  → fold in, clear key
 *   2. legacy `onboarding.json`                   → fold in, delete file
 *   3. Write a fresh `settings.json` so subsequent boots are direct.
 */
export async function hydrateSettings(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  let initial: Settings;
  const onDisk = await readSettingsFile();

  if (onDisk) {
    initial = onDisk;
  } else {
    // First run on this machine OR fresh state. Try legacy migration.
    const fromLs = readLegacyLocalStorage();
    const fromOnb = await readLegacyOnboarding();
    if (fromLs || fromOnb) {
      initial = { ...DEFAULT_SETTINGS, ...(fromLs ?? {}), ...(fromOnb ?? {}) };
      // Persist immediately so a crash before debounce flush does not lose
      // the migrated values.
      await writeSettingsFile(initial);
      // Clear legacy sources only after the new file is written.
      if (fromLs) {
        try {
          localStorage.removeItem(LEGACY_LS_KEY);
        } catch {
          /* ignore */
        }
      }
      if (fromOnb) {
        await deleteLegacyOnboarding();
      }
      // eslint-disable-next-line no-console
      console.log(
        `[settings] migrated legacy state (localStorage=${!!fromLs}, onboarding=${!!fromOnb})`,
      );
    } else {
      initial = { ...DEFAULT_SETTINGS };
      // Write a baseline file so users see a real file on disk after first
      // launch (helpful for debugging "where are my settings?").
      await writeSettingsFile(initial);
    }
  }

  // systemPromptCustom is now user-editable (see types.ts SettingField). The
  // boot-time reset to DEFAULT_SETTINGS.systemPromptCustom was removed —
  // edits persist across sessions. Users restore the shipped template via
  // the "Restore default" button in Settings → System Prompt.

  // Apply theme immediately so the first paint matches persisted state.
  lastTheme = initial.theme;
  applyTheme(initial.theme);

  settings.set(initial);
  _loaded.set(true);
}

// Subscribe to in-memory changes. Skip writes until hydration completes —
// before that, the store contains DEFAULT_SETTINGS and writing it would
// clobber on-disk state.
settings.subscribe((s) => {
  // Apply theme on every change (cheap; only DOM attr swap when different).
  if (s.theme !== lastTheme) {
    lastTheme = s.theme;
    applyTheme(s.theme);
  }

  if (!get(_loaded)) return;

  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeSettingsFile(get(settings));
  }, WRITE_DEBOUNCE_MS);
});

export function patchSettings(patch: Partial<Settings>): void {
  settings.update((s) => ({ ...s, ...patch }));
}

export function resetSettings(): void {
  settings.set({ ...DEFAULT_SETTINGS });
}

export function getSettings(): Settings {
  return get(settings);
}

/** Force an immediate, un-debounced write. Useful before a known imminent
 *  quit (e.g. completing onboarding the user may immediately Cmd-Q after). */
export async function flushSettings(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  await writeSettingsFile(get(settings));
}

export type SDKQueryOptions = Record<string, unknown>;

export function settingsToSDKOptions(s: Settings): SDKQueryOptions {
  const opts: SDKQueryOptions = {};

  if (s.model) opts.model = s.model;
  if (s.fallbackModel) opts.fallbackModel = s.fallbackModel;
  if (s.maxThinkingTokens != null) opts.maxThinkingTokens = s.maxThinkingTokens;
  if (s.maxTurns != null) opts.maxTurns = s.maxTurns;
  if (s.maxBudgetUsd != null) opts.maxBudgetUsd = s.maxBudgetUsd;
  if (s.effort) opts.effort = s.effort;

  opts.permissionMode = s.permissionMode;
  if (s.allowDangerouslySkipPermissions)
    opts.allowDangerouslySkipPermissions = true;
  if (s.allowedTools.length) opts.allowedTools = s.allowedTools;
  if (s.disallowedTools.length) opts.disallowedTools = s.disallowedTools;

  if (s.cwd) opts.cwd = s.cwd;
  if (s.additionalDirectories.length)
    opts.additionalDirectories = s.additionalDirectories;
  if (s.continueLatest) opts.continue = true;
  else if (s.resume) opts.resume = s.resume;
  if (s.forkSession) opts.forkSession = true;
  if (s.sessionId) opts.sessionId = s.sessionId;
  if (s.sessionTitle) opts.title = s.sessionTitle;
  if (s.sessionPersistence === false) opts.persistSession = false;

  if (s.systemPromptMode === "preset") {
    opts.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      ...(s.appendSystemPrompt ? { append: s.appendSystemPrompt } : {}),
      ...(s.excludeDynamicSystemPromptSections
        ? { excludeDynamicSections: true }
        : {}),
    };
  } else if (s.systemPromptMode === "custom") {
    // Custom mode = locked master orchestrator template + optional user
    // additions via appendSystemPrompt. The base template is readonly so the
    // user sees exactly what is sent.
    const base = DEFAULT_SETTINGS.systemPromptCustom;
    opts.systemPrompt = s.appendSystemPrompt
      ? `${base}\n\n${s.appendSystemPrompt}`
      : base;
  }

  if (s.toolsMode === "preset") {
    opts.tools = { type: "preset", preset: "claude_code" };
  } else if (s.toolsMode === "custom" && s.toolsCustom.length) {
    opts.tools = s.toolsCustom;
  }

  try {
    const mcp = JSON.parse(s.mcpServersJson || "{}");
    if (mcp && typeof mcp === "object" && Object.keys(mcp).length) {
      opts.mcpServers = mcp;
    }
  } catch {
    /* ignore parse */
  }
  if (s.strictMcpConfig) opts.strictMcpConfig = true;

  try {
    const agents = JSON.parse(s.agentsJson || "{}");
    if (agents && typeof agents === "object" && Object.keys(agents).length) {
      opts.agents = agents;
    }
  } catch {
    /* ignore parse */
  }

  try {
    const hooks = JSON.parse(s.hooksJson || "{}");
    if (hooks && typeof hooks === "object" && Object.keys(hooks).length) {
      // SDK expects HookCallbackMatcher[] per event; UI cannot supply callable
      // functions. Pass-through is reserved for future structured hook config.
      opts.hooks = hooks;
    }
  } catch {
    /* ignore parse */
  }
  if (s.includeHookEvents) opts.includeHookEvents = true;

  const disabledPlugins = new Set(s.disabledPluginPaths ?? []);
  const enabledPlugins = (s.pluginDirs ?? []).filter(
    (p) => !disabledPlugins.has(p),
  );
  if (enabledPlugins.length) {
    opts.plugins = enabledPlugins.map((p) => ({ type: "local", path: p }));
  }

  if (s.includePartialMessages) opts.includePartialMessages = true;
  if (s.debug) opts.debug = true;
  // Start from user-configured betas, then auto-inject the 1M context beta
  // for models that require it. Dedupe so manual entries don't double up.
  const betas = new Set<string>(s.betas);
  if (s.model) {
    const id = s.model.includes("/") ? s.model.split("/").pop()! : s.model;
    if (id === "claude-opus-4-7" || id === "claude-sonnet-4-6") {
      betas.add("context-1m-2025-08-07");
    }
  }
  if (betas.size) opts.betas = Array.from(betas);
  if (s.settingSources.length) opts.settingSources = s.settingSources;

  // Merge user env JSON + bareMode env routing.
  let envObj: Record<string, string> = {};
  try {
    const parsed = JSON.parse(s.envJson || "{}");
    if (parsed && typeof parsed === "object") {
      envObj = { ...parsed };
    }
  } catch {
    /* ignore parse */
  }
  if (s.bareMode) {
    // bareMode has no SDK Options field; route via env.
    envObj.CLAUDE_CODE_SIMPLE = "1";
  }
  if (Object.keys(envObj).length) opts.env = envObj;

  if (s.executable) opts.executable = s.executable;

  if (s.jsonSchema && s.jsonSchema.trim()) {
    try {
      const schema = JSON.parse(s.jsonSchema);
      if (schema && typeof schema === "object") {
        opts.outputFormat = { type: "json_schema", schema };
      }
    } catch {
      /* ignore parse — UI surfaces non-blocking error via FieldControl */
    }
  }

  return opts;
}
