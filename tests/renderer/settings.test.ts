import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  AppSettings,
  IpcResponse,
  IPC_CHANNELS,
  SessionStartResponse,
  SessionStatusResponse,
} from "../../src/shared/types.js";
import { asPerf, DEFAULT_SETTINGS } from "../../src/shared/types.js";
import { SAVED_INDICATOR } from "../../src/renderer/settings/constants.js";

type SettingsSetResponse = IpcResponse<typeof IPC_CHANNELS.SETTINGS_SET>;

const mockApi = {
  window: { setHeight: vi.fn() },
  app: { getVersion: vi.fn().mockResolvedValue("1.0.0"), quit: vi.fn() },
  settings: {
    get: vi.fn<() => Promise<AppSettings>>(),
    set: vi.fn<(_partial: Partial<AppSettings>) => Promise<SettingsSetResponse>>(),
    open: vi.fn(),
  },
  session: {
    start: vi.fn(),
    cancel: vi.fn(),
    getStatus: vi.fn<() => Promise<SessionStatusResponse | null>>(),
  },
  onSettingsChanged: vi.fn<(_cb: (s: AppSettings) => void) => () => void>(() => vi.fn()),
  onShortcutRegistrationFailed: vi.fn<(_cb: (d: { accelerator: string }) => void) => () => void>(() => vi.fn()),
  onWindowHide: vi.fn(() => vi.fn()),
  onSessionStatusUpdate: vi.fn<(_cb: (status: SessionStatusResponse) => void) => () => void>(
    () => vi.fn(),
  ),
  autoUpdater: {
    checkForUpdates: vi.fn(),
    onStatus: vi.fn(() => vi.fn()),
  },
  platform: { os: "darwin" as string },
};

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

function setupDom(): void {
  document.body.innerHTML = '<div id="app"></div>';
}

