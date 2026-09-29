/**
 * Hybrid auto-updater policy (infrastructure).
 * electron-updater event handling, background checks, user-initiated download/install
 * with browser fallback. Presentation hooks are injected — no main imports.
 */

import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import { app } from "electron/main";
import { shell } from "electron/common";
import log from "electron-log";
import type { AutoUpdaterStatus, UpdateMeta } from "../../shared/types.js";
import type { AppPushEvent } from "../../application/ports/main-to-renderer-notifier.port.js";
import type { UtilityDialogOptions, UtilityDialogResult } from "../../shared/utility-dialog.js";
import {
  categorizeUpdaterError,
  deriveReleaseUrlBase,
  parseGitHubRepoIdentity,
} from "./auto-updater-utils.js";

/** Timing constants (keep in sync with main/constants.ts updater values). */
const INITIAL_UPDATE_CHECK_DELAY_MS = 3000;
const PERIODIC_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAX_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let checkIntervalId: ReturnType<typeof setInterval> | null = null;
let initialCheckTimerId: ReturnType<typeof setTimeout> | null = null;

/** True while a tray/IPC-initiated check is in progress (download/install path). */
let userInitiatedCheck = false;

/**
 * True until a user-initiated check delivers feedback (dialog, download start, or browser).
 * Survives joining an in-flight background check whose events already fired without user intent.
 */
let pendingUserFeedback = false;

/** True after we have notified the user that a download is underway (once per attempt). */
let downloadNotifySent = false;

/**
 * Shared in-flight `autoUpdater.checkForUpdates()` promise.
 * Background, tray, and IPC callers join this single request.
 */
let inFlightCheck: Promise<Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>> | null = null;

/** Last version seen as available (for browser fallback if download/install fails). */
let lastAvailableVersion: string | null = null;

let consecutiveFailures = 0;

/** Strict semver (optionally pre-release / build metadata) for release URL safety. */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/;

/**
 * Construction-time deps for hybrid updater policy.
 * Wired by createElectronUpdaterPort — no main-process imports.
 */
export interface HybridAutoUpdaterDeps {
  /** Semantic push into MainToRendererNotifierPort (mapped to IPC in adapter). */
  publish: (event: AppPushEvent) => void;
  /** Repository URL from package metadata (for browser fallback links). */
  getRepositoryUrl: () => string;
  /**
   * Present an aurora utility dialog (Check for Updates, install ready, etc.).
   * Main wires this to WindowGraph `presentUtilityDialog` (foreground + icon aurora).
   */
  showUserDialog: (options: UtilityDialogOptions) => Promise<UtilityDialogResult>;
  /** Optional OS notification for user-initiated check/download status. */
  notifyUser?: (message: { title: string; body: string }) => void;
}

let deps: HybridAutoUpdaterDeps | null = null;
let cachedReleaseUrlBase: string | null | undefined = undefined;

type UpdaterLifecycle = {
  started: boolean;
  retired: boolean;
  pending: Set<Promise<unknown>>;
  handlers: Array<() => void>;
  checkInProgress: boolean;
  checkErrorReported: boolean;
  downloadErrorReported: boolean;
};

function createLifecycle(): UpdaterLifecycle {
  return {
    started: false,
    retired: false,
    pending: new Set(),
    handlers: [],
    checkInProgress: false,
    checkErrorReported: false,
    downloadErrorReported: false,
  };
}

let lifecycle: UpdaterLifecycle | null = null;
let retiringLifecycle: UpdaterLifecycle | null = null;
let restartRequested = false;

function isCurrent(owner: UpdaterLifecycle): boolean {
  return lifecycle === owner && !owner.retired;
}

function removeOwnedHandlers(owner: UpdaterLifecycle): void {
  for (const remove of owner.handlers) remove();
  owner.handlers.length = 0;
}

function trackOperation(owner: UpdaterLifecycle, operation: Promise<unknown>): void {
  owner.pending.add(operation);
  void operation.then(
    () => {
      finishOperation(owner, operation);
    },
    () => {
      finishOperation(owner, operation);
    },
  );
}

