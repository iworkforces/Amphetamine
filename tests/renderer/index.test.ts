import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppSettings, SessionStatusResponse } from "../../src/shared/types.js";
import { asPerf, DEFAULT_SETTINGS } from "../../src/shared/types.js";
import {
  STATUS_PREVENTING_SLEEP,
  STATUS_SLEEP_PREVENTION_OFF,
  STATUS_UNAVAILABLE,
  ERROR_SETTINGS_UNAVAILABLE,
  ERROR_PREFERENCE_SAVE_FAILED,
} from "../../src/renderer/constants.js";

const mockApi = {
  window: { setHeight: vi.fn() },
  app: { getVersion: vi.fn().mockResolvedValue("1.0.0"), quit: vi.fn() },
  settings: {
    get: vi.fn<() => Promise<AppSettings>>(),
    set: vi.fn(),
    open: vi.fn(),
  },
  session: {
    start: vi.fn(),
    cancel: vi.fn(),
    getStatus: vi.fn<() => Promise<SessionStatusResponse | null>>(),
  },
  onSettingsChanged: vi.fn<(_cb: (s: AppSettings) => void) => () => void>(() => vi.fn()),
  onWindowHide: vi.fn<(_cb: () => void) => () => void>(() => vi.fn()),
  onSessionStatusUpdate: vi.fn<(_cb: (s: SessionStatusResponse) => void) => () => void>(() =>
    vi.fn(),
  ),
  autoUpdater: {
    checkForUpdates: vi.fn(),
    onStatus: vi.fn(() => vi.fn()),
  },
  benchmark: {
    isEnabled: vi.fn(() => false),
  },
  platform: { os: "darwin" as string },
};

function setupDom(): void {
  document.body.innerHTML = '<div id="app"></div>';
}

function getTimerText(): string | null {
  return document.getElementById("timer-text")?.textContent ?? null;
}

function getStatusText(): string | null {
  return document.getElementById("status-text")?.textContent ?? null;
}

function getStatusDot(): HTMLElement | null {
  return document.querySelector("#status-dot");
}

function getToggle(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("#prevent-sleep-toggle");
}

function getErrorText(): string | null {
  return document.getElementById("status-error")?.textContent ?? null;
}

function timedSessionStatus(remainingSeconds = 25 * 60): SessionStatusResponse {
  const now = performance.now();
  return {
    isRunning: true,
    startedAt: asPerf(now),
    expiresAt: asPerf(now + remainingSeconds * 1000),
    remainingSeconds,
    durationMinutes: 30,
  };
}

async function bootRenderer(): Promise<void> {
  vi.resetModules();
  const domContentLoadedListeners: EventListenerOrEventListenerObject[] = [];
  const addEventListener = document.addEventListener.bind(document);
  const addEventListenerSpy = vi
    .spyOn(document, "addEventListener")
    .mockImplementation((type, listener, options) => {
      if (type === "DOMContentLoaded") {
        domContentLoadedListeners.push(listener);
        return;
      }

      addEventListener(type, listener, options);
    });

  await import("../../src/renderer/index.js");
  addEventListenerSpy.mockRestore();

  const domContentLoadedListener = domContentLoadedListeners[0];
  expect(domContentLoadedListener).toBeDefined();

  const domContentLoadedEvent = new Event("DOMContentLoaded");
  if (typeof domContentLoadedListener === "function") {
    domContentLoadedListener(domContentLoadedEvent);
  } else {
    domContentLoadedListener?.handleEvent(domContentLoadedEvent);
  }

  await vi.advanceTimersByTimeAsync(0);
}

function setDocumentVisibility(visibilityState: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    value: visibilityState,
    configurable: true,
  });
}