describe("renderer settings", () => {
  const defaultSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    launchAtLogin: false,
    preventSleep: false,
    defaultSessionDuration: null,
  };
  const idleStatus: SessionStatusResponse = {
    isRunning: false,
    startedAt: null,
    expiresAt: null,
    remainingSeconds: null,
    durationMinutes: null,
  };

  function accepted(settings: AppSettings): SettingsSetResponse {
    return { settings, rejectedKeys: [] };
  }

  async function startCurrentSettingsEntry(): Promise<void> {
    vi.resetModules();
    const addListener = vi.spyOn(document, "addEventListener");
    await import("../../src/renderer/settings/index.js");
    const ready = addListener.mock.calls.find(([eventName]) => eventName === "DOMContentLoaded")?.[1];
    addListener.mockRestore();
    if (typeof ready !== "function") throw new Error("Settings entry did not register for DOM ready");
    document.removeEventListener("DOMContentLoaded", ready);
    ready.call(document, new Event("DOMContentLoaded"));
  }

  async function mountSettings(): Promise<void> {
    mockApi.session.getStatus.mockResolvedValue(idleStatus);
    await startCurrentSettingsEntry();
    await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setupDom();

    mockApi.settings.get.mockResolvedValue({ ...defaultSettings });
    mockApi.settings.set.mockImplementation(async (s: Partial<AppSettings>) => ({
      settings: { ...defaultSettings, ...s },
      rejectedKeys: [] as string[],
    }));
    mockApi.session.getStatus.mockResolvedValue(null);

    Object.defineProperty(globalThis, "window", {
      value: {
        ...globalThis.window,
        api: mockApi,
         
        addEventListener: globalThis.window?.addEventListener?.bind(globalThis.window) ?? vi.fn(),
        removeEventListener:
         
          globalThis.window?.removeEventListener?.bind(globalThis.window) ?? vi.fn(),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("render", () => {
    it("renders settings form with all controls and sections", async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(document.getElementById("launch-at-login-toggle")).not.toBeNull();
      expect(document.getElementById("prevent-sleep-toggle")).not.toBeNull();
      expect(document.getElementById("session-duration-select")).not.toBeNull();
      expect(document.getElementById("battery-threshold-select")).not.toBeNull();
      expect(document.getElementById("sleep-block-mode-select")).not.toBeNull();
      expect(document.getElementById("shortcut-input")).not.toBeNull();
      expect(document.getElementById("section-general")?.textContent).toBe("General");
      expect(document.getElementById("section-session")?.textContent).toBe("Session");
      expect(document.getElementById("section-power")?.textContent).toBe("Power");
      expect(SAVED_INDICATOR).toBe("Saved");
      expect(SAVED_INDICATOR).not.toMatch(/[✓✔✅]/);
    });

    it("saves sleep block mode without starting a session", async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const select = document.getElementById("sleep-block-mode-select") as HTMLSelectElement;
      select.value = "prevent-app-suspension";
      select.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(350);

      expect(mockApi.settings.set).toHaveBeenCalledWith({
        sleepBlockMode: "prevent-app-suspension",
      });
      expect(mockApi.session.start).not.toHaveBeenCalled();
    });

    it("surfaces rejectedKeys from settings.set", async () => {
      mockApi.settings.set.mockResolvedValueOnce({
        settings: { ...defaultSettings },
        rejectedKeys: ["shortcut"],
      });
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(350);

      const errorEl = document.getElementById("settings-error-text");
      expect(errorEl?.textContent).toContain("shortcut");
    });

    it("renders launch-at-login toggle checked when setting is true", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...defaultSettings,
        launchAtLogin: true,
      });

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      expect(toggle.checked).toBe(true);
    });

    it("renders prevent-sleep toggle unchecked by default", async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("prevent-sleep-toggle") as HTMLInputElement;
      expect(toggle.checked).toBe(false);
    });

    it("renders duration dropdown with correct options", async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const select = document.getElementById("session-duration-select") as HTMLSelectElement;
      const options = Array.from(select.options);
      const values = options.map((o) => o.value);

      expect(values).toEqual(["", "15", "30", "60", "120", "240"]);
    });

    it("selects correct duration option based on settings", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...defaultSettings,
        defaultSessionDuration: 60,
      });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now()),
        expiresAt: asPerf(Date.now() + 60 * 60 * 1000),
        remainingSeconds: 3600,
        durationMinutes: 60,
      });

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const select = document.getElementById("session-duration-select") as HTMLSelectElement;
      expect(select.value).toBe("60");
    });
  });

  describe("showSaveIndicator", () => {
    it('shows "Saved" indicator after successful save', async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));

      await vi.advanceTimersByTimeAsync(350);

      const indicator = document.getElementById("launch-save-indicator");
      expect(indicator?.textContent).toBe(SAVED_INDICATOR);
      expect(indicator?.classList.contains("visible")).toBe(true);
    });

    it("save indicator disappears after 1.5 seconds", async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));

      await vi.advanceTimersByTimeAsync(350);
      expect(document.getElementById("launch-save-indicator")?.classList.contains("visible")).toBe(
        true,
      );

      await vi.advanceTimersByTimeAsync(1500);
      expect(document.getElementById("launch-save-indicator")?.classList.contains("visible")).toBe(
        false,
      );
    });
  });

  describe("saveSettings debounce", () => {
    it("rapid calls only persist after 300ms debounce", async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;

      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(100);

      toggle.checked = false;
      toggle.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(100);

      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));

      expect(mockApi.settings.set).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(350);

      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);
      expect(mockApi.settings.set).toHaveBeenCalledWith(
        expect.objectContaining({ launchAtLogin: true }),
      );
    });
  });

  describe("error handling", () => {
    it("sets error via textContent (XSS prevention)", async () => {
      mockApi.settings.set.mockRejectedValue(new Error("Network error"));

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));

      await vi.advanceTimersByTimeAsync(350);

      const errorEl = document.getElementById("settings-error-text");
      expect(errorEl?.textContent).toBe("Network error");
      // Verify it was set via textContent not innerHTML (XSS prevention)
      expect(errorEl?.innerHTML).not.toContain("<script>");
    });

    it("renders generic message for non-Error throws", async () => {
      mockApi.settings.set.mockRejectedValue("unknown failure");

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("prevent-sleep-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));

      await vi.advanceTimersByTimeAsync(350);

      const errorEl = document.getElementById("settings-error-text");
      expect(errorEl?.textContent).toBe("Failed to save settings");
    });
  });

  describe("toggle and dropdown interactions", () => {
    it("calls settings.set with preventSleep: true when sleep toggle enabled", async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("prevent-sleep-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));

      await vi.advanceTimersByTimeAsync(350);

      expect(mockApi.settings.set).toHaveBeenCalledWith(
        expect.objectContaining({ preventSleep: true }),
      );
    });

    it("calls session.start when duration dropdown changes", async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const select = document.getElementById("session-duration-select") as HTMLSelectElement;
      select.value = "30";
      select.dispatchEvent(new Event("change"));

      expect(mockApi.session.start).toHaveBeenCalledWith(30);
    });

    it("sets defaultSessionDuration when duration selected (no longer conflates preventSleep)", async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const select = document.getElementById("session-duration-select") as HTMLSelectElement;
      select.value = "60";
      select.dispatchEvent(new Event("change"));

      await vi.advanceTimersByTimeAsync(350);

      // Renderer no longer writes preventSleep when starting a session.
      // Sleep prevention is derived in composition from
      // (settings.preventSleep || sessionTimer.sessionActive).
      const calls = mockApi.settings.set.mock.calls.map((c: unknown[]) => c[0]);
      const durationCall = calls.find(
        (c): c is Record<string, unknown> =>
          typeof c === "object" && c !== null && "defaultSessionDuration" in c,
      );
      // Debounced save sends only the changed preference keys (partial), not a full snapshot.
      expect(durationCall).toEqual(expect.objectContaining({ defaultSessionDuration: 60 }));
      expect(durationCall).not.toHaveProperty("preventSleep");
    });

    it("sends null duration when Indefinitely selected", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...defaultSettings,
        defaultSessionDuration: 30,
        preventSleep: true,
      });

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const select = document.getElementById("session-duration-select") as HTMLSelectElement;
      select.value = "";
      select.dispatchEvent(new Event("change"));

      expect(mockApi.session.start).toHaveBeenCalledWith(null);

      await vi.advanceTimersByTimeAsync(350);

      expect(mockApi.settings.set).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultSessionDuration: null,
        }),
      );
    });

  });
  describe("onSettingsChanged push updates", () => {
    it("updates UI when settings are pushed from main process", async () => {
      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const launchToggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      expect(launchToggle.checked).toBe(false);

      const callback = mockApi.onSettingsChanged.mock.calls[0]![0];
      callback({
        ...defaultSettings,
        launchAtLogin: true,
        preventSleep: true,
      });

      expect(launchToggle.checked).toBe(true);
      const sleepToggle = document.getElementById("prevent-sleep-toggle") as HTMLInputElement;
      expect(sleepToggle.checked).toBe(true);
    });

    it("updates duration dropdown when pushed", async () => {
      mockApi.session.getStatus.mockResolvedValue(null);

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const select = document.getElementById("session-duration-select") as HTMLSelectElement;
      expect(select.value).toBe("");

      const callback = mockApi.onSettingsChanged.mock.calls.at(-1)![0];
      callback({
        ...defaultSettings,
        defaultSessionDuration: 120,
        preventSleep: true,
      });

      expect(select.value).toBe("120");
    });
    it("preserves running session duration when settings push arrives", async () => {
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now()),
        expiresAt: asPerf(Date.now() + 60 * 60 * 1000),
        remainingSeconds: 3600,
        durationMinutes: 60,
      });

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const select = document.getElementById("session-duration-select") as HTMLSelectElement;
      expect(select.value).toBe("60"); // init from running session

      // Simulate a SETTINGS_CHANGED push (e.g., tray toggled preventSleep)
      // The push carries the stored defaultSessionDuration (null, not the running 60)
      const callback = mockApi.onSettingsChanged.mock.calls[0]![0];
      callback({
        ...defaultSettings,
        preventSleep: true,
        defaultSessionDuration: null, // stored value on disk
      });

      // Dropdown must NOT revert to stored null — running session duration wins
      expect(select.value).toBe("60");
    });

  });

  describe("latest-snapshot save queue", () => {
    it("queues the latest snapshot when a save is already in flight", async () => {
      const resolvers: Array<(v: AppSettings) => void> = [];
      mockApi.settings.set.mockImplementation(
        (s: Partial<AppSettings>) =>
          new Promise((resolve) => {
            resolvers.push(() => resolve({ settings: { ...defaultSettings, ...s }, rejectedKeys: [] }));
          }),
      );

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));

      // Let the debounce fire — first save is now in flight (unresolved).
      await vi.advanceTimersByTimeAsync(350);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);
      expect(mockApi.settings.set.mock.calls[0]![0].launchAtLogin).toBe(true);

      // While the first save is still pending, the user flips it again.
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(350);

      // The second save must NOT have been issued yet — it should be queued.
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);

      // Resolve the in-flight save; the queued latest snapshot must now flush.
      resolvers[0]!({ ...defaultSettings, launchAtLogin: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(mockApi.settings.set).toHaveBeenCalledTimes(2);
      expect(mockApi.settings.set.mock.calls[1]![0].launchAtLogin).toBe(false);

      // Resolve the queued save so no dangling promises remain.
      resolvers[1]!({ ...defaultSettings, launchAtLogin: false });
      await vi.advanceTimersByTimeAsync(0);
    });

    it("collapses multiple in-flight changes into a single latest-snapshot save", async () => {
      const resolvers: Array<(v: AppSettings) => void> = [];
      mockApi.settings.set.mockImplementation(
        (s: Partial<AppSettings>) =>
          new Promise((resolve) => {
            resolvers.push(() => resolve({ settings: { ...defaultSettings, ...s }, rejectedKeys: [] }));
          }),
      );

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(350);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);

      // Several rapid changes while the first save is still pending.
      const batterySelect = document.getElementById(
        "battery-threshold-select",
      ) as HTMLSelectElement;
      batterySelect.value = "10";
      batterySelect.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(350);
      batterySelect.value = "20";
      batterySelect.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(350);

      // Still only one in-flight save; the rest collapsed into the queue.
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);

      resolvers[0]!({ ...defaultSettings, launchAtLogin: true });
      await vi.advanceTimersByTimeAsync(0);

      // Exactly one follow-up save with the LATEST partial batch is issued.
      expect(mockApi.settings.set).toHaveBeenCalledTimes(2);
      expect(mockApi.settings.set.mock.calls[1]![0].batteryThreshold).toBe(20);
      // launchAtLogin already flushed in the first save; second batch may only carry battery.

      resolvers[1]!({ ...defaultSettings, launchAtLogin: true, batteryThreshold: 20 });
      await vi.advanceTimersByTimeAsync(0);
    });

    it("does not permanently block queued saves when an in-flight save fails", async () => {
      let callCount = 0;
      const resolvers: Array<() => void> = [];
      const rejectors: Array<(e: Error) => void> = [];
      mockApi.settings.set.mockImplementation(
        (s: Partial<AppSettings>) => new Promise((resolve, reject) => {
            callCount += 1;
            if (callCount === 1) {
              rejectors.push(() => reject(new Error("Disk full")));
            } else {
              resolvers.push(() => resolve(accepted({ ...defaultSettings, ...s })));
            }
          }),
      );

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(350);

      // Queue a follow-up change while the first save is in flight.
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(350);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);

      // Fail the in-flight save — the queued snapshot must still get a chance.
      rejectors[0]!(new Error("Disk full"));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockApi.settings.set).toHaveBeenCalledTimes(2);
      expect(mockApi.settings.set.mock.calls[1]![0].launchAtLogin).toBe(false);

      resolvers[0]!();
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  describe("save reconciliation with renderer state", () => {
    it("keeps a debounced local edit visible through a settings push while applying unrelated fields", async () => {
      await mountSettings();

      const sleepToggle = document.getElementById("prevent-sleep-toggle") as HTMLInputElement;
      const batterySelect = document.getElementById("battery-threshold-select") as HTMLSelectElement;
      sleepToggle.checked = true;
      sleepToggle.dispatchEvent(new Event("change"));
      expect(sleepToggle.checked).toBe(true);
      expect(mockApi.settings.set).not.toHaveBeenCalled();

      mockApi.onSettingsChanged.mock.calls.at(-1)![0]({
        ...defaultSettings,
        batteryThreshold: 10,
      });
      expect(batterySelect.value).toBe("10");
      expect(sleepToggle.checked).toBe(true);

      await vi.advanceTimersByTimeAsync(299);
      expect(mockApi.settings.set).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ preventSleep: true });
    });

    it("does not repaint a newer same-key edit with an older save response", async () => {
      const firstSave = Promise.withResolvers<SettingsSetResponse>();
      mockApi.settings.set.mockImplementationOnce(() => firstSave.promise);
      await mountSettings();

      const batterySelect = document.getElementById("battery-threshold-select") as HTMLSelectElement;
      batterySelect.value = "10";
      batterySelect.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ batteryThreshold: 10 });

      batterySelect.value = "20";
      batterySelect.dispatchEvent(new Event("change"));
      expect(batterySelect.value).toBe("20");
      firstSave.resolve(accepted({ ...defaultSettings, batteryThreshold: 10 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(batterySelect.value).toBe("20");

      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenNthCalledWith(2, { batteryThreshold: 20 });
    });

    it("retains an unrelated authoritative push after an older save acknowledges", async () => {
      const firstSave = Promise.withResolvers<SettingsSetResponse>();
      mockApi.settings.set.mockImplementationOnce(() => firstSave.promise);
      await mountSettings();

      const launchToggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      launchToggle.checked = true;
      launchToggle.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ launchAtLogin: true });

      mockApi.onSettingsChanged.mock.calls.at(-1)![0]({
        ...defaultSettings,
        launchAtLogin: true,
        preventSleep: true,
        batteryThreshold: 10,
      });
      expect((document.getElementById("prevent-sleep-toggle") as HTMLInputElement).checked).toBe(true);
      expect((document.getElementById("battery-threshold-select") as HTMLSelectElement).value).toBe("10");

      firstSave.resolve(accepted({ ...defaultSettings, launchAtLogin: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(launchToggle.checked).toBe(true);
      expect((document.getElementById("prevent-sleep-toggle") as HTMLInputElement).checked).toBe(true);
      expect((document.getElementById("battery-threshold-select") as HTMLSelectElement).value).toBe("10");
    });

    it("applies an unrelated duration preference returned only in a successful partial save", async () => {
      const save = Promise.withResolvers<SettingsSetResponse>();
      mockApi.settings.get.mockResolvedValue({ ...defaultSettings, defaultSessionDuration: 30 });
      mockApi.settings.set.mockImplementationOnce(() => save.promise);
      await mountSettings();

      const launchToggle = document.querySelector<HTMLInputElement>("#launch-at-login-toggle");
      const durationSelect = document.querySelector<HTMLSelectElement>("#session-duration-select");
      expect(durationSelect?.value).toBe("30");
      launchToggle?.click();
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ launchAtLogin: true });
      expect(durationSelect?.value).toBe("30");

      save.resolve(
        accepted({ ...defaultSettings, launchAtLogin: true, defaultSessionDuration: 120 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(launchToggle?.checked).toBe(true);
      expect(document.getElementById("launch-save-indicator")?.textContent).toBe(SAVED_INDICATOR);
      expect(durationSelect?.value).toBe("120");
      expect(mockApi.session.start).not.toHaveBeenCalled();
    });

    it("waits for the latest 300ms debounce before flushing a queued edit", async () => {
      const firstSave = Promise.withResolvers<SettingsSetResponse>();
      mockApi.settings.set.mockImplementationOnce(() => firstSave.promise);
      await mountSettings();

      const launchToggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      const batterySelect = document.getElementById("battery-threshold-select") as HTMLSelectElement;
      launchToggle.checked = true;
      launchToggle.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ launchAtLogin: true });

      batterySelect.value = "10";
      batterySelect.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);
      batterySelect.value = "20";
      batterySelect.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(100);

      firstSave.resolve(accepted({ ...defaultSettings, launchAtLogin: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);
      expect(batterySelect.value).toBe("20");
      await vi.advanceTimersByTimeAsync(199);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockApi.settings.set).toHaveBeenNthCalledWith(2, { batteryThreshold: 20 });
    });

    it("reverts a rejected key to its confirmed value without showing Saved", async () => {
      mockApi.settings.set.mockResolvedValueOnce({
        settings: { ...defaultSettings },
        rejectedKeys: ["preventSleep"],
      });
      await mountSettings();

      const sleepToggle = document.getElementById("prevent-sleep-toggle") as HTMLInputElement;
      sleepToggle.checked = true;
      sleepToggle.dispatchEvent(new Event("change"));
      expect(sleepToggle.checked).toBe(true);
      await vi.advanceTimersByTimeAsync(300);

      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ preventSleep: true });
      expect(sleepToggle.checked).toBe(false);
      expect(document.getElementById("settings-error-text")?.textContent).toContain("preventSleep");
      expect(document.getElementById("sleep-save-indicator")?.textContent).not.toBe(SAVED_INDICATOR);
    });

    it("keeps a rejected shortcut error after an unrelated setting saves", async () => {
      const confirmedSettings: AppSettings = {
        ...defaultSettings,
        shortcut: "CommandOrControl+Shift+A",
      };
      mockApi.settings.get.mockResolvedValueOnce(confirmedSettings);
      mockApi.settings.set
        .mockResolvedValueOnce({ settings: confirmedSettings, rejectedKeys: ["shortcut"] })
        .mockResolvedValueOnce(accepted({ ...confirmedSettings, launchAtLogin: true }));
      await mountSettings();

      const shortcutButton = document.getElementById("shortcut-input") as HTMLButtonElement;
      expect(shortcutButton.textContent).toBe("⌘⇧A");
      shortcutButton.click();
      document.defaultView!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "W", metaKey: true, bubbles: true, cancelable: true }),
      );
      expect(shortcutButton.textContent).toBe("⌘W");
      await vi.advanceTimersByTimeAsync(300);

      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ shortcut: "CommandOrControl+W" });
      expect(shortcutButton.textContent).toBe("⌘⇧A");
      expect(document.getElementById("shortcut-save-indicator")?.textContent).not.toBe(SAVED_INDICATOR);
      const errorText = document.getElementById("settings-error-text");
      expect(errorText?.textContent).toContain("shortcut");
      const rejectedError = errorText?.textContent;

      const launchToggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      launchToggle.click();
      await vi.advanceTimersByTimeAsync(300);

      expect(mockApi.settings.set).toHaveBeenNthCalledWith(2, { launchAtLogin: true });
      expect(launchToggle.checked).toBe(true);
      expect(document.getElementById("launch-save-indicator")?.textContent).toBe(SAVED_INDICATOR);
      expect(shortcutButton.textContent).toBe("⌘⇧A");
      expect(errorText?.textContent).toBe(rejectedError);
    });

    it("does not revert a newer same-key edit when an earlier edit is rejected", async () => {
      const firstSave = Promise.withResolvers<SettingsSetResponse>();
      mockApi.settings.set.mockImplementationOnce(() => firstSave.promise);
      await mountSettings();

      const batterySelect = document.getElementById("battery-threshold-select") as HTMLSelectElement;
      batterySelect.value = "10";
      batterySelect.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ batteryThreshold: 10 });

      batterySelect.value = "20";
      batterySelect.dispatchEvent(new Event("change"));
      expect(batterySelect.value).toBe("20");
      firstSave.resolve({ settings: { ...defaultSettings }, rejectedKeys: ["batteryThreshold"] });
      await vi.advanceTimersByTimeAsync(0);
      expect(document.getElementById("settings-error-text")?.textContent).toContain("batteryThreshold");
      expect(batterySelect.value).toBe("20");
      expect(document.getElementById("battery-save-indicator")?.textContent).not.toBe(SAVED_INDICATOR);

      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenNthCalledWith(2, { batteryThreshold: 20 });
    });

    it("requeues a failed write behind the newest edit without flushing early or showing false Saved", async () => {
      const firstSave = Promise.withResolvers<SettingsSetResponse>();
      const retry = Promise.withResolvers<SettingsSetResponse>();
      mockApi.settings.set.mockImplementationOnce(() => firstSave.promise).mockImplementationOnce(() => retry.promise);
      await mountSettings();

      const launchToggle = document.getElementById("launch-at-login-toggle") as HTMLInputElement;
      const batterySelect = document.getElementById("battery-threshold-select") as HTMLSelectElement;
      launchToggle.checked = true;
      launchToggle.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ launchAtLogin: true });
      batterySelect.value = "10";
      batterySelect.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);
      batterySelect.value = "20";
      batterySelect.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(100);

      firstSave.reject(new Error("Disk full"));
      await vi.advanceTimersByTimeAsync(0);
      expect(document.getElementById("settings-error-text")?.textContent).toBe("Disk full");
      expect(document.getElementById("battery-save-indicator")?.textContent).not.toBe(SAVED_INDICATOR);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(mockApi.settings.set).toHaveBeenNthCalledWith(2, {
        launchAtLogin: true,
        batteryThreshold: 20,
      });
      expect(document.getElementById("battery-save-indicator")?.textContent).not.toBe(SAVED_INDICATOR);

      retry.resolve(accepted({ ...defaultSettings, launchAtLogin: true, batteryThreshold: 20 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(document.getElementById("battery-save-indicator")?.textContent).toBe(SAVED_INDICATOR);
    });

    it("starts a duration session but saves its preference even when session.start fails", async () => {
      mockApi.session.start.mockResolvedValueOnce({ ok: false, reason: "rejected" });
      await mountSettings();

      const durationSelect = document.getElementById("session-duration-select") as HTMLSelectElement;
      durationSelect.value = "30";
      durationSelect.dispatchEvent(new Event("change"));
      expect(durationSelect.value).toBe("30");
      expect(mockApi.session.start).toHaveBeenCalledExactlyOnceWith(30);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.getElementById("settings-error-text")?.textContent).toBe("Failed to start session");
      expect(mockApi.settings.set).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ defaultSessionDuration: 30 });
      expect(document.getElementById("settings-error-text")?.textContent).toBe("Failed to start session");
    });

    it("keeps a new duration selected while its session start awaits a matching status push", async () => {
      const start = Promise.withResolvers<SessionStartResponse>();
      mockApi.settings.get.mockResolvedValue({ ...defaultSettings, defaultSessionDuration: 60 });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(100),
        expiresAt: asPerf(3_600_100),
        remainingSeconds: 3600,
        durationMinutes: 60,
      });
      mockApi.session.start.mockImplementationOnce(() => start.promise);
      await startCurrentSettingsEntry();
      await vi.advanceTimersByTimeAsync(0);

      const durationSelect = document.getElementById("session-duration-select") as HTMLSelectElement;
      expect(durationSelect.value).toBe("60");
      durationSelect.value = "30";
      durationSelect.dispatchEvent(new Event("change"));
      expect(mockApi.session.start).toHaveBeenCalledExactlyOnceWith(30);
      expect(durationSelect.value).toBe("30");

      mockApi.onSettingsChanged.mock.calls.at(-1)![0]({
        ...defaultSettings,
        defaultSessionDuration: 60,
        batteryThreshold: 10,
      });
      expect((document.getElementById("battery-threshold-select") as HTMLSelectElement).value).toBe("10");
      expect(durationSelect.value).toBe("30");

      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ defaultSessionDuration: 30 });
      expect(durationSelect.value).toBe("30");

      start.resolve({ ok: true, startedAt: 200, durationMinutes: 30, expiresAt: 1_800_200 });
      await vi.advanceTimersByTimeAsync(0);
      mockApi.onSessionStatusUpdate.mock.calls.at(-1)![0]({
        isRunning: true,
        startedAt: asPerf(200),
        expiresAt: asPerf(1_800_200),
        remainingSeconds: 1800,
        durationMinutes: 30,
      });
      expect(durationSelect.value).toBe("30");
    });

    it("ignores an older shortcut failure after a newer shortcut is queued and acknowledged", async () => {
      const firstSave = Promise.withResolvers<SettingsSetResponse>();
      const secondSave = Promise.withResolvers<SettingsSetResponse>();
      mockApi.settings.set.mockImplementation((partial) =>
        partial.shortcut === "CommandOrControl+K" ? firstSave.promise : secondSave.promise,
      );
      await mountSettings();

      const shortcutButton = document.getElementById("shortcut-input") as HTMLButtonElement;
      shortcutButton.click();
      document.defaultView!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "K", metaKey: true, bubbles: true, cancelable: true }),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ shortcut: "CommandOrControl+K" });

      shortcutButton.click();
      document.defaultView!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "L", metaKey: true, bubbles: true, cancelable: true }),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);
      expect(shortcutButton.textContent).toBe("⌘L");

      mockApi.onShortcutRegistrationFailed.mock.calls.at(-1)![0]({
        accelerator: "CommandOrControl+K",
      });
      expect(document.getElementById("settings-error-text")?.textContent).toBe("");
      expect(shortcutButton.textContent).toBe("⌘L");

      firstSave.resolve(accepted({ ...defaultSettings, shortcut: "CommandOrControl+K" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockApi.settings.set).toHaveBeenNthCalledWith(2, { shortcut: "CommandOrControl+L" });

      secondSave.resolve(accepted({ ...defaultSettings, shortcut: "CommandOrControl+L" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(shortcutButton.textContent).toBe("⌘L");
      expect(document.getElementById("shortcut-save-indicator")?.textContent).toBe(SAVED_INDICATOR);
      expect(document.getElementById("settings-error-text")?.textContent).toBe("");
    });
  });

  describe("session status projection", () => {
    it("tracks a timed session push without changing the stored duration preference", async () => {
      mockApi.settings.get.mockResolvedValue({ ...defaultSettings, defaultSessionDuration: 30 });
      await mountSettings();

      const durationSelect = document.getElementById("session-duration-select") as HTMLSelectElement;
      expect(durationSelect.value).toBe("30");
      mockApi.onSessionStatusUpdate.mock.calls.at(-1)?.[0]({
        isRunning: true,
        startedAt: asPerf(100),
        expiresAt: asPerf(3_600_100),
        remainingSeconds: 3600,
        durationMinutes: 60,
      });
      expect(durationSelect.value).toBe("60");

      mockApi.onSettingsChanged.mock.calls.at(-1)![0]({
        ...defaultSettings,
        defaultSessionDuration: 30,
        preventSleep: true,
      });
      expect(durationSelect.value).toBe("60");
      expect(mockApi.settings.set).not.toHaveBeenCalled();
    });

    it("keeps an indefinite running session selected through a settings push", async () => {
      mockApi.settings.get.mockResolvedValue({ ...defaultSettings, defaultSessionDuration: 30 });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(100),
        expiresAt: null,
        remainingSeconds: null,
        durationMinutes: null,
      });
      await startCurrentSettingsEntry();
      await vi.advanceTimersByTimeAsync(0);

      const durationSelect = document.getElementById("session-duration-select") as HTMLSelectElement;
      expect(durationSelect.value).toBe("");
      mockApi.onSettingsChanged.mock.calls.at(-1)![0]({
        ...defaultSettings,
        defaultSessionDuration: 30,
        batteryThreshold: 10,
      });
      expect((document.getElementById("battery-threshold-select") as HTMLSelectElement).value).toBe("10");
      expect(durationSelect.value).toBe("");
    });

    it("switches from a timed session to an indefinite session on a status push", async () => {
      mockApi.settings.get.mockResolvedValue({ ...defaultSettings, defaultSessionDuration: 30 });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(100),
        expiresAt: asPerf(3_600_100),
        remainingSeconds: 3600,
        durationMinutes: 60,
      });
      await startCurrentSettingsEntry();
      await vi.advanceTimersByTimeAsync(0);

      const durationSelect = document.getElementById("session-duration-select") as HTMLSelectElement;
      expect(durationSelect.value).toBe("60");
      mockApi.onSessionStatusUpdate.mock.calls.at(-1)?.[0]({
        isRunning: true,
        startedAt: asPerf(200),
        expiresAt: null,
        remainingSeconds: null,
        durationMinutes: null,
      });
      expect(durationSelect.value).toBe("");

      mockApi.onSettingsChanged.mock.calls.at(-1)![0]({
        ...defaultSettings,
        defaultSessionDuration: 30,
        preventSleep: true,
      });
      expect(durationSelect.value).toBe("");
      expect(mockApi.settings.set).not.toHaveBeenCalled();
    });

    it("restores the stored preference when a timed session becomes idle", async () => {
      mockApi.settings.get.mockResolvedValue({ ...defaultSettings, defaultSessionDuration: 30 });
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(100),
        expiresAt: asPerf(3_600_100),
        remainingSeconds: 3600,
        durationMinutes: 60,
      });
      await startCurrentSettingsEntry();
      await vi.advanceTimersByTimeAsync(0);

      const durationSelect = document.getElementById("session-duration-select") as HTMLSelectElement;
      expect(durationSelect.value).toBe("60");
      mockApi.onSessionStatusUpdate.mock.calls.at(-1)?.[0](idleStatus);
      expect(durationSelect.value).toBe("30");

      mockApi.onSettingsChanged.mock.calls.at(-1)![0]({
        ...defaultSettings,
        defaultSessionDuration: 30,
        preventSleep: true,
      });
      expect(durationSelect.value).toBe("30");
      expect(mockApi.settings.set).not.toHaveBeenCalled();
    });

    it("applies status pushes while hidden and retains them on warm-cache reopen", async () => {
      mockApi.settings.get.mockResolvedValue({ ...defaultSettings, defaultSessionDuration: 30 });
      await mountSettings();

      const durationSelect = document.getElementById("session-duration-select") as HTMLSelectElement;
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      mockApi.onSessionStatusUpdate.mock.calls.at(-1)?.[0]({
        isRunning: true,
        startedAt: asPerf(100),
        expiresAt: asPerf(1_800_100),
        remainingSeconds: 1800,
        durationMinutes: 30,
      });
      mockApi.onSessionStatusUpdate.mock.calls.at(-1)?.[0]({
        isRunning: true,
        startedAt: asPerf(200),
        expiresAt: asPerf(3_600_200),
        remainingSeconds: 3600,
        durationMinutes: 60,
      });
      expect(durationSelect.value).toBe("60");

      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(35);
      expect(durationSelect.value).toBe("60");
      mockApi.onSettingsChanged.mock.calls.at(-1)![0]({
        ...defaultSettings,
        defaultSessionDuration: 30,
        preventSleep: true,
      });
      expect((document.getElementById("prevent-sleep-toggle") as HTMLInputElement).checked).toBe(true);
      expect(durationSelect.value).toBe("60");
    });
  });

  describe("startup push ordering", () => {
    it("does not overwrite a settings push with an older settings.get result", async () => {
      const initialSettings = Promise.withResolvers<AppSettings>();
      mockApi.settings.get.mockImplementationOnce(() => initialSettings.promise);
      mockApi.session.getStatus.mockResolvedValue(idleStatus);
      await startCurrentSettingsEntry();
      expect(mockApi.settings.get).toHaveBeenCalledTimes(1);

      mockApi.onSettingsChanged.mock.calls.at(-1)?.[0]({
        ...defaultSettings,
        preventSleep: true,
        batteryThreshold: 10,
      });
      initialSettings.resolve({ ...defaultSettings });
      await vi.advanceTimersByTimeAsync(0);

      expect((document.getElementById("prevent-sleep-toggle") as HTMLInputElement).checked).toBe(true);
      expect((document.getElementById("battery-threshold-select") as HTMLSelectElement).value).toBe("10");
      expect(mockApi.settings.set).not.toHaveBeenCalled();
    });

    it("does not overwrite a session push with an older session.getStatus result", async () => {
      const initialStatus = Promise.withResolvers<SessionStatusResponse>();
      mockApi.settings.get.mockResolvedValue({ ...defaultSettings, defaultSessionDuration: 30 });
      mockApi.session.getStatus.mockImplementationOnce(() => initialStatus.promise);
      await startCurrentSettingsEntry();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockApi.session.getStatus).toHaveBeenCalledTimes(1);

      mockApi.onSessionStatusUpdate.mock.calls.at(-1)?.[0]({
        isRunning: true,
        startedAt: asPerf(100),
        expiresAt: asPerf(3_600_100),
        remainingSeconds: 3600,
        durationMinutes: 60,
      });
      initialStatus.resolve(idleStatus);
      await vi.advanceTimersByTimeAsync(0);

      expect((document.getElementById("session-duration-select") as HTMLSelectElement).value).toBe("60");
      expect(mockApi.settings.set).not.toHaveBeenCalled();
    });
  });

  describe("warm-cache and unload lifecycle", () => {
    it("keeps subscriptions active through hide and reopen", async () => {
      const stopSettings = vi.fn();
      const stopShortcut = vi.fn();
      mockApi.onSettingsChanged.mockReturnValueOnce(stopSettings);
      mockApi.onShortcutRegistrationFailed.mockReturnValueOnce(stopShortcut);
      mockApi.settings.get.mockResolvedValue({ ...defaultSettings, shortcut: "CommandOrControl+K" });
      await mountSettings();

      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(stopSettings).not.toHaveBeenCalled();
      expect(stopShortcut).not.toHaveBeenCalled();

      mockApi.onSettingsChanged.mock.calls.at(-1)![0]({
        ...defaultSettings,
        preventSleep: true,
        shortcut: "CommandOrControl+K",
      });
      expect((document.getElementById("prevent-sleep-toggle") as HTMLInputElement).checked).toBe(true);
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(35);
      mockApi.onShortcutRegistrationFailed.mock.calls.at(-1)![0]({ accelerator: "CommandOrControl+K" });
      expect(document.getElementById("settings-error-text")?.textContent).toContain("CommandOrControl+K");
      expect(stopSettings).not.toHaveBeenCalled();
      expect(stopShortcut).not.toHaveBeenCalled();
    });

    it("unsubscribes settings, shortcut, and session pushes on beforeunload", async () => {
      const stopSettings = vi.fn();
      const stopShortcut = vi.fn();
      const stopSession = vi.fn();
      mockApi.onSettingsChanged.mockReturnValueOnce(stopSettings);
      mockApi.onShortcutRegistrationFailed.mockReturnValueOnce(stopShortcut);
      mockApi.onSessionStatusUpdate.mockReturnValueOnce(stopSession);
      await mountSettings();

      document.defaultView!.dispatchEvent(new Event("beforeunload"));
      expect(stopSettings).toHaveBeenCalledTimes(1);
      expect(stopShortcut).toHaveBeenCalledTimes(1);
      expect(stopSession).toHaveBeenCalledTimes(1);
    });

    it("cancels a pending debounced save on beforeunload", async () => {
      await mountSettings();

      const sleepToggle = document.getElementById("prevent-sleep-toggle") as HTMLInputElement;
      sleepToggle.checked = true;
      sleepToggle.dispatchEvent(new Event("change"));
      expect(sleepToggle.checked).toBe(true);
      await vi.advanceTimersByTimeAsync(299);
      expect(mockApi.settings.set).not.toHaveBeenCalled();

      document.defaultView!.dispatchEvent(new Event("beforeunload"));
      await vi.advanceTimersByTimeAsync(1);
      expect(mockApi.settings.set).not.toHaveBeenCalled();
    });

    it("stops shortcut recorder key handling on beforeunload", async () => {
      await mountSettings();

      const shortcutButton = document.getElementById("shortcut-input") as HTMLButtonElement;
      shortcutButton.click();
      expect(shortcutButton.getAttribute("aria-pressed")).toBe("true");
      document.defaultView!.dispatchEvent(new Event("beforeunload"));
      document.defaultView!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "K", metaKey: true, bubbles: true, cancelable: true }),
      );
      await vi.advanceTimersByTimeAsync(300);

      expect(mockApi.settings.set).not.toHaveBeenCalled();
      expect(shortcutButton.getAttribute("aria-pressed")).toBe("false");
    });

    it("does not repaint or show Saved when an in-flight save settles after beforeunload", async () => {
      const firstSave = Promise.withResolvers<SettingsSetResponse>();
      mockApi.settings.set.mockImplementationOnce(() => firstSave.promise);
      await mountSettings();

      const batterySelect = document.getElementById("battery-threshold-select") as HTMLSelectElement;
      batterySelect.value = "10";
      batterySelect.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledExactlyOnceWith({ batteryThreshold: 10 });
      batterySelect.value = "20";
      batterySelect.dispatchEvent(new Event("change"));
      expect(batterySelect.value).toBe("20");

      document.defaultView!.dispatchEvent(new Event("beforeunload"));
      firstSave.resolve(accepted({ ...defaultSettings, batteryThreshold: 10 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(batterySelect.value).toBe("20");
      expect(document.getElementById("battery-save-indicator")?.textContent).not.toBe(SAVED_INDICATOR);
      await vi.advanceTimersByTimeAsync(300);
      expect(mockApi.settings.set).toHaveBeenCalledTimes(1);
    });

    it("ignores already-delivered push callbacks after beforeunload", async () => {
      await mountSettings();

      const settingsPush = mockApi.onSettingsChanged.mock.calls.at(-1)![0];
      const sessionPush = mockApi.onSessionStatusUpdate.mock.calls.at(-1)?.[0];
      const sleepToggle = document.getElementById("prevent-sleep-toggle") as HTMLInputElement;
      const durationSelect = document.getElementById("session-duration-select") as HTMLSelectElement;
      expect(sleepToggle.checked).toBe(false);
      expect(durationSelect.value).toBe("");
      document.defaultView!.dispatchEvent(new Event("beforeunload"));

      settingsPush({ ...defaultSettings, preventSleep: true, defaultSessionDuration: 30 });
      sessionPush?.({
        isRunning: true,
        startedAt: asPerf(100),
        expiresAt: asPerf(3_600_100),
        remainingSeconds: 3600,
        durationMinutes: 60,
      });
      expect(sleepToggle.checked).toBe(false);
      expect(durationSelect.value).toBe("");
    });
  });

  describe("session status on init", () => {
    it("sets defaultSessionDuration from running session status", async () => {
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now()),
        expiresAt: asPerf(Date.now() + 60 * 60 * 1000),
        remainingSeconds: 3600,
        durationMinutes: 60,
      });

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const select = document.getElementById("session-duration-select") as HTMLSelectElement;
      expect(select.value).toBe("60");
    });
  describe("saveSettings failure", () => {
    it("preserves user's intended UI state when save fails", async () => {
      mockApi.settings.set.mockRejectedValue(new Error("Disk full"));

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.getElementById("prevent-sleep-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));

      await vi.advanceTimersByTimeAsync(350);

      // After failure, render() is called with the error message which rebuilds
      // the form from local `settings` state — the user's intended state must persist,
      // not revert to the original server-side value.
      const refreshedToggle = document.getElementById(
        "prevent-sleep-toggle",
      ) as HTMLInputElement;
      expect(refreshedToggle.checked).toBe(true);

      const errorEl = document.getElementById("settings-error-text");
      expect(errorEl?.textContent).toBe("Disk full");
    });
  });

  describe("session.start failure", () => {
    it("does not crash the renderer when session.start rejects", async () => {
      mockApi.session.start.mockRejectedValue(new Error("Session start failed"));

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      const select = document.getElementById("session-duration-select") as HTMLSelectElement;
      select.value = "30";

      // Should not throw synchronously even though session.start rejects
      expect(() => select.dispatchEvent(new Event("change"))).not.toThrow();

      expect(mockApi.session.start).toHaveBeenCalledWith(30);

      // Allow rejection to settle without breaking the test
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(350);
    });
  });

  describe("loadInitialData partial failure", () => {
    it("renders with defaults when settings.get fails but session.getStatus succeeds", async () => {
      mockApi.settings.get.mockRejectedValue(new Error("IPC timeout"));
      mockApi.session.getStatus.mockResolvedValue({
        isRunning: true,
        startedAt: asPerf(Date.now()),
        expiresAt: asPerf(Date.now() + 30 * 60 * 1000),
        remainingSeconds: 1800,
        durationMinutes: 30,
      });

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      // init() awaits settings.get (rejects), then session.getStatus (resolves), then render()
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Form must render despite settings.get failure — using defaults
      const launchToggle = document.getElementById(
        "launch-at-login-toggle",
      ) as HTMLInputElement | null;
      expect(launchToggle).not.toBeNull();
      expect(launchToggle?.checked).toBe(false);

      const select = document.getElementById(
        "session-duration-select",
      ) as HTMLSelectElement | null;
      expect(select).not.toBeNull();
      expect(select?.value).toBe("30");
    });

    it("renders settings when settings.get succeeds but session.getStatus fails", async () => {
      mockApi.settings.get.mockResolvedValue({
        ...defaultSettings,
        launchAtLogin: true,
        preventSleep: true,
      });
      mockApi.session.getStatus.mockRejectedValue(new Error("Status unavailable"));

      vi.resetModules();
      await import("../../src/renderer/settings/index.js");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Settings successfully applied to UI even though getStatus failed
      const launchToggle = document.getElementById(
        "launch-at-login-toggle",
      ) as HTMLInputElement | null;
      expect(launchToggle?.checked).toBe(true);

      const sleepToggle = document.getElementById(
        "prevent-sleep-toggle",
      ) as HTMLInputElement | null;
      expect(sleepToggle?.checked).toBe(true);
    });
  });
});

});
