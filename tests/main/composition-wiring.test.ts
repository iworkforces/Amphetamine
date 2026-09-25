import { describe, it, expect, vi, beforeEach } from "vitest";

// Helper: extracts the first argument of the first call of a hoisted mock with
// type assertion. vi.hoisted(() => vi.fn(() => ...)) infers an empty-args
// signature, so mock.calls[0]?.[0] is typed as `undefined`. Routing through a
// generic helper that accepts a mock with `unknown[][]` calls lets us assert
// the deps shape captured at call-site without `as any`.
function firstCallArg<T>(mock: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): T {
  const call = mock.mock.calls[0];
  if (!call || call.length === 0) {
    throw new Error("Expected mock to have been called at least once");
  }
  return call[0] as T;
}

// Hoisted mocks
const mockGetSettings = vi.hoisted(() => vi.fn());
const mockOnSettingsChanged = vi.hoisted(() => vi.fn());
const mockUpdateSettings = vi.hoisted(() => vi.fn());
const mockSyncAutoLaunch = vi.hoisted(() => vi.fn());
const mockGetAllWindows = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockLogInfo = vi.hoisted(() => vi.fn());
const mockRegisterGlobalShortcut = vi.hoisted(() => vi.fn());

// Sleep-prevention mocks
const mockSyncPreventSleep = vi.hoisted(() => vi.fn());
const mockStopPreventingSleep = vi.hoisted(() => vi.fn());
const mockIsPreventingSleep = vi.hoisted(() => vi.fn());

// Battery-monitor factory mocks
const mockBatteryInit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockBatteryCleanup = vi.hoisted(() => vi.fn());
const mockBatteryOnPreventSleepChange = vi.hoisted(() => vi.fn());
const mockBatteryReconfigure = vi.hoisted(() => vi.fn());
const mockCreateBatteryMonitor = vi.hoisted(() =>
  vi.fn(() => ({
    initBatteryMonitoring: mockBatteryInit,
    cleanupBatteryMonitoring: mockBatteryCleanup,
    onPreventSleepChange: mockBatteryOnPreventSleepChange,
    reconfigure: mockBatteryReconfigure,
  })),
);

// Session-timer factory mocks
const mockSessionStart = vi.hoisted(() => vi.fn());
const mockSessionCancel = vi.hoisted(() => vi.fn());
const mockSessionGetStatus = vi.hoisted(() => vi.fn());
const mockSessionCleanup = vi.hoisted(() => vi.fn());
const mockSessionReconcile = vi.hoisted(() => vi.fn());
const mockSessionBroadcast = vi.hoisted(() => vi.fn());
const mockCreateSessionTimer = vi.hoisted(() =>
  vi.fn(() => ({
    startSession: mockSessionStart,
    cancelSession: mockSessionCancel,
    getStatus: mockSessionGetStatus,
    cleanup: mockSessionCleanup,
    reconcileSessionState: mockSessionReconcile,
    broadcastSessionUpdate: mockSessionBroadcast,
  })),
);

const mockCreateSettingsWindow = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: { isPackaged: false, focus: vi.fn() },
  BrowserWindow: { getAllWindows: mockGetAllWindows },
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn(),
    isOnBatteryPower: vi.fn().mockReturnValue(false),
  },
}));

