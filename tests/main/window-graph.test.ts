import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BrowserWindow } from "electron";
import {
  UTILITY_DIALOG_APPLY,
  UTILITY_DIALOG_GET_PAYLOAD,
  UTILITY_DIALOG_RESPOND,
  UTILITY_DIALOG_SET_HEIGHT,
  type UtilityDialogOptions,
} from "../../src/shared/utility-dialog.js";

const mockFocus = vi.fn();
const mockShow = vi.fn();
const mockClose = vi.fn();
const mockDestroy = vi.fn();
const mockHide = vi.fn();
const mockIsDestroyed = vi.fn().mockReturnValue(false);
const mockIsVisible = vi.fn().mockReturnValue(false);
const mockLoadURL = vi.fn();
const mockLoadFile = vi.fn();
const mockOnce = vi.fn<(event: string, callback: () => void) => void>();
const mockOn =
  vi.fn<(event: string, callback: (event: { preventDefault: () => void }) => void) => void>();
const mockSetWindowOpenHandler =
  vi.fn<(handler: (details: { url: string }) => { action: string }) => void>();
const mockHarden = vi.fn();
const mockIpcHandle =
  vi.fn<
    (
      channel: string,
      handler: (event: { sender: { id: number } }, value?: unknown) => unknown,
    ) => void
  >();
const mockIpcRemoveHandler = vi.fn();
let mockWebContentsId = 0;
const mockGetSize = vi.fn().mockReturnValue([420, 300]);
const mockSetPosition = vi.fn();

