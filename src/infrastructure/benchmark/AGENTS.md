# Infrastructure Benchmark Mode

Production benchmark harness when `AMPHETAMINE_BENCHMARK=1`. Not a normal product path; `AppShell` skips `composition.initUpdater()` when `isBenchmarkMode()`.

## Files

| File | Role |
|------|------|
| `benchmark.ts` | Configure userData, timer hooks, run measurements, write `AMPHETAMINE_BENCHMARK_RESULT:` line |
| `benchmark-env.ts` | Env names, `isBenchmarkMode()`, `getBenchmarkScenario()`, active-session duration constant |
| `benchmark-metrics.ts` | Summaries / runtime info; artifact includes `scenario` + battery counters |
| `index.ts` | Public barrel |

## Scenarios

| Scenario | Env / CLI | Behavior |
|----------|-----------|----------|
| `idle` (default) | `--scenario idle` or omit | Idle samples without starting a session |
| `active-session` | `--scenario active-session` | Starts timed session via renderer `window.api.session.start(30)` before sampling |

Artifact fields (schemaVersion 1, additive): `scenario`, `scenarioMeta.{name,sessionDurationMinutes}`.

## Battery counters (benchmark-gated)

Semantic counters on `timerCounters.battery` (zeros outside benchmark mode):

| Key | Meaning |
|-----|---------|
| `scheduled` | Periodic poll interval started |
| `callbackAttempted` | Guard entry ran (a coalesced follow-up check is one more entry) |
| `guardedSkipped` | Early exit (threshold/AC/inactive/disposed/re-entry while a read is in flight) |
| `completedRead` | Charge-percent read attempted past gates (counted even when the result is revoked as stale) |

Owned by `main/battery-monitor.ts` (`getBatteryBenchmarkCounters` / `resetBatteryBenchmarkCounters`).

## Bootstrap hooks

- Early in `main/index.ts`: `configureBenchmarkEnvironment()` + `installBenchmarkTimerCounters()`.
- After measurements: print stdout protocol line and quit.
- Renderer countdown counters only when `window.api.benchmark.isEnabled()` (preload reads the same env name).

## Rules

- Protocol and JSON artifact shape stay stable for `scripts/benchmark-performance.ts`.
- Dynamic imports of `main/tray` and `main/settings-window` for measurement only; do not invert product bootstrap into the harness.
- Import from `src/infrastructure/benchmark/` (or the barrel). There are no `main/benchmark*` shims.
- Do not change battery policy/intervals for measurement.
- Log tag: `[benchmark]` if logging is added; result line is stdout protocol for the harness script.
- Artifacts belong under `artifacts/` (or temp dirs), never under `src/` or `shared/`.
