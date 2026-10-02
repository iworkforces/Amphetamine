import { describe, it, expect } from "vitest";
import { IPC_CHANNELS, PUSH_CHANNELS, type IpcChannelMap } from "../../src/shared/types.js";
import { SETTINGS_QUIT_DRAIN_ACK, SETTINGS_QUIT_DRAIN_REQUEST } from "../../src/shared/settings-quit.js";
import * as utilityDialog from "../../src/shared/utility-dialog.js";

describe("IPC channel budget contract", () => {
  it("has exactly 16 named channels", () => {
    expect(Object.keys(IPC_CHANNELS)).toHaveLength(16);
  });

  it("maps every channel in IpcChannelMap", () => {
    const mapKeys = Object.keys(IPC_CHANNELS) as (keyof typeof IPC_CHANNELS)[];
    for (const key of mapKeys) {
      const channel = IPC_CHANNELS[key];
      // Type-level map access: ensure each channel is a key of IpcChannelMap via assignability
      const _assert: keyof IpcChannelMap = channel;
      expect(typeof _assert).toBe("string");
    }
  });

  it("push channels are a subset of IPC_CHANNELS values", () => {
    const all = new Set(Object.values(IPC_CHANNELS));
    for (const push of PUSH_CHANNELS) {
      expect(all.has(push)).toBe(true);
    }
    expect(PUSH_CHANNELS).toHaveLength(5);
  });

  it("keeps quit lifecycle messages private and disjoint from public IPC and pushes", () => {
    const publicChannels = new Set<string>(Object.values(IPC_CHANNELS));
    for (const channel of [SETTINGS_QUIT_DRAIN_ACK, SETTINGS_QUIT_DRAIN_REQUEST]) {
      expect(publicChannels.has(channel)).toBe(false);
      expect(PUSH_CHANNELS).not.toContain(channel);
    }
  });

  it("keeps exactly four private utility-dialog channels outside the public budget", () => {
    const dialogChannels = Object.entries(utilityDialog)
      .filter(([name]) => name.startsWith("UTILITY_DIALOG_"))
      .map(([, channel]) => channel as string);
    expect(dialogChannels.sort()).toEqual([
      "utility-dialog:apply",
      "utility-dialog:get-payload",
      "utility-dialog:respond",
      "utility-dialog:set-height",
    ]);
    const publicChannels = new Set<string>(Object.values(IPC_CHANNELS));
    for (const channel of dialogChannels) {
      expect(publicChannels.has(channel)).toBe(false);
    }
  });
});
