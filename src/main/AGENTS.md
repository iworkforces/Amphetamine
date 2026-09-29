# Main Process - Electron Presentation + Composition

Main process owns app lifecycle, BrowserWindows, tray, typed IPC registration, and the composition root. Business rules live under `application/` and `domain/`; OS/Electron I/O adapters under `infrastructure/` (with thin façades here for stable import paths).

**Process graph:** `AppShell` is the topology root (ready/quit order). `process/window-graph` is the **only** production factory for popover, settings, about, and utility-dialog `BrowserWindow`s. Public renderers talk through preload `window.api`; the utility dialog uses a dedicated preload (`utilityDialogApi`).

## Files

| File | Role |
|------|------|
| `index.ts` | App lifecycle events only (ready, quit, single-instance, errors, benchmark entry) |
| `app-shell.ts` | `createAppShell()` — process-graph root: windows + composition + IPC + tray + updater + quit cleanup |
| `process/secure-web-preferences.ts` | Single `createSecureWebPreferences()` for all BrowserWindows (sandbox / contextIsolation / no nodeIntegration) |
| `process/window-graph.ts` | Owns popover / settings / about / utility-dialog BrowserWindows + registry + coalesced hide + **hide-on-close warm cache** for Settings/About/utility-dialog + single-flight `presentUtilityDialog` + `closeUtilityDialogWindow` + `destroyAllWindows()` |
| `composition-root.ts` | `createAppComposition()` — ports, session handle, reactions, user notifier, `showUserDialog` → `presentUtilityDialog`, `getIpcDeps` / `getTrayDeps` / `initUpdater`, ordered `cleanup()` |
| `ipc.ts` | Typed handler registration; session handlers use injected `IpcDeps.sessionTimer` |
| `ipc-utils.ts` | `validateSender`, `typedHandle`; public allowlist `index.html` / `settings.html` / `about.html` (utility-dialog is **not** public-IPC allowlisted) |
| `tray.ts` | Tray icon/menu; Check for Updates; destroy on cleanup |
| `settings.ts` | Façade over `infrastructure/settings` (`SettingsStorePort`); `flushSettingsWriteChain()` |
| `sleep-prevention.ts` | Façade over `infrastructure/sleep` (`SleepBlockerPort`) |
| `session-timer.ts` | Façade over `application/session` engine; **handle injection only** |
| `global-shortcut.ts` | Façade over RegisterAppShortcut + GlobalShortcutPort |
| `auto-launch.ts` | Login items + `AutoLaunchPort` view (port lives here, not infrastructure) |
| `battery-monitor.ts` | Threshold **detector** only; injected `BatterySensorPort` (`createBatterySensor`); optional `onPercentSample`; benchmark counters |
| `auto-updater.ts` | IPC registration + re-exports of hybrid policy (`infrastructure/updater`) |
| `auto-updater-utils.ts` | Façade over pure release-URL helpers + package repo lookup |
| `settings-window.ts` | Thin re-export of WindowGraph settings APIs |
| `about-window.ts` | Thin re-export of WindowGraph about APIs (built `about.html`) |
| `security.ts` | WebContents navigation hardening; default deny-all `window.open` |
| `constants.ts` | Window sizes, timeouts, tray/menu UI strings |
| `platform/` | OS adapters + utility foreground; see `platform/AGENTS.md` |
| `utils/broadcast.ts` | Typed main→renderer push helper (`PushChannel`) |
| `utils/packageInfo.ts` | Cached package metadata guard |

## Bootstrap and quit

**Ready order (required, owned by `AppShell.init()`):**

1. `enterTrayOnlyMode()` + `createPopoverWindow()` (WindowGraph)
2. `createAppComposition()` + `await composition.init()` (settings, session, battery, shortcut, reactions)
3. `registerIpcHandlers(window, composition.getIpcDeps())`
4. `setupTray(composition.getTrayDeps())`
5. `composition.initUpdater()` unless benchmark mode

**Quit (`index.ts` sole `before-quit` owner → `AppShell.cleanup()`):**

