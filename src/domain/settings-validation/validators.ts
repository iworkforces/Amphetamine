import { cloneAppSettings, DEFAULT_SETTINGS } from "../settings/app-settings.js";
import type { AppSettings } from "../settings/app-settings.js";
import type { SleepBlockMode } from "../settings/sleep-block-mode.js";
import { MAX_SESSION_DURATION_MINUTES } from "../session/duration.js";

export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export const isPositiveNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

export const isClamped0to100 = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

export const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export const isSleepBlockMode = (v: unknown): v is SleepBlockMode =>
  v === "prevent-display-sleep" || v === "prevent-app-suspension";

export const isQuickSessionDurations = (value: unknown): value is readonly number[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 6 &&
  new Set(value).size === value.length &&
  Array.from(value, (duration: unknown) => duration).every(
    (duration: unknown) =>
      typeof duration === "number" &&
      Number.isInteger(duration) &&
      duration >= 1 &&
      duration <= MAX_SESSION_DURATION_MINUTES,
  );

const ACCELERATOR_MODIFIERS = [
  "Cmd",
  "Command",
  "CommandOrControl",
  "CmdOrCtrl",
  "Ctrl",
  "Control",
  "Option",
  "Alt",
  "Shift",
  "Super",
] as const;

const MODIFIER_PATTERN =
  /(CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Option|Alt|Shift|Super)/;

/** Host platform string for reserved-key / normalize rules (defaults to Node `process.platform`). */
export type AcceleratorPlatform = string;

function defaultPlatform(): AcceleratorPlatform {
  // Avoid bare `process` (shared eslint has no Node globals); main/tests run under Node.
  const proc = (globalThis as { process?: { platform?: string } }).process;
  return typeof proc?.platform === "string" ? proc.platform : "darwin";
}

/**
 * On Windows, pure `Cmd`/`Command` modifiers have no effect in Electron.
 * Rewrite them to `CommandOrControl` so stored macOS-centric prefs still work.
 * Leaves Ctrl/Control/CommandOrControl unchanged.
 */
export function normalizeAcceleratorForPlatform(
  accelerator: string,
  platform: AcceleratorPlatform = defaultPlatform(),
): string {
  if (platform !== "win32") {
    return accelerator;
  }
  return accelerator
    .split("+")
    .map((part) => {
      const token = part.trim();
      if (token === "Cmd" || token === "Command") {
        return "CommandOrControl";
      }
      return token;
    })
    .join("+");
}

function isReservedAccelerator(s: string, platform: AcceleratorPlatform): boolean {
  // macOS / cross-platform: Cmd-family + Q/W/Tab/Space (and CommandOrControl aliases).
  const CMD_RESERVED_KEYS = ["Q", "W", "Tab", "Space"];
  const CMD_ALIASES = ["Cmd", "Command", "CommandOrControl", "CmdOrCtrl"];
  const cmdForbidden = CMD_ALIASES.flatMap((mod) =>
    CMD_RESERVED_KEYS.map((key) => new RegExp(`^${mod}\\+${key}$`, "i")),
  );
  if (cmdForbidden.some((r) => r.test(s))) {
    return true;
  }

  // Windows (and general Ctrl) reserved combos.
  if (platform === "win32") {
    if (/^(Ctrl|Control)\+W$/i.test(s)) {
      return true;
    }
    if (/^Alt\+F4$/i.test(s)) {
      return true;
    }
  }

  // Alt+F4 is never a sensible global app shortcut on any OS we target.
  if (/^Alt\+F4$/i.test(s)) {
    return true;
  }

  return false;
}

/**
 * Validates an Electron accelerator string (e.g. "CommandOrControl+Shift+A").
 * Requires:
 *  - non-empty string
 *  - at least one modifier (Cmd/Command/Ctrl/Control/Option/Alt/Shift/Super)
 *  - at least one non-modifier key
 *  - not a reserved system shortcut (platform-aware)
 */
export const isValidAccelerator = (
  s: unknown,
  platform: AcceleratorPlatform = defaultPlatform(),
): s is string => {
  if (!isNonEmptyString(s)) return false;

  if (!MODIFIER_PATTERN.test(s)) return false;

  const parts = s.split("+").map((p) => p.trim());
  const nonModifiers = parts.filter((p) => !(ACCELERATOR_MODIFIERS as readonly string[]).includes(p));
  if (nonModifiers.length === 0) return false;

  if (isReservedAccelerator(s, platform)) return false;

  return true;
};

/**
 * Validates a shortcut settings value. Accepts either:
 *  - an empty string (sentinel for "use default shortcut", see AppSettings.shortcut)
 *  - a valid Electron accelerator (see {@link isValidAccelerator})
 */
export const isValidShortcutSetting = (
  v: unknown,
  platform: AcceleratorPlatform = defaultPlatform(),
): v is string => v === "" || isValidAccelerator(v, platform);

export const validateBoolean = (value: unknown, defaultValue: boolean): boolean =>
  isBoolean(value) ? value : defaultValue;

export const validatePositiveNumber = (
  value: unknown,
  defaultValue: number | null,
): number | null => (isPositiveNumber(value) ? value : defaultValue);

export const validateClampedNumber = (value: unknown, defaultValue: number): number =>
  isClamped0to100(value) ? value : defaultValue;

export function validateNonEmptyString(value: unknown, defaultValue: string): string {
  return isNonEmptyString(value) ? value : defaultValue;
}

type SettingsValidator<K extends keyof AppSettings> = (
  value: unknown,
  fallback: AppSettings[K],
) => AppSettings[K];

export const VALIDATORS: { [K in keyof AppSettings]: SettingsValidator<K> } = {
  launchAtLogin: (v, f) => (isBoolean(v) ? v : f),
  preventSleep: (v, f) => (isBoolean(v) ? v : f),
  defaultSessionDuration: (v, f) => {
    if (v === null) return null;
    return isPositiveNumber(v) ? v : f;
  },
  quickSessionDurations: (v, f) => (isQuickSessionDurations(v) ? [...v] : [...f]),
  batteryThreshold: (v, f) => (isClamped0to100(v) ? v : f),
  shortcut: (v, f) => {
    if (!isValidShortcutSetting(v)) return f;
    if (v === "") return v;
    return normalizeAcceleratorForPlatform(v);
  },
  sleepBlockMode: (v, f) => (isSleepBlockMode(v) ? v : f),
};

function applyValidator<K extends keyof AppSettings>(
  key: K,
  value: unknown,
  fallback: AppSettings[K],
): AppSettings[K] {
  return VALIDATORS[key](value, fallback);
}

/**
 * Map legacy disk keys into current AppSettings shape before validation.
 * `sessionDuration` (pre-split) → `defaultSessionDuration`.
 * On win32, pure Cmd/Command accelerators are normalized toward CommandOrControl
 * via {@link normalizeAcceleratorForPlatform} during shortcut validation.
 */
export function migrateRawSettingsRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  if (!("defaultSessionDuration" in next) && "sessionDuration" in next) {
    next.defaultSessionDuration = next.sessionDuration;
  }
  delete next.sessionDuration;
  return next;
}