vi.mock("electron", () => ({
  app: { isPackaged: false, focus: vi.fn() },
  ipcMain: {
    handle: mockIpcHandle,
    removeHandler: mockIpcRemoveHandler,
  },
  BrowserWindow: vi.fn(function (this: Record<string, unknown>) {
    this.focus = mockFocus;
    this.show = mockShow;
    this.close = mockClose;
    this.destroy = mockDestroy;
    this.hide = mockHide;
    this.isDestroyed = mockIsDestroyed;
    this.isVisible = mockIsVisible;
    this.loadURL = mockLoadURL;
    this.loadFile = mockLoadFile;
    this.once = mockOnce;
    this.on = mockOn;
    this.getSize = mockGetSize;
    this.setPosition = mockSetPosition;
    this.setContentSize = vi.fn();
    this.webContents = {
      id: ++mockWebContentsId,
      setWindowOpenHandler: mockSetWindowOpenHandler,
      on: vi.fn(),
      send: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      executeJavaScript: vi.fn().mockResolvedValue(undefined),
    };
  }),
  nativeImage: {
    createFromPath: vi.fn().mockReturnValue({
      toPNG: vi.fn().mockReturnValue(Buffer.from("png")),
    }),
  },
  screen: {
    getDisplayNearestPoint: vi.fn().mockReturnValue({
      workArea: { x: 0, y: 0, width: 1000, height: 800 },
    }),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("../../src/infrastructure/benchmark/benchmark-env.js", () => ({
  isBenchmarkMode: () => false,
}));

vi.mock("../../src/main/security.js", () => ({
  hardenWebContents: mockHarden,
}));

vi.mock("../../src/main/utils/packageInfo.js", () => ({
  getPackageInfo: () => ({
    productName: "Amphetamine",
    version: "1.0.0",
    description: "Keep awake",
    repository: "https://github.com/example/amphetamine",
    author: "Test",
  }),
}));

const mockAcquireUtility = vi.hoisted(() => vi.fn());
const mockReleaseUtility = vi.hoisted(() => vi.fn());

vi.mock("../../src/main/platform/index.js", () => ({
  popoverWindowChrome: () => ({ skipTaskbar: true }),
  settingsWindowChrome: () => ({ skipTaskbar: false }),
  aboutWindowChrome: () => ({ skipTaskbar: true }),
  utilityDialogWindowChrome: () => ({ skipTaskbar: false, titleBarStyle: "hidden" }),
  appIconFileName: () => "icon.icns",
  isDarwin: () => false,
  enterForegroundMode: vi.fn(),
  enterTrayOnlyMode: vi.fn(),
  setDockIcon: vi.fn(),
  acquireUtilityForeground: (...args: unknown[]) => mockAcquireUtility(...args),
  releaseUtilityForeground: (...args: unknown[]) => mockReleaseUtility(...args),
  setUtilityDockIcon: vi.fn(),
}));

vi.mock("../../src/main/utils/broadcast.js", () => ({
  broadcastToWindows: vi.fn(),
}));

const dialogOptions: UtilityDialogOptions = {
  title: "Update available",
  message: "Install the update?",
  detail: "A new version is ready.",
  buttons: ["Later", "Restart"],
  defaultId: 1,
  cancelId: 0,
};

function createdWindow(windowConstructor: typeof BrowserWindow, index = 0) {
  const result = vi.mocked(windowConstructor).mock.results[index];
  if (result?.type !== "return") {
    throw new Error("Expected a constructed BrowserWindow");
  }
  return result.value;
}

function invokeUtilityDialog(channel: string, senderId: number, value?: unknown): unknown {
  const handler = mockIpcHandle.mock.calls.findLast(([registered]) => registered === channel)?.[1];
  expect(handler).toBeTypeOf("function");
  return handler?.({ sender: { id: senderId } }, value);
}

function readyUtilityDialog(index = 0): void {
  const handler = mockOnce.mock.calls.filter(([event]) => event === "ready-to-show")[index]?.[1];
  expect(handler).toBeTypeOf("function");
  handler?.();
}

function closeUtilityDialog(index = 0): ReturnType<typeof vi.fn> {
  const handler = mockOn.mock.calls.filter(([event]) => event === "close")[index]?.[1];
  expect(handler).toBeTypeOf("function");
  const preventDefault = vi.fn();
  handler?.({ preventDefault });
  return preventDefault;
}

function closedUtilityDialog(index = 0): void {
  const handler = mockOn.mock.calls.filter(([event]) => event === "closed")[index]?.[1];
  expect(handler).toBeTypeOf("function");
  handler?.({ preventDefault: vi.fn() });
}

describe("window-graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockWebContentsId = 0;
    mockIsDestroyed.mockReturnValue(false);
    mockIsVisible.mockReturnValue(false);
    mockShow.mockReset();
    mockHide.mockReset();
    mockDestroy.mockReset();
    mockGetSize.mockReturnValue([420, 300]);
    mockShow.mockImplementation(() => mockIsVisible.mockReturnValue(true));
    mockHide.mockImplementation(() => mockIsVisible.mockReturnValue(false));
    // Default: do not auto-fire ready-to-show (tests opt in via mockImplementation).
    mockOnce.mockReset();
    mockOn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createPopoverWindow applies shared secure webPreferences with preload", async () => {
    const { createPopoverWindow } = await import("../../src/main/process/window-graph.js");
    const { BrowserWindow } = await import("electron");
    createPopoverWindow({ isQuitting: () => false });
    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(BrowserWindow).mock.calls[0]![0] as {
      webPreferences: Record<string, unknown>;
    };
    expect(opts.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(String(opts.webPreferences.preload)).toContain("preload");
    expect(mockHarden).toHaveBeenCalled();
  });

  it("createSettingsWindow uses the same secure triad with preload", async () => {
    const { createSettingsWindow } = await import("../../src/main/process/window-graph.js");
    const { BrowserWindow } = await import("electron");
    createSettingsWindow();
    const opts = vi.mocked(BrowserWindow).mock.calls[0]![0] as {
      webPreferences: Record<string, unknown>;
    };
    expect(opts.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(String(opts.webPreferences.preload)).toContain("preload");
  });

  it("showAbout uses secure triad with shared preload", async () => {
    const { showAbout } = await import("../../src/main/process/window-graph.js");
    const { BrowserWindow } = await import("electron");
    showAbout();
    const opts = vi.mocked(BrowserWindow).mock.calls[0]![0] as {
      webPreferences: Record<string, unknown>;
    };
    expect(opts.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(String(opts.webPreferences.preload)).toContain("preload");
  });

  it("opens only package-repository links from About in the external browser", async () => {
    const { showAbout } = await import("../../src/main/process/window-graph.js");
    const { shell } = await import("electron");
    showAbout();
    const openWindow = mockSetWindowOpenHandler.mock.calls[0]?.[0];
    expect(openWindow).toBeTypeOf("function");

    for (const url of [
      "https://github.com/example/amphetamine",
      "https://github.com/example/amphetamine/releases",
    ]) {
      expect(openWindow?.({ url })).toEqual({ action: "deny" });
      expect(shell.openExternal).toHaveBeenLastCalledWith(url);
    }
    expect(shell.openExternal).toHaveBeenCalledTimes(2);

    for (const url of [
      "http://github.com/example/amphetamine",
      "https://github.com/example/amphetamine-evil",
      "https://not-github.com/example/amphetamine",
      "javascript:alert(1)",
      "not a URL",
    ]) {
      expect(openWindow?.({ url })).toEqual({ action: "deny" });
    }
    expect(shell.openExternal).toHaveBeenCalledTimes(2);
  });

  it("destroyAllWindows destroys utility windows and popover", async () => {
    const {
      createPopoverWindow,
      createSettingsWindow,
      showAbout,
      destroyAllWindows,
    } = await import("../../src/main/process/window-graph.js");
    createPopoverWindow({ isQuitting: () => false });
    createSettingsWindow();
    showAbout();
    destroyAllWindows();
    // Utility windows force-destroy (warm cache must not survive quit).
    expect(mockDestroy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("hides settings on user close and reuses the cached window", async () => {
    vi.useFakeTimers();
    mockOnce.mockImplementation((event: string, cb: () => void) => {
      if (event === "ready-to-show") cb();
    });
    mockShow.mockImplementation(() => {
      mockIsVisible.mockReturnValue(true);
    });
    mockHide.mockImplementation(() => {
      mockIsVisible.mockReturnValue(false);
    });

    const { createSettingsWindow } = await import("../../src/main/process/window-graph.js");
    const { BrowserWindow } = await import("electron");
    createSettingsWindow();
    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(mockAcquireUtility).toHaveBeenCalledTimes(1);

    const closeHandler = mockOn.mock.calls.find((c) => c[0] === "close")?.[1] as
      | ((e: { preventDefault: () => void }) => void)
      | undefined;
    expect(closeHandler).toBeTypeOf("function");
    const preventDefault = vi.fn();
    closeHandler?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(mockHide).toHaveBeenCalled();
    expect(mockReleaseUtility).toHaveBeenCalledTimes(1);

    // Second open reuses the same BrowserWindow (no recreate / reload).
    createSettingsWindow();
    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(mockShow).toHaveBeenCalled();
    expect(mockFocus).toHaveBeenCalled();
    expect(mockAcquireUtility).toHaveBeenCalledTimes(2);

    // Warm-cache show clears form focus so no control (e.g. Launch at Login) is focused.
    await vi.advanceTimersByTimeAsync(0);
    const instance = vi.mocked(BrowserWindow).mock.results[0]?.value as {
      webContents: { executeJavaScript: ReturnType<typeof vi.fn> };
    };
    expect(instance.webContents.executeJavaScript).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not re-show after dismiss before first ready-to-show", async () => {
    // Capture ready-to-show without firing it immediately.
    let readyToShow: (() => void) | undefined;
    mockOnce.mockImplementation((event: string, cb: () => void) => {
      if (event === "ready-to-show") {
        readyToShow = cb;
      }
    });
    mockShow.mockImplementation(() => {
      mockIsVisible.mockReturnValue(true);
    });
    mockHide.mockImplementation(() => {
      mockIsVisible.mockReturnValue(false);
    });

    const { createSettingsWindow } = await import("../../src/main/process/window-graph.js");
    const { BrowserWindow } = await import("electron");

    createSettingsWindow();
    // Second open before paint: early present (show + acquire).
    createSettingsWindow();
    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(mockShow).toHaveBeenCalled();
    expect(mockAcquireUtility).toHaveBeenCalledTimes(1);

    const closeHandler = mockOn.mock.calls.find((c) => c[0] === "close")?.[1] as
      | ((e: { preventDefault: () => void }) => void)
      | undefined;
    closeHandler?.({ preventDefault: vi.fn() });
    expect(mockHide).toHaveBeenCalled();
    expect(mockReleaseUtility).toHaveBeenCalledTimes(1);

    mockShow.mockClear();
    mockAcquireUtility.mockClear();
    mockFocus.mockClear();

    // Late ready-to-show must not resurrect the dismissed window.
    readyToShow?.();
    expect(mockShow).not.toHaveBeenCalled();
    expect(mockAcquireUtility).not.toHaveBeenCalled();
    expect(mockFocus).not.toHaveBeenCalled();
  });

  it("About hide-on-close reuses cache and ignores late ready-to-show after dismiss", async () => {
    let readyToShow: (() => void) | undefined;
    mockOnce.mockImplementation((event: string, cb: () => void) => {
      if (event === "ready-to-show") {
        readyToShow = cb;
      }
    });
    mockShow.mockImplementation(() => {
      mockIsVisible.mockReturnValue(true);
    });
    mockHide.mockImplementation(() => {
      mockIsVisible.mockReturnValue(false);
    });

    const { showAbout } = await import("../../src/main/process/window-graph.js");
    const { BrowserWindow } = await import("electron");

    showAbout();
    showAbout(); // early present before ready
    expect(BrowserWindow).toHaveBeenCalledTimes(1);

    const closeHandler = mockOn.mock.calls.find((c) => c[0] === "close")?.[1] as
      | ((e: { preventDefault: () => void }) => void)
      | undefined;
    closeHandler?.({ preventDefault: vi.fn() });
    expect(mockHide).toHaveBeenCalled();

    mockShow.mockClear();
    mockAcquireUtility.mockClear();
    readyToShow?.();
    expect(mockShow).not.toHaveBeenCalled();
    expect(mockAcquireUtility).not.toHaveBeenCalled();

    // Explicit reopen after dismiss still works (warm cache).
    showAbout();
    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(mockShow).toHaveBeenCalled();
    expect(mockAcquireUtility).toHaveBeenCalledTimes(1);
  });

  it("isSettingsWindowOpen is true only when visible", async () => {
    mockOnce.mockImplementation((event: string, cb: () => void) => {
      if (event === "ready-to-show") cb();
    });
    mockShow.mockImplementation(() => {
      mockIsVisible.mockReturnValue(true);
    });
    mockHide.mockImplementation(() => {
      mockIsVisible.mockReturnValue(false);
    });

    const { createSettingsWindow, isSettingsWindowOpen } = await import(
      "../../src/main/process/window-graph.js"
    );
    createSettingsWindow();
    expect(isSettingsWindowOpen()).toBe(true);

    const closeHandler = mockOn.mock.calls.find((c) => c[0] === "close")?.[1] as
      | ((e: { preventDefault: () => void }) => void)
      | undefined;
    closeHandler?.({ preventDefault: vi.fn() });
    expect(isSettingsWindowOpen()).toBe(false);
  });

  it("loads local renderer pages and hides the tray popover on blur in packaged mode", async () => {
    vi.useFakeTimers();
    const { app, nativeImage } = await import("electron");
    const resourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(app, "isPackaged", { configurable: true, value: true });
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/tmp/amphetamine-window-graph-test",
    });

    try {
      const {
        createPopoverWindow,
        createSettingsWindow,
        showAbout,
        presentUtilityDialog,
        hasPendingPopoverHide,
      } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const { broadcastToWindows } = await import("../../src/main/utils/broadcast.js");
      let quitting = false;
      createPopoverWindow({ isQuitting: () => quitting });
      createSettingsWindow();
      showAbout();
      const dialog = presentUtilityDialog(dialogOptions);
      const dialogWindow = createdWindow(BrowserWindow, 3);

      expect(mockLoadURL).not.toHaveBeenCalled();
      expect(mockLoadFile.mock.calls.map(([file]) => file)).toEqual([
        expect.stringMatching(/\/renderer\/index\.html$/),
        expect.stringMatching(/\/renderer\/settings\.html$/),
        expect.stringMatching(/\/renderer\/about\.html$/),
        expect.stringMatching(/\/renderer\/utility-dialog\.html$/),
      ]);
      expect(nativeImage.createFromPath).toHaveBeenCalledWith(
        "/tmp/amphetamine-window-graph-test/icon.icns",
      );

      const blur = mockOn.mock.calls.find(([event]) => event === "blur")?.[1];
      quitting = true;
      blur?.({ preventDefault: vi.fn() });
      expect(hasPendingPopoverHide()).toBe(false);
      quitting = false;
      mockIsDestroyed.mockReturnValue(true);
      blur?.({ preventDefault: vi.fn() });
      expect(hasPendingPopoverHide()).toBe(false);
      mockIsDestroyed.mockReturnValue(false);
      blur?.({ preventDefault: vi.fn() });
      expect(hasPendingPopoverHide()).toBe(true);
      expect(broadcastToWindows).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(160);
      expect(mockHide).toHaveBeenCalledTimes(1);

      readyUtilityDialog(2);
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, dialogWindow.webContents.id, 1);
      await expect(dialog).resolves.toEqual({ response: 1, checkboxChecked: false });
    } finally {
      Object.defineProperty(app, "isPackaged", { configurable: true, value: false });
      if (resourcesPath) {
        Object.defineProperty(process, "resourcesPath", resourcesPath);
      } else {
        Reflect.deleteProperty(process, "resourcesPath");
      }
    }
  });

  describe("popover hide coalescing", () => {
    it("positions the popover inside the work area, then toggles it closed", async () => {
      const { createPopoverWindow, showPopoverNearTray } =
        await import("../../src/main/process/window-graph.js");
      const { BrowserWindow, screen } = await import("electron");
      const bounds = { x: 880, y: 10, width: 40, height: 20 };

      showPopoverNearTray(bounds);
      expect(mockShow).not.toHaveBeenCalled();
      createPopoverWindow({ isQuitting: () => false });
      const window = createdWindow(BrowserWindow);
      expect(window.getSize).toHaveBeenCalledTimes(0);
      showPopoverNearTray(bounds);
      expect(screen.getDisplayNearestPoint).toHaveBeenCalledWith({ x: 880, y: 10 });
      expect(mockSetPosition).toHaveBeenCalledWith(580, 34, false);
      expect(mockShow).toHaveBeenCalledTimes(1);
      expect(mockFocus).toHaveBeenCalledTimes(1);

      showPopoverNearTray(bounds);
      expect(mockHide).toHaveBeenCalledTimes(1);
      expect(mockShow).toHaveBeenCalledTimes(1);

      showPopoverNearTray({ x: 0, y: 760, width: 40, height: 20 });
      expect(mockSetPosition).toHaveBeenLastCalledWith(0, 456, false);
      expect(mockShow).toHaveBeenCalledTimes(2);
    });

    it("cancels a pending popover hide on user close and clears its registry on closed", async () => {
      vi.useFakeTimers();
      let quitting = false;
      const { createPopoverWindow, getPopoverWindow, hasPendingPopoverHide } =
        await import("../../src/main/process/window-graph.js");
      const { broadcastToWindows } = await import("../../src/main/utils/broadcast.js");
      const window = createPopoverWindow({ isQuitting: () => quitting });
      expect(getPopoverWindow()).toBe(window);

      const minimize = mockOn.mock.calls.find(([event]) => event === "minimize")?.[1];
      const close = mockOn.mock.calls.find(([event]) => event === "close")?.[1];
      const closed = mockOn.mock.calls.find(([event]) => event === "closed")?.[1];
      const event = { preventDefault: vi.fn() };
      minimize?.(event);
      expect(hasPendingPopoverHide()).toBe(true);
      expect(broadcastToWindows).toHaveBeenCalledTimes(1);

      close?.(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(hasPendingPopoverHide()).toBe(false);
      expect(mockHide).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(mockHide).toHaveBeenCalledTimes(1);

      quitting = true;
      close?.(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      closed?.(event);
      expect(getPopoverWindow()).toBeNull();
      expect(createPopoverWindow({ isQuitting: () => false })).not.toBe(window);
    });

    it("blur/minimize bursts create at most one pending hide and one broadcast", async () => {
      vi.useFakeTimers();
      const { createPopoverWindow, hasPendingPopoverHide } = await import(
        "../../src/main/process/window-graph.js"
      );
      const { broadcastToWindows } = await import("../../src/main/utils/broadcast.js");
      createPopoverWindow({ isQuitting: () => false });

      const blurHandler = mockOn.mock.calls.find((c) => c[0] === "blur")?.[1] as
        | (() => void)
        | undefined;
      const minimizeHandler = mockOn.mock.calls.find((c) => c[0] === "minimize")?.[1] as
        | (() => void)
        | undefined;
      expect(blurHandler).toBeTypeOf("function");
      expect(minimizeHandler).toBeTypeOf("function");

      // Force non-dev packaged-like hide path: isDev is false when packaged or benchmark.
      // blur handler checks !isDev — constants isDev is based on app.isPackaged.
      // In this mock app.isPackaged is false so isDev may be true and blur no-ops.
      // minimize always schedules.
      minimizeHandler?.();
      minimizeHandler?.();
      minimizeHandler?.();

      expect(hasPendingPopoverHide()).toBe(true);
      expect(vi.mocked(broadcastToWindows)).toHaveBeenCalledTimes(1);
      expect(mockHide).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(mockHide).toHaveBeenCalledTimes(1);
      expect(hasPendingPopoverHide()).toBe(false);
      vi.useRealTimers();
    });

    it("showing before hide expiry cancels stale hide", async () => {
      vi.useFakeTimers();
      const { createPopoverWindow, hasPendingPopoverHide } = await import(
        "../../src/main/process/window-graph.js"
      );
      createPopoverWindow({ isQuitting: () => false });

      const minimizeHandler = mockOn.mock.calls.find((c) => c[0] === "minimize")?.[1] as
        | (() => void)
        | undefined;
      const showHandler = mockOn.mock.calls.find((c) => c[0] === "show")?.[1] as
        | (() => void)
        | undefined;
      expect(showHandler).toBeTypeOf("function");

      minimizeHandler?.();
      expect(hasPendingPopoverHide()).toBe(true);
      showHandler?.();
      expect(hasPendingPopoverHide()).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      expect(mockHide).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("destroyAllWindows clears pending hide timer", async () => {
      vi.useFakeTimers();
      const { createPopoverWindow, destroyAllWindows, hasPendingPopoverHide } = await import(
        "../../src/main/process/window-graph.js"
      );
      createPopoverWindow({ isQuitting: () => false });
      const minimizeHandler = mockOn.mock.calls.find((c) => c[0] === "minimize")?.[1] as
        | (() => void)
        | undefined;
      minimizeHandler?.();
      expect(hasPendingPopoverHide()).toBe(true);
      destroyAllWindows();
      expect(hasPendingPopoverHide()).toBe(false);
      vi.useRealTimers();
    });

    it("does not hide a destroyed popover when its delayed minimize expires", async () => {
      vi.useFakeTimers();
      const { createPopoverWindow, getPopoverWindow, hasPendingPopoverHide } = await import(
        "../../src/main/process/window-graph.js"
      );
      createPopoverWindow({ isQuitting: () => false });
      const minimize = mockOn.mock.calls.find(([event]) => event === "minimize")?.[1];
      minimize?.({ preventDefault: vi.fn() });
      expect(hasPendingPopoverHide()).toBe(true);

      mockIsDestroyed.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(160);
      expect(mockHide).not.toHaveBeenCalled();
      expect(hasPendingPopoverHide()).toBe(false);
      expect(getPopoverWindow()).toBeNull();
    });

    it("reuses a live popover and ignores late events from its replaced predecessor", async () => {
      const { createPopoverWindow, getPopoverWindow, hasPendingPopoverHide } = await import(
        "../../src/main/process/window-graph.js"
      );
      const { BrowserWindow } = await import("electron");
      const first = createPopoverWindow({ isQuitting: () => false });
      expect(createPopoverWindow({ isQuitting: () => false })).toBe(first);
      expect(BrowserWindow).toHaveBeenCalledTimes(1);

      mockIsDestroyed.mockReturnValue(true);
      const replacement = createPopoverWindow({ isQuitting: () => false });
      mockIsDestroyed.mockReturnValue(false);
      expect(replacement).not.toBe(first);
      const oldClosed = mockOn.mock.calls.filter(([event]) => event === "closed")[0]?.[1];
      oldClosed?.({ preventDefault: vi.fn() });
      expect(getPopoverWindow()).toBe(replacement);

      const minimize = mockOn.mock.calls.filter(([event]) => event === "minimize")[1]?.[1];
      mockIsDestroyed.mockReturnValue(true);
      minimize?.({ preventDefault: vi.fn() });
      expect(hasPendingPopoverHide()).toBe(false);
      mockIsDestroyed.mockReturnValue(false);
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
    });
  });

  describe("utility foreground pairing", () => {
    it("does not release foreground if closed before ready-to-show", async () => {
      const { createSettingsWindow } = await import("../../src/main/process/window-graph.js");
      createSettingsWindow();

      const closedHandler = mockOn.mock.calls.find((c) => c[0] === "closed")?.[1] as
        | (() => void)
        | undefined;
      expect(closedHandler).toBeTypeOf("function");
      // Never fire ready-to-show → heldForeground stays false
      closedHandler?.();

      expect(mockAcquireUtility).not.toHaveBeenCalled();
      expect(mockReleaseUtility).not.toHaveBeenCalled();
    });

    it("acquires on ready-to-show and releases once on hide (user close)", async () => {
      mockOnce.mockImplementation((event: string, cb: () => void) => {
        if (event === "ready-to-show") cb();
      });
      mockIsVisible.mockReturnValue(true);
      const { createSettingsWindow } = await import("../../src/main/process/window-graph.js");
      createSettingsWindow();

      expect(mockAcquireUtility).toHaveBeenCalledTimes(1);

      const closeHandler = mockOn.mock.calls.find((c) => c[0] === "close")?.[1] as
        | ((e: { preventDefault: () => void }) => void)
        | undefined;
      closeHandler?.({ preventDefault: vi.fn() });
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
      expect(mockHide).toHaveBeenCalled();
    });

    it("leaves an unpainted settings window hidden when the user closes it", async () => {
      const { createSettingsWindow, isSettingsWindowOpen } = await import(
        "../../src/main/process/window-graph.js"
      );
      createSettingsWindow();

      expect(closeUtilityDialog()).toHaveBeenCalledTimes(1);
      expect(mockHide).not.toHaveBeenCalled();
      expect(mockReleaseUtility).not.toHaveBeenCalled();
      readyUtilityDialog();
      expect(mockShow).not.toHaveBeenCalled();
      expect(mockAcquireUtility).not.toHaveBeenCalled();
      expect(isSettingsWindowOpen()).toBe(false);
    });

    it("keeps settings usable when clearing renderer focus rejects after presentation", async () => {
      vi.useFakeTimers();
      const { createSettingsWindow } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      createSettingsWindow();
      const window = createdWindow(BrowserWindow);
      vi.mocked(window.webContents.executeJavaScript).mockRejectedValueOnce(new Error("Navigated"));

      readyUtilityDialog();
      await vi.advanceTimersByTimeAsync(0);
      expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
      expect(mockShow).toHaveBeenCalledTimes(1);
      createSettingsWindow();
      await vi.advanceTimersByTimeAsync(0);
      expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(2);
      expect(mockFocus).toHaveBeenCalledTimes(2);
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
    });

    it("releases About foreground on external close and creates a new shell on reopen", async () => {
      const { showAbout } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      showAbout();
      readyUtilityDialog();
      expect(mockAcquireUtility).toHaveBeenCalledTimes(1);

      closedUtilityDialog();
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
      mockIsVisible.mockReturnValue(false);
      showAbout();
      readyUtilityDialog(1);
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
      expect(mockLoadURL).toHaveBeenCalledTimes(2);
      expect(mockShow).toHaveBeenCalledTimes(2);
      expect(mockAcquireUtility).toHaveBeenCalledTimes(2);
      closedUtilityDialog(1);
      expect(mockReleaseUtility).toHaveBeenCalledTimes(2);
    });

    it("does not turn reentrant close events into hide during app teardown", async () => {
      const { createSettingsWindow, showAbout, presentUtilityDialog, destroyAllWindows } =
        await import("../../src/main/process/window-graph.js");
      createSettingsWindow();
      showAbout();
      const dialog = presentUtilityDialog({ ...dialogOptions, cancelId: 1 });
      const dialogClose = vi.fn();
      const settingsClose = vi.fn();
      const aboutClose = vi.fn();
      mockDestroy
        .mockImplementationOnce(() => {
          const close = mockOn.mock.calls.filter(([event]) => event === "close")[2]?.[1];
          close?.({ preventDefault: dialogClose });
        })
        .mockImplementationOnce(() => {
          const close = mockOn.mock.calls.filter(([event]) => event === "close")[0]?.[1];
          close?.({ preventDefault: settingsClose });
        })
        .mockImplementationOnce(() => {
          const close = mockOn.mock.calls.filter(([event]) => event === "close")[1]?.[1];
          close?.({ preventDefault: aboutClose });
        });

      destroyAllWindows();
      await expect(dialog).resolves.toEqual({ response: 1, checkboxChecked: false });
      expect(mockDestroy).toHaveBeenCalledTimes(3);
      expect(dialogClose).not.toHaveBeenCalled();
      expect(settingsClose).not.toHaveBeenCalled();
      expect(aboutClose).not.toHaveBeenCalled();
      expect(mockHide).not.toHaveBeenCalled();
      expect(mockIpcRemoveHandler).toHaveBeenCalledTimes(3);
    });
  });

  describe("utility dialog", () => {
    it("applies a payload without flashing show when the shell is already visible", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const result = presentUtilityDialog(dialogOptions);
      const window = createdWindow(BrowserWindow);
      mockIsVisible.mockReturnValue(true);

      readyUtilityDialog();
      expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(UTILITY_DIALOG_APPLY, {
        ...dialogOptions,
      });
      expect(mockShow).not.toHaveBeenCalled();
      expect(mockFocus).toHaveBeenCalledTimes(1);
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 1);
      await expect(result).resolves.toEqual({ response: 1, checkboxChecked: false });
      expect(mockHide).toHaveBeenCalledTimes(1);
    });

    it("dismisses a visible idle shell without resolving a second dialog", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const first = presentUtilityDialog(dialogOptions);
      const window = createdWindow(BrowserWindow);
      readyUtilityDialog();
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 1);
      await expect(first).resolves.toEqual({ response: 1, checkboxChecked: false });

      window.show();
      expect(closeUtilityDialog()).toHaveBeenCalledTimes(1);
      expect(mockHide).toHaveBeenCalledTimes(2);
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
      expect(() => invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, window.webContents.id)).toThrow(
        "No active dialog payload",
      );

      const nextOptions = { ...dialogOptions, title: "Second request" };
      const next = presentUtilityDialog(nextOptions);
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      expect(window.webContents.send).toHaveBeenLastCalledWith(UTILITY_DIALOG_APPLY, nextOptions);
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 0);
      await expect(next).resolves.toEqual({ response: 0, checkboxChecked: false });
    });

    it("keeps private handlers bound to the new shell when a cached one was destroyed", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const first = presentUtilityDialog(dialogOptions);
      const oldWindow = createdWindow(BrowserWindow);
      readyUtilityDialog();
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, oldWindow.webContents.id, 1);
      await expect(first).resolves.toEqual({ response: 1, checkboxChecked: false });

      mockIsDestroyed.mockReturnValue(true);
      const nextOptions = { ...dialogOptions, message: "New renderer" };
      const next = presentUtilityDialog(nextOptions);
      mockIsDestroyed.mockReturnValue(false);
      const newWindow = createdWindow(BrowserWindow, 1);
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
      expect(mockIpcHandle).toHaveBeenCalledTimes(3);
      expect(() => invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, oldWindow.webContents.id)).toThrow(
        "No active dialog payload",
      );
      expect(invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, newWindow.webContents.id)).toEqual(
        nextOptions,
      );
      readyUtilityDialog(1);
      expect(newWindow.webContents.send).toHaveBeenCalledExactlyOnceWith(
        UTILITY_DIALOG_APPLY,
        nextOptions,
      );
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, newWindow.webContents.id, 0);
      await expect(next).resolves.toEqual({ response: 0, checkboxChecked: false });
    });

    it("removes private handlers when an already dismissed shell closes externally", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const first = presentUtilityDialog(dialogOptions);
      const window = createdWindow(BrowserWindow);
      readyUtilityDialog();
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 1);
      await expect(first).resolves.toEqual({ response: 1, checkboxChecked: false });

      closedUtilityDialog();
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
      expect(mockIpcRemoveHandler.mock.calls.map(([channel]) => channel)).toEqual([
        UTILITY_DIALOG_GET_PAYLOAD,
        UTILITY_DIALOG_RESPOND,
        UTILITY_DIALOG_SET_HEIGHT,
      ]);
      const next = presentUtilityDialog({ ...dialogOptions, title: "After external close" });
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
      expect(mockIpcHandle).toHaveBeenCalledTimes(6);
      readyUtilityDialog(1);
      const newWindow = createdWindow(BrowserWindow, 1);
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, newWindow.webContents.id, 1);
      await expect(next).resolves.toEqual({ response: 1, checkboxChecked: false });
    });

    it("loads a secure, hidden shell and presents its payload only when ready", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow, app } = await import("electron");

      const result = presentUtilityDialog(dialogOptions);
      const window = createdWindow(BrowserWindow);
      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 360,
          height: 280,
          show: false,
          resizable: false,
          webPreferences: expect.objectContaining({
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            preload: expect.stringContaining("utility-dialog.cjs"),
          }),
        }),
      );
      expect(mockHarden).toHaveBeenCalledWith(window);
      expect(mockLoadURL).toHaveBeenCalledWith(expect.stringMatching(/\/utility-dialog\.html$/));
      expect(mockIpcHandle.mock.calls.map(([channel]) => channel)).toEqual([
        UTILITY_DIALOG_GET_PAYLOAD,
        UTILITY_DIALOG_RESPOND,
        UTILITY_DIALOG_SET_HEIGHT,
      ]);
      expect(mockAcquireUtility).toHaveBeenCalledTimes(1);
      expect(mockShow).not.toHaveBeenCalled();
      expect(window.webContents.send).not.toHaveBeenCalled();
      expect(invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, window.webContents.id)).toEqual({
        ...dialogOptions,
      });

      readyUtilityDialog();
      expect(window.setContentSize).toHaveBeenCalledWith(360, 280, false);
      expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(UTILITY_DIALOG_APPLY, {
        ...dialogOptions,
      });
      expect(mockShow).toHaveBeenCalledTimes(1);
      expect(mockFocus).toHaveBeenCalledTimes(1);
      expect(app.focus).toHaveBeenCalledWith({ steal: true });
      expect(mockAcquireUtility).toHaveBeenCalledTimes(1);

      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 1);
      await expect(result).resolves.toEqual({ response: 1, checkboxChecked: false });
      expect(mockHide).toHaveBeenCalledTimes(1);
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
      expect(mockDestroy).not.toHaveBeenCalled();
      expect(() => invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, window.webContents.id)).toThrow(
        "No active dialog payload",
      );
    });

    it("joins concurrent requests, then re-applies only the new payload to the warm shell", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const first = presentUtilityDialog(dialogOptions);
      const joined = presentUtilityDialog({ ...dialogOptions, title: "Ignored second request" });
      const window = createdWindow(BrowserWindow);

      expect(joined).toBe(first);
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      expect(mockAcquireUtility).toHaveBeenCalledTimes(1);
      readyUtilityDialog();
      expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(UTILITY_DIALOG_APPLY, {
        ...dialogOptions,
      });
      invokeUtilityDialog(UTILITY_DIALOG_SET_HEIGHT, window.webContents.id, 400);
      expect(window.setContentSize).toHaveBeenLastCalledWith(360, 400, false);

      const preventDefault = closeUtilityDialog();
      expect(preventDefault).toHaveBeenCalledTimes(1);
      await expect(first).resolves.toEqual({ response: 0, checkboxChecked: false });
      await expect(joined).resolves.toEqual({ response: 0, checkboxChecked: false });
      expect(mockHide).toHaveBeenCalledTimes(1);
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);

      const nextOptions = {
        ...dialogOptions,
        title: "Download complete",
        buttons: ["Later", "Install"],
      };
      const next = presentUtilityDialog(nextOptions);
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      expect(mockLoadURL).toHaveBeenCalledTimes(1);
      expect(mockIpcHandle).toHaveBeenCalledTimes(3);
      expect(mockAcquireUtility).toHaveBeenCalledTimes(2);
      expect(window.setContentSize).toHaveBeenLastCalledWith(360, 280, false);
      expect(window.webContents.send).toHaveBeenCalledTimes(2);
      expect(window.webContents.send).toHaveBeenLastCalledWith(UTILITY_DIALOG_APPLY, nextOptions);
      expect(invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, window.webContents.id)).toEqual(
        nextOptions,
      );
      expect(mockShow).toHaveBeenCalledTimes(2);
      expect(mockFocus).toHaveBeenCalledTimes(2);

      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 1);
      await expect(next).resolves.toEqual({ response: 1, checkboxChecked: false });
      expect(mockReleaseUtility).toHaveBeenCalledTimes(2);
      expect(mockDestroy).not.toHaveBeenCalled();
      expect(window.webContents.send).toHaveBeenCalledTimes(2);
    });

    it("does not show a dismissed loading shell on late ready, but can present it later", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const first = presentUtilityDialog(dialogOptions);
      const window = createdWindow(BrowserWindow);

      expect(closeUtilityDialog()).toHaveBeenCalledTimes(1);
      await expect(first).resolves.toEqual({ response: 0, checkboxChecked: false });
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
      readyUtilityDialog();
      expect(mockShow).not.toHaveBeenCalled();
      expect(window.webContents.send).not.toHaveBeenCalled();
      expect(mockAcquireUtility).toHaveBeenCalledTimes(1);

      const next = presentUtilityDialog({ ...dialogOptions, message: "Try again" });
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      expect(mockLoadURL).toHaveBeenCalledTimes(1);
      expect(mockShow).toHaveBeenCalledTimes(1);
      expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(UTILITY_DIALOG_APPLY, {
        ...dialogOptions,
        message: "Try again",
      });
      expect(mockAcquireUtility).toHaveBeenCalledTimes(2);
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 1);
      await expect(next).resolves.toEqual({ response: 1, checkboxChecked: false });
    });

    it("reuses the still-loading shell without showing before ready", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const first = presentUtilityDialog(dialogOptions);
      const window = createdWindow(BrowserWindow);
      closeUtilityDialog();
      await expect(first).resolves.toEqual({ response: 0, checkboxChecked: false });

      const second = presentUtilityDialog({ ...dialogOptions, title: "Reopened before paint" });
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      expect(mockAcquireUtility).toHaveBeenCalledTimes(2);
      expect(mockShow).not.toHaveBeenCalled();
      readyUtilityDialog();
      expect(mockShow).toHaveBeenCalledTimes(1);
      expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(UTILITY_DIALOG_APPLY, {
        ...dialogOptions,
        title: "Reopened before paint",
      });
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 1);
      await expect(second).resolves.toEqual({ response: 1, checkboxChecked: false });
    });

    it("rejects foreign IPC senders and clamps valid height requests", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const result = presentUtilityDialog(dialogOptions);
      const window = createdWindow(BrowserWindow);
      readyUtilityDialog();
      const foreignSender = window.webContents.id + 1;

      expect(() => invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, foreignSender)).toThrow(
        "No active dialog payload",
      );
      expect(() => invokeUtilityDialog(UTILITY_DIALOG_SET_HEIGHT, foreignSender, 450)).toThrow(
        "Invalid sender",
      );
      expect(() => invokeUtilityDialog(UTILITY_DIALOG_RESPOND, foreignSender, 1)).toThrow(
        "Invalid sender",
      );
      expect(window.setContentSize).toHaveBeenCalledTimes(1);
      expect(mockHide).not.toHaveBeenCalled();

      mockIsDestroyed.mockReturnValue(true);
      expect(() => invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, window.webContents.id)).toThrow(
        "No active dialog payload",
      );
      expect(() =>
        invokeUtilityDialog(UTILITY_DIALOG_SET_HEIGHT, window.webContents.id, 450),
      ).toThrow("Invalid sender");
      expect(() => invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 1)).toThrow(
        "Invalid sender",
      );
      mockIsDestroyed.mockReturnValue(false);

      for (const [height, expected] of [
        [180, 200],
        [320.1, 321],
        [800, 520],
        [Number.POSITIVE_INFINITY, 280],
        [Number.NaN, 280],
        ["450", 280],
      ] as const) {
        invokeUtilityDialog(UTILITY_DIALOG_SET_HEIGHT, window.webContents.id, height);
        expect(window.setContentSize).toHaveBeenLastCalledWith(360, expected, false);
      }
      expect(window.setContentSize).toHaveBeenCalledTimes(7);
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 0);
      await expect(result).resolves.toEqual({ response: 0, checkboxChecked: false });
    });

    it("normalizes button lists and IDs, and treats invalid replies as cancel", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const empty = presentUtilityDialog({
        ...dialogOptions,
        buttons: [],
        defaultId: 9,
        cancelId: -1,
      });
      const window = createdWindow(BrowserWindow);
      expect(invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, window.webContents.id)).toEqual({
        ...dialogOptions,
        buttons: ["OK"],
        defaultId: 0,
        cancelId: 0,
      });
      readyUtilityDialog();
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 1);
      await expect(empty).resolves.toEqual({ response: 0, checkboxChecked: false });

      const oversized = presentUtilityDialog({
        ...dialogOptions,
        buttons: ["Not now", "Later", "Install", "Unused"],
        defaultId: 1.5,
        cancelId: 2,
      });
      expect(invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, window.webContents.id)).toEqual({
        ...dialogOptions,
        buttons: ["Not now", "Later", "Install"],
        defaultId: 2,
        cancelId: 2,
      });
      expect(window.webContents.send).toHaveBeenCalledTimes(2);
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, "1");
      await expect(oversized).resolves.toEqual({ response: 2, checkboxChecked: false });

      const nonInteger = presentUtilityDialog({ ...dialogOptions, defaultId: 0, cancelId: 1 });
      expect(invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, window.webContents.id)).toEqual({
        ...dialogOptions,
        defaultId: 0,
        cancelId: 1,
      });
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 0.5);
      await expect(nonInteger).resolves.toEqual({ response: 1, checkboxChecked: false });
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      expect(mockLoadURL).toHaveBeenCalledTimes(1);
    });

    it("force-destroys an in-flight shell, removes private IPC and ignores late ready", async () => {
      const { presentUtilityDialog, closeUtilityDialogWindow } =
        await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const result = presentUtilityDialog({ ...dialogOptions, cancelId: 1 });
      const window = createdWindow(BrowserWindow);

      closeUtilityDialogWindow();
      await expect(result).resolves.toEqual({ response: 1, checkboxChecked: false });
      expect(mockDestroy).toHaveBeenCalledTimes(1);
      expect(mockHide).not.toHaveBeenCalled();
      expect(mockIpcRemoveHandler.mock.calls.map(([channel]) => channel)).toEqual([
        UTILITY_DIALOG_GET_PAYLOAD,
        UTILITY_DIALOG_RESPOND,
        UTILITY_DIALOG_SET_HEIGHT,
      ]);
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
      readyUtilityDialog();
      expect(mockShow).not.toHaveBeenCalled();
      expect(window.webContents.send).not.toHaveBeenCalled();

      closeUtilityDialogWindow();
      expect(mockDestroy).toHaveBeenCalledTimes(1);
      expect(mockIpcRemoveHandler).toHaveBeenCalledTimes(3);
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
    });

    it("settles an active dialog and destroys its shell on app-wide window teardown", async () => {
      const { presentUtilityDialog, destroyAllWindows } =
        await import("../../src/main/process/window-graph.js");
      const result = presentUtilityDialog({ ...dialogOptions, cancelId: 1 });
      readyUtilityDialog();

      destroyAllWindows();
      await expect(result).resolves.toEqual({ response: 1, checkboxChecked: false });
      expect(mockDestroy).toHaveBeenCalledTimes(1);
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
      expect(mockIpcRemoveHandler).toHaveBeenCalledTimes(3);
      expect(mockHide).not.toHaveBeenCalled();
    });

    it("still allows dismissal if resizing or application focus fails", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow, app } = await import("electron");
      const result = presentUtilityDialog(dialogOptions);
      const window = createdWindow(BrowserWindow);
      vi.mocked(window.setContentSize).mockImplementationOnce(() => {
        throw new Error("Window is closing");
      });
      vi.mocked(app.focus).mockImplementationOnce(() => {
        throw new Error("Cannot focus");
      });

      readyUtilityDialog();
      expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(UTILITY_DIALOG_APPLY, {
        ...dialogOptions,
      });
      expect(mockShow).toHaveBeenCalledTimes(1);
      expect(mockFocus).toHaveBeenCalledTimes(1);
      expect(closeUtilityDialog()).toHaveBeenCalledTimes(1);
      await expect(result).resolves.toEqual({ response: 0, checkboxChecked: false });
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
    });

    it("does not push to destroyed renderer contents during presentation", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const result = presentUtilityDialog(dialogOptions);
      const window = createdWindow(BrowserWindow);
      vi.mocked(window.webContents.isDestroyed).mockReturnValue(true);

      readyUtilityDialog();
      expect(window.webContents.send).not.toHaveBeenCalled();
      expect(mockShow).toHaveBeenCalledTimes(1);
      expect(closeUtilityDialog()).toHaveBeenCalledTimes(1);
      await expect(result).resolves.toEqual({ response: 0, checkboxChecked: false });
    });

    it("destroys the hidden cache on cleanup, then registers fresh IPC for a new shell", async () => {
      const { presentUtilityDialog, closeUtilityDialogWindow } =
        await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const first = presentUtilityDialog(dialogOptions);
      const firstWindow = createdWindow(BrowserWindow);
      readyUtilityDialog();
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, firstWindow.webContents.id, 1);
      await expect(first).resolves.toEqual({ response: 1, checkboxChecked: false });

      closeUtilityDialogWindow();
      expect(mockDestroy).toHaveBeenCalledTimes(1);
      expect(mockIpcRemoveHandler).toHaveBeenCalledTimes(3);
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
      closeUtilityDialogWindow();
      expect(mockDestroy).toHaveBeenCalledTimes(1);

      const second = presentUtilityDialog({ ...dialogOptions, title: "New shell" });
      const nextWindow = createdWindow(BrowserWindow, 1);
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
      expect(mockLoadURL).toHaveBeenCalledTimes(2);
      expect(mockIpcHandle).toHaveBeenCalledTimes(6);
      expect(() =>
        invokeUtilityDialog(UTILITY_DIALOG_GET_PAYLOAD, firstWindow.webContents.id),
      ).toThrow("No active dialog payload");
      readyUtilityDialog(1);
      expect(nextWindow.webContents.send).toHaveBeenCalledExactlyOnceWith(UTILITY_DIALOG_APPLY, {
        ...dialogOptions,
        title: "New shell",
      });
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, nextWindow.webContents.id, 0);
      await expect(second).resolves.toEqual({ response: 0, checkboxChecked: false });
    });

    it("settles on an external closed event and re-creates its shell", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      const first = presentUtilityDialog({ ...dialogOptions, cancelId: 1 });
      closedUtilityDialog();
      await expect(first).resolves.toEqual({ response: 1, checkboxChecked: false });
      expect(mockReleaseUtility).toHaveBeenCalledTimes(1);
      expect(mockIpcRemoveHandler).toHaveBeenCalledTimes(3);

      const second = presentUtilityDialog(dialogOptions);
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
      expect(mockIpcHandle).toHaveBeenCalledTimes(6);
      readyUtilityDialog(1);
      const window = createdWindow(BrowserWindow, 1);
      expect(mockShow).toHaveBeenCalledTimes(1);
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 0);
      await expect(second).resolves.toEqual({ response: 0, checkboxChecked: false });
      expect(mockReleaseUtility).toHaveBeenCalledTimes(2);
    });

    it("returns the cancel result when the window cannot be constructed", async () => {
      const { presentUtilityDialog } = await import("../../src/main/process/window-graph.js");
      const { BrowserWindow } = await import("electron");
      vi.mocked(BrowserWindow).mockImplementationOnce(function () {
        throw new Error("Window creation failed");
      });

      await expect(presentUtilityDialog({ ...dialogOptions, cancelId: 1 })).resolves.toEqual({
        response: 1,
        checkboxChecked: false,
      });
      expect(mockIpcHandle).not.toHaveBeenCalled();
      expect(mockAcquireUtility).not.toHaveBeenCalled();
      expect(mockShow).not.toHaveBeenCalled();

      const retried = presentUtilityDialog(dialogOptions);
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
      readyUtilityDialog();
      const window = createdWindow(BrowserWindow, 1);
      invokeUtilityDialog(UTILITY_DIALOG_RESPOND, window.webContents.id, 1);
      await expect(retried).resolves.toEqual({ response: 1, checkboxChecked: false });
    });
  });
});
