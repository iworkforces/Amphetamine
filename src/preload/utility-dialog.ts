/**
 * Minimal sandboxed preload for the aurora utility dialog window.
 * Private channels — not part of the public window.api surface.
 * Replies carry the main-owned `presentationId` they answer; main drops stale ones.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import {
  UTILITY_DIALOG_APPLY,
  UTILITY_DIALOG_GET_PAYLOAD,
  UTILITY_DIALOG_RESPOND,
  UTILITY_DIALOG_SET_HEIGHT,
  type UtilityDialogApplyMessage,
  type UtilityDialogPayload,
} from "../shared/utility-dialog.js";

const utilityDialogApi = {
  /** Payload of the active presentation (rejects while the shell is idle). */
  getPayload: (): Promise<UtilityDialogPayload> =>
    ipcRenderer.invoke(UTILITY_DIALOG_GET_PAYLOAD) as Promise<UtilityDialogPayload>,
  respond: (presentationId: number, response: number): Promise<void> =>
    ipcRenderer.invoke(UTILITY_DIALOG_RESPOND, presentationId, response) as Promise<void>,
  /** Report content height so the BrowserWindow can shrink-wrap. */
  setHeight: (presentationId: number, height: number): Promise<void> =>
    ipcRenderer.invoke(UTILITY_DIALOG_SET_HEIGHT, presentationId, height) as Promise<void>,
  /**
   * Warm-cache re-present or retirement pushed by main without reloading the page.
   * Returns an unsubscribe function.
   */
  onApply: (callback: (message: UtilityDialogApplyMessage) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, message: UtilityDialogApplyMessage): void => {
      callback(message);
    };
    ipcRenderer.on(UTILITY_DIALOG_APPLY, listener);
    return () => {
      ipcRenderer.removeListener(UTILITY_DIALOG_APPLY, listener);
    };
  },
  /** Host platform (optional body class for caption padding). */
  os: process.platform,
};

contextBridge.exposeInMainWorld("utilityDialogApi", utilityDialogApi);

export type UtilityDialogApi = typeof utilityDialogApi;
