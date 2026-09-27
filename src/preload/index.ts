import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { BENCHMARK_ENV_NAME } from "../shared/benchmark-types.js";
import { IPC_CHANNELS } from "../shared/types.js";
import {
  SETTINGS_QUIT_DRAIN_ACK,
  SETTINGS_QUIT_DRAIN_REQUEST,
  type SettingsQuitDrainAck,
  type SettingsQuitDrainRequest,
} from "../shared/settings-quit.js";
import type {
  AppSettings,
  IpcChannel,
  IpcChannelMap,
  IpcRequest,
  IpcResponse,
} from "../shared/types.js";

/**
 * Type-safe wrapper around `ipcRenderer.invoke`.
 *
 * Channels whose request type is `void` or `undefined` accept zero arguments;
 * all others require a single payload of the exact request type. The single
 * cast on the returned Promise is the boundary cast — Electron's typings for
 * `invoke` return `Promise<unknown>` and we narrow to the channel-specific
 * response type from `IpcChannelMap`.
 */
function invoke<K extends IpcChannel>(
  channel: K,
  ...args: IpcChannelMap[K]["request"] extends void | undefined ? [] : [IpcChannelMap[K]["request"]]
): Promise<IpcChannelMap[K]["response"]> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcChannelMap[K]["response"]>;
}

const api = {
  window: {
    setHeight: (height: IpcRequest<typeof IPC_CHANNELS.WINDOW_SET_HEIGHT>): void =>
      ipcRenderer.send(IPC_CHANNELS.WINDOW_SET_HEIGHT, height),
  },

  app: {
    getVersion: (): Promise<IpcResponse<typeof IPC_CHANNELS.APP_GET_VERSION>> =>
      invoke(IPC_CHANNELS.APP_GET_VERSION),
    getAbout: (): Promise<IpcResponse<typeof IPC_CHANNELS.APP_GET_ABOUT>> =>
      invoke(IPC_CHANNELS.APP_GET_ABOUT),
    quit: (): Promise<IpcResponse<typeof IPC_CHANNELS.APP_QUIT>> => invoke(IPC_CHANNELS.APP_QUIT),
  },

  settings: {
    get: (): Promise<IpcResponse<typeof IPC_CHANNELS.SETTINGS_GET>> =>
      invoke(IPC_CHANNELS.SETTINGS_GET),

    set: (
      partial: IpcRequest<typeof IPC_CHANNELS.SETTINGS_SET>,
    ): Promise<IpcResponse<typeof IPC_CHANNELS.SETTINGS_SET>> =>
      invoke(IPC_CHANNELS.SETTINGS_SET, partial),

    open: (): Promise<IpcResponse<typeof IPC_CHANNELS.SETTINGS_OPEN>> =>
      invoke(IPC_CHANNELS.SETTINGS_OPEN),

    onQuitDrain: (callback: (_request: SettingsQuitDrainRequest) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, request: SettingsQuitDrainRequest) => {
        callback(request);
      };
      ipcRenderer.on(SETTINGS_QUIT_DRAIN_REQUEST, listener);
      return () => ipcRenderer.removeListener(SETTINGS_QUIT_DRAIN_REQUEST, listener);
    },

    ackQuitDrain: (ack: SettingsQuitDrainAck): void =>
      ipcRenderer.send(SETTINGS_QUIT_DRAIN_ACK, ack),
  },

  session: {
    start: (
      durationMinutes: number | null,
    ): Promise<IpcResponse<typeof IPC_CHANNELS.SESSION_START>> =>
      invoke(IPC_CHANNELS.SESSION_START, { durationMinutes }),
    cancel: (): Promise<IpcResponse<typeof IPC_CHANNELS.SESSION_CANCEL>> =>
      invoke(IPC_CHANNELS.SESSION_CANCEL),
    getStatus: (): Promise<IpcResponse<typeof IPC_CHANNELS.SESSION_STATUS>> =>
      invoke(IPC_CHANNELS.SESSION_STATUS),
  },

  onSettingsChanged: (callback: (_settings: AppSettings) => void) => {
    const listener = (_event: IpcRendererEvent, settings: AppSettings) => {
      callback(settings);
    };
    ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, listener);
    };
  },

  onWindowHide: (callback: () => void): (() => void) => {
    const listener = (_event: IpcRendererEvent) => {
      callback();
    };
    ipcRenderer.on(IPC_CHANNELS.WINDOW_HIDE, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_HIDE, listener);
    };
  },

  onSessionStatusUpdate: (
    callback: (_data: IpcResponse<typeof IPC_CHANNELS.SESSION_STATUS_UPDATE>) => void,
  ) => {
    const listener = (
      _event: IpcRendererEvent,
      data: IpcResponse<typeof IPC_CHANNELS.SESSION_STATUS_UPDATE>,
    ) => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.SESSION_STATUS_UPDATE, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SESSION_STATUS_UPDATE, listener);
    };
  },

  onShortcutRegistrationFailed: (
    callback: (_data: IpcResponse<typeof IPC_CHANNELS.SHORTCUT_REGISTRATION_FAILED>) => void,
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      data: IpcResponse<typeof IPC_CHANNELS.SHORTCUT_REGISTRATION_FAILED>,
    ) => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.SHORTCUT_REGISTRATION_FAILED, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SHORTCUT_REGISTRATION_FAILED, listener);
    };
  },

  autoUpdater: {
    checkForUpdates: (): Promise<IpcResponse<typeof IPC_CHANNELS.AUTO_UPDATER_CHECK>> =>
      invoke(IPC_CHANNELS.AUTO_UPDATER_CHECK),
    onStatus: (callback: (_data: IpcResponse<typeof IPC_CHANNELS.AUTO_UPDATER_STATUS>) => void) => {
      const listener = (
        _event: IpcRendererEvent,
        data: IpcResponse<typeof IPC_CHANNELS.AUTO_UPDATER_STATUS>,
      ) => {
        callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.AUTO_UPDATER_STATUS, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.AUTO_UPDATER_STATUS, listener);
      };
    },
  },

  benchmark: {
    isEnabled: (): boolean => process.env[BENCHMARK_ENV_NAME] === "1",
  },

  /**
   * Host OS identity for renderer UI (shortcut labels, etc.).
   * Read-only snapshot of Node `process.platform` in the preload sandbox.
   */
  platform: {
    os: process.platform,
  },
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;

