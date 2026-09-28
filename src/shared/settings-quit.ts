export const SETTINGS_QUIT_DRAIN_REQUEST = "settings-quit:drain-request" as const;
export const SETTINGS_QUIT_DRAIN_ACK = "settings-quit:drain-ack" as const;

export interface SettingsQuitDrainRequest {
  readonly requestId: string;
}

export interface SettingsQuitDrainAck {
  readonly requestId: string;
  readonly status: "saved" | "failed";
}