1. Idempotent cleanup flags (`index` + shell)
2. Drain the cached Settings renderer (including hidden windows), then `flushSettingsWriteChain()` under one absolute 2s deadline; skip absent/not-ready windows
3. Tray `destroy`, IPC cleanup
4. `composition.cleanup()`
5. `destroyAllWindows()` (WindowGraph) → `app.exit(0)`

Do not register a second `before-quit` handler on settings or other modules.

## Composition rules

- Settings field reactions run only through `SettingsReactionService` (single store `onChange` subscriber).
- Effective sleep: `preventSleep` **OR** session active — via `createRecomputeSleepPrevention` + domain `isEffectivelyActive`.
- Low-battery: detector calls `HandleLowBatteryAutoStop` (clear intent + cancel session + optional OS notify via `UserNotifierPort`).
- Battery monitor is constructed with `createBatterySensor()`; it may report `onPercentSample` so low-battery messages can include the last known charge percent.
- Session IPC before `init` **fails closed** (throws); no module-level session globals.
- Application → renderer pushes use `AppPushEvent` via `MainToRendererNotifierPort` (not raw `IPC_CHANNELS`).
- OS user feedback uses `UserNotifierPort` (`createOsUserNotifier`) — not a push channel.
- `getTrayDeps().checkForUpdates` → `UpdaterPort.checkNow()`.
- Updater port is configured with `showUserDialog` → WindowGraph `presentUtilityDialog` (aurora alert + own utility-foreground ref) and `getRepositoryUrl` at composition construct time (`setFeedURL` uses that repo). Optional `notifyUser` for Checking/Downloading OS notifications.
- `cleanup()` order: settings/about windows → unsubscribe reactions → battery → session → sleep stop → shortcut unregister → updater stop. Utility dialog is torn down by AppShell `destroyAllWindows()` (not composition).

## Popover hide coalescing

- Blur/minimize schedule **one** pending delayed hide + **one** `WINDOW_HIDE` broadcast (`HIDE_DELAY_MS`).
- Further blur/minimize while pending is a no-op; `show` / destroy / quit cancel the timer (`hasPendingPopoverHide` test seam).
- Renderer hide handlers are transition-based (ignore duplicate hide while already hidden).

## IPC and security

- Use `typedHandle()` for invoke channels (validates sender).
- Public raw `ipcMain.on()` requires `validateSender()`; the private Settings quit acknowledgement instead checks the exact cached `webContents`, its current main frame, and the correlated request ID.
- Packaged public senders: exact-match NFC-normalized `lib/renderer/{index,settings,about}.html`; dev: `DEV_ORIGINS`. Utility-dialog private IPC uses webContents-id binding (not URL allowlist).
- Renderer pushes: `broadcastToWindows<K>()`; skip destroyed windows.
- `hardenWebContents` blocks off-allowlist navigation and **denies all** `window.open` by default (popover, settings, about, utility-dialog).
- About external links: WindowGraph overrides `setWindowOpenHandler` to allowlist the package repository URL (and paths under it on `github.com`) via `shell.openExternal` (still returns `deny` so no popup BrowserWindow).
- Popover / Settings / About use shared preload via `createSecureWebPreferences({ preload: index.cjs })`. Utility dialog uses dedicated `utility-dialog.cjs` preload.

## Timing and state

- Session machine: `application/session/session-engine.ts` (`ClockPort` + `SchedulePort`).
- Elapsed: `ClockPort.perfNow()` / `asPerf`; resume: `ClockPort.wallNow()`.
- `setTimeout` + `.unref()` only in schedule (and polling) adapters — not in application.
- `createSessionTimer({ broadcast, onSessionActiveChange?, powerMonitor? })` — no settings writers.
- `reconcileSessionState()` is a no-op: preference null must not kill a live session.
- Preference field `defaultSessionDuration` is settings/UI only.

## Tray

- Icon = **effective** active (`getEffectiveActive`).
- Menu checkbox = **user intent** (`getPreventSleep`) only.
- Menu: Prevent Sleep, **Cancel session** (when a session is running), Settings…, About Amphetamine, Check for Updates…, Quit (most labels in `constants.ts`).
- Icons: `nativeImage.createFromPath()` only (asar-safe). Cleanup calls `tray.destroy()`.

