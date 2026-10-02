/**
 * WindowGraph — owns every BrowserWindow in the main process.
 *
 * Process-model role: the only place that spawns renderer processes. Shared
 * secure webPreferences, navigation hardening, and singleton tracking live here.
 */
import { BrowserWindow, screen } from "electron/main";
import { nativeImage, shell } from "electron/common";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron/main";
import {
  ABOUT_WINDOW_HEIGHT,
  ABOUT_WINDOW_WIDTH,
  getDevServerUrl,
  HIDE_DELAY_MS,
  isDev,
  MAIN_WINDOW_HEIGHT,
  MAIN_WINDOW_WIDTH,
  SETTINGS_WINDOW_HEIGHT,
  SETTINGS_WINDOW_WIDTH,
  UTILITY_DIALOG_HEIGHT,
  UTILITY_DIALOG_MAX_HEIGHT,
  UTILITY_DIALOG_MIN_HEIGHT,
  UTILITY_DIALOG_WIDTH,
} from "../constants.js";
import { hardenWebContents } from "../security.js";
import { broadcastToWindows } from "../utils/broadcast.js";
import { IPC_CHANNELS } from "../../shared/types.js";
import {
  SETTINGS_QUIT_DRAIN_ACK,
  SETTINGS_QUIT_DRAIN_REQUEST,
  type SettingsQuitDrainRequest,
} from "../../shared/settings-quit.js";
import {
  UTILITY_DIALOG_APPLY,
  UTILITY_DIALOG_GET_PAYLOAD,
  UTILITY_DIALOG_RESPOND,
  UTILITY_DIALOG_SET_HEIGHT,
  type UtilityDialogApplyMessage,
  type UtilityDialogOptions,
  type UtilityDialogPayload,
  type UtilityDialogResult,
} from "../../shared/utility-dialog.js";
import {
  aboutWindowChrome,
  appIconFileName,
  acquireUtilityForeground,
  releaseUtilityForeground,
  setUtilityDockIcon,
  popoverWindowChrome,
  settingsWindowChrome,
  utilityDialogWindowChrome,
} from "../platform/index.js";
import { createSecureWebPreferences } from "./secure-web-preferences.js";
import { getPackageInfo } from "../utils/packageInfo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Preload CJS path relative to compiled main process modules. */
export function getPreloadScriptPath(): string {
  return path.join(__dirname, "..", "preload", "index.cjs");
}

/** Dedicated sandboxed preload for the aurora utility dialog. */
export function getUtilityDialogPreloadPath(): string {
  return path.join(__dirname, "..", "preload", "utility-dialog.cjs");
}

function getWindowIconPath(): string {
  return path.join(__dirname, "..", "..", "src", "assets", "settings-hero-icon.png");
}

function getAppIconPath(): string {
  const fileName = appIconFileName();
  if (isDev) {
    return path.join(__dirname, "..", "..", "build", fileName);
  }
  return path.join(process.resourcesPath, fileName);
}

let cachedDockIcon: Electron.NativeImage | null = null;

function getDockIcon(): Electron.NativeImage {
  if (!cachedDockIcon) {
    cachedDockIcon = nativeImage.createFromPath(getAppIconPath());
  }
  return cachedDockIcon;
}

function ensureUtilityDockIcon(): void {
  setUtilityDockIcon(getDockIcon());
}

// --- Registry ---

let popoverWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let settingsReadyWindow: BrowserWindow | null = null;
let aboutWindow: BrowserWindow | null = null;
/** Single pending delayed hide for the popover (blur/minimize coalesced). */
let popoverHideTimeoutId: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule one delayed popover hide + one WINDOW_HIDE broadcast.
 * Additional blur/minimize events while pending are no-ops.
 */
function schedulePopoverHide(win: BrowserWindow): void {
  if (popoverHideTimeoutId !== null) {
    return;
  }
  broadcastToWindows(IPC_CHANNELS.WINDOW_HIDE, undefined);
  popoverHideTimeoutId = setTimeout(() => {
    popoverHideTimeoutId = null;
    if (!win.isDestroyed()) {
      win.hide();
    }
  }, HIDE_DELAY_MS);
  popoverHideTimeoutId.unref();
}

/** Cancel a pending delayed hide (e.g. popover shown again before expiry). */
function cancelPendingPopoverHide(): void {
  if (popoverHideTimeoutId === null) return;
  clearTimeout(popoverHideTimeoutId);
  popoverHideTimeoutId = null;
}

