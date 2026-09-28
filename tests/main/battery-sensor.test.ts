import { beforeEach, describe, expect, it, vi } from "vitest";

const powerMonitor = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  isOnBatteryPower: vi.fn(() => false),
}));
const getBatteryPercent = vi.hoisted(() => vi.fn<() => Promise<number | null>>());

vi.mock("electron", () => ({ powerMonitor }));
vi.mock("../../src/main/platform/battery-percent.js", () => ({ getBatteryPercent }));

describe("battery sensor adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads current source and delegates percentage reads", async () => {
    const { createBatterySensor } = await import("../../src/main/platform/battery-sensor.js");
    const sensor = createBatterySensor();
    powerMonitor.isOnBatteryPower.mockReturnValue(true);
    getBatteryPercent.mockResolvedValue(42);

    expect(sensor.isOnBatteryPower()).toBe(true);
    expect(await sensor.getPercent()).toBe(42);
    expect(powerMonitor.isOnBatteryPower).toHaveBeenCalledTimes(1);
    expect(getBatteryPercent).toHaveBeenCalledTimes(1);
  });

  it("maps events without an initial event and unsubscribes identical listeners once", async () => {
    const { createBatterySensor } = await import("../../src/main/platform/battery-sensor.js");
    const callbacks = { onBattery: vi.fn(), onAc: vi.fn(), onResume: vi.fn() };
    powerMonitor.isOnBatteryPower.mockReturnValue(true);

    const unsubscribe = createBatterySensor().onPowerSourceChange(callbacks);

    expect(callbacks.onBattery).not.toHaveBeenCalled();
    expect(powerMonitor.on).toHaveBeenCalledTimes(3);
    expect(powerMonitor.on).toHaveBeenCalledWith("on-battery", callbacks.onBattery);
    expect(powerMonitor.on).toHaveBeenCalledWith("on-ac", callbacks.onAc);
    expect(powerMonitor.on).toHaveBeenCalledWith("resume", callbacks.onResume);
    for (const [event, listener] of powerMonitor.on.mock.calls) {
      listener();
      expect(powerMonitor.off).not.toHaveBeenCalled();
      const handler =
        event === "on-battery"
          ? callbacks.onBattery
          : event === "on-ac"
            ? callbacks.onAc
            : callbacks.onResume;
      expect(handler).toHaveBeenCalledTimes(1);
    }

    unsubscribe();
    unsubscribe();
    expect(powerMonitor.off.mock.calls).toEqual(powerMonitor.on.mock.calls);
  });
});
