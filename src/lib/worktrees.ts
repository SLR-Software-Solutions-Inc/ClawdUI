import { writable, get } from "svelte/store";
import { rpcCall } from "./sidecarRpc";
import { settings } from "./settings";
import { setWorkspace } from "./workspace";

export type Worktree = {
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
};

export type CreateWorktreeResult = {
  path: string;
  branch: string;
  baseBranch: string;
  tool: "wt" | "git-worktree";
};

export type ListWorktreesResult =
  | { kind: "ok"; entries: Worktree[] }
  | { kind: "non_git" }
  | { kind: "error"; error: string };

type WorktreesState = {
  items: Worktree[];
  loading: boolean;
  error: string | null;
  /** True when the workspace folder is not a git repository. */
  nonGit: boolean;
  /** When true, suppress the non-git prompt until cwd changes. */
  dismissed: boolean;
  baseRepoPath: string | null;
};

const initial: WorktreesState = {
  items: [],
  loading: false,
  error: null,
  nonGit: false,
  dismissed: false,
  baseRepoPath: null,
};

export const worktrees = writable<WorktreesState>(initial);

function effectiveCwd(): string | null {
  return get(settings).cwd ?? null;
}

export async function list(): Promise<void> {
  const cwd = effectiveCwd();
  worktrees.update((s) => ({
    ...s,
    loading: true,
    error: null,
    nonGit: false,
    baseRepoPath: cwd,
  }));
  if (!cwd) {
    worktrees.update((s) => ({
      ...s,
      loading: false,
      items: [],
      nonGit: false,
    }));
    return;
  }
  try {
    const res = await rpcCall<ListWorktreesResult | Worktree[]>(
      "list_worktrees",
      { baseRepoPath: cwd },
    );
    // Tagged result from updated sidecar; fall back to legacy array shape
    // if an older sidecar is somehow in play.
    if (Array.isArray(res)) {
      worktrees.update((s) => ({
        ...s,
        loading: false,
        items: res,
        nonGit: false,
      }));
      return;
    }
    if (res && res.kind === "ok") {
      worktrees.update((s) => ({
        ...s,
        loading: false,
        items: Array.isArray(res.entries) ? res.entries : [],
        nonGit: false,
      }));
      return;
    }
    if (res && res.kind === "non_git") {
      worktrees.update((s) => ({
        ...s,
        loading: false,
        items: [],
        nonGit: true,
      }));
      return;
    }
    if (res && res.kind === "error") {
      worktrees.update((s) => ({
        ...s,
        loading: false,
        error: res.error,
        items: [],
        nonGit: false,
      }));
      return;
    }
    // Unknown shape — treat as empty.
    worktrees.update((s) => ({ ...s, loading: false, items: [], nonGit: false }));
  } catch (err) {
    worktrees.update((s) => ({
      ...s,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
      items: [],
      nonGit: false,
    }));
  }
}

export function dismissNonGit(): void {
  worktrees.update((s) => ({ ...s, dismissed: true }));
}

/**
 * Initialize the current workspace folder as a git repo (`git init -b main`)
 * and refresh the worktree list. Only runs after explicit user action.
 */
export async function initRepo(): Promise<void> {
  const cwd = effectiveCwd();
  if (!cwd) throw new Error("no workspace open");
  await rpcCall<{ ok: true }>("git_init", { path: cwd });
  await list();
}

/**
 * Create a worktree from the current cwd as base repo. On success, pivots
 * the workspace (and settings.cwd) to the new path. The caller is
 * responsible for restarting the agent session.
 */
export async function create(
  branch: string,
  baseBranch = "main",
): Promise<CreateWorktreeResult> {
  const cwd = effectiveCwd();
  if (!cwd) throw new Error("no workspace open");
  if (!branch || !branch.trim()) throw new Error("branch name required");
  const result = await rpcCall<CreateWorktreeResult>("create_worktree", {
    baseRepoPath: cwd,
    branch: branch.trim(),
    baseBranch: baseBranch || "main",
  });
  // Pivot workspace + settings.cwd to the new path.
  setWorkspace(result.path);
  // Refresh list (best-effort).
  void list();
  return result;
}

// Auto-refresh list when cwd changes. Reset the non-git dismissal so a new
// folder gets a fresh prompt.
let lastCwd: string | undefined = undefined;
settings.subscribe((s) => {
  if (s.cwd !== lastCwd) {
    lastCwd = s.cwd;
    worktrees.update((st) => ({ ...st, dismissed: false }));
    void list();
  }
});