## Platform

- Prefer `isDarwin()` / `isWin32()` from `platform/`.
- Tray-only boot: `enterTrayOnlyMode()` (from AppShell).
- Window chrome: `popoverWindowChrome` / `settingsWindowChrome` / `aboutWindowChrome` / `utilityDialogWindowChrome` (applied inside WindowGraph). Utility dialog chrome is **opaque** (`backgroundColor: #0D1117`, no vibrancy/mica) with system Close (hiddenInset / titleBarOverlay).
- Settings, About, and utility dialog acquire/release **refcounted** utility foreground (`acquireUtilityForeground` / `releaseUtilityForeground`); Dock icon via `setUtilityDockIcon`.
- Settings/About/utility-dialog use **hide-on-close warm cache**: first open creates+loads the BrowserWindow; user close hides (renderer stays warm); quit/`close*Window` force-destroys (`win.destroy()`, not hide).
- Utility dialog is **single-flight** (concurrent `presentUtilityDialog` joins the in-flight promise). Re-present pushes payload via `utility-dialog:apply` (no reload). Present path resets content size to default then re-measures; renderer calls `set-height` **before** the open fade (avoids first-open aurora filter fringe at the window edge).
- `*WantsVisible` intent flag (Settings/About/utility-dialog): late `ready-to-show` after user dismiss must not re-show; reopening sets intent true again.
- Settings present path clears form focus after show (deferred `webContents.executeJavaScript` blur) so warm-cache reopen does not restore Launch at Login / last control.
- `isSettingsWindowOpen()` means **visible** (not merely cached-and-hidden).
- Login items: `buildLoginItemSettings()` — no `openAsHidden` on non-darwin.
- Battery shell-outs only in `platform/battery-percent.ts`.

## Benchmark

- Early (in `index.ts`): `configureBenchmarkEnvironment()` + `installBenchmarkTimerCounters()` from `infrastructure/benchmark`.
- AppShell skips `initUpdater` when `isBenchmarkMode()`.
- Scenarios via env: idle (default) or active-session (starts timed session before samples).
- Battery semantic counters are benchmark-gated only (`getBatteryBenchmarkCounters`).
- Measures then prints `AMPHETAMINE_BENCHMARK_RESULT:` and quits.
- Harness may dynamically import tray/settings from main for measurement.

## Process imports

- Main/infrastructure use `from "electron/main"` (and `electron/common` for `shell` / `nativeImage`).
- Preload continues to use `from "electron"` / renderer-safe APIs.

## Anti-Patterns

- Never call `powerSaveBlocker.start/stop` outside `infrastructure/sleep`.
- Never bypass sender validation for IPC.
- Never expose mutable settings cache; always clone snapshots.
- Never put settings field validators in main; extend domain `VALIDATORS`.
- Never load tray icons with `fs.readFileSync`.
- Never hardcode tray/menu strings outside `constants.ts`.
- Never write session runtime duration into settings from the timer.
- Never register a competing `before-quit` handler.
- Never call macOS-only Electron APIs without `isDarwin()`.
- Never reintroduce `setActiveSessionTimer` / module-level session exports.
- Never create `BrowserWindow`s outside `process/window-graph` (except tests).
- Never reintroduce inline `data:` About HTML; use the built `about.html` entry.
- Never call `initAutoUpdater()` outside `UpdaterPort` / composition `initUpdater()`.
- Never destroy Settings/About on user close (hide-on-close); only force-destroy on quit/composition cleanup.
- Never destroy the utility dialog on user dismiss (hide-on-close); only force-destroy on quit / `closeUtilityDialogWindow`.
- Never present a Settings/About/utility-dialog window when wantsVisible is false (dismiss-before-ready race).
- Never reintroduce native `dialog.showMessageBox` for updater UX (use `presentUtilityDialog` / `showUserDialog`).

## Commands

```bash
bun run test -- tests/main
bun run typecheck
bun run typecheck:sticky
bun run typecheck:layers
bun run benchmark:performance  # after bun run build
```
