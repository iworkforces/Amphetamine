import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = new EventEmitter();
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    destroyed = false;
    constructor() {
      super();
      app.emit("browser-window-created", {}, this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    async loadFile() {
      this.webContents.emit("did-fail-load", {}, -1, "failure", "file:", true);
    }
    async loadURL(url: string) {
      this.webContents.emit("did-start-navigation", {}, "file:", false, true);
      if (url !== "pending")
        this.webContents.emit("did-fail-provisional-load", {}, -3, "aborted", "file:", true);
    }
  }
  return { app, BrowserWindow: Window };
});

import { BrowserWindow } from "electron/main";
import {
  installBenchmarkReadinessTracking,
  waitForWindowLoad,
  waitForWindowReadyToShow,
} from "../../src/infrastructure/benchmark/benchmark-readiness.js";

installBenchmarkReadinessTracking();
afterEach(() => vi.useRealTimers());

describe("benchmark window readiness", () => {
  it("records completion even when it precedes the waiter", async () => {
    const window = new BrowserWindow();
    window.webContents.emit("did-finish-load");
    await expect(waitForWindowLoad(window)).resolves.toMatchObject({ kind: "loaded" });
    expect(window.webContents.listenerCount("did-fail-load")).toBe(0);
  });

  it("recognizes readiness of a cached window without waiting for another event", async () => {
    const window = new BrowserWindow();
    window.webContents.emit("did-finish-load");
    window.emit("ready-to-show");
    await expect(waitForWindowReadyToShow(window)).resolves.toEqual({
      kind: "loaded",
      elapsedMs: 0,
    });
    window.destroy();
    expect(window.listenerCount("closed")).toBe(0);
  });

  it("does not mistake a failed non-loading window for readiness", async () => {
    const window = new BrowserWindow();
    await window.loadFile("missing");
    await expect(waitForWindowLoad(window)).resolves.toMatchObject({ kind: "failed" });
    expect(window.webContents.listenerCount("did-finish-load")).toBe(0);
  });

  it("records provisional main-frame load failures", async () => {
    const window = new BrowserWindow();
    await window.loadURL("file://missing");
    await expect(waitForWindowLoad(window)).resolves.toMatchObject({ kind: "failed" });
    expect(window.webContents.listenerCount("did-fail-provisional-load")).toBe(0);
  });

  it("does not reuse successful readiness after a failed reload", async () => {
    const window = new BrowserWindow();
    window.webContents.emit("did-finish-load");
    window.emit("ready-to-show");
    await window.loadURL("file://missing");
    await expect(waitForWindowLoad(window)).resolves.toMatchObject({ kind: "failed" });
    await expect(waitForWindowReadyToShow(window)).resolves.toMatchObject({ kind: "failed" });
  });

  it("waits for an in-flight reload instead of reusing cached readiness", async () => {
    const window = new BrowserWindow();
    window.webContents.emit("did-finish-load");
    window.emit("ready-to-show");
    await window.loadURL("pending");
    let settled = false;
    const readiness = waitForWindowReadyToShow(window).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    window.webContents.emit("did-finish-load");
    await expect(readiness).resolves.toMatchObject({ kind: "loaded" });
  });

  it("cleans competing listeners when a window closes", async () => {
    const window = new BrowserWindow();
    const ready = waitForWindowReadyToShow(window);
    window.destroy();
    await expect(ready).resolves.toMatchObject({ kind: "closed" });
    await expect(waitForWindowLoad(window)).resolves.toMatchObject({ kind: "closed" });
    expect(window.listenerCount("ready-to-show")).toBe(0);
    expect(window.webContents.listenerCount("did-fail-load")).toBe(0);
  });

  it("cleans timers and listeners when readiness times out", async () => {
    vi.useFakeTimers();
    const window = new BrowserWindow();
    const ready = waitForWindowReadyToShow(window);
    await vi.advanceTimersByTimeAsync(7000);
    await expect(ready).resolves.toMatchObject({ kind: "timeout" });
    await expect(waitForWindowLoad(window)).resolves.toMatchObject({ kind: "timeout" });
    expect(window.listenerCount("ready-to-show")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
