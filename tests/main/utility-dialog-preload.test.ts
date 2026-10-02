import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  UTILITY_DIALOG_APPLY,
  UTILITY_DIALOG_GET_PAYLOAD,
  UTILITY_DIALOG_RESPOND,
  UTILITY_DIALOG_SET_HEIGHT,
  type UtilityDialogApplyMessage,
} from "../../src/shared/utility-dialog.js";
import type { UtilityDialogApi } from "../../src/preload/utility-dialog.js";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockOn = vi.hoisted(() => vi.fn());
const mockRemoveListener = vi.hoisted(() => vi.fn());
const mockExposeInMainWorld = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
}));

describe("utility-dialog preload", () => {
  let api: UtilityDialogApi;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockInvoke.mockResolvedValue(undefined);
    mockExposeInMainWorld.mockImplementation((_name: string, exposed: UtilityDialogApi) => {
      api = exposed;
    });
    await import("../../src/preload/utility-dialog.js");
  });

  it("exposes only the minimal private bridge as utilityDialogApi", () => {
    expect(mockExposeInMainWorld).toHaveBeenCalledExactlyOnceWith(
      "utilityDialogApi",
      expect.any(Object),
    );
    expect(Object.keys(api).sort()).toEqual(
      ["getPayload", "onApply", "os", "respond", "setHeight"].sort(),
    );
    expect(api.os).toBe(process.platform);
  });

  it("reads the active payload without arguments", async () => {
    const payload = { presentationId: 4, title: "t", message: "m", detail: "d", buttons: ["OK"] };
    mockInvoke.mockResolvedValueOnce(payload);

    await expect(api.getPayload()).resolves.toBe(payload);
    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith(UTILITY_DIALOG_GET_PAYLOAD);
  });

  it("forwards the answered presentation id with each response and height", async () => {
    await api.respond(3, 1);
    await api.setHeight(3, 312);

    expect(mockInvoke.mock.calls).toEqual([
      [UTILITY_DIALOG_RESPOND, 3, 1],
      [UTILITY_DIALOG_SET_HEIGHT, 3, 312],
    ]);
  });

  it("propagates main-process rejections to the renderer", async () => {
    const invalidSender = new Error("[utility-dialog] Invalid sender");
    mockInvoke.mockRejectedValueOnce(invalidSender);

    await expect(api.respond(1, 0)).rejects.toBe(invalidSender);
  });

  it("delivers present and retire messages, then unsubscribes the exact listener", () => {
    const received: UtilityDialogApplyMessage[] = [];
    const unsubscribe = api.onApply((message) => {
      received.push(message);
    });
    const listener = mockOn.mock.calls.find(([channel]) => channel === UTILITY_DIALOG_APPLY)?.[1];
    expect(listener).toBeTypeOf("function");

    const presentMessage: UtilityDialogApplyMessage = {
      kind: "present",
      payload: {
        presentationId: 2,
        title: "Update",
        message: "Ready",
        detail: "",
        buttons: ["Later", "Install"],
        defaultId: 1,
        cancelId: 0,
      },
    };
    const retireMessage: UtilityDialogApplyMessage = { kind: "retire", presentationId: 2 };
    listener({ sender: {} }, presentMessage);
    listener({ sender: {} }, retireMessage);
    expect(received).toEqual([presentMessage, retireMessage]);

    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledExactlyOnceWith(UTILITY_DIALOG_APPLY, listener);
  });
});
