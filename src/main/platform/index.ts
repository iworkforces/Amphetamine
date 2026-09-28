/**
 * Public platform API for main-process OS differences (macOS + Windows).
 *
 * Prefer importing from this module at call sites. Implementation lives in
 * sibling files.
 *
 * Modules:
 *   os.ts                    — pure identity helpers
 *   shell.ts                 — activation policy, Dock icon, login items
 *   utility-presentation.ts  — refcounted Dock / foreground for utility surfaces
 *   window-chrome.ts         — BrowserWindow option builders
 *   battery-percent.ts       — multi-OS charge percent providers
 *
 * Rules:
 * - Prefer these helpers over raw `process.platform` in main code.
 * - Never call macOS-only Electron APIs without an `isDarwin()` guard.
 * - Keep platform modules free of composition/settings policy.
 */

import {
  type PlatformId,
  type ProcessPlatform,
  resolvePlatformId,
  isDarwin,
  isWin32,
  isSupportedPlatform,
} from "./os.js";

import {
  type LoginItemWriteSettings,
  shouldUseActivationPolicy,
  enterTrayOnlyMode,
  enterForegroundMode,
  setDockIcon,
  buildLoginItemSettings,
} from "./shell.js";

import {
  acquireUtilityForeground,
  releaseUtilityForeground,
  isUtilityForegroundHeld,
  setUtilityDockIcon,
  resetUtilityForegroundForTests,
} from "./utility-presentation.js";

import {
  type WindowChromeOptions,
  popoverWindowChrome,
  settingsWindowChrome,
  aboutWindowChrome,
  utilityDialogWindowChrome,
  appIconFileName,
} from "./window-chrome.js";

import {
  getBatteryPercent,
  parsePmsetOutput,
  parsePowerShellBatteryOutput,
} from "./battery-percent.js";
import { createBatterySensor } from "./battery-sensor.js";

export type { PlatformId, ProcessPlatform, LoginItemWriteSettings, WindowChromeOptions };

export {
  resolvePlatformId,
  isDarwin,
  isWin32,
  isSupportedPlatform,
  shouldUseActivationPolicy,
  enterTrayOnlyMode,
  enterForegroundMode,
  setDockIcon,
  buildLoginItemSettings,
  acquireUtilityForeground,
  releaseUtilityForeground,
  isUtilityForegroundHeld,
  setUtilityDockIcon,
  resetUtilityForegroundForTests,
  popoverWindowChrome,
  settingsWindowChrome,
  aboutWindowChrome,
  utilityDialogWindowChrome,
  appIconFileName,
  getBatteryPercent,
  createBatterySensor,
  parsePmsetOutput,
  parsePowerShellBatteryOutput,
};
