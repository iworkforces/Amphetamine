import { describe, it, expect, vi, beforeEach } from "vitest";
import { IPC_CHANNELS, DEFAULT_SETTINGS } from "../../src/shared/types.js";

// Mock electron first - must be done before importing ipc
const mockGetVersion = vi.hoisted(() => vi.fn().mockReturnValue("1.0.0"));
const mockGetAppPath = vi.hoisted(() => vi.fn().mockReturnValue("/mock/app"));
const mockIpcMainHandle = vi.hoisted(() => vi.fn());
const mockIpcMainOn = vi.hoisted(() => vi.fn());
const mockBrowserWindowGetAllWindows = vi.hoisted(() => vi.fn().mockReturnValue([]));

vi.mock("electron", () => ({
  app: {
    getVersion: mockGetVersion,
    getAppPath: mockGetAppPath,
  },
  ipcMain: {
    handle: mockIpcMainHandle,
    on: mockIpcMainOn,
  },
  BrowserWindow: {
    getAllWindows: mockBrowserWindowGetAllWindows,
  },
}));

// Mock dependencies
const mockGetSettings = vi.fn().mockReturnValue({ ...DEFAULT_SETTINGS });
const mockUpdateSettings = vi.fn().mockImplementation((partial: Partial<typeof DEFAULT_SETTINGS>) => ({
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
  let registerIpcHandlers: (_win: unknown, _deps: unknown) => void;
  let registeredHandlers: Map<string, (..._args: unknown[]) => unknown>;

  function makeIpcDeps(): unknown {
    return {
      getSettings: mockGetSettings,
      updateSettings: mockUpdateSettings,
      createSettingsWindow: mockCreateSettingsWindow,
      registerAutoUpdaterIpc: vi.fn(),
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
    mockIpcMainHandle.mockImplementation((channel: string, handler: (..._args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    });
    mockIpcMainOn.mockImplementation((channel: string, handler: (..._args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    });

    // Import the module
    const mod = await import("../../src/main/ipc.js");
    registerIpcHandlers = mod.registerIpcHandlers as unknown as (_win: unknown, _deps: unknown) => void;
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

      mockUpdateSettings.mockReturnValue({ settings: { ...DEFAULT_SETTINGS, preventSleep: true }, rejectedKeys: [] });

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
