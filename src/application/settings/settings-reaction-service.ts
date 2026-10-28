import type { AppSettings } from "../../domain/settings/app-settings.js";
import { settingsFieldEqual } from "../../domain/settings/app-settings.js";
import type { AutoLaunchPort } from "../ports/auto-launch.port.js";
import type { MainToRendererNotifierPort } from "../ports/main-to-renderer-notifier.port.js";
import type { LoggerPort } from "../ports/logger.port.js";

/** Fields the popover/settings UI actually displays. */
export const RENDERER_VISIBLE_SETTINGS_KEYS: readonly (keyof AppSettings)[] = [
  "preventSleep",
  "batteryThreshold",
  "shortcut",
  "quickSessionDurations",
] as const;

export type SettingsReactionHandler = (
  settings: AppSettings,
  prev: AppSettings | null,
) => void;

export interface SettingsReactionService {
  handleChange: SettingsReactionHandler;
}

export interface SettingsReactionServiceDeps {
  recomputeSleepPrevention: (userIntentOverride?: boolean) => void;
  autoLaunch: AutoLaunchPort;
  isPreventingSleep: () => boolean;
  getSessionActive: () => boolean;
  reconfigureBattery: () => void;
  registerShortcut: () => void;
  reconcileSession: () => void;
  notifier: MainToRendererNotifierPort;
  logger: LoggerPort;
  logTag?: string;
}

/**
 * Sole owner of settings field-diff reactions (KD-15).
 * Subscribe once to SettingsStorePort.onChange; never also react inside UpdateSettings.
 */
export function createSettingsReactionService(
  deps: SettingsReactionServiceDeps,
): SettingsReactionService {
  const tag = deps.logTag ?? "[settings-reactions]";

  const handleChange: SettingsReactionHandler = (settings, prevSettings) => {
    try {
      if (prevSettings !== null) {
        const keys = Object.keys(settings) as (keyof AppSettings)[];
        let changed = false;
        for (const key of keys) {
          if (!settingsFieldEqual(settings, prevSettings, key)) {
            changed = true;
            break;
          }
        }
        if (!changed) return;
      }

      deps.reconcileSession();

      if (!prevSettings || settings.preventSleep !== prevSettings.preventSleep) {
        deps.recomputeSleepPrevention(settings.preventSleep);
      }
      if (!prevSettings || settings.launchAtLogin !== prevSettings.launchAtLogin) {
        deps.autoLaunch.sync(settings.launchAtLogin);
      }
      if (!prevSettings || settings.batteryThreshold !== prevSettings.batteryThreshold) {
        deps.reconfigureBattery();
      }
      if (!prevSettings || settings.sleepBlockMode !== prevSettings.sleepBlockMode) {
        if (
          deps.isPreventingSleep() ||
          settings.preventSleep ||
          deps.getSessionActive()
        ) {
          deps.recomputeSleepPrevention(settings.preventSleep);
        }
      }
      if (prevSettings && settings.shortcut !== prevSettings.shortcut) {
        deps.registerShortcut();
      }

      const hasRendererChange =
        prevSettings === null ||
        RENDERER_VISIBLE_SETTINGS_KEYS.some(
          (k) => !settingsFieldEqual(settings, prevSettings, k),
        );
      if (hasRendererChange) {
        deps.notifier.publish({ type: "settings-changed", settings });
      }
    } catch (err) {
      deps.logger.error(`${tag} Settings subscriber error:`, err);
    }
  };

  return { handleChange };
}
