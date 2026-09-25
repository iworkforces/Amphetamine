import log from "electron-log";

/** GitHub owner/repo pair for electron-updater's GitHub provider. */
export type GitHubRepoIdentity = {
  readonly owner: string;
  readonly repo: string;
};

/**
 * Parse `owner` / `repo` from a GitHub repository URL
 * (e.g. `https://github.com/iworkforces/Amphetamine[.git]`).
 */
export function parseGitHubRepoIdentity(repoUrlStr: string): GitHubRepoIdentity | null {
  try {
    const parsed = new URL(repoUrlStr);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
      return null;
    }
    const parts = parsed.pathname
      .replace(/\.git$/i, "")
      .split("/")
      .filter((p) => p.length > 0);
    const owner = parts[0];
    const repo = parts[1];
    if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
      return null;
    }
    return { owner, repo };
  } catch {
    return null;
  }
}

/**
 * Derive GitHub release URL base from a repository URL string.
 * Returns `null` if the repository URL is missing or not https github.com.
 */
export function deriveReleaseUrlBase(repoUrlStr: string): string | null {
  try {
    const identity = parseGitHubRepoIdentity(repoUrlStr);
    if (identity === null) {
      log.warn("[auto-updater] package.json repository is not an https github.com URL:", repoUrlStr);
      return null;
    }
    const normalized = repoUrlStr.replace(/\.git$/i, "").replace(/\/$/, "");
    return `${normalized}/releases/tag/v`;
  } catch (err) {
    log.warn("[auto-updater] Failed to derive release URL from repository field:", err);
    return null;
  }
}

/**
 * Sanitize an auto-updater error into a fixed category to avoid leaking
 * filesystem paths, proxy URLs, or tokens into the renderer/UI. The raw
 * `err.message` is still logged via electron-log for diagnostics.
 */
/** Sanitized updater error category for UI and status broadcasts. */
export type UpdaterErrorCategory =
  | "network"
  | "feed-missing"
  | "signature"
  | "io"
  | "unknown";

export function categorizeUpdaterError(err: Error): UpdaterErrorCategory {
  const haystack = `${err.name} ${err.message}`.toLowerCase();
  // Missing latest-mac.yml / latest.yml surfaces as HTTP 404 from GitHub.
  if (
    haystack.includes("404") ||
    haystack.includes("status code 404") ||
    haystack.includes("httperror: 404") ||
    haystack.includes("cannot find latest") ||
    haystack.includes("latest-mac.yml") ||
    haystack.includes("latest.yml") ||
    (haystack.includes("enoent") && haystack.includes("latest"))
  ) {
    return "feed-missing";
  }
  if (
    haystack.includes("enotfound") ||
    haystack.includes("econnrefused") ||
    haystack.includes("etimedout") ||
    haystack.includes("enetunreach") ||
    haystack.includes("ehostunreach") ||
    haystack.includes("econnreset") ||
    haystack.includes("eai_again") ||
    haystack.includes("enetdown") ||
    haystack.includes("err_internet_disconnected") ||
    haystack.includes("err_network_changed") ||
    haystack.includes("net::") ||
    haystack.includes("network")
  ) {
    return "network";
  }
  if (
    haystack.includes("signature") ||
    haystack.includes("certificate") ||
    haystack.includes("code-signing")
  ) {
    return "signature";
  }
  if (
    haystack.includes("eacces") ||
    haystack.includes("enospc") ||
    haystack.includes("eio") ||
    haystack.includes("write") ||
    haystack.includes("read")
  ) {
    return "io";
  }
  return "unknown";
}
