import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks - same pattern as existing tests
const mockGetSettings = vi.hoisted(() =>
  vi.fn().mockReturnValue({ launchAtLogin: false, preventSleep: false }),
);
const mockCompositionInit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCompositionCleanup = vi.hoisted(() => vi.fn());
const mockGetIpcDeps = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    createSettingsWindow: vi.fn(),
    registerAutoUpdaterIpc: vi.fn(),
    sessionTimer: {
      startSession: vi.fn(),
      cancelSession: vi.fn(),
      getStatus: vi.fn(),
    },
  }),
);
const mockGetTrayDeps = vi.hoisted(() => vi.fn().mockReturnValue({}));
const mockCreateAppComposition = vi.hoisted(() =>
  vi.fn(() => ({
    init: mockCompositionInit,
    initUpdater: vi.fn(),
    cleanup: mockCompositionCleanup,
    getIpcDeps: mockGetIpcDeps,
    getTrayDeps: mockGetTrayDeps,
    ready: true,
  })),
);
const mockSetupTray = vi.hoisted(() => vi.fn().mockReturnValue(() => {}));
const mockRegisterIpcHandlers = vi.hoisted(() => vi.fn());
const mockCloseSettingsWindow = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());
const mockLogInfo = vi.hoisted(() => vi.fn());
const mockShowErrorBox = vi.hoisted(() => vi.fn());
const mockSetActivationPolicy = vi.hoisted(() => vi.fn());
const mockSetAboutPanelOptions = vi.hoisted(() => vi.fn());
const mockGetVersion = vi.hoisted(() => vi.fn().mockReturnValue("1.0.0"));
const mockGetAppPath = vi.hoisted(() => vi.fn().mockReturnValue("/mock/app/path"));
const mockWhenReady = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockExit = vi.hoisted(() => vi.fn());
const mockRequestSingleInstanceLock = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockOn = vi.hoisted(() => vi.fn());
const mockProcessOn = vi.hoisted(() => vi.fn());

// Mock electron
vi.mock("electron", () => ({
  app: {
    getVersion: mockGetVersion,
    quit: vi.fn(),
    isPackaged: false,
    setAboutPanelOptions: mockSetAboutPanelOptions,
    whenReady: mockWhenReady,
    on: mockOn,
    getAppPath: mockGetAppPath,
    setActivationPolicy: mockSetActivationPolicy,
    exit: mockExit,
    requestSingleInstanceLock: mockRequestSingleInstanceLock,
  },
  BrowserWindow: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.loadURL = vi.fn();
    this.loadFile = vi.fn();
    this.show = vi.fn();
    this.hide = vi.fn();
    this.focus = vi.fn();
    this.destroy = vi.fn();
    this.isVisible = vi.fn().mockReturnValue(false);
    this.isDestroyed = vi.fn().mockReturnValue(false);
    this.getBounds = vi.fn().mockReturnValue({ x: 0, y: 0, width: 360, height: 480 });
    this.setPosition = vi.fn();
    this.setSize = vi.fn();
    this.setAlwaysOnTop = vi.fn();
    this.on = vi.fn();
    this.removeListener = vi.fn();
    this.webContents = {
      send: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
  }),
  nativeImage: {
    createFromPath: vi.fn().mockReturnValue({
      toPNG: vi.fn().mockReturnValue(Buffer.alloc(0)),
    }),
  },
  dialog: {
    showErrorBox: mockShowErrorBox,
  },
}));

vi.mock("electron-log", () => ({
  default: {
    error: mockLogError,
    info: mockLogInfo,
  },
}));

vi.mock("../../src/main/tray.js", () => ({
  setupTray: mockSetupTray,
}));

vi.mock("../../src/main/ipc.js", () => ({
  registerIpcHandlers: mockRegisterIpcHandlers,
}));

vi.mock("../../src/main/settings.js", () => ({
  getSettings: mockGetSettings,
  updateSettings: vi.fn(),
  flushSettingsWriteChain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/main/composition-root.js", () => ({
  createAppComposition: mockCreateAppComposition,
}));

vi.mock("../../src/main/settings-window.js", () => ({
  closeSettingsWindow: mockCloseSettingsWindow,
  createSettingsWindow: vi.fn(),
}));

