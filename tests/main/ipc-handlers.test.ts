import { describe, it, expect, vi, beforeEach } from "vitest";
import { IPC_CHANNELS, DEFAULT_SETTINGS } from "../../src/shared/types.js";

// Mock electron first - must be done before importing ipc
const mockGetVersion = vi.hoisted(() => vi.fn().mockReturnValue("1.0.0"));
const mockGetAppPath = vi.hoisted(() => vi.fn().mockReturnValue("/mock/app"));
const mockIpcMainHandle = vi.hoisted(() => vi.fn());
const mockIpcMainOn = vi.hoisted(() => vi.fn());
const mockIpcMainOff = vi.hoisted(() => vi.fn());
const mockIpcMainRemoveHandler = vi.hoisted(() => vi.fn());
const mockBrowserWindowGetAllWindows = vi.hoisted(() => vi.fn().mockReturnValue([]));

vi.mock("electron", () => ({
  app: {
    getVersion: mockGetVersion,
    getAppPath: mockGetAppPath,
  },
  ipcMain: {
    handle: mockIpcMainHandle,
    on: mockIpcMainOn,
    off: mockIpcMainOff,
    removeHandler: mockIpcMainRemoveHandler,
  },
  BrowserWindow: {
    getAllWindows: mockBrowserWindowGetAllWindows,
  },
}));

// Mock dependencies
const mockGetSettings = vi.fn().mockReturnValue({ ...DEFAULT_SETTINGS });
const mockUpdateSettings = vi
  .fn()
  .mockImplementation((partial: Partial<typeof DEFAULT_SETTINGS>) => ({
    ...DEFAULT_SETTINGS,
    ...partial,
  }));
const mockOnSettingsChanged = vi.fn();
const mockCreateSettingsWindow = vi.fn();
const mockStartSession = vi.fn().mockReturnValue({
  isRunning: true,
  startedAt: Date.now(),
  expiresAt: null,
  durationMinutes: null,
});
const mockCancelSession = vi.fn().mockReturnValue({
  isRunning: false,
  startedAt: null,
  expiresAt: null,
  durationMinutes: null,
});
const mockGetStatus = vi.fn().mockReturnValue({
  isRunning: false,
  startedAt: null,
  expiresAt: null,
  durationMinutes: null,
});

vi.mock("../../src/main/settings.js", () => ({
  getSettings: mockGetSettings,
  updateSettings: mockUpdateSettings,
  onSettingsChanged: mockOnSettingsChanged,
}));

vi.mock("../../src/main/settings-window.js", () => ({
  createSettingsWindow: mockCreateSettingsWindow,
}));

vi.mock("../../src/main/utils/packageInfo.js", () => ({
  getPackageInfo: () => ({
    productName: "Amphetamine",
    version: "1.0.0",
    description: "Keep awake",
    repository: "https://github.com/iworkforces/Amphetamine",
    author: "Test",
  }),
}));

vi.mock("../../src/main/session-timer.js", () => ({
  startSession: mockStartSession,
  cancelSession: mockCancelSession,
  getStatus: mockGetStatus,
}));

