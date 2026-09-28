import { powerMonitor } from "electron/main";
import type { BatterySensorPort } from "../../application/ports/battery-sensor.port.js";
import { getBatteryPercent } from "./battery-percent.js";

export function createBatterySensor(): BatterySensorPort {
  return {
    getPercent: getBatteryPercent,
    isOnBatteryPower: () => powerMonitor.isOnBatteryPower(),
    onPowerSourceChange: (handlers) => {
      powerMonitor.on("on-battery", handlers.onBattery);
      powerMonitor.on("on-ac", handlers.onAc);
      powerMonitor.on("resume", handlers.onResume);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        powerMonitor.off("on-battery", handlers.onBattery);
        powerMonitor.off("on-ac", handlers.onAc);
        powerMonitor.off("resume", handlers.onResume);
      };
    },
  };
}
