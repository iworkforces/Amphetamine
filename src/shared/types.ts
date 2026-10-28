/**
 * Cross-process transport contracts (IPC channels, wire DTOs) plus re-exports
 * of pure domain settings/time types for preload and existing import paths.
 */

export type { PerfTimestamp } from "../domain/time/perf-timestamp.js";
export { asPerf } from "../domain/time/perf-timestamp.js";
export type { SleepBlockMode } from "../domain/settings/sleep-block-mode.js";
export type { AppSettings } from "../domain/settings/app-settings.js";
export { DEFAULT_SETTINGS } from "../domain/settings/app-settings.js";
export type { BatterySample, BatteryMonitorStatus } from "../domain/battery/monitor-status.js";

/** IPC channel names — single source of truth */
export const IPC_CHANNELS = {
  WINDOW_SET_HEIGHT: "window:set-height",
  WINDOW_HIDE: "window:hide",
  APP_GET_VERSION: "app:get-version",
  APP_GET_ABOUT: "app:get-about",
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  SESSION_START: "session:start",
  SESSION_CANCEL: "session:cancel",
  SESSION_STATUS: "session:status",
  SESSION_STATUS_UPDATE: "session:status-update",
  SETTINGS_CHANGED: "settings:changed",
  SETTINGS_OPEN: "settings:open",
  APP_QUIT: "app:quit",
  AUTO_UPDATER_CHECK: "auto-updater:check",
  AUTO_UPDATER_STATUS: "auto-updater:status",
  SHORTCUT_REGISTRATION_FAILED: "shortcut:registration-failed",
  BATTERY_STATUS: "battery:status",
  BATTERY_STATUS_UPDATE: "battery:status-update",
} as const;

import type { PerfTimestamp } from "../domain/time/perf-timestamp.js";
import type { AppSettings } from "../domain/settings/app-settings.js";
import type { BatteryMonitorStatus } from "../domain/battery/monitor-status.js";

/**
 * Canonical session status payload — discriminated union with three arms.
 *
 * Used as the response shape for both the `SESSION_STATUS` IPC request/response
 * channel and the `SESSION_STATUS_UPDATE` push channel — renderers should treat
 * these payloads as interchangeable.
 *
 * Arms (discriminated by `isRunning` + `expiresAt`):
 * - Not running: `isRunning: false`, all other fields `null`.
 * - Timed session: `isRunning: true`, all five fields are `number` (no nulls).
 * - Indefinite session: `isRunning: true`, `startedAt: number`,
 *   `expiresAt`, `remainingSeconds`, `durationMinutes` all `null`.
 */
export type SessionStatusResponse =
  | {
      isRunning: false;
      startedAt: null;
      expiresAt: null;
      remainingSeconds: null;
      durationMinutes: null;
    }
  | {
      // Timed session
      isRunning: true;
      startedAt: PerfTimestamp;
      expiresAt: PerfTimestamp;
      remainingSeconds: number;
      durationMinutes: number;
    }
  | {
      // Indefinite session
      isRunning: true;
      startedAt: PerfTimestamp;
      expiresAt: null;
      remainingSeconds: null;
      durationMinutes: null;
    };

export type SessionStartRequest = { durationMinutes: number | null; operation?: never };
export type SessionExtendRequest = { operation: "extend"; additionalMinutes: number };
export type TimedSessionStatus = Extract<
  SessionStatusResponse,
  { isRunning: true; expiresAt: PerfTimestamp }
>;
export type SessionExtendResponse =
  | { ok: true; status: TimedSessionStatus }
  | {
      ok: false;
      reason: "invalid-additional-minutes" | "idle" | "indefinite" | "expired" | "duration-limit" | "rejected";
    };

/** Response shape for SESSION_START channel — discriminated union */
export type SessionStartResponse =
  | {
      ok: true;
      startedAt: number;
      durationMinutes: number | null;
      expiresAt: number | null;
    }
  | {
      ok: false;
      reason: "invalid-duration" | "rejected" | "Duration cannot exceed 24 hours";
    };

/**
 * Minimal local mirror of electron-updater's UpdateInfo — only the fields the
 * app actually consumes. Kept dependency-free so `shared/` does not import
 * `electron-updater`.
 */
export interface UpdateMeta {
  version: string;
  releaseDate: string;
  releaseNotes?: string;
}