function finishOperation(owner: UpdaterLifecycle, operation: Promise<unknown>): void {
  owner.pending.delete(operation);
  if (owner === retiringLifecycle && owner.pending.size === 0) {
    removeOwnedHandlers(owner);
    retiringLifecycle = null;
    if (restartRequested) {
      restartRequested = false;
      initAutoUpdater();
    }
  }
}

/** Configure hybrid policy (idempotent; last call wins). */
export function configureHybridAutoUpdater(next: HybridAutoUpdaterDeps): void {
  deps = next;
  cachedReleaseUrlBase = undefined;
  lifecycle ??= createLifecycle();
}

function requireDeps(): HybridAutoUpdaterDeps {
  if (deps === null) {
    throw new Error("[auto-updater] configureHybridAutoUpdater() must run before use");
  }
  return deps;
}

function publishStatus(status: AutoUpdaterStatus): void {
  requireDeps().publish({ type: "auto-updater-status", status });
}

function getReleaseUrlBase(): string | null {
  if (cachedReleaseUrlBase !== undefined) {
    return cachedReleaseUrlBase;
  }
  const base = deriveReleaseUrlBase(requireDeps().getRepositoryUrl());
  cachedReleaseUrlBase = base;
  return base;
}

function toUpdateMeta(info: UpdateInfo): UpdateMeta {
  return {
    version: info.version,
    releaseDate: typeof info.releaseDate === "string" ? info.releaseDate : "",
    ...(typeof info.releaseNotes === "string" ? { releaseNotes: info.releaseNotes } : {}),
  };
}

/**
 * Present the aurora utility dialog (injected by composition / WindowGraph).
 * Keeps infrastructure free of BrowserWindow / Dock policy.
 */
async function presentUserDialog(options: UtilityDialogOptions): Promise<UtilityDialogResult> {
  return requireDeps().showUserDialog(options);
}

/**
 * Apple HIG two-button layout: secondary (dismiss/alt) left, primary right.
 * `defaultId` lands on the primary action; `cancelId` defaults to secondary (Esc).
 * Use `cancelOnPrimary: true` when Esc should dismiss without the secondary side effect
 * (e.g. Open Releases… + OK).
 */
function twoButtonAlert(
  primaryLabel: string,
  secondaryLabel: string,
  options?: { cancelOnPrimary?: boolean },
): {
  buttons: string[];
  defaultId: number;
  cancelId: number;
  primaryResponse: number;
  secondaryResponse: number;
} {
  const primaryResponse = 1;
  const secondaryResponse = 0;
  return {
    buttons: [secondaryLabel, primaryLabel],
    defaultId: primaryResponse,
    cancelId: options?.cancelOnPrimary === true ? primaryResponse : secondaryResponse,
    primaryResponse,
    secondaryResponse,
  };
}

function notifyUserStatus(body: string): void {
  try {
    requireDeps().notifyUser?.({ title: "Amphetamine", body });
  } catch (err: unknown) {
    log.warn("[auto-updater] notifyUser failed:", err);
  }
}

/**
 * Open the GitHub release page for a version (browser fallback).
 * Used when in-app download/install is unavailable or fails (unsigned builds, etc.).
 */
function openReleasePageInBrowser(version: string): void {
  if (!SEMVER_RE.test(version)) {
    log.warn("[auto-updater] Skipping release URL — invalid version format:", version);
    return;
  }
  const base = getReleaseUrlBase();
  if (base === null) {
    log.warn("[auto-updater] Skipping release URL — no derivable repository URL");
    return;
  }
  const url = base + encodeURIComponent(version);
  log.info("[auto-updater] Opening release page (fallback):", url);
  void shell.openExternal(url);
}

/** Open the repository releases list (no specific version). */
function openReleasesListInBrowser(): void {
  const base = getReleaseUrlBase();
  if (base === null) {
    log.warn("[auto-updater] Skipping releases list — no derivable repository URL");
    return;
  }
  // base ends with "/releases/tag/v" — strip tag suffix for the list page.
  const listUrl = base.replace(/\/releases\/tag\/v$/, "/releases");
  log.info("[auto-updater] Opening releases list:", listUrl);
  void shell.openExternal(listUrl);
}

function clearUserInitiated(): void {
  userInitiatedCheck = false;
  pendingUserFeedback = false;
  downloadNotifySent = false;
}

function markUserFeedbackDelivered(): void {
  pendingUserFeedback = false;
}

