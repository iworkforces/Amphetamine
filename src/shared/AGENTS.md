# Shared — Cross-Process Transport Contracts

Zero-runtime-dependency contracts shared by main, preload, renderer, scripts, and tests. **IPC wire shapes live here.** Pure settings types and validators own their source of truth under `src/domain/` and are re-exported for stable import paths.

## Files

| File | Role |
|------|------|
| `types.ts` | `IPC_CHANNELS`, `PUSH_CHANNELS`, `IpcChannelMap`, session/updater/about wire DTOs; re-exports domain `AppSettings` / `DEFAULT_SETTINGS` / `PerfTimestamp` / `SleepBlockMode` / `asPerf` |
| `utility-dialog.ts` | Private utility-dialog channel names + `UtilityDialogOptions` / payload (with main-owned `presentationId`) / `UtilityDialogApplyMessage` (present \| retire) / result types (not part of public `IPC_CHANNELS` budget) |
| `settings-quit.ts` | Private correlated Settings drain request/ack contract (not part of public channel or push budgets) |
| `settings-validators.ts` | Re-export of domain settings validation |
| `benchmark-types.ts` | Benchmark env name, renderer counter types/defaults, runtime guard |

## IPC Contract

`IPC_CHANNELS` holds **16** channel name literals:

| Key | Wire name | Kind |
|-----|-----------|------|
| `WINDOW_SET_HEIGHT` | `window:set-height` | invoke / send |
| `WINDOW_HIDE` | `window:hide` | push |
| `APP_GET_VERSION` | `app:get-version` | invoke |
| `APP_GET_ABOUT` | `app:get-about` | invoke |
| `SETTINGS_GET` / `SETTINGS_SET` / `SETTINGS_OPEN` | `settings:*` | invoke |
| `SETTINGS_CHANGED` | `settings:changed` | push |
| `SESSION_START` / `SESSION_CANCEL` / `SESSION_STATUS` | `session:*` | invoke |
| `SESSION_STATUS_UPDATE` | `session:status-update` | push |
| `APP_QUIT` | `app:quit` | invoke |
| `AUTO_UPDATER_CHECK` | `auto-updater:check` | invoke |
| `AUTO_UPDATER_STATUS` | `auto-updater:status` | push |
| `SHORTCUT_REGISTRATION_FAILED` | `shortcut:registration-failed` | push |

- `PUSH_CHANNELS` is the main→renderer push subset (5 channels).
- `IpcChannelMap` maps every channel to request/response types.
- Adding a **public** channel requires updates in: shared types, preload `api` + `WiredChannels`, main `registerIpcHandlers()` (or updater IPC), and tests.
- Push-only channels still need response payload types (typed listeners/broadcasts).
- **Private** utility-dialog channels (`get-payload` / `respond` / `set-height` / push `apply`) stay out of `IPC_CHANNELS`; they are handled only by WindowGraph + the dedicated preload.
- **Private** Settings quit drain request/ack channels stay out of `IPC_CHANNELS` and `PUSH_CHANNELS`; WindowGraph authenticates the cached Settings main frame before accepting an acknowledgement.

## Process-model note

Channel names in `IPC_CHANNELS` / `PUSH_CHANNELS` are the **wire** surface (main/preload/renderer).
Application code must not import channel literals; it publishes semantic `AppPushEvent` values via
`MainToRendererNotifierPort`, and `infrastructure/notification/broadcast-notifier` maps events to channels.

`settings-changed` is only published when a renderer-visible key changes (`preventSleep` \| `batteryThreshold` \| `shortcut`); payload is still a full `AppSettings` snapshot.

## Settings Contract (domain-owned)

| Field | Meaning |
|-------|---------|
| `launchAtLogin` | OS login-item toggle |
| `preventSleep` | User sleep-prevention **intent** (not live session) |
| `defaultSessionDuration` | Preference only: minutes or `null` for indefinite |
| `sleepBlockMode` | `prevent-display-sleep` \| `prevent-app-suspension` |
| `batteryThreshold` | Low-battery auto-disable percent; `0` disables |
| `shortcut` | Accelerator; empty means default |

- Always clone `DEFAULT_SETTINGS` / snapshots with spread.
- Runtime session state is **not** settings; it lives in the session engine + `SessionStatusResponse`.
- Validation: domain `VALIDATORS` / `validateRawSettings` / `mergeValidatedPartial` (re-exported here).
- Legacy disk key: `sessionDuration` → `defaultSessionDuration` via `migrateRawSettingsRecord`.
- Shortcut reserved combos and win32 Cmd→CommandOrControl normalization live in domain validators.

## Session / updater / about / utility-dialog wire DTOs

- `SessionStatusResponse`: 3-arm union (stopped / timed / indefinite).
- `SessionStartResponse`: ok/fail (`invalid-duration`, `Duration cannot exceed 24 hours`, `rejected`).
- `AutoUpdaterStatus`: checking / available / not-available / downloaded / downloading / errors.
- `AboutInfo`: `productName`, `version`, `description`, `repository`, `author` (`app:get-about`).
- `UtilityDialogOptions` / `UtilityDialogPayload` / `UtilityDialogResult`: fancy-aurora utility alert contract (`utility-dialog.ts`; private channels, not public `IPC_CHANNELS`).
- `PerfTimestamp` is branded via domain `asPerf(n)`.

## Benchmark Contract

- `BENCHMARK_ENV_NAME` is `AMPHETAMINE_BENCHMARK`.
- Scenarios: `BenchmarkScenario` = `idle` \| `active-session` (`isBenchmarkScenario`); harness CLI `--scenario`.
- Renderer counters: `benchmark-countdown.ts`; battery counters: `BatteryBenchmarkCounters` (benchmark-gated in main).
- Main harness under `infrastructure/benchmark`; artifact includes `scenario` / `scenarioMeta` and `timerCounters.battery`.
- Guard with `isRendererCountdownTimerCounters()` / `isBatteryBenchmarkCounters()` before trusting results.

## Anti-Patterns

- Never put Electron imports here.
- Never encode process-specific side effects in shared modules.
- Never reintroduce domain type bodies into this package (re-export only).
- Never add a settings field that doubles as live session state.
- Never commit benchmark artifacts under `shared/`; use `artifacts/`.
