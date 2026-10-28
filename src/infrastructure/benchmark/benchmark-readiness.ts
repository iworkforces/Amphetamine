import { app, type BrowserWindow } from "electron/main";
import type { BenchmarkLoadResult } from "../../shared/benchmark-types.js";

const LOAD_TIMEOUT_MS = 7000;
const loads = new WeakMap<BrowserWindow, Promise<BenchmarkLoadResult>>();
const outcomes = new WeakMap<BrowserWindow, BenchmarkLoadResult>();
const readyWindows = new WeakSet<BrowserWindow>();
const readyTrackingCleanup = new WeakMap<BrowserWindow, () => void>();

export function installBenchmarkReadinessTracking(): void {
  app.on("browser-window-created", (_event, win) => {
    loads.set(win, observeLoad(win));
    const contents = win.webContents;
    const navigation = (
      _event: Electron.Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (!isInPlace && isMainFrame && outcomes.has(win)) {
        outcomes.delete(win);
        loads.set(win, observeLoad(win));
      }
    };
    const cleanupNavigation = (): void => {
      contents.removeListener("did-start-navigation", navigation);
      win.removeListener("closed", cleanupNavigation);
    };
    contents.on("did-start-navigation", navigation);
    win.once("closed", cleanupNavigation);
    const ready = (): void => {
      readyWindows.add(win);
      cleanup();
    };
    const closed = (): void => {
      cleanup();
      readyWindows.delete(win);
    };
    const cleanup = (): void => {
      win.removeListener("ready-to-show", ready);
      win.removeListener("closed", closed);
      readyTrackingCleanup.delete(win);
    };
    readyTrackingCleanup.set(win, cleanup);
    win.once("ready-to-show", ready);
    win.once("closed", closed);
  });
}

export function waitForWindowLoad(win: BrowserWindow): Promise<BenchmarkLoadResult> {
  if (win.isDestroyed() || win.webContents.isDestroyed())
    return Promise.resolve({ kind: "closed", elapsedMs: 0 });
  return loads.get(win) ?? Promise.resolve({ kind: "failed", elapsedMs: 0 });
}

function observeLoad(win: BrowserWindow): Promise<BenchmarkLoadResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const contents = win.webContents;
    const finish = (kind: BenchmarkLoadResult["kind"]): void => {
      clearTimeout(timeout);
      if (kind !== "loaded") readyTrackingCleanup.get(win)?.();
      contents.removeListener("did-finish-load", loaded);
      contents.removeListener("did-fail-load", failed);
      contents.removeListener("did-fail-provisional-load", failed);
      contents.removeListener("destroyed", closed);
      win.removeListener("closed", closed);
      const result = { kind, elapsedMs: performance.now() - started };
      outcomes.set(win, result);
      resolve(result);
    };
    const loaded = (): void => finish("loaded");
    const failed = (
      _event: Electron.Event,
      _code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame) finish("failed");
    };
    const closed = (): void => finish("closed");
    const timeout = setTimeout(() => finish("timeout"), LOAD_TIMEOUT_MS);
    timeout.unref();
    contents.once("did-finish-load", loaded);
    contents.on("did-fail-load", failed);
    contents.on("did-fail-provisional-load", failed);
    contents.once("destroyed", closed);
    win.once("closed", closed);
  });
}

export async function waitForWindowReadyToShow(win: BrowserWindow): Promise<BenchmarkLoadResult> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return { kind: "closed", elapsedMs: 0 };
  const outcome = outcomes.get(win);
  if (outcome !== undefined && outcome.kind !== "loaded") return outcome;
  if (outcome === undefined && readyWindows.has(win)) {
    const started = performance.now();
    const load = await waitForWindowLoad(win);
    if (load.kind !== "loaded") return load;
    return { kind: "loaded", elapsedMs: performance.now() - started };
  }
  if (readyWindows.has(win)) return { kind: "loaded", elapsedMs: 0 };
  return new Promise((resolve) => {
    const started = performance.now();
    const contents = win.webContents;
    const finish = (kind: BenchmarkLoadResult["kind"]): void => {
      clearTimeout(timeout);
      if (kind !== "loaded") readyTrackingCleanup.get(win)?.();
      win.removeListener("ready-to-show", loaded);
      win.removeListener("closed", closed);
      contents.removeListener("did-fail-load", failed);
      contents.removeListener("did-fail-provisional-load", failed);
      contents.removeListener("destroyed", closed);
      resolve({ kind, elapsedMs: performance.now() - started });
    };
    const loaded = (): void => finish("loaded");
    const failed = (
      _event: Electron.Event,
      _code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame) finish("failed");
    };
    const closed = (): void => finish("closed");
    const timeout = setTimeout(() => finish("timeout"), LOAD_TIMEOUT_MS);
    timeout.unref();
    win.once("ready-to-show", loaded);
    win.once("closed", closed);
    contents.on("did-fail-load", failed);
    contents.on("did-fail-provisional-load", failed);
    contents.once("destroyed", closed);
  });
}