/** Test/observability seam: true while a delayed hide is scheduled. */
export function hasPendingPopoverHide(): boolean {
  return popoverHideTimeoutId !== null;
}

export function getPopoverWindow(): BrowserWindow | null {
  if (popoverWindow !== null && popoverWindow.isDestroyed()) {
    popoverWindow = null;
  }
  return popoverWindow;
}

// --- Popover ---

export interface PopoverWindowOptions {
  /** True while the app is quitting (close should destroy, not hide). */
  isQuitting: () => boolean;
}

/**
 * Create the tray popover window (singleton). Replaces prior createWindow in index.
 */
export function createPopoverWindow(options: PopoverWindowOptions): BrowserWindow {
  if (popoverWindow !== null && !popoverWindow.isDestroyed()) {
    return popoverWindow;
  }

  const win = new BrowserWindow({
    width: MAIN_WINDOW_WIDTH,
    height: MAIN_WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    paintWhenInitiallyHidden: false,
    ...popoverWindowChrome(),
    webPreferences: createSecureWebPreferences({ preload: getPreloadScriptPath() }),
  });

  hardenWebContents(win);

  if (isDev) {
    void win.loadURL(getDevServerUrl());
  } else {
    void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  win.on("close", (event) => {
    if (options.isQuitting()) return;
    event.preventDefault();
    cancelPendingPopoverHide();
    win.hide();
  });

  win.on("show", () => {
    // Becoming visible invalidates any stale delayed hide.
    cancelPendingPopoverHide();
  });

  win.on("minimize", () => {
    if (!win.isDestroyed()) {
      schedulePopoverHide(win);
    }
  });

  win.on("blur", () => {
    if (!isDev && !options.isQuitting() && !win.isDestroyed()) {
      schedulePopoverHide(win);
    }
  });

  win.on("closed", () => {
    cancelPendingPopoverHide();
    if (popoverWindow === win) {
      popoverWindow = null;
    }
  });

  popoverWindow = win;
  return win;
}

/**
 * Position and show the popover near the tray icon (or last known bounds).
 * Toggle hide when already visible.
 */
export function showPopoverNearTray(trayBounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): void {
  const win = getPopoverWindow();
  if (win === null || win.isDestroyed()) return;

  cancelPendingPopoverHide();

  if (win.isVisible()) {
    win.hide();
    return;
  }

  const size = win.getSize();
  const winWidth = size[0] ?? MAIN_WINDOW_WIDTH;
  const winHeight = size[1] ?? MAIN_WINDOW_HEIGHT;
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y,
  });
  const work = display.workArea;

  // Center horizontally on tray; prefer below tray on top menu bar, else above.
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winWidth / 2);
  let y = trayBounds.y + trayBounds.height + 4;
  if (y + winHeight > work.y + work.height) {
    y = trayBounds.y - winHeight - 4;
  }
  x = Math.max(work.x, Math.min(x, work.x + work.width - winWidth));
  y = Math.max(work.y, Math.min(y, work.y + work.height - winHeight));

  win.setPosition(x, y, false);
  win.show();
  win.focus();
}

// --- Settings / About: hide-on-close warm cache ---
//
// First open creates + loads the BrowserWindow (slow). User close hides and keeps
// the renderer process warm so the next open is show/focus only (fast). Quit and
// composition cleanup force-destroy via closeSettingsWindow / closeAboutWindow.

let settingsHeldForeground = false;
let aboutHeldForeground = false;
/** When true, close is allowed to destroy (quit / composition cleanup). */
let settingsAllowDestroy = false;
let aboutAllowDestroy = false;
/**
 * User intent to have the utility visible. Cleared on hide/destroy.
 * Guards late `ready-to-show` so a dismiss before first paint cannot re-show the window.
 */
let settingsWantsVisible = false;
let aboutWantsVisible = false;

type UtilityKind = "settings" | "about";

function isUtilityHeld(kind: UtilityKind): boolean {
  return kind === "settings" ? settingsHeldForeground : aboutHeldForeground;
}

function setUtilityHeld(kind: UtilityKind, held: boolean): void {
  if (kind === "settings") {
    settingsHeldForeground = held;
  } else {
    aboutHeldForeground = held;
  }
}

