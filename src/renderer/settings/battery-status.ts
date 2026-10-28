import type { BatteryMonitorStatus, BatterySample } from "../../shared/types.js";
import {
  BATTERY_STATUS_AC_POWER,
  BATTERY_STATUS_AWAITING_SAMPLE,
  BATTERY_STATUS_CURRENT_PREFIX,
  BATTERY_STATUS_DISABLED,
  BATTERY_STATUS_HISTORY_PREFIX,
  BATTERY_STATUS_INACTIVE,
  BATTERY_STATUS_LOADING,
  BATTERY_STATUS_NO_HISTORY,
  BATTERY_STATUS_QUERY_FAILED,
  BATTERY_STATUS_READING,
  BATTERY_STATUS_UNAVAILABLE,
} from "./constants.js";

function describeStatus(status: BatteryMonitorStatus): string {
  switch (status.state) {
    case "disabled": return BATTERY_STATUS_DISABLED;
    case "inactive": return BATTERY_STATUS_INACTIVE;
    case "ac-power": return BATTERY_STATUS_AC_POWER;
    case "reading": return BATTERY_STATUS_READING;
    case "sample": return BATTERY_STATUS_CURRENT_PREFIX;
    case "unavailable":
      return status.reason === "awaiting-first-sample"
        ? BATTERY_STATUS_AWAITING_SAMPLE : BATTERY_STATUS_UNAVAILABLE;
  }
}

function formatSample(sample: BatterySample): string {
  const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(sample.percent);
  const timestamp = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "short",
  }).format(sample.sampledAt);
  return `${percent}% · ${timestamp}`;
}

export function createBatteryStatusView(): { paint: () => void; dispose: () => void } {
  let status: BatteryMonitorStatus | null = null;
  let revision = 0;
  let disposed = false;
  let queryFailed = false;
  const paint = (): void => {
    if (disposed) return;
    const state = document.getElementById("battery-monitor-status");
    const history = document.getElementById("battery-monitor-history");
    if (state) {
      state.textContent = status === null
        ? queryFailed ? BATTERY_STATUS_QUERY_FAILED : BATTERY_STATUS_LOADING
        : describeStatus(status);
    }
    if (history) {
      history.textContent = status === null ? "" : status.state === "sample"
        ? formatSample(status.current)
        : status.lastSample === null ? BATTERY_STATUS_NO_HISTORY
          : `${BATTERY_STATUS_HISTORY_PREFIX}: ${formatSample(status.lastSample)}`;
    }
  };
  const accept = (next: BatteryMonitorStatus): void => {
    status = globalThis.structuredClone(next);
    paint();
  };
  const queryRevision = revision;
  const unsubscribe = window.api.battery.onStatusChange((next) => {
    if (disposed) return;
    revision += 1;
    accept(next);
  });
  void window.api.battery.getStatus().then((next) => {
    if (!disposed && revision === queryRevision) accept(next);
  }).catch(() => {
    if (disposed || revision !== queryRevision) return;
    queryFailed = true;
    paint();
  });
  return {
    paint,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
