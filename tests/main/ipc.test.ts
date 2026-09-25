import { describe, it, expect, vi, beforeEach } from "vitest";
import { afterEach } from "vitest";
import { IPC_CHANNELS, DEFAULT_SETTINGS } from "../../src/shared/types.js";
import type { IpcMainInvokeEvent, IpcMainEvent } from "electron";
import { validateSender } from "../../src/main/ipc.js";

describe("validateSender", () => {
  it("accepts file:// origin for app index.html (exact match)", () => {
    const event = {
      senderFrame: { url: "file:///path/to/app.asar/lib/renderer/index.html" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(true);
  });

  it("accepts file:// origin for settings.html (exact match)", () => {
    const event = {
      senderFrame: { url: "file:///path/to/app.asar/lib/renderer/settings.html" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(true);
  });

  it("accepts file:// origin for about.html (exact match)", () => {
    const event = {
      senderFrame: { url: "file:///path/to/app.asar/lib/renderer/about.html" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(true);
  });

  it("rejects file:// origin with path prefix attack (substring bypass)", () => {
    const event = {
      senderFrame: { url: "file:///path/to/app.asar.evil/index.html" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(false);
  });

  it("rejects file:// origin to non-allowlisted path within bundle", () => {
    const event = {
      senderFrame: { url: "file:///path/to/app.asar/src/renderer/index.html" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(false);
  });

  it("accepts http://localhost:5173 origin (dev server)", () => {
    const event = {
      senderFrame: { url: "http://localhost:5173/" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(true);
  });

  it("accepts http://127.0.0.1:5173 origin (dev server)", () => {
    const event = {
      senderFrame: { url: "http://127.0.0.1:5173/index.html" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(true);
  });

  it("rejects file:// origin outside app bundle", () => {
    const event = {
      senderFrame: { url: "file:///tmp/malicious.html" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(false);
  });

  it("rejects malicious origin", () => {
    const event = {
      senderFrame: { url: "https://evil.com/" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(false);
  });

  it("rejects empty sender URL", () => {
    const event = {
      senderFrame: { url: "" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(false);
  });

  it("rejects undefined sender frame", () => {
    const event = {
      senderFrame: undefined,
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(false);
  });

  it("rejects non-allowlisted port", () => {
    const event = {
      senderFrame: { url: "http://localhost:3000/" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(false);
  });

  it("rejects similar but different domain", () => {
    const event = {
      senderFrame: { url: "http://localhost.com:5173/" },
    } as unknown as IpcMainEvent;
    expect(validateSender(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Additional coverage: ipcMain.on sender validation, APP_QUIT, SESSION_START
// invalid duration, SESSION_STATUS while running, path-traversal injection.
// ---------------------------------------------------------------------------

const {
  mockGetSettings,
  mockUpdateSettings,
  mockOnSettingsChanged,
  mockCreateSettingsWindow,
  mockStartSession,
  mockCancelSession,
  mockGetStatus,
  mockGetPackageInfo,
} = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
  mockUpdateSettings: vi.fn(),
  mockOnSettingsChanged: vi.fn(),
  mockCreateSettingsWindow: vi.fn(),
  mockStartSession: vi.fn(),
  mockCancelSession: vi.fn(),
  mockGetStatus: vi.fn(),
  mockGetPackageInfo: vi.fn(),
}));

vi.mock("../../src/main/utils/packageInfo.js", () => ({
  getPackageInfo: mockGetPackageInfo,
}));

vi.mock("../../src/main/settings.js", () => ({
  getSettings: mockGetSettings,
  updateSettings: mockUpdateSettings,
  onSettingsChanged: mockOnSettingsChanged,
}));

vi.mock("../../src/main/settings-window.js", () => ({
  createSettingsWindow: mockCreateSettingsWindow,
}));

vi.mock("../../src/main/session-timer.js", () => ({
  startSession: mockStartSession,
  cancelSession: mockCancelSession,
  getStatus: mockGetStatus,
}));

vi.mock("../../src/main/auto-updater.js", () => ({
  registerAutoUpdaterIpc: vi.fn(),
}));

describe("ipc additional coverage", () => {
  let registerIpcHandlers: (
    _win: { setSize?: (_w: number, _h: number, _animate?: boolean) => void },
    _deps: unknown,
  ) => void;
  let registeredHandlers: Map<string, (..._args: unknown[]) => unknown>;
  let appQuitMock: ReturnType<typeof vi.fn>;

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

  const validEvent = {
      senderFrame: { url: "file:///path/to/app.asar/lib/renderer/index.html" },
  } as unknown as IpcMainInvokeEvent;
  const invalidEvent = {
    senderFrame: { url: "https://evil.com/" },
  } as unknown as IpcMainInvokeEvent;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const electron = await import("electron");
    vi.mocked(electron.app.getAppPath).mockReturnValue("/path/to/app.asar");
    vi.mocked(electron.app.getVersion).mockReturnValue("1.0.0");
    vi.mocked(electron.app.quit).mockClear();
    appQuitMock = vi.mocked(electron.app.quit) as unknown as ReturnType<typeof vi.fn>;

    mockGetSettings.mockReturnValue({ ...DEFAULT_SETTINGS });
    mockUpdateSettings.mockImplementation((partial: Partial<typeof DEFAULT_SETTINGS>) => ({
      ...DEFAULT_SETTINGS,
      ...partial,
    }));
    mockStartSession.mockReturnValue({
      isRunning: true,
      startedAt: 1_700_000_000_000,
      expiresAt: null,
      durationMinutes: null,
    });
    mockGetStatus.mockReturnValue({
      isRunning: false,
      startedAt: null,
      expiresAt: null,
      remainingSeconds: null,
      durationMinutes: null,
    });
    mockGetPackageInfo.mockReturnValue({
      productName: "Amphetamine",
      description: "Keep awake",
      repository: "https://github.com/iworkforces/Amphetamine",
      author: "Test Author",
    });

    registeredHandlers = new Map();
    vi.mocked(electron.ipcMain.handle).mockImplementation(
      ((channel: string, handler: (..._args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, handler);
      }) as typeof electron.ipcMain.handle
    );
    vi.mocked(electron.ipcMain.on).mockImplementation(
      ((channel: string, handler: (..._args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, handler);
        return electron.ipcMain;
      }) as typeof electron.ipcMain.on,
    );

    const mod = await import("../../src/main/ipc.js");
    registerIpcHandlers = mod.registerIpcHandlers as unknown as typeof registerIpcHandlers;
  });

  describe("ipcMain.on sender validation (WINDOW_SET_HEIGHT)", () => {
    it("valid file:// origin: invokes window.setSize", () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.WINDOW_SET_HEIGHT);
      expect(handler).toBeDefined();
      vi.useFakeTimers();
      handler!(validEvent, 320);
      vi.runAllTimers();
      vi.useRealTimers();
      expect(mockWindow.setSize).toHaveBeenCalledWith(360, 320, false);
    });

    it("invalid origin (https://evil.com): does NOT invoke window.setSize", () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.WINDOW_SET_HEIGHT);
      handler!(invalidEvent, 320);
      expect(mockWindow.setSize).not.toHaveBeenCalled();
    });

    it("coalesces a burst for 16ms and uses the latest valid height", async () => {
      vi.useFakeTimers();
      try {
        const mockWindow = { setSize: vi.fn() };
        registerIpcHandlers(mockWindow, makeIpcDeps());
        const handler = registeredHandlers.get(IPC_CHANNELS.WINDOW_SET_HEIGHT);
        expect(handler).toBeDefined();

        handler?.(validEvent, 290);
        await vi.advanceTimersByTimeAsync(8);
        handler?.(validEvent, 365);
        handler?.(invalidEvent, 470);
        handler?.(validEvent, 0);
        await vi.advanceTimersByTimeAsync(7);
        expect(mockWindow.setSize).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(mockWindow.setSize).toHaveBeenCalledExactlyOnceWith(360, 365, false);

        handler?.(validEvent, 410);
        await vi.advanceTimersByTimeAsync(16);
        expect(mockWindow.setSize).toHaveBeenNthCalledWith(2, 360, 410, false);
        expect(mockWindow.setSize).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      { firstHeight: 300, latestHeight: 100, expectedHeight: 220 },
      { firstHeight: 300, latestHeight: 1000, expectedHeight: 480 },
    ])("clamps the latest height in a coalesced burst to $expectedHeight", async ({
      firstHeight,
      latestHeight,
      expectedHeight,
    }) => {
      vi.useFakeTimers();
      try {
        const mockWindow = { setSize: vi.fn() };
        registerIpcHandlers(mockWindow, makeIpcDeps());
        const handler = registeredHandlers.get(IPC_CHANNELS.WINDOW_SET_HEIGHT);
        expect(handler).toBeDefined();

        handler?.(validEvent, firstHeight);
        handler?.(validEvent, latestHeight);
        await vi.advanceTimersByTimeAsync(16);

        expect(mockWindow.setSize).toHaveBeenCalledExactlyOnceWith(360, expectedHeight, false);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["320", 320.5, Number.NaN])("ignores invalid height %s", async (height) => {
      vi.useFakeTimers();
      try {
        const mockWindow = { setSize: vi.fn() };
        registerIpcHandlers(mockWindow, makeIpcDeps());
        const handler = registeredHandlers.get(IPC_CHANNELS.WINDOW_SET_HEIGHT);
        expect(handler).toBeDefined();

        handler?.(validEvent, height);
        await vi.advanceTimersByTimeAsync(16);

        expect(mockWindow.setSize).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("app information handlers", () => {
    it("returns the live app version for an allowed sender", async () => {
      const electron = await import("electron");
      vi.mocked(electron.app.getVersion).mockReturnValue("9.8.7");
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_VERSION)?.(validEvent);

      expect(result).toBe("9.8.7");
    });

    it("returns an empty version without reading the app version for a rejected sender", async () => {
      const electron = await import("electron");
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_VERSION)?.(invalidEvent);

      expect(result).toBe("");
      expect(electron.app.getVersion).not.toHaveBeenCalled();
    });

    it("returns package metadata with the live app version for an allowed sender", async () => {
      const electron = await import("electron");
      vi.mocked(electron.app.getVersion).mockReturnValue("9.8.7");
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_ABOUT)?.(validEvent);

      expect(result).toEqual({
        productName: "Amphetamine",
        version: "9.8.7",
        description: "Keep awake",
        repository: "https://github.com/iworkforces/Amphetamine",
        author: "Test Author",
      });
      expect(mockGetPackageInfo).toHaveBeenCalledTimes(1);
    });

    it("returns blank about fields without reading package metadata for a rejected sender", async () => {
      const electron = await import("electron");
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_ABOUT)?.(invalidEvent);

      expect(result).toEqual({
        productName: "",
        version: "",
        description: "",
        repository: "",
        author: "",
      });
      expect(electron.app.getVersion).not.toHaveBeenCalled();
      expect(mockGetPackageInfo).not.toHaveBeenCalled();
    });
  });

  describe("settings handlers", () => {
    it("returns current settings for an allowed sender", () => {
      const settings = { ...DEFAULT_SETTINGS, preventSleep: true, batteryThreshold: 35 };
      mockGetSettings.mockReturnValue(settings);
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = registeredHandlers.get(IPC_CHANNELS.SETTINGS_GET)?.(validEvent);

      expect(result).toEqual(settings);
      expect(mockGetSettings).toHaveBeenCalledTimes(1);
    });

    it("returns defaults instead of private settings for a rejected sender", () => {
      mockGetSettings.mockReturnValue({ ...DEFAULT_SETTINGS, preventSleep: true });
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = registeredHandlers.get(IPC_CHANNELS.SETTINGS_GET)?.(invalidEvent);

      expect(result).toEqual(DEFAULT_SETTINGS);
      expect(mockGetSettings).not.toHaveBeenCalled();
    });

    it("returns the persisted settings and rejected keys from an allowed update", async () => {
      const partial = { preventSleep: true, batteryThreshold: 35 };
      const response = {
        settings: { ...DEFAULT_SETTINGS, preventSleep: true },
        rejectedKeys: ["batteryThreshold"],
      };
      mockUpdateSettings.mockResolvedValue(response);
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = await registeredHandlers.get(IPC_CHANNELS.SETTINGS_SET)?.(validEvent, partial);

      expect(mockUpdateSettings).toHaveBeenCalledWith(partial);
      expect(result).toEqual(response);
    });

    it("does not persist a rejected update and returns current settings without rejected keys", async () => {
      const settings = { ...DEFAULT_SETTINGS, preventSleep: true, batteryThreshold: 35 };
      mockGetSettings.mockReturnValue(settings);
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = await registeredHandlers.get(IPC_CHANNELS.SETTINGS_SET)?.(invalidEvent, {
        preventSleep: false,
      });

      expect(result).toEqual({ settings, rejectedKeys: [] });
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it("opens settings for an allowed sender", async () => {
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = await registeredHandlers.get(IPC_CHANNELS.SETTINGS_OPEN)?.(validEvent);

      expect(result).toBeUndefined();
      expect(mockCreateSettingsWindow).toHaveBeenCalledTimes(1);
    });

    it("does not open settings for a rejected sender", async () => {
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = await registeredHandlers.get(IPC_CHANNELS.SETTINGS_OPEN)?.(invalidEvent);

      expect(result).toBeUndefined();
      expect(mockCreateSettingsWindow).not.toHaveBeenCalled();
    });
  });

  describe("session cancel and rejected status", () => {
    it("cancels an allowed session and acknowledges cancellation", async () => {
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = await registeredHandlers.get(IPC_CHANNELS.SESSION_CANCEL)?.(validEvent);

      expect(result).toEqual({ cancelled: true });
      expect(mockCancelSession).toHaveBeenCalledTimes(1);
    });

    it("does not cancel a session for a rejected sender", async () => {
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = await registeredHandlers.get(IPC_CHANNELS.SESSION_CANCEL)?.(invalidEvent);

      expect(result).toEqual({ cancelled: false });
      expect(mockCancelSession).not.toHaveBeenCalled();
    });

    it("hides a running session from a rejected sender without reading its status", () => {
      mockGetStatus.mockReturnValue({
        isRunning: true,
        startedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_060_000,
        remainingSeconds: 42,
        durationMinutes: 1,
      });
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());

      const result = registeredHandlers.get(IPC_CHANNELS.SESSION_STATUS)?.(invalidEvent);

      expect(result).toEqual({
        isRunning: false,
        startedAt: null,
        expiresAt: null,
        remainingSeconds: null,
        durationMinutes: null,
      });
      expect(mockGetStatus).not.toHaveBeenCalled();
    });
  });

  describe("APP_QUIT handler", () => {
    it("valid sender: app.quit() is called", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.APP_QUIT);
      expect(handler).toBeDefined();
      await handler!(validEvent);
      expect(appQuitMock).toHaveBeenCalledTimes(1);
    });

    it("invalid sender: app.quit() is NOT called", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.APP_QUIT);
      await handler!(invalidEvent);
      expect(appQuitMock).not.toHaveBeenCalled();
    });
  });

  describe("SESSION_START with invalid durationMinutes", () => {
    const invalidDurationResponse = { ok: false, reason: "invalid-duration" } as const;

    it("negative number: returns invalid-duration failure and does not start session", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(validEvent, { durationMinutes: -5 });
      expect(result).toEqual(invalidDurationResponse);
      expect(mockStartSession).not.toHaveBeenCalled();
    });

    it("NaN: returns invalid-duration failure and does not start session", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(validEvent, { durationMinutes: NaN });
      expect(result).toEqual(invalidDurationResponse);
      expect(mockStartSession).not.toHaveBeenCalled();
    });

    it("zero: returns invalid-duration failure and does not start session", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(validEvent, { durationMinutes: 0 });
      expect(result).toEqual(invalidDurationResponse);
      expect(mockStartSession).not.toHaveBeenCalled();
    });

    it("non-integer (e.g. 1.5): returns invalid-duration failure and does not start session", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(validEvent, { durationMinutes: 1.5 });
      expect(result).toEqual(invalidDurationResponse);
      expect(mockStartSession).not.toHaveBeenCalled();
    });

    it("invalid sender: returns rejected failure", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(invalidEvent, { durationMinutes: 30 });
      expect(result).toEqual({ ok: false, reason: "rejected" });
      expect(mockStartSession).not.toHaveBeenCalled();
    });

    it("startSession returns null startedAt: returns rejected failure (invariant violation)", async () => {
      mockStartSession.mockReturnValueOnce({
        isRunning: false,
        startedAt: null,
        expiresAt: null,
        durationMinutes: null,
      });
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(validEvent, { durationMinutes: 30 });
      expect(result).toEqual({ ok: false, reason: "rejected" });
    });

    it("valid duration: returns ok success with payload", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(validEvent, { durationMinutes: 30 });
      expect(result).toMatchObject({
        ok: true,
        startedAt: 1_700_000_000_000,
        durationMinutes: null,
        expiresAt: null,
      });
    });

    it(">1440 minutes: returns exact 24h failure reason and does not start session", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(validEvent, { durationMinutes: 1441 });
      expect(result).toEqual({ ok: false, reason: "Duration cannot exceed 24 hours" });
      expect(mockStartSession).not.toHaveBeenCalled();
    });

    it("exactly 1440 minutes: starts session (upper bound inclusive)", async () => {
      mockStartSession.mockReturnValueOnce({
        isRunning: true,
        startedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_000_000 + 1440 * 60_000,
        durationMinutes: 1440,
      });
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(validEvent, { durationMinutes: 1440 });
      expect(mockStartSession).toHaveBeenCalledWith(1440);
      expect(result).toEqual({
        ok: true,
        startedAt: 1_700_000_000_000,
        durationMinutes: 1440,
        expiresAt: 1_700_000_000_000 + 1440 * 60_000,
      });
    });

    it("null duration (indefinite): starts session and returns ok payload", async () => {
      mockStartSession.mockReturnValueOnce({
        isRunning: true,
        startedAt: 1_700_000_000_000,
        expiresAt: null,
        durationMinutes: null,
      });
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(validEvent, { durationMinutes: null });
      expect(mockStartSession).toHaveBeenCalledWith(null);
      expect(result).toEqual({
        ok: true,
        startedAt: 1_700_000_000_000,
        durationMinutes: null,
        expiresAt: null,
      });
    });

    it("Infinity: returns invalid-duration failure and does not start session", async () => {
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_START);
      const result = await handler!(validEvent, { durationMinutes: Number.POSITIVE_INFINITY });
      expect(result).toEqual(invalidDurationResponse);
      expect(mockStartSession).not.toHaveBeenCalled();
    });
  });

  describe("SESSION_STATUS while a session is running", () => {
    it("returns running status with startedAt and remainingSeconds", async () => {
      const startedAt = 1_700_000_000_000;
      const expiresAt = startedAt + 60_000;
      mockGetStatus.mockReturnValue({
        isRunning: true,
        startedAt,
        expiresAt,
        remainingSeconds: 42,
        durationMinutes: 1,
      });
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.SESSION_STATUS);
      const result = (await handler!(validEvent)) as {
        isRunning: boolean;
        startedAt: number | null;
        remainingSeconds: number | null;
      };
      expect(result.isRunning).toBe(true);
      expect(typeof result.startedAt).toBe("number");
      expect(result.startedAt).toBe(startedAt);
      expect(typeof result.remainingSeconds).toBe("number");
      expect(result.remainingSeconds).toBe(42);
    });
  });

  describe("path-traversal sender URL injection", () => {
    it("rejects file:// path with traversal segments that resolve outside allowlist", async () => {
      // file:///path/to/app.asar/../etc/index.html resolves to /path/etc/index.html — outside allowlist
      const traversalEvent = {
        senderFrame: { url: "file:///path/to/app.asar/../etc/index.html" },
      } as unknown as IpcMainEvent;
      const { validateSender } = await import("../../src/main/ipc.js");
      expect(validateSender(traversalEvent)).toBe(false);
    });

    it("rejects file:// malicious path traversal that does not resolve to allowlisted index.html", async () => {
      const traversalEvent = {
        senderFrame: { url: "file:///malicious/../index.html" },
      } as unknown as IpcMainEvent;
      const { validateSender } = await import("../../src/main/ipc.js");
      expect(validateSender(traversalEvent)).toBe(false);
    });

    it("APP_QUIT rejects path-traversal sender URL", async () => {
      const traversalEvent = {
        senderFrame: { url: "file:///path/to/app.asar/../../etc/passwd/index.html" },
      } as unknown as IpcMainEvent;
      const mockWindow = { setSize: vi.fn() };
      registerIpcHandlers(mockWindow, makeIpcDeps());
      const handler = registeredHandlers.get(IPC_CHANNELS.APP_QUIT);
      await handler!(traversalEvent);
      expect(appQuitMock).not.toHaveBeenCalled();
    });
  });

  describe("packaged Windows public IPC senders", () => {
    const rendererRoot = "file:///C:/Program%20Files/Amphetamine/app.asar/lib/renderer/";

    beforeEach(async () => {
      const electron = await import("electron");
      vi.mocked(electron.app.getAppPath).mockReturnValue("C:\\Program Files\\Amphetamine\\app.asar");
      Object.defineProperty(electron.app, "isPackaged", { configurable: true, value: true });
      vi.resetModules();
      const mod = await import("../../src/main/ipc.js");
      registerIpcHandlers = mod.registerIpcHandlers as unknown as typeof registerIpcHandlers;
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());
    });

    afterEach(async () => {
      const electron = await import("electron");
      Object.defineProperty(electron.app, "isPackaged", { configurable: true, value: false });
    });

    it("returns the app version from the packaged index main frame", () => {
      const event = { senderFrame: { url: `${rendererRoot}index.html`, parent: null } };

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_VERSION)?.(event);

      expect(result).toBe("1.0.0");
    });

    it("returns settings from the packaged settings main frame", () => {
      const settings = { ...DEFAULT_SETTINGS, preventSleep: true };
      mockGetSettings.mockReturnValue(settings);
      const event = { senderFrame: { url: `${rendererRoot}settings.html`, parent: null } };

      const result = registeredHandlers.get(IPC_CHANNELS.SETTINGS_GET)?.(event);

      expect(result).toEqual(settings);
      expect(mockGetSettings).toHaveBeenCalledTimes(1);
    });

    it("returns about metadata from the packaged about main frame", () => {
      const event = { senderFrame: { url: `${rendererRoot}about.html`, parent: null } };

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_ABOUT)?.(event);

      expect(result).toEqual({
        productName: "Amphetamine",
        version: "1.0.0",
        description: "Keep awake",
        repository: "https://github.com/iworkforces/Amphetamine",
        author: "Test Author",
      });
      expect(mockGetPackageInfo).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["outside bundle", "file:///C:/Other/Amphetamine/app.asar/lib/renderer/index.html"],
      ["similar bundle prefix", "file:///C:/Program%20Files/Amphetamine/app.asar.evil/lib/renderer/index.html"],
      ["unlisted renderer", `${rendererRoot}utility-dialog.html`],
      ["traversal", `${rendererRoot}../../index.html`],
      ["malformed escape", `${rendererRoot}index%ZZ.html`],
      ["UNC host", "file://server/C:/Program%20Files/Amphetamine/app.asar/lib/renderer/index.html"],
    ])("rejects %s through the registered version handler", (_reason, url) => {
      const event = { senderFrame: { url, parent: null } };

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_VERSION)?.(event);

      expect(result).toBe("");
    });

    it("rejects a child frame even when its URL is allowlisted", () => {
      const event = {
        senderFrame: { url: `${rendererRoot}index.html`, parent: { url: `${rendererRoot}index.html` } },
      };

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_VERSION)?.(event);

      expect(result).toBe("");
    });

    it("rejects a missing sender frame", () => {
      const event = { senderFrame: undefined };

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_VERSION)?.(event);

      expect(result).toBe("");
    });

    it("rejects the dev HTTP origin in a packaged build", () => {
      const event = { senderFrame: { url: "http://localhost:5173/index.html", parent: null } };

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_VERSION)?.(event);

      expect(result).toBe("");
    });

    it("allows the dev HTTP origin in an unpackaged build", async () => {
      const electron = await import("electron");
      Object.defineProperty(electron.app, "isPackaged", { configurable: true, value: false });
      vi.resetModules();
      const mod = await import("../../src/main/ipc.js");
      registerIpcHandlers = mod.registerIpcHandlers as unknown as typeof registerIpcHandlers;
      registerIpcHandlers({ setSize: vi.fn() }, makeIpcDeps());
      const event = { senderFrame: { url: "http://localhost:5173/index.html", parent: null } };

      const result = registeredHandlers.get(IPC_CHANNELS.APP_GET_VERSION)?.(event);

      expect(result).toBe("1.0.0");
    });
  });
});