function wantsVisible(kind: UtilityKind): boolean {
  return kind === "settings" ? settingsWantsVisible : aboutWantsVisible;
}

function setWantsVisible(kind: UtilityKind, wants: boolean): void {
  if (kind === "settings") {
    settingsWantsVisible = wants;
  } else {
    aboutWantsVisible = wants;
  }
}

/**
 * Drop focus from renderer controls after show.
 * Chromium restores the previous active element (or first tabbable) on
 * BrowserWindow.show(); Settings should open without a focused switch/select,
 * About without the GitHub icon ring.
 */
function clearUtilityRendererFocus(win: BrowserWindow, kind: UtilityKind): void {
  // Defer past Chromium's focus-restore pass on show/focus.
  setTimeout(() => {
    if (win.isDestroyed() || !wantsVisible(kind) || !win.isVisible()) {
      return;
    }
    void win.webContents
      .executeJavaScript(
        `(() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && active !== document.body) {
            active.blur();
          }
        })()`,
      )
      .catch(() => {
        // Window may have been destroyed or navigated away mid-flight.
      });
  }, 0);
}

/**
 * Show/focus a warm-cached utility. No-ops if the user already dismissed
 * (prevents late ready-to-show from resurrecting a closed window).
 */
function presentCachedUtilityWindow(win: BrowserWindow, kind: UtilityKind): void {
  if (win.isDestroyed() || !wantsVisible(kind)) return;
  if (!isUtilityHeld(kind)) {
    ensureUtilityDockIcon();
    acquireUtilityForeground();
    setUtilityHeld(kind, true);
  }
  if (!win.isVisible()) {
    win.show();
  }
  win.focus();
  clearUtilityRendererFocus(win, kind);
}

function hideCachedUtilityWindow(win: BrowserWindow, kind: UtilityKind): void {
  // Mark dismissed before hide so any in-flight ready-to-show is ignored.
  setWantsVisible(kind, false);
  if (isUtilityHeld(kind)) {
    releaseUtilityForeground();
    setUtilityHeld(kind, false);
  }
  if (!win.isDestroyed() && win.isVisible()) {
    win.hide();
  }
}

function destroyCachedUtilityWindow(
  win: BrowserWindow | null,
  kind: UtilityKind,
  clearRegistry: () => void,
): void {
  setWantsVisible(kind, false);
  if (isUtilityHeld(kind)) {
    releaseUtilityForeground();
    setUtilityHeld(kind, false);
  }
  clearRegistry();
  if (win === null || win.isDestroyed()) {
    return;
  }
  if (kind === "settings") {
    settingsAllowDestroy = true;
  } else {
    aboutAllowDestroy = true;
  }
  try {
    // destroy() bypasses hide-on-close preventDefault and tears down the renderer.
    win.destroy();
  } finally {
    if (kind === "settings") {
      settingsAllowDestroy = false;
    } else {
      aboutAllowDestroy = false;
    }
  }
}

// --- Settings ---

/**
 * Creates or focuses the settings window (singleton, warm-cached after first open).
 * macOS: Dock while visible. Windows: taskbar button while visible.
 * User close hides the window; quit destroys it.
 */
export function createSettingsWindow(): BrowserWindow {
  // User requested visibility (clears a prior hide before late ready-to-show).
  setWantsVisible("settings", true);

  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    presentCachedUtilityWindow(settingsWindow, "settings");
    return settingsWindow;
  }

  const win = new BrowserWindow({
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    minWidth: SETTINGS_WINDOW_WIDTH,
    minHeight: SETTINGS_WINDOW_HEIGHT,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    icon: getWindowIconPath(),
    ...settingsWindowChrome(),
    webPreferences: createSecureWebPreferences({ preload: getPreloadScriptPath() }),
  });

  hardenWebContents(win);

  if (isDev) {
    void win.loadURL(`${getDevServerUrl()}/settings.html`);
  } else {
    void win.loadFile(path.join(__dirname, "..", "renderer", "settings.html"));
  }

  win.once("ready-to-show", () => {
    settingsReadyWindow = win;
    // May no-op if the user dismissed before first paint (wantsVisible=false).
    presentCachedUtilityWindow(win, "settings");
  });

  // User close (title bar / Esc / window.close) → hide + keep warm cache.
  win.on("close", (event) => {
    if (settingsAllowDestroy) {
      return;
    }
    event.preventDefault();
    hideCachedUtilityWindow(win, "settings");
  });

  win.on("closed", () => {
    if (settingsWindow === win) {
      settingsWindow = null;
    }
    if (settingsReadyWindow === win) settingsReadyWindow = null;
    setWantsVisible("settings", false);
    if (settingsHeldForeground) {
      releaseUtilityForeground();
      settingsHeldForeground = false;
    }
  });

  settingsWindow = win;
  return win;
}

