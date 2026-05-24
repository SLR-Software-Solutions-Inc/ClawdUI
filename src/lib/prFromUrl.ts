/**
 * URL-first PR parsing. Used by PrPicker — user pastes a PR URL, we parse host
 * + owner + repo + PR number directly so we never depend on cwd's git remote
 * (which can be a hostname-aliased SSH URL the sidecar can't resolve back to
 * an API host).
 *
 * Supported shapes:
 *   GitHub:    https://github.com/<owner>/<repo>/pull/<n>
 *   Forgejo /  https://<host>/<owner>/<repo>/pulls/<n>
 *     Gitea
 *   GitLab:    https://<host>/<owner>[/<group>...]/<repo>/-/merge_requests/<n>
 *   Bitbucket: https://bitbucket.org/<owner>/<repo>/pull-requests/<n>
 */

export type Provider = "github" | "forgejo" | "gitlab" | "bitbucket";

export type ParsedPrUrl = {
  provider: Provider;
  host: string;          // bare host, e.g. "your.git.host"
  hostBaseUrl: string;   // "https://your.git.host"
  owner: string;
  repo: string;
  prNumber: number;
};

const PR_SEGMENT: Record<Provider, RegExp> = {
  github: /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$|\?)/,
  forgejo: /^\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:\/|$|\?)/,
  gitlab: /^\/(.+?)\/([^/]+)\/-\/merge_requests\/(\d+)(?:\/|$|\?)/,
  bitbucket: /^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:\/|$|\?)/,
};

export function parsePrUrl(input: string): ParsedPrUrl | null {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.host.toLowerCase();
  const path = url.pathname;

  // Provider detection: host-based first, then path-based as fallback.
  let provider: Provider | null = null;
  if (host === "github.com" || host === "www.github.com") provider = "github";
  else if (host === "bitbucket.org" || host === "www.bitbucket.org") provider = "bitbucket";
  else if (host.includes("gitlab") || /\/-\/merge_requests\//.test(path)) provider = "gitlab";
  else if (/\/pulls\/\d+/.test(path)) provider = "forgejo";

  if (!provider) return null;

  const m = path.match(PR_SEGMENT[provider]);
  if (!m) return null;

  const owner = m[1];
  const repo = m[2].replace(/\.git$/, "");
  const prNumber = parseInt(m[3], 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) return null;

  return {
    provider,
    host,
    hostBaseUrl: `${url.protocol}//${url.host}`,
    owner,
    repo,
    prNumber,
  };
}

/** Convenience: does this string LOOK like a PR url? Used for clipboard sniff. */
export function looksLikePrUrl(s: string): boolean {
  return parsePrUrl(s) !== null;
}
