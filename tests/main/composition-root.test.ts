import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetSettings = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    launchAtLogin: false,
    preventSleep: false,
    defaultSessionDuration: null,
    batteryThreshold: 0,
    shortcut: "",
    sleepBlockMode: "prevent-display-sleep",
  }),
);
const mockOnSettingsChanged = vi.hoisted(() => vi.fn(() => () => {}));
const mockUpdateSettings = vi.hoisted(() => vi.fn());
const mockInitSettings = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSyncPreventSleep = vi.hoisted(() => vi.fn());
const mockStopPreventingSleep = vi.hoisted(() => vi.fn());
const mockIsPreventingSleep = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockCreateSessionTimer = vi.hoisted(() =>
  vi.fn(() => ({
    startSession: vi.fn(),
    cancelSession: vi.fn(),
    getStatus: vi.fn(),
    cleanup: vi.fn(),
    reconcileSessionState: vi.fn(),
    broadcastSessionUpdate: vi.fn(),
    sessionActive: false,
  })),
);
const mockCreateBatteryMonitor = vi.hoisted(() =>
  vi.fn(() => ({
    initBatteryMonitoring: vi.fn().mockResolvedValue(undefined),
    cleanupBatteryMonitoring: vi.fn(),
    onPreventSleepChange: vi.fn(),
    reconfigure: vi.fn(),
  })),
);

vi.mock("electron", () => ({
  powerMonitor: { on: vi.fn(), off: vi.fn(), isOnBatteryPower: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
  app: { isPackaged: false, focus: vi.fn() },
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../src/infrastructure/updater/hybrid-auto-updater.js", () => ({
  configureHybridAutoUpdater: vi.fn(),
  initAutoUpdater: vi.fn(),
  stopAutoUpdater: vi.fn(),
  checkForUpdatesNow: vi.fn(),
  checkForUpdatesForIpc: vi.fn(),
}));
vi.mock("../../src/main/settings.js", () => ({
  initSettings: mockInitSettings,
  getSettings: mockGetSettings,
  onSettingsChanged: mockOnSettingsChanged,
  updateSettings: mockUpdateSettings,
  getSettingsStore: () => ({
    init: mockInitSettings,
    get: mockGetSettings,
    update: mockUpdateSettings,
    onChange: mockOnSettingsChanged,
    flush: vi.fn(),
    save: vi.fn(),
  }),
}));
vi.mock("../../src/main/auto-launch.js", () => ({
  getAutoLaunchPort: () => ({ sync: vi.fn() }),
  syncAutoLaunch: vi.fn(),
}));
vi.mock("../../src/main/global-shortcut.js", () => ({
  registerGlobalShortcut: vi.fn(),
  unregisterGlobalShortcut: vi.fn(),
}));
vi.mock("../../src/main/sleep-prevention.js", () => ({
  syncPreventSleep: mockSyncPreventSleep,
  stopPreventingSleep: mockStopPreventingSleep,
  isPreventingSleep: mockIsPreventingSleep,
  getSleepBlockerPort: () => ({
    sync: mockSyncPreventSleep,
    isActive: mockIsPreventingSleep,
    stop: mockStopPreventingSleep,
  }),
}));
vi.mock("../../src/main/battery-monitor.js", () => ({
  createBatteryMonitor: mockCreateBatteryMonitor,
}));
vi.mock("../../src/main/session-timer.js", () => ({
  createSessionTimer: mockCreateSessionTimer,
}));
vi.mock("../../src/main/auto-updater.js", () => ({
  registerAutoUpdaterIpc: vi.fn(),
  stopAutoUpdater: vi.fn(),
  initAutoUpdater: vi.fn(),
  checkForUpdatesNow: vi.fn(),
}));
vi.mock("../../src/main/settings-window.js", () => ({
  createSettingsWindow: vi.fn(),
  closeSettingsWindow: vi.fn(),
  isSettingsWindowOpen: vi.fn().mockReturnValue(false),
}));
vi.mock("../../src/main/about-window.js", () => ({
  closeAboutWindow: vi.fn(),
}));
vi.mock("../../src/main/utils/packageInfo.js", () => ({
  getPackageInfo: () => ({
    repository: "https://github.com/iworkforces/Amphetamine",
    productName: "Amphetamine",
    version: "1.0.0",
    description: "",
    author: "Test",
  }),
}));
vi.mock("../../src/main/platform/index.js", () => ({
  enterForegroundMode: vi.fn(),
  enterTrayOnlyMode: vi.fn(),
  acquireUtilityForeground: vi.fn(),
  releaseUtilityForeground: vi.fn(),
}));
vi.mock("../../src/main/process/window-graph.js", () => ({
  presentUtilityDialog: vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false }),
}));

describe("createAppComposition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockCreateSessionTimer.mockReturnValue({
      startSession: vi.fn(),
      cancelSession: vi.fn(),
      getStatus: vi.fn(),
      cleanup: vi.fn(),
      reconcileSessionState: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
      sessionActive: false,
    });
    mockCreateBatteryMonitor.mockReturnValue({
      initBatteryMonitoring: vi.fn().mockResolvedValue(undefined),
      cleanupBatteryMonitoring: vi.fn(),
      onPreventSleepChange: vi.fn(),
      reconfigure: vi.fn(),
    });
    mockOnSettingsChanged.mockReturnValue(() => {});
    mockGetSettings.mockReturnValue({
      launchAtLogin: false,
      preventSleep: false,
      defaultSessionDuration: null,
      batteryThreshold: 0,
      shortcut: "",
      sleepBlockMode: "prevent-display-sleep",
    });
  });

  it("session IPC deps fail closed before init", async () => {
    const { createAppComposition } = await import("../../src/main/composition-root.js");
    const composition = createAppComposition();
    const deps = composition.getIpcDeps();
    expect(() => deps.sessionTimer.startSession(30)).toThrow(/not ready/i);
    expect(() => deps.sessionTimer.cancelSession()).toThrow(/not ready/i);
    expect(() => deps.sessionTimer.getStatus()).toThrow(/not ready/i);
  });

  it("session IPC deps work after init", async () => {
    const startSession = vi.fn().mockReturnValue({
      isRunning: true,
      startedAt: 1,
      expiresAt: null,
      durationMinutes: null,
    });
    mockCreateSessionTimer.mockReturnValue({
      startSession,
      cancelSession: vi.fn(),
      getStatus: vi.fn().mockReturnValue({
        isRunning: false,
        startedAt: null,
        expiresAt: null,
        remainingSeconds: null,
        durationMinutes: null,
      }),
      cleanup: vi.fn(),
      reconcileSessionState: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
      sessionActive: false,
    });

    const { createAppComposition } = await import("../../src/main/composition-root.js");
    const composition = createAppComposition();
    await composition.init();
    const deps = composition.getIpcDeps();
    deps.sessionTimer.startSession(30);
    expect(startSession).toHaveBeenCalledWith(30);
    composition.cleanup();
  });

  it("getTrayDeps works after init and cleanup clears ready", async () => {
    const { createAppComposition } = await import("../../src/main/composition-root.js");
    const composition = createAppComposition();
    await composition.init();
    const tray = composition.getTrayDeps();
    expect(typeof tray.getEffectiveActive).toBe("function");
    expect(typeof tray.checkForUpdates).toBe("function");
    expect(tray.getPreventSleep()).toBe(false);
    tray.checkForUpdates();
    const unsub = tray.onActiveStateChanged(() => {});
    unsub();
    composition.cleanup();
    expect(composition.ready).toBe(false);
  });
});
