/** Battery percent + AC/battery events. */
export interface BatterySensorPort {
  getPercent(): Promise<number | null>;
  isOnBatteryPower(): boolean;
  onPowerSourceChange(handlers: {
    onBattery: () => void;
    onAc: () => void;
    onResume: () => void;
  }): () => void;
}
