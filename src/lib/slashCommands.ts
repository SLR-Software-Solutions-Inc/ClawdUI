/**
 * Built-in slash commands surfaced in the composer popover.
 *
 * Mirrors Claude CLI parity for the slash menu — these entries are *not*
 * wired to a runtime yet. The composer emits a `slashCommand` event with
 * `{ command, args }` so the host can route them later.
 *
 * `argsHint` non-null = command expects arguments; selecting it leaves the
 * caret in the textarea instead of firing immediately.
 */
export type SlashCommand = {
  id: string;
  description: string;
  argsHint?: string;
};

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { id: "clear", description: "Clear conversation history" },
  { id: "compact", description: "Compact the current conversation" },
  { id: "model", description: "Switch the active model", argsHint: "<name>" },
  { id: "resume", description: "Resume a previous session", argsHint: "<id>" },
  { id: "help", description: "Show help" },
  { id: "memory", description: "Edit CLAUDE.md memory files" },
  // Worker T: hooks debugger overlay.
  { id: "hooks", description: "Open hooks debugger" },
  { id: "agents", description: "List or switch agents" },
  { id: "mcp", description: "Manage MCP servers" },
  { id: "permissions", description: "Edit permission rules" },
  { id: "worktree", description: "Switch git worktree", argsHint: "<branch>" },
  // Worker U: real surfaces for previously-stub slash commands.
  { id: "plan", description: "Toggle plan mode (no code until approved)" },
  { id: "init", description: "Initialize CLAUDE.md + project skills" },
  { id: "commit", description: "Stage and commit current changes" },
  { id: "pr", description: "Resume from a pull request" },
  { id: "feedback", description: "Send feedback / file an issue" },
  { id: "undo", description: "Rewind the last user/assistant turn" },
  { id: "fork", description: "Fork the current session into a new branch" },
  // Worker Z: opens the CheckpointDrawer overlay (backing store in checkpoints.ts).
  { id: "checkpoints", description: "List or save session checkpoints" },
];

/** Fuzzy match shared with skills.ts — kept inline so this file has no deps. */
export function scoreSlash(query: string, cmd: SlashCommand): number | null {
  const q = query.toLowerCase();
  if (!q) return 0;
  const id = cmd.id.toLowerCase();
  const desc = cmd.description.toLowerCase();
  if (id.startsWith(q)) return 1000 - id.length;
  if (id.includes(q)) return 800 - id.indexOf(q);
  let i = 0;
  for (const c of id) {
    if (c === q[i]) i++;
    if (i === q.length) return 500 - id.length;
  }
  if (desc.includes(q)) return 100;
  return null;
}

export function filterBuiltins(query: string): SlashCommand[] {
  if (!query) return BUILTIN_COMMANDS;
  const scored = BUILTIN_COMMANDS
    .map((c) => ({ c, score: scoreSlash(query, c) }))
    .filter((x): x is { c: SlashCommand; score: number } => x.score !== null);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.c);
}
