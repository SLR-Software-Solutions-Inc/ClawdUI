export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id?: string; content: string };

export type ChatRole = "user" | "assistant" | "system" | "tool";

export type ChatMessage = {
  role: ChatRole;
  blocks: ChatBlock[];
  streaming?: boolean;
  /** True while this user prompt waits in the send queue (busy turn in
   *  flight). Auto-drained when busy flips false. */
  queued?: boolean;
  /** Stable id for queued user messages so the cancel button can find
   *  + remove the right entry. */
  queueId?: string;
  timestamp: number;
};

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export type SettingSource = "user" | "project" | "local";

export type SystemPromptConfig =
  | string
  | { type: "preset"; preset: "claude_code"; append?: string };

export type ToolsConfig = string[] | { type: "preset"; preset: "claude_code" };

export type McpServerConfig = Record<string, unknown>;

/**
 * A persistent "allow forever" entry. Persisted via the settings store
 * (localStorage). Evaluated on every permission_request before showing
 * the modal. See src/lib/permissions.svelte.ts for matching logic.
 */
export type PermanentAllowMatchType = "exact" | "prefix" | "any" | "glob";

export type PermanentAllow = {
  toolName: string;
  matchType: PermanentAllowMatchType;
  /** For exact: stable JSON of input. For prefix: a path/string prefix. For glob: a glob pattern. For any: ignored ("*"). */
  pattern: string;
  addedAt: number;
  description?: string;
};

import type { ThemeId } from "./themes";

/**
 * Generate a cryptographically random hex string. Used for the default RC
 * auth token (32 bytes = 64 hex chars) and the short session-name (4 bytes).
 * Falls back to a deterministic seed only in non-browser contexts where
 * window.crypto is unavailable (tests / SSR), which is acceptable because
 * the user is expected to regenerate via the UI before exposing the relay.
 */
