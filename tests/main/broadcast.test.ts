import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PushChannel, IpcResponse } from "../../src/shared/types.js";
import { IPC_CHANNELS, DEFAULT_SETTINGS } from "../../src/shared/types.js";

const { mockGetAllWindows } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn().mockReturnValue([]),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: mockGetAllWindows },
}));

describe("broadcastToWindows", () => {
  let broadcastToWindows: <K extends PushChannel>(
    channel: K,
    data: IpcResponse<K>,
  ) => void;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetAllWindows.mockReturnValue([]);
    const mod = await import("../../src/main/utils/broadcast.js");
    broadcastToWindows = mod.broadcastToWindows;
  });

  it("does nothing when there are no windows", () => {
    mockGetAllWindows.mockReturnValue([]);
    broadcastToWindows(IPC_CHANNELS.SESSION_STATUS_UPDATE, {
      isRunning: false,
      startedAt: null,
      expiresAt: null,
      remainingSeconds: null,
      durationMinutes: null,
    });
    expect(mockGetAllWindows).toHaveBeenCalledTimes(1);
  });

  it("sends to a single window", () => {
    const mockSend = vi.fn();
    mockGetAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: mockSend } },
    ]);

    broadcastToWindows(IPC_CHANNELS.SETTINGS_CHANGED, {
      ...DEFAULT_SETTINGS,
      launchAtLogin: false,
      preventSleep: true,
      defaultSessionDuration: null,
    });

    expect(mockSend).toHaveBeenCalledWith("settings:changed", {
      ...DEFAULT_SETTINGS,
      launchAtLogin: false,
      preventSleep: true,
      defaultSessionDuration: null,
    });
  });

  it("sends to multiple windows", () => {
    const mockSend1 = vi.fn();
    const mockSend2 = vi.fn();
    const mockSend3 = vi.fn();
    mockGetAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: mockSend1 } },
      { isDestroyed: () => false, webContents: { send: mockSend2 } },
      { isDestroyed: () => false, webContents: { send: mockSend3 } },
    ]);

    broadcastToWindows(IPC_CHANNELS.AUTO_UPDATER_STATUS, { status: "checking" });

    expect(mockSend1).toHaveBeenCalledWith("auto-updater:status", { status: "checking" });
    expect(mockSend2).toHaveBeenCalledWith("auto-updater:status", { status: "checking" });
    expect(mockSend3).toHaveBeenCalledWith("auto-updater:status", { status: "checking" });
  });

  it("skips destroyed windows", () => {
    const mockSend = vi.fn();
    mockGetAllWindows.mockReturnValue([
      { isDestroyed: () => true, webContents: { send: mockSend } },
    ]);

    broadcastToWindows(IPC_CHANNELS.AUTO_UPDATER_STATUS, { status: "error", category: "network" });

    expect(mockSend).not.toHaveBeenCalled();
  });
});

it("routes a semantic battery status to renderer windows", async () => {
  const { createBroadcastNotifier } = await import("../../src/infrastructure/notification/broadcast-notifier.js");
  const { broadcastToWindows } = await import("../../src/main/utils/broadcast.js");
  const send = vi.fn();
  mockGetAllWindows.mockReturnValue([{ isDestroyed: () => false, webContents: { send } }]);
  const status = { state: "inactive", reason: null, current: null, lastSample: null } as const;
  createBroadcastNotifier(broadcastToWindows).publish({ type: "battery-status", status });
  expect(send).toHaveBeenCalledWith(IPC_CHANNELS.BATTERY_STATUS_UPDATE, status);
});
