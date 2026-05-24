/**
 * Human-readable one-liner for a Claude Code tool_use block.
 * Returns null if the tool is unknown / inputs missing — caller falls back
 * to the existing collapsible JSON view.
 *
 * Goal: at-a-glance `Read(file.ts:120-200)` instead of a JSON blob.
 */
function shorten(p: unknown, max = 60): string {
  const s = typeof p === "string" ? p : JSON.stringify(p ?? "");
  if (s.length <= max) return s;
  return "…" + s.slice(-max + 1);
}

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Compact a path: keep last 2 segments, prefix … if dropped. */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  if (parts.length <= 3) return p;
  return "…/" + parts.slice(-2).join("/");
}

export function summarizeToolUse(name: string, input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Read": {
      const fp = i.file_path as string | undefined;
      const offset = i.offset as number | undefined;
      const limit = i.limit as number | undefined;
      if (!fp) return null;
      const rng = offset != null
        ? `:${offset}${limit ? `-${offset + limit}` : "+"}`
        : "";
      return `Read(${shortPath(fp)}${rng})`;
    }
    case "Write": {
      const fp = i.file_path as string | undefined;
      const content = i.content as string | undefined;
      if (!fp) return null;
      const sz = content != null ? ` · ${content.length}b` : "";
      return `Write(${shortPath(fp)}${sz})`;
    }
    case "Edit":
    case "MultiEdit": {
      const fp = i.file_path as string | undefined;
      const edits = Array.isArray(i.edits) ? (i.edits as unknown[]).length : null;
      if (!fp) return null;
      const count = edits != null ? ` · ${edits} edit${edits === 1 ? "" : "s"}` : "";
      return `${name}(${shortPath(fp)}${count})`;
    }
    case "Bash": {
      const cmd = i.command as string | undefined;
      if (!cmd) return null;
      return `Bash · ${shorten(cmd, 80)}`;
    }
    case "Glob": {
      const pattern = i.pattern as string | undefined;
      const path = i.path as string | undefined;
      if (!pattern) return null;
      return `Glob(${pattern}${path ? ` in ${shortPath(path)}` : ""})`;
    }
    case "Grep": {
      const pattern = i.pattern as string | undefined;
      const path = i.path as string | undefined;
      const glob = i.glob as string | undefined;
      if (!pattern) return null;
      const where = path ? ` in ${shortPath(path)}` : glob ? ` ·${glob}` : "";
      return `Grep(${shorten(pattern, 40)}${where})`;
    }
    case "WebFetch": {
      const url = i.url as string | undefined;
      if (!url) return null;
      return `WebFetch · ${shorten(url, 70)}`;
    }
    case "WebSearch": {
      const q = i.query as string | undefined;
      if (!q) return null;
      return `WebSearch · "${shorten(q, 60)}"`;
    }
    case "TodoWrite": {
      const todos = Array.isArray(i.todos) ? (i.todos as unknown[]).length : null;
      return `TodoWrite · ${todos ?? 0} item${todos === 1 ? "" : "s"}`;
    }
    case "Task":
    case "Agent": {
      const desc = i.description as string | undefined;
      const subagent = i.subagent_type as string | undefined;
      const lead = subagent ? `Agent[${subagent}]` : name;
      return `${lead} · ${shorten(desc ?? "(no description)", 80)}`;
    }
    case "NotebookEdit": {
      const fp = i.notebook_path as string | undefined;
      const cell = i.cell_number as number | undefined;
      if (!fp) return null;
      return `NotebookEdit(${shortPath(fp)}${cell != null ? ` · cell ${cell}` : ""})`;
    }
    case "ExitPlanMode":
      return "Exit plan mode";
    case "BashOutput":
    case "KillShell": {
      const bid = (i.bash_id ?? i.shell_id) as string | undefined;
      return `${name}(${bid ?? "?"})`;
    }
    default:
      return null;
  }
}
