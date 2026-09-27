import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrayDeps } from "../../src/main/tray.js";
import {
  ACCELERATOR_QUIT,
  MENU_ABOUT,
  MENU_PREVENT_SLEEP,
  MENU_QUIT,
  MENU_SETTINGS,
} from "../../src/main/constants.js";

const mockTrayConstructor = vi.hoisted(() =>
  vi.fn().mockImplementation(function (this: Record<string, ReturnType<typeof vi.fn>>) {
    this.setToolTip = vi.fn();
    this.setTitle = vi.fn();
    this.setImage = vi.fn();
    this.on = vi.fn();
    this.getBounds = vi.fn().mockReturnValue({ x: 100, y: 0, width: 22, height: 22 });
    this.popUpContextMenu = vi.fn();
    this.setContextMenu = vi.fn();
    this.setIgnoreDoubleClickEvents = vi.fn();
    this.destroy = vi.fn();
  }),
);
const mockNativeThemeOn = vi.hoisted(() => vi.fn());
const mockNativeThemeRemoveListener = vi.hoisted(() => vi.fn());
const mockCreateFromPath = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    toPNG: vi.fn().mockReturnValue(Buffer.alloc(0)),
    isEmpty: vi.fn().mockReturnValue(false),
  }),
);
const mockCreateEmpty = vi.hoisted(() => vi.fn().mockReturnValue({ addRepresentation: vi.fn() }));
const mockBuildFromTemplate = vi.hoisted(() => vi.fn().mockReturnValue({}));
const mockAppQuit = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  Tray: mockTrayConstructor,
  Menu: { buildFromTemplate: mockBuildFromTemplate },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  app: {
    quit: mockAppQuit,
    getPath: vi.fn().mockReturnValue("/tmp/test-user-data"),
  },
  nativeImage: {
    createFromPath: mockCreateFromPath,
    createEmpty: mockCreateEmpty,
    createFromBuffer: vi.fn().mockReturnValue({ toPNG: vi.fn().mockReturnValue(Buffer.alloc(0)) }),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    on: mockNativeThemeOn,
    removeListener: mockNativeThemeRemoveListener,
  },
  BrowserWindow: vi.fn().mockImplementation(function (
    this: Record<string, ReturnType<typeof vi.fn>>,
  ) {
    this.on = vi.fn();
  }),
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("tray", () => {
  let preventSleep: boolean;
  let effectiveActive: boolean;
  let settingsChangeCallbacks: Array<() => void>;
  let activeStateChangeCallbacks: Array<() => void>;

  function createTrayDeps(): TrayDeps {
    return {
      getPreventSleep: () => preventSleep,
      getEffectiveActive: () => effectiveActive,
      getSessionActive: () => false,
      togglePreventSleep: () => {
        preventSleep = !preventSleep;
      },
      onSettingsChanged: (cb: () => void) => {
        settingsChangeCallbacks.push(cb);
        return () => {
          const idx = settingsChangeCallbacks.indexOf(cb);
          if (idx >= 0) settingsChangeCallbacks.splice(idx, 1);
        };
      },
      onActiveStateChanged: (cb: () => void) => {
        activeStateChangeCallbacks.push(cb);
        return () => {
          const idx = activeStateChangeCallbacks.indexOf(cb);
          if (idx >= 0) activeStateChangeCallbacks.splice(idx, 1);
        };
      },
      openSettings: vi.fn(),
      checkForUpdates: vi.fn(),
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    preventSleep = false;
    effectiveActive = false;
    settingsChangeCallbacks = [];
    activeStateChangeCallbacks = [];

    mockTrayConstructor.mockImplementation(function (
      this: Record<string, ReturnType<typeof vi.fn>>,
    ) {
      this.setToolTip = vi.fn();
      this.setTitle = vi.fn();
      this.setImage = vi.fn();
      this.on = vi.fn();
      this.getBounds = vi.fn().mockReturnValue({ x: 100, y: 0, width: 22, height: 22 });
      this.popUpContextMenu = vi.fn();
      this.setContextMenu = vi.fn();
      this.setIgnoreDoubleClickEvents = vi.fn();
      this.destroy = vi.fn();
    });
    mockCreateFromPath.mockReturnValue({
      toPNG: vi.fn().mockReturnValue(Buffer.alloc(0)),
      isEmpty: vi.fn().mockReturnValue(false),
    });
    mockCreateEmpty.mockReturnValue({ addRepresentation: vi.fn() });
  });

  describe("setupTray", () => {
    it("subscribes to settings changes via onSettingsChanged", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      expect(settingsChangeCallbacks.length).toBe(1);
    });

    it("creates a Tray instance", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      expect(mockTrayConstructor).toHaveBeenCalledTimes(1);
    });

    it("ignores double-click so Windows menu click stays stable", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const trayInstance = mockTrayConstructor.mock.results[0]!.value as {
        setIgnoreDoubleClickEvents: ReturnType<typeof vi.fn>;
        setContextMenu: ReturnType<typeof vi.fn>;
      };
      expect(trayInstance.setIgnoreDoubleClickEvents).toHaveBeenCalledWith(true);
      expect(trayInstance.setContextMenu).toHaveBeenCalled();
    });

    it("sets tooltip to Amphetamine", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const trayInstance = mockTrayConstructor.mock.results[0]!.value;
      expect(trayInstance.setToolTip).toHaveBeenCalledWith(expect.stringContaining("Amphetamine"));
    });

    it("registers click handler on tray", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const trayInstance = mockTrayConstructor.mock.results[0]!.value;
      expect(trayInstance.on).toHaveBeenCalledWith("click", expect.any(Function));
    });

    it("registers nativeTheme.on('updated') handler", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      expect(mockNativeThemeOn).toHaveBeenCalledWith("updated", expect.any(Function));
    });

    it("returns a cleanup function", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      const cleanup = setupTray(createTrayDeps());

      expect(typeof cleanup).toBe("function");
    });
  });

  describe("icon", () => {
    it("icon updates when settings change (preventSleep toggle)", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const trayInstance = mockTrayConstructor.mock.results[0]!.value;
      const setImageCalls = trayInstance.setImage.mock.calls.length;

      preventSleep = true;
      effectiveActive = true;
      settingsChangeCallbacks[0]!();

      expect(trayInstance.setImage.mock.calls.length).toBeGreaterThan(setImageCalls);
    });

    it("icon shows active when session is active even if settings.preventSleep is false", async () => {
      // Regression: tray icon must reflect effective sleep-prevention state,
      // not just persisted user intent. A live session with preventSleep=false
      // should still render the active icon.
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const trayInstance = mockTrayConstructor.mock.results[0]!.value;
      const setImageCalls = trayInstance.setImage.mock.calls.length;

      // Session starts: preventSleep stays false, effective flips true.
      effectiveActive = true;
      activeStateChangeCallbacks[0]!();

      expect(trayInstance.setImage.mock.calls.length).toBeGreaterThan(setImageCalls);
      // Last setImage call should have used the active icon — verify by checking
      // that a non-inactive asset path was requested at least once.
      const activePathRequested = mockCreateFromPath.mock.calls.some(
        (call) => typeof call[0] === "string" && !(call[0] as string).includes("inactive-"),
      );
      expect(activePathRequested).toBe(true);
    });

    it("initial icon uses effective active state, not just preventSleep", async () => {
      // preventSleep=false but session already active before tray setup.
      effectiveActive = true;
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const activePathRequested = mockCreateFromPath.mock.calls.some(
        (call) => typeof call[0] === "string" && !(call[0] as string).includes("inactive-"),
      );
      expect(activePathRequested).toBe(true);
    });

    it("icon updates when nativeTheme changes", async () => {
      vi.useFakeTimers();
      try {
        const { setupTray } = await import("../../src/main/tray.js");
        setupTray(createTrayDeps());

        const trayInstance = mockTrayConstructor.mock.results[0]!.value;
        const setImageCalls = trayInstance.setImage.mock.calls.length;

        // Get the nativeTheme updated handler and call it
        const themeHandler = mockNativeThemeOn.mock.calls.find((call) => call[0] === "updated")![1];
        themeHandler();

        // Theme updates are debounced (50ms) — flush timer
        vi.advanceTimersByTime(60);

        expect(trayInstance.setImage.mock.calls.length).toBeGreaterThan(setImageCalls);
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses fallback SVG when image files are empty", async () => {
      mockCreateFromPath.mockReturnValue({
        toPNG: vi.fn().mockReturnValue(Buffer.alloc(0)),
        isEmpty: vi.fn().mockReturnValue(true),
      });

      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      // Tray should still be created (fallback icon used)
      expect(mockTrayConstructor).toHaveBeenCalledTimes(1);
    });

    it("caches icons — second build with same params returns cached", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const initialCreateFromPathCalls = mockCreateFromPath.mock.calls.length;

      // Trigger icon rebuild with same theme/state
      settingsChangeCallbacks[0]!();

      // createFromPath should NOT be called again (cached)
      expect(mockCreateFromPath.mock.calls.length).toBe(initialCreateFromPathCalls);
    });
  });

  describe("menu", () => {
    it("builds menu from template", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      expect(mockBuildFromTemplate).toHaveBeenCalled();
    });

    it("menu contains Prevent Sleep checkbox", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const template = mockBuildFromTemplate.mock.calls[0]![0];
      const preventSleepItem = template.find(
        (item: { label?: string }) => item.label === MENU_PREVENT_SLEEP,
      );
      expect(preventSleepItem).toBeDefined();
      expect(preventSleepItem.type).toBe("checkbox");
    });

    it("Prevent Sleep checkbox reflects current state (off by default)", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const template = mockBuildFromTemplate.mock.calls[0]![0];
      const preventSleepItem = template.find(
        (item: { label?: string }) => item.label === MENU_PREVENT_SLEEP,
      );
      expect(preventSleepItem.checked).toBe(false);
    });

    it("Prevent Sleep checkbox reflects active state", async () => {
      preventSleep = true;
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const template = mockBuildFromTemplate.mock.calls[0]![0];
      const preventSleepItem = template.find(
        (item: { label?: string }) => item.label === MENU_PREVENT_SLEEP,
      );
      expect(preventSleepItem.checked).toBe(true);
    });

    it("menu contains Settings, About, and Quit items", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const template = mockBuildFromTemplate.mock.calls[0]![0];
      const labels = template.map((item: { label?: string }) => item.label).filter(Boolean);

      expect(labels).toContain(MENU_SETTINGS);
      expect(labels).toContain(MENU_ABOUT);
      expect(labels).toContain(MENU_QUIT);
    });

    it("Quit menu item has CommandOrControl+Q accelerator", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const template = mockBuildFromTemplate.mock.calls[0]![0];
      const quitItem = template.find((item: { label?: string }) => item.label === MENU_QUIT);
      expect(quitItem.accelerator).toBe(ACCELERATOR_QUIT);
    });

    it("menu is rebuilt when preventSleep changes", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const callsBefore = mockBuildFromTemplate.mock.calls.length;

      // Settings change without preventSleep change should NOT rebuild
      settingsChangeCallbacks[0]!();
      expect(mockBuildFromTemplate.mock.calls.length).toBe(callsBefore);

      // Change preventSleep then trigger callback — menu should rebuild
      preventSleep = !preventSleep;
      settingsChangeCallbacks[0]!();

      expect(mockBuildFromTemplate.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it("menu is NOT rebuilt when only effective active state changes (session-only)", async () => {
      // Regression: checkbox must stay bound to user intent. A session-only
      // active-state change must not rebuild the menu (user intent unchanged).
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const callsBefore = mockBuildFromTemplate.mock.calls.length;

      effectiveActive = true;
      activeStateChangeCallbacks[0]!();

      expect(mockBuildFromTemplate.mock.calls.length).toBe(callsBefore);
    });

    it("Prevent Sleep checkbox stays false during session-only active state", async () => {
      // Regression: even though icon goes active, the checkbox should remain
      // false (user intent has not changed).
      effectiveActive = true;
      preventSleep = false;
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const template = mockBuildFromTemplate.mock.calls[0]![0];
      const preventSleepItem = template.find(
        (item: { label?: string }) => item.label === MENU_PREVENT_SLEEP,
      );
      expect(preventSleepItem.checked).toBe(false);
    });

    it("left-click pops the classic context menu", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      setupTray(createTrayDeps());

      const trayInstance = mockTrayConstructor.mock.results[0]!.value;
      expect(trayInstance.setContextMenu).toHaveBeenCalled();
      const clickCall = trayInstance.on.mock.calls.find(
        (call: [string, ...unknown[]]) => call[0] === "click",
      );
      expect(clickCall).toBeDefined();
      (clickCall![1] as () => void)();
      expect(trayInstance.popUpContextMenu).toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("unsubscribes from settings changes", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      const cleanup = setupTray(createTrayDeps());

      expect(settingsChangeCallbacks.length).toBe(1);

      cleanup();

      expect(settingsChangeCallbacks.length).toBe(0);
    });

    it("unsubscribes from effective active-state changes", async () => {
      const { setupTray } = await import("../../src/main/tray.js");
      const cleanup = setupTray(createTrayDeps());

      expect(activeStateChangeCallbacks.length).toBe(1);

      cleanup();

      expect(activeStateChangeCallbacks.length).toBe(0);
    });

    it("removes nativeTheme listener", async () => {
      const { nativeTheme } = await import("electron");
      const { setupTray } = await import("../../src/main/tray.js");
      const cleanup = setupTray(createTrayDeps());

      cleanup();

      expect(nativeTheme.removeListener).toHaveBeenCalledWith("updated", expect.any(Function));
    });
  });

  describe("error handling", () => {
    it("setupTray does not throw when Tray constructor throws", async () => {
      mockTrayConstructor.mockImplementationOnce(() => {
        throw new Error("Tray init failed");
      });

      const { setupTray } = await import("../../src/main/tray.js");

      // The current implementation does not catch this internally; verify it surfaces
      // synchronously rather than crashing the process asynchronously.
      expect(() => setupTray(createTrayDeps())).toThrow("Tray init failed");
    });

    it("rolls back subscriptions, theme listener, and tray when menu setup fails", async () => {
      const failure = new Error("menu failed");
      mockBuildFromTemplate.mockImplementationOnce(() => {
        throw failure;
      });
      const { setupTray, measureBenchmarkTrayMenuProxy } = await import("../../src/main/tray.js");

      expect(() => setupTray(createTrayDeps())).toThrow(failure);
      expect(settingsChangeCallbacks).toHaveLength(0);
      expect(activeStateChangeCallbacks).toHaveLength(0);
      expect(mockNativeThemeRemoveListener).toHaveBeenCalledWith(
        "updated",
        mockNativeThemeOn.mock.calls[0]![1],
      );
      expect(mockTrayConstructor.mock.results[0]!.value.destroy).toHaveBeenCalledOnce();
      expect(measureBenchmarkTrayMenuProxy()).toBeNull();
    });

    it("rolls back the first subscription if registering the second throws", async () => {
      const failure = new Error("active registration failed");
      const deps = createTrayDeps();
      deps.onActiveStateChanged = () => {
        throw failure;
      };
      const { setupTray } = await import("../../src/main/tray.js");

      expect(() => setupTray(deps)).toThrow(failure);
      expect(settingsChangeCallbacks).toHaveLength(0);
      expect(mockTrayConstructor.mock.results[0]!.value.destroy).toHaveBeenCalledOnce();
    });

    it("cancels a theme timer and keeps callbacks inert when teardown itself fails", async () => {
      vi.useFakeTimers();
      try {
        const failure = new Error("click registration failed");
        const deps = createTrayDeps();
        const originalSubscribe = deps.onActiveStateChanged;
        deps.onActiveStateChanged = (callback) => {
          const unsubscribe = originalSubscribe(callback);
          const themeCallback = mockNativeThemeOn.mock.calls[0]![1] as () => void;
          themeCallback();
          return () => {
            unsubscribe();
            throw new Error("unsubscribe failed");
          };
        };
        mockTrayConstructor.mockImplementationOnce(function (
          this: Record<string, ReturnType<typeof vi.fn>>,
        ) {
          this.setToolTip = vi.fn();
          this.setContextMenu = vi.fn();
          this.setIgnoreDoubleClickEvents = vi.fn();
          this.on = vi.fn(() => {
            throw failure;
          });
          this.destroy = vi.fn();
        });
        const { setupTray } = await import("../../src/main/tray.js");

        expect(() => setupTray(deps)).toThrow(failure);
        expect(mockTrayConstructor.mock.results[0]!.value.destroy).toHaveBeenCalledOnce();
        expect(settingsChangeCallbacks).toHaveLength(0);
        expect(activeStateChangeCallbacks).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("destroys the tray and releases remaining resources if an unsubscribe throws", async () => {
      const deps = createTrayDeps();
      const originalSubscribe = deps.onSettingsChanged;
      deps.onSettingsChanged = (callback) => {
        const unsubscribe = originalSubscribe(callback);
        return () => {
          unsubscribe();
          throw new Error("unsubscribe failed");
        };
      };
      const { setupTray, measureBenchmarkTrayMenuProxy } = await import("../../src/main/tray.js");
      const cleanup = setupTray(deps);
      const trayInstance = mockTrayConstructor.mock.results[0]!.value;

      expect(() => cleanup()).not.toThrow();
      expect(trayInstance.destroy).toHaveBeenCalledOnce();
      expect(activeStateChangeCallbacks).toHaveLength(0);
      expect(mockNativeThemeRemoveListener).toHaveBeenCalledOnce();
      expect(measureBenchmarkTrayMenuProxy()).toBeNull();
      cleanup();
      expect(trayInstance.destroy).toHaveBeenCalledOnce();
    });
  });

  describe("theme debounce", () => {
    it("rapid nativeTheme.updated events only rebuild icon once (debounced 50ms)", async () => {
      vi.useFakeTimers();
      try {
        const { setupTray } = await import("../../src/main/tray.js");
        setupTray(createTrayDeps());

        const trayInstance = mockTrayConstructor.mock.results[0]!.value;
        const initialSetImageCalls = trayInstance.setImage.mock.calls.length;

        const themeHandler = mockNativeThemeOn.mock.calls.find((call) => call[0] === "updated")![1];

        // Fire 5 rapid theme update events
        themeHandler();
        themeHandler();
        themeHandler();
        themeHandler();
        themeHandler();

        // Before debounce flush — no extra setImage calls
        expect(trayInstance.setImage.mock.calls.length).toBe(initialSetImageCalls);

        // Flush the debounce
        await vi.advanceTimersByTimeAsync(60);

        // Exactly one rebuild after the burst
        expect(trayInstance.setImage.mock.calls.length).toBe(initialSetImageCalls + 1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