describe("renderer popover (index.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setupDom();
    mockApi.settings.get.mockReset();
    mockApi.settings.set.mockReset();
    mockApi.session.getStatus.mockReset();
    mockApi.app.getVersion.mockReset();
    mockApi.onSettingsChanged.mockReset().mockImplementation(() => vi.fn());
    mockApi.onSessionStatusUpdate.mockReset().mockImplementation(() => vi.fn());
    mockApi.onWindowHide.mockReset().mockImplementation(() => vi.fn());
    mockApi.app.getVersion.mockResolvedValue("1.0.0");

    // Default: preventSleep off
    const defaultSettings: AppSettings = {
      ...DEFAULT_SETTINGS,
      launchAtLogin: false,
      preventSleep: false,
      defaultSessionDuration: null,
    };
    mockApi.settings.get.mockResolvedValue(defaultSettings);
    mockApi.session.getStatus.mockResolvedValue(null);

    Object.defineProperty(globalThis, "window", {
      value: {
        ...globalThis.window,
        api: mockApi,

        addEventListener: globalThis.window?.addEventListener?.bind(globalThis.window) ?? vi.fn(),
        dispatchEvent: globalThis.window?.dispatchEvent?.bind(globalThis.window) ?? vi.fn(),
        removeEventListener:
          globalThis.window?.removeEventListener?.bind(globalThis.window) ?? vi.fn(),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    window.dispatchEvent(new Event("beforeunload"));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("formatTimerLabel via render", () => {
    it('renders "Timer Indefinitely" when preventSleep is false', async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      });
      mockApi.session.getStatus.mockResolvedValue(null);

      // Trigger DOMContentLoaded → init()
      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));

      // Let promises resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(getTimerText()).toBe("Timer Indefinitely");
    });

    it('renders "Timer Indefinitely" when session not running', async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: true,
        defaultSessionDuration: null,
      });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: false,
        startedAt: null,
        expiresAt: null,
        remainingSeconds: null,
        durationMinutes: null,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(getTimerText()).toBe("Timer Indefinitely");
    });

    it('renders "Timer Indefinitely" when running with null durationMinutes', async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: true,
        defaultSessionDuration: null,
      });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now()),
        expiresAt: null,
        remainingSeconds: null,
        durationMinutes: null,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(getTimerText()).toBe("Timer Indefinitely");
    });

    it("renders hours and minutes remaining for large durations", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: true,
        defaultSessionDuration: 120,
      });
      // 1h 30m = 5400 seconds
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now() - 30 * 60 * 1000),
        expiresAt: asPerf(Date.now() + 90 * 60 * 1000),
        remainingSeconds: 5400,
        durationMinutes: 120,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const text = getTimerText();
      expect(text).toContain("Timer");
      expect(text).toContain("h");
      expect(text).toContain("m remaining");
    });

    it("renders minutes only when less than an hour", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: true,
        defaultSessionDuration: 30,
      });
      // 25 minutes remaining = 1500 seconds
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now() - 5 * 60 * 1000),
        expiresAt: asPerf(Date.now() + 25 * 60 * 1000),
        remainingSeconds: 1500,
        durationMinutes: 30,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const text = getTimerText();
      expect(text).toContain("Timer");
      expect(text).toContain("m remaining");
      expect(text).not.toContain("h");
    });
  });

  describe("status UI", () => {
    it("shows active status dot and text when preventSleep is true", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: true,
        defaultSessionDuration: null,
      });
      mockApi.session.getStatus.mockResolvedValue(null);

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(getStatusDot()?.classList.contains("active")).toBe(true);
      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
    });

    it("shows inactive status when preventSleep is false", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      });
      mockApi.session.getStatus.mockResolvedValue(null);

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(getStatusDot()?.classList.contains("active")).toBe(false);
      expect(getStatusText()).toBe(STATUS_SLEEP_PREVENTION_OFF);
    });
  });

  describe("render", () => {
    it("renders version in header", async () => {
      mockApi.app.getVersion.mockResolvedValue("2.5.0");
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const version = document.querySelector(".app-version");
      expect(version?.textContent).toBe("v2.5.0");
    });

    it("renders settings and quit buttons", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(document.getElementById("settings-action")).not.toBeNull();
      expect(document.getElementById("quit-action")).not.toBeNull();
    });

    it("calls settings.open when settings button clicked", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      document.getElementById("settings-action")?.click();
      expect(mockApi.settings.open).toHaveBeenCalledOnce();
    });

    it("calls app.quit when quit button clicked", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      document.getElementById("quit-action")?.click();
      expect(mockApi.app.quit).toHaveBeenCalledOnce();
    });

    it("keeps the successful version when settings fail", async () => {
      mockApi.settings.get.mockRejectedValue(new Error("IPC error"));

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const version = document.querySelector(".app-version");
      expect(version?.textContent).toBe("v1.0.0");
      expect(getToggle()?.disabled).toBe(true);
      expect(getStatusText()).toBe(STATUS_UNAVAILABLE);
    });
  });

  describe("startup and recovery", () => {
    it("subscribes before reads settle and enables only the authoritative settings snapshot", async () => {
      const settingsRead = Promise.withResolvers<AppSettings>();
      const versionRead = Promise.withResolvers<string>();
      mockApi.settings.get.mockReturnValueOnce(settingsRead.promise);
      mockApi.app.getVersion.mockReturnValueOnce(versionRead.promise);

      await bootRenderer();

      expect(mockApi.onSettingsChanged).toHaveBeenCalledOnce();
      expect(mockApi.onSessionStatusUpdate).toHaveBeenCalledOnce();
      expect(mockApi.onWindowHide).toHaveBeenCalledOnce();
      expect(getToggle()?.disabled).toBe(true);
      expect(getStatusText()).toBe(STATUS_UNAVAILABLE);
      settingsRead.resolve({ ...DEFAULT_SETTINGS, preventSleep: true });
      await vi.advanceTimersByTimeAsync(16);
      expect(getToggle()?.disabled).toBe(false);
      expect(getToggle()?.checked).toBe(true);
      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
      expect(document.querySelector(".app-version")?.textContent).toBe("v-");
      versionRead.resolve("2.5.0");
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector(".app-version")?.textContent).toBe("v2.5.0");
    });

    it("retains loaded settings when version lookup fails", async () => {
      mockApi.app.getVersion.mockRejectedValueOnce(new Error("version unavailable"));
      mockApi.settings.get.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, preventSleep: true });

      await bootRenderer();
      await vi.advanceTimersByTimeAsync(16);

      expect(document.querySelector(".app-version")?.textContent).toBe("v-");
      expect(getToggle()?.disabled).toBe(false);
      expect(getToggle()?.checked).toBe(true);
    });

    it("recovers from a failed settings read via push without replaying a write", async () => {
      mockApi.settings.get.mockRejectedValueOnce(new Error("settings unavailable"));
      await bootRenderer();
      await vi.advanceTimersByTimeAsync(16);
      expect(getToggle()?.disabled).toBe(true);
      expect(getErrorText()).toBe(ERROR_SETTINGS_UNAVAILABLE);

      mockApi.onSettingsChanged.mock.calls[0]?.[0]({ ...DEFAULT_SETTINGS, preventSleep: true });
      await vi.advanceTimersByTimeAsync(16);

      expect(getToggle()?.disabled).toBe(false);
      expect(getToggle()?.checked).toBe(true);
      expect(getErrorText()).toBe("");
      expect(mockApi.settings.set).not.toHaveBeenCalled();
    });

    it("retries unavailable settings on the next show without duplicating subscriptions", async () => {
      mockApi.settings.get
        .mockRejectedValueOnce(new Error("settings unavailable"))
        .mockResolvedValueOnce({ ...DEFAULT_SETTINGS, preventSleep: true });
      await bootRenderer();
      mockApi.onWindowHide.mock.calls[0]?.[0]();

      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(16);

      expect(mockApi.settings.get).toHaveBeenCalledTimes(2);
      expect(mockApi.onSettingsChanged).toHaveBeenCalledOnce();
      expect(mockApi.onSessionStatusUpdate).toHaveBeenCalledOnce();
      expect(mockApi.onWindowHide).toHaveBeenCalledOnce();
      expect(getToggle()?.checked).toBe(true);
      expect(getToggle()?.disabled).toBe(false);
    });

    it("does not replace a newer settings push with a stale initial read", async () => {
      const settingsRead = Promise.withResolvers<AppSettings>();
      mockApi.settings.get.mockReturnValueOnce(settingsRead.promise);
      await bootRenderer();

      mockApi.onSettingsChanged.mock.calls[0]?.[0]({ ...DEFAULT_SETTINGS, preventSleep: true });
      settingsRead.resolve({ ...DEFAULT_SETTINGS, preventSleep: false });
      await vi.advanceTimersByTimeAsync(16);

      expect(getToggle()?.checked).toBe(true);
      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
    });

    it("recovers a failed session read with a timed-session push and keeps its ticker visible-only", async () => {
      mockApi.session.getStatus.mockRejectedValueOnce(new Error("session unavailable"));
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      await bootRenderer();
      expect(setIntervalSpy).not.toHaveBeenCalled();

      mockApi.onSessionStatusUpdate.mock.calls[0]?.[0](timedSessionStatus());
      await vi.advanceTimersByTimeAsync(16);
      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
      expect(getTimerText()).toContain("25m remaining");
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      mockApi.onWindowHide.mock.calls[0]?.[0]();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not replace a newer session push with a stale initial status response", async () => {
      const sessionRead = Promise.withResolvers<SessionStatusResponse | null>();
      mockApi.session.getStatus.mockReturnValueOnce(sessionRead.promise);
      await bootRenderer();

      mockApi.onSessionStatusUpdate.mock.calls[0]?.[0](timedSessionStatus());
      sessionRead.resolve(null);
      await vi.advanceTimersByTimeAsync(16);

      expect(getTimerText()).toContain("25m remaining");
      expect(document.getElementById("cancel-session-action")).not.toBeNull();
    });

    it("retries a failed session read on the next show without duplicating its subscription", async () => {
      mockApi.session.getStatus
        .mockRejectedValueOnce(new Error("session unavailable"))
        .mockResolvedValueOnce(timedSessionStatus());
      await bootRenderer();
      mockApi.onWindowHide.mock.calls[0]?.[0]();

      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(16);

      expect(mockApi.session.getStatus).toHaveBeenCalledTimes(2);
      expect(mockApi.onSessionStatusUpdate).toHaveBeenCalledOnce();
      expect(getTimerText()).toContain("25m remaining");
      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
    });
  });

  describe("preference writes", () => {
    it("serializes rapid changes and paints only acknowledged preference values", async () => {
      const first = Promise.withResolvers<{ settings: AppSettings; rejectedKeys: string[] }>();
      const second = Promise.withResolvers<{ settings: AppSettings; rejectedKeys: string[] }>();
      mockApi.settings.get.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, preventSleep: true });
      mockApi.settings.set.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      await bootRenderer();
      const toggle = getToggle();
      expect(toggle?.checked).toBe(true);

      if (toggle) {
        toggle.checked = false;
        toggle.dispatchEvent(new Event("change"));
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change"));
      }
      await vi.advanceTimersByTimeAsync(16);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);
      expect(getToggle()?.checked).toBe(true);
      first.resolve({ settings: { ...DEFAULT_SETTINGS, preventSleep: false }, rejectedKeys: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockApi.settings.set).toHaveBeenNthCalledWith(2, { preventSleep: true });
      second.resolve({ settings: { ...DEFAULT_SETTINGS, preventSleep: true }, rejectedKeys: [] });
      await vi.advanceTimersByTimeAsync(16);
      expect(getToggle()?.checked).toBe(true);
      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
    });

    it("does not let an older write acknowledgement erase a newer settings push", async () => {
      const write = Promise.withResolvers<{ settings: AppSettings; rejectedKeys: string[] }>();
      mockApi.settings.set.mockReturnValueOnce(write.promise);
      await bootRenderer();
      const toggle = getToggle();
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change"));
      }
      mockApi.onSettingsChanged.mock.calls[0]?.[0]({ ...DEFAULT_SETTINGS, preventSleep: true });

      write.resolve({ settings: { ...DEFAULT_SETTINGS, preventSleep: false }, rejectedKeys: [] });
      await vi.advanceTimersByTimeAsync(16);

      expect(getToggle()?.checked).toBe(true);
      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
    });

    it("reconciles a rejected promise by reading main state without replaying the write", async () => {
      mockApi.settings.set.mockRejectedValueOnce(new Error("disk error"));
      mockApi.settings.get
        .mockResolvedValueOnce({ ...DEFAULT_SETTINGS, preventSleep: false })
        .mockResolvedValueOnce({ ...DEFAULT_SETTINGS, preventSleep: false });
      await bootRenderer();
      const toggle = getToggle();
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change"));
      }
      await vi.advanceTimersByTimeAsync(16);

      expect(getToggle()?.checked).toBe(false);
      expect(getStatusText()).toBe(STATUS_SLEEP_PREVENTION_OFF);
      expect(getErrorText()).toBe(ERROR_PREFERENCE_SAVE_FAILED);
      expect(mockApi.settings.get).toHaveBeenCalledTimes(2);
      expect(mockApi.settings.set).toHaveBeenCalledOnce();
    });

    it("shows rejection and uses returned settings when preventSleep is in rejectedKeys", async () => {
      mockApi.settings.set.mockResolvedValueOnce({
        settings: { ...DEFAULT_SETTINGS, preventSleep: false },
        rejectedKeys: ["preventSleep"],
      });
      await bootRenderer();
      const toggle = getToggle();
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change"));
      }
      await vi.advanceTimersByTimeAsync(16);

      expect(getToggle()?.checked).toBe(false);
      expect(getErrorText()).toBe(ERROR_PREFERENCE_SAVE_FAILED);
      expect(mockApi.settings.set).toHaveBeenCalledOnce();
    });

    it("does not replay a queued preference when its first write was rejected", async () => {
      const write = Promise.withResolvers<{ settings: AppSettings; rejectedKeys: string[] }>();
      mockApi.settings.get.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, preventSleep: true });
      mockApi.settings.set.mockReturnValueOnce(write.promise);
      await bootRenderer();
      const toggle = getToggle();
      if (toggle) {
        toggle.checked = false;
        toggle.dispatchEvent(new Event("change"));
        toggle.checked = false;
        toggle.dispatchEvent(new Event("change"));
      }

      write.resolve({
        settings: { ...DEFAULT_SETTINGS, preventSleep: true },
        rejectedKeys: ["preventSleep"],
      });
      await vi.advanceTimersByTimeAsync(16);

      expect(mockApi.settings.set).toHaveBeenCalledOnce();
      expect(getToggle()?.checked).toBe(true);
      expect(getErrorText()).toBe(ERROR_PREFERENCE_SAVE_FAILED);
    });

    it("reconciles a failed write even while an invalidated startup read is pending", async () => {
      const startupRead = Promise.withResolvers<AppSettings>();
      mockApi.settings.get
        .mockReturnValueOnce(startupRead.promise)
        .mockResolvedValueOnce({ ...DEFAULT_SETTINGS, preventSleep: true });
      mockApi.settings.set.mockRejectedValueOnce(new Error("write failed"));
      await bootRenderer();
      mockApi.onSettingsChanged.mock.calls[0]?.[0]({ ...DEFAULT_SETTINGS, preventSleep: false });
      await vi.advanceTimersByTimeAsync(16);
      const toggle = getToggle();
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change"));
      }
      await vi.advanceTimersByTimeAsync(16);

      expect(mockApi.settings.get).toHaveBeenCalledTimes(2);
      startupRead.resolve({ ...DEFAULT_SETTINGS, preventSleep: false });
      await vi.advanceTimersByTimeAsync(16);
      expect(getToggle()?.checked).toBe(true);
      expect(getErrorText()).toBe(ERROR_PREFERENCE_SAVE_FAILED);
    });

    it("disables the toggle if reconciliation after a rejected write also fails", async () => {
      mockApi.settings.set.mockRejectedValueOnce(new Error("write failed"));
      mockApi.settings.get
        .mockResolvedValueOnce({ ...DEFAULT_SETTINGS, preventSleep: false })
        .mockRejectedValueOnce(new Error("read failed"));
      await bootRenderer();
      const toggle = getToggle();
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change"));
      }
      await vi.advanceTimersByTimeAsync(16);

      expect(getToggle()?.disabled).toBe(true);
      expect(getStatusText()).toBe(STATUS_UNAVAILABLE);
      expect(getErrorText()).toBe(ERROR_PREFERENCE_SAVE_FAILED);
    });
  });

  describe("unload", () => {
    it("unsubscribes, cancels countdown and RAF, and ignores late reads and pushes", async () => {
      const settingsRead = Promise.withResolvers<AppSettings>();
      const versionRead = Promise.withResolvers<string>();
      mockApi.settings.get.mockReturnValueOnce(settingsRead.promise);
      mockApi.app.getVersion.mockReturnValueOnce(versionRead.promise);
      const unsubscribeSettings = vi.fn();
      const unsubscribeSession = vi.fn();
      const unsubscribeHide = vi.fn();
      mockApi.onSettingsChanged.mockReturnValueOnce(unsubscribeSettings);
      mockApi.onSessionStatusUpdate.mockReturnValueOnce(unsubscribeSession);
      mockApi.onWindowHide.mockReturnValueOnce(unsubscribeHide);
      const cancelRaf = vi.spyOn(globalThis, "cancelAnimationFrame");
      await bootRenderer();
      const statusPush = mockApi.onSessionStatusUpdate.mock.calls[0]?.[0];
      statusPush?.(timedSessionStatus());
      window.dispatchEvent(new Event("beforeunload"));
      const appHtml = document.getElementById("app")?.innerHTML;

      settingsRead.resolve({ ...DEFAULT_SETTINGS, preventSleep: true });
      versionRead.resolve("3.0.0");
      statusPush?.(timedSessionStatus());
      await vi.advanceTimersByTimeAsync(32);

      expect(unsubscribeSettings).toHaveBeenCalledOnce();
      expect(unsubscribeSession).toHaveBeenCalledOnce();
      expect(unsubscribeHide).toHaveBeenCalledOnce();
      expect(cancelRaf).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(document.getElementById("app")?.innerHTML).toBe(appHtml);
    });

    it("does not paint an acknowledgement that resolves after unload", async () => {
      const write = Promise.withResolvers<{ settings: AppSettings; rejectedKeys: string[] }>();
      mockApi.settings.set.mockReturnValueOnce(write.promise);
      await bootRenderer();
      const toggle = getToggle();
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change"));
      }
      window.dispatchEvent(new Event("beforeunload"));
      const appHtml = document.getElementById("app")?.innerHTML;

      write.resolve({ settings: { ...DEFAULT_SETTINGS, preventSleep: true }, rejectedKeys: [] });
      await vi.advanceTimersByTimeAsync(32);

      expect(document.getElementById("app")?.innerHTML).toBe(appHtml);
      expect(mockApi.settings.set).toHaveBeenCalledOnce();
    });

    it("does not restart the ticker when a stale session read finishes after unload", async () => {
      const sessionRead = Promise.withResolvers<SessionStatusResponse | null>();
      mockApi.session.getStatus.mockReturnValueOnce(sessionRead.promise);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      await bootRenderer();
      mockApi.onSessionStatusUpdate.mock.calls[0]?.[0](timedSessionStatus());
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      window.dispatchEvent(new Event("beforeunload"));

      sessionRead.resolve(null);
      await vi.advanceTimersByTimeAsync(16);

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("resize", () => {
    it("calls window.api.window.setHeight after render", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      // requestAnimationFrame needs to fire
      await vi.advanceTimersByTimeAsync(16);

      expect(mockApi.window.setHeight).toHaveBeenCalled();
    });
  });

  describe("countdown ticker", () => {
    it("keeps a pending settings repaint when a countdown tick lands before its frame", async () => {
      mockApi.session.getStatus.mockResolvedValue(timedSessionStatus(24 * 60 + 1));
      await bootRenderer();
      await vi.advanceTimersByTimeAsync(16);

      setTimeout(() => {
        mockApi.onSettingsChanged.mock.calls[0]?.[0]({ ...DEFAULT_SETTINGS, preventSleep: true });
      }, 983);
      await vi.advanceTimersByTimeAsync(1000);

      expect(getTimerText()).toContain("24m remaining");
      expect(getToggle()?.checked).toBe(true);
      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
    });

    it("does not create a countdown interval on idle init", async () => {
      // Given: no timed session exists when the popover initializes.
      mockApi.session.getStatus.mockResolvedValue(null);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      // When: the renderer initializes.
      await bootRenderer();

      // Then: no countdown interval is scheduled for idle state.
      expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it("creates exactly one interval for visible timed init and updates through the timer path", async () => {
      // Given: a visible popover starts with a timed session.
      mockApi.session.getStatus.mockResolvedValue(timedSessionStatus());
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      // When: the renderer initializes and the countdown interval ticks.
      await bootRenderer();
      await vi.advanceTimersByTimeAsync(16);
      expect(getTimerText()).toContain("25m remaining");
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(16);

      // Then: exactly one interval exists and the existing timer path updates the label.
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(getTimerText()).toContain("24m remaining");
    });

    it("clears on hide and resumes exactly one interval for a timed session", async () => {
      // Given: a timed session initialized with one countdown interval.
      mockApi.session.getStatus.mockResolvedValue(timedSessionStatus());
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      await bootRenderer();
      expect(setIntervalSpy).toHaveBeenCalledOnce();

      // When: the popover hides, then becomes visible again twice.
      const windowHideCallback = mockApi.onWindowHide.mock.calls[0]?.[0];
      expect(windowHideCallback).toBeDefined();
      windowHideCallback?.();
      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));

      // Then: hide clears once and visible resume schedules only one replacement interval.
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    });

    it("starts the ticker when a timed-session push arrives while visible and no ticker exists", async () => {
      // Given: the popover is visible with no timed session and no countdown interval.
      mockApi.session.getStatus.mockResolvedValue(null);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      await bootRenderer();
      const windowHideCallback = mockApi.onWindowHide.mock.calls[0]?.[0];
      expect(windowHideCallback).toBeDefined();
      windowHideCallback?.();
      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      setIntervalSpy.mockClear();

      // When: a timed-session status push arrives while the popover is visible.
      const sessionCallback = mockApi.onSessionStatusUpdate.mock.calls[0]?.[0];
      expect(sessionCallback).toBeDefined();
      sessionCallback?.(timedSessionStatus());

      // Then: the push starts exactly one countdown interval.
      expect(setIntervalSpy).toHaveBeenCalledOnce();
    });
  });
  describe("push subscriptions", () => {
    it("subscribes to onSettingsChanged on init", async () => {
      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockApi.onSettingsChanged).toHaveBeenCalledWith(expect.any(Function));
    });

    it("subscribes to onSessionStatusUpdate on init", async () => {
      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockApi.onSessionStatusUpdate).toHaveBeenCalledWith(expect.any(Function));
    });

    it("updates status when settings push arrives (preventSleep on)", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(getStatusText()).toBe(STATUS_SLEEP_PREVENTION_OFF);

      // Simulate push: preventSleep turned on
      const settingsCallback = mockApi.onSettingsChanged.mock.calls[0]![0];
      settingsCallback({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: true,
        defaultSessionDuration: null,
      });

      // Wait for rAF
      await vi.advanceTimersByTimeAsync(16);

      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
      expect(getStatusDot()?.classList.contains("active")).toBe(true);
    });

    it("updates timer when session status push arrives", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: true,
        defaultSessionDuration: 30,
      });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now()),
        expiresAt: asPerf(Date.now() + 25 * 60 * 1000),
        remainingSeconds: 1500,
        durationMinutes: 30,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      // Simulate session status push with updated remaining time
      const sessionCallback = mockApi.onSessionStatusUpdate.mock.calls[0]![0];
      sessionCallback({
        isRunning: true,
        startedAt: asPerf(Date.now()),
        expiresAt: asPerf(Date.now() + 10 * 60 * 1000),
        remainingSeconds: 600,
        durationMinutes: 30,
      });

      await vi.advanceTimersByTimeAsync(16);

      const text = getTimerText();
      expect(text).toContain("Timer");
      expect(text).toContain("m remaining");
    });

    it("keeps session active when preventSleep is turned off via push while session running", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: true,
        defaultSessionDuration: 30,
      });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now()),
        expiresAt: asPerf(Date.now() + 25 * 60 * 1000),
        remainingSeconds: 1500,
        durationMinutes: 30,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      // Turn off preventSleep via push — session still running
      const settingsCallback = mockApi.onSettingsChanged.mock.calls[0]![0];
      settingsCallback({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      });

      await vi.advanceTimersByTimeAsync(16);

      // Effective active state stays true while session.isRunning is true.
      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
      expect(getStatusDot()?.classList.contains("active")).toBe(true);
      const text = getTimerText();
      expect(text).toContain("Timer");
      expect(text).toContain("m remaining");
    });

    it("shows active status and remaining timer for running timed session even when preventSleep is false", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: 30,
      });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now()),
        expiresAt: asPerf(Date.now() + 20 * 60 * 1000),
        remainingSeconds: 1200,
        durationMinutes: 30,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(getStatusDot()?.classList.contains("active")).toBe(true);
      expect(getStatusText()).toBe(STATUS_PREVENTING_SLEEP);
      const text = getTimerText();
      expect(text).toContain("Timer");
      expect(text).toContain("m remaining");
    });

    it("fetches session.getStatus during init even when preventSleep is false", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      });
      mockApi.session.getStatus.mockResolvedValue(null);

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockApi.session.getStatus).toHaveBeenCalled();
    });
  });

  describe("session action subtree stability", () => {
    it("preserves cancel-button node identity across same-mode status pushes and ticks", async () => {
      mockApi.session.getStatus.mockResolvedValue(timedSessionStatus(30 * 60));
      mockApi.session.cancel.mockResolvedValue({ cancelled: true });
      await bootRenderer();
      await vi.advanceTimersByTimeAsync(16);

      const cancelBefore = document.getElementById("cancel-session-action");
      expect(cancelBefore).not.toBeNull();

      const sessionCallback = mockApi.onSessionStatusUpdate.mock.calls[0]?.[0];
      expect(sessionCallback).toBeDefined();
      // Same running mode with updated remaining — must not rebuild actions.
      sessionCallback?.(timedSessionStatus(29 * 60));
      await vi.advanceTimersByTimeAsync(16);
      sessionCallback?.(timedSessionStatus(28 * 60));
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(16);

      const cancelAfter = document.getElementById("cancel-session-action");
      expect(cancelAfter).toBe(cancelBefore);

      cancelAfter?.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockApi.session.cancel).toHaveBeenCalledTimes(1);
    });

    it("replaces chips with cancel on idle→running and restores chips on running→idle", async () => {
      mockApi.session.getStatus.mockResolvedValue(null);
      mockApi.session.start.mockResolvedValue({
        ok: true,
        startedAt: Date.now(),
        durationMinutes: 30,
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      await bootRenderer();
      await vi.advanceTimersByTimeAsync(16);

      const chipsBefore = document.querySelectorAll(".session-chip:not(.session-chip--cancel)");
      expect(chipsBefore.length).toBeGreaterThan(0);
      expect(document.getElementById("cancel-session-action")).toBeNull();

      const sessionCallback = mockApi.onSessionStatusUpdate.mock.calls[0]?.[0];
      sessionCallback?.(timedSessionStatus());
      await vi.advanceTimersByTimeAsync(16);
      expect(document.getElementById("cancel-session-action")).not.toBeNull();
      expect(document.querySelectorAll(".session-chip:not(.session-chip--cancel)").length).toBe(0);

      sessionCallback?.({
        isRunning: false,
        startedAt: null,
        expiresAt: null,
        remainingSeconds: null,
        durationMinutes: null,
      });
      await vi.advanceTimersByTimeAsync(16);
      expect(document.getElementById("cancel-session-action")).toBeNull();
      expect(
        document.querySelectorAll(".session-chip:not(.session-chip--cancel)").length,
      ).toBeGreaterThan(0);
    });

    it("chip click invokes session.start exactly once via delegation", async () => {
      mockApi.session.getStatus.mockResolvedValue(null);
      mockApi.session.start.mockResolvedValue({
        ok: true,
        startedAt: Date.now(),
        durationMinutes: 15,
        expiresAt: Date.now() + 15 * 60 * 1000,
      });
      await bootRenderer();
      await vi.advanceTimersByTimeAsync(16);

      const chip = document.querySelector<HTMLButtonElement>('.session-chip[data-duration="15"]');
      expect(chip).not.toBeNull();
      chip?.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockApi.session.start).toHaveBeenCalledTimes(1);
      expect(mockApi.session.start).toHaveBeenCalledWith(15);
    });

    it("duplicate hide signals clear countdown only once", async () => {
      mockApi.session.getStatus.mockResolvedValue(timedSessionStatus());
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      await bootRenderer();
      await vi.advanceTimersByTimeAsync(16);

      const intervalId = setIntervalSpy.mock.results[0]?.value as ReturnType<typeof setInterval>;
      expect(intervalId).toBeDefined();
      clearIntervalSpy.mockClear();

      const windowHideCallback = mockApi.onWindowHide.mock.calls[0]?.[0];
      expect(windowHideCallback).toBeDefined();
      windowHideCallback?.();
      // First hide clears the countdown interval exactly once.
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
      const clearsAfterFirstHide = clearIntervalSpy.mock.calls.filter(
        (c) => c[0] === intervalId,
      ).length;
      expect(clearsAfterFirstHide).toBe(1);

      setDocumentVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      windowHideCallback?.();

      // Duplicate hide / visibilitychange must not clear the same interval again.
      const clearsAfterDupes = clearIntervalSpy.mock.calls.filter(
        (c) => c[0] === intervalId,
      ).length;
      expect(clearsAfterDupes).toBe(1);
    });
  });

  describe("session display", () => {
    it("renders seconds when less than a minute", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: true,
        defaultSessionDuration: 15,
      });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now() - 14 * 60 * 1000),
        expiresAt: asPerf(Date.now() + 45 * 1000),
        remainingSeconds: 45,
        durationMinutes: 15,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const text = getTimerText();
      expect(text).toContain("Timer");
      // 45 seconds rounds up to 1 minute
      expect(text).toContain("m remaining");
    });

    it("renders zero remaining as 0m", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: true,
        defaultSessionDuration: 15,
      });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now() - 15 * 60 * 1000),
        expiresAt: asPerf(Date.now()),
        remainingSeconds: 0,
        durationMinutes: 15,
      });

      vi.resetModules();
      await import("../../src/renderer/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const text = getTimerText();
      expect(text).toContain("Timer");
      expect(text).toContain("0m remaining");
    });
  });
});
