import { afterEach, describe, expect, it, vi } from "vitest";
import { createBatteryMonitor } from "../../src/main/battery-monitor.js";
import type { BatterySensorPort } from "../../src/application/ports/battery-sensor.port.js";

describe("cached battery monitor status", () => {
  afterEach(() => vi.useRealTimers());

  it("reports policy precedence, reading, sample and retained history without query reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let threshold = 0;
    let active = false;
    let battery = false;
    const pending = Promise.withResolvers<number | null>();
    const getPercent = vi.fn(() => pending.promise);
    let handlers: Parameters<BatterySensorPort["onPowerSourceChange"]>[0] | undefined;
    const publish = vi.fn();
    const monitor = createBatteryMonitor({
      sensor: { getPercent, isOnBatteryPower: () => battery, onPowerSourceChange: (next) => { handlers = next; return () => {}; } },
      getThreshold: () => threshold,
      isPreventingSleep: () => active,
      onAutoStop: vi.fn(),
      onStatusChange: publish,
    });
    await monitor.initBatteryMonitoring();
    expect(monitor.getStatus().state).toBe("disabled");
    threshold = 20;
    monitor.reconfigure();
    expect(monitor.getStatus().state).toBe("inactive");
    active = true;
    monitor.onPreventSleepChange(true);
    expect(monitor.getStatus().state).toBe("ac-power");
    battery = true;
    monitor.onPreventSleepChange(true);
    expect(monitor.getStatus()).toMatchObject({ state: "unavailable", reason: "awaiting-first-sample" });
    expect(getPercent).not.toHaveBeenCalled();
    handlers?.onBattery();
    expect(monitor.getStatus().state).toBe("reading");
    pending.resolve(80);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.getStatus()).toEqual({ state: "sample", reason: null, current: { percent: 80, sampledAt: 1000 }, lastSample: { percent: 80, sampledAt: 1000 } });
    battery = false;
    handlers?.onAc();
    expect(monitor.getStatus()).toEqual({ state: "ac-power", reason: null, current: null, lastSample: { percent: 80, sampledAt: 1000 } });
    monitor.cleanupBatteryMonitoring();
  });

  it.each([null, NaN, Infinity, -1, 101])("rejects invalid sample %s without auto-stop", async (percent) => {
    vi.useFakeTimers();
    const autoStop = vi.fn();
    const monitor = createBatteryMonitor({
      sensor: { getPercent: async () => percent, isOnBatteryPower: () => true, onPowerSourceChange: () => () => {} },
      getThreshold: () => 20, isPreventingSleep: () => true, onAutoStop: autoStop,
    });
    await monitor.initBatteryMonitoring();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.getStatus()).toEqual({ state: "unavailable", reason: "unavailable", current: null, lastSample: null });
    expect(autoStop).not.toHaveBeenCalled();
    monitor.cleanupBatteryMonitoring();
  });

  it("suppresses stale error and cleanup completions", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<number | null>();
    const publish = vi.fn();
    let active = true;
    const monitor = createBatteryMonitor({
      sensor: { getPercent: () => pending.promise, isOnBatteryPower: () => true, onPowerSourceChange: () => () => {} },
      getThreshold: () => 20, isPreventingSleep: () => active, onAutoStop: vi.fn(), onStatusChange: publish,
    });
    await monitor.initBatteryMonitoring();
    await vi.advanceTimersByTimeAsync(60_000);
    active = false;
    monitor.onPreventSleepChange(false);
    publish.mockClear();
    pending.reject(new Error("stale"));
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();
    expect(monitor.getStatus().state).toBe("inactive");
    monitor.cleanupBatteryMonitoring();
  });

  it("discards stale success and coalesces triggers into a fresh read", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<number | null>();
    const getPercent = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(70);
    const autoStop = vi.fn();
    let handlers: Parameters<BatterySensorPort["onPowerSourceChange"]>[0] | undefined;
    const monitor = createBatteryMonitor({
      sensor: { getPercent, isOnBatteryPower: () => true, onPowerSourceChange: (next) => { handlers = next; return () => {}; } },
      getThreshold: () => 20, isPreventingSleep: () => true, onAutoStop: autoStop,
    });
    await monitor.initBatteryMonitoring();
    handlers?.onBattery();
    handlers?.onResume();
    handlers?.onResume();
    pending.resolve(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(getPercent).toHaveBeenCalledTimes(2);
    expect(monitor.getStatus()).toMatchObject({ state: "sample", current: { percent: 70 }, lastSample: { percent: 70 } });
    expect(autoStop).not.toHaveBeenCalled();
    monitor.cleanupBatteryMonitoring();
  });
});