/** Re-read flag after await; event handlers may clear it concurrently. */
function stillNeedsUserFeedback(): boolean {
  return pendingUserFeedback;
}

/**
 * Single-flight check: concurrent callers share one `checkForUpdates()`.
 * Manual (user-initiated) joiners upgrade `userInitiatedCheck` before awaiting.
 */
function runSharedCheckForUpdates(
  owner: UpdaterLifecycle,
): Promise<Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>> {
  if (inFlightCheck !== null) {
    return inFlightCheck;
  }
  owner.checkErrorReported = false;
  owner.downloadErrorReported = false;
  owner.checkInProgress = true;
  const pending = autoUpdater
    .checkForUpdates()
    .catch((error: unknown) => {
      if (isCurrent(owner) && !owner.checkErrorReported) {
        onError(error instanceof Error ? error : new Error(String(error)), owner);
      }
      throw error;
    })
    .finally(() => {
      owner.checkInProgress = false;
      if (inFlightCheck === pending) {
        inFlightCheck = null;
      }
    });
  inFlightCheck = pending;
  trackOperation(owner, pending);
  return pending;
}

/**
 * Finish a failed user-initiated check with browser fallback or a dialog.
 * No-ops if event handlers already consumed the user-initiated flag.
 */
let lastCheckErrorCategory: "network" | "feed-missing" | "signature" | "io" | "unknown" = "unknown";

function finishUserInitiatedFailure(owner: UpdaterLifecycle): void {
  if (!isCurrent(owner)) return;
  if (!userInitiatedCheck && !pendingUserFeedback) {
    return;
  }
  const version = lastAvailableVersion;
  const category = lastCheckErrorCategory;
  clearUserInitiated();
  if (version !== null) {
    openReleasePageInBrowser(version);
  } else {
    showCheckFailedDialog(category, owner);
  }
}

/** User-facing dialog when this build is already the latest. */
function showUpToDateDialog(version: string, owner: UpdaterLifecycle): void {
  if (!isCurrent(owner)) return;
  void presentUserDialog({
    buttons: ["OK"],
    defaultId: 0,
    cancelId: 0,
    title: "Amphetamine",
    message: "You’re Up to Date",
    detail: `Amphetamine ${version} is the latest version available.`,
  }).catch((err: unknown) => {
    log.warn("[auto-updater] Failed to show up-to-date dialog:", err);
  });
}

/** User-facing dialog when a manual check fails and we have no update payload. */
function showCheckFailedDialog(
  category: "network" | "feed-missing" | "signature" | "io" | "unknown" = "unknown",
  owner: UpdaterLifecycle,
): void {
  if (!isCurrent(owner)) return;
  const detailByCategory: Record<typeof category, string> = {
    network:
      "Amphetamine couldn’t reach the update server. Check your network connection and try again, " +
      "or open the Releases page to download the latest version.",
    "feed-missing":
      "Update information for this release isn’t available yet. " +
      "Open the Releases page to download manually, or try again after a new release is published.",
    signature:
      "An update was found but couldn’t be verified. Open the Releases page to download manually.",
    io:
      "Amphetamine couldn’t save or read update files. Check available disk space and try again, " +
      "or open the Releases page to download manually.",
    unknown:
      "Amphetamine couldn’t complete the update check. Open the Releases page to download manually.",
  };
  // Esc / cancel must dismiss (OK), not open the browser.
  const actions = twoButtonAlert("OK", "Open Releases…", { cancelOnPrimary: true });
  void presentUserDialog({
    buttons: actions.buttons,
    defaultId: actions.defaultId,
    cancelId: actions.cancelId,
    title: "Amphetamine",
    message: "Unable to Check for Updates",
    detail: detailByCategory[category],
  })
    .then((result) => {
      if (!isCurrent(owner)) return;
      if (result.response === actions.secondaryResponse) {
        openReleasesListInBrowser();
      }
    })
    .catch((err: unknown) => {
      log.warn("[auto-updater] Failed to show check-failed dialog:", err);
    });
}