/** True when the settings window exists and is currently visible. */
export function isSettingsWindowOpen(): boolean {
  return settingsWindow !== null && !settingsWindow.isDestroyed() && settingsWindow.isVisible();
}

export function drainSettingsWindow(signal: AbortSignal): Promise<void> {
  const win = settingsWindow;
  if (
    win === null ||
    win !== settingsReadyWindow ||
    win.isDestroyed() ||
    win.webContents.isDestroyed() ||
    win.webContents.isLoadingMainFrame()
  ) {
    return Promise.resolve();
  }

  const contents = win.webContents;
  const request: SettingsQuitDrainRequest = { requestId: randomUUID() };
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      ipcMain.removeListener(SETTINGS_QUIT_DRAIN_ACK, onAck);
      contents.removeListener("destroyed", onDestroyed);
      win.removeListener("closed", onDestroyed);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDestroyed = (): void => settle(new Error("Settings window closed during quit drain"));
    const onAbort = (): void => settle(new Error("Settings quit drain timed out"));
    const onAck = (event: IpcMainEvent, value: unknown): void => {
      if (
        settingsWindow !== win ||
        win.isDestroyed() ||
        contents.isDestroyed() ||
        event.sender !== contents ||
        event.senderFrame !== contents.mainFrame ||
        event.senderFrame.parent !== null ||
        typeof value !== "object" ||
        value === null ||
        !("requestId" in value) ||
        value.requestId !== request.requestId ||
        !("status" in value)
      )
        return;
      if (value.status === "failed") {
        settle(new Error("Settings renderer save failed during quit drain"));
      } else if (value.status === "saved") {
        settle();
      }
    };
    ipcMain.on(SETTINGS_QUIT_DRAIN_ACK, onAck);
    contents.once("destroyed", onDestroyed);
    win.once("closed", onDestroyed);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      contents.send(SETTINGS_QUIT_DRAIN_REQUEST, request);
    } catch (error) {
      settle(error instanceof Error ? error : new Error("Settings quit drain send failed"));
    }
  });
}

/**
 * Force-destroy the settings window (quit / composition cleanup).
 * Does not leave a warm cache entry.
 */
export function closeSettingsWindow(): void {
  const win = settingsWindow;
  destroyCachedUtilityWindow(win, "settings", () => {
    settingsWindow = null;
  });
}

// --- About (built renderer entry) ---

/**
 * Creates or focuses the About window (singleton, warm-cached after first open).
 * Shared secure webPreferences + preload; content is the about renderer entry.
 * User close hides the window; quit destroys it.
 */
export function showAbout(_mainWindow?: BrowserWindow): void {
  setWantsVisible("about", true);

  if (aboutWindow !== null && !aboutWindow.isDestroyed()) {
    presentCachedUtilityWindow(aboutWindow, "about");
    return;
  }

  const win = new BrowserWindow({
    width: ABOUT_WINDOW_WIDTH,
    height: ABOUT_WINDOW_HEIGHT,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    show: false,
    icon: getWindowIconPath(),
    ...aboutWindowChrome(),
    webPreferences: createSecureWebPreferences({ preload: getPreloadScriptPath() }),
  });

  hardenWebContents(win);

  // Allow only the package repository URL (and its path under github.com).
  const repoUrl = getPackageInfo()
    .repository.replace(/\.git$/i, "")
    .replace(/\/$/, "");
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "github.com" &&
        (url === repoUrl || url.startsWith(`${repoUrl}/`))
      ) {
        void shell.openExternal(url);
      }
    } catch {
      // ignore invalid URLs
    }
    return { action: "deny" };
  });

  if (isDev) {
    void win.loadURL(`${getDevServerUrl()}/about.html`);
  } else {
    void win.loadFile(path.join(__dirname, "..", "renderer", "about.html"));
  }

  win.once("ready-to-show", () => {
    // May no-op if the user dismissed before first paint (wantsVisible=false).
    presentCachedUtilityWindow(win, "about");
  });

  win.on("close", (event) => {
    if (aboutAllowDestroy) {
      return;
    }
    event.preventDefault();
    hideCachedUtilityWindow(win, "about");
  });

  win.on("closed", () => {
    if (aboutWindow === win) {
      aboutWindow = null;
    }
    setWantsVisible("about", false);
    if (aboutHeldForeground) {
      releaseUtilityForeground();
      aboutHeldForeground = false;
    }
  });

  aboutWindow = win;
}

