import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

interface MockWindow {
  isDestroyed: () => boolean;
  webContents: { send: Mock };
}

function createMockWindow(): MockWindow {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}

// --- Hoisted mocks ---
const mockOn = vi.hoisted(() => vi.fn());
const mockOff = vi.hoisted(() => vi.fn());
const mockCheckForUpdates = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockDownloadUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockQuitAndInstall = vi.hoisted(() => vi.fn());
const mockGetAllWindows = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockIpcMainHandle = vi.hoisted(() => vi.fn());
const mockIpcMainRemoveHandler = vi.hoisted(() => vi.fn());
const mockGetAppPath = vi.hoisted(() => vi.fn().mockReturnValue("/path/to/app.asar"));
const mockLogInfo = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());
const mockShellOpenExternal = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockShowUserDialog = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ response: 1, checkboxChecked: false as const }),
);
const mockGetPackageInfo = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    name: "amphetamine",
    productName: "Amphetamine",
    version: "1.6.2",
    description: "",
    repository: "https://github.com/iworkforces/Amphetamine",
    homepage: "https://github.com/iworkforces/Amphetamine",
    author: "iworkforces Engineers",
  }),
);

const mockSetFeedURL = vi.hoisted(() => vi.fn());
const emitterHandlers = new Map<string, Set<(...args: unknown[]) => void>>();

function emitUpdaterEvent(event: string, ...args: unknown[]): void {
  for (const handler of emitterHandlers.get(event) ?? []) handler(...args);
}

vi.mock("electron-updater", () => ({
  autoUpdater: {
    on: mockOn,
    off: mockOff,
    checkForUpdates: mockCheckForUpdates,
    downloadUpdate: mockDownloadUpdate,
    quitAndInstall: mockQuitAndInstall,
    setFeedURL: mockSetFeedURL,
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: false,
  },
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: mockGetAppPath,
    focus: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: mockGetAllWindows,
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  ipcMain: {
    handle: mockIpcMainHandle,
    removeHandler: mockIpcMainRemoveHandler,
  },
}));

vi.mock("../../src/main/utils/packageInfo.js", () => ({
  getPackageInfo: mockGetPackageInfo,
}));

vi.mock("electron-log", () => ({
  default: { info: mockLogInfo, warn: mockLogWarn, error: mockLogError },
}));

function getHandler(eventName: string): (...args: unknown[]) => void {
  const call = mockOn.mock.calls.find((c) => c[0] === eventName);
  if (!call) throw new Error(`handler not registered: ${eventName}`);
  return call[1] as (...args: unknown[]) => void;
}