/**
 * Compile-time exhaustiveness check: every channel in `IPC_CHANNELS` must be
 * wired through `window.api`. `WiredChannels` lists all channel literals
 * explicitly — if a new channel is added to `IpcChannelMap` but not to this
 * union, `_ExhaustivenessCheck` resolves to a tuple that cannot be assigned
 * `true`, breaking the build.
 *
 * NOTE: Deriving `WiredChannels` automatically from `typeof api` is not
 * feasible because `IpcRequest<K>` and `IpcResponse<K>` evaluate eagerly —
 * the channel literal `K` does not survive in the resolved structural type.
 * The explicit union is intentional and correct.
 *
 * The `[_UnwiredChannels] extends [never]` tuple wrapper suppresses
 * distributive-conditional behavior over union members.
 */
type WiredChannels =
  | typeof IPC_CHANNELS.WINDOW_HIDE
  | typeof IPC_CHANNELS.WINDOW_SET_HEIGHT
  | typeof IPC_CHANNELS.APP_GET_VERSION
  | typeof IPC_CHANNELS.APP_GET_ABOUT
  | typeof IPC_CHANNELS.APP_QUIT
  | typeof IPC_CHANNELS.SETTINGS_GET
  | typeof IPC_CHANNELS.SETTINGS_SET
  | typeof IPC_CHANNELS.SETTINGS_OPEN
  | typeof IPC_CHANNELS.SETTINGS_CHANGED
  | typeof IPC_CHANNELS.SESSION_START
  | typeof IPC_CHANNELS.SESSION_CANCEL
  | typeof IPC_CHANNELS.SESSION_STATUS
  | typeof IPC_CHANNELS.SESSION_STATUS_UPDATE
  | typeof IPC_CHANNELS.AUTO_UPDATER_CHECK
  | typeof IPC_CHANNELS.AUTO_UPDATER_STATUS
  | typeof IPC_CHANNELS.SHORTCUT_REGISTRATION_FAILED;

type _UnwiredChannels = Exclude<IpcChannel, WiredChannels>;
type _ExhaustivenessCheck = [_UnwiredChannels] extends [never]
  ? true
  : ["unwired channels:", _UnwiredChannels];
const _check: _ExhaustivenessCheck = true;
void _check;
