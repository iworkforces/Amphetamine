import { ipcMain, app, type BrowserWindow, type IpcMainEvent } from "electron/main";
import log from "electron-log";
import {
  IPC_CHANNELS,
  DEFAULT_SETTINGS,
  type IpcRequest,
  type IpcResponse,
} from "../shared/types.js";
import { MAIN_WINDOW_WIDTH, MIN_POPOVER_HEIGHT, MAX_POPOVER_HEIGHT } from "./constants.js";
import { getPackageInfo } from "./utils/packageInfo.js";

import type { AppSettings } from "../shared/types.js";
import type { SessionTimerHandle } from "./session-timer.js";

import { validateSender, typedHandle } from "./ipc-utils.js";
import { validateDurationMinutes } from "../domain/session/duration.js";
export { validateSender } from "./ipc-utils.js";

/**
 * Dependencies required by the IPC layer.
 *
 * Replaces direct sibling-module imports so that ipc.ts has no compile-time
 * edges to settings, settings-window, auto-updater, or session-timer.
 *
 * `sessionTimer` is the subset of `SessionTimerHandle` actually consumed by
 * IPC handlers. Composition owns the live handle; ipc receives it here.
 */
export interface IpcDeps {
  getSettings: () => AppSettings;
  updateSettings: (
    partial: Partial<AppSettings>,
  ) => Promise<{ settings: AppSettings; rejectedKeys: string[] }>;
  createSettingsWindow: () => void;
  registerAutoUpdaterIpc: () => () => void;
  sessionTimer: Pick<SessionTimerHandle, "startSession" | "cancelSession" | "getStatus">;
}

/** Window IPC handlers (fire-and-forget) */
function registerWindowIpc(
  win: BrowserWindow,
  disposers: Array<() => void>,
  onWindowClosed: () => void,
): void {
  let pendingResizeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResizeHeight = 0;

  const onResize = (
    event: IpcMainEvent,
    height: IpcRequest<typeof IPC_CHANNELS.WINDOW_SET_HEIGHT>,
  ): void => {
    if (!validateSender(event)) return;
    try {
      if (typeof height === "number" && height > 0 && Number.isInteger(height)) {
        pendingResizeHeight = height;
        if (pendingResizeTimer === null) {
          pendingResizeTimer = setTimeout(() => {
            pendingResizeTimer = null;
            const clampedHeight = Math.max(
              MIN_POPOVER_HEIGHT,
              Math.min(MAX_POPOVER_HEIGHT, Math.round(pendingResizeHeight)),
            );
            win.setSize(MAIN_WINDOW_WIDTH, clampedHeight, false);
          }, 16);
        }
      }
    } catch (err) {
      log.error("[ipc] WINDOW_SET_HEIGHT error:", err);
    }
  };
  let registered = true;
  const unregister = (): void => {
    if (!registered) return;
    registered = false;
    if (pendingResizeTimer !== null) clearTimeout(pendingResizeTimer);
    ipcMain.off(IPC_CHANNELS.WINDOW_SET_HEIGHT, onResize);
    win.removeListener("closed", onWindowClosed);
  };
  disposers.push(unregister);
  ipcMain.on(IPC_CHANNELS.WINDOW_SET_HEIGHT, onResize);
  win.on("closed", onWindowClosed);
}

/** App utility IPC handlers */
function registerAppIpc(disposers: Array<() => void>): void {
  disposers.push(
    typedHandle(
      IPC_CHANNELS.APP_GET_VERSION,
      () => "",
      (): IpcResponse<typeof IPC_CHANNELS.APP_GET_VERSION> => {
        return app.getVersion();
      },
    ),
  );
  disposers.push(
    typedHandle(
      IPC_CHANNELS.APP_GET_ABOUT,
      () => ({
        productName: "Amphetamine",
        version: "2.0.0",
        description:
          "A tray app that keeps your computer awake on macOS and Windows. Lives in the system tray, prevents the system from going to sleep, and stays out of the Dock/taskbar when idle.",
        repository: "",
        author: "iworkforces Engineers",
      }),
      (): IpcResponse<typeof IPC_CHANNELS.APP_GET_ABOUT> => {
        const pkg = getPackageInfo();
        return {
          productName: pkg.productName,
          version: app.getVersion(),
          description: pkg.description,
          repository: pkg.repository,
          author: pkg.author,
        };
      },
    ),
  );
  disposers.push(
    typedHandle(
      IPC_CHANNELS.APP_QUIT,
      () => undefined,
      () => {
        app.quit();
      },
    ),
  );
}

