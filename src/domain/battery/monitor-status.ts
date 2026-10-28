export type BatterySample = { readonly percent: number; readonly sampledAt: number };

export type BatteryMonitorStatus = { readonly lastSample: BatterySample | null } & (
  | { readonly state: "sample"; readonly reason: null; readonly current: BatterySample }
  | { readonly state: "disabled" | "inactive" | "ac-power" | "reading"; readonly reason: null; readonly current: null }
  | { readonly state: "unavailable"; readonly reason: "awaiting-first-sample" | "unavailable"; readonly current: null }
);