/**
 * Force-destroy the About window (quit / composition cleanup).
 * Does not leave a warm cache entry.
 */
export function closeAboutWindow(): void {
  const win = aboutWindow;
  destroyCachedUtilityWindow(win, "about", () => {
    aboutWindow = null;
  });
}

// --- Aurora utility dialog (updater alerts; single-flight, hide-on-close warm cache) ---
//
// First present creates + loads the BrowserWindow (slow). User dismiss hides and keeps
// the renderer warm so the next present is apply-payload + show/focus only (fast).
// Quit / destroyAllWindows force-destroys via closeUtilityDialogWindow.
//
// Two lifetimes: a *shell* (BrowserWindow + the private handlers it registered) outlives
// many *presentations* (one request each, stamped with a main-owned, increasing id).
// Invokes count only from the cached shell's current main frame and only for the active
// presentation id. Shell callbacks (ready, load failure, closed) act only while their
// shell is current, so a discarded shell never touches state owned by its replacement.

/** One cached dialog BrowserWindow and the private IPC handlers it registered. */
interface UtilityDialogShell {
  readonly win: BrowserWindow;
  readonly contents: Electron.WebContents;
  /** First paint happened; re-present can skip waiting for ready-to-show. */
  ready: boolean;
  /** Private channels this shell registered (in order); only these are removed on teardown. */
  readonly ownedChannels: string[];
  /** Torn down (failure, external close, quit); its late callbacks are ignored. */
  retired: boolean;
}

/** One presentation (request). Concurrent callers share `promise` (first options win). */
interface UtilityDialogPresentation {
  readonly payload: UtilityDialogPayload;
  readonly promise: Promise<UtilityDialogResult>;
  readonly resolve: (result: UtilityDialogResult) => void;
  /** This presentation holds one utility-foreground reference. */
  holdsForeground: boolean;
}

let utilityDialogShell: UtilityDialogShell | null = null;
/**
 * Active (unsettled) presentation. Doubles as the user's intent to have the dialog
 * visible: a late ready-to-show after dismissal finds none and cannot re-show.
 */
let utilityDialogPresentation: UtilityDialogPresentation | null = null;
/** Last issued presentation id (main-owned, strictly increasing). */
let lastUtilityDialogPresentationId = 0;
/** When true, close is allowed to destroy (quit / composition cleanup). */
let utilityDialogAllowDestroy = false;

function normalizeUtilityDialogOptions(
  options: UtilityDialogOptions,
  presentationId: number,
): UtilityDialogPayload {
  const buttons = options.buttons.length > 0 ? options.buttons.slice(0, 3) : (["OK"] as string[]);
  const lastIndex = buttons.length - 1;
  const defaultId =
    typeof options.defaultId === "number" &&
    Number.isInteger(options.defaultId) &&
    options.defaultId >= 0 &&
    options.defaultId < buttons.length
      ? options.defaultId
      : lastIndex;
  const cancelId =
    typeof options.cancelId === "number" &&
    Number.isInteger(options.cancelId) &&
    options.cancelId >= 0 &&
    options.cancelId < buttons.length
      ? options.cancelId
      : 0;
  return {
    presentationId,
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons,
    defaultId,
    cancelId,
  };
}

/**
 * True only for an invoke from `shell`'s live WebContents *and* its current main frame,
 * while that shell is the cached one. Foreign contents, child frames, and missing,
 * detached, or destroyed frames are rejected.
 */
function isUtilityDialogSender(shell: UtilityDialogShell, event: IpcMainInvokeEvent): boolean {
  if (shell.retired || utilityDialogShell !== shell) {
    return false;
  }
  const { win, contents } = shell;
  if (win.isDestroyed() || contents.isDestroyed() || event.sender !== contents) {
    return false;
  }
  const frame = event.senderFrame;
  return (
    frame !== null &&
    frame === contents.mainFrame &&
    frame.parent === null &&
    !frame.detached &&
    !frame.isDestroyed()
  );
}

