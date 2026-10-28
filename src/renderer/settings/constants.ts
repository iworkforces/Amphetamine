/** UI strings for the settings window. */
export const WINDOW_TITLE = "Settings" as const;
export const HERO_NAME = "Amphetamine" as const;
export const HERO_DESCRIPTION = "Keep your Mac or PC awake" as const;

export const SECTION_GENERAL = "General" as const;
export const SECTION_SESSION = "Session" as const;
export const SECTION_POWER = "Power" as const;

export const LABEL_LAUNCH_AT_LOGIN = "Launch at Login" as const;
export const DESC_LAUNCH_AT_LOGIN = "Start Amphetamine when you log in" as const;

export const LABEL_PREVENT_SLEEP = "Prevent Sleep" as const;
export const DESC_PREVENT_SLEEP = "Keep this computer awake while enabled" as const;

export const LABEL_ACTIVATE_FOR = "Activate for" as const;
export const DESC_ACTIVATE_FOR = "How long to keep sleep prevention on" as const;

export const LABEL_BATTERY_THRESHOLD = "Battery Threshold" as const;
export const DESC_BATTERY_THRESHOLD =
  "Turn off sleep prevention when battery falls below this level" as const;

export const LABEL_SLEEP_BLOCK_MODE = "Sleep Block Mode" as const;
export const DESC_SLEEP_BLOCK_MODE =
  "Keep the display awake, or allow the display to sleep" as const;

export const LABEL_SHORTCUT = "Toggle Shortcut" as const;
export const DESC_SHORTCUT = "Global keyboard shortcut to toggle sleep prevention" as const;

export const OPTION_INDEFINITELY = "Indefinitely" as const;
export const OPTION_15_MIN = "15 Minutes" as const;
export const OPTION_30_MIN = "30 Minutes" as const;
export const OPTION_1_HOUR = "1 Hour" as const;
export const OPTION_2_HOURS = "2 Hours" as const;
export const OPTION_4_HOURS = "4 Hours" as const;

export const OPTION_BATTERY_OFF = "Off" as const;
export const OPTION_BATTERY_5 = "5%" as const;
export const OPTION_BATTERY_10 = "10%" as const;
export const OPTION_BATTERY_15 = "15%" as const;
export const OPTION_BATTERY_20 = "20%" as const;
export const OPTION_DISPLAY_SLEEP = "Prevent Display Sleep" as const;
export const OPTION_ALLOW_DISPLAY_SLEEP = "Allow Display Sleep" as const;

export const SHORTCUT_PLACEHOLDER = "Click to Record" as const;
export const SHORTCUT_RECORDING = "Press Keys…" as const;
export const SHORTCUT_ARIA_LABEL = "Toggle shortcut recorder" as const;
export const SAVED_INDICATOR = "Saved" as const;
export const SHORTCUT_REGISTRATION_FAILED_PREFIX = "Could not register shortcut" as const;

export const ERROR_INVALID_DURATION = "Invalid session duration" as const;
export const ERROR_START_SESSION = "Failed to start session" as const;
export const ERROR_SAVE_SETTINGS = "Failed to save settings" as const;
export const ERROR_REJECTED_KEYS_PREFIX = "Some settings could not be saved" as const;
export const LABEL_QUICK_SESSION_DURATIONS = "Quick Sessions" as const;
export const DESC_QUICK_SESSION_DURATIONS = "Minutes, separated by commas, in the order shown in the popover" as const;
export const QUICK_SESSION_DURATIONS_PLACEHOLDER = "15, 30, 60, 120" as const;
export const ERROR_QUICK_SESSION_DURATIONS = "Use 1 to 6 unique whole-minute durations from 1 to 1440." as const;
export const LABEL_BATTERY_MONITOR = "Battery Monitor" as const;
export const BATTERY_STATUS_LOADING = "Loading monitor status..." as const;
export const BATTERY_STATUS_QUERY_FAILED = "Monitor status unavailable" as const;
export const BATTERY_STATUS_DISABLED = "Disabled - battery threshold is off" as const;
export const BATTERY_STATUS_INACTIVE = "Inactive - sleep prevention is off" as const;
export const BATTERY_STATUS_AC_POWER = "AC power - battery monitoring is paused" as const;
export const BATTERY_STATUS_READING = "Reading battery level..." as const;
export const BATTERY_STATUS_AWAITING_SAMPLE = "Awaiting the first battery sample" as const;
export const BATTERY_STATUS_UNAVAILABLE = "Battery information is unavailable" as const;
export const BATTERY_STATUS_CURRENT_PREFIX = "Current sample" as const;
export const BATTERY_STATUS_HISTORY_PREFIX = "Last sample (not current)" as const;
export const BATTERY_STATUS_NO_HISTORY = "No accepted battery sample yet" as const;

export function sessionDurationOptionLabel(minutes: number): string {
  return `${minutes} Minutes`;
}
