/**
 * Main process entry — app lifecycle events only.
 * Process graph wiring lives in AppShell.
 */
import { app, dialog } from "electron/main";
import log from "electron-log";
import os from "node:os";
import { getPackageInfo } from "./utils/packageInfo.js";
import { stopPreventingSleep } from "./sleep-prevention.js";
import {
  configureBenchmarkEnvironment,
  installBenchmarkTimerCounters,
  runBenchmarkIfRequested,
} from "../infrastructure/benchmark/index.js";
import { isDev } from "./constants.js";
import { createAppShell, type AppShell } from "./app-shell.js";
import { installGlobalWebContentsHardening } from "./security.js";

const mainProcessStartMs = performance.now();

configureBenchmarkEnvironment();
installBenchmarkTimerCounters();
installGlobalWebContentsHardening();

process.on("uncaughtException", (error: Error) => {
  log.error("[main] Uncaught exception:", error);
  if (!isDev) {
    dialog.showErrorBox(
      "Unexpected Error",
      "An unexpected error occurred. Please restart the app.",
    );
    stopPreventingSleep();
    app.exit(1);
  }
});
process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  log.error("[main] Unhandled rejection at:", promise, "reason:", reason);
  // Do not exit on unhandled rejection - these are often recoverable
});

const packageJson = getPackageInfo();
const platform = [os.type(), os.release(), os.arch()].join(", ");
app.setAboutPanelOptions({
  applicationName: "Amphetamine",
  applicationVersion: app.getVersion(),
  copyright: `Developed by ${packageJson.author}`,
  version: platform,
});

let shell: AppShell | null = null;
let didRunQuitCleanup = false;
const hasQuitCleanupStarted = (): boolean => didRunQuitCleanup;

app.on("second-instance", () => {
  shell?.showMainWindow();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

void app
  .whenReady()
  .then(async () => {
    if (didRunQuitCleanup) return;
    const appReadyMs = performance.now() - mainProcessStartMs;
    shell = createAppShell();
    await shell.init();
    if (hasQuitCleanupStarted() || !shell.ready) return;

    const mainWindow = shell.getMainWindow();
    if (mainWindow !== null) {
      void runBenchmarkIfRequested({
        mainWindow,
        appReadyMs,
        bootstrapReadyMs: performance.now() - mainProcessStartMs,
      }).catch((err: unknown) => {
        log.error("[benchmark] Benchmark run failed:", err);
        app.exit(1);
      });
    }
  })
  .catch((err: unknown) => {
    log.error("[main] Startup failed:", err);
    app.quit();
  });

app.on("window-all-closed", () => {
  // Tray-only app stays alive when all windows close
});

app.on("before-quit", (event) => {
  if (didRunQuitCleanup) return;
  event.preventDefault();
  didRunQuitCleanup = true;
  void (async () => {
    try {
      await shell?.cleanup();
    } catch (err: unknown) {
      log.error("[main] Quit cleanup failed:", err);
    } finally {
      shell = null;
      app.exit(0);
    }
  })();
});
