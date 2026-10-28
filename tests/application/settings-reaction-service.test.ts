import { describe, it, expect, vi } from "vitest";
import {
  createSettingsReactionService,
  RENDERER_VISIBLE_SETTINGS_KEYS,
} from "../../src/application/settings/settings-reaction-service.js";
import { DEFAULT_SETTINGS } from "../../src/domain/settings/app-settings.js";
import type { AppSettings } from "../../src/domain/settings/app-settings.js";

describe("createSettingsReactionService", () => {
  function build() {
    const recomputeSleepPrevention = vi.fn();
    const autoLaunch = { sync: vi.fn() };
    const reconfigureBattery = vi.fn();
    const registerShortcut = vi.fn();
    const reconcileSession = vi.fn();
    const publish = vi.fn();
    const service = createSettingsReactionService({
      recomputeSleepPrevention,
      autoLaunch,
      isPreventingSleep: () => false,
      getSessionActive: () => false,
      reconfigureBattery,
      registerShortcut,
      reconcileSession,
      notifier: { publish },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    return {
      service,
      recomputeSleepPrevention,
      autoLaunch,
      reconfigureBattery,
      registerShortcut,
      reconcileSession,
      publish,
    };
  }

  const base = { ...DEFAULT_SETTINGS };

  it("skips when settings are shallow-equal", () => {
    const { service, reconcileSession, publish } = build();
    service.handleChange(base, base);
    expect(reconcileSession).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not publish SETTINGS_CHANGED for launchAtLogin-only", () => {
    const { service, autoLaunch, publish } = build();
    const next: AppSettings = { ...base, launchAtLogin: true };
    service.handleChange(next, base);
    expect(autoLaunch.sync).toHaveBeenCalledWith(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes SETTINGS_CHANGED for renderer-visible keys", () => {
    const { service, publish } = build();
    const changes: Partial<AppSettings>[] = [
      { shortcut: "Cmd+Shift+Z" },
      { batteryThreshold: 20 },
      { preventSleep: true },
      { quickSessionDurations: [30, 15] },
    ];
    expect(changes.map((change) => Object.keys(change)[0]).sort()).toEqual(
      [...RENDERER_VISIBLE_SETTINGS_KEYS].sort(),
    );
    for (const change of changes) {
      publish.mockClear();
      const next = { ...base, ...change };
      service.handleChange(next, base);
      expect(publish).toHaveBeenCalledWith({ type: "settings-changed", settings: next });
    }
  });

  it("ignores equal copied presets and publishes a reordered list", () => {
    const { service, reconcileSession, publish } = build();
    service.handleChange({ ...base, quickSessionDurations: [15, 30, 60, 120] }, base);
    expect(reconcileSession).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const reordered = { ...base, quickSessionDurations: [30, 15, 60, 120] };
    service.handleChange(reordered, base);
    expect(reconcileSession).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledExactlyOnceWith({ type: "settings-changed", settings: reordered });
  });

  it("recomputes on preventSleep change without registering shortcut", () => {
    const { service, recomputeSleepPrevention, registerShortcut } = build();
    service.handleChange({ ...base, preventSleep: true }, base);
    expect(recomputeSleepPrevention).toHaveBeenCalledWith(true);
    expect(registerShortcut).not.toHaveBeenCalled();
  });

  it("recomputes sleepBlockMode only when idle gates fail (blocker/intent/session)", () => {
    const recomputeSleepPrevention = vi.fn();
    const service = createSettingsReactionService({
      recomputeSleepPrevention,
      autoLaunch: { sync: vi.fn() },
      isPreventingSleep: () => false,
      getSessionActive: () => false,
      reconfigureBattery: vi.fn(),
      registerShortcut: vi.fn(),
      reconcileSession: vi.fn(),
      notifier: { publish: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    service.handleChange(
      { ...base, sleepBlockMode: "prevent-app-suspension" },
      base,
    );
    expect(recomputeSleepPrevention).not.toHaveBeenCalled();

    const serviceActive = createSettingsReactionService({
      recomputeSleepPrevention,
      autoLaunch: { sync: vi.fn() },
      isPreventingSleep: () => true,
      getSessionActive: () => false,
      reconfigureBattery: vi.fn(),
      registerShortcut: vi.fn(),
      reconcileSession: vi.fn(),
      notifier: { publish: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    recomputeSleepPrevention.mockClear();
    serviceActive.handleChange(
      { ...base, sleepBlockMode: "prevent-app-suspension" },
      base,
    );
    expect(recomputeSleepPrevention).toHaveBeenCalledWith(false);
  });

  it("logs when a reaction throws", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = createSettingsReactionService({
      recomputeSleepPrevention: () => {
        throw new Error("boom");
      },
      autoLaunch: { sync: vi.fn() },
      isPreventingSleep: () => false,
      getSessionActive: () => false,
      reconfigureBattery: vi.fn(),
      registerShortcut: vi.fn(),
      reconcileSession: vi.fn(),
      notifier: { publish: vi.fn() },
      logger,
    });
    service.handleChange({ ...DEFAULT_SETTINGS, preventSleep: true }, DEFAULT_SETTINGS);
    expect(logger.error).toHaveBeenCalled();
  });
});
