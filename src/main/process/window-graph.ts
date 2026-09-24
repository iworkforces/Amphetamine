/**
 * WindowGraph — owns every BrowserWindow in the main process.
 *
 * Process-model role: the only place that spawns renderer processes. Shared
 * secure webPreferences, navigation hardening, and singleton tracking live here.
 */
import { BrowserWindow, screen } from "electron/main";
import { nativeImage, shell } from "electron/common";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, ipcMain, type IpcMainInvokeEvent } from "electron/main";
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
  UTILITY_DIALOG_APPLY,
  UTILITY_DIALOG_GET_PAYLOAD,
  UTILITY_DIALOG_RESPOND,
  UTILITY_DIALOG_SET_HEIGHT,
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
 * Drop focus from form controls after warm-cache show.
 * Chromium restores the previous active element on BrowserWindow.show();
 * Settings should open without a focused switch/select (second+ open).
 */
function clearSettingsRendererFocus(win: BrowserWindow): void {
  // Defer past Chromium's focus-restore pass on show/focus.
  setTimeout(() => {
    if (win.isDestroyed() || !wantsVisible("settings") || !win.isVisible()) {
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
  if (kind === "settings") {
    clearSettingsRendererFocus(win);
  }
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
  return (
    settingsWindow !== null &&
    !settingsWindow.isDestroyed() &&
    settingsWindow.isVisible()
  );
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
  const repoUrl = getPackageInfo().repository.replace(/\.git$/i, "").replace(/\/$/, "");
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

let utilityDialogWindow: BrowserWindow | null = null;
let utilityDialogHeldForeground = false;
/** When true, close is allowed to destroy (quit / composition cleanup). */
let utilityDialogAllowDestroy = false;
/**
 * User intent to have the dialog visible. Cleared on hide/finish.
 * Guards late ready-to-show so a dismiss before first paint cannot re-show.
 */
let utilityDialogWantsVisible = false;
/** True after first did-finish-load / ready-to-show so re-present can skip load. */
let utilityDialogShellReady = false;
/** In-flight presentation; concurrent callers await the same result. */
let utilityDialogInFlight: Promise<UtilityDialogResult> | null = null;
let utilityDialogPayload: UtilityDialogPayload | null = null;
let utilityDialogResolve: ((result: UtilityDialogResult) => void) | null = null;
let utilityDialogHandlersRegistered = false;

function normalizeUtilityDialogOptions(options: UtilityDialogOptions): UtilityDialogPayload {
  const buttons =
    options.buttons.length > 0 ? options.buttons.slice(0, 3) : (["OK"] as string[]);
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
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons,
    defaultId,
    cancelId,
  };
}

function isUtilityDialogSender(event: IpcMainInvokeEvent): boolean {
  const win = utilityDialogWindow;
  if (win === null || win.isDestroyed()) {
    return false;
  }
  return event.sender.id === win.webContents.id;
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

function releaseUtilityDialogForeground(): void {
  if (utilityDialogHeldForeground) {
    releaseUtilityForeground();
    utilityDialogHeldForeground = false;
  }
}

function acquireUtilityDialogForeground(): void {
  ensureUtilityDockIcon();
  if (!utilityDialogHeldForeground) {
    acquireUtilityForeground();
    utilityDialogHeldForeground = true;
  }
}

/**
 * Push payload into the warm renderer and reset content height for re-measure.
 * No-ops if the shell is gone or not yet ready.
 */
function applyUtilityDialogPayload(win: BrowserWindow): void {
  if (win.isDestroyed() || utilityDialogPayload === null) {
    return;
  }
  try {
    win.setContentSize(UTILITY_DIALOG_WIDTH, UTILITY_DIALOG_HEIGHT, false);
  } catch {
    // Size can fail if the window is mid-destroy.
  }
  if (!win.webContents.isDestroyed()) {
    win.webContents.send(UTILITY_DIALOG_APPLY, utilityDialogPayload);
  }
}

function showUtilityDialogWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || !utilityDialogWantsVisible) {
    return;
  }
  acquireUtilityDialogForeground();
  applyUtilityDialogPayload(win);
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
 * Settle an in-flight presentation and hide (warm) or destroy (quit).
 * Safe to call twice: second call no-ops resolve.
 */
function finishUtilityDialog(response: number): void {
  const payload = utilityDialogPayload;
  const resolve = utilityDialogResolve;
  const win = utilityDialogWindow;
  const destroying = utilityDialogAllowDestroy;

  utilityDialogResolve = null;
  utilityDialogInFlight = null;
  utilityDialogWantsVisible = false;
  // Keep last payload only until hide completes; clear so getPayload fails when idle.
  utilityDialogPayload = null;

  releaseUtilityDialogForeground();

  if (destroying) {
    if (utilityDialogHandlersRegistered) {
      ipcMain.removeHandler(UTILITY_DIALOG_GET_PAYLOAD);
      ipcMain.removeHandler(UTILITY_DIALOG_RESPOND);
      ipcMain.removeHandler(UTILITY_DIALOG_SET_HEIGHT);
      utilityDialogHandlersRegistered = false;
    }
    utilityDialogShellReady = false;
    utilityDialogWindow = null;
    if (win !== null && !win.isDestroyed()) {
      win.destroy();
    }
  } else if (win !== null && !win.isDestroyed() && win.isVisible()) {
    win.hide();
  }

  if (resolve !== null) {
    const safeResponse =
      payload !== null &&
      Number.isInteger(response) &&
      response >= 0 &&
      response < payload.buttons.length
        ? response
        : (payload?.cancelId ?? 0);
    resolve({ response: safeResponse, checkboxChecked: false });
  }
}

function registerUtilityDialogHandlers(): void {
  if (utilityDialogHandlersRegistered) {
    return;
  }
  ipcMain.handle(UTILITY_DIALOG_GET_PAYLOAD, (event) => {
    if (!isUtilityDialogSender(event) || utilityDialogPayload === null) {
      throw new Error("[utility-dialog] No active dialog payload");
    }
    return utilityDialogPayload;
  });
  ipcMain.handle(UTILITY_DIALOG_RESPOND, (event, response: unknown) => {
    if (!isUtilityDialogSender(event)) {
      throw new Error("[utility-dialog] Invalid sender");
    }
    const index = typeof response === "number" ? response : Number.NaN;
    finishUtilityDialog(index);
  });
  ipcMain.handle(UTILITY_DIALOG_SET_HEIGHT, (event, height: unknown) => {
    if (!isUtilityDialogSender(event)) {
      throw new Error("[utility-dialog] Invalid sender");
    }
    const win = utilityDialogWindow;
    if (win === null || win.isDestroyed()) {
      return;
    }
    const next = clampUtilityDialogHeight(typeof height === "number" ? height : Number.NaN);
    win.setContentSize(UTILITY_DIALOG_WIDTH, next, false);
  });
  utilityDialogHandlersRegistered = true;
}

function createUtilityDialogShell(): BrowserWindow {
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

  hardenWebContents(win);
  utilityDialogWindow = win;
  utilityDialogShellReady = false;
  registerUtilityDialogHandlers();

  win.once("ready-to-show", () => {
    if (win.isDestroyed() || utilityDialogWindow !== win) {
      return;
    }
    utilityDialogShellReady = true;
    // May no-op if the user dismissed before first paint.
    showUtilityDialogWindow(win);
  });

  // User close (traffic light / caption) → hide + settle cancel (warm cache).
  win.on("close", (event) => {
    if (utilityDialogAllowDestroy) {
      return;
    }
    event.preventDefault();
    if (utilityDialogInFlight !== null) {
      const cancelId = utilityDialogPayload?.cancelId ?? 0;
      finishUtilityDialog(cancelId);
    } else if (!win.isDestroyed() && win.isVisible()) {
      win.hide();
      releaseUtilityDialogForeground();
      utilityDialogWantsVisible = false;
    }
  });

  win.on("closed", () => {
    if (utilityDialogWindow === win) {
      utilityDialogWindow = null;
    }
    utilityDialogShellReady = false;
    utilityDialogWantsVisible = false;
    releaseUtilityDialogForeground();
    // If destroy raced past finish, settle any waiter.
    if (utilityDialogResolve !== null) {
      const resolve = utilityDialogResolve;
      const cancelId = utilityDialogPayload?.cancelId ?? 0;
      utilityDialogResolve = null;
      utilityDialogInFlight = null;
      utilityDialogPayload = null;
      resolve({ response: cancelId, checkboxChecked: false });
    }
    if (utilityDialogHandlersRegistered) {
      ipcMain.removeHandler(UTILITY_DIALOG_GET_PAYLOAD);
      ipcMain.removeHandler(UTILITY_DIALOG_RESPOND);
      ipcMain.removeHandler(UTILITY_DIALOG_SET_HEIGHT);
      utilityDialogHandlersRegistered = false;
    }
  });

  if (isDev) {
    void win.loadURL(`${getDevServerUrl()}/utility-dialog.html`);
  } else {
    void win.loadFile(path.join(__dirname, "..", "renderer", "utility-dialog.html"));
  }

  return win;
}

/**
 * Present a single-flight aurora utility dialog (Check for Updates, etc.).
 * First open creates + loads the shell; later opens re-apply payload + show (warm cache).
 * Concurrent calls share the in-flight promise.
 */
export function presentUtilityDialog(
  options: UtilityDialogOptions,
): Promise<UtilityDialogResult> {
  if (utilityDialogInFlight !== null) {
    return utilityDialogInFlight;
  }

  const payload = normalizeUtilityDialogOptions(options);
  utilityDialogPayload = payload;
  utilityDialogWantsVisible = true;

  const inFlight = new Promise<UtilityDialogResult>((resolve) => {
    utilityDialogResolve = resolve;

    try {
      const existing = utilityDialogWindow;
      if (existing !== null && !existing.isDestroyed() && utilityDialogShellReady) {
        showUtilityDialogWindow(existing);
        return;
      }

      if (existing !== null && !existing.isDestroyed()) {
        // Shell still loading; ready-to-show will call showUtilityDialogWindow.
        acquireUtilityDialogForeground();
        return;
      }

      createUtilityDialogShell();
      // Acquire early so tray-only apps surface Dock while the shell loads.
      acquireUtilityDialogForeground();
    } catch {
      utilityDialogResolve = null;
      utilityDialogInFlight = null;
      utilityDialogPayload = null;
      utilityDialogWantsVisible = false;
      releaseUtilityDialogForeground();
      resolve({ response: payload.cancelId, checkboxChecked: false });
    }
  });

  if (utilityDialogResolve !== null) {
    utilityDialogInFlight = inFlight;
  }

  return inFlight;
}

/**
 * Force-destroy the utility dialog shell (quit / composition cleanup).
 * Resolves any waiter with the cancel button index.
 */
export function closeUtilityDialogWindow(): void {
  utilityDialogAllowDestroy = true;
  utilityDialogWantsVisible = false;

  if (utilityDialogInFlight !== null) {
    const cancelId = utilityDialogPayload?.cancelId ?? 0;
    finishUtilityDialog(cancelId);
  } else {
    releaseUtilityDialogForeground();
    if (utilityDialogHandlersRegistered) {
      ipcMain.removeHandler(UTILITY_DIALOG_GET_PAYLOAD);
      ipcMain.removeHandler(UTILITY_DIALOG_RESPOND);
      ipcMain.removeHandler(UTILITY_DIALOG_SET_HEIGHT);
      utilityDialogHandlersRegistered = false;
    }
    const win = utilityDialogWindow;
    utilityDialogWindow = null;
    utilityDialogShellReady = false;
    utilityDialogPayload = null;
    if (win !== null && !win.isDestroyed()) {
      win.destroy();
    }
  }

  utilityDialogAllowDestroy = false;
}

/**
 * Destroy all tracked windows. Used on quit after composition cleanup.
 * Utility windows and popover use destroy() so hide-on-close cannot prevent teardown.
 */
export function destroyAllWindows(): void {
  cancelPendingPopoverHide();
  closeUtilityDialogWindow();
  closeSettingsWindow();
  closeAboutWindow();
  if (popoverWindow !== null && !popoverWindow.isDestroyed()) {
    popoverWindow.destroy();
  }
  popoverWindow = null;
}
