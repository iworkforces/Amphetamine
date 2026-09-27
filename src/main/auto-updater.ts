/**
 * Main-process auto-updater façade.
 * Hybrid policy lives in infrastructure/updater; this file owns IPC registration
 * and stable re-exports for existing import paths.
 */
import log from "electron-log";
import { IPC_CHANNELS } from "../shared/types.js";
import { typedHandle } from "./ipc-utils.js";
import { checkForUpdatesForIpc } from "../infrastructure/updater/hybrid-auto-updater.js";

export {
  initAutoUpdater,
  stopAutoUpdater,
  checkForUpdatesNow,
  checkForUpdatesForIpc,
} from "../infrastructure/updater/hybrid-auto-updater.js";

/**
 * Register the auto-updater IPC handler.
 * Allows renderer to manually trigger an update check (same hybrid path as tray).
 */
export function registerAutoUpdaterIpc(): () => void {
  const unregister = typedHandle(
    IPC_CHANNELS.AUTO_UPDATER_CHECK,
    () => null,
    async () => {
      return await checkForUpdatesForIpc();
    },
  );
  try {
    log.info("[auto-updater] IPC handler registered");
  } catch (error) {
    unregister();
    throw error;
  }
  return unregister;
}