/** User-facing dialog when update checks are unavailable (unpackaged / dev). */
function showUpdatesUnavailableDialog(owner: UpdaterLifecycle): void {
  if (!isCurrent(owner)) return;
  void presentUserDialog({
    buttons: ["OK"],
    defaultId: 0,
    cancelId: 0,
    title: "Amphetamine",
    message: "Updates Unavailable",
    detail:
      "Update checks work only in a packaged release of Amphetamine. " +
      "This development or unpackaged build can’t download updates.",
  }).catch((err: unknown) => {
    log.warn("[auto-updater] Failed to show updates-unavailable dialog:", err);
  });
}

/** Handle "checking-for-update" event */
function onCheckingForUpdate(): void {
  log.info("[auto-updater] Checking for updates...");
  publishStatus({ status: "checking" });
  if (userInitiatedCheck) {
    notifyUserStatus("Checking for updates…");
  }
}

/**
 * Handle "update-available" event.
 *
 * Hybrid policy:
 * - Always broadcast status.
 * - User-initiated check: try in-app download; on failure fall back to browser.
 * - Background/periodic check: do not download or open the browser (non-intrusive).
 */
function onUpdateAvailable(info: UpdateInfo, owner: UpdaterLifecycle): void {
  log.info("[auto-updater] Update available:", info.version);
  consecutiveFailures = 0;
  rescheduleCheckLoop();
  lastAvailableVersion = info.version;

  publishStatus({
    status: "available",
    info: toUpdateMeta(info),
  });

  if (!userInitiatedCheck || !pendingUserFeedback) {
    log.info("[auto-updater] Background check found update; waiting for user action");
    return;
  }

  // Download path is the user feedback for this check (progress + install dialog later).
  markUserFeedbackDelivered();
  startUserInitiatedDownload(info.version, owner);
}

function startUserInitiatedDownload(version: string, owner: UpdaterLifecycle): void {
  owner.downloadErrorReported = false;
  log.info("[auto-updater] User-initiated: attempting in-app download of", version);
  if (!downloadNotifySent) {
    downloadNotifySent = true;
    notifyUserStatus(`Downloading Amphetamine ${version}…`);
  }
  const download = autoUpdater.downloadUpdate();
  trackOperation(owner, download);
  void download
    .then(() => {
      if (!isCurrent(owner)) return;
      log.info("[auto-updater] downloadUpdate() resolved for", version);
    })
    .catch((err: unknown) => {
      if (!isCurrent(owner) || owner.downloadErrorReported) return;
      owner.downloadErrorReported = true;
      log.warn("[auto-updater] In-app download failed; falling back to browser:", err);
      openReleasePageInBrowser(version);
      clearUserInitiated();
    });
}

/** Handle "update-not-available" event */
function onUpdateNotAvailable(info: UpdateInfo, owner: UpdaterLifecycle): void {
  log.info("[auto-updater] No update available. Current version:", info.version);
  consecutiveFailures = 0;
  rescheduleCheckLoop();
  publishStatus({
    status: "not-available",
    info: {
      version: info.version,
      releaseDate: typeof info.releaseDate === "string" ? info.releaseDate : "",
    },
  });

  if (userInitiatedCheck || pendingUserFeedback) {
    clearUserInitiated();
    showUpToDateDialog(info.version, owner);
  }
}

/** Handle download progress during user-initiated update */
function onDownloadProgress(progress: ProgressInfo): void {
  if (!userInitiatedCheck) return;
  publishStatus({
    status: "downloading",
    progress: {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    },
  });
  // One notification at first progress if download start was missed.
  if (!downloadNotifySent && lastAvailableVersion !== null) {
    downloadNotifySent = true;
    notifyUserStatus(`Downloading Amphetamine ${lastAvailableVersion}…`);
  }
}

/**
 * Handle "update-downloaded" event.
 * For user-initiated flow: offer restart to install; on decline leave staged for later.
 * If quitAndInstall is refused/fails, fall back to the GitHub release page.
 */
