# Amphetamine

**Generated:** 2026-09-05
**Commit:** 588e9bf
**Branch:** develop

Tray-only Electron app for **macOS and Windows**. Prevents system sleep through user intent or timed sessions. Battery-aware auto-disable, global shortcut, settings window, auto-updater, and benchmark harness.

## Overview

| Layer | Tech |
|------|------|
| Runtime | Bun 1.4.2+ / Node `>=26 <27` |
| TypeScript | Dual: native **7.x** (`@typescript/native` owns workspace `tsc`) for typecheck; **6.x** (`typescript@6`) for the JS API / ESLint until 7.1 programmatic API lands |
| Electron | `^44.2.0` (package pin; do not downgrade below patched 44.x) |
| Build | Rslib main/preload to CJS + Rsbuild renderer (popover + settings + about + utility-dialog) |
| Test | Vitest 5 workspace: domain + application + main (Node) + renderer (jsdom) |
| Lint | ESLint 10 flat; sticky type-safety rules as errors for `src/` |
| Layers | Clean Architecture Lite: `domain` → `application` → `infrastructure` / presentation (`main`, `preload`, `renderer`) |

Product platforms: **darwin** and **win32**. OS differences go through thin main-process platform adapters (`src/main/platform/`). Do not scatter unguarded macOS-only Electron APIs. Renderer is vanilla TypeScript; no UI framework. Linux is out of scope.

## Source Map

```text
src/domain/               Pure types and rules (no Electron, no Node I/O)
src/application/          Use cases + 12 port interfaces (no Electron)
src/infrastructure/       Adapters + hybrid updater + benchmark harness
src/main/                 AppShell, WindowGraph, composition, façades, platform/
src/preload/              window.api + utility-dialog preload
src/renderer/             popover + settings + about + utility-dialog
src/shared/               IPC contracts; private dialog channels; domain re-exports
src/assets/               checked-in generated PNGs
scripts/                  Bun tooling, icons, sticky/layer guards
build/                    entitlements, fuses
.github/workflows/        CI / CD / develop beta
lib/, dist/, artifacts/   generated — do not add AGENTS.md
```

Dependency rule: **domain** and **application** must not import `electron` / `electron-log` / process roots. Enforced by `bun run typecheck:layers` and ESLint restricted imports.

## Where to Look

| Task | Location | Notes |
|------|----------|-------|
| Add IPC channel | `src/shared/types.ts`, `src/preload/index.ts`, `src/main/ipc.ts` | Keep `IPC_CHANNELS` (16 names), `IpcChannelMap`, preload `WiredChannels`, and handlers in sync |
| Add settings field | `src/domain/settings/app-settings.ts`, `src/domain/settings-validation/validators.ts` | Extend `AppSettings`, `DEFAULT_SETTINGS`, `VALIDATORS`; migrate legacy keys in `migrateRawSettingsRecord`; shared re-exports stay available |
| Domain pure rules | `src/domain/` | `isEffectivelyActive`, duration validation, threshold, `PerfTimestamp` |
| Application use cases | `src/application/` | Session engine, recompute/toggle sleep, settings reactions, low-battery, shortcut |
| Port interfaces | `src/application/ports/` | Closed budget of **12** ports; see `ports/index.ts` |
| Process graph / windows | `src/main/app-shell.ts`, `src/main/process/` | AppShell ready/quit (composition before IPC); WindowGraph sole `BrowserWindow` factory; hide-on-close warm cache |
| Main→renderer push | `MainToRendererNotifierPort` + `broadcast-notifier` | Application publishes `AppPushEvent`; adapter maps to `PUSH_CHANNELS` |
| OS user notifications | `UserNotifierPort` + `os-user-notifier` | Low-battery OS `Notification` (not a renderer push) |
| Settings persistence | `src/infrastructure/settings/`, façade `src/main/settings.ts` | Atomic write; coalesced one-in-flight + one pending batch |
| Sleep blocker | `src/infrastructure/sleep/`, façade `src/main/sleep-prevention.ts` | Sole `powerSaveBlocker` owner |
| Session runtime | `src/application/session/`, façade `src/main/session-timer.ts` | Handle injection only; no module-level session globals |
| Settings → system side effects | `SettingsReactionService` (application), wired in composition | Single `onChange` subscriber; UpdateSettings is persist-only |
| Login items | `src/main/auto-launch.ts` (`AutoLaunchPort` view) | Implemented in main (not infrastructure) |
| Tray/menu | `src/main/tray.ts`, `src/assets/AGENTS.md` | Icon = effective active; checkbox = user intent |
| Renderer popover | `src/renderer/index.ts` | Domain `isEffectivelyActive`; mode-stable session actions; chips start session only |
| Settings UI | `src/renderer/settings/AGENTS.md` | System Settings groups; debounced saves; shortcut recorder; warm-cache focus clear |
| About window | `src/renderer/about/`, WindowGraph `showAbout` | Built `about.html`; dismiss Close/Escape (no OK); github allowlist |
| Utility dialog | `src/renderer/utility-dialog/`, WindowGraph `presentUtilityDialog` | Dedicated preload; single-flight; height settle before fade-in |
| Hybrid auto-updater | `src/infrastructure/updater/` (+ main IPC façade) | `showUserDialog` inject; `setFeedURL` from package repo; single-flight checks; needs `latest-mac.yml` / `latest.yml` on release |
| Utility Dock / dialogs | `src/main/platform/utility-presentation.ts` | Refcounted macOS foreground; prefer `isDarwin` / `isWin32` |
| Benchmark mode | `src/infrastructure/benchmark/`, `scripts/benchmark-performance.ts` | `idle` \| `active-session`; requires built `lib/` |
| Test mocking | `tests/AGENTS.md` (+ main/renderer) | Domain/application pure; main mocks Electron |
| Dev/build/CI | `scripts/`, `build/`, `.github/workflows/` | Parallel prod build; CI must publish mac update feeds |

