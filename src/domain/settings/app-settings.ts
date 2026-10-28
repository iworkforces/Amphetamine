import type { SleepBlockMode } from "./sleep-block-mode.js";

/** Application settings */
export interface AppSettings {
  /** Whether to launch the app at login (auto-start on system restart) */
  launchAtLogin: boolean;
  /** Whether to prevent the system from sleeping (user intent) */
  preventSleep: boolean;
  /**
   * Default session duration preference in minutes (`null` = indefinite).
   * Preference only — runtime session state lives in the session timer, not settings.
   */
  defaultSessionDuration: number | null;
  quickSessionDurations: readonly number[];
  /** Battery threshold (0-100) — auto-stop sleep prevention when on battery below threshold. 0 = disabled */
  batteryThreshold: number;
  /**
   * Global keyboard shortcut to toggle sleep prevention
   * (e.g. CommandOrControl+Shift+A). Empty string = use default.
   */
  shortcut: string;
  /**
   * powerSaveBlocker type. `prevent-display-sleep` keeps the display on (default);
   * `prevent-app-suspension` allows the display to sleep while keeping the system awake.
   */
  sleepBlockMode: SleepBlockMode;
}

/** Default settings values */
export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  launchAtLogin: false,
  preventSleep: false,
  defaultSessionDuration: null,
  quickSessionDurations: Object.freeze([15, 30, 60, 120]),
  batteryThreshold: 0,
  shortcut: "",
  sleepBlockMode: "prevent-display-sleep",
};

export function cloneAppSettings(settings: AppSettings): AppSettings {
  return { ...settings, quickSessionDurations: [...settings.quickSessionDurations] };
}

export function settingsFieldEqual(
  first: AppSettings,
  second: AppSettings,
  key: keyof AppSettings,
): boolean {
  if (key !== "quickSessionDurations") return first[key] === second[key];
  return (
    first.quickSessionDurations.length === second.quickSessionDurations.length &&
    first.quickSessionDurations.every((value, index) => value === second.quickSessionDurations[index])
  );
}
