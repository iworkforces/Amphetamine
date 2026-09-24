import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const fsMockState = vi.hoisted(() => ({
  failWriteFile: false,
  failNextWriteFile: false,
  pauseWriteFile: null as Promise<void> | null,
  signalWriteStart: null as (() => void) | null,
  writeFileError: new Error("ENOSPC: no space left on device"),
}));

import type * as SettingsModule from "../../src/main/settings.js";
import type * as FsPromises from "node:fs/promises";
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  return {
    ...actual,
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      fsMockState.signalWriteStart?.();
      await fsMockState.pauseWriteFile;
      if (fsMockState.failWriteFile || fsMockState.failNextWriteFile) {
        fsMockState.failNextWriteFile = false;
        throw fsMockState.writeFileError;
      }
      return actual.writeFile(...args);
    }),
  };
});
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/amphetamine-settings-test"),
    on: vi.fn(),
    quit: vi.fn(),
  },
  dialog: {
    showErrorBox: vi.fn(),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const MOCK_USER_DATA_PATH = "/tmp/amphetamine-settings-test";

import { dialog } from "electron";
import log from "electron-log";
import {
  initSettings,
  saveSettings,
  getSettings,
  updateSettings,
} from "../../src/main/settings.js";
import { DEFAULT_SETTINGS } from "../../src/shared/types.js";
import { createFileSettingsStore } from "../../src/infrastructure/settings/file-settings-store.js";

describe("settings", () => {
  const settingsPath = join(MOCK_USER_DATA_PATH, "settings.json");

  beforeEach(async () => {
    vi.clearAllMocks();
    fsMockState.failWriteFile = false;
    fsMockState.failNextWriteFile = false;
    fsMockState.pauseWriteFile = null;
    fsMockState.signalWriteStart = null;

    if (existsSync(MOCK_USER_DATA_PATH)) {
      rmSync(MOCK_USER_DATA_PATH, { recursive: true, force: true });
    }
    mkdirSync(MOCK_USER_DATA_PATH, { recursive: true });

    await initSettings();
  });

  afterEach(() => {
    if (existsSync(MOCK_USER_DATA_PATH)) {
      rmSync(MOCK_USER_DATA_PATH, { recursive: true, force: true });
    }
  });

  describe("initSettings", () => {
    it("rejects access before the new store has loaded disk settings", async () => {
      const freshSettings = createFileSettingsStore({
        getUserDataPath: () => MOCK_USER_DATA_PATH,
        onSaveFailure: { notifyPersistenceBroken: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(() => freshSettings.get()).toThrow(/before initSettings/);

      await freshSettings.init();
      expect(freshSettings.get()).toEqual(DEFAULT_SETTINGS);
    });

    it("returns defaults when no file exists", async () => {
      if (existsSync(settingsPath)) {
        rmSync(settingsPath);
      }

      await initSettings();
      const settings = getSettings();

      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it("reads existing file correctly", async () => {
      const expectedSettings = { launchAtLogin: true };

      mkdirSync(MOCK_USER_DATA_PATH, { recursive: true });
      const fs = require("fs");
      fs.writeFileSync(settingsPath, JSON.stringify(expectedSettings));

      await initSettings();
      const settings = getSettings();

      expect(settings.launchAtLogin).toBe(true);
    });

    it("handles corrupted JSON (returns defaults)", async () => {
      mkdirSync(MOCK_USER_DATA_PATH, { recursive: true });
      const fs = require("fs");
      fs.writeFileSync(settingsPath, "{ not valid json }");

      await initSettings();
      const settings = getSettings();

      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it("backs up malformed JSON while continuing with defaults", async () => {
      writeFileSync(settingsPath, "{broken");

      await initSettings();

      const backups = readdirSync(MOCK_USER_DATA_PATH).filter((name) =>
        name.startsWith("settings.json.corrupt-"),
      );
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(MOCK_USER_DATA_PATH, backups[0] ?? ""), "utf-8")).toBe("{broken");
      expect(existsSync(settingsPath)).toBe(false);
      expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it("uses defaults and reports a read error other than a missing file", async () => {
      mkdirSync(settingsPath);

      await initSettings();

      expect(getSettings()).toEqual(DEFAULT_SETTINGS);
      expect(log.error).toHaveBeenCalledWith(
        "[settings] Failed to read settings file:",
        expect.objectContaining({ code: "EISDIR" }),
      );
    });

    it.each(["null", "[]", "42"])("treats JSON %s as an empty settings record", async (raw) => {
      writeFileSync(settingsPath, raw);

      await initSettings();

      expect(getSettings()).toEqual(DEFAULT_SETTINGS);
      expect(readFileSync(settingsPath, "utf-8")).toBe(raw);
    });

    it("validates disk fields independently while migrating a legacy session duration", async () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          launchAtLogin: true,
          batteryThreshold: 150,
          sessionDuration: 45,
          shortcut: "Cmd+Q",
        }),
      );

      await initSettings();

      expect(getSettings()).toEqual({
        ...DEFAULT_SETTINGS,
        launchAtLogin: true,
        defaultSessionDuration: 45,
      });
    });
  });

  describe("saveSettings", () => {
    it("persists to disk", async () => {
      const settingsToSave = { ...DEFAULT_SETTINGS, launchAtLogin: true };

      await saveSettings(settingsToSave);

      expect(existsSync(settingsPath)).toBe(true);

      const raw = readFileSync(settingsPath, "utf-8");
      const saved = JSON.parse(raw);

      expect(saved.launchAtLogin).toBe(true);
    });

    it("writes atomically so final file only appears when write is complete", async () => {
      const settingsToSave = { ...DEFAULT_SETTINGS, launchAtLogin: true, preventSleep: true };

      await saveSettings(settingsToSave);

      // Final file should exist with correct content
      expect(existsSync(settingsPath)).toBe(true);
      const raw = readFileSync(settingsPath, "utf-8");
      const saved = JSON.parse(raw);
      expect(saved.launchAtLogin).toBe(true);
      expect(saved.preventSleep).toBe(true);
    });
    it("writes settings file with mode 0o600 (owner-only)", async () => {
      const fsPromises = await import("node:fs/promises");
      const writeFileMock = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
      writeFileMock.mockClear();

      await saveSettings({ ...DEFAULT_SETTINGS, launchAtLogin: true });

      // writeFile should have been called with mode 0o600 in the options object.
      const calledWithMode = writeFileMock.mock.calls.some((call) => {
        const opts = call[2] as unknown;
        return (
          typeof opts === "object" &&
          opts !== null &&
          (opts as { mode?: number }).mode === 0o600
        );
      });
      expect(calledWithMode).toBe(true);

      // Final on-disk file should have 0o600 permission bits.
      const fs = await import("node:fs");
      const stat = fs.statSync(settingsPath);
      // mode & 0o777 should be exactly 0o600 (owner rw, no group/other).
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe("getSettings", () => {
    it("returns cached copy", async () => {
      await initSettings();

      const settings = getSettings();

      expect(settings).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe("updateSettings", () => {
    it("merges partial, saves, and returns full settings", async () => {
      await saveSettings({ ...DEFAULT_SETTINGS, launchAtLogin: false });

      const result = await updateSettings({ launchAtLogin: true });

      expect(result.settings.launchAtLogin).toBe(true);
      expect(result.rejectedKeys).toEqual([]);

      const raw = readFileSync(settingsPath, "utf-8");
      const saved = JSON.parse(raw);
      expect(saved.launchAtLogin).toBe(true);

      const cached = getSettings();
      expect(cached.launchAtLogin).toBe(true);
    });

    it("ignores unknown properties in partial", async () => {
      getSettings();

      const result = await updateSettings({ launchAtLogin: true });

      expect(Object.keys(result.settings).sort()).toEqual(
        [
          "launchAtLogin",
          "preventSleep",
          "defaultSessionDuration",
          "batteryThreshold",
          "shortcut",
          "sleepBlockMode",
        ].sort(),
      );
    });

    it("updates launchAtLogin correctly", async () => {
      await saveSettings({ ...DEFAULT_SETTINGS, launchAtLogin: false });

      const result = await updateSettings({ launchAtLogin: true });

      expect(result.settings.launchAtLogin).toBe(true);

      const raw = readFileSync(settingsPath, "utf-8");
      const saved = JSON.parse(raw);
      expect(saved.launchAtLogin).toBe(true);

      const result2 = await updateSettings({ launchAtLogin: false });
      expect(result2.settings.launchAtLogin).toBe(false);
    });

    it("defaults launchAtLogin to false when not in file", async () => {
      const fs = require("fs");
      fs.writeFileSync(settingsPath, JSON.stringify({}));

      await initSettings();
      const settings = getSettings();

      expect(settings.launchAtLogin).toBe(false);
    });
  });

  describe("validation edge cases", () => {
    it("rejects NaN defaultSessionDuration (no change)", async () => {
      await updateSettings({ defaultSessionDuration: 60 });
      const before = getSettings().defaultSessionDuration;

      const result = await updateSettings({ defaultSessionDuration: Number.NaN });

      expect(result.settings.defaultSessionDuration).toBe(before);
      expect(result.settings.defaultSessionDuration).toBe(60);
      expect(result.rejectedKeys).toContain("defaultSessionDuration");
    });

    it("rejects Infinity defaultSessionDuration (no change)", async () => {
      await updateSettings({ defaultSessionDuration: 60 });
      const before = getSettings().defaultSessionDuration;

      const result = await updateSettings({ defaultSessionDuration: Number.POSITIVE_INFINITY });

      expect(result.settings.defaultSessionDuration).toBe(before);
      expect(result.settings.defaultSessionDuration).toBe(60);

      const result2 = await updateSettings({ defaultSessionDuration: Number.NEGATIVE_INFINITY });
      expect(result2.settings.defaultSessionDuration).toBe(60);
    });
  });

  describe("concurrent updateSettings", () => {
    it("final state matches the last call when fired rapidly", async () => {
      await updateSettings({ defaultSessionDuration: 10 });

      const p1 = updateSettings({ defaultSessionDuration: 30 });
      const p2 = updateSettings({ defaultSessionDuration: 60 });
      const p3 = updateSettings({ defaultSessionDuration: 90 });

      const results = await Promise.all([p1, p2, p3]);

      // Final result observed by caller and cache must reflect the last update
      expect(results[2].settings.defaultSessionDuration).toBe(90);
      expect(getSettings().defaultSessionDuration).toBe(90);
    });

    it("coalesces rapid same- and different-field updates into fewer physical writes", async () => {
      const fsPromises = await import("node:fs/promises");
      const writeFileMock = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
      const renameMock = fsPromises.rename as unknown as ReturnType<typeof vi.fn>;
      // rename may not be mocked — spy if available
      const renameSpy =
        typeof renameMock?.mockClear === "function"
          ? renameMock
          : vi.spyOn(fsPromises, "rename");
      writeFileMock.mockClear();
      renameSpy.mockClear();

      const changeListener = vi.fn();
      const { onSettingsChanged } = await import("../../src/main/settings.js");
      const unsub = onSettingsChanged(changeListener);

      const results = await Promise.all([
        updateSettings({ preventSleep: true }),
        updateSettings({ launchAtLogin: true }),
        updateSettings({ batteryThreshold: 20 }),
        updateSettings({ preventSleep: false }),
      ]);

      // After all callers settle, disk/cache hold the merged final fields.
      expect(getSettings().preventSleep).toBe(false);
      expect(getSettings().launchAtLogin).toBe(true);
      expect(getSettings().batteryThreshold).toBe(20);
      for (const r of results) {
        expect(r.rejectedKeys).toEqual([]);
      }

      // Fewer physical write/rename pairs than 4 logical updates.
      expect(writeFileMock.mock.calls.length).toBeLessThan(4);
      expect(writeFileMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      // Change emissions are per successful physical batch, not per logical update.
      expect(changeListener.mock.calls.length).toBeLessThan(4);
      expect(changeListener.mock.calls.length).toBeGreaterThanOrEqual(1);

      unsub();
    });

    it("flushSettingsWriteChain awaits queued coalesced work", async () => {
      const { flushSettingsWriteChain } = await import("../../src/main/settings.js");
      void updateSettings({ launchAtLogin: true });
      void updateSettings({ batteryThreshold: 15 });
      await flushSettingsWriteChain();
      expect(getSettings().launchAtLogin).toBe(true);
      expect(getSettings().batteryThreshold).toBe(15);
    });
  });

  describe("no-change dedup", () => {
    it("does not write to disk when partial matches current settings", async () => {
      // Establish baseline on disk
      await updateSettings({ launchAtLogin: true });
      expect(existsSync(settingsPath)).toBe(true);

      // Remove the file — if updateSettings tries to write again, the file will reappear
      rmSync(settingsPath);
      expect(existsSync(settingsPath)).toBe(false);

      // Same value as cache — dedup must skip the disk write
      const result = await updateSettings({ launchAtLogin: true });

      expect(result.settings.launchAtLogin).toBe(true);
      expect(existsSync(settingsPath)).toBe(false);
    });
  });

  describe("save failure handling", () => {
    let _settings: typeof SettingsModule;

    beforeEach(async () => {
      vi.resetModules();
      fsMockState.failWriteFile = false;
      _settings = await import("../../src/main/settings.js");
      await _settings.initSettings();
      vi.mocked(dialog.showErrorBox).mockClear();
      vi.mocked(log.error).mockClear();
    });

    afterEach(() => {
      fsMockState.failWriteFile = false;
    });

    it("throws and leaves settingsCache unchanged when writeFile rejects", async () => {
      await _settings.updateSettings({ launchAtLogin: false, defaultSessionDuration: 60 });
      const before = _settings.getSettings();

      fsMockState.failWriteFile = true;

      await expect(_settings.updateSettings({ launchAtLogin: true })).rejects.toThrow(/ENOSPC/);

      const after = _settings.getSettings();
      expect(after).toEqual(before);
      expect(after.launchAtLogin).toBe(false);
    });

    it("does not emit change event on save failure", async () => {
      await _settings.updateSettings({ launchAtLogin: false });
      fsMockState.failWriteFile = true;

      const listener = vi.fn();
      const unsubscribe = _settings.onSettingsChanged(listener);

      await expect(_settings.updateSettings({ launchAtLogin: true })).rejects.toThrow();

      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("logs error on save failure (does not swallow)", async () => {
      fsMockState.failWriteFile = true;

      await expect(_settings.updateSettings({ launchAtLogin: true })).rejects.toThrow();

      expect(log.error).toHaveBeenCalledWith(
        "[settings] Failed to save settings:",
        expect.any(Error),
      );
    });

    it("shows error dialog after 3 consecutive save failures", async () => {
      fsMockState.failWriteFile = true;

      await expect(_settings.updateSettings({ defaultSessionDuration: 30 })).rejects.toThrow();
      expect(dialog.showErrorBox).not.toHaveBeenCalled();

      await expect(_settings.updateSettings({ defaultSessionDuration: 60 })).rejects.toThrow();
      expect(dialog.showErrorBox).not.toHaveBeenCalled();

      await expect(_settings.updateSettings({ defaultSessionDuration: 90 })).rejects.toThrow();
      expect(dialog.showErrorBox).toHaveBeenCalledWith(
        "Settings Cannot Be Saved",
        "Disk may be full. Changes will be lost on restart.",
      );
    });

    it("resets consecutive failure counter on successful save", async () => {
      fsMockState.failWriteFile = true;
      await expect(_settings.updateSettings({ defaultSessionDuration: 30 })).rejects.toThrow();
      await expect(_settings.updateSettings({ defaultSessionDuration: 60 })).rejects.toThrow();

      // Recover
      fsMockState.failWriteFile = false;
      await _settings.updateSettings({ defaultSessionDuration: 90 });

      // Two more failures should NOT trigger dialog (counter reset)
      fsMockState.failWriteFile = true;
      await expect(_settings.updateSettings({ defaultSessionDuration: 120 })).rejects.toThrow();
      await expect(_settings.updateSettings({ defaultSessionDuration: 150 })).rejects.toThrow();

      expect(dialog.showErrorBox).not.toHaveBeenCalled();
    });

    it("rejects a failed active write but persists the later merged pending batch", async () => {
      let releaseWrite: () => void = () => {};
      const blockedWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let signalStarted: () => void = () => {};
      const writeStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      fsMockState.pauseWriteFile = blockedWrite;
      fsMockState.signalWriteStart = signalStarted;
      fsMockState.failNextWriteFile = true;

      const failed = _settings.updateSettings({ defaultSessionDuration: 30 });
      const failedAssertion = expect(failed).rejects.toThrow(/ENOSPC/);
      await writeStarted;

      const valid = _settings.updateSettings({ launchAtLogin: true, batteryThreshold: 150 });
      const latest = _settings.updateSettings({ batteryThreshold: 20 });
      releaseWrite();
      fsMockState.pauseWriteFile = null;

      await failedAssertion;
      const [firstPending, lastPending] = await Promise.all([valid, latest]);
      expect(firstPending.rejectedKeys).toEqual(["batteryThreshold"]);
      expect(lastPending.rejectedKeys).toEqual([]);
      const expected = { ...DEFAULT_SETTINGS, launchAtLogin: true, batteryThreshold: 20 };
      expect(firstPending.settings).toEqual(expected);
      expect(lastPending.settings).toEqual(expected);
      expect(_settings.getSettings()).toEqual(expected);
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(expected);
    });
  });

  describe("store façade accessors", () => {
    it("getSettingsStore returns the live store", async () => {
      const mod = await import("../../src/main/settings.js");
      await mod.initSettings();
      const store = mod.getSettingsStore();
      expect(store.get().preventSleep).toBe(false);
      await mod.flushSettingsWriteChain();
    });
  });
});
