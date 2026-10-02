# Tests — Vitest Workspace

Four Vitest projects: pure domain/application, main (Node + Electron mocks + infrastructure), renderer (jsdom). Process-specific rules live in child docs.

## Structure

```text
tests/
  setup.main.ts        baseline Electron mock for main project
  domain/              pure domain unit tests (no Electron)
  application/         use-case tests (ports mocked / fakes)
  main/                Node + mocked Electron; see main/AGENTS.md
  infrastructure/      adapters (run under main project)
  shared/              shared contract tests (main project)
  renderer/            jsdom UI; see renderer/AGENTS.md
```

## Vitest workspace

| Project | Environment | Includes | Coverage include |
|---------|-------------|----------|------------------|
| `domain` | `node` | `tests/domain/**/*.test.ts` | `src/domain/**/*.ts` |
| `application` | `node` | `tests/application/**/*.test.ts` | `src/application/**/*.ts` |
| `main` | `node` | `tests/main/**`, `tests/infrastructure/**`, `tests/shared/**` | `src/main/**`, `src/infrastructure/**`, `src/shared/**` |
| `renderer` | `jsdom` | `tests/renderer/**/*.test.ts` | `src/renderer/**/*.ts` |

- Root coverage `include`: `src/**/*.ts` (thresholds: lines/functions/branches **90%**).
- Coverage excludes (see `vitest.workspace.ts`): type-only ports (`**/*.port.ts`), pure re-export barrels, `infrastructure/benchmark/benchmark.ts`, Electron UI entry shells (`main/index`, `main/tray`, `main/auto-updater`, about/settings façades + renderer shells, `hybrid-auto-updater`, `benchmark-countdown`).
- Main project **aliases** `electron/main` and `electron/common` → `electron` so production process imports work under Node mocks.
- `passWithNoTests: true` for filtered project runs.
- `pool: "threads"`.
- `typecheck:tests` uses `tsconfig.tests.json` (sticky strict; unused locals/params relaxed).
- Sticky ESLint full strength on `src/`; tests relax `no-unsafe-*`, non-null assertions, `no-unnecessary-condition`.

## Shared conventions

- Prefer filenames mirroring source.
- `vi.resetModules()` + dynamic import when module singletons matter.
- Prefer `vi.advanceTimersByTimeAsync()` over real sleeps.
- Cover exhaustive branches for discriminated unions.
- Mock `electron-log` for main modules that import it; never in renderer.
- Settings fixtures: spread `DEFAULT_SETTINGS` (includes `defaultSessionDuration`, `sleepBlockMode`).
- `createSessionTimer` deps: `{ broadcast, onSessionActiveChange?, powerMonitor? }` — no settings writers; **no** module-level session globals.
- `TrayDeps` must include `checkForUpdates` and `getEffectiveActive`.
- Battery monitor mocks must include `reconfigure`; benchmark counter tests mock `isBenchmarkMode`.
- Composition: session IPC deps throw before `init()`; mock hybrid updater / packageInfo / platform when constructing `createAppComposition`.
- Application notifier mocks expect `publish({ type: "…", … })` (`AppPushEvent`), not channel strings.
- `SETTINGS_CHANGED` / `settings-changed` only for `preventSleep` \| `batteryThreshold` \| `shortcut`.
- Updater tests mock `autoUpdater.setFeedURL` and assert single-flight `checkForUpdates`; hybrid dialogs use injected `showUserDialog` (not `dialog.showMessageBox`).
- Composition tests mock `presentUtilityDialog` when constructing the real composition root.
- No real filesystem, Electron windows, network, or OS battery queries in unit tests.

## Commands

```bash
bun run test
bun run test -- tests/domain
bun run test -- tests/application
bun run test -- tests/main
bun run test -- tests/renderer
bun run test:coverage
bun run typecheck:tests
bun run typecheck:sticky
bun run typecheck:layers
```

## Notes

- Preload unit tests live under `tests/main/preload.test.ts`.
- Process-graph suites: `app-shell.test.ts`, `window-graph.test.ts` (incl. hide coalesce, warm cache, wantsVisible, utility foreground), `secure-web-preferences.test.ts`, `utility-presentation.test.ts`, `composition-wiring.test.ts`, `composition-root.test.ts`.
- Application suites cover session engine, sleep recompute/toggle, settings reactions/update/get, low-battery auto-stop (incl. optional `UserNotifierPort`), and port barrel compile.
- Perf/coalesce suites: settings write batching, updater single-flight, renderer session-action identity, `merge-latest-yml.test.ts`, `build-production.test.ts`.
- Release matrix: `release-matrix.test.ts`, `beta-release-matrix.test.ts` (script tests live under `tests/main/`). Battery sensor: `battery-sensor.test.ts`. Packaged Windows navigation: `security-validation.test.ts`.
- **62** test files (Vitest 5 workspace; refresh counts when the suite grows).
- Renderer aurora: `about.test.ts` + `utility-dialog.test.ts` cover fancy leaf fixtures and warm-cache `.is-paused` toggles; main WindowGraph still owns presentation/single-flight coverage.