## Code map

Sentrux DSM: 163 nodes, 325 edges, all below-diagonal (downward layering). LSP unconfigured — refs from import search.

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `createAppShell` | fn | `src/main/app-shell.ts` | index + tests | Ready/quit topology |
| `createAppComposition` | fn | `src/main/composition-root.ts` | AppShell | Ports, reactions, updater inject |
| WindowGraph | module | `src/main/process/window-graph.ts` | 4 façades + tests | Sole `BrowserWindow` factory |
| `IPC_CHANNELS` | const | `src/shared/types.ts` | ~18 | Public 16-name wire budget |
| `AppPushEvent` | union | `src/application/ports/` | application | Semantic push (no channel literals) |
| `AppSettings` | type | `src/domain/settings/app-settings.ts` | ~11+ via shared | Settings contract |
| `VALIDATORS` | const | `src/domain/settings-validation/` | store + tests | Disk load + merge |
| `isEffectivelyActive` | fn | `src/domain/session/effective-active.ts` | tray/sleep/popover | Intent OR session |
| `createSessionEngine` | fn | `src/application/session/` | session-timer façade | Handle injection |
| `SettingsReactionService` | factory | `src/application/settings/` | composition only | Sole `onChange` subscriber |
| `configureHybridAutoUpdater` | fn | `src/infrastructure/updater/` | UpdaterPort | Single-flight + injected dialogs |
| `presentUtilityDialog` | fn | WindowGraph | composition `showUserDialog` | Aurora alerts |

## Log tags (production)

`[main]` bootstrap · `[app-shell]` graph · `[composition]` wiring · `[settings-reactions]` · `[session]` · `[settings]` store · `[sleep]` · `[battery]` detector · `[low-battery]` use case · `[shortcut]` · `[ipc]` · `[auto-launch]` · `[auto-updater]` · `[security]` · `[benchmark]` · `[notify]` OS toasts

## Conventions

- Source is ESM TypeScript; main/preload output is CJS. Use `.js` extensions in TS imports.
- Type-safe IPC: `typedHandle()` in main, typed `invoke<K>()` in preload, exhaustive `WiredChannels` check.
- Main/infrastructure import Electron via `electron/main` (and `electron/common` for `shell`/`nativeImage`); preload uses `electron`.
- Application never imports `IPC_CHANNELS`; publish `AppPushEvent` through `MainToRendererNotifierPort`.
- Session **preference** is `defaultSessionDuration`; live session state is engine handle + `SESSION_STATUS*` pushes only.
- `PerfTimestamp` values come from `asPerf(n)`. Do not raw-cast timestamps.
- `SessionStatusResponse`, `SessionStartResponse`, updater status, and benchmark guards are discriminated/runtime-checked contracts.
- Settings init is async; writes use UUID temp file + rename with **coalesced batching** (one active write + one pending merge); quit flushes via `flushSettingsWriteChain()`.
- Settings→renderer pushes (`settings-changed`) only when a renderer-visible key changes (`preventSleep` \| `batteryThreshold` \| `shortcut`).
- Popover `#session-actions` rebuilds only on running/idle **mode** change (stable cancel-button identity); hide transitions are coalesced in WindowGraph.
- UI strings in constants files; styles in CSS. Format: double quotes, semicolons, 2-space, print width 100.
- Sticky TS (`bun run typecheck:sticky`): strict family + `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`.
- Sticky ESLint `src/`: `no-explicit-any`, `no-unsafe-*`, `no-floating-promises`, `strict-boolean-expressions`, `ban-ts-comment`, `no-non-null-assertion`, `no-unnecessary-condition`.