vi.mock("../../src/main/auto-updater.js", () => ({
  initAutoUpdater: vi.fn(),
  stopAutoUpdater: vi.fn(),
  registerAutoUpdaterIpc: vi.fn(),
  setBroadcastFn: vi.fn(),
  checkForUpdatesNow: vi.fn(),
}));

vi.mock("../../src/main/session-timer.js", () => ({
  createSessionTimer: vi.fn(),
}));

vi.mock("../../src/main/shortcut.js", () => ({
  unregisterGlobalShortcut: vi.fn(),
}));
vi.mock("../../src/main/utils/packageInfo.js", () => ({
  getPackageInfo: vi.fn().mockReturnValue({ author: "Test Author", version: "1.0.0" }),
}));

// Mock process.on for uncaughtException and unhandledRejection
vi.stubGlobal("process", {
  ...process,
  on: mockProcessOn,
});

describe("main index - AppShell bootstrap", () => {
  let BrowserWindow: ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Get BrowserWindow reference
    const electron = await import("electron");
    BrowserWindow = electron.BrowserWindow as unknown as ReturnType<typeof vi.fn> & {
      mock: { calls: unknown[][] };
    };

    // Reset mocks
    mockGetSettings.mockReturnValue({ launchAtLogin: false, preventSleep: false });
    mockCompositionInit.mockResolvedValue(undefined);
    mockWhenReady.mockResolvedValue(undefined);
  });

  it("creates BrowserWindow with correct width and height", async () => {
    await import("../../src/main/index.js");

    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    const callArgs = BrowserWindow.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.width).toBe(360);
    expect(callArgs.height).toBe(480);
  });

  it("creates BrowserWindow with alwaysOnTop true", async () => {
    await import("../../src/main/index.js");

    const callArgs = BrowserWindow.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.alwaysOnTop).toBe(true);
  });

  it("creates BrowserWindow with frame false and platform popover chrome", async () => {
    await import("../../src/main/index.js");

    const callArgs = BrowserWindow.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.frame).toBe(false);
    expect(callArgs.skipTaskbar).toBe(true);
    if (process.platform === "darwin") {
      expect(callArgs.transparent).toBe(true);
      expect(callArgs.vibrancy).toBe("popover");
    } else {
      expect(callArgs.transparent).toBe(false);
      expect(callArgs.vibrancy).toBeUndefined();
    }
  });

  it("creates BrowserWindow with sandboxed webPreferences", async () => {
    await import("../../src/main/index.js");

    const callArgs = BrowserWindow.mock.calls[0]![0] as { webPreferences: Record<string, unknown> };
    expect(callArgs.webPreferences.sandbox).toBe(true);
    expect(callArgs.webPreferences.contextIsolation).toBe(true);
    expect(callArgs.webPreferences.nodeIntegration).toBe(false);
  });

  it("sets preload path in webPreferences", async () => {
    await import("../../src/main/index.js");

    const callArgs = BrowserWindow.mock.calls[0]![0] as { webPreferences: Record<string, unknown> };
    expect(callArgs.webPreferences.preload).toContain("preload");
    expect(callArgs.webPreferences.preload).toContain("index.cjs");
  });

  it("routes startup rejection through the sole before-quit cleanup owner", async () => {
    const startup = Promise.withResolvers<void>();
    mockCompositionInit.mockReturnValue(startup.promise);
    const { app } = await import("electron");
    await import("../../src/main/index.js");
    startup.reject(new Error("settings failed"));
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    const quitHandlers = mockOn.mock.calls.filter((call) => call[0] === "before-quit");
    expect(quitHandlers).toHaveLength(1);
    const event = { preventDefault: vi.fn() };
    quitHandlers[0]?.[1](event);
    await vi.waitFor(() => expect(mockExit).toHaveBeenCalledWith(0));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockCompositionCleanup).toHaveBeenCalledTimes(1);
    expect(mockRegisterIpcHandlers).not.toHaveBeenCalled();
    expect(mockSetupTray).not.toHaveBeenCalled();
    quitHandlers[0]?.[1]({ preventDefault: vi.fn() });
    expect(mockExit).toHaveBeenCalledTimes(1);
  });
});
