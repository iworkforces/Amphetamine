import { Tray, nativeTheme, Menu, app, type MenuItemConstructorOptions } from "electron/main";
import { nativeImage } from "electron/common";
import log from "electron-log";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { showAbout as openAboutWindow } from "./about-window.js";

import {
  ACCELERATOR_QUIT,
  MENU_ABOUT,
  MENU_CHECK_UPDATES,
  MENU_PREVENT_SLEEP,
  MENU_QUIT,
  MENU_SETTINGS,
  TRAY_ICON_COLOR_ACTIVE,
  TRAY_ICON_COLOR_INACTIVE,
  TRAY_ICON_SIZE,
} from "./constants.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let cachedMenu: Menu | null = null;
let themeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function tooltipForState(effectiveActive: boolean, sessionActive: boolean): string {
  if (sessionActive) {
    return effectiveActive
      ? "Amphetamine — Session active (preventing sleep)"
      : "Amphetamine — Session active";
  }
  return effectiveActive ? "Amphetamine — Preventing sleep" : "Amphetamine — Sleep prevention off";
}

/**
 * Module-scope SVG fallback icon — built once, reused on every cache miss.
 * Avoids re-allocating the SVG buffer per failed icon load.
 */
const FALLBACK_SVG_SIZE = TRAY_ICON_SIZE;
const fallbackIconDark = nativeImage.createFromBuffer(
  Buffer.from(
    `<svg width="${FALLBACK_SVG_SIZE}" height="${FALLBACK_SVG_SIZE}" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="${FALLBACK_SVG_SIZE / 2}" cy="${FALLBACK_SVG_SIZE / 2}" r="${FALLBACK_SVG_SIZE / 2 - 1}" fill="${TRAY_ICON_COLOR_ACTIVE}"/></svg>`,
  ),
);
const fallbackIconLight = nativeImage.createFromBuffer(
  Buffer.from(
    `<svg width="${FALLBACK_SVG_SIZE}" height="${FALLBACK_SVG_SIZE}" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="${FALLBACK_SVG_SIZE / 2}" cy="${FALLBACK_SVG_SIZE / 2}" r="${FALLBACK_SVG_SIZE / 2 - 1}" fill="${TRAY_ICON_COLOR_INACTIVE}"/></svg>`,
  ),
);

function showAbout(): void {
  openAboutWindow();
}

/**
 * Cached tray icons — only 4 variants (dark/light × active/inactive).
 * Avoids rebuilding from disk on every theme/settings change.
 */
const iconCache = new Map<string, Electron.NativeImage>();

export interface TrayDeps {
  getPreventSleep: () => boolean;
  /**
   * Effective sleep-prevention active state used to drive the tray icon.
   * Computed by composition as (settings.preventSleep || sessionActive).
   * The menu checkbox still mirrors user intent via getPreventSleep().
   */
  getEffectiveActive: () => boolean;
  /** Live session running (for tooltip / optional menu). */
  getSessionActive: () => boolean;
  togglePreventSleep: () => void;
  onSettingsChanged: (callback: () => void) => () => void;
  /**
   * Notifies the tray when the effective active state changes for reasons other
   * than a settings update (e.g., a session starting or expiring without any
   * user-intent change). Used to refresh the tray icon without rebuilding the menu.
   */
  onActiveStateChanged: (callback: () => void) => () => void;
  openSettings: () => void;
  checkForUpdates: () => void;
  cancelSession?: () => void;
}

