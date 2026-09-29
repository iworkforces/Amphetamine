# Application — Use Cases and Ports

Electron-free application services. Depends on **domain** and **port interfaces** only (may import domain types + shared **types** for wire DTOs such as `SessionStatusResponse`, never channel name literals). Implementations live in `infrastructure/` (and a few main façades) and are wired in `main/composition-root.ts`.

## Layout

| Path | Role |
|------|------|
| `ports/` | Port interfaces (closed budget of 12; see barrel `ports/index.ts`) |
| `session/session-engine.ts` | Timed/indefinite session machine (`ClockPort` + `SchedulePort` + notifier + logger) |
| `sleep/recompute-sleep-prevention.ts` | Effective sleep OR policy → `SleepBlockerPort` |
| `sleep/toggle-prevent-sleep.ts` | Flip `preventSleep` via store (persist-only) |
| `settings/update-settings.ts` | Persist-only partial update |
| `settings/get-settings.ts` | Snapshot read |
| `settings/settings-reaction-service.ts` | **Sole** settings field-diff reaction owner |
| `battery/handle-low-battery-auto-stop.ts` | Clear intent + cancel session; optional `UserNotifierPort` feedback |
| `shortcut/register-app-shortcut.ts` | Register shortcut; `DEFAULT_SHORTCUT`; publish failure via notifier |

## Ports (budget: 12)

| Port | Purpose | Implementation home |
|------|---------|---------------------|
| `SettingsStorePort` | Load/get/update/onChange/flush | `infrastructure/settings` |
| `SettingsSaveFailurePort` | Persist failure UX | `infrastructure/settings` |
| `SleepBlockerPort` | Start/stop power-save blocker | `infrastructure/sleep` |
| `MainToRendererNotifierPort` | Publish **`AppPushEvent`** only | `infrastructure/notification` |
| `UserNotifierPort` | OS user-visible feedback (not renderer push) | `infrastructure/notification/os-user-notifier` |
| `ClockPort` | `perfNow` / `wallNow` | `infrastructure/clock` |
| `SchedulePort` | Delay + cancel | `infrastructure/schedule` |
| `AutoLaunchPort` | Login-item sync | **`main/auto-launch.ts`** (not infrastructure) |
| `GlobalShortcutPort` | Register / unregister | `infrastructure/shortcut` |
| `BatterySensorPort` | Percent + power-source events | **`main/platform/battery-sensor.ts`** (`createBatterySensor`; percent via `battery-percent`) |
| `LoggerPort` | Structured logs | `infrastructure/logging` |
| `UpdaterPort` | `init` / `stop` / `checkNow` | `infrastructure/updater` |

Do not add ports for Tray/Menu/BrowserWindow chrome.

### AppPushEvent (notifier)

```ts
| { type: "settings-changed"; settings: AppSettings }
| { type: "session-status"; status: SessionStatusResponse }
| { type: "shortcut-registration-failed"; accelerator: string }
| { type: "auto-updater-status"; status: AutoUpdaterStatus }
```

Infrastructure `broadcast-notifier` maps these to `PUSH_CHANNELS`.

### Settings reactions

`SettingsReactionService` is the **only** store `onChange` subscriber for field side effects:

| Field change | Reaction |
|--------------|----------|
| any change | `reconcileSession` (no-op for preference; must not kill live sessions) |
| `preventSleep` | `recomputeSleepPrevention` |
| `launchAtLogin` | `autoLaunch.sync` |
| `batteryThreshold` | `reconfigureBattery` |
| `sleepBlockMode` | recompute only if blocker active OR intent OR session |
| `shortcut` | re-register global shortcut |
| `preventSleep` \| `batteryThreshold` \| `shortcut` | publish `settings-changed` (`RENDERER_VISIBLE_SETTINGS_KEYS`) |

`UpdateSettings` validates + persists only — never runs reactions inline.

## Rules

- No `electron`, `electron-log`, `setTimeout` (use `SchedulePort`), or main/infrastructure imports.
- No `IPC_CHANNELS` / push channel string literals; use `AppPushEvent` on the notifier port.
- Session engine cancels outstanding schedule handles on cancel/cleanup/expiry.
- `reconcileSessionState` must remain a no-op regarding preference null (must not cancel live sessions).
- Prefer factories (`createX(deps)`) matching existing style; no DI container.
- Low-battery auto-stop may take optional `userNotifier` + `getLastKnownPercent`; production wires both from composition.
- Log tags: prefer `[session]`, `[settings-reactions]`, `[shortcut]`, `[low-battery]` (low-battery use case default), `[composition]` (see root AGENTS.md). `[notify]` is used by the OS notification adapter.

## Tests

Pure unit tests under `tests/application/` with fake ports (especially fake `SchedulePort` for expiry). Notifier mocks expect `publish({ type: "…", … })`. Low-battery tests cover optional `UserNotifierPort.notify`. `ports-compile.test.ts` guards the port barrel surface (type-only exports).

Persistence coalescing and updater single-flight live in infrastructure/main tests, not here.
