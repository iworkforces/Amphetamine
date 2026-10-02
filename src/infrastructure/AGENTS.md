# Infrastructure — Adapters

Implements application ports with Electron/Node. May import domain types and application ports. Prefer not importing presentation modules that create cycles with composition (benchmark is a known exception for measurement-only dynamic imports of tray/settings).

## Adapters

| Path | Port / role | Notes |
|------|-------------|-------|
| `clock/system-clock.ts` | `ClockPort` | `performance.now` + `Date.now` |
| `schedule/node-schedule.ts` | `SchedulePort` | `setTimeout` + `unref` / `clearTimeout` |
| `logging/electron-logger.ts` | `LoggerPort` | `electron-log` |
| `notification/broadcast-notifier.ts` | `MainToRendererNotifierPort` | maps `AppPushEvent` → IPC `PUSH_CHANNELS` |
| `notification/os-user-notifier.ts` | `UserNotifierPort` | Electron `Notification`; falls back to logger when unsupported |
| `settings/file-settings-store.ts` | `SettingsStorePort` | atomic JSON; **coalesced** one active write + one pending batch; corrupt backup; isolated commits (copied patches, per-recipient snapshots) |
| `settings/dialog-save-failure.ts` | `SettingsSaveFailurePort` | `dialog.showErrorBox` |
| `sleep/power-save-blocker.ts` | `SleepBlockerPort` | **sole** `powerSaveBlocker` owner |
| `shortcut/electron-global-shortcut.ts` | `GlobalShortcutPort` | register / unregisterAll |
| `updater/hybrid-auto-updater.ts` | hybrid policy | electron-updater events; `setFeedURL` from package repo; single-flight checks; injected `showUserDialog` + optional `notifyUser` |
| `updater/auto-updater-utils.ts` | pure helpers | `deriveReleaseUrlBase`, `parseGitHubRepoIdentity`, `categorizeUpdaterError` |
| `updater/electron-updater-port.ts` | `UpdaterPort` | `configureHybridAutoUpdater` + lifecycle; **no main imports** |
| `benchmark/` | harness | scenarios + battery counters; see local `AGENTS.md` |

## Not here (intentional)

| Port / concern | Where it lives | Why |
|----------------|----------------|-----|
| `AutoLaunchPort` | `main/auto-launch.ts` | Login items are a main-process OS façade |
| `BatterySensorPort` | `main/platform/battery-sensor.ts` | `createBatterySensor`; percent still `battery-percent` shell-outs |
| Tray / BrowserWindow | `main/tray.ts`, `main/process/` | Presentation chrome, not application ports |

## Settings write coalescing

- At most **one physical write** in flight and **one pending batch** of callers.
- Different-field updates merge; each caller keeps its own `rejectedKeys`.
- Cache + `onChange` only after successful rename; failure preserves cache and rejects batch callers.
- `update()` copies the patch when it accepts it (later caller mutation cannot reach queued work) and rejects before `init()` without touching disk.
- Every subscriber and caller receives its **own** snapshot (no-op results included); nothing can alias the cache or another recipient.
- After the rename lands the batch is committed: subscribers run in registration order, each isolated (sync throws and async rejections logged as `[settings] Change subscriber threw:`), then callers resolve. Subscriber failures never reject callers or count toward the 3-failure feedback threshold.
- Subscribers may enqueue updates while a batch commits; they join the pending batch and `flush()` drains them. Unsubscribe is idempotent and removes only its own registration.
- `flush()` must await all queued work (used on quit).

## Updater

- `initAutoUpdater` calls `autoUpdater.setFeedURL({ provider: "github", owner, repo })` from `package.json` repository (via injected `getRepositoryUrl`).
- Concurrent tray/IPC/background checks share one in-flight `checkForUpdates()`; manual join upgrades user intent.
- macOS needs **`latest-mac.yml`** on the GitHub release; Windows needs **`latest.yml`**. Missing feed → false “could not reach update server” dialog.
- Background checks keep `autoDownload = false`; user-initiated path may download/install or open GitHub.
- Updater user dialogs use injected `showUserDialog` (composition wires WindowGraph `presentUtilityDialog` — fancy coffee-brown aurora BrowserWindow with its own utility-foreground ref). No native `dialog.showMessageBox`.
- Dialog button layout follows Apple alert HIG: secondary left, primary right (`twoButtonAlert`). Check-failed Esc / system Close maps to OK (`cancelOnPrimary`), not Open Releases. Info-only dialogs (up-to-date / unpackaged) pass a single OK button; the renderer hides the action row and dismisses via Close / Esc.
- Optional `notifyUser` surfaces Checking / Downloading OS notifications for user-initiated checks. Joining an in-flight background check settles feedback if events already ran without user intent.
- Updater must not import `src/main/*` (dialog presentation is injected).

## User notifications

- `UserNotifierPort` is for OS-level feedback that is **not** a renderer push (distinct from `MainToRendererNotifierPort`).
- `createOsUserNotifier` uses Electron `Notification`; when unsupported, logs with `[notify]` and no-ops.
- Production: composition wires notifier into `HandleLowBatteryAutoStop`.

## Rules

- Prefer `import … from "electron/main"`; use `electron/common` for `shell` / `nativeImage`.
- Never call `powerSaveBlocker` outside `sleep/power-save-blocker.ts`.
- Platform shell-outs stay under `main/platform` (not moved out of main).
- Main façades (`settings.ts`, `sleep-prevention.ts`, `auto-updater.ts`, `global-shortcut.ts`, …) may re-export or wrap these adapters for stable paths.
- Prefer construction-time injection of ports over module-level mutable globals (`configureHybridAutoUpdater` with `publish` / `getRepositoryUrl` / `showUserDialog` / optional `notifyUser`).
- Benchmark may import main for measurement-only seams (`getBatteryBenchmarkCounters`, dynamic tray/settings) — do not expand that exception.

## Log tags

| Module | Tag |
|--------|-----|
| sleep | `[sleep]` |
| settings store | `[settings]` |
| shortcut | `[shortcut]` |
| updater | `[auto-updater]` |
| OS notifications | `[notify]` |
| benchmark | `[benchmark]` |
