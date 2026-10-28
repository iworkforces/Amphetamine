import type { AppSettings } from "../../domain/settings/app-settings.js";
import type { BatteryMonitorStatus } from "../../domain/battery/monitor-status.js";
import type { AutoUpdaterStatus, SessionStatusResponse } from "../../shared/types.js";

/**
 * Semantic main→renderer push events.
 * Application code publishes these; infrastructure maps them to IPC channels.
 */
export type AppPushEvent =
  | { type: "settings-changed"; settings: AppSettings }
  | { type: "session-status"; status: SessionStatusResponse }
  | { type: "battery-status"; status: BatteryMonitorStatus }
  | { type: "shortcut-registration-failed"; accelerator: string }
  | { type: "auto-updater-status"; status: AutoUpdaterStatus };

/**
 * Main→renderer notification port (transport-agnostic).
 * Adapter maps AppPushEvent → IPC PUSH_CHANNELS.
 */
export interface MainToRendererNotifierPort {
  publish(event: AppPushEvent): void;
}
