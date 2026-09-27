/**
 * Composition root — outermost production wiring (not a CA layer).
 * Builds ports, use cases, session timer, reactions; exposes IPC/tray deps + cleanup.
 * No Partial overrides — tests use lower-level factories (KD-21).
 */
import log from "electron-log";
import { powerMonitor } from "electron/main";
import type { AppSettings } from "../shared/types.js";
import { initSettings, getSettings, getSettingsStore, onSettingsChanged } from "./settings.js";
import { getAutoLaunchPort } from "./auto-launch.js";
import {
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  type ShortcutDeps,
} from "./global-shortcut.js";
import { isPreventingSleep, stopPreventingSleep, getSleepBlockerPort } from "./sleep-prevention.js";
import { createBatteryMonitor, type BatteryMonitorHandle } from "./battery-monitor.js";
import { createSessionTimer, type SessionTimerHandle } from "./session-timer.js";
import type { TrayDeps } from "./tray.js";
import { createSettingsWindow, closeSettingsWindow } from "./settings-window.js";
import { closeAboutWindow } from "./about-window.js";
import { registerAutoUpdaterIpc } from "./auto-updater.js";
import { presentUtilityDialog } from "./process/window-graph.js";
import { getPackageInfo } from "./utils/packageInfo.js";
import { createRecomputeSleepPrevention } from "../application/sleep/recompute-sleep-prevention.js";
import { createTogglePreventSleep } from "../application/sleep/toggle-prevent-sleep.js";
import { createHandleLowBatteryAutoStop } from "../application/battery/handle-low-battery-auto-stop.js";
import { createGetSettings } from "../application/settings/get-settings.js";
import { createUpdateSettings } from "../application/settings/update-settings.js";
import { createSettingsReactionService } from "../application/settings/settings-reaction-service.js";
import { createElectronLogger } from "../infrastructure/logging/electron-logger.js";
import { createBroadcastNotifier } from "../infrastructure/notification/broadcast-notifier.js";
import { createOsUserNotifier } from "../infrastructure/notification/os-user-notifier.js";
import { createElectronUpdaterPort } from "../infrastructure/updater/electron-updater-port.js";
import { broadcastToWindows } from "./utils/broadcast.js";
import type { IpcDeps } from "./ipc.js";

export interface AppComposition {
  /** Initialize settings, session, battery, reactions, shortcut. Call before IPC/tray. */
  init(): Promise<void>;
  /** Start hybrid auto-updater (packaged builds only; no-op in benchmark via AppShell). */
  initUpdater(): void;
  /** Ordered cleanup (settings/about windows → reactions → battery → session → sleep → shortcut → updater). */
  cleanup(): void;
  getIpcDeps(): IpcDeps;
  getTrayDeps(): TrayDeps;
  /** True after successful init until cleanup. */
  readonly ready: boolean;
}

/**
 * Create a production composition instance (full factory only — no overrides).
 */