/** Settings IPC handlers */
function registerSettingsIpc(deps: IpcDeps, disposers: Array<() => void>): void {
  disposers.push(
    typedHandle(
      IPC_CHANNELS.SETTINGS_GET,
      () => ({ ...DEFAULT_SETTINGS }),
      (): IpcResponse<typeof IPC_CHANNELS.SETTINGS_GET> => deps.getSettings(),
    ),
  );
  disposers.push(
    typedHandle(
      IPC_CHANNELS.SETTINGS_SET,
      () => ({ settings: deps.getSettings(), rejectedKeys: [] }),
      async (
        _event,
        partial: IpcRequest<typeof IPC_CHANNELS.SETTINGS_SET>,
      ): Promise<IpcResponse<typeof IPC_CHANNELS.SETTINGS_SET>> => {
        // Coordinator handles system sync (power-saver, auto-launch, session cancel, broadcast) via settings change
        return await deps.updateSettings(partial);
      },
    ),
  );
  disposers.push(
    typedHandle(
      IPC_CHANNELS.SETTINGS_OPEN,
      () => undefined,
      async () => {
        deps.createSettingsWindow();
      },
    ),
  );
}

/** Session timer IPC handlers */
function registerSessionIpc(deps: IpcDeps, disposers: Array<() => void>): void {
  disposers.push(
    typedHandle(
      IPC_CHANNELS.SESSION_START,
      () => ({ ok: false, reason: "rejected" }),
      async (_event, request) => {
        const envelope: unknown = request;
        if (
          typeof envelope !== "object" ||
          envelope === null ||
          Array.isArray(envelope) ||
          !("durationMinutes" in envelope)
        ) {
          return { ok: false, reason: "invalid-duration" };
        }
        const durationMinutes: unknown = envelope.durationMinutes;
        if (durationMinutes !== null && typeof durationMinutes !== "number") {
          return { ok: false, reason: "invalid-duration" };
        }
        const durationCheck = validateDurationMinutes(durationMinutes);
        if (!durationCheck.ok) {
          log.warn(
            "[session] SESSION_START rejected durationMinutes:",
            durationMinutes,
            durationCheck.reason,
          );
          return {
            ok: false,
            reason:
              durationCheck.reason === "Duration cannot exceed 24 hours"
                ? "Duration cannot exceed 24 hours"
                : "invalid-duration",
          };
        }
        const result = deps.sessionTimer.startSession(durationCheck.durationMinutes);
        // startSession() guarantees non-null startedAt; SessionState type is widened for getStatus() reuse.
        if (result.startedAt === null) {
          log.error(
            "[session] SESSION_START: startSession returned null startedAt (invariant violation)",
          );
          return { ok: false, reason: "rejected" };
        }
        return {
          ok: true,
          startedAt: result.startedAt,
          durationMinutes: result.durationMinutes,
          expiresAt: result.expiresAt,
        };
      },
    ),
  );
  disposers.push(
    typedHandle(
      IPC_CHANNELS.SESSION_CANCEL,
      () => ({ cancelled: false }),
      async () => {
        deps.sessionTimer.cancelSession();
        return { cancelled: true };
      },
    ),
  );
  disposers.push(
    typedHandle(
      IPC_CHANNELS.SESSION_STATUS,
      () => ({
        isRunning: false,
        startedAt: null,
        expiresAt: null,
        remainingSeconds: null,
        durationMinutes: null,
      }),
      () => deps.sessionTimer.getStatus(),
    ),
  );
}

/** Register all IPC handlers (orchestrator) */
export function registerIpcHandlers(win: BrowserWindow, deps: IpcDeps): () => void {
  const disposers: Array<() => void> = [];
  let registered = true;
  const unregister = (): void => {
    if (!registered) return;
    registered = false;
    const cleanupErrors: unknown[] = [];
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
  };
  try {
    registerWindowIpc(win, disposers, unregister);
    registerAppIpc(disposers);
    registerSettingsIpc(deps, disposers);
    registerSessionIpc(deps, disposers);
    disposers.push(deps.registerAutoUpdaterIpc());
  } catch (error) {
    try {
      unregister();
    } catch (cleanupError) {
      log.error("[ipc] registration rollback cleanup failed:", cleanupError);
    }
    throw error;
  }
  return unregister;
}
