/**
 * AppShell — Electron process-graph root.
 *
 * Owns ready/quit ordering for windows, composition, IPC, tray, and updater.
 * Composition remains the ports/use-cases wiring; this module is the topology.
 */
import type { BrowserWindow } from "electron/main";
import log from "electron-log";
import { createAppComposition, type AppComposition } from "./composition-root.js";
import { registerIpcHandlers } from "./ipc.js";
import { setupTray } from "./tray.js";
import { flushSettingsWriteChain } from "./settings.js";
import { isBenchmarkMode } from "../infrastructure/benchmark/benchmark-env.js";
import { enterTrayOnlyMode } from "./platform/index.js";
import {
  createPopoverWindow,
  drainSettingsWindow,
  destroyAllWindows,
  getPopoverWindow,
} from "./process/window-graph.js";

const SETTINGS_QUIT_DEADLINE_MS = 2000;

export interface AppShell {
  /** Ready order: tray-only mode → popover → composition → IPC → tray → updater. */
  init(): Promise<void>;
  /**
   * Quit order: drain Settings renderer → flush store → tray → IPC → composition.cleanup → destroy windows.
   * Idempotent.
   */
  cleanup(): Promise<void>;
  /** True after successful init until cleanup. */
  readonly ready: boolean;
  /** Popover BrowserWindow, or null before init / after destroy. */
  getMainWindow(): BrowserWindow | null;
  /** Show popover (second-instance activation). */
  showMainWindow(): void;
}

/**
 * Create the production process-graph shell (full factory only — no overrides).
 */
export function createAppShell(): AppShell {
  let composition: AppComposition | null = null;
  let cleanupTray: (() => void) | null = null;
  let cleanupIpc: (() => void) | null = null;
  let mainWindow: BrowserWindow | null = null;
  let isQuitting = false;
  let ready = false;
  let initOperation: Promise<void> | null = null;
  let cleanupOperation: Promise<void> | null = null;
  const isClosing = (): boolean => isQuitting;

  const init = (): Promise<void> => {
    if (cleanupOperation !== null || isQuitting) return Promise.resolve();
    if (initOperation !== null) return initOperation;
    initOperation = (async () => {
      try {
        enterTrayOnlyMode();
        mainWindow = createPopoverWindow({ isQuitting: () => isQuitting });
        composition = createAppComposition();
        await composition.init();
        if (isClosing()) return;

        cleanupIpc = registerIpcHandlers(mainWindow, composition.getIpcDeps());
        cleanupTray = setupTray(composition.getTrayDeps());
        if (!isBenchmarkMode()) composition.initUpdater();
        ready = true;
        log.info("[app-shell] Initialized");
      } catch (err) {
        try {
          await cleanup();
        } catch (cleanupError) {
          log.error("[app-shell] Cleanup after failed init failed:", cleanupError);
        }
        throw err;
      }
    })();
    return initOperation;
  };

  const cleanup = (): Promise<void> => {
    if (cleanupOperation !== null) return cleanupOperation;
    isQuitting = true;
    cleanupOperation = (async () => {
      const deadline = performance.now() + SETTINGS_QUIT_DEADLINE_MS;
      const drainController = new AbortController();
      const awaitWithinDeadline = async (
        stage: string,
        operation: () => Promise<void>,
      ): Promise<void> => {
        const remaining = Math.max(0, deadline - performance.now());
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          if (remaining === 0) {
            void operation().catch((err: unknown) => {
              log.error(`[app-shell] ${stage} on quit failed:`, err);
            });
            log.error(`[app-shell] ${stage} on quit timed out`);
            return;
          }
          const completed = await Promise.race([
            operation().then(() => true),
            new Promise<false>((resolve) => {
              timeout = setTimeout(() => resolve(false), remaining);
            }),
          ]);
          if (!completed) log.error(`[app-shell] ${stage} on quit timed out`);
        } catch (err) {
          log.error(`[app-shell] ${stage} on quit failed:`, err);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      };
      await awaitWithinDeadline("Settings renderer drain", () =>
        drainSettingsWindow(drainController.signal),
      );
      drainController.abort();
      await awaitWithinDeadline("Settings store flush", flushSettingsWriteChain);

      try {
        cleanupTray?.();
      } catch (err) {
        log.error("[app-shell] Tray cleanup on quit failed:", err);
      }
      cleanupTray = null;
      try {
        cleanupIpc?.();
      } catch (err) {
        log.error("[app-shell] IPC cleanup on quit failed:", err);
      }
      cleanupIpc = null;
      try {
        composition?.cleanup();
      } catch (err) {
        log.error("[app-shell] Composition cleanup on quit failed:", err);
      }
      composition = null;
      try {
        destroyAllWindows();
      } catch (err) {
        log.error("[app-shell] Window cleanup on quit failed:", err);
      } finally {
        mainWindow = null;
        ready = false;
      }
      log.info("[app-shell] Cleaned up");
    })();
    return cleanupOperation;
  };

  return {
    init,
    cleanup,
    get ready() {
      return ready;
    },
    getMainWindow: () => (isQuitting ? null : (getPopoverWindow() ?? mainWindow)),
    showMainWindow: () => {
      if (isQuitting) return;
      const win = getPopoverWindow() ?? mainWindow;
      win?.show();
    },
  };
}
