import type {
  AppPushEvent,
  MainToRendererNotifierPort,
} from "../../application/ports/main-to-renderer-notifier.port.js";
import { IPC_CHANNELS, type IpcResponse, type PushChannel } from "../../shared/types.js";

/**
 * Maps semantic AppPushEvent values to typed IPC push channels.
 */
export function createBroadcastNotifier(
  broadcast: <K extends PushChannel>(channel: K, data: IpcResponse<K>) => void,
): MainToRendererNotifierPort {
  return {
    publish(event: AppPushEvent): void {
      switch (event.type) {
        case "settings-changed":
          broadcast(IPC_CHANNELS.SETTINGS_CHANGED, event.settings);
          return;
        case "session-status":
          broadcast(IPC_CHANNELS.SESSION_STATUS_UPDATE, event.status);
          return;
        case "battery-status":
          broadcast(IPC_CHANNELS.BATTERY_STATUS_UPDATE, event.status);
          return;
        case "shortcut-registration-failed":
          broadcast(IPC_CHANNELS.SHORTCUT_REGISTRATION_FAILED, {
            accelerator: event.accelerator,
          });
          return;
        case "auto-updater-status":
          broadcast(IPC_CHANNELS.AUTO_UPDATER_STATUS, event.status);
          return;
      }
    },
  };
}