export function createAppComposition(): AppComposition {
  let prevSettings: AppSettings | null = null;
  let shortcutDeps: ShortcutDeps | null = null;
  let unsubscribeSettings: (() => void) | null = null;
  let sessionTimer: SessionTimerHandle | null = null;
  let batteryMonitor: BatteryMonitorHandle | null = null;
  let sessionActiveCache = false;
  let effectiveActive = false;
  let ready = false;
  let closing = false;
  let initOperation: Promise<void> | null = null;
  const isClosing = (): boolean => closing;
  const effectiveActiveListeners = new Set<() => void>();

  const logger = createElectronLogger();
  const notifier = createBroadcastNotifier(broadcastToWindows);
  const userNotifier = createOsUserNotifier(logger);
  let lastBatteryPercent: number | null = null;
  const updaterPort = createElectronUpdaterPort(notifier, {
    getRepositoryUrl: () => getPackageInfo().repository,
    // Aurora utility dialog (WindowGraph) — acquires/releases its own foreground ref.
    showUserDialog: (options) => presentUtilityDialog(options),
    notifyUser: (message) => {
      userNotifier.notify(message);
    },
  });

  const notifyEffectiveActiveChange = (next: boolean): void => {
    if (next === effectiveActive) return;
    effectiveActive = next;
    for (const listener of effectiveActiveListeners) {
      try {
        listener();
      } catch (err) {
        log.error("[composition] effective-active listener threw:", err);
      }
    }
  };

  const recomputeSleepPrevention = createRecomputeSleepPrevention({
    getUserIntent: () => getSettings().preventSleep,
    getSessionActive: () => sessionActiveCache,
    getSleepBlockMode: () => getSettings().sleepBlockMode,
    sleepBlocker: getSleepBlockerPort(),
    onPreventSleepChange: (active) => {
      batteryMonitor?.onPreventSleepChange(active);
    },
    onEffectiveActiveChange: (active) => {
      notifyEffectiveActiveChange(active);
    },
  });

  const togglePreventSleep = createTogglePreventSleep({
    store: getSettingsStore(),
    logger,
    logTag: "[composition]",
  });

  const handleLowBatteryAutoStop = createHandleLowBatteryAutoStop({
    store: getSettingsStore(),
    cancelSession: () => {
      sessionTimer?.cancelSession();
    },
    logger,
    userNotifier,
    getLastKnownPercent: () => lastBatteryPercent,
    logTag: "[composition]",
  });

  const getSettingsUc = createGetSettings(getSettingsStore());
  const updateSettingsUc = createUpdateSettings(getSettingsStore());

  const requireSessionTimer = (): SessionTimerHandle => {
    if (sessionTimer === null) {
      throw new Error(
        "[composition] Session timer not ready. Call composition.init() before session IPC.",
      );
    }
    return sessionTimer;
  };

  const init = (): Promise<void> => {
    if (closing) return Promise.resolve();
    if (initOperation !== null) return initOperation;
    initOperation = (async () => {
      try {
        await initSettings();
        if (isClosing()) return;
        const settings = getSettings();
        prevSettings = { ...settings };

        getAutoLaunchPort().sync(settings.launchAtLogin);
        sessionActiveCache = false;
        effectiveActive = false;
        recomputeSleepPrevention();

        sessionTimer = createSessionTimer({
          broadcast: broadcastToWindows,
          onSessionActiveChange: (active) => {
            sessionActiveCache = active;
            recomputeSleepPrevention();
          },
          powerMonitor,
        });

        batteryMonitor = createBatteryMonitor({
          getThreshold: () => getSettings().batteryThreshold,
          onAutoStop: handleLowBatteryAutoStop,
          isPreventingSleep,
          onPercentSample: (percent) => {
            lastBatteryPercent = percent;
          },
        });
        void batteryMonitor
          .initBatteryMonitoring()
          .catch((err) => log.error("[composition] Battery init failed:", err));

        shortcutDeps = {
          getShortcut: () => getSettings().shortcut,
          getPreventSleep: () => getSettings().preventSleep,
          togglePreventSleep,
        };
        registerGlobalShortcut(shortcutDeps);

        const reactions = createSettingsReactionService({
          recomputeSleepPrevention,
          autoLaunch: getAutoLaunchPort(),
          isPreventingSleep,
          getSessionActive: () => sessionActiveCache,
          reconfigureBattery: () => {
            batteryMonitor?.reconfigure();
          },
          registerShortcut: () => {
            if (shortcutDeps) {
              registerGlobalShortcut(shortcutDeps);
            }
          },
          reconcileSession: () => {
            sessionTimer?.reconcileSessionState();
          },
          notifier,
          logger,
          logTag: "[settings-reactions]",
        });

        unsubscribeSettings = onSettingsChanged((next: AppSettings) => {
          const prev = prevSettings;
          reactions.handleChange(next, prev);
          prevSettings = { ...next };
        });

        ready = true;
        log.info("[composition] Initialized");
      } catch (err) {
        cleanup();
        throw err;
      }
    })();
    return initOperation;
  };

  const cleanup = (): void => {
    if (closing) return;
    closing = true;
    ready = false;
    const disposers = [
      closeSettingsWindow,
      closeAboutWindow,
      () => unsubscribeSettings?.(),
      () => batteryMonitor?.cleanupBatteryMonitoring(),
      () => sessionTimer?.cleanup(),
      stopPreventingSleep,
      unregisterGlobalShortcut,
      () => updaterPort.stop(),
    ];
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (err) {
        log.error("[composition] Cleanup failed:", err);
      }
    }
    unsubscribeSettings = null;
    batteryMonitor = null;
    sessionTimer = null;
    sessionActiveCache = false;
    effectiveActive = false;
    effectiveActiveListeners.clear();
    prevSettings = null;
    shortcutDeps = null;
    log.info("[composition] Cleaned up");
  };

  const getIpcDeps = (): IpcDeps => ({
    getSettings: () => getSettingsUc(),
    updateSettings: (partial) => updateSettingsUc(partial),
    createSettingsWindow,
    registerAutoUpdaterIpc,
    sessionTimer: {
      startSession: (durationMinutes) => requireSessionTimer().startSession(durationMinutes),
      cancelSession: () => requireSessionTimer().cancelSession(),
      getStatus: () => requireSessionTimer().getStatus(),
    },
  });

  const getTrayDeps = (): TrayDeps => ({
    getPreventSleep: () => getSettings().preventSleep,
    getEffectiveActive: () => effectiveActive,
    getSessionActive: () => sessionActiveCache,
    togglePreventSleep,
    onSettingsChanged: (cb: () => void) =>
      onSettingsChanged((_settings) => {
        cb();
      }),
    onActiveStateChanged: (cb: () => void) => {
      effectiveActiveListeners.add(cb);
      return () => {
        effectiveActiveListeners.delete(cb);
      };
    },
    openSettings: () => createSettingsWindow(),
    checkForUpdates: () => updaterPort.checkNow(),
    cancelSession: () => {
      sessionTimer?.cancelSession();
    },
  });

  const initUpdater = (): void => {
    if (closing || !ready) return;
    updaterPort.init();
  };

  return {
    init,
    initUpdater,
    cleanup,
    getIpcDeps,
    getTrayDeps,
    get ready() {
      return ready;
    },
  };
}