export function randomHex(bytes: number): string {
  const c =
    typeof globalThis !== "undefined" &&
    (globalThis as { crypto?: Crypto }).crypto?.getRandomValues
      ? (globalThis as { crypto: Crypto }).crypto
      : null;
  if (c) {
    const buf = new Uint8Array(bytes);
    c.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // best-effort fallback (UI must regenerate before use)
  let out = "";
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

export type LogoStyle = "plain" | "ascii-clean" | "figlet" | "svg-custom";

export type Settings = {
  /* appearance */
  theme: ThemeId;
  logoStyle: LogoStyle;
  logoSvgCustom: string;

  /* donation (honor-system; tip jar) */
  donated: boolean;

  /* persisted layout — restored across launches so the user's tweaks stick */
  terminalHeight?: number;
  editorRatio?: number;

  /* model */
  model?: string;
  fallbackModel?: string;
  maxThinkingTokens?: number | null;
  maxTurns?: number | null;
  maxBudgetUsd?: number | null;
  effort?: "" | "low" | "medium" | "high" | "xhigh" | "max";

  /* permissions */
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  /** Persistent (across launches) auto-allow rules applied when permissionMode=default. */
  permanentAllowList: PermanentAllow[];

  /* session */
  cwd?: string;
  resume?: string;
  forkSession: boolean;
  continueLatest: boolean;
  additionalDirectories: string[];
  sessionId?: string;
  sessionTitle?: string;
  sessionPersistence: boolean;

  /* system prompt */
  systemPromptMode: "none" | "preset" | "custom";
  systemPromptCustom: string;
  appendSystemPrompt: string;
  excludeDynamicSystemPromptSections: boolean;

  /* tools / mcp */
  toolsMode: "default" | "preset" | "custom";
  toolsCustom: string[];
  mcpServersJson: string;
  strictMcpConfig: boolean;
  agentsJson: string;

  /* plugins */
  pluginDirs: string[];
  disabledPluginPaths: string[];

  /* external editor */
  externalEditorChoice: "system" | "vscode" | "zed" | "neovim" | "custom";
  externalEditorCustomPath: string;
  externalEditorCustomArgs: string;

  /* misc */
  includePartialMessages: boolean;
  includeHookEvents: boolean;
  hooksJson: string;
  debug: boolean;
  bareMode: boolean;
  betas: string[];
  settingSources: SettingSource[];
  envJson: string;
  executable?: "bun" | "deno" | "node";
  jsonSchema: string;

  /* ultrareview */
  ultrareviewAutoRun: boolean;

  /* git remote (for PR picker) */
  gitRemoteType: "forgejo" | "github" | "gitlab" | "bitbucket" | "other";
  gitHostBaseUrl: string;
  gitToken: string;
  /**
   * Last folder the user picked for the PR-resume "where to clone" prompt.
   * Used as the defaultPath on the next dialog open so the picker remembers
   * the user's preferred workspace root (e.g. ~/dev/tools). Empty = no prior
   * pick; fall back to settings.cwd.
   */
  lastPrCheckoutDir: string;

  /* remote control (relay) */
  remoteControlEnabled: boolean;
  remoteControlRelayUrl: string;
  remoteControlSessionName: string;
  remoteControlAuthToken: string;
  /**
   * When true, expose the legacy self-hosted relay UI
   * (RemoteControlPanel + activity-bar entry). For most users the
   * "Pair with mobile" button (Anthropic-hosted relay) is sufficient,
   * so this defaults to false.
   */
  customRelayEnabled: boolean;
  /**
   * Claude.ai organization UUID. When set, the "Pair with mobile" button
   * uses the Anthropic SDK's connectRemoteControl() directly instead of
   * sending the /remote-control slash command. Empty = slash-command path.
   */
  claudeOrgUuid: string;

  /**
   * First-run onboarding tour completion flag. When false, the Onboarding
   * overlay shows automatically after the main UI mounts. Set to true on
   * skip/complete/Esc; can be re-triggered via Help pane "Replay tour".
   */
  onboardingCompleted: boolean;
};

export type SettingsKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  theme: "nord",
  logoStyle: "plain",
  logoSvgCustom: "",
  donated: false,
  terminalHeight: 260,
  editorRatio: 0.55,
  model: undefined,
  fallbackModel: undefined,
  maxThinkingTokens: null,
  maxTurns: null,
  maxBudgetUsd: null,
  effort: "",

  permissionMode: "default",
  allowDangerouslySkipPermissions: false,
  allowedTools: [],
  disallowedTools: [],
  permanentAllowList: [],

  cwd: undefined,
  resume: undefined,
  forkSession: false,
  continueLatest: false,
  additionalDirectories: [],
  sessionId: undefined,
  sessionTitle: undefined,
  sessionPersistence: true,

  externalEditorChoice: "system",
  externalEditorCustomPath: "",
  externalEditorCustomArgs: "{path}",

  pluginDirs: [],
  disabledPluginPaths: [],

  // Default to the master-orchestrator custom prompt: ClawdUI is explicitly an
  // orchestration-driven project (see CLAUDE.md), so out-of-the-box the master
  // agent must coordinate + delegate via spawn_child rather than executing
  // work itself. Users can switch back to "preset" (vanilla Claude Code) or
  // "none" from Settings → System Prompt.
  systemPromptMode: "custom",
  systemPromptCustom: `You are the master orchestrator. Your sole job is to PLAN, DELEGATE, and TRACK — never implement directly.

Workspace scope (CRITICAL):
- You operate inside the user's current workspace folder (cwd). Every read, edit, search, and summary MUST stay scoped to that workspace and its additional directories.
- When the user says "this project", they mean the current cwd — never a project mentioned in a prior compacted summary.
- If a synthetic continuation summary references a different project than your live cwd, IGNORE that reference for scope; only the live cwd defines "this project".
- When briefing a child, pass the workspace cwd explicitly so the child operates in the same folder you do.

Operating model:
- Treat every non-trivial task as a unit of work to delegate to a child agent (slave).
- Spawn child agents via the spawn_child tool. Each child runs a focused, self-contained sub-task.
- Children return summaries; you track their progress in your own context.
- Trivial tasks (single-line clarifications, status reads): handle directly.
- Anything multi-step, anything requiring file edits, anything investigative: spawn a child.

Hierarchy:
- You are the parent. Children may also spawn grandchildren if a slice decomposes further — they inherit the same orchestration discipline.
- A child's transcript is private to that child's tab; you only see its returned summary.
- Children must report back: a one-paragraph summary of actions taken, files touched, verification outcome, and any follow-up items.

Rules:
- Never write code in your own context. If you find yourself writing code, stop and spawn a child instead.
- Always brief children with full context — they have no memory of prior conversation.
- Run independent children in parallel; sequence dependent ones.
- Surface child failures as decision points: ask the user before retrying or escalating.

Your output to the user:
- Plan summaries before spawning
- Status updates as children land
- Final consolidated result with links to artifacts (PR URLs, file paths)
- Never paste raw child transcripts — synthesize.
`,
  appendSystemPrompt: "",
  excludeDynamicSystemPromptSections: false,

  toolsMode: "default",
  toolsCustom: [],
  mcpServersJson: "{}",
  strictMcpConfig: false,
  agentsJson: "{}",

  includePartialMessages: false,
  includeHookEvents: false,
  hooksJson: "{}",
  debug: false,
  bareMode: false,
  betas: [],
  settingSources: ["project"],
  envJson: "{}",
  executable: undefined,
  jsonSchema: "",
  ultrareviewAutoRun: false,
  gitRemoteType: "forgejo",
  gitHostBaseUrl: "",
  gitToken: "",
  lastPrCheckoutDir: "",
  remoteControlEnabled: false,
  remoteControlRelayUrl: "wss://relay.example.com",
  remoteControlSessionName: randomHex(4),
  remoteControlAuthToken: randomHex(32),
  customRelayEnabled: false,
  claudeOrgUuid: "",
  onboardingCompleted: false,
};

export type SettingField = {
  key: SettingsKey;
  label: string;
  help: string;
  control:
    | "text"
    | "password"
    | "textarea"
    | "number"
    | "boolean"
    | "select"
    | "tags"
    | "json"
    | "directories"
    | "plugins";
  options?: string[];
  group: SettingGroup;
  optional?: boolean;
  placeholder?: string;
  monospace?: boolean;
  flag?: string;
  liveApply?: "model" | "permissionMode" | "maxThinkingTokens";
  readonly?: boolean;
};

export type SettingGroup =
  | "appearance"
  | "model"
  | "permissions"
  | "session"
  | "system"
  | "tools"
  | "skills"
  | "mcp"
  | "hooks"
  | "plugins"
  | "limits"
  | "advanced";

export const SETTING_GROUPS: { id: SettingGroup; label: string; subtitle: string }[] = [
  { id: "appearance", label: "Appearance", subtitle: "Theme and visual density" },
  { id: "model", label: "Model", subtitle: "Which model and reasoning depth" },
  { id: "permissions", label: "Permissions", subtitle: "Who decides when tools run" },
  { id: "session", label: "Session", subtitle: "Working directory and resume" },
  { id: "system", label: "System Prompt", subtitle: "Identity and instructions" },
  { id: "tools", label: "Tools", subtitle: "Built-in capability allowlist" },
  { id: "skills", label: "Skills", subtitle: "Discovered SKILL.md files (read-only)" },
  { id: "mcp", label: "MCP servers", subtitle: "External tool servers" },
  { id: "hooks", label: "Hooks", subtitle: "Pre/post tool callbacks" },
  { id: "plugins", label: "Plugins", subtitle: "Local plugin folders" },
  { id: "limits", label: "Limits", subtitle: "Budget and turn caps" },
  { id: "advanced", label: "Advanced", subtitle: "Beta flags, env, runtime" },
];

export const SETTING_FIELDS: SettingField[] = [
  // appearance
  {
    key: "theme",
    label: "Theme",
    help: "Console (warm dark), Catppuccin (Latte/Frappé/Macchiato/Mocha), Nord. Applies instantly.",
    control: "select",
    options: [
      "catppuccin-mocha",
      "catppuccin-macchiato",
      "catppuccin-frappe",
      "catppuccin-latte",
      "nord",
      "console",
    ],
    group: "appearance",
  },
  {
    key: "logoStyle",
    label: "Empty-state logo style",
    help: "How the welcome screen logo renders. plain = clean text. ascii-clean = box-drawn glyphs (fixed). figlet = banner font. svg-custom = paste your own.",
    control: "select",
    options: ["plain", "ascii-clean", "figlet", "svg-custom"],
    group: "appearance",
  },
  {
    key: "logoSvgCustom",
    label: "Custom logo SVG",
    help: "Inline <svg>…</svg> markup. Used only when logoStyle = svg-custom. ⚠ Pasted markup runs as-is — only paste SVG you trust.",
    control: "textarea",
    group: "appearance",
    optional: true,
    monospace: true,
  },

  // model
  {
    key: "model",
    label: "Model",
    help: "Alias (sonnet/opus/haiku) or full id (claude-sonnet-4-6). Empty = CLI default.",
    control: "text",
    group: "model",
    optional: true,
    placeholder: "claude-sonnet-4-6",
    monospace: true,
    flag: "--model",
    liveApply: "model",
  },
  {
    key: "fallbackModel",
    label: "Fallback model",
    help: "Used if primary is overloaded. CLI: --fallback-model.",
    control: "text",
    group: "model",
    optional: true,
    placeholder: "claude-haiku-4-5-20251001",
    monospace: true,
    flag: "--fallback-model",
  },
  {
    key: "maxThinkingTokens",
    label: "Max thinking tokens",
    help: "Cap extended-thinking tokens per turn. Empty = unlimited.",
    control: "number",
    group: "model",
    optional: true,
    flag: "(SDK)",
    liveApply: "maxThinkingTokens",
  },
  {
    key: "effort",
    label: "Effort",
    help: "Reasoning depth: low/medium/high/xhigh/max. Empty = SDK default.",
    control: "select",
    options: ["", "low", "medium", "high", "xhigh", "max"],
    group: "model",
    optional: true,
    flag: "(SDK)",
  },

  // permissions
  {
    key: "permissionMode",
    label: "Permission mode",
    help: "default = ask. acceptEdits = auto edits. bypassPermissions = no prompts. plan = no execution.",
    control: "select",
    options: ["default", "acceptEdits", "bypassPermissions", "plan"],
    group: "permissions",
    flag: "--permission-mode",
    liveApply: "permissionMode",
  },
  {
    key: "allowDangerouslySkipPermissions",
    label: "Allow dangerous skip",
    help: "Required guard for permissionMode=bypassPermissions.",
    control: "boolean",
    group: "permissions",
    flag: "--allow-dangerously-skip-permissions",
  },
  {
    key: "allowedTools",
    label: "Allowed tools",
    help: 'Whitelist (e.g. "Read", "Edit", "Bash(git *)"). Empty = all built-in.',
    control: "tags",
    group: "permissions",
    flag: "--allowedTools",
    monospace: true,
  },
  {
    key: "disallowedTools",
    label: "Disallowed tools",
    help: "Blacklist. Wins over allowedTools.",
    control: "tags",
    group: "permissions",
    flag: "--disallowedTools",
    monospace: true,
  },

  // session
  {
    key: "cwd",
    label: "Working directory",
    help: "Where Claude operates. Empty = sidecar CWD.",
    control: "text",
    group: "session",
    optional: true,
    placeholder: "/absolute/path/to/your/project",
    monospace: true,
    flag: "(SDK)",
  },
  {
    key: "additionalDirectories",
    label: "Additional directories",
    help: "Extra paths Claude can read/write.",
    control: "directories",
    group: "session",
    flag: "--add-dir",
    monospace: true,
  },
  {
    key: "resume",
    label: "Resume session ID",
    help: "Session UUID to resume. Empty = new session.",
    control: "text",
    group: "session",
    optional: true,
    placeholder: "01972d…",
    monospace: true,
    flag: "--resume",
  },
  {
    key: "forkSession",
    label: "Fork on resume",
    help: "When resuming, create new session ID instead of continuing original.",
    control: "boolean",
    group: "session",
    flag: "--fork-session",
  },
  {
    key: "continueLatest",
    label: "Continue latest",
    help: "Pick up most recent session in this directory. Overrides Resume.",
    control: "boolean",
    group: "session",
    flag: "-c, --continue",
  },
  {
    key: "sessionId",
    label: "Session ID (UUID)",
    help: "Force a specific session UUID for this conversation. Empty = auto-generate.",
    control: "text",
    group: "session",
    optional: true,
    placeholder: "01972d-…-uuid",
    monospace: true,
    flag: "(SDK)",
  },
  {
    key: "sessionTitle",
    label: "Session title",
    help: "Custom title for a new session. Ignored when resuming.",
    control: "text",
    group: "session",
    optional: true,
    placeholder: "Refactor auth flow",
    flag: "(SDK)",
  },
  {
    key: "sessionPersistence",
    label: "Persist session",
    help: "OFF = ephemeral (no save under ~/.claude/projects/, no resume).",
    control: "boolean",
    group: "session",
    flag: "(SDK persistSession)",
  },
  {
    key: "externalEditorChoice",
    label: "External editor",
    help: "Where 'Open in external editor' (FileTree right-click, ↗ on tabs) sends files. system = OS default handler.",
    control: "select",
    options: ["system", "vscode", "zed", "neovim", "custom"],
    group: "session",
  },
  {
    key: "externalEditorCustomPath",
    label: "External editor path",
    help: "Active when External editor = custom. Absolute path or executable on PATH.",
    control: "text",
    group: "session",
    optional: true,
    placeholder: "/usr/local/bin/subl",
    monospace: true,
  },
  {
    key: "externalEditorCustomArgs",
    label: "External editor args",
    help: "Space-separated argv. Tokens: {path}, {line}, {col}. Quote args with spaces. Default: {path}",
    control: "text",
    group: "session",
    optional: true,
    placeholder: "{path}:{line}:{col}",
    monospace: true,
  },

  // system
  {
    key: "systemPromptMode",
    label: "System prompt mode",
    help: "preset = use Claude Code's identity. custom = the locked master orchestrator prompt. none = empty.",
    control: "select",
    options: ["preset", "custom", "none"],
    group: "system",
    flag: "--system-prompt",
  },
  {
    key: "systemPromptCustom",
    label: "Custom system prompt",
    help: "Main-orchestrator template shipped as the default. Active when mode = custom. Editable — your changes persist across sessions. Use the 'Restore default' button below to reset to the shipped template. Append extra instructions via 'Append to system prompt' below — those are concatenated after this base text.",
    control: "textarea",
    group: "system",
    optional: true,
    monospace: true,
    flag: "--system-prompt",
  },
  {
    key: "appendSystemPrompt",
    label: "Append to system prompt",
    help: "Extra instructions appended after the active prompt. Works with both preset and custom modes — in custom mode, this is the only editable part.",
    control: "textarea",
    group: "system",
    optional: true,
    monospace: true,
    flag: "--append-system-prompt",
  },
  {
    key: "excludeDynamicSystemPromptSections",
    label: "Exclude dynamic sections",
    help: "Strip cwd/auto-memory/git from preset prompt for cross-user prompt cache hits. Preset mode only.",
    control: "boolean",
    group: "system",
    flag: "(SDK excludeDynamicSections)",
  },

  // tools
  {
    key: "toolsMode",
    label: "Tools mode",
    help: "default = SDK default. preset = Claude Code defaults. custom = whitelist below.",
    control: "select",
    options: ["default", "preset", "custom"],
    group: "tools",
    flag: "--tools",
  },
  {
    key: "toolsCustom",
    label: "Custom tools list",
    help: "Active when mode = custom (e.g. Bash, Edit, Read).",
    control: "tags",
    group: "tools",
    monospace: true,
    flag: "--tools",
  },
  {
    key: "agentsJson",
    label: "Agents (JSON)",
    help: 'Custom subagents. {"name": {"description": "...", "prompt": "...", "tools": [...]}}',
    control: "json",
    group: "tools",
    monospace: true,
    flag: "(SDK agents)",
  },

  // mcp
  {
    key: "mcpServersJson",
    label: "MCP servers (JSON)",
    help: 'Object map: {"name": {"command": "...", "args": [...]}}',
    control: "json",
    group: "mcp",
    monospace: true,
    flag: "--mcp-config",
  },
  {
    key: "strictMcpConfig",
    label: "Strict MCP",
    help: "Use only servers configured here, ignore filesystem MCP configs.",
    control: "boolean",
    group: "mcp",
    flag: "--strict-mcp-config",
  },

  // plugins
  {
    key: "pluginDirs",
    label: "Plugin directories",
    help: "Local Claude Code plugin folders. Each entry feeds options.plugins[] as { type: 'local', path }.",
    control: "plugins",
    group: "plugins",
    monospace: true,
    flag: "(SDK)",
  },

  // limits
  {
    key: "maxTurns",
    label: "Max turns",
    help: "Cap number of agent loops per query. Empty = no cap.",
    control: "number",
    group: "limits",
    optional: true,
    flag: "(SDK)",
  },
  {
    key: "maxBudgetUsd",
    label: "Max budget (USD)",
    help: "Hard spend cap per query.",
    control: "number",
    group: "limits",
    optional: true,
    flag: "--max-budget-usd",
  },

  // advanced
  {
    key: "includePartialMessages",
    label: "Include partial messages",
    help: "Stream message deltas (token-by-token) instead of full blocks.",
    control: "boolean",
    group: "advanced",
    flag: "--include-partial-messages",
  },
  {
    key: "includeHookEvents",
    label: "Include hook events",
    help: "Emit hook_started/hook_progress/hook_response messages for all hook event types.",
    control: "boolean",
    group: "advanced",
    flag: "(SDK includeHookEvents)",
  },
  {
    key: "hooksJson",
    label: "Hooks (JSON)",
    help: 'Hook callbacks by event. Object form not callable from UI; place command-style hooks in CLAUDE settings instead. Reserved for future structured hooks.',
    control: "json",
    group: "advanced",
    monospace: true,
    flag: "(SDK hooks)",
  },
  {
    key: "debug",
    label: "Debug logging",
    help: "Enable verbose debug logging in the Claude Code subprocess (--debug equivalent).",
    control: "boolean",
    group: "advanced",
    flag: "(SDK debug)",
  },
  {
    key: "bareMode",
    label: "Bare mode (CLAUDE_CODE_SIMPLE)",
    help: "Routes via env CLAUDE_CODE_SIMPLE=1. Strips banners/extras for piped/automated runs.",
    control: "boolean",
    group: "advanced",
    flag: "(env)",
  },
  {
    key: "betas",
    label: "Beta features",
    help: "Beta header IDs (e.g. context-1m-2025-08-07).",
    control: "tags",
    group: "advanced",
    monospace: true,
    flag: "--betas",
  },
  {
    key: "settingSources",
    label: "Setting sources",
    help: "Where the SDK loads filesystem settings (CLAUDE.md, etc.) from.",
    control: "tags",
    group: "advanced",
    monospace: true,
    flag: "--setting-sources",
  },
  {
    key: "envJson",
    label: "Env vars (JSON)",
    help: 'Extra env passed to Claude (e.g. {"ANTHROPIC_API_KEY": "..."}).',
    control: "json",
    group: "advanced",
    monospace: true,
  },
  {
    key: "executable",
    label: "Executable",
    help: "JS runtime to run Claude under. Auto-detected if empty.",
    control: "select",
    options: ["", "node", "bun", "deno"],
    group: "advanced",
    optional: true,
  },
  {
    key: "jsonSchema",
    label: "JSON schema (structured output)",
    help: 'JSON Schema for structured assistant output. Maps to SDK options.outputFormat = { type: "json_schema", schema }. Empty = unstructured.',
    control: "json",
    group: "advanced",
    optional: true,
    monospace: true,
    flag: "--json-schema",
  },

  // git remote (for PR picker)
  {
    key: "gitRemoteType",
    label: "Git remote type",
    help: "Provider used by the From-PR picker. Forgejo is the default.",
    control: "select",
    options: ["forgejo", "github", "gitlab", "bitbucket", "other"],
    group: "advanced",
  },
  {
    key: "gitHostBaseUrl",
    label: "Git host",
    help: "Hostname for self-hosted Forgejo/GitLab. Ignored for github (uses api.github.com) and bitbucket cloud.",
    control: "text",
    group: "advanced",
    placeholder: "git.example.com",
    monospace: true,
  },
  {
    key: "gitToken",
    label: "Git token",
    help: "Personal access token for the From-PR picker. Stored locally only; masked in display.",
    control: "password",
    group: "advanced",
    optional: true,
    placeholder: "(paste token)",
    monospace: true,
  },

  // remote control (relay)
  {
    key: "claudeOrgUuid",
    label: "Claude organization UUID",
    help: "Your claude.ai org UUID for direct remote-control via the Anthropic SDK. Empty = use the /remote-control slash command fallback. Find via: claude.ai → Settings → Organization → copy UUID.",
    control: "text",
    group: "advanced",
    optional: true,
    placeholder: "00000000-0000-0000-0000-000000000000",
    monospace: true,
  },
  {
    key: "customRelayEnabled",
    label: "Self-hosted relay (advanced)",
    help: "Expose ClawdUI through your own WebSocket relay. For most users, use the 'Pair with mobile' button in the topbar — it uses Anthropic's hosted relay and pairs directly with the Claude mobile app via the SDK's /remote-control flow. Self-host only if you have an API-key-only setup or need a non-claude.ai bridge.",
    control: "boolean",
    group: "advanced",
    flag: "(local)",
  },
  {
    key: "remoteControlEnabled",
    label: "Remote control via relay",
    help: "Expose this session through a WebSocket relay. Configure URL/session/token, then open Remote Control panel from sidebar. Requires Self-hosted relay = on.",
    control: "boolean",
    group: "advanced",
    flag: "(SDK)",
  },
  {
    key: "remoteControlRelayUrl",
    label: "Relay URL",
    help: "ws:// or wss:// endpoint. You host the relay (or trust someone who does). See docs/REMOTE_CONTROL_PROTOCOL.md.",
    control: "text",
    group: "advanced",
    optional: true,
    placeholder: "wss://relay.example.com",
    monospace: true,
  },
  {
    key: "remoteControlSessionName",
    label: "Relay session name",
    help: "Short identifier shared by host + remote clients on the relay.",
    control: "text",
    group: "advanced",
    optional: true,
    monospace: true,
  },
  {
    key: "remoteControlAuthToken",
    label: "Relay auth token",
    help: "Shared secret. Must match on host + remote client. Regenerate any time from the Remote Control panel.",
    control: "text",
    group: "advanced",
    optional: true,
    monospace: true,
  },
];