function onUpdateDownloaded(info: UpdateInfo, owner: UpdaterLifecycle): void {
  log.info("[auto-updater] Update downloaded:", info.version);
  publishStatus({
    status: "downloaded",
    info: toUpdateMeta(info),
  });

  if (!userInitiatedCheck) {
    // Background download path is not used (autoDownload=false); keep safe.
    return;
  }

  clearUserInitiated();

  const actions = twoButtonAlert("Restart", "Later");
  void presentUserDialog({
    buttons: actions.buttons,
    defaultId: actions.defaultId,
    cancelId: actions.cancelId,
    title: "Amphetamine",
    message: "A New Version Is Ready to Install",
    detail:
      `Amphetamine ${info.version} was downloaded. Restart to finish updating. ` +
      "If automatic install isn’t available (for example on unsigned builds), " +
      "you can install from the Releases page instead.",
  })
    .then((result) => {
      if (!isCurrent(owner)) return;
      if (result.response === actions.primaryResponse) {
        try {
          // isSilent=false, isForceRunAfter=true so the app relaunches after swap when possible.
          autoUpdater.quitAndInstall(false, true);
        } catch (err) {
          log.warn("[auto-updater] quitAndInstall failed; falling back to browser:", err);
          openReleasePageInBrowser(info.version);
        }
      } else {
        log.info("[auto-updater] User deferred install; update remains staged if supported");
      }
    })
    .catch((err: unknown) => {
      if (!isCurrent(owner)) return;
      log.warn("[auto-updater] Install dialog failed; falling back to browser:", err);
      openReleasePageInBrowser(info.version);
    });
}

/** Handle "error" event */
function onError(err: Error, owner: UpdaterLifecycle): void {
  if (owner.checkErrorReported || owner.downloadErrorReported) return;
  if (owner.checkInProgress) {
    owner.checkErrorReported = true;
  }
  if (userInitiatedCheck && lastAvailableVersion !== null) owner.downloadErrorReported = true;
  log.error("[auto-updater] Error:", err.message);
  consecutiveFailures += 1;
  rescheduleCheckLoop();
  const category = categorizeUpdaterError(err);
  lastCheckErrorCategory = category;
  publishStatus({
    status: "error",
    category,
  });

  // User-initiated path failed (check/download/signature): open release page when we know a version;
  // otherwise surface a dialog so Check for Updates never fails silently.
  if (userInitiatedCheck) {
    const version = lastAvailableVersion;
    clearUserInitiated();
    if (version !== null) {
      log.info("[auto-updater] Error during user-initiated update; falling back to browser");
      openReleasePageInBrowser(version);
    } else {
      log.info("[auto-updater] Error during user-initiated check with no known version");
      showCheckFailedDialog(category, owner);
    }
  }
}

/** Register all autoUpdater event handlers */
function registerUpdateEventHandlers(owner: UpdaterLifecycle): void {
  const checking = () => {
    if (isCurrent(owner)) onCheckingForUpdate();
  };
  const available = (info: UpdateInfo) => {
    if (isCurrent(owner)) onUpdateAvailable(info, owner);
  };
  const unavailable = (info: UpdateInfo) => {
    if (isCurrent(owner)) onUpdateNotAvailable(info, owner);
  };
  const progress = (info: ProgressInfo) => {
    if (isCurrent(owner)) onDownloadProgress(info);
  };
  const downloaded = (info: UpdateInfo) => {
    if (isCurrent(owner)) onUpdateDownloaded(info, owner);
  };
  const error = (reason: Error) => {
    if (isCurrent(owner)) onError(reason, owner);
  };
  autoUpdater.on("checking-for-update", checking);
  autoUpdater.on("update-available", available);
  autoUpdater.on("update-not-available", unavailable);
  autoUpdater.on("download-progress", progress);
  autoUpdater.on("update-downloaded", downloaded);
  autoUpdater.on("error", error);
  owner.handlers.push(
    () => autoUpdater.off("checking-for-update", checking),
    () => autoUpdater.off("update-available", available),
    () => autoUpdater.off("update-not-available", unavailable),
    () => autoUpdater.off("download-progress", progress),
    () => autoUpdater.off("update-downloaded", downloaded),
    () => autoUpdater.off("error", error),
  );
}

/** Compute next interval with exponential backoff capped at MAX_UPDATE_CHECK_INTERVAL_MS */
function computeNextInterval(): number {
  return Math.min(
    PERIODIC_UPDATE_CHECK_INTERVAL_MS * Math.pow(2, consecutiveFailures),
    MAX_UPDATE_CHECK_INTERVAL_MS,
  );
}

