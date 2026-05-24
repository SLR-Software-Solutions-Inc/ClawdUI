import { writable } from "svelte/store";
import { rpcCall } from "./sidecarRpc";
import { settings, getSettings } from "./settings";
import type { ParsedPrUrl } from "./prFromUrl";

export type PR = {
  number: number;
  title: string;
  branch: string;
  author: string;
  url: string;
  updatedAt: string;
  body?: string;
  /** Head HTTPS clone URL (from PR metadata — never inferred from cwd). */
  cloneUrl?: string;
  /** Head SSH clone URL. */
  sshUrl?: string;
  /** PR base branch (e.g. "main") — used as `wt --base`. */
  baseBranch?: string;
  /** Short repo name (e.g. "ClawdUI"). Used to compute target dir name. */
  repoName?: string;
};

/**
 * Fetch a single PR by parsed URL. Talks to the sidecar's `fetch_pr_by_url`
 * RPC which dispatches to the right provider API. Replaces the old
 * `list_pull_requests` flow that relied on cwd's git remote.
 */
export async function fetchPrByUrl(parsed: ParsedPrUrl): Promise<PR> {
  const s = getSettings();
  return await rpcCall<PR>("fetch_pr_by_url", {
    url: `${parsed.hostBaseUrl}`,
    provider: parsed.provider,
    host: parsed.host,
    hostBaseUrl: parsed.hostBaseUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.prNumber,
    token: s.gitToken || undefined,
  });
}

export type CheckoutResult = {
  ok: true;
  localBranch: string;
  /** "wt" = wt switch path; "git" = plain git fetch+checkout in-place. */
  strategy: "wt" | "git";
  /** Human-readable reason explaining which path was taken and why. */
  reason: string;
  /** The dir the workspace should pivot to (worktree path OR clone root). */
  finalCwd: string;
};

/**
 * Locally check out the PR head branch in the user-picked folder.
 *
 * Behaviour:
 *  - If `<chosenFolder>/<repoName>/` exists, reuse it. Otherwise `git clone
 *    <cloneUrl>` it. Clone URL comes from the PR's head.repo metadata —
 *    never inferred from any existing cwd.
 *  - Detect layout (bare+worktrees vs regular clone vs unknown).
 *  - If bare+worktrees AND `wt` CLI is on PATH → `wt switch --create
 *    pr-<n> --base <baseBranch>`.
 *  - Else (regular clone, or wt missing, or unknown layout) → plain
 *    `git fetch origin pull/<n>/head:pr-<n> && git checkout pr-<n>`
 *    in-place.
 *
 * Auth failures are surfaced as a typed error message the UI can render.
 */
export async function checkoutPrBranch(
  pr: PR,
  parsed: ParsedPrUrl,
  chosenFolder: string,
): Promise<CheckoutResult> {
  if (!chosenFolder) {
    throw new Error("No folder picked — choose a folder to clone/check out into.");
  }
  // Resolve the repo dir name. Prefer the PR's head.repo.name; fall back
  // to the parsed URL repo segment so we always have something.
  const repoName = pr.repoName || parsed.repo;
  return await rpcCall<CheckoutResult>("checkout_pr_branch", {
    chosenFolder,
    provider: parsed.provider,
    prNumber: pr.number,
    branch: pr.branch,
    cloneUrl: pr.cloneUrl,
    sshUrl: pr.sshUrl,
    repoName,
    baseBranch: pr.baseBranch,
  });
}

type PrState = {
  prs: PR[];
  loading: boolean;
  error: string | null;
  cwd: string | null;
};

const initial: PrState = {
  prs: [],
  loading: false,
  error: null,
  cwd: null,
};

export const prList = writable<PrState>(initial);

export async function refresh(): Promise<void> {
  const s = getSettings();
  const cwd = s.cwd ?? null;
  prList.update((st) => ({ ...st, loading: true, error: null, cwd }));
  if (!cwd) {
    prList.update((st) => ({
      ...st,
      loading: false,
      prs: [],
      error: "no working directory configured",
    }));
    return;
  }
  try {
    const list = await rpcCall<PR[]>("list_pull_requests", {
      cwd,
      remoteType: s.gitRemoteType,
      hostBaseUrl: s.gitHostBaseUrl,
      token: s.gitToken || undefined,
    });
    prList.update((st) => ({
      ...st,
      loading: false,
      prs: Array.isArray(list) ? list : [],
    }));
  } catch (err) {
    prList.update((st) => ({
      ...st,
      loading: false,
      prs: [],
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * Fetch a formatted preamble for a PR. Returned `preamble` should be appended
 * to settings.appendSystemPrompt (or used as the first user message) before
 * starting a new session — the legacy --from-pr CLI flag is replaced by this.
 */
export async function formatPrContext(pr: PR): Promise<{
  preamble: string;
  title: string;
}> {
  const s = getSettings();
  const cwd = s.cwd ?? "";
  return await rpcCall<{ preamble: string; title: string }>(
    "format_pr_context",
    {
      cwd,
      remoteType: s.gitRemoteType,
      hostBaseUrl: s.gitHostBaseUrl,
      token: s.gitToken || undefined,
      prNumber: pr.number,
      prTitle: pr.title,
      prBranch: pr.branch,
      prBody: pr.body,
    },
  );
}

// Refresh on cwd change (mirrors sessions.ts behavior, but only kick when the
// picker has been opened at least once — we drive that by checking state.cwd).
let lastCwd: string | undefined = undefined;
settings.subscribe((s) => {
  if (s.cwd !== lastCwd) {
    lastCwd = s.cwd;
    // Reset state but don't auto-fetch — user explicitly opens the picker.
    prList.update((st) => ({ ...st, prs: [], error: null, cwd: s.cwd ?? null }));
  }
});
