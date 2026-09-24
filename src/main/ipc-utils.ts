import { ipcMain, app, type IpcMainEvent, type IpcMainInvokeEvent } from "electron/main";
import path from "node:path";
import { fileURLToPath } from "node:url";
import log from "electron-log";
import { type IpcChannelMap } from "../shared/types.js";
import { DEV_ORIGINS } from "./constants.js";

let _cachedAppPath: string | null = null;
let _allowedFilePaths: ReadonlySet<string> | null = null;
let _windowsAppPath = false;
function getAllowedFilePaths(): ReadonlySet<string> {
  if (_allowedFilePaths === null) {
    const appPath = app.getAppPath();
    _windowsAppPath = /^[A-Za-z]:[\\/]/.test(appPath);
    const pathForApp = _windowsAppPath ? path.win32 : path.posix;
    _cachedAppPath = pathForApp.resolve(appPath);
    _allowedFilePaths = new Set([
      pathForApp.join(_cachedAppPath, "lib", "renderer", "index.html").normalize("NFC"),
      pathForApp.join(_cachedAppPath, "lib", "renderer", "settings.html").normalize("NFC"),
      pathForApp.join(_cachedAppPath, "lib", "renderer", "about.html").normalize("NFC"),
    ]);
  }
  return _allowedFilePaths;
}
let _allowedOrigins: ReadonlySet<string> | null = null;
function getAllowedOrigins(): ReadonlySet<string> {
  if (_allowedOrigins === null) {
    _allowedOrigins = new Set(app.isPackaged ? [] : DEV_ORIGINS);
  }
  return _allowedOrigins;
}
/** Returns true if the sender's origin is the app's own renderer */
export function validateSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  // Reject child frames; main frame has parent === null. Tests may omit (undefined) — allow.
  // eslint-disable-next-line eqeqeq
  if (event.senderFrame?.parent != null) return false;
  const senderUrl = event.senderFrame?.url ?? "";
  const valid = validateSenderUrl(senderUrl);
  if (!valid) {
    log.warn("[ipc] Sender validation failed", { url: senderUrl });
  }
  return valid;
}
export function validateSenderUrl(senderUrl: string): boolean {
  try {
    const url = new URL(senderUrl);
    if (url.protocol === "http:") {
      const origins = getAllowedOrigins();
      return origins.has(url.origin) || origins.has(`${url.protocol}//${url.host}`);
    }
    // file:// origin check (packaged app) - exact path match within app bundle
    if (url.protocol === "file:") {
      if (url.host !== "") return false;
      const allowedPaths = getAllowedFilePaths();
      try {
        const urlPath = fileURLToPath(url, { windows: _windowsAppPath }).normalize("NFC");
        return allowedPaths.has(urlPath);
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    log.warn("[ipc] Invalid sender URL:", senderUrl);
    return false;
  }
}
/**
 * Type-safe IPC handler wrapper.
 * Ensures handler return type matches IpcChannelMap response type at compile time.
 */
export type IpcHandler<K extends keyof IpcChannelMap> = (
  _event: IpcMainInvokeEvent,
  _request: IpcChannelMap[K]["request"],
) => Promise<IpcChannelMap[K]["response"]> | IpcChannelMap[K]["response"];

export function typedHandle<K extends keyof IpcChannelMap>(channel: K, handler: IpcHandler<K>): void {
  ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1]);
}