/** Reschedule the periodic check loop with the current backoff interval */
function rescheduleCheckLoop(): void {
  if (checkIntervalId === null) {
    return;
  }
  clearInterval(checkIntervalId);
  const nextInterval = computeNextInterval();
  log.info(
    "[auto-updater] Rescheduling periodic check; failures=",
    consecutiveFailures,
    "interval(ms)=",
    nextInterval,
  );
  checkIntervalId = setInterval(() => {
    log.info("[auto-updater] Running periodic update check...");
    if (lifecycle !== null) void runSharedCheckForUpdates(lifecycle).catch(() => undefined);
  }, nextInterval);
  checkIntervalId.unref();
}

/** Start initial delayed check and periodic update check loop */
function startUpdateCheckLoop(owner: UpdaterLifecycle): void {
  // Initial check after 3-second delay (avoid startup slowdown) — not subject to backoff
  initialCheckTimerId = setTimeout(() => {
    initialCheckTimerId = null;
    log.info("[auto-updater] Running initial update check...");
    if (isCurrent(owner)) void runSharedCheckForUpdates(owner).catch(() => undefined);
  }, INITIAL_UPDATE_CHECK_DELAY_MS);
  initialCheckTimerId.unref();

  // Periodic check (base 4 hours, exponential backoff on failures up to 24 hours)
  checkIntervalId = setInterval(() => {
    log.info("[auto-updater] Running periodic update check...");
    if (isCurrent(owner)) void runSharedCheckForUpdates(owner).catch(() => undefined);
  }, PERIODIC_UPDATE_CHECK_INTERVAL_MS);
  checkIntervalId.unref();
}

/**
 * Initialize the auto-updater.
 * Registers event handlers and starts periodic update checks.
 * Only runs in packaged (production) builds.
 *
 * Hybrid policy (option C):
 * - autoDownload stays false so background checks never pull payloads.
 * - "Check for Updates" tries download + quitAndInstall when the platform allows;
 *   otherwise falls back to opening the GitHub release page.
 *
 * Feed metadata (electron-updater GitHub provider):
 * - macOS: ZIP + `latest-mac.yml` (and optional blockmap) on the release
 * - Windows: NSIS/portable EXE for **x64 and arm64** + `latest.yml` (and optional blockmap);
 *   electron-updater selects the asset matching `process.arch` when both are published
 * Unsigned or incomplete feeds still check for availability; install then falls back
 * to the browser. CD attaches these artifacts when present.
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    return;
  }
  if (retiringLifecycle !== null) {
    restartRequested = true;
    return;
  }
  const owner = lifecycle ?? createLifecycle();
  if (owner.started) return;
  lifecycle = owner;
  owner.started = true;

  autoUpdater.logger = log;
  // Keep background auto-download off. User-initiated flow calls downloadUpdate() explicitly.
  // macOS: code-signature verification runs via electron-updater / Squirrel.Mac on quitAndInstall.
  // Windows (x64/arm64): in-app install works when Authenticode-signed and latest.yml is published;
  // otherwise browser fallback covers unsigned CI builds and download/install failures.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // Prefer package.json repository over a possibly stale app-update.yml baked at
  // package time (e.g. after org rename). electron-updater GitHub provider needs
  // owner/repo; feed files (latest-mac.yml / latest.yml) must still be on the release.
  const identity = parseGitHubRepoIdentity(requireDeps().getRepositoryUrl());
  if (identity !== null) {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: identity.owner,
      repo: identity.repo,
    });
    log.info(`[auto-updater] GitHub feed configured: ${identity.owner}/${identity.repo}`);
  } else {
    log.warn(
      "[auto-updater] Could not parse GitHub owner/repo from package repository; using packaged app-update.yml",
    );
  }

  registerUpdateEventHandlers(owner);
  startUpdateCheckLoop(owner);

  log.info("[auto-updater] Auto-updater initialized (packaged build, hybrid install)");
}

/**
 * Stop the auto-updater.
 * Clears owned timers and retires in-flight transport before removing owned listeners.
 */