/** About window package metadata (renderer-safe snapshot). */
export interface AboutInfo {
  productName: string;
  version: string;
  description: string;
  repository: string;
  /** Rights holder for copyright line (from package.json author). */
  author: string;
}

/**
 * Discriminated union response for AUTO_UPDATER_STATUS. Each arm is keyed on
 * `status` so consumers can use exhaustive `switch` narrowing.
 */
export type AutoUpdaterStatus =
  | { status: "checking" }
  | { status: "available"; info: UpdateMeta }
  | { status: "not-available"; info: UpdateMeta }
  | { status: "downloaded"; info: UpdateMeta }
  | { status: "downloading"; progress: { percent: number; transferred: number; total: number } }
  | {
      status: "check-error" | "download-error" | "error";
      category: "network" | "feed-missing" | "signature" | "io" | "unknown";
    };

/** IPC Request/Response type map for type-safe IPC */
export type IpcChannelMap = {
  [IPC_CHANNELS.WINDOW_SET_HEIGHT]: {
    request: number;
    response: void;
  };
  [IPC_CHANNELS.APP_GET_VERSION]: {
    request: void;
    response: string;
  };
  [IPC_CHANNELS.APP_GET_ABOUT]: {
    request: void;
    response: AboutInfo;
  };
  [IPC_CHANNELS.SETTINGS_GET]: {
    request: void;
    response: AppSettings;
  };
  [IPC_CHANNELS.SETTINGS_SET]: {
    request: Partial<AppSettings>;
    response: { settings: AppSettings; rejectedKeys: string[] };
  };
  [IPC_CHANNELS.SESSION_START]: {
    request: SessionStartRequest | SessionExtendRequest;
    response: SessionStartResponse | SessionExtendResponse;
  };
  [IPC_CHANNELS.SESSION_CANCEL]: {
    request: undefined;
    response: { cancelled: boolean };
  };
  [IPC_CHANNELS.SESSION_STATUS]: {
    request: undefined;
    response: SessionStatusResponse;
  };
  [IPC_CHANNELS.SESSION_STATUS_UPDATE]: {
    request: undefined;
    response: SessionStatusResponse;
  };
  [IPC_CHANNELS.SETTINGS_CHANGED]: {
    request: undefined;
    response: AppSettings;
  };
  [IPC_CHANNELS.SETTINGS_OPEN]: {
    request: undefined;
    response: void;
  };
  [IPC_CHANNELS.APP_QUIT]: {
    request: undefined;
    response: void;
  };
  [IPC_CHANNELS.WINDOW_HIDE]: {
    request: undefined;
    response: void;
  };
  [IPC_CHANNELS.AUTO_UPDATER_CHECK]: {
    request: undefined;
    response: { version: string; releaseDate: string } | null;
  };
  [IPC_CHANNELS.AUTO_UPDATER_STATUS]: {
    request: undefined;
    response: AutoUpdaterStatus;
  };
  [IPC_CHANNELS.SHORTCUT_REGISTRATION_FAILED]: {
    request: undefined;
    response: { accelerator: string };
  };
  [IPC_CHANNELS.BATTERY_STATUS]: {
    request: undefined;
    response: BatteryMonitorStatus;
  };
  [IPC_CHANNELS.BATTERY_STATUS_UPDATE]: {
    request: undefined;
    response: BatteryMonitorStatus;
  };
};

/** Type utilities for type-safe IPC */
export type IpcChannel = keyof IpcChannelMap;
export type IpcRequest<K extends IpcChannel> = IpcChannelMap[K]["request"];
export type IpcResponse<K extends IpcChannel> = IpcChannelMap[K]["response"];

/** Channels that main process pushes to renderer (no request, only response) */
export const PUSH_CHANNELS = [
  IPC_CHANNELS.SETTINGS_CHANGED,
  IPC_CHANNELS.SESSION_STATUS_UPDATE,
  IPC_CHANNELS.AUTO_UPDATER_STATUS,
  IPC_CHANNELS.WINDOW_HIDE,
  IPC_CHANNELS.SHORTCUT_REGISTRATION_FAILED,
  IPC_CHANNELS.BATTERY_STATUS_UPDATE,
] as const;

export type PushChannel = (typeof PUSH_CHANNELS)[number];