/** The active presentation when `presentationId` names it; otherwise the reply is stale. */
function activeUtilityDialogPresentation(
  presentationId: unknown,
): UtilityDialogPresentation | null {
  const presentation = utilityDialogPresentation;
  return presentation !== null && presentation.payload.presentationId === presentationId
    ? presentation
    : null;
}

function clampUtilityDialogHeight(height: number): number {
  if (!Number.isFinite(height)) {
    return UTILITY_DIALOG_HEIGHT;
  }
  return Math.min(
    UTILITY_DIALOG_MAX_HEIGHT,
    Math.max(UTILITY_DIALOG_MIN_HEIGHT, Math.ceil(height)),
  );
}

function acquirePresentationForeground(presentation: UtilityDialogPresentation): void {
  ensureUtilityDockIcon();
  if (!presentation.holdsForeground) {
    acquireUtilityForeground();
    presentation.holdsForeground = true;
  }
}

function releasePresentationForeground(presentation: UtilityDialogPresentation): void {
  if (presentation.holdsForeground) {
    presentation.holdsForeground = false;
    releaseUtilityForeground();
  }
}

/**
 * Settle `presentation` once: clear it, release only its foreground reference, and
 * resolve its callers (invalid indices map to the cancel button). No-op if already settled.
 */
function settleUtilityDialogPresentation(
  presentation: UtilityDialogPresentation,
  response: number,
  retire?: () => void,
): void {
  if (utilityDialogPresentation !== presentation) {
    return;
  }
  utilityDialogPresentation = null;
  const { payload } = presentation;
  try {
    releasePresentationForeground(presentation);
    retire?.();
  } finally {
    const safeResponse =
      Number.isInteger(response) && response >= 0 && response < payload.buttons.length
        ? response
        : payload.cancelId;
    presentation.resolve({ response: safeResponse, checkboxChecked: false });
  }
}

/**
 * Retire a shell: remove only the private handlers it registered, then destroy its
 * window. Every step is attempted; the first failure is rethrown afterwards.
 */
function teardownUtilityDialogShell(shell: UtilityDialogShell): void {
  shell.retired = true;
  shell.ready = false;
  if (utilityDialogShell === shell) {
    utilityDialogShell = null;
  }
  let firstError: unknown;
  for (const channel of shell.ownedChannels.splice(0)) {
    try {
      ipcMain.removeHandler(channel);
    } catch (error) {
      firstError ??= error;
    }
  }
  try {
    if (!shell.win.isDestroyed()) {
      shell.win.destroy();
    }
  } catch (error) {
    firstError ??= error;
  }
  if (firstError !== undefined) throw firstError;
}

/**
 * The shell failed (main-frame load rejected): cancel the presentation it carried and
 * discard it so a later presentation builds a fresh one. Never throws (async callback).
 */
function failUtilityDialogShell(shell: UtilityDialogShell): void {
  if (shell.retired || utilityDialogShell !== shell) {
    return;
  }
  const presentation = utilityDialogPresentation;
  try {
    teardownUtilityDialogShell(shell);
  } catch {
    // Best effort: the shell is already out of the registry and marked retired.
  }
  if (presentation !== null) {
    try {
      settleUtilityDialogPresentation(presentation, presentation.payload.cancelId);
    } catch {
      // The presentation is settled even if releasing its foreground failed.
    }
  }
}

/**
 * Push the active payload into a ready shell, reset its height for re-measure, and
 * bring it forward. No-ops unless `presentation` is still the active one.
 */
function showUtilityDialogPresentation(
  shell: UtilityDialogShell,
  presentation: UtilityDialogPresentation,
): void {
  const { win, contents } = shell;
  if (
    shell.retired ||
    !shell.ready ||
    win.isDestroyed() ||
    utilityDialogPresentation !== presentation
  ) {
    return;
  }
  acquirePresentationForeground(presentation);
  try {
    win.setContentSize(UTILITY_DIALOG_WIDTH, UTILITY_DIALOG_HEIGHT, false);
  } catch {
    // Size can fail if the window is mid-destroy.
  }
  if (!contents.isDestroyed()) {
    const message: UtilityDialogApplyMessage = { kind: "present", payload: presentation.payload };
    contents.send(UTILITY_DIALOG_APPLY, message);
  }
  if (!win.isVisible()) {
    win.show();
  }
  win.focus();
  try {
    app.focus({ steal: true });
  } catch {
    // focus can fail in headless / test environments
  }
}