## Anti-Patterns

- Never call `powerSaveBlocker.start/stop` outside `src/infrastructure/sleep`. Never bypass `validateSender()`.
- Never expose mutable settings; clone snapshots. Never mutate `DEFAULT_SETTINGS`.
- Never use `Date.now()` for elapsed session timing (`ClockPort.wallNow()` for sleep-resilient expiry).
- Never call macOS-only Electron APIs without `isDarwin()`. Battery shell-outs only in `platform/battery-percent.ts`.
- Never `JSON.parse(...) as T`, `as any`, `@ts-ignore`, or `@ts-expect-error` in `src/`.
- Never import Electron in renderer (preload only) or into domain/application. Never import `scripts/` from runtime. Never import `IPC_CHANNELS` into application.
- Never create BrowserWindows outside `main/process/window-graph` (except tests).
- Never dual-subscribe settings reactions. Never reintroduce `setActiveSessionTimer` or mirror session into settings.
- Never add docs under `lib/` / `dist/` / `artifacts/`. Never ship before fuse/signing. Never drop sticky pins without a CI change.

## Commands

```bash
bun run dev                    # rslib watch x2 + rsbuild dev + Electron
bun run test                   # Vitest workspace
bun run test:coverage          # v8 coverage
bun run build                  # parallel main + preload + renderer (scripts/build-production.ts)
bun run benchmark:performance  # requires build; optional --scenario idle|active-session
bun run package                # mac arm64 DMG/ZIP + fuses; also :x64, :universal, :dir, :win, :win:arm64
bun run typecheck              # native tsc -b (TypeScript 7 via @typescript/native)
bun run typecheck:tests        # native tsc tests project
bun run typecheck:sticky       # assert sticky strict compiler flags
bun run typecheck:layers       # assert domain/application import boundaries
bun run lint                   # ESLint src/ tests/ (uses typescript@6 API package)
bun run format                 # Prettier src/tests targets
bun run clean                  # remove lib/dist outputs
```

## Notes

- **Version:** `1.12.1` (tags `v1.12.1`; beta `v1.12.1-beta.N`). Electron pin `^44.2.0`. Runtime deps: `electron-log` + `electron-updater` only.
- Effective sleep = `preventSleep` **OR** session. Tray **icon** = effective; checkbox = intent. Low-battery auto-stop clears both + OS `UserNotifierPort`.
- Popover chips start a session only (do not write preference). Settings duration select starts **and** writes `defaultSessionDuration`.
- Utility surfaces share `--utility-window-bg` (`#0D1117` only in `utility-tokens.css`). Fancy aurora bloom on `.icon-aurora` only; `bindIconAuroraStagePause` before any About await. Settings stays `icon-aurora--static`.
- Settings/About/utility-dialog: **hide-on-close** warm cache; `*WantsVisible`; refcounted Dock via `utility-presentation`. Windows: taskbar + `titleBarOverlay`. About dismisses via system Close / Escape (no in-content OK).
- Updater: injected `showUserDialog` → `presentUtilityDialog` (not `dialog.showMessageBox`). Info-only hides the OK row. Releases must publish `latest-mac.yml` + `latest.yml`. Repo: `iworkforces/Amphetamine`.
- Utility-dialog private channels stay out of the public 16-name `IPC_CHANNELS` budget. `hardenWebContents` denies `window.open`; About allowlists the package GitHub repo via `shell.openExternal`.
- Login items: darwin `openAsHidden: true`; win32 `openAtLogin` only. Sleep default `prevent-display-sleep`.
- Develop CI: lint/test. **Beta** on `develop` publishes `vX.Y.Z-beta.N` (`prerelease: true`). Production CD is `workflow_run` on `main` only.
