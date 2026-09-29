# Main Tests — Node and Electron Mocks

Main-process Vitest suites run in Node with Electron mocked (project aliases `electron/main` + `electron/common` → `electron`). They cover lifecycle, AppShell, composition, IPC/security, façades, timers, tray, updater, platform, and utilities.

## Test surface

| Area | Typical files |
|------|----------------|
| Bootstrap / quit | `index.test.ts`, `app-shell.test.ts` |
| Window graph | `window-graph.test.ts` (popover hide coalesce, Settings/About warm cache, wantsVisible dismiss race, focus-clear, utility acquire/release; utility-dialog path mocked via chrome/preload seams), `secure-web-preferences.test.ts`, `settings-window*.test.ts`, `about-window.test.ts` |
| Composition | `composition-root.test.ts` (session IPC fail-closed before init) |
| Composition wiring | `composition-wiring.test.ts` (settings reactions / tray effective-active matrix) |
| IPC / security | `ipc.test.ts`, `ipc-handlers.test.ts`, `security.test.ts`, `security-validation.test.ts` (packaged Windows `file://` paths), `preload.test.ts` |
| Session façade | `session-timer.test.ts` (handle from `createSessionTimer` only) |
| Settings store | `settings.test.ts` (write coalesce), `settings.predicates.test.ts` |
| OS integrations | `sleep-prevention.test.ts`, `battery-monitor.test.ts` (incl. benchmark counters / `onPercentSample`), `auto-launch.test.ts`, `global-shortcut.test.ts`, `shortcut.test.ts`, `tray.test.ts` |
| Platform | `platform.test.ts`, `battery-percent.test.ts`, `battery-sensor.test.ts`, `platform-shell-side-effects.test.ts`, `utility-presentation.test.ts` (refcount / Dock icon) |
| Updater | `auto-updater.test.ts` (hybrid + setFeedURL + single-flight), `auto-updater-utils.test.ts`; port: `tests/infrastructure/updater-port.test.ts` |
| Tooling contracts | `merge-latest-yml.test.ts`, `build-production.test.ts`, `release-matrix.test.ts`, `beta-release-matrix.test.ts` |
| Utils | `broadcast.test.ts`, `packageInfo.test.ts`, `constants.test.ts` |

Infrastructure adapter tests under `tests/infrastructure/` also run in the main Vitest project (`electron-logger`, `dialog-save-failure`, `benchmark-metrics`, `updater-port`).

Pure use-case / domain tests live under `tests/application` and `tests/domain` (not here).

## Mocking rules

- `tests/setup.main.ts`: baseline Electron mock (app, BrowserWindow, ipcMain, Tray, Menu, shell, dialog, nativeImage, nativeTheme, powerSaveBlocker, powerMonitor).
- Use `vi.hoisted()` for values referenced by `vi.mock()` factories.
- Local `vi.mock("electron")` only for narrower shapes (alias covers `electron/main`).
- Restore singletons with `vi.resetModules()` + dynamic import.
- Mock `node:fs/promises`, `node:child_process`, hybrid updater, and logs — not real OS state.
- `createSessionTimer` deps: `broadcast` required; optional `onSessionActiveChange` / `powerMonitor`.
- Battery handle mocks include `reconfigure`.
- Tray deps include `checkForUpdates` and `getEffectiveActive`.
- Composition tests: mock `hybrid-auto-updater`, `packageInfo`, platform shell helpers, `createBatterySensor`, `isSettingsWindowOpen` when constructing the real composition root.
- Hybrid updater tests: `configureHybridAutoUpdater` with `createBroadcastNotifier` wrapping `broadcastToWindows`; mock `setFeedURL`.
- Auto-launch: darwin expects `openAsHidden: true`; win32 only `openAtLogin`.

## Behavioral focus

- `reconcileSessionState` must not kill sessions when `defaultSessionDuration` is null.
- Battery threshold change while preventing sleep re-arms polling via `reconfigure`.
- Quit: AppShell drains cached Settings renderer → store flush under one 2s deadline → tray → `composition.cleanup()` → `destroyAllWindows()`.
- Tray cleanup calls `destroy()`.
- Sleep mode: `powerSaveBlocker.start` receives configured mode string.
- Effective sleep OR matrix (4 rows) via tray effective active / recompute.
- Composition: session IPC throws before `init()`; no `setActiveSessionTimer`.
- SESSION_START goldens: `invalid-duration`, `Duration cannot exceed 24 hours` (>1440), 1440 inclusive, `null` indefinite.
- SETTINGS_CHANGED only for `preventSleep` \| `batteryThreshold` \| `shortcut` (via AppPushEvent → channel).
- `sleepBlockMode` recompute only when blocker active OR intent OR session; mode read from `getSettings()` (advance mock cache before subscriber).
- About: shared secure prefs **with** preload; loads `/about.html`; github-only `window.open` via override after `hardenWebContents`; acquires utility foreground on ready-to-show (same as Settings).
- Utility presentation: nested acquires keep Dock until last release; over-release is safe; utility dialog + Settings/About use independent foreground refs.
- Warm cache (Settings/About): user `close` → preventDefault + hide + release foreground; second open reuses one BrowserWindow (no recreate); `close*Window` / `destroyAllWindows` force-`destroy`.
- Utility dialog: hide-on-close warm cache + `apply` re-present; single-flight; `showUserDialog` mocked in hybrid updater tests (payload/button HIG), not native MessageBox.
- Dismiss-before-ready: early present then hide then late `ready-to-show` must **not** re-show or re-acquire (`*WantsVisible`).
- Settings/About present: deferred `executeJavaScript` blur so warm reopen does not focus a control (Settings form; About GitHub icon).
- `isSettingsWindowOpen` is true only when visible (hidden cache returns false).
- AppShell: ready order tray-only → popover → composition → IPC → tray → `initUpdater` (skipped in benchmark); quit ends with `destroyAllWindows` (includes open utility dialog).
- Popover hide: blur/minimize bursts → one pending hide; show before expiry cancels hide.
- Settings coalesce: rapid multi-field updates → fewer write/rename pairs than logical updates; flush awaits queue.
- Updater: concurrent checks call `checkForUpdates` once; `setFeedURL` from package repository; injected `showUserDialog` with HIG two-button layout; check-failed Esc/`cancelId` dismisses (OK), not Open Releases; install Later/Restart indices preserved.
- Platform chrome: `utilityDialogWindowChrome` is opaque `#0D1117` (no vibrancy/mica) with system Close.

## Timer and async

- Prefer fake timers + `vi.advanceTimersByTimeAsync()`.
- Assert `.unref()` on mocked handles when relevant.
- No real sleeps for timeout/updater/session/battery polling.

## IPC / security

- Cover valid packaged public origins (`index` / `settings` / `about.html`), valid dev, and rejected origins. Utility-dialog is intentionally **not** on the public allowlist.
- Assert registration + dependency routing for handlers (including `APP_GET_ABOUT`).
- Prefer `IPC_CHANNELS` names in transport tests; application tests use `AppPushEvent`.

## Anti-Patterns

- Never launch real Electron windows, `pmset`, or PowerShell battery queries.
- Battery monitor tests inject a fake `BatterySensorPort`; parser/exec coverage in `battery-percent.test.ts`; `powerMonitor` wiring in `battery-sensor.test.ts`.
- Never reintroduce expectations that the session timer writes `defaultSessionDuration` into settings.
- Never assume module-level `startSession` exports or `coordinator` still exist.
- Never assert About loads `data:text/html`.