/**
 * Button or native Close dismissal: settle the presentation, retire it in the warm
 * renderer through APPLY (so its late keyboard, height, and animation work stays
 * inert), and hide the shell for reuse.
 */
function dismissUtilityDialog(
  shell: UtilityDialogShell,
  presentation: UtilityDialogPresentation,
  response: number,
): void {
  settleUtilityDialogPresentation(presentation, response, () => {
    const { win, contents } = shell;
    try {
      if (!contents.isDestroyed()) {
        const message: UtilityDialogApplyMessage = {
          kind: "retire",
          presentationId: presentation.payload.presentationId,
        };
        contents.send(UTILITY_DIALOG_APPLY, message);
      }
    } catch {
      // Main stays authoritative: replies for a settled presentation are ignored anyway.
    }
    if (!win.isDestroyed() && win.isVisible()) {
      win.hide();
    }
  });
}

/**
 * Register the private handlers for `shell`. Throws on the first failure, leaving
 * `shell.ownedChannels` listing exactly what this shell registered for rollback.
 */
function registerUtilityDialogHandlers(shell: UtilityDialogShell): void {
  const handlers: readonly (readonly [
    string,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ])[] = [
    [
      UTILITY_DIALOG_GET_PAYLOAD,
      (event) => {
        const presentation = utilityDialogPresentation;
        if (!isUtilityDialogSender(shell, event) || presentation === null) {
          throw new Error("[utility-dialog] No active dialog payload");
        }
        return presentation.payload;
      },
    ],
    [
      UTILITY_DIALOG_RESPOND,
      (event, presentationId, response) => {
        if (!isUtilityDialogSender(shell, event)) {
          throw new Error("[utility-dialog] Invalid sender");
        }
        // A reply for a dismissed presentation must never dismiss its successor.
        const presentation = activeUtilityDialogPresentation(presentationId);
        if (presentation === null) {
          return;
        }
        dismissUtilityDialog(
          shell,
          presentation,
          typeof response === "number" ? response : Number.NaN,
        );
      },
    ],
    [
      UTILITY_DIALOG_SET_HEIGHT,
      (event, presentationId, height) => {
        if (!isUtilityDialogSender(shell, event)) {
          throw new Error("[utility-dialog] Invalid sender");
        }
        // A height measured for a dismissed presentation must never resize its successor.
        if (activeUtilityDialogPresentation(presentationId) === null || shell.win.isDestroyed()) {
          return;
        }
        const next = clampUtilityDialogHeight(typeof height === "number" ? height : Number.NaN);
        shell.win.setContentSize(UTILITY_DIALOG_WIDTH, next, false);
      },
    ],
  ];
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, handler);
    shell.ownedChannels.push(channel);
  }
}

function createUtilityDialogShell(): UtilityDialogShell {
  const win = new BrowserWindow({
    width: UTILITY_DIALOG_WIDTH,
    height: UTILITY_DIALOG_HEIGHT,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: true,
    alwaysOnTop: true,
    show: false,
    icon: getWindowIconPath(),
    ...utilityDialogWindowChrome(),
    webPreferences: createSecureWebPreferences({
      preload: getUtilityDialogPreloadPath(),
    }),
  });
  const shell: UtilityDialogShell = {
    win,
    contents: win.webContents,
    ready: false,
    ownedChannels: [],
    retired: false,
  };

  try {
    hardenWebContents(win);
    registerUtilityDialogHandlers(shell);
  } catch (error) {
    // Partial registration: roll back only this shell's handlers and discard its window.
    try {
      teardownUtilityDialogShell(shell);
    } catch {
      // The registration failure is the one worth reporting.
    }
    throw error;
  }
  utilityDialogShell = shell;

  win.once("ready-to-show", () => {
    if (shell.retired || utilityDialogShell !== shell || win.isDestroyed()) {
      return;
    }
    shell.ready = true;
    // No active presentation means the user dismissed before first paint.
    const presentation = utilityDialogPresentation;
    if (presentation !== null) {
      showUtilityDialogPresentation(shell, presentation);
    }
  });

  // User close (traffic light / caption) → hide + settle cancel (warm cache).
  win.on("close", (event) => {
    if (utilityDialogAllowDestroy || shell.retired) {
      return;
    }
    event.preventDefault();
    const presentation = utilityDialogPresentation;
    if (presentation !== null) {
      dismissUtilityDialog(shell, presentation, presentation.payload.cancelId);
    } else if (!win.isDestroyed() && win.isVisible()) {
      win.hide();
    }
  });

  win.on("closed", () => {
    // Shells we tore down ourselves own nothing any more (their replacement might).
    if (shell.retired) {
      return;
    }
    // Closed externally: discard this shell and cancel the presentation it carried.
    const presentation = utilityDialogPresentation;
    try {
      teardownUtilityDialogShell(shell);
    } finally {
      if (presentation !== null) {
        settleUtilityDialogPresentation(presentation, presentation.payload.cancelId);
      }
    }
  });

  const load = isDev
    ? win.loadURL(`${getDevServerUrl()}/utility-dialog.html`)
    : win.loadFile(path.join(__dirname, "..", "renderer", "utility-dialog.html"));
  void load.catch(() => {
    failUtilityDialogShell(shell);
  });

  return shell;
}