export function stopAutoUpdater(): void {
  const owner = lifecycle;
  restartRequested = false;
  if (owner === null || owner.retired) return;
  owner.retired = true;
  lifecycle = null;
  if (initialCheckTimerId !== null) {
    clearTimeout(initialCheckTimerId);
    initialCheckTimerId = null;
  }
  if (checkIntervalId !== null) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }
  if (owner.pending.size > 0) {
    retiringLifecycle = owner;
  } else {
    removeOwnedHandlers(owner);
  }
  lastAvailableVersion = null;
  clearUserInitiated();
  consecutiveFailures = 0;
  lastCheckErrorCategory = "unknown";
  // Clear shared in-flight seam so a later check is not stuck on a dead promise.
  inFlightCheck = null;
  log.info("[auto-updater] Stopped");
}

/**
 * Manually trigger an update check (tray menu / IPC).
 * Marks the check as user-initiated so an available update will attempt download/install
 * with browser fallback. Always gives user-visible feedback (dialog or browser fallback).
 * Joins any in-flight background check (upgrading user intent) rather than starting a second.
 */
export function checkForUpdatesNow(): void {
  const owner = lifecycle;
  if (owner === null || owner.retired || retiringLifecycle !== null) return;
  if (!app.isPackaged) {
    log.info("[auto-updater] checkForUpdatesNow skipped (not packaged)");
    showUpdatesUnavailableDialog(owner);
    return;
  }
  log.info("[auto-updater] Manual update check requested (hybrid path)");
  // Upgrade intent before awaiting so a joined background check becomes user-visible.
  userInitiatedCheck = true;
  pendingUserFeedback = true;
  downloadNotifySent = false;
  notifyUserStatus("Checking for updates…");
  void (async () => {
    try {
      const result = await runSharedCheckForUpdates(owner);
      if (!isCurrent(owner)) return;
      // Event handlers already delivered feedback (dialog, download, or browser).
      if (!stillNeedsUserFeedback()) {
        return;
      }
      // Joined a check whose events ran without user intent — settle from the result.
      if (result?.updateInfo) {
        lastAvailableVersion = result.updateInfo.version;
        markUserFeedbackDelivered();
        publishStatus({
          status: "available",
          info: toUpdateMeta(result.updateInfo),
        });
        startUserInitiatedDownload(result.updateInfo.version, owner);
      } else {
        clearUserInitiated();
        showUpToDateDialog(app.getVersion(), owner);
      }
    } catch (err: unknown) {
      if (!isCurrent(owner)) return;
      log.warn("[auto-updater] Manual update check failed:", err);
      if (err instanceof Error) {
        lastCheckErrorCategory = categorizeUpdaterError(err);
      }
      finishUserInitiatedFailure(owner);
    }
  })();
}

/**
 * User-initiated check for IPC handlers (same hybrid path as tray).
 * Returns update metadata when electron-updater resolves with updateInfo.
 * Shares the single in-flight `checkForUpdates()` with tray/background callers.
 */
export async function checkForUpdatesForIpc(): Promise<{
  version: string;
  releaseDate: string;
} | null> {
  const owner = lifecycle;
  if (owner === null || owner.retired || retiringLifecycle !== null) return null;
  if (!app.isPackaged) {
    log.info("[auto-updater] checkForUpdatesForIpc skipped (not packaged)");
    showUpdatesUnavailableDialog(owner);
    return null;
  }
  userInitiatedCheck = true;
  pendingUserFeedback = true;
  downloadNotifySent = false;
  notifyUserStatus("Checking for updates…");
  try {
    const result = await runSharedCheckForUpdates(owner);
    if (!isCurrent(owner)) return null;
    if (stillNeedsUserFeedback()) {
      if (result?.updateInfo) {
        lastAvailableVersion = result.updateInfo.version;
        markUserFeedbackDelivered();
        startUserInitiatedDownload(result.updateInfo.version, owner);
      } else {
        clearUserInitiated();
        showUpToDateDialog(app.getVersion(), owner);
      }
    }
    if (result?.updateInfo) {
      return {
        version: result.updateInfo.version,
        releaseDate:
          typeof result.updateInfo.releaseDate === "string" ? result.updateInfo.releaseDate : "",
      };
    }
    return null;
  } catch (err) {
    if (!isCurrent(owner)) return null;
    log.warn("[auto-updater] Failed to check for updates:", err);
    if (err instanceof Error) {
      lastCheckErrorCategory = categorizeUpdaterError(err);
    }
    finishUserInitiatedFailure(owner);
    return null;
  }
}
