/** UI status strings shown in the popover. */
export const STATUS_PREVENTING_SLEEP = "Preventing Sleep" as const;
export const STATUS_SLEEP_PREVENTION_OFF = "Sleep Prevention Off" as const;
export const STATUS_UNAVAILABLE = "Status unavailable" as const;
export const ERROR_SETTINGS_UNAVAILABLE = "Settings unavailable" as const;
export const ERROR_PREFERENCE_SAVE_FAILED = "Could not save Prevent Sleep" as const;

/** Primary control labels */
export const LABEL_PREVENT_SLEEP = "Prevent Sleep" as const;
export const LABEL_CANCEL_SESSION = "Cancel session" as const;
export const LABEL_SESSION_DURATION = "Start session" as const;
export const LABEL_INDEFINITE = "Indefinite" as const;
export const LABEL_EXTEND_SESSION = "Add 15 minutes" as const;
export const LABEL_EXTENDING_SESSION = "Adding time..." as const;
export const ERROR_EXTEND_SESSION = "Could not extend this session. Try again." as const;
export const ERROR_EXTEND_DURATION_LIMIT = "A session cannot exceed 24 hours." as const;
export const ERROR_EXTEND_SESSION_ENDED = "This timed session is no longer available." as const;

export function sessionChipLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export function sessionChipAccessibleLabel(minutes: number): string {
  return `Start a ${minutes}-minute session`;
}
