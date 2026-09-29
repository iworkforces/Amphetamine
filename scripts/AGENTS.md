# Scripts - Local Tooling

Developer-only Bun/Node scripts. Runtime app code must not import from here. Scripts own dev orchestration, production build parallelism, generated assets, benchmark harness execution, update-feed merge, and sticky typecheck guards.

## Files

| File | Role |
|------|------|
| `dev.ts` | Starts Rslib main/preload watchers, Rsbuild dev server, waits for readiness, launches Electron |
| `build-production.ts` | Parallel production compile: main + preload + renderer; labels output; kills siblings on failure |
| `benchmark-performance.ts` | Runs built app in benchmark mode; writes harness JSON; supports `--scenario idle\|active-session` |
| `merge-latest-yml.ts` | Merge dual-arch electron-builder `latest*.yml` feeds for GitHub Releases (CD) |
| `stage-release-assets.py` | Stage unique basenames for CD publish (`artifacts/release-staging/`; feeds + binaries) |
| `release-matrix.ts` | Validate production artifact matrix (`source` vs `staged`); CLI `verify-release-matrix.ts` |
| `beta-release-matrix.ts` | Validate develop-beta binaries (`-beta-N`); CLI `verify-beta-release-matrix.ts` |
| `check-sticky-ts.mjs` | Asserts sticky TypeScript compiler flags via native `tsc --showConfig` (prefers `@typescript/native`) |
| `check-layer-imports.mjs` | Asserts domain/application import boundaries (no Electron / outer layers) |
| `generate-app-icon.mjs` | Generates `build/icon.icns`, `build/icon.ico`, and `src/assets/settings-hero-icon.png` |
| `generate-coffee-tray-icons.mjs` | Generates 8 tray PNGs for active/inactive × light/dark × scale |

## Dev Orchestration

`dev.ts` flow:

1. Start `bun x rslib build --watch -c rslib.config.ts`.
2. Start `bun x rslib build --watch -c rslib.config.preload.ts`.
3. Start `bun x rsbuild dev --port 5173` (popover + settings + about + utility-dialog environments).
4. Wait for `lib/main/index.cjs` and `lib/preload/index.cjs` (preload multi-entry also builds `utility-dialog.cjs`).
5. TCP-connect to `localhost:5173` before Electron launch.
6. Launch `bun x electron . --disable-gpu-sandbox --log-level=3` with `DEV_SERVER_URL`.
7. Kill child processes on Electron exit or signals.

## Production build (parallel)

`bun run build` → `scripts/build-production.ts`:

- Spawns main (rslib), preload (rslib), and renderer (rsbuild) **concurrently** with `NODE_ENV=production`.
- Prefixes child stdout/stderr with `[main]` / `[preload]` / `[renderer]`.
- On first nonzero exit: SIGTERM remaining siblings, then exit nonzero.
- Verifies outputs: `lib/main/index.cjs`, `lib/preload/index.cjs`, `lib/preload/utility-dialog.cjs`, `lib/renderer/{index,settings,about,utility-dialog}.html`.
- Windows-safe (no POSIX job-control syntax). Focused scripts `build:main` / `build:preload` / `build:renderer` remain for single-target builds.

## Sticky Typecheck Guard

- `check-sticky-ts.mjs` runs `tsc -p tsconfig.json --showConfig` and `tsconfig.tests.json`.
- Resolves **TypeScript 7 native** `tsc` from `@typescript/native` when present (side-by-side with `typescript@6` for the JS API / ESLint).
- Fails if sticky flags are missing or not `true` (strict family + project extras such as `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, …).
- Invoked by `bun run typecheck:sticky` and the CI lint job.
- Do not weaken the flag list without an intentional sticky-policy change in root `AGENTS.md`.

## Layer Import Guard

- `check-layer-imports.mjs` scans `src/domain` and `src/application` for forbidden imports.
- Domain: no `electron*`, `main`, `application`, `infrastructure`, `preload`, `renderer`.
- Application: no `electron*`, `main`, `infrastructure`, `preload`, `renderer` (may import domain + shared).
- Also blocks package imports of `electron`, `electron-log`, `electron-updater`.
- Invoked by `bun run typecheck:layers` and the CI lint job.

## Benchmark Harness

- Run `bun run build` before `bun run benchmark:performance`; requires built `lib/main/index.cjs` and `lib/renderer/index.html`.
- Launches Electron with `NODE_ENV=production`, `AMPHETAMINE_BENCHMARK=1`, optional `AMPHETAMINE_BENCHMARK_SCENARIO`, temp user-data, GPU sandbox disabled.
- CLI: `--label`, `--out` (required), optional `--baseline`, optional `--scenario idle|active-session` (default idle).
- Waits for stdout line prefix `AMPHETAMINE_BENCHMARK_RESULT:`; writes JSON under `artifacts/` (or `--out` path).

## Update feed merge (CD)

- `merge-latest-yml.ts` combines per-arch `latest-mac.yml` / `latest.yml` from CI matrix jobs into one release asset.
- Usage: `bun run scripts/merge-latest-yml.ts a.yml b.yml --out out.yml`.
- Unit tests: `tests/main/merge-latest-yml.test.ts`, `tests/main/release-matrix.test.ts`.

## Release asset staging (CD)

- `stage-release-assets.py` copies arch-job artifacts into a flat staging dir with unique basenames for `gh release upload`.
- Invoked from CD (not runtime). Feeds come from `update-feed/`; binaries from arch dirs; collisions must not fail the job (see workflows AGENTS).
- CD runs `verify-release-matrix.ts source` after artifact download, then `staged` after `stage-release-assets.py`. Beta `release` runs `verify-beta-release-matrix.ts`.

## Conventions

- TypeScript scripts use `#!/usr/bin/env bun`.
- `Date.now()` is acceptable for process wait timeouts; app session timing rules do not apply here.
- Use TCP readiness checks for the dev server. Do not replace with fixed sleeps.
- Icon scripts use ESM `fileURLToPath(import.meta.url)` for dirname behavior.
- Generated icon assets are checked-in runtime/build resources; see `src/assets/AGENTS.md`.

## Anti-Patterns

- Never launch Electron before both CJS build outputs exist.
- Never add runtime app dependencies on `scripts/` files.
- Never rename tray icon outputs without updating generator scripts, `src/assets/AGENTS.md`, and `src/main/tray.ts`.
- Never treat benchmark output as source; it is generated evidence.
- Never remove sticky flags from `check-sticky-ts.mjs` to greenwash a failing build.
- Never ship a production release without merged `latest-mac.yml` / `latest.yml` on the GitHub release.

## Commands

```bash
bun run dev
bun run build
bun run build && bun run benchmark:performance -- --scenario idle --out artifacts/perf/idle.json
bun run typecheck:sticky
bun run typecheck:layers
bun scripts/generate-app-icon.mjs
bun scripts/generate-coffee-tray-icons.mjs
bun run scripts/merge-latest-yml.ts arm64/latest-mac.yml x64/latest-mac.yml --out latest-mac.yml
bun run scripts/verify-release-matrix.ts source
bun run scripts/verify-beta-release-matrix.ts 2.0.5 1
```
