import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCompositionInit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCompositionCleanup = vi.hoisted(() => vi.fn());
const mockGetIpcDeps = vi.hoisted(() => vi.fn().mockReturnValue({ sessionTimer: {} }));
const mockGetTrayDeps = vi.hoisted(() => vi.fn().mockReturnValue({}));
const mockInitUpdater = vi.hoisted(() => vi.fn());
const mockCreateAppComposition = vi.hoisted(() =>
  vi.fn(() => ({
    init: mockCompositionInit,
    initUpdater: mockInitUpdater,
    cleanup: mockCompositionCleanup,
    getIpcDeps: mockGetIpcDeps,
    getTrayDeps: mockGetTrayDeps,
    ready: true,
  })),
);
const mockSetupTray = vi.hoisted(() => vi.fn().mockReturnValue(vi.fn()));
const mockIpcCleanup = vi.hoisted(() => vi.fn());
const mockRegisterIpcHandlers = vi.hoisted(() => vi.fn().mockReturnValue(mockIpcCleanup));
const mockFlushSettings = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockEnterTrayOnlyMode = vi.hoisted(() => vi.fn());
const mockCreatePopoverWindow = vi.hoisted(() =>
  vi.fn().mockReturnValue({ id: 1, show: vi.fn(), isDestroyed: () => false }),
);
const mockDestroyAllWindows = vi.hoisted(() => vi.fn());
const mockGetPopoverWindow = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockIsBenchmarkMode = vi.hoisted(() => vi.fn().mockReturnValue(false));

vi.mock("electron-log", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../src/main/composition-root.js", () => ({
  createAppComposition: mockCreateAppComposition,
}));

vi.mock("../../src/main/ipc.js", () => ({
  registerIpcHandlers: mockRegisterIpcHandlers,
}));

vi.mock("../../src/main/tray.js", () => ({
  setupTray: mockSetupTray,
}));

vi.mock("../../src/main/settings.js", () => ({
  flushSettingsWriteChain: mockFlushSettings,
}));

vi.mock("../../src/infrastructure/benchmark/benchmark-env.js", () => ({
  isBenchmarkMode: () => mockIsBenchmarkMode(),
}));

vi.mock("../../src/main/platform/index.js", () => ({
  enterTrayOnlyMode: mockEnterTrayOnlyMode,
}));

vi.mock("../../src/main/process/window-graph.js", () => ({
  createPopoverWindow: mockCreatePopoverWindow,
  destroyAllWindows: mockDestroyAllWindows,
  getPopoverWindow: mockGetPopoverWindow,
}));