export function setupTray(deps: TrayDeps): () => void {
  // In dev:      __dirname = lib/main/   → ../../src/assets
  // In packaged: __dirname = app.asar/lib/main/ → ../../src/assets (inside asar)
  //
  // IMPORTANT: use nativeImage.createFromPath() — it understands asar virtual paths.
  // fs.readFileSync() does NOT resolve asar paths in the main process and will throw,
  // which silently prevents the tray from ever being created.
  const assetsDir = path.join(__dirname, "..", "..", "src", "assets");

  function buildIcon(isDark: boolean, isActive: boolean): Electron.NativeImage {
    const key = `${isDark}-${isActive}`;
    const cached = iconCache.get(key);
    if (cached) return cached;

    const suffix = isDark ? "dark" : "light";
    const statePrefix = isActive ? "" : "inactive-";
    const icon1x = nativeImage.createFromPath(
      path.join(assetsDir, `tray-icon-${statePrefix}${suffix}.png`),
    );
    const icon2x = nativeImage.createFromPath(
      path.join(assetsDir, `tray-icon-${statePrefix}${suffix}@2x.png`),
    );
    // Fall back to a programmatic icon if image files are missing or corrupted
    if (icon1x.isEmpty() || icon2x.isEmpty()) {
      log.warn("[tray] Tray icon files missing or corrupted, using fallback");
      return isDark ? fallbackIconDark : fallbackIconLight;
    }
    const icon = nativeImage.createEmpty();
    icon.addRepresentation({ scaleFactor: 1.0, buffer: icon1x.toPNG() });
    icon.addRepresentation({ scaleFactor: 2.0, buffer: icon2x.toPNG() });

    iconCache.set(key, icon);
    return icon;
  }

  function refreshTrayIcon(): void {
    if (!tray) return;
    const effective = deps.getEffectiveActive();
    tray.setImage(buildIcon(nativeTheme.shouldUseDarkColors, effective));
    tray.setToolTip(tooltipForState(effective, deps.getSessionActive()));
  }

  const initialPreventSleep = deps.getPreventSleep();
  const initialEffectiveActive = deps.getEffectiveActive();
  let unsubscribeSettings: (() => void) | null = null;
  let unsubscribeActiveState: (() => void) | null = null;
  let themeRegistered = false;
  let disposed = false;

  // Update icon whenever the system theme changes or settings change (debounced)
  const onThemeUpdated = (): void => {
    if (disposed) return;
    if (themeDebounceTimer) clearTimeout(themeDebounceTimer);
    themeDebounceTimer = setTimeout(() => {
      themeDebounceTimer = null;
      if (!disposed) refreshTrayIcon();
    }, 50);
  };

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    for (const release of [unsubscribeSettings, unsubscribeActiveState]) {
      try {
        release?.();
      } catch (err) {
        log.error("[tray] Failed to unsubscribe:", err);
      }
    }
    if (themeRegistered) {
      try {
        nativeTheme.removeListener("updated", onThemeUpdated);
      } catch (err) {
        log.error("[tray] Failed to remove theme listener:", err);
      }
    }
    if (themeDebounceTimer) {
      clearTimeout(themeDebounceTimer);
      themeDebounceTimer = null;
    }
    const currentTray = tray;
    tray = null;
    cachedMenu = null;
    iconCache.clear();
    if (currentTray !== null) {
      try {
        currentTray.destroy();
      } catch (err) {
        log.error("[tray] Failed to destroy tray:", err);
      }
    }
  };

  // Store unsubscribes for cleanup robustness.
  // Track BOTH user intent (drives menu checkbox + cache rebuild) and effective
  // active state (drives icon) so each updates only when its own input changes.
  let lastPreventSleep = initialPreventSleep;
  let lastEffectiveActive = initialEffectiveActive;
  let lastSessionActive = false;

  try {
    tray = new Tray(buildIcon(nativeTheme.shouldUseDarkColors, initialEffectiveActive));
    tray.setToolTip(tooltipForState(initialEffectiveActive, deps.getSessionActive()));
    themeRegistered = true;
    nativeTheme.on("updated", onThemeUpdated);
    lastSessionActive = deps.getSessionActive();
    unsubscribeSettings = deps.onSettingsChanged(() => {
      if (disposed) return;
      const currentPreventSleep = deps.getPreventSleep();
      const currentEffectiveActive = deps.getEffectiveActive();
      let iconNeedsRefresh = false;
      if (currentEffectiveActive !== lastEffectiveActive) {
        lastEffectiveActive = currentEffectiveActive;
        iconNeedsRefresh = true;
      }
      if (currentPreventSleep !== lastPreventSleep) {
        lastPreventSleep = currentPreventSleep;
        cachedMenu = buildMenu();
        tray?.setContextMenu(cachedMenu);
        iconNeedsRefresh = true;
      }
      if (iconNeedsRefresh) {
        refreshTrayIcon();
      }
    });
    unsubscribeActiveState = deps.onActiveStateChanged(() => {
      if (disposed) return;
      // Effective active / session can change without settings change.
      // Refresh icon + tooltip; rebuild menu only when session presence flips
      // (Cancel session item).
      const currentEffectiveActive = deps.getEffectiveActive();
      const sessionActive = deps.getSessionActive();
      if (currentEffectiveActive !== lastEffectiveActive) {
        lastEffectiveActive = currentEffectiveActive;
        refreshTrayIcon();
      } else {
        tray?.setToolTip(tooltipForState(currentEffectiveActive, sessionActive));
      }
      if (sessionActive !== lastSessionActive) {
        lastSessionActive = sessionActive;
        cachedMenu = buildMenu();
        tray?.setContextMenu(cachedMenu);
      }
    });

    function buildMenu(): Menu {
      const preventSleep = deps.getPreventSleep();
      const sessionActive = deps.getSessionActive();

      const template: MenuItemConstructorOptions[] = [
        {
          label: MENU_PREVENT_SLEEP,
          type: "checkbox",
          checked: preventSleep,
          click: () => {
            deps.togglePreventSleep();
          },
        },
        { type: "separator" },
      ];
      if (sessionActive && deps.cancelSession !== undefined) {
        template.push({
          label: "Cancel session",
          click: () => {
            deps.cancelSession?.();
          },
        });
        template.push({ type: "separator" });
      }
      template.push(
        { label: MENU_SETTINGS, click: () => deps.openSettings() },
        { label: MENU_ABOUT, click: () => showAbout() },
        { label: MENU_CHECK_UPDATES, click: () => deps.checkForUpdates() },
        { label: MENU_QUIT, accelerator: ACCELERATOR_QUIT, click: () => app.quit() },
      );
      return Menu.buildFromTemplate(template);
    }

    cachedMenu = buildMenu();
    // Classic tray menu: setContextMenu so OS left/right click show menu items.
    // Explicit click handler keeps left-click reliable across macOS/Windows.
    tray.setContextMenu(cachedMenu);
    // Windows: avoid double-click firing click twice (opens menu then dismisses).
    tray.setIgnoreDoubleClickEvents(true);

    tray.on("click", () => {
      if (tray !== null && cachedMenu !== null) {
        tray.popUpContextMenu(cachedMenu);
      }
    });
    return cleanup;
  } catch (err) {
    cleanup();
    throw err;
  }
}

export function measureBenchmarkTrayMenuProxy(): number | null {
  if (tray === null || cachedMenu === null) return null;
  const started = performance.now();
  tray.popUpContextMenu(cachedMenu);
  return performance.now() - started;
}
