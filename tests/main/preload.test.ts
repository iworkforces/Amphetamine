import { describe, it, expect, vi, beforeEach } from "vitest";
import { IPC_CHANNELS } from "../../src/shared/types.js";
import { SETTINGS_QUIT_DRAIN_REQUEST, SETTINGS_QUIT_DRAIN_ACK } from "../../src/shared/settings-quit.js";

const mockSend = vi.fn();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockExposeInMainWorld = vi.fn();

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    send: mockSend,
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
}));

describe("preload", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Capture the API object passed to exposeInMainWorld
    mockExposeInMainWorld.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_name: string, exposedApi: any) => {
        api = exposedApi;
      },
    );

    await import("../../src/preload/index.js");
  });

  it("exposes api to main world via contextBridge", () => {
    expect(mockExposeInMainWorld).toHaveBeenCalledWith("api", expect.any(Object));
  });

  it("exposes platform.os from process.platform", () => {
    expect(api.platform.os).toBe(process.platform);
  });

  it("window.setHeight calls ipcRenderer.send with channel and height", () => {
    api.window.setHeight(300);

    expect(mockSend).toHaveBeenCalledWith(IPC_CHANNELS.WINDOW_SET_HEIGHT, 300);
  });

  it("app.getVersion calls ipcRenderer.invoke with correct channel", () => {
    api.app.getVersion();

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_GET_VERSION);
  });

  it("app.getAbout calls ipcRenderer.invoke with correct channel", () => {
    api.app.getAbout();

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_GET_ABOUT);
  });

  it("settings.get calls ipcRenderer.invoke with correct channel", () => {
    api.settings.get();

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_GET);
  });

  it("settings.set calls ipcRenderer.invoke with partial settings", () => {
    const partial = { preventSleep: true };
    api.settings.set(partial);

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_SET, partial);
  });

  it("settings.open calls ipcRenderer.invoke with correct channel", () => {
    api.settings.open();

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_OPEN);
  });

  it("exposes only a typed quit drain subscription and acknowledgement", () => {
    const callback = vi.fn();
    const unsubscribe = api.settings.onQuitDrain(callback);
    expect(mockOn).toHaveBeenCalledWith(SETTINGS_QUIT_DRAIN_REQUEST, expect.any(Function));
    const listener = mockOn.mock.calls.find(([channel]) => channel === SETTINGS_QUIT_DRAIN_REQUEST)?.[1];
    listener({}, { requestId: "quit-1" });
    expect(callback).toHaveBeenCalledExactlyOnceWith({ requestId: "quit-1" });
    const ack = { requestId: "quit-1", status: "saved" };
    api.settings.ackQuitDrain(ack);
    expect(mockSend).toHaveBeenCalledWith(SETTINGS_QUIT_DRAIN_ACK, ack);
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(SETTINGS_QUIT_DRAIN_REQUEST, listener);
    expect(api.settings.send).toBeUndefined();
  });

  it("session.start calls ipcRenderer.invoke with durationMinutes", () => {
    api.session.start(30);

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_START, {
      durationMinutes: 30,
    });
  });

  it("session.start with null calls ipcRenderer.invoke with null duration", () => {
    api.session.start(null);

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_START, {
      durationMinutes: null,
    });
  });

  it("session.cancel calls ipcRenderer.invoke with correct channel", () => {
    api.session.cancel();

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_CANCEL);
  });

  it("session.getStatus calls ipcRenderer.invoke with correct channel", () => {
    api.session.getStatus();

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_STATUS);
  });

  it("quit calls ipcRenderer.invoke with correct channel", () => {
    api.app.quit();

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_QUIT);
  });

  it("onSettingsChanged registers listener and returns unsubscribe function", () => {
    const callback = vi.fn();
    const unsubscribe = api.onSettingsChanged(callback);

    expect(mockOn).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED, expect.any(Function));

    // Simulate settings push from main process
    const listener = mockOn.mock.calls[0]![1];
    const testSettings = { preventSleep: true, launchAtLogin: false, defaultSessionDuration: null };
    listener({}, testSettings);
    expect(callback).toHaveBeenCalledWith(testSettings);

    // Unsubscribe removes the listener
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED, listener);
  });

  it("onSessionStatusUpdate registers listener and returns unsubscribe function", () => {
    const callback = vi.fn();
    const unsubscribe = api.onSessionStatusUpdate(callback);

    expect(mockOn).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_STATUS_UPDATE, expect.any(Function));

    // Simulate session status push from main process
    const calls = mockOn.mock.calls;
    const sessionCall = calls.find(
      (c: unknown[]) => c[0] === IPC_CHANNELS.SESSION_STATUS_UPDATE,
    );
    const listener = sessionCall![1];
    const testStatus = {
      isRunning: true,
      startedAt: 1000,
      expiresAt: 2000,
      remainingSeconds: 60,
      durationMinutes: 30,
    };
    listener({}, testStatus);
    expect(callback).toHaveBeenCalledWith(testStatus);

    // Unsubscribe removes the listener
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.SESSION_STATUS_UPDATE,
      listener,
    );
  });

  it("autoUpdater.checkForUpdates calls ipcRenderer.invoke with correct channel", () => {
    api.autoUpdater.checkForUpdates();

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.AUTO_UPDATER_CHECK);
  });

  it("autoUpdater.onStatus registers listener and returns unsubscribe function", () => {
    const callback = vi.fn();
    const unsubscribe = api.autoUpdater.onStatus(callback);

    expect(mockOn).toHaveBeenCalledWith(IPC_CHANNELS.AUTO_UPDATER_STATUS, expect.any(Function));

    // Simulate status push from main process
    const statusCall = mockOn.mock.calls.find(
      (c: unknown[]) => c[0] === IPC_CHANNELS.AUTO_UPDATER_STATUS,
    );
    const listener = statusCall![1];
    const testStatus = {
      status: "available",
      info: { version: "2.0.0", releaseDate: "2025-01-01" },
    };
    listener({}, testStatus);
    expect(callback).toHaveBeenCalledWith(testStatus);

    // Unsubscribe removes the listener
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(IPC_CHANNELS.AUTO_UPDATER_STATUS, listener);
  });

  it("onWindowHide registers listener and returns unsubscribe", () => {
    const callback = vi.fn();
    const unsubscribe = api.onWindowHide(callback);
    const hideCall = mockOn.mock.calls.find((c: unknown[]) => c[0] === IPC_CHANNELS.WINDOW_HIDE);
    const listener = hideCall![1];
    listener({});
    expect(callback).toHaveBeenCalled();
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(IPC_CHANNELS.WINDOW_HIDE, listener);
  });

  it("onShortcutRegistrationFailed registers listener and returns unsubscribe", () => {
    const callback = vi.fn();
    const unsubscribe = api.onShortcutRegistrationFailed(callback);
    const failCall = mockOn.mock.calls.find(
      (c: unknown[]) => c[0] === IPC_CHANNELS.SHORTCUT_REGISTRATION_FAILED,
    );
    const listener = failCall![1];
    listener({}, { accelerator: "Cmd+Shift+A" });
    expect(callback).toHaveBeenCalledWith({ accelerator: "Cmd+Shift+A" });
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.SHORTCUT_REGISTRATION_FAILED,
      listener,
    );
  });

  it("benchmark.isEnabled reflects env", () => {
    expect(typeof api.benchmark.isEnabled()).toBe("boolean");
  });
});
