/**
 * Payload + channel names for the aurora utility alert dialog
 * (Check for Updates and other main-owned message dialogs).
 * Private to the utility-dialog preload — not part of the public IPC_CHANNELS budget.
 *
 * Presentation identity: the warm-cached window outlives individual requests, so
 * main stamps every presentation with a `presentationId` (monotonic, main-owned).
 * Renderer replies carry it back; main ignores replies for any presentation that
 * is no longer active, and the renderer ignores pushes older than the latest it saw.
 */

/** Invoke `()`: renderer fetches the payload of the active presentation. */
export const UTILITY_DIALOG_GET_PAYLOAD = "utility-dialog:get-payload" as const;

/** Invoke `(presentationId, response)`: chosen button index; dismisses that presentation. */
export const UTILITY_DIALOG_RESPOND = "utility-dialog:respond" as const;

/** Invoke `(presentationId, height)`: content height so the window can shrink-wrap. */
export const UTILITY_DIALOG_SET_HEIGHT = "utility-dialog:set-height" as const;

/**
 * Main → renderer push of a {@link UtilityDialogApplyMessage}: present a payload on
 * warm-cache reopen (no full reload), or retire a dismissed presentation.
 * Not an invoke; preload listens with `onApply`.
 */
export const UTILITY_DIALOG_APPLY = "utility-dialog:apply" as const;

/** Options for a single-flight aurora utility dialog (1–3 buttons). */
export interface UtilityDialogOptions {
  /** Window title (macOS title bar / taskbar). */
  title: string;
  /** Primary bold message. */
  message: string;
  /** Secondary detail paragraph. */
  detail: string;
  /** Button labels left→right (secondary left, primary right for two-button HIG). */
  buttons: string[];
  /** Index of the default (focused / Return) button. */
  defaultId?: number;
  /** Index returned on Escape / window close. Defaults to 0. */
  cancelId?: number;
}

/** Snapshot handed to the utility-dialog renderer. */
export interface UtilityDialogPayload {
  /** Main-owned identity; later presentations always carry a larger id. */
  presentationId: number;
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

/** APPLY push: show a presentation, or retire one the user already dismissed. */
export type UtilityDialogApplyMessage =
  { kind: "present"; payload: UtilityDialogPayload } | { kind: "retire"; presentationId: number };

/** Result shape mirrors Electron MessageBoxReturnValue (minus checkbox). */
export interface UtilityDialogResult {
  response: number;
  checkboxChecked: false;
}