describe("auto-updater (hybrid infrastructure)", () => {
  let initAutoUpdater: () => void;
  let stopAutoUpdater: () => void;
  let registerAutoUpdaterIpc: () => () => void;
  let checkForUpdatesNow: () => void;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    emitterHandlers.clear();
    mockOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = emitterHandlers.get(event) ?? new Set();
      handlers.add(handler);
      emitterHandlers.set(event, handlers);
    });
    mockOff.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      emitterHandlers.get(event)?.delete(handler);
    });

    mockCheckForUpdates.mockResolvedValue(null);
    mockGetAppPath.mockReturnValue("/path/to/app.asar");
    mockDownloadUpdate.mockResolvedValue(undefined);
    mockGetAllWindows.mockReturnValue([]);
    mockShowUserDialog.mockResolvedValue({ response: 1, checkboxChecked: false });

    const hybrid = await import("../../src/infrastructure/updater/hybrid-auto-updater.js");
    const { broadcastToWindows } = await import("../../src/main/utils/broadcast.js");
    const { createBroadcastNotifier } =
      await import("../../src/infrastructure/notification/broadcast-notifier.js");
    const notifier = createBroadcastNotifier(broadcastToWindows);
    hybrid.configureHybridAutoUpdater({
      publish: (event) => {
        notifier.publish(event);
      },
      getRepositoryUrl: () => String(mockGetPackageInfo().repository),
      showUserDialog: mockShowUserDialog,
    });
    initAutoUpdater = hybrid.initAutoUpdater;
    stopAutoUpdater = hybrid.stopAutoUpdater;
    checkForUpdatesNow = hybrid.checkForUpdatesNow;

    const facade = await import("../../src/main/auto-updater.js");
    registerAutoUpdaterIpc = facade.registerAutoUpdaterIpc;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initAutoUpdater", () => {
    it("does nothing when app is not packaged", async () => {
      const { app } = await import("electron");
      const originalDescriptor = Object.getOwnPropertyDescriptor(app, "isPackaged");
      try {
        Object.defineProperty(app, "isPackaged", {
          value: false,
          configurable: true,
          writable: true,
        });

        vi.resetModules();
        const freshHybrid = await import("../../src/infrastructure/updater/hybrid-auto-updater.js");
        const { broadcastToWindows: bcast } = await import("../../src/main/utils/broadcast.js");
        const { createBroadcastNotifier: makeN } =
          await import("../../src/infrastructure/notification/broadcast-notifier.js");
        const n = makeN(bcast);
        freshHybrid.configureHybridAutoUpdater({
          publish: (event) => {
            n.publish(event);
          },
          getRepositoryUrl: () => "https://github.com/iworkforces/Amphetamine",
          showUserDialog: mockShowUserDialog,
        });
        freshHybrid.initAutoUpdater();

        expect(mockOn).not.toHaveBeenCalled();
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(app, "isPackaged", originalDescriptor);
        } else {
          Object.defineProperty(app, "isPackaged", {
            value: true,
            configurable: true,
            writable: true,
          });
        }
        vi.resetModules();
        await import("../../src/infrastructure/updater/hybrid-auto-updater.js");
      }
    });

    it("registers event handlers when app is packaged", () => {
      initAutoUpdater();

      expect(mockOn).toHaveBeenCalledWith("checking-for-update", expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith("update-available", expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith("update-not-available", expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith("download-progress", expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith("update-downloaded", expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("configures GitHub feed from package repository (owner/repo)", () => {
      initAutoUpdater();
      expect(mockSetFeedURL).toHaveBeenCalledWith({
        provider: "github",
        owner: "iworkforces",
        repo: "Amphetamine",
      });
    });

    it("sets autoDownload and autoInstallOnAppQuit to false", async () => {
      const { autoUpdater } = await import("electron-updater");

      initAutoUpdater();

      expect(autoUpdater.autoDownload).toBe(false);
      expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    });

    it("schedules initial check after 3 seconds", () => {
      initAutoUpdater();

      expect(mockCheckForUpdates).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3000);

      expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
    });

    it("broadcasts to windows on update-available event", () => {
      const mockWindow = createMockWindow();
      mockGetAllWindows.mockReturnValue([mockWindow]);

      initAutoUpdater();
      getHandler("update-available")({
        version: "1.2.0",
        releaseDate: "2025-01-01",
        releaseNotes: "Bug fixes",
      });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        "auto-updater:status",
        expect.objectContaining({
          status: "available",
          info: expect.objectContaining({ version: "1.2.0" }),
        }),
      );
    });

    it("does NOT open release URL or download on background update-available", () => {
      initAutoUpdater();
      getHandler("update-available")({ version: "2.0.0", releaseDate: "2025-01-01" });

      expect(mockShellOpenExternal).not.toHaveBeenCalled();
      expect(mockDownloadUpdate).not.toHaveBeenCalled();
    });

    it("broadcasts error status on error event", () => {
      const mockWindow = createMockWindow();
      mockGetAllWindows.mockReturnValue([mockWindow]);

      initAutoUpdater();
      getHandler("error")(new Error("Network error"));

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        "auto-updater:status",
        expect.objectContaining({
          status: "error",
          category: "network",
        }),
      );
    });
  });

  describe("hybrid user-initiated path", () => {
    it("downloads when update is available after checkForUpdatesNow", () => {
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("update-available")({ version: "2.0.0", releaseDate: "2025-01-01" });

      expect(mockDownloadUpdate).toHaveBeenCalledTimes(1);
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it("opens release page when downloadUpdate rejects", async () => {
      mockDownloadUpdate.mockRejectedValueOnce(new Error("signature failed"));
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("update-available")({ version: "2.0.0", releaseDate: "2025-01-01" });

      await vi.waitFor(() => {
        expect(mockShellOpenExternal).toHaveBeenCalledWith(
          "https://github.com/iworkforces/Amphetamine/releases/tag/v2.0.0",
        );
      });
    });

    it("prompts to restart after download and calls quitAndInstall on Restart", async () => {
      // HIG layout: secondary left (Later=0), primary right (Restart=1)
      mockShowUserDialog.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("update-available")({ version: "2.1.0", releaseDate: "2025-01-01" });
      getHandler("update-downloaded")({ version: "2.1.0", releaseDate: "2025-01-01" });

      await vi.waitFor(() => {
        expect(mockShowUserDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "A New Version Is Ready to Install",
            buttons: ["Later", "Restart"],
            defaultId: 1,
            cancelId: 0,
          }),
        );
      });
      await vi.waitFor(() => {
        expect(mockQuitAndInstall).toHaveBeenCalledWith(false, true);
      });
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it("does not quitAndInstall when user chooses Later", async () => {
      mockShowUserDialog.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("update-available")({ version: "2.1.0", releaseDate: "2025-01-01" });
      getHandler("update-downloaded")({ version: "2.1.0", releaseDate: "2025-01-01" });

      await vi.waitFor(() => {
        expect(mockShowUserDialog).toHaveBeenCalled();
      });
      await Promise.resolve();
      expect(mockQuitAndInstall).not.toHaveBeenCalled();
    });

    it("opens release page when quitAndInstall throws", async () => {
      mockShowUserDialog.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      mockQuitAndInstall.mockImplementationOnce(() => {
        throw new Error("unsigned");
      });
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("update-available")({ version: "2.2.0", releaseDate: "2025-01-01" });
      getHandler("update-downloaded")({ version: "2.2.0", releaseDate: "2025-01-01" });

      await vi.waitFor(() => {
        expect(mockShellOpenExternal).toHaveBeenCalledWith(
          "https://github.com/iworkforces/Amphetamine/releases/tag/v2.2.0",
        );
      });
    });

    it("opens release page on error after a known available version (user-initiated)", () => {
      mockDownloadUpdate.mockImplementationOnce(() => new Promise(() => undefined));
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("update-available")({ version: "3.0.0", releaseDate: "2025-01-01" });
      getHandler("error")(new Error("ENOTFOUND"));

      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "https://github.com/iworkforces/Amphetamine/releases/tag/v3.0.0",
      );
    });

    it("shows up-to-date dialog on user-initiated not-available", async () => {
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("update-not-available")({ version: "1.0.0", releaseDate: "2025-01-01" });

      await vi.waitFor(() => {
        expect(mockShowUserDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "You’re Up to Date",
            detail: "Amphetamine 1.0.0 is the latest version available.",
          }),
        );
      });
    });

    it("shows check-failed dialog on user-initiated error with no known version", async () => {
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("error")(new Error("Network error ENOTFOUND"));

      await vi.waitFor(() => {
        expect(mockShowUserDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Unable to Check for Updates",
            buttons: ["Open Releases…", "OK"],
            defaultId: 1,
            cancelId: 1, // Esc dismisses (OK), does not open Releases
          }),
        );
      });
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it("does not open releases when user chooses OK on check failure", async () => {
      mockShowUserDialog.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("error")(new Error("Network error ENOTFOUND"));

      await vi.waitFor(() => {
        expect(mockShowUserDialog).toHaveBeenCalled();
      });
      await Promise.resolve();
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it("opens releases list when user chooses Open Releases on check failure", async () => {
      // Secondary (Open Releases…) is index 0 in HIG two-button layout
      mockShowUserDialog.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("error")(new Error("Network error"));

      await vi.waitFor(() => {
        expect(mockShellOpenExternal).toHaveBeenCalledWith(
          "https://github.com/iworkforces/Amphetamine/releases",
        );
      });
    });

    it("rejects invalid version when falling back to browser", async () => {
      mockDownloadUpdate.mockRejectedValueOnce(new Error("fail"));
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("update-available")({ version: "malicious<script>", releaseDate: "2025-01-01" });

      await vi.waitFor(() => {
        expect(mockLogWarn).toHaveBeenCalled();
      });
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });
  });

  describe("version validation (security) for browser fallback", () => {
    async function triggerFallback(version: string): Promise<void> {
      mockDownloadUpdate.mockRejectedValueOnce(new Error("fail"));
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("update-available")({ version, releaseDate: "2025-01-01" });
      await vi.waitFor(() => {
        expect(mockDownloadUpdate).toHaveBeenCalled();
      });
      // allow rejection microtask
      await Promise.resolve();
      await Promise.resolve();
    }

    it("rejects path traversal attempts in version", async () => {
      await triggerFallback("../../../etc/passwd");
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalled();
    });

    it("rejects version with embedded HTML/script", async () => {
      await triggerFallback("<img src=x onerror=alert(1)>");
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it("rejects empty version string", async () => {
      await triggerFallback("");
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it("accepts valid semver with pre-release tag (e.g. 1.0.0-alpha)", async () => {
      await triggerFallback("1.0.0-alpha");
      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "https://github.com/iworkforces/Amphetamine/releases/tag/v1.0.0-alpha",
      );
    });

    it("accepts valid semver with build metadata (e.g. 1.0.0+build.123)", async () => {
      await triggerFallback("1.0.0+build.123");
      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "https://github.com/iworkforces/Amphetamine/releases/tag/v1.0.0%2Bbuild.123",
      );
    });

    it("rejects version with only alphabetic characters", async () => {
      await triggerFallback("latest");
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it("rejects unanchored garbage suffix (e.g. 1.2.3.evil)", async () => {
      await triggerFallback("1.2.3.evil");
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalled();
    });

    it("rejects partial semver (e.g. 1.2)", async () => {
      await triggerFallback("1.2");
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it("accepts plain semver 1.2.3", async () => {
      await triggerFallback("1.2.3");
      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "https://github.com/iworkforces/Amphetamine/releases/tag/v1.2.3",
      );
    });

    it("accepts pre-release tag 1.2.3-beta.1", async () => {
      await triggerFallback("1.2.3-beta.1");
      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "https://github.com/iworkforces/Amphetamine/releases/tag/v1.2.3-beta.1",
      );
    });

    it("URL-encodes the version when constructing the release URL", async () => {
      await triggerFallback("1.0.0+build.1");
      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "https://github.com/iworkforces/Amphetamine/releases/tag/v1.0.0%2Bbuild.1",
      );
    });

    it("derives release URL from package.json repository field (no hardcoded org)", async () => {
      await triggerFallback("3.0.0");
      const url = mockShellOpenExternal.mock.calls[0]![0] as string;
      expect(url).toContain("https://github.com/iworkforces/Amphetamine/releases/tag/");
      expect(url).not.toContain("CCWorkforce");
    });
  });

  describe("event handler details", () => {
    it("broadcasts checking-for-update status", () => {
      const mockWindow = createMockWindow();
      mockGetAllWindows.mockReturnValue([mockWindow]);

      initAutoUpdater();
      getHandler("checking-for-update")();

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        "auto-updater:status",
        expect.objectContaining({ status: "checking" }),
      );
    });

    it("broadcasts update-not-available status", () => {
      const mockWindow = createMockWindow();
      mockGetAllWindows.mockReturnValue([mockWindow]);

      initAutoUpdater();
      getHandler("update-not-available")({ version: "1.0.0", releaseDate: "2025-01-01" });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        "auto-updater:status",
        expect.objectContaining({
          status: "not-available",
          info: expect.objectContaining({ version: "1.0.0" }),
        }),
      );
    });

    it("broadcasts update-downloaded status", () => {
      const mockWindow = createMockWindow();
      mockGetAllWindows.mockReturnValue([mockWindow]);

      initAutoUpdater();
      getHandler("update-downloaded")({ version: "2.0.0", releaseDate: "2025-06-01" });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        "auto-updater:status",
        expect.objectContaining({
          status: "downloaded",
          info: expect.objectContaining({ version: "2.0.0" }),
        }),
      );
    });

    it("includes releaseNotes when present as string", () => {
      const mockWindow = createMockWindow();
      mockGetAllWindows.mockReturnValue([mockWindow]);

      initAutoUpdater();
      getHandler("update-available")({
        version: "3.0.0",
        releaseDate: "2025-01-01",
        releaseNotes: "New features",
      });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        "auto-updater:status",
        expect.objectContaining({
          status: "available",
          info: expect.objectContaining({ releaseNotes: "New features" }),
        }),
      );
    });

    it("omits releaseNotes when not a string", () => {
      const mockWindow = createMockWindow();
      mockGetAllWindows.mockReturnValue([mockWindow]);

      initAutoUpdater();
      getHandler("update-available")({
        version: "3.0.0",
        releaseDate: "2025-01-01",
        releaseNotes: [{ note: "foo" }],
      });

      const sentData = mockWindow.webContents.send.mock.calls[0]![1] as {
        info: { releaseNotes?: string };
      };
      expect(sentData.info.releaseNotes).toBeUndefined();
    });

    it("broadcasts download-progress only for user-initiated checks", () => {
      const mockWindow = createMockWindow();
      mockGetAllWindows.mockReturnValue([mockWindow]);

      initAutoUpdater();
      getHandler("download-progress")({
        percent: 50,
        transferred: 50,
        total: 100,
        bytesPerSecond: 1,
        delta: 1,
      });
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
        "auto-updater:status",
        expect.objectContaining({ status: "downloading" }),
      );

      checkForUpdatesNow();
      getHandler("download-progress")({
        percent: 50,
        transferred: 50,
        total: 100,
        bytesPerSecond: 1,
        delta: 1,
      });
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        "auto-updater:status",
        expect.objectContaining({
          status: "downloading",
          progress: expect.objectContaining({ percent: 50 }),
        }),
      );
    });
  });

  describe("stopAutoUpdater", () => {
    it("clears timers and removes only its own listeners once", () => {
      const unrelated = vi.fn();
      mockOn("error", unrelated);
      initAutoUpdater();
      initAutoUpdater();
      expect(mockOn).toHaveBeenCalledTimes(7);
      stopAutoUpdater();
      stopAutoUpdater();

      expect(mockOff).toHaveBeenCalledTimes(6);
      for (const [event, handler] of mockOn.mock.calls.slice(1)) {
        expect(mockOff).toHaveBeenCalledWith(event, handler);
      }
      emitUpdaterEvent("error", new Error("unrelated"));
      expect(unrelated).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(4 * 60 * 60 * 1000);
      expect(mockCheckForUpdates).not.toHaveBeenCalled();
    });

    it("retires a deferred IPC check and quarantines old emitter events until it settles", async () => {
      let resolveOld: ((value: unknown) => void) | undefined;
      mockCheckForUpdates.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      );
      initAutoUpdater();
      const hybrid = await import("../../src/infrastructure/updater/hybrid-auto-updater.js");
      const pending = hybrid.checkForUpdatesForIpc();
      const oldAvailable = getHandler("update-available");
      stopAutoUpdater();
      initAutoUpdater();
      expect(mockOn).toHaveBeenCalledTimes(6);
      emitUpdaterEvent("update-available", { version: "7.0.0", releaseDate: "2026-01-01" });
      emitUpdaterEvent("error", new Error("stale"));
      oldAvailable({ version: "7.0.0", releaseDate: "2026-01-01" });
      expect(mockDownloadUpdate).not.toHaveBeenCalled();
      resolveOld?.({ updateInfo: { version: "7.0.0", releaseDate: "2026-01-01" } });
      expect(await pending).toBeNull();
      await vi.waitFor(() => expect(mockOn).toHaveBeenCalledTimes(12));
      expect(mockShowUserDialog).not.toHaveBeenCalled();
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
      expect(mockDownloadUpdate).not.toHaveBeenCalled();
      expect(mockOff).toHaveBeenCalledTimes(6);
      mockCheckForUpdates.mockResolvedValueOnce(null);
      await hybrid.checkForUpdatesForIpc();
      expect(mockCheckForUpdates).toHaveBeenCalledTimes(2);
    });

    it("cancels a queued reinitialization when stopped again", async () => {
      let resolveOld: ((value: unknown) => void) | undefined;
      mockCheckForUpdates.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      );
      initAutoUpdater();
      const hybrid = await import("../../src/infrastructure/updater/hybrid-auto-updater.js");
      const pending = hybrid.checkForUpdatesForIpc();
      stopAutoUpdater();
      initAutoUpdater();
      stopAutoUpdater();
      resolveOld?.(null);
      expect(await pending).toBeNull();
      await vi.waitFor(() => expect(mockOff).toHaveBeenCalledTimes(6));
      expect(mockOn).toHaveBeenCalledTimes(6);
      initAutoUpdater();
      expect(mockOn).toHaveBeenCalledTimes(12);
      stopAutoUpdater();
    });

    it("joins a background check with tray and IPC intent without downloading twice", async () => {
      let resolveCheck: ((value: unknown) => void) | undefined;
      mockCheckForUpdates.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCheck = resolve;
          }),
      );
      initAutoUpdater();
      vi.advanceTimersByTime(3000);
      checkForUpdatesNow();
      const hybrid = await import("../../src/infrastructure/updater/hybrid-auto-updater.js");
      const ipc = hybrid.checkForUpdatesForIpc();
      expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
      const info = { version: "2.0.0", releaseDate: "2026-01-01" };
      emitUpdaterEvent("update-available", info);
      emitUpdaterEvent("update-available", info);
      resolveCheck?.({ updateInfo: info });
      expect(await ipc).toEqual(info);
      expect(mockDownloadUpdate).toHaveBeenCalledTimes(1);
      stopAutoUpdater();
    });

    it("drives the real updater port through join, retirement and reinitialization", async () => {
      let resolveOld: ((value: unknown) => void) | undefined;
      mockCheckForUpdates.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      );
      const { createElectronUpdaterPort } =
        await import("../../src/infrastructure/updater/electron-updater-port.js");
      const publish = vi.fn();
      const notifyUser = vi.fn();
      const port = createElectronUpdaterPort(
        { publish },
        {
          getRepositoryUrl: () => "https://github.com/iworkforces/Amphetamine",
          showUserDialog: mockShowUserDialog,
          notifyUser,
        },
      );
      port.init();
      vi.advanceTimersByTime(3000);
      port.checkNow();
      expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
      expect(notifyUser).toHaveBeenCalled();
      port.stop();
      port.init();
      emitUpdaterEvent("update-available", { version: "9.0.0", releaseDate: "2026-01-01" });
      expect(publish).not.toHaveBeenCalled();
      resolveOld?.({ updateInfo: { version: "9.0.0", releaseDate: "2026-01-01" } });
      await vi.waitFor(() => expect(mockOn).toHaveBeenCalledTimes(12));
      expect(mockDownloadUpdate).not.toHaveBeenCalled();
      port.checkNow();
      emitUpdaterEvent("update-not-available", { version: "2.0.5", releaseDate: "2026-01-01" });
      expect(mockCheckForUpdates).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledWith({
        type: "auto-updater-status",
        status: { status: "not-available", info: { version: "2.0.5", releaseDate: "2026-01-01" } },
      });
      port.stop();
    });

    it("reports a background check rejection without an emitter error once", async () => {
      const window = createMockWindow();
      mockGetAllWindows.mockReturnValue([window]);
      mockCheckForUpdates.mockRejectedValueOnce(new Error("offline"));
      initAutoUpdater();
      await vi.advanceTimersByTimeAsync(3000);
      emitUpdaterEvent("error", new Error("offline"));
      expect(
        window.webContents.send.mock.calls.filter((call) => call[1]?.status === "error"),
      ).toHaveLength(1);
      expect(mockShowUserDialog).not.toHaveBeenCalled();
      stopAutoUpdater();
    });

    it("ignores download rejection and install-dialog response after stop", async () => {
      let rejectDownload: ((error: Error) => void) | undefined;
      mockDownloadUpdate.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectDownload = reject;
          }),
      );
      initAutoUpdater();
      checkForUpdatesNow();
      getHandler("update-available")({ version: "2.0.0", releaseDate: "2026-01-01" });
      stopAutoUpdater();
      initAutoUpdater();
      expect(mockOn).toHaveBeenCalledTimes(6);
      rejectDownload?.(new Error("offline"));
      await vi.waitFor(() => expect(mockOn).toHaveBeenCalledTimes(12));
      expect(mockShellOpenExternal).not.toHaveBeenCalled();

      let resolveDialog:
        ((value: { response: number; checkboxChecked: boolean }) => void) | undefined;
      mockShowUserDialog.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDialog = resolve;
          }),
      );
      checkForUpdatesNow();
      getHandler("update-available")({ version: "3.0.0", releaseDate: "2026-01-01" });
      getHandler("update-downloaded")({ version: "3.0.0", releaseDate: "2026-01-01" });
      stopAutoUpdater();
      resolveDialog?.({ response: 1, checkboxChecked: false });
      await Promise.resolve();
      expect(mockQuitAndInstall).not.toHaveBeenCalled();
    });

    it("handles a timer rejection once when the emitter reports the same failure", async () => {
      let rejectCheck: ((error: Error) => void) | undefined;
      mockCheckForUpdates.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectCheck = reject;
          }),
      );
      const window = createMockWindow();
      mockGetAllWindows.mockReturnValue([window]);
      initAutoUpdater();
      vi.advanceTimersByTime(3000);
      getHandler("error")(new Error("offline"));
      rejectCheck?.(new Error("offline"));
      await Promise.resolve();
      await Promise.resolve();
      expect(
        window.webContents.send.mock.calls.filter((call) => call[1]?.status === "error"),
      ).toHaveLength(1);
      expect(mockShowUserDialog).not.toHaveBeenCalled();
      stopAutoUpdater();
    });

    it("reports and backs off once when the check emits an error before returning a rejection", async () => {
      mockCheckForUpdates.mockImplementationOnce(() => {
        emitUpdaterEvent("error", new Error("offline"));
        return Promise.reject(new Error("offline"));
      });
      const window = createMockWindow();
      mockGetAllWindows.mockReturnValue([window]);
      const intervals = vi.spyOn(globalThis, "setInterval");
      initAutoUpdater();

      await vi.advanceTimersByTimeAsync(3000);

      expect(
        window.webContents.send.mock.calls.filter((call) => call[1]?.status === "error"),
      ).toHaveLength(1);
      expect(intervals).toHaveBeenCalledTimes(2);
      expect(intervals).toHaveBeenNthCalledWith(1, expect.any(Function), 4 * 60 * 60 * 1000);
      expect(intervals).toHaveBeenNthCalledWith(2, expect.any(Function), 8 * 60 * 60 * 1000);
      expect(mockShowUserDialog).not.toHaveBeenCalled();
      stopAutoUpdater();
      intervals.mockRestore();
    });
  });

  describe("registerAutoUpdaterIpc", () => {
    it("returns an idempotent disposer for the updater invoke channel", () => {
      const unregister = registerAutoUpdaterIpc();

      unregister();
      unregister();

      expect(mockIpcMainRemoveHandler).toHaveBeenCalledExactlyOnceWith("auto-updater:check");
    });

    it("unregisters its handler if setup throws after registration", () => {
      const setupError = new Error("updater log failed");
      mockLogInfo.mockImplementationOnce(() => {
        throw setupError;
      });

      expect(() => registerAutoUpdaterIpc()).toThrow(setupError);

      expect(mockIpcMainHandle).toHaveBeenCalledWith("auto-updater:check", expect.any(Function));
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledExactlyOnceWith("auto-updater:check");
    });

    it("registers AUTO_UPDATER_CHECK handler", () => {
      registerAutoUpdaterIpc();
      expect(mockIpcMainHandle).toHaveBeenCalledWith("auto-updater:check", expect.any(Function));
    });

    it("IPC handler returns null when checkForUpdates returns no updateInfo", async () => {
      mockCheckForUpdates.mockResolvedValueOnce(null);
      registerAutoUpdaterIpc();
      const handler = mockIpcMainHandle.mock.calls.find(
        (c) => c[0] === "auto-updater:check",
      )![1] as (event: unknown) => Promise<unknown>;

      const result = await handler({
        senderFrame: { parent: null, url: "file:///path/to/app.asar/lib/renderer/index.html" },
      });
      expect(result).toBeNull();
      expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
    });

    it("accepts a packaged Windows renderer sender with spaces in its path", async () => {
      mockGetAppPath.mockReturnValue("C:\\Program Files\\Amphetamine\\resources\\app.asar");
      mockCheckForUpdates.mockResolvedValueOnce({
        updateInfo: { version: "2.0.0", releaseDate: "2026-01-01" },
      });
      registerAutoUpdaterIpc();
      const handler = mockIpcMainHandle.mock.calls.find(
        (call) => call[0] === "auto-updater:check",
      )![1] as (event: unknown) => Promise<unknown>;

      const result = await handler({
        senderFrame: {
          parent: null,
          url: "file:///C:/Program%20Files/Amphetamine/resources/app.asar/lib/renderer/index.html",
        },
      });

      expect(result).toEqual({ version: "2.0.0", releaseDate: "2026-01-01" });
      expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
    });

    it("rejects a forbidden sender without checking for updates", async () => {
      registerAutoUpdaterIpc();
      const handler = mockIpcMainHandle.mock.calls.find(
        (call) => call[0] === "auto-updater:check",
      )![1] as (event: unknown) => Promise<unknown>;

      const result = await handler({
        senderFrame: { parent: null, url: "https://evil.example/index.html" },
      });

      expect(result).toBeNull();
      expect(mockCheckForUpdates).not.toHaveBeenCalled();
    });
  });

  describe("checkForUpdatesNow", () => {
    it("calls checkForUpdates when packaged", () => {
      initAutoUpdater();
      mockCheckForUpdates.mockClear();
      checkForUpdatesNow();
      expect(mockCheckForUpdates).toHaveBeenCalled();
    });

    it("joins concurrent tray/IPC checks into one autoUpdater.checkForUpdates call", async () => {
      let resolveCheck: ((value: unknown) => void) | undefined;
      mockCheckForUpdates.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCheck = resolve;
          }),
      );
      initAutoUpdater();
      mockCheckForUpdates.mockClear();

      const hybrid = await import("../../src/infrastructure/updater/hybrid-auto-updater.js");
      const p1 = hybrid.checkForUpdatesForIpc();
      hybrid.checkForUpdatesNow();
      const p2 = hybrid.checkForUpdatesForIpc();

      expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
      resolveCheck?.({
        updateInfo: { version: "9.9.9", releaseDate: "2026-01-01" },
      });
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1?.version).toBe("9.9.9");
      expect(r2?.version).toBe("9.9.9");
    });

    it("clears in-flight state after rejection so a later check runs again", async () => {
      mockCheckForUpdates.mockRejectedValueOnce(new Error("network"));
      initAutoUpdater();
      mockCheckForUpdates.mockClear();

      const hybrid = await import("../../src/infrastructure/updater/hybrid-auto-updater.js");
      await hybrid.checkForUpdatesForIpc();
      expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);

      mockCheckForUpdates.mockResolvedValueOnce(null);
      await hybrid.checkForUpdatesForIpc();
      expect(mockCheckForUpdates).toHaveBeenCalledTimes(2);
    });

    it("shows updates-unavailable dialog when not packaged", async () => {
      const { app } = await import("electron");
      const originalDescriptor = Object.getOwnPropertyDescriptor(app, "isPackaged");
      try {
        Object.defineProperty(app, "isPackaged", {
          value: false,
          configurable: true,
          writable: true,
        });

        vi.resetModules();
        const freshMod = await import("../../src/infrastructure/updater/hybrid-auto-updater.js");
        const { broadcastToWindows: bcast2 } = await import("../../src/main/utils/broadcast.js");
        const { createBroadcastNotifier: makeN2 } =
          await import("../../src/infrastructure/notification/broadcast-notifier.js");
        const n2 = makeN2(bcast2);
        freshMod.configureHybridAutoUpdater({
          publish: (event) => {
            n2.publish(event);
          },
          getRepositoryUrl: () => "https://github.com/iworkforces/Amphetamine",
          showUserDialog: mockShowUserDialog,
        });
        mockShowUserDialog.mockClear();
        mockCheckForUpdates.mockClear();
        freshMod.checkForUpdatesNow();

        await vi.waitFor(() => {
          expect(mockShowUserDialog).toHaveBeenCalledWith(
            expect.objectContaining({
              message: "Updates Unavailable",
            }),
          );
        });
        expect(mockCheckForUpdates).not.toHaveBeenCalled();
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(app, "isPackaged", originalDescriptor);
        } else {
          Object.defineProperty(app, "isPackaged", {
            value: true,
            configurable: true,
            writable: true,
          });
        }
        vi.resetModules();
        await import("../../src/infrastructure/updater/hybrid-auto-updater.js");
      }
    });

    it("shows check-failed dialog when checkForUpdates rejects with no known version", async () => {
      mockCheckForUpdates.mockRejectedValueOnce(new Error("offline"));
      initAutoUpdater();
      checkForUpdatesNow();

      await vi.waitFor(() => {
        expect(mockShowUserDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Unable to Check for Updates",
          }),
        );
      });
    });
  });
});