/**
 * Validates raw settings from disk JSON against expected shape.
 * Single path: migrate legacy keys → filter known fields → mergeValidatedPartial(DEFAULTS).
 */
export function validateRawSettings(raw: Record<string, unknown>): AppSettings {
  const migrated = migrateRawSettingsRecord(raw);
  const partial: Partial<AppSettings> = {};
  for (const key of Object.keys(VALIDATORS) as (keyof AppSettings)[]) {
    if (key in migrated) {
      // Assign through a narrow helper so exactOptionalPropertyTypes is satisfied.
      assignPartial(partial, key, migrated[key]);
    }
  }
  return mergeValidatedPartial(DEFAULT_SETTINGS, partial).merged;
}

function assignPartial<K extends keyof AppSettings>(
  target: Partial<AppSettings>,
  key: K,
  value: unknown,
): void {
  // Store raw; mergeValidatedPartial re-validates.
  (target as Record<string, unknown>)[key] = value;
}

export function mergeValidatedPartial(
  base: AppSettings,
  partial: Partial<AppSettings>,
): { merged: AppSettings; rejectedKeys: string[] } {
  const merged: AppSettings = cloneAppSettings(base);
  const rejectedKeys: string[] = [];
  for (const key of Object.keys(partial) as (keyof AppSettings)[]) {
    if (!(key in VALIDATORS)) {
      rejectedKeys.push(key);
      continue;
    }
    const incoming = partial[key];
    if (incoming === undefined) continue;
    const validated = applyValidator(key, incoming, base[key]);
    // Shortcut may be rewritten (Cmd → CommandOrControl on win32) while still accepted.
    if (key === "shortcut") {
      if (!isValidShortcutSetting(incoming)) {
        rejectedKeys.push(key);
      }
    } else if (key === "quickSessionDurations") {
      if (!isQuickSessionDurations(incoming)) rejectedKeys.push(key);
    } else if (validated !== incoming) {
      rejectedKeys.push(key);
    }
    assignValidated(merged, key, incoming);
  }
  return { merged, rejectedKeys };
}

function assignValidated<K extends keyof AppSettings>(
  target: AppSettings,
  key: K,
  incoming: unknown,
): void {
  target[key] = applyValidator(key, incoming, target[key]);
}