describe("createAppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockCompositionInit.mockResolvedValue(undefined);
    mockFlushSettings.mockResolvedValue(undefined);
    mockSetupTray.mockReturnValue(vi.fn());
    mockRegisterIpcHandlers.mockReturnValue(mockIpcCleanup);
    mockIsBenchmarkMode.mockReturnValue(false);
    mockGetPopoverWindow.mockReturnValue(null);
    mockCreatePopoverWindow.mockReturnValue({
      id: 1,
      show: vi.fn(),
      isDestroyed: () => false,
    });
  });

  it("init follows process-graph ready order", async () => {
    const { createAppShell } = await import("../../src/main/app-shell.js");
    const shell = createAppShell();
    await shell.init();

    expect(mockEnterTrayOnlyMode).toHaveBeenCalled();
    expect(mockCreatePopoverWindow).toHaveBeenCalled();
    expect(mockCreateAppComposition).toHaveBeenCalled();
    expect(mockCompositionInit).toHaveBeenCalled();
    expect(mockRegisterIpcHandlers).toHaveBeenCalled();
    expect(mockSetupTray).toHaveBeenCalled();
    expect(mockInitUpdater).toHaveBeenCalled();
    expect(shell.ready).toBe(true);

    // Order: tray-only → popover → composition.init → ipc → tray → updater
    const order = [
      mockEnterTrayOnlyMode.mock.invocationCallOrder[0],
      mockCreatePopoverWindow.mock.invocationCallOrder[0],
      mockCompositionInit.mock.invocationCallOrder[0],
      mockRegisterIpcHandlers.mock.invocationCallOrder[0],
      mockSetupTray.mock.invocationCallOrder[0],
      mockInitUpdater.mock.invocationCallOrder[0],
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    }
  });

  it("skips auto-updater init in benchmark mode", async () => {
    mockIsBenchmarkMode.mockReturnValue(true);
    const { createAppShell } = await import("../../src/main/app-shell.js");
    await createAppShell().init();
    expect(mockInitUpdater).not.toHaveBeenCalled();
  });

  it("cleanup is ordered and idempotent", async () => {
    const trayCleanup = vi.fn();
    mockSetupTray.mockReturnValue(trayCleanup);
    const { createAppShell } = await import("../../src/main/app-shell.js");
    const shell = createAppShell();
    await shell.init();
    await shell.cleanup();
    await shell.cleanup();

    expect(mockFlushSettings).toHaveBeenCalledTimes(1);
    expect(trayCleanup).toHaveBeenCalledTimes(1);
    expect(mockIpcCleanup).toHaveBeenCalledTimes(1);
    expect(mockCompositionCleanup).toHaveBeenCalledTimes(1);
    expect(mockDestroyAllWindows).toHaveBeenCalledTimes(1);
    expect(shell.ready).toBe(false);
    const order = [
      mockFlushSettings.mock.invocationCallOrder[0],
      trayCleanup.mock.invocationCallOrder[0],
      mockIpcCleanup.mock.invocationCallOrder[0],
      mockCompositionCleanup.mock.invocationCallOrder[0],
      mockDestroyAllWindows.mock.invocationCallOrder[0],
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    }
  });

  it("passes isQuitting predicate into createPopoverWindow", async () => {
    const { createAppShell } = await import("../../src/main/app-shell.js");
    const shell = createAppShell();
    await shell.init();
    const opts = mockCreatePopoverWindow.mock.calls[0]![0] as {
      isQuitting: () => boolean;
    };
    expect(opts.isQuitting()).toBe(false);
    await shell.cleanup();
    expect(opts.isQuitting()).toBe(true);
  });

  it("showMainWindow uses popover registry", async () => {
    const show = vi.fn();
    mockGetPopoverWindow.mockReturnValue({ show });
    const { createAppShell } = await import("../../src/main/app-shell.js");
    const shell = createAppShell();
    shell.showMainWindow();
    expect(show).toHaveBeenCalled();
  });

  it("shares pending init and cleanup, and never acquires resources after closing", async () => {
    const settings = Promise.withResolvers<void>();
    const flush = Promise.withResolvers<void>();
    mockCompositionInit.mockReturnValue(settings.promise);
    mockFlushSettings.mockReturnValue(flush.promise);
    const { createAppShell } = await import("../../src/main/app-shell.js");
    const shell = createAppShell();
    const firstInit = shell.init();
    expect(shell.init()).toBe(firstInit);
    const firstCleanup = shell.cleanup();
    expect(shell.cleanup()).toBe(firstCleanup);
    flush.resolve();
    await firstCleanup;
    settings.resolve();
    await firstInit;
    await shell.init();
    expect(mockCreateAppComposition).toHaveBeenCalledTimes(1);
    expect(mockRegisterIpcHandlers).not.toHaveBeenCalled();
    expect(mockIpcCleanup).not.toHaveBeenCalled();
    expect(mockSetupTray).not.toHaveBeenCalled();
    expect(mockInitUpdater).not.toHaveBeenCalled();
    expect(mockCompositionCleanup).toHaveBeenCalledTimes(1);
    expect(shell.ready).toBe(false);
  });

  it("does not deadlock when initialization rejects after cleanup has begun", async () => {
    const settings = Promise.withResolvers<void>();
    mockCompositionInit.mockReturnValue(settings.promise);
    const { createAppShell } = await import("../../src/main/app-shell.js");
    const shell = createAppShell();
    const init = shell.init();
    const cleanup = shell.cleanup();
    await cleanup;
    settings.reject(new Error("settings failed"));
    await expect(init).rejects.toThrow("settings failed");
    expect(mockCompositionCleanup).toHaveBeenCalledTimes(1);
    expect(mockRegisterIpcHandlers).not.toHaveBeenCalled();
    expect(mockIpcCleanup).not.toHaveBeenCalled();
    expect(mockSetupTray).not.toHaveBeenCalled();
  });

  it("disposes partial startup when IPC registration throws", async () => {
    mockRegisterIpcHandlers.mockImplementationOnce(() => {
      throw new Error("IPC failed");
    });
    const { createAppShell } = await import("../../src/main/app-shell.js");
    const shell = createAppShell();
    await expect(shell.init()).rejects.toThrow("IPC failed");
    await shell.cleanup();
    expect(mockCompositionCleanup).toHaveBeenCalledTimes(1);
    expect(mockDestroyAllWindows).toHaveBeenCalledTimes(1);
    expect(mockSetupTray).not.toHaveBeenCalled();
    expect(mockIpcCleanup).not.toHaveBeenCalled();
    expect(mockInitUpdater).not.toHaveBeenCalled();
    expect(shell.ready).toBe(false);
  });

  it("finishes cleanup after a throwing tray disposer and cancels the flush timer", async () => {
    vi.useFakeTimers();
    try {
      const trayCleanup = vi.fn(() => {
        throw new Error("tray failure");
      });
      mockSetupTray.mockReturnValue(trayCleanup);
      const { createAppShell } = await import("../../src/main/app-shell.js");
      const shell = createAppShell();
      await shell.init();
      await shell.cleanup();
      expect(vi.getTimerCount()).toBe(0);
      expect(trayCleanup).toHaveBeenCalledTimes(1);
      expect(mockIpcCleanup).toHaveBeenCalledTimes(1);
      expect(mockCompositionCleanup).toHaveBeenCalledTimes(1);
      expect(mockDestroyAllWindows).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases IPC after tray setup fails and keeps the original startup error", async () => {
    const failure = new Error("tray setup failed");
    mockSetupTray.mockImplementationOnce(() => {
      throw failure;
    });
    mockIpcCleanup.mockImplementationOnce(() => {
      throw new Error("IPC cleanup failed");
    });
    const { createAppShell } = await import("../../src/main/app-shell.js");
    const shell = createAppShell();

    await expect(shell.init()).rejects.toBe(failure);
    await shell.cleanup();
    expect(mockIpcCleanup).toHaveBeenCalledOnce();
    expect(mockCompositionCleanup).toHaveBeenCalledOnce();
    expect(mockDestroyAllWindows).toHaveBeenCalledOnce();
    expect(shell.ready).toBe(false);
  });

  it("preserves updater startup failure when window teardown throws", async () => {
    const failure = new Error("updater failed");
    mockInitUpdater.mockImplementationOnce(() => {
      throw failure;
    });
    mockDestroyAllWindows.mockImplementationOnce(() => {
      throw new Error("window destroy failed");
    });
    const { createAppShell } = await import("../../src/main/app-shell.js");
    const shell = createAppShell();

    await expect(shell.init()).rejects.toBe(failure);
    expect(mockIpcCleanup).toHaveBeenCalledOnce();
    expect(mockCompositionCleanup).toHaveBeenCalledOnce();
    expect(mockDestroyAllWindows).toHaveBeenCalledOnce();
    expect(shell.getMainWindow()).toBeNull();
  });

  it("bounds a stalled settings flush to 2000 ms", async () => {
    vi.useFakeTimers();
    try {
      mockFlushSettings.mockReturnValue(new Promise<void>(() => {}));
      const { createAppShell } = await import("../../src/main/app-shell.js");
      const shell = createAppShell();
      await shell.init();
      const cleanup = shell.cleanup();
      await vi.advanceTimersByTimeAsync(1999);
      expect(mockDestroyAllWindows).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await cleanup;
      expect(mockDestroyAllWindows).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