vi.mock("electron-log", () => ({
  default: { info: mockLogInfo, error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../src/infrastructure/updater/hybrid-auto-updater.js", () => ({
  configureHybridAutoUpdater: vi.fn(),
  initAutoUpdater: vi.fn(),
  stopAutoUpdater: vi.fn(),
  checkForUpdatesNow: vi.fn(),
  checkForUpdatesForIpc: vi.fn(),
}));

vi.mock("../../src/main/settings.js", () => ({
  initSettings: vi.fn().mockResolvedValue(undefined),
  getSettings: mockGetSettings,
  onSettingsChanged: mockOnSettingsChanged,
  updateSettings: mockUpdateSettings,
  getSettingsStore: () => ({
    init: vi.fn(),
    get: mockGetSettings,
    update: mockUpdateSettings,
    onChange: mockOnSettingsChanged,
    flush: vi.fn(),
    save: vi.fn(),
  }),
}));

vi.mock("../../src/main/auto-launch.js", () => ({
  syncAutoLaunch: mockSyncAutoLaunch,
  getAutoLaunchPort: () => ({ sync: mockSyncAutoLaunch }),
}));

vi.mock("../../src/main/global-shortcut.js", () => ({
  registerGlobalShortcut: mockRegisterGlobalShortcut,
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

// Use cases / logger pull through real modules; electron-log already mocked.

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
  createSettingsWindow: mockCreateSettingsWindow,
  closeSettingsWindow: vi.fn(),
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

describe("composition wiring", () => {
  /** Live composition under test (replaces coordinator façade entrypoints). */
  let composition: {
    init: () => Promise<void>;
    cleanup: () => void;
    getTrayDeps: () => {
      getEffectiveActive: () => boolean;
      onActiveStateChanged: (cb: () => void) => () => void;
      getPreventSleep?: () => boolean;
      togglePreventSleep?: () => unknown;
      onSettingsChanged?: (cb: () => void) => () => void;
      openSettings?: () => void;
      checkForUpdates?: () => void;
    };
    ready: boolean;
  } | null;
  let settingsCallback: (_settings: Record<string, unknown>) => void;

  const defaultSettings = {
    launchAtLogin: false,
    preventSleep: false,
    defaultSessionDuration: null as number | null,
    batteryThreshold: 0,
    shortcut: "",
    // Union (not `as const` singleton) so mode-switch tests can emit either value.
    sleepBlockMode: "prevent-display-sleep" as "prevent-display-sleep" | "prevent-app-suspension",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Re-wire factories that return handles after clearAllMocks reset return values
    mockCreateBatteryMonitor.mockReturnValue({
      initBatteryMonitoring: mockBatteryInit,
      cleanupBatteryMonitoring: mockBatteryCleanup,
      onPreventSleepChange: mockBatteryOnPreventSleepChange,
      reconfigure: mockBatteryReconfigure,
    });
    mockCreateSessionTimer.mockReturnValue({
      startSession: mockSessionStart,
      cancelSession: mockSessionCancel,
      getStatus: mockSessionGetStatus,
      cleanup: mockSessionCleanup,
      reconcileSessionState: mockSessionReconcile,
      broadcastSessionUpdate: mockSessionBroadcast,
    });
    mockBatteryInit.mockResolvedValue(undefined);

    // Capture the callback passed to onSettingsChanged
    mockOnSettingsChanged.mockImplementation((cb: (_settings: Record<string, unknown>) => void) => {
      settingsCallback = cb;
      return () => {}; // unsubscribe fn
    });

    mockGetSettings.mockReturnValue({ ...defaultSettings });
    mockGetAllWindows.mockReturnValue([]);

    composition = null;
  });

  async function initComposition(): Promise<void> {
    const { createAppComposition } = await import("../../src/main/composition-root.js");
    composition = createAppComposition();
    await composition.init();
  }

  function cleanupComposition(): void {
    composition?.cleanup();
    composition = null;
  }

  function requireTrayDeps() {
    if (composition === null || !composition.ready) {
      throw new Error("[composition] getTrayDeps() called before composition.init()");
    }
    return composition.getTrayDeps();
  }

  describe("composition.init", () => {
    it("syncs auto-launch state on init", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, launchAtLogin: true });
      await initComposition();

      expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
    });

    it("syncs preventSleep state on init", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: true });
      await initComposition();

      expect(mockSyncPreventSleep).toHaveBeenCalledWith(true, "prevent-display-sleep");
    });

    it("constructs the session timer with explicit deps", async () => {
      await initComposition();

      expect(mockCreateSessionTimer).toHaveBeenCalledTimes(1);
      const deps = firstCallArg<Record<string, unknown>>(mockCreateSessionTimer);
      expect(typeof deps.broadcast).toBe("function");
    });

    it("constructs a session timer handle for injection (no module-level delegators)", async () => {
      await initComposition();

      expect(mockCreateSessionTimer).toHaveBeenCalledTimes(1);
      expect(mockCreateSessionTimer).toHaveBeenCalledWith(
        expect.objectContaining({
          broadcast: expect.any(Function),
        }),
      );
    });

    it("constructs the battery monitor with explicit deps", async () => {
      await initComposition();

      expect(mockCreateBatteryMonitor).toHaveBeenCalledTimes(1);
      const deps = firstCallArg<Record<string, unknown>>(mockCreateBatteryMonitor);
      expect(typeof deps.getThreshold).toBe("function");
      expect(typeof deps.onAutoStop).toBe("function");
      expect(typeof deps.isPreventingSleep).toBe("function");
      // Battery monitor is a pure detector — it must NOT receive a direct
      // sleep-prevention stop wrapper. Policy lives in composition (HandleLowBatteryAutoStop).
      expect(deps.stopPreventingSleep).toBeUndefined();
    });

    it("battery onAutoStop cancels session and clears standing preventSleep when set", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: true });
      await initComposition();

      const deps = firstCallArg<{ onAutoStop: () => void }>(mockCreateBatteryMonitor);
      mockSessionCancel.mockClear();
      mockUpdateSettings.mockClear();
      mockUpdateSettings.mockResolvedValueOnce(undefined);

      deps.onAutoStop();

      expect(mockUpdateSettings).toHaveBeenCalledWith({ preventSleep: false });
      expect(mockSessionCancel).toHaveBeenCalledTimes(1);
      // The detector must NOT have been given a direct stopPreventingSleep wrapper.
      expect(mockStopPreventingSleep).not.toHaveBeenCalled();
    });

    it("battery onAutoStop skips updateSettings when preventSleep is already false but still cancels session", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: false });
      await initComposition();

      const deps = firstCallArg<{ onAutoStop: () => void }>(mockCreateBatteryMonitor);
      mockSessionCancel.mockClear();
      mockUpdateSettings.mockClear();

      deps.onAutoStop();

      expect(mockUpdateSettings).not.toHaveBeenCalled();
      expect(mockSessionCancel).toHaveBeenCalledTimes(1);
    });

    it("battery onAutoStop swallows updateSettings rejection without floating", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: true });
      await initComposition();

      const deps = firstCallArg<{ onAutoStop: () => void }>(mockCreateBatteryMonitor);
      mockUpdateSettings.mockClear();
      mockUpdateSettings.mockRejectedValueOnce(new Error("disk full"));

      // Must not throw synchronously and must not produce an unhandled rejection.
      expect(() => deps.onAutoStop()).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    });

    it("battery getThreshold reads current settings", async () => {
      await initComposition();

      const deps = firstCallArg<{ getThreshold: () => number }>(mockCreateBatteryMonitor);
      mockGetSettings.mockReturnValue({ ...defaultSettings, batteryThreshold: 42 });
      expect(deps.getThreshold()).toBe(42);
    });

    it("initializes battery monitoring", async () => {
      await initComposition();

      expect(mockBatteryInit).toHaveBeenCalled();
    });

    it("subscribes to settings changes", async () => {
      await initComposition();

      expect(mockOnSettingsChanged).toHaveBeenCalledWith(expect.any(Function));
    });

    it("registers global shortcut with deps", async () => {
      await initComposition();

      expect(mockRegisterGlobalShortcut).toHaveBeenCalledWith(
        expect.objectContaining({
          getShortcut: expect.any(Function),
          getPreventSleep: expect.any(Function),
          togglePreventSleep: expect.any(Function),
        }),
      );
    });

    it("syncs preventSleep on settings change", async () => {
      await initComposition();

      settingsCallback({ ...defaultSettings, preventSleep: true });

      expect(mockSyncPreventSleep).toHaveBeenCalledWith(true, "prevent-display-sleep");
    });

    it("syncs autoLaunch on settings change", async () => {
      await initComposition();

      settingsCallback({ ...defaultSettings, launchAtLogin: true });

      expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
    });

    it("does NOT cancel session when preventSleep transitions true to false (preference is orthogonal)", async () => {
      // FIX: settings.preventSleep is now the user's standing preference,
      // NOT "a session is active". Toggling it off must NOT cancel the session.
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: true });
      await initComposition();
      mockSessionCancel.mockClear();
      mockSyncPreventSleep.mockClear();

      settingsCallback({ ...defaultSettings, preventSleep: false });

      expect(mockSessionCancel).not.toHaveBeenCalled();
      // sleep prevention recomputed: userIntent=false, sessionActive=false (no session in test) → false
      expect(mockSyncPreventSleep).toHaveBeenCalledWith(false, "prevent-display-sleep");
    });

    it("does not cancel session when preventSleep stays false", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: false });
      await initComposition();
      mockSessionCancel.mockClear();

      settingsCallback({ ...defaultSettings, preventSleep: false });

      expect(mockSessionCancel).not.toHaveBeenCalled();
    });

    it("does not cancel session when preventSleep transitions false to true", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: false });
      await initComposition();
      mockSessionCancel.mockClear();

      settingsCallback({ ...defaultSettings, preventSleep: true });

      expect(mockSessionCancel).not.toHaveBeenCalled();
    });

    it("broadcasts settings to all renderer windows", async () => {
      const mockSend = vi.fn();
      mockGetAllWindows.mockReturnValue([
        { isDestroyed: () => false, webContents: { send: mockSend } },
      ]);

      await initComposition();

      const newSettings = { ...defaultSettings, preventSleep: true };
      settingsCallback(newSettings);

      expect(mockSend).toHaveBeenCalledWith("settings:changed", newSettings);
    });

    it("broadcasts to multiple windows", async () => {
      const mockSend1 = vi.fn();
      const mockSend2 = vi.fn();
      mockGetAllWindows.mockReturnValue([
        { isDestroyed: () => false, webContents: { send: mockSend1 } },
        { isDestroyed: () => false, webContents: { send: mockSend2 } },
      ]);

      await initComposition();

      const newSettings = { ...defaultSettings, preventSleep: true };
      settingsCallback(newSettings);

      expect(mockSend1).toHaveBeenCalledWith("settings:changed", newSettings);
      expect(mockSend2).toHaveBeenCalledWith("settings:changed", newSettings);
    });

    it("logs initialization", async () => {
      await initComposition();

      expect(mockLogInfo).toHaveBeenCalledWith("[composition] Initialized");
    });
  });

  describe("shallow-diff + shortcut re-register + sleep recomputation", () => {
    it("recursion is structurally impossible: settings.preventSleep no longer triggers cancelSession", async () => {
      // Previously cancelSession() wrote preventSleep:false to settings, which
      // re-triggered the subscriber, requiring an inSubscriber guard. Now
      // cancelSession() does not touch settings, so the recursion vector is gone.
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: true });
      await initComposition();

      mockSyncPreventSleep.mockClear();
      mockSessionCancel.mockClear();

      settingsCallback({ ...defaultSettings, preventSleep: false });

      // No session cancellation — the user simply disabled their standing preference.
      expect(mockSessionCancel).not.toHaveBeenCalled();
      // Sleep recomputed exactly once.
      expect(mockSyncPreventSleep).toHaveBeenCalledTimes(1);
      expect(mockSyncPreventSleep).toHaveBeenCalledWith(false, "prevent-display-sleep");
    });

    it("skips sync + broadcast when settings are identical (shallow-equal)", async () => {
      const mockSend = vi.fn();
      mockGetAllWindows.mockReturnValue([
        { isDestroyed: () => false, webContents: { send: mockSend } },
      ]);
      await initComposition();

      mockSyncAutoLaunch.mockClear();
      mockSyncPreventSleep.mockClear();
      mockSend.mockClear();

      settingsCallback({ ...defaultSettings });

      expect(mockSyncAutoLaunch).not.toHaveBeenCalled();
      expect(mockSyncPreventSleep).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("re-registers shortcut when shortcut setting changes", async () => {
      await initComposition();
      expect(mockRegisterGlobalShortcut).toHaveBeenCalledTimes(1);

      settingsCallback({ ...defaultSettings, shortcut: "Cmd+Shift+B" });

      expect(mockRegisterGlobalShortcut).toHaveBeenCalledTimes(2);
    });

    it("does not re-register shortcut when shortcut is unchanged", async () => {
      await initComposition();
      expect(mockRegisterGlobalShortcut).toHaveBeenCalledTimes(1);

      settingsCallback({ ...defaultSettings, preventSleep: true });

      expect(mockRegisterGlobalShortcut).toHaveBeenCalledTimes(1);
    });

    it("still processes genuine changes (syncPreventSleep called)", async () => {
      await initComposition();
      mockSyncPreventSleep.mockClear();

      settingsCallback({ ...defaultSettings, preventSleep: true });

      expect(mockSyncPreventSleep).toHaveBeenCalledWith(true, "prevent-display-sleep");
    });
  });

  describe("composition.cleanup", () => {
    it("unsubscribes from settings changes", async () => {
      const mockUnsubscribe = vi.fn();
      mockOnSettingsChanged.mockReturnValue(mockUnsubscribe);
      await initComposition();

      cleanupComposition();

      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it("stops preventing sleep", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: true });
      await initComposition();
      cleanupComposition();

      expect(mockStopPreventingSleep).toHaveBeenCalledTimes(1);
    });

    it("cleans up battery monitoring", async () => {
      await initComposition();
      cleanupComposition();

      expect(mockBatteryCleanup).toHaveBeenCalledTimes(1);
    });

    it("cleans up the session timer on cleanup", async () => {
      await initComposition();
      mockSessionCleanup.mockClear();
      cleanupComposition();

      expect(mockSessionCleanup).toHaveBeenCalledTimes(1);
    });

    it("logs cleanup", async () => {
      await initComposition();
      cleanupComposition();

      expect(mockLogInfo).toHaveBeenCalledWith("[composition] Cleaned up");
    });

    it("handles cleanup when not initialized", async () => {
      // cleanup without init — should not throw
      expect(() => cleanupComposition()).not.toThrow();
    });
  });

  describe("getTrayDeps (effective active state)", () => {
    it("exposes getEffectiveActive and onActiveStateChanged", async () => {
      await initComposition();
      const deps = requireTrayDeps();
      expect(typeof deps.getEffectiveActive).toBe("function");
      expect(typeof deps.onActiveStateChanged).toBe("function");
    });

    it("getEffectiveActive reflects userIntent OR session active state", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: false });
      await initComposition();
      const deps = requireTrayDeps();

      expect(deps.getEffectiveActive()).toBe(false);

      // Simulate session-timer signaling active state.
      const timerDeps = firstCallArg<{ onSessionActiveChange: (active: boolean) => void }>(
        mockCreateSessionTimer,
      );
      timerDeps.onSessionActiveChange(true);

      expect(deps.getEffectiveActive()).toBe(true);
    });

    it("notifies tray listeners when effective active state flips on session start with preventSleep=false", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: false });
      await initComposition();
      const deps = requireTrayDeps();

      const listener = vi.fn();
      deps.onActiveStateChanged(listener);

      const timerDeps = firstCallArg<{ onSessionActiveChange: (active: boolean) => void }>(
        mockCreateSessionTimer,
      );
      timerDeps.onSessionActiveChange(true);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(deps.getEffectiveActive()).toBe(true);
    });

    it("does not notify when effective state is unchanged", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: true });
      await initComposition();
      const deps = requireTrayDeps();

      const listener = vi.fn();
      deps.onActiveStateChanged(listener);

      // userIntent already true → effective already true. Session going active
      // should not re-notify (no change).
      const timerDeps = firstCallArg<{ onSessionActiveChange: (active: boolean) => void }>(
        mockCreateSessionTimer,
      );
      timerDeps.onSessionActiveChange(true);

      expect(listener).not.toHaveBeenCalled();
    });

    it("onActiveStateChanged returns an unsubscribe function", async () => {
      await initComposition();
      const deps = requireTrayDeps();

      const listener = vi.fn();
      const unsubscribe = deps.onActiveStateChanged(listener);
      unsubscribe();

      const timerDeps = firstCallArg<{ onSessionActiveChange: (active: boolean) => void }>(
        mockCreateSessionTimer,
      );
      timerDeps.onSessionActiveChange(true);

      expect(listener).not.toHaveBeenCalled();
    });

    // Effective-active OR matrix (userIntent || sessionActive).
    it.each([
      { preventSleep: false, sessionActive: false, expected: false },
      { preventSleep: true, sessionActive: false, expected: true },
      { preventSleep: false, sessionActive: true, expected: true },
      { preventSleep: true, sessionActive: true, expected: true },
    ] as const)(
      "OR matrix: preventSleep=$preventSleep sessionActive=$sessionActive → effective=$expected",
      async ({ preventSleep, sessionActive, expected }) => {
        mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep });
        await initComposition();
        const deps = requireTrayDeps();

        if (sessionActive) {
          const timerDeps = firstCallArg<{ onSessionActiveChange: (active: boolean) => void }>(
            mockCreateSessionTimer,
          );
          timerDeps.onSessionActiveChange(true);
        }

        expect(deps.getEffectiveActive()).toBe(expected);
        // Last syncPreventSleep call must match effective OR policy + current mode.
        expect(mockSyncPreventSleep).toHaveBeenLastCalledWith(expected, "prevent-display-sleep");
      },
    );
  });

  describe("settings reactions: rendererVisibleKeys + sleepBlockMode", () => {
    function setupBroadcastCapture(): ReturnType<typeof vi.fn> {
      const mockSend = vi.fn();
      mockGetAllWindows.mockReturnValue([
        { isDestroyed: () => false, webContents: { send: mockSend } },
      ]);
      return mockSend;
    }

    it("launchAtLogin-only change does NOT broadcast SETTINGS_CHANGED", async () => {
      const mockSend = setupBroadcastCapture();
      await initComposition();
      mockSend.mockClear();
      mockSyncAutoLaunch.mockClear();

      settingsCallback({ ...defaultSettings, launchAtLogin: true });

      expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("sleepBlockMode-only change does NOT broadcast SETTINGS_CHANGED", async () => {
      const mockSend = setupBroadcastCapture();
      mockIsPreventingSleep.mockReturnValue(false);
      await initComposition();
      mockSend.mockClear();

      settingsCallback({
        ...defaultSettings,
        sleepBlockMode: "prevent-app-suspension",
      });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it("defaultSessionDuration-only change does NOT broadcast SETTINGS_CHANGED", async () => {
      const mockSend = setupBroadcastCapture();
      await initComposition();
      mockSend.mockClear();

      settingsCallback({ ...defaultSettings, defaultSessionDuration: 60 });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it("batteryThreshold change broadcasts SETTINGS_CHANGED and reconfigures battery", async () => {
      const mockSend = setupBroadcastCapture();
      await initComposition();
      mockSend.mockClear();
      mockBatteryReconfigure.mockClear();

      const next = { ...defaultSettings, batteryThreshold: 20 };
      settingsCallback(next);

      expect(mockBatteryReconfigure).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("settings:changed", next);
    });

    it("shortcut change broadcasts SETTINGS_CHANGED and re-registers shortcut", async () => {
      const mockSend = setupBroadcastCapture();
      await initComposition();
      mockSend.mockClear();
      const registerCountAfterInit = mockRegisterGlobalShortcut.mock.calls.length;

      const next = { ...defaultSettings, shortcut: "CommandOrControl+Shift+Z" };
      settingsCallback(next);

      expect(mockRegisterGlobalShortcut.mock.calls.length).toBe(registerCountAfterInit + 1);
      expect(mockSend).toHaveBeenCalledWith("settings:changed", next);
    });

    /**
     * Production order: settings cache updates, then onSettingsChanged fires.
     * recomputeSleepPrevention reads sleepBlockMode via getSettings() (not the
     * event payload alone), so tests must advance the mock cache first.
     */
    function emitSettingsChange(next: typeof defaultSettings): void {
      mockGetSettings.mockReturnValue({ ...next });
      settingsCallback({ ...next });
    }

    it("sleepBlockMode change recomputes when preventSleep is true", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: true });
      mockIsPreventingSleep.mockReturnValue(true);
      await initComposition();
      mockSyncPreventSleep.mockClear();

      emitSettingsChange({
        ...defaultSettings,
        preventSleep: true,
        sleepBlockMode: "prevent-app-suspension",
      });

      expect(mockSyncPreventSleep).toHaveBeenCalledWith(true, "prevent-app-suspension");
    });

    it("sleepBlockMode change recomputes when blocker is already active (intent false)", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: false });
      mockIsPreventingSleep.mockReturnValue(true);
      await initComposition();
      mockSyncPreventSleep.mockClear();

      emitSettingsChange({
        ...defaultSettings,
        preventSleep: false,
        sleepBlockMode: "prevent-app-suspension",
      });

      // userIntent false + session inactive → effective false, but recompute still runs
      // so the active blocker restarts under the new mode.
      expect(mockSyncPreventSleep).toHaveBeenCalledWith(false, "prevent-app-suspension");
    });

    it("sleepBlockMode change recomputes when a session is active", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: false });
      mockIsPreventingSleep.mockReturnValue(false);
      await initComposition();

      const timerDeps = firstCallArg<{ onSessionActiveChange: (active: boolean) => void }>(
        mockCreateSessionTimer,
      );
      timerDeps.onSessionActiveChange(true);
      mockSyncPreventSleep.mockClear();
      mockIsPreventingSleep.mockReturnValue(true);

      emitSettingsChange({
        ...defaultSettings,
        preventSleep: false,
        sleepBlockMode: "prevent-app-suspension",
      });

      expect(mockSyncPreventSleep).toHaveBeenCalledWith(true, "prevent-app-suspension");
    });

    it("sleepBlockMode change does NOT recompute when idle (no intent, no session, blocker off)", async () => {
      mockGetSettings.mockReturnValue({ ...defaultSettings, preventSleep: false });
      mockIsPreventingSleep.mockReturnValue(false);
      await initComposition();
      mockSyncPreventSleep.mockClear();

      emitSettingsChange({
        ...defaultSettings,
        preventSleep: false,
        sleepBlockMode: "prevent-app-suspension",
      });

      expect(mockSyncPreventSleep).not.toHaveBeenCalled();
    });
  });

  describe("getTrayDeps before init", () => {
    it("throws when requireTrayDeps used before composition.init", async () => {
      const { createAppComposition } = await import("../../src/main/composition-root.js");
      composition = createAppComposition();
      expect(() => requireTrayDeps()).toThrow(/before composition\.init/i);
    });
  });
});