/** The cached shell if still alive; one destroyed behind our back is discarded first. */
function reusableUtilityDialogShell(): UtilityDialogShell | null {
  const shell = utilityDialogShell;
  if (shell === null) {
    return null;
  }
  if (!shell.win.isDestroyed() && !shell.contents.isDestroyed()) {
    return shell;
  }
  teardownUtilityDialogShell(shell);
  return null;
}

/**
 * Present a single-flight aurora utility dialog (Check for Updates, etc.).
 * First open creates + loads the shell; later opens re-apply payload + show (warm cache).
 * Concurrent calls share the in-flight promise; the first caller's options win.
 */
export function presentUtilityDialog(options: UtilityDialogOptions): Promise<UtilityDialogResult> {
  const active = utilityDialogPresentation;
  if (active !== null) {
    return active.promise;
  }

  lastUtilityDialogPresentationId += 1;
  const payload = normalizeUtilityDialogOptions(options, lastUtilityDialogPresentationId);
  const { promise, resolve } = Promise.withResolvers<UtilityDialogResult>();
  const presentation: UtilityDialogPresentation = {
    payload,
    promise,
    resolve,
    holdsForeground: false,
  };
  utilityDialogPresentation = presentation;

  try {
    const shell = reusableUtilityDialogShell() ?? createUtilityDialogShell();
    // Acquire before first paint so tray-only apps surface the Dock while the shell loads.
    acquirePresentationForeground(presentation);
    // A loading shell presents from ready-to-show instead.
    showUtilityDialogPresentation(shell, presentation);
  } catch {
    try {
      settleUtilityDialogPresentation(presentation, payload.cancelId);
    } catch {
      // Settled with the cancel result even if releasing its foreground failed.
    }
  }

  return promise;
}

/**
 * Force-destroy the utility dialog shell (quit / composition cleanup).
 * Resolves any waiter with the cancel button index.
 */
export function closeUtilityDialogWindow(): void {
  utilityDialogAllowDestroy = true;
  let firstError: unknown;
  try {
    const presentation = utilityDialogPresentation;
    if (presentation !== null) {
      try {
        settleUtilityDialogPresentation(presentation, presentation.payload.cancelId);
      } catch (error) {
        firstError ??= error;
      }
    }
    const shell = utilityDialogShell;
    if (shell !== null) {
      try {
        teardownUtilityDialogShell(shell);
      } catch (error) {
        firstError ??= error;
      }
    }
  } finally {
    utilityDialogAllowDestroy = false;
  }
  if (firstError !== undefined) throw firstError;
}

/**
 * Destroy all tracked windows. Used on quit after composition cleanup.
 * Utility windows and popover use destroy() so hide-on-close cannot prevent teardown.
 */
export function destroyAllWindows(): void {
  cancelPendingPopoverHide();
  let firstError: unknown;
  for (const closeWindow of [closeUtilityDialogWindow, closeSettingsWindow, closeAboutWindow]) {
    try {
      closeWindow();
    } catch (err) {
      firstError ??= err;
    }
  }
  const win = popoverWindow;
  popoverWindow = null;
  try {
    if (win !== null && !win.isDestroyed()) {
      win.destroy();
    }
  } catch (err) {
    firstError ??= err;
  }
  if (firstError !== undefined) throw firstError;
}