describe("ipc-handlers", () => {
  let registerIpcHandlers: (_win: unknown, _deps: unknown) => () => void;
  let registeredHandlers: Map<string, (..._args: unknown[]) => unknown>;

  function makeIpcDeps(): unknown {
    return {
      getSettings: mockGetSettings,
      updateSettings: mockUpdateSettings,
      createSettingsWindow: mockCreateSettingsWindow,
      registerAutoUpdaterIpc: vi.fn(() => vi.fn()),
      sessionTimer: {
        startSession: mockStartSession,
        cancelSession: mockCancelSession,
        getStatus: mockGetStatus,
      },
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Reset mock return values
    mockGetSettings.mockReturnValue({ ...DEFAULT_SETTINGS });
    mockUpdateSettings.mockImplementation((partial: Partial<typeof DEFAULT_SETTINGS>) => ({
      ...DEFAULT_SETTINGS,
      ...partial,
    }));
    mockGetStatus.mockReturnValue({
      isRunning: false,
      startedAt: null,
      expiresAt: null,
      durationMinutes: null,
    });
    mockBrowserWindowGetAllWindows.mockReturnValue([]);

    // Clear and setup handler registry
    registeredHandlers = new Map();
    mockIpcMainHandle.mockImplementation(
      (channel: string, handler: (..._args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, handler);
      },
    );
    mockIpcMainOn.mockImplementation(
      (channel: string, handler: (..._args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, handler);
      },
    );
    mockIpcMainOff.mockImplementation(
      (channel: string, handler: (..._args: unknown[]) => unknown) => {
        if (registeredHandlers.get(channel) === handler) registeredHandlers.delete(channel);
      },
    );
    mockIpcMainRemoveHandler.mockImplementation((channel: string) => {
      registeredHandlers.delete(channel);
    });

    // Import the module
    const mod = await import("../../src/main/ipc.js");
    registerIpcHandlers = (win, deps) =>
      (mod.registerIpcHandlers as unknown as (_win: unknown, _deps: unknown) => () => void)(
        { on: vi.fn(), removeListener: vi.fn(), ...(win as object) },
        deps,
      );
  });

  describe("registration lifetime", () => {
    it("unregisters public channels and pending resize once without touching private channels", async () => {
      vi.useFakeTimers();
      try {
        const privateHandler = vi.fn();
        registeredHandlers.set("utility-dialog:close", privateHandler);
        const mockWindow = { setSize: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
        const deps = {
          ...(makeIpcDeps() as object),
          registerAutoUpdaterIpc: () => {
            mockIpcMainHandle(IPC_CHANNELS.AUTO_UPDATER_CHECK, vi.fn());
            return () => mockIpcMainRemoveHandler(IPC_CHANNELS.AUTO_UPDATER_CHECK);
          },
        };
        const unregister = registerIpcHandlers(mockWindow, deps);
        const onClosed = mockWindow.on.mock.calls.find(([event]) => event === "closed")?.[1];
        const resize = registeredHandlers.get(IPC_CHANNELS.WINDOW_SET_HEIGHT);
        expect(registeredHandlers.has(IPC_CHANNELS.SESSION_STATUS)).toBe(true);
        expect(registeredHandlers.has(IPC_CHANNELS.AUTO_UPDATER_CHECK)).toBe(true);

        resize?.({ senderFrame: { url: "file:///mock/app/lib/renderer/index.html" } }, 320);
        unregister();
        unregister();
        onClosed?.();
        await vi.advanceTimersByTimeAsync(16);

        expect(registeredHandlers).toEqual(new Map([["utility-dialog:close", privateHandler]]));
        expect(mockIpcMainRemoveHandler).toHaveBeenCalledTimes(10);
        expect(mockIpcMainOff).toHaveBeenCalledExactlyOnceWith(
          IPC_CHANNELS.WINDOW_SET_HEIGHT,
          resize,
        );
        expect(mockWindow.removeListener).toHaveBeenCalledExactlyOnceWith("closed", onClosed);
        expect(mockWindow.setSize).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rolls back previously installed handlers when an invoke registration throws", () => {
      const registrationError = new Error("settings registration failed");
      mockIpcMainHandle.mockImplementation(
        (channel: string, handler: (..._args: unknown[]) => unknown) => {
          if (channel === IPC_CHANNELS.SETTINGS_SET) throw registrationError;
          registeredHandlers.set(channel, handler);
        },
      );
      const mockWindow = { on: vi.fn(), removeListener: vi.fn() };

      expect(() => registerIpcHandlers(mockWindow, makeIpcDeps())).toThrow(registrationError);

      expect(registeredHandlers.size).toBe(0);
      expect(mockIpcMainRemoveHandler.mock.calls.map(([channel]) => channel)).toEqual([
        IPC_CHANNELS.SETTINGS_GET,
        IPC_CHANNELS.APP_QUIT,
        IPC_CHANNELS.APP_GET_ABOUT,
        IPC_CHANNELS.APP_GET_VERSION,
      ]);
      expect(mockIpcMainOff).toHaveBeenCalledWith(
        IPC_CHANNELS.WINDOW_SET_HEIGHT,
        expect.any(Function),
      );
      expect(mockWindow.removeListener).toHaveBeenCalledWith("closed", expect.any(Function));
    });

    it("attempts every cleanup and preserves registration error when a disposer throws", () => {
      const registrationError = new Error("settings registration failed");
      const cleanupError = new Error("session cleanup failed");
      const privateHandler = vi.fn();
      registeredHandlers.set("utility-dialog:close", privateHandler);
      mockIpcMainHandle.mockImplementation(
        (channel: string, handler: (..._args: unknown[]) => unknown) => {
          if (channel === IPC_CHANNELS.SETTINGS_SET) throw registrationError;
          registeredHandlers.set(channel, handler);
        },
      );
      mockIpcMainRemoveHandler.mockImplementation((channel: string) => {
        registeredHandlers.delete(channel);
        if (channel === IPC_CHANNELS.SETTINGS_GET) throw cleanupError;
      });

      expect(() => registerIpcHandlers({}, makeIpcDeps())).toThrow(registrationError);

      expect(registeredHandlers).toEqual(new Map([["utility-dialog:close", privateHandler]]));
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledTimes(4);
      expect(mockIpcMainOff).toHaveBeenCalledWith(
        IPC_CHANNELS.WINDOW_SET_HEIGHT,
        expect.any(Function),
      );
    });

    it("attempts every cleanup and rethrows first cleanup error only once", () => {
      const cleanupError = new Error("updater cleanup failed");
      const privateHandler = vi.fn();
      registeredHandlers.set("utility-dialog:close", privateHandler);
      const deps = {
        ...(makeIpcDeps() as object),
        registerAutoUpdaterIpc: () => {
          mockIpcMainHandle(IPC_CHANNELS.AUTO_UPDATER_CHECK, vi.fn());
          return () => {
            mockIpcMainRemoveHandler(IPC_CHANNELS.AUTO_UPDATER_CHECK);
            throw cleanupError;
          };
        },
      };
      const unregister = registerIpcHandlers({}, deps);

      expect(() => unregister()).toThrow(cleanupError);
      expect(() => unregister()).not.toThrow();

      expect(registeredHandlers).toEqual(new Map([["utility-dialog:close", privateHandler]]));
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledTimes(10);
      expect(mockIpcMainOff).toHaveBeenCalledTimes(1);
    });

    it("unregisters invoke handlers when the window closes before shell cleanup", () => {
      const mockWindow = { on: vi.fn(), removeListener: vi.fn() };
      const unregister = registerIpcHandlers(mockWindow, makeIpcDeps());
      const onClosed = mockWindow.on.mock.calls.find(([event]) => event === "closed")?.[1];

      onClosed?.();
      unregister();

      expect(registeredHandlers.size).toBe(0);
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledTimes(9);
      expect(mockIpcMainOff).toHaveBeenCalledTimes(1);
    });

    it("rolls back all earlier handlers when updater registration throws", () => {
      const registrationError = new Error("updater registration failed");
      const deps = {
        ...(makeIpcDeps() as object),
        registerAutoUpdaterIpc: () => {
          throw registrationError;
        },
      };

      expect(() => registerIpcHandlers({}, deps)).toThrow(registrationError);

      expect(registeredHandlers.size).toBe(0);
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledTimes(9);
      expect(mockIpcMainOff).toHaveBeenCalledWith(
        IPC_CHANNELS.WINDOW_SET_HEIGHT,
        expect.any(Function),
      );
    });

    it("rolls back when updater setup fails after installing its own handler", () => {
      const registrationError = new Error("updater logging failed");
      const deps = {
        ...(makeIpcDeps() as object),
        registerAutoUpdaterIpc: () => {
          mockIpcMainHandle(IPC_CHANNELS.AUTO_UPDATER_CHECK, vi.fn());
          mockIpcMainRemoveHandler(IPC_CHANNELS.AUTO_UPDATER_CHECK);
          throw registrationError;
        },
      };

      expect(() => registerIpcHandlers({}, deps)).toThrow(registrationError);

      expect(registeredHandlers.size).toBe(0);
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledTimes(10);
      expect(mockIpcMainOff).toHaveBeenCalledTimes(1);
    });

    it("rolls back the resize listener when subscribing to window close throws", () => {
      const registrationError = new Error("window closed subscription failed");
      const mockWindow = {
        on: () => {
          throw registrationError;
        },
        removeListener: vi.fn(),
      };

      expect(() => registerIpcHandlers(mockWindow, makeIpcDeps())).toThrow(registrationError);

      expect(registeredHandlers.size).toBe(0);
      expect(mockIpcMainOff).toHaveBeenCalledWith(
        IPC_CHANNELS.WINDOW_SET_HEIGHT,
        expect.any(Function),
      );
    });

    it("cancels a queued resize if registration fails after the resize listener runs", async () => {
      vi.useFakeTimers();
      try {
        const registrationError = new Error("window closed subscription failed");
        const mockWindow = {
          on: () => {
            throw registrationError;
          },
          removeListener: vi.fn(),
          setSize: vi.fn(),
        };
        mockIpcMainOn.mockImplementation(
          (channel: string, handler: (..._args: unknown[]) => unknown) => {
            registeredHandlers.set(channel, handler);
            handler({ senderFrame: { url: "file:///mock/app/lib/renderer/index.html" } }, 320);
          },
        );

        expect(() => registerIpcHandlers(mockWindow, makeIpcDeps())).toThrow(registrationError);
        await vi.advanceTimersByTimeAsync(16);

        expect(registeredHandlers.size).toBe(0);
        expect(mockWindow.setSize).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rolls back if the resize listener registration throws after subscribing", () => {
      const registrationError = new Error("resize registration failed");
      mockIpcMainOn.mockImplementation(
        (channel: string, handler: (..._args: unknown[]) => unknown) => {
          registeredHandlers.set(channel, handler);
          throw registrationError;
        },
      );

      expect(() => registerIpcHandlers({}, makeIpcDeps())).toThrow(registrationError);

      expect(registeredHandlers.size).toBe(0);
      expect(mockIpcMainOff).toHaveBeenCalledTimes(1);
    });
  });

  describe("WINDOW_SET_HEIGHT handler", () => {
    it("clamps height to MIN_WINDOW_HEIGHT if too small", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.WINDOW_SET_HEIGHT);
      expect(handler).toBeDefined();

      const mockEvent = {
        senderFrame: { url: "file:///mock/app/lib/renderer/index.html" },
      };

      // Height below minimum (220)
      vi.useFakeTimers();
      handler!(mockEvent, 100);
      vi.runAllTimers();
      vi.useRealTimers();

      expect(mockWindow.setSize).toHaveBeenCalledWith(360, 220, false);
    });

    it("clamps height to MAX_WINDOW_HEIGHT if too large", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.WINDOW_SET_HEIGHT);
      const mockEvent = {
        senderFrame: { url: "file:///mock/app/lib/renderer/index.html" },
      };

      // Height above maximum (480)
      vi.useFakeTimers();
      handler!(mockEvent, 1000);
      vi.runAllTimers();
      vi.useRealTimers();

      expect(mockWindow.setSize).toHaveBeenCalledWith(360, 480, false);
    });

    it("accepts valid height within bounds", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.WINDOW_SET_HEIGHT);
      const mockEvent = {
        senderFrame: { url: "file:///mock/app/lib/renderer/index.html" },
      };

      vi.useFakeTimers();
      handler!(mockEvent, 350);
      vi.runAllTimers();
      vi.useRealTimers();

      expect(mockWindow.setSize).toHaveBeenCalledWith(360, 350, false);
    });

    it("ignores non-positive height values", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.WINDOW_SET_HEIGHT);
      const mockEvent = {
        senderFrame: { url: "file:///mock/app/lib/renderer/index.html" },
      };

      handler!(mockEvent, -50);
      handler!(mockEvent, 0);

      expect(mockWindow.setSize).not.toHaveBeenCalled();
    });
  });

  describe("APP_GET_VERSION handler", () => {
    it("typedHandle rejects before invoking an unguarded protected callback", async () => {
      const { typedHandle } = await import("../../src/main/ipc-utils.js");
      const protectedHandler = vi.fn().mockReturnValue("private-version");
      typedHandle(IPC_CHANNELS.APP_GET_VERSION, () => "", protectedHandler);
      const handler = registeredHandlers.get(IPC_CHANNELS.APP_GET_VERSION);

      const result = await handler?.({ senderFrame: { url: "https://evil.com/" } });

      expect(result).toBe("");
      expect(protectedHandler).not.toHaveBeenCalled();
    });

    it("typedHandle returns an idempotent disposer for its own channel", async () => {
      const { typedHandle } = await import("../../src/main/ipc-utils.js");
      const unregister = typedHandle(
        IPC_CHANNELS.APP_GET_VERSION,
        () => "",
        () => "1.0.0",
      );
      registeredHandlers.set("utility-dialog:close", vi.fn());

      unregister();
      unregister();

      expect(registeredHandlers.has(IPC_CHANNELS.APP_GET_VERSION)).toBe(false);
      expect(registeredHandlers.has("utility-dialog:close")).toBe(true);
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledExactlyOnceWith(
        IPC_CHANNELS.APP_GET_VERSION,
      );
    });

    it("returns app version for valid sender", async () => {
      const mockWindow = {};
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.APP_GET_VERSION);
      expect(handler).toBeDefined();

      const mockEvent = {
        senderFrame: { url: "file:///mock/app/lib/renderer/index.html" },
      };

      const result = await handler!(mockEvent);
      expect(result).toBe("1.0.0");
    });
  });

  describe("APP_GET_ABOUT handler", () => {
    it("returns package about info for valid sender", async () => {
      const mockWindow = {};
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.APP_GET_ABOUT);
      expect(handler).toBeDefined();

      const mockEvent = {
        senderFrame: { url: "file:///mock/app/lib/renderer/about.html" },
      };

      const result = await handler!(mockEvent);
      expect(result).toEqual({
        productName: "Amphetamine",
        version: "1.0.0",
        description: "Keep awake",
        repository: "https://github.com/iworkforces/Amphetamine",
        author: "Test",
      });
    });
  });

  describe("SETTINGS_GET handler", () => {
    it("returns settings for valid sender", async () => {
      const mockSettings = { ...DEFAULT_SETTINGS, preventSleep: true };
      mockGetSettings.mockReturnValue(mockSettings);

      const mockWindow = {};
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.SETTINGS_GET);
      const mockEvent = {
        senderFrame: { url: "file:///mock/app/lib/renderer/index.html" },
      };

      const result = await handler!(mockEvent);
      expect(result).toEqual(mockSettings);
    });
  });

  describe("SETTINGS_SET handler", () => {
    it("calls updateSettings with partial settings", async () => {
      const mockWindow = {};
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.SETTINGS_SET);
      const mockEvent = {
        senderFrame: { url: "file:///mock/app/lib/renderer/index.html" },
      };

      mockUpdateSettings.mockReturnValue({
        settings: { ...DEFAULT_SETTINGS, preventSleep: true },
        rejectedKeys: [],
      });

      await handler!(mockEvent, { preventSleep: true });

      expect(mockUpdateSettings).toHaveBeenCalledWith({ preventSleep: true });
    });
  });

  describe("SETTINGS_OPEN handler", () => {
    it("calls createSettingsWindow for valid sender", async () => {
      const mockWindow = {};
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.SETTINGS_OPEN);
      const mockEvent = {
        senderFrame: { url: "file:///mock/app/lib/renderer/index.html" },
      };

      await handler!(mockEvent);

      expect(mockCreateSettingsWindow).toHaveBeenCalledTimes(1);
    });
  });

  describe("session handlers", () => {
    const validEvent = {
      senderFrame: { url: "file:///mock/app/lib/renderer/index.html" },
    };

    it("SESSION_START calls startSession", async () => {
      const mockWindow = {};
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);

      await handler!(validEvent, { durationMinutes: null });

      expect(mockStartSession).toHaveBeenCalledWith(null);
    });

    it("SESSION_CANCEL calls cancelSession", async () => {
      const mockWindow = {};
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_CANCEL);

      await handler!(validEvent);

      expect(mockCancelSession).toHaveBeenCalledTimes(1);
    });

    it("SESSION_CANCEL calls cancelSession", async () => {
      const mockWindow = {};
      registerIpcHandlers(mockWindow, makeIpcDeps());

      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_CANCEL);

      await handler!(validEvent);

      expect(mockCancelSession).toHaveBeenCalledTimes(1);
    });

    it("SESSION_STATUS returns pure status snapshot (never null) when no session running", async () => {
      const mockWindow = {};
      registerIpcHandlers(mockWindow, makeIpcDeps());

      mockGetStatus.mockReturnValue({
        isRunning: false,
        startedAt: null,
        expiresAt: null,
        durationMinutes: null,
        remainingSeconds: null,
      });

      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_STATUS);

      const result = await handler!(validEvent);
      expect(result).toEqual({
        isRunning: false,
        startedAt: null,
        expiresAt: null,
        durationMinutes: null,
        remainingSeconds: null,
      });
    });
  });
});
