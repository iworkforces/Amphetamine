# Repository Context

## Scope and Method

This analysis covers the tracked repository at `1e9a20be5b51aa5028ca984f639cba58c3dd6e27` on `develop`. The initial working tree was clean. An inventory of 249 tracked files preceded delegation; five read-only reviewers examined architecture, runtime behavior, quality/security/performance, delivery, and developer use. The coordinator read the applicable guidance, reconciled reports against source, and closed reported gaps in preload, utility-window, configuration, and release paths. Only this file and the three proposal files are authorized outputs. None of the proposals has been implemented.

Repository paths and symbols below are evidence references. Observed facts describe source or configuration, not successful execution. Inferences and unresolved questions are labeled explicitly. Tests, builds, installations, native UI, signing, publishing, and benchmarks were not run; those commands can create files outside the four authorized outputs. The analysis therefore does not certify runtime correctness or current CI status.

The knowledge graph used project `Volumes-Data-oss-oc-Amphetamine`, generation `2026-09-27T09:35:45Z`, with Tier 2 verification and exact-path coverage checks. Reported coverage was checked against source; child TypeScript configurations with uncertain graph freshness were read directly. A clean graph coverage signal is not proof of exhaustive parsing. Binary and generated areas are classified in the ledger rather than treated as missing source.

A read-only librarian and Oracle reviewed uncertain interpretations, proposed contracts, and potentially stale external claims. Their remaining limitations are recorded below. The humanizer skill was applied separately to the evidence context and each proposal, preserving the required headings, technical boundaries, commands, and rubric structure.

## Repository Map

Amphetamine is a tray-only Electron sleep-prevention application for macOS and Windows. It combines persistent user intent with timed or indefinite sessions, battery-aware stopping, a global shortcut, login settings, and a hybrid updater. Linux is outside the product scope (`README.md`, `src/main/platform/AGENTS.md`).

`package.json` declares version `1.13.2`, Electron `^44.4.5`, Node `>=26 <27`, and Bun `>=1.4.2`, with package manager `bun@1.4.2`. Main and preload code compile to CJS through Rslib; Rsbuild produces four vanilla-TypeScript renderer entries. The manifest declares Vitest `^5.0.2`, ESLint `^10.11.0`, Rsbuild `^2.2.10`, and Rslib `^1.0.2`. Type checking uses the `@typescript/native` alias to TypeScript 7; ESLint's programmatic API uses the separate TypeScript 6 alias. Runtime dependencies are `electron-log` and `electron-updater`. These are manifest declarations, not an installation or support-status audit.

| Area | Responsibility and entry points |
| --- | --- |
| `src/domain/` | Settings types/validation, duration rules, effective-active rule, branded performance timestamps |
| `src/application/` | Session engine, sleep recomputation/toggle, settings use cases/reactions, low-battery stopping, shortcut registration, twelve ports |
| `src/infrastructure/` | Atomic settings persistence, Electron sleep/shortcut/updater/notification adapters, clocks/scheduling/logging, benchmark instrumentation |
| `src/main/` | `index.ts` lifecycle, `app-shell.ts` topology, `composition-root.ts` dependency wiring, IPC/tray, platform adapters, `process/window-graph.ts` window ownership |
| `src/preload/` | Public `window.api` and separate `utilityDialogApi` bridges |
| `src/renderer/` | Popover, Settings, About, utility dialog, shared styles and motion behavior |
| `src/shared/` | Typed IPC contracts, private dialog contracts, domain re-exports |
| `tests/` | Pure domain/application tests, mocked Electron/infrastructure/shared tests, jsdom renderer tests |
| `scripts/`, `build/`, `.github/workflows/` | Development/build orchestration, asset generation, benchmarks, packaging/fuses, feed merging/staging, CI and releases |
| Root and `docs/` | Tool configuration, developer guidance, product README, historical implementation plans and Windows QA checklist |

Inference: the repository has disciplined boundaries, strict checks, and substantial behavioral test seams, but documentation drift and excluded integration surfaces prevent calling it release-verified on source inspection alone.

## Architecture and Key Flows

The intended dependency direction is domain to application to adapters/presentation. Domain code cannot import Electron, Node I/O, or outer layers. Application code uses ports and domain rules; semantic `AppPushEvent` values cross the notification port instead of IPC channel strings. `scripts/check-layer-imports.mjs`, `eslint.config.mjs`, and area guidance enforce these boundaries. `src/application/ports/index.ts` is a closed twelve-port budget, including the reserved battery sensor port. Main-platform adapters remain in `src/main/platform/`; moving them to infrastructure is not a prerequisite for changes.

Normal startup runs `src/main/index.ts:62` -> `createAppShell().init()` -> tray-only policy/popover creation -> awaited composition initialization -> public IPC -> tray -> updater. `src/main/composition-root.ts:143` loads settings, synchronizes login behavior, recomputes sleep prevention, creates the session/battery handles, registers the shortcut, and subscribes the settings reaction service. IPC receives a session handle through `getIpcDeps`; `requireSessionTimer` fails before initialization. `src/main/process/window-graph.ts` is the only production `BrowserWindow` factory.

Persistent intent and live session activity are independent inputs to `isEffectivelyActive`. Sleep recomputation owns the resulting physical blocker through `SleepBlockerPort`; only `src/infrastructure/sleep/` calls `powerSaveBlocker.start/stop`. The tray icon reflects effective activity, while its checkbox reflects persistent intent (`src/main/tray.ts`, `src/application/sleep/recompute-sleep-prevention.ts`). Cancelling a session must not silently clear separately enabled intent.

Settings requests flow through preload -> main IPC -> `createUpdateSettings` -> the infrastructure store. The store validates and merges changes, allows one active write and one pending merged batch, writes a UUID temporary file with restrictive permissions, then renames it before publishing the new snapshot. Callers receive their own rejected keys, and readers receive clones (`src/infrastructure/settings/`, `src/domain/settings-validation/`). One composition-owned `SettingsReactionService` subscriber applies system effects. The legacy `sessionDuration` migration belongs to settings validation; `defaultSessionDuration` is a preference, never the live timer state.

Normal quit has one `before-quit` owner in `src/main/index.ts:84`. AppShell races settings flush against 2000 ms, then destroys the tray, cleans composition, and destroys windows before the entry point exits. Composition cleanup removes reactions, battery/session resources, the blocker, shortcut, and updater (`src/main/app-shell.ts:75`, `src/main/composition-root.ts:212`). That flush timeout is a best-effort bound, not a durability guarantee.

## Product and Runtime Behavior

The session engine uses injected clock/scheduler ports, performance timestamps for elapsed timing, and wall-clock expiry reconciliation on resume (`src/application/session/session-engine.ts`, `src/main/session-timer.ts`). A duration of `null` means indefinite; timed sessions accept at most 1440 minutes. Popover chips start sessions without saving the preference. Settings duration selection starts a session and saves the default. Setting the default to `null` must not cancel a live session (`src/renderer/index.ts`, `src/renderer/settings/`, `tests/main/session-timer.test.ts`).

Battery monitoring checks only when relevant, polls every 60 seconds, coalesces concurrent reads, and treats unavailable percentages as unavailable rather than low battery. OS queries are confined to `src/main/platform/battery-percent.ts`. The application low-battery use case requests persistent intent clearing, cancels the session, and sends an OS notification. Login settings and window chrome differ by platform; macOS-only APIs are guarded (`src/main/battery-monitor.ts`, `src/main/auto-launch.ts`, `src/main/platform/`).

Settings, About, and the utility dialog hide on user close and retain warm renderer state. Visibility-intent flags prevent late readiness events from reopening dismissed windows. Each visible utility surface holds a foreground reference; the last release returns to tray-only mode (`src/main/process/window-graph.ts`, `src/main/platform/utility-presentation.ts`). Quit force-destroys these windows. The utility dialog joins concurrent presentations into one promise, uses its own preload/private IPC, applies new payloads without reload, and measures height before fading in. Its private sender check is bound to the active window's webContents ID (`window-graph.ts:613`), distinct from public IPC authorization.

The preload strips Electron event objects from subscriptions and returns unsubscribe functions; renderers unsubscribe on teardown and use local countdown updates rather than per-second IPC. Popover session-action DOM identity is stable within a mode; hide transitions are coalesced. Settings saves are debounced and serialized with pending changes (`src/preload/index.ts`, `src/renderer/index.ts`, `src/renderer/settings/`). About only opens the package repository through a main-process allowlist. Utility content uses text nodes, and aurora activity follows visibility (`src/renderer/about/index.ts`, `src/renderer/utility-dialog/index.ts`). No native or visual QA was performed here.

The updater derives its GitHub feed from package metadata, joins concurrent checks, distinguishes background/manual intent, and injects custom utility dialogs. Background checks do not automatically download updates; manual checks can download/install or offer the release page (`src/infrastructure/updater/hybrid-auto-updater.ts`, `src/infrastructure/updater/electron-updater-port.ts`, `src/main/auto-updater.ts`). Feed publication and runtime update behavior therefore form one operational contract.

## Quality, Security, and Performance

Public IPC accepts the exact normalized packaged `index.html`, `settings.html`, and `about.html` paths or configured development HTTP origins; it rejects child frames and invalid/missing sender URLs (`src/main/ipc-utils.ts:33`). Windows path handling and UNC/traversal cases have dedicated tests. All examined public invoke handlers explicitly validate senders, but `typedHandle` itself only registers the function (`ipc-utils.ts:77`). Guidance claiming automatic validation describes a stronger contract than the implementation. This is a maintenance hazard, not evidence of an unguarded current handler or an exploit.

`createSecureWebPreferences` enables isolation/sandboxing and disables Node integration. WebContents hardening denies unexpected navigation and popup windows. The utility dialog is excluded from the public URL allowlist and uses its separate bridge. Type safety at preload does not validate arbitrary runtime input: `SESSION_START` directly reads `request.durationMinutes` (`src/main/ipc.ts:128`). Its raw height listener validates the sender and coalesces updates for 16 ms, but does not own cleanup for that pending timeout (`ipc.ts:39`).

Observed lifecycle gaps: AppShell's ready-only initialization guard does not coalesce concurrent initialization; cleanup's boolean does not let concurrent callers await the same completion. Composition awaits settings before acquiring resources without a terminal check, and battery reads can report results after disposal (`src/main/app-shell.ts:50`, `src/main/composition-root.ts:143`, `src/main/battery-monitor.ts:114`). Inference: particular interleavings can create resources or invoke effects after cleanup, or dereference cleared composition state. These are source-derived failure paths, not reproduced incidents. Cleanup also stops at a throwing dependency inside composition; AppShell only catches the composition cleanup call as a whole.

Vitest has four projects: domain/application in Node, main plus infrastructure/shared under mocked Electron, and renderer under jsdom. Tests use fake timers and mocked I/O. `vitest.workspace.ts:45` enforces 90% lines, functions, and branches when coverage runs; there is no statement threshold. Several entry shells, hybrid updater, and benchmark runtime are excluded. `passWithNoTests: true` means an empty filtered run is not proof that a focused suite executed. The thresholds do not measure scripts, which lie outside the root `src/**/*.ts` coverage include.

Performance mechanisms include settings write coalescing, single-flight battery/updater work, warm windows, and local renderer countdowns. The benchmark supports idle and active-session scenarios with a stable result prefix, isolated user data, timer/battery/countdown counters, and no updater startup (`src/infrastructure/benchmark/`, `scripts/benchmark-performance.ts`). The harness uses a 60-second child timeout; stdout/stderr buffers are not bounded. `--baseline` records loaded/missing state without comparing performance (`benchmark-performance.ts:229`). No enforced performance threshold was found, and no performance claim is made.

Logs have subsystem tags and errors are generally observable through `electron-log`. Remaining conditional risks include a low-battery success notification before persistence succeeds (`src/application/battery/handle-low-battery-auto-stop.ts:24`) and later settings effects skipped if an earlier dependency throws inside the reaction service's whole-handler catch (`src/application/settings/settings-reaction-service.ts:44`). Neither is selected for implementation in this command.

## Build, Test, Packaging, and Release

`bun run check` expands to `bun run typecheck`, `bun run typecheck:tests`, `bun run typecheck:sticky`, `bun run typecheck:layers`, `bun run lint`, and `bun run test` (`package.json`). Coverage is separate: `bun run test:coverage`. `bun run build` starts main/preload/renderer compilation concurrently, terminates siblings on failure, and verifies seven outputs: main CJS, two preloads, and four renderer HTML files (`scripts/build-production.ts`). `scripts/dev.ts` waits for CJS outputs and TCP readiness before starting Electron; development and benchmark launches disable the GPU sandbox. These launch flags are not packaged renderer security preferences.

Root and process-specific TypeScript configurations, the dual compiler aliases, ESM source with `.js` imports, and CJS packaging must remain consistent. Strict flags and ESLint rules forbid unsafe escape hatches in source. Generated output is under `lib/` and `dist/`; runtime must not import tooling from `scripts/`. Icon generators own checked-in build icons, tray PNGs, and the Settings hero image (`scripts/AGENTS.md`, `src/assets/AGENTS.md`).

CI checks main/develop pushes and pull requests with Node `26.3.0`, Bun `1.4.2`, frozen lockfile installation, the type/lint/test checks, and a source-name guard. Main pushes package macOS arm64/x64 and Windows x64/arm64 after checks, retaining artifacts for 14 days (`.github/workflows/ci.yml`). `electron-builder.yml` creates macOS DMG/ZIP and Windows NSIS/portable outputs. `build/after-pack.cjs` runs fail-closed fuse handling before archive creation; macOS modification requires re-signing and verification. Hardened runtime and notarization are explicitly disabled in current configuration. Their consequences for actual distributions were not tested.

Production CD checks out the successful main CI run's SHA, derives `v<version>`, merges platform feeds, stages unique basenames, and publishes with `gh release create|upload --clobber`. A release with any existing assets causes republishing to be skipped. The current artifact checks require at least one package overall and at least one feed per OS, not every architecture. Single-feed branches copy directly; multi-feed branches call the merger (`.github/workflows/cd.yml:192`). Staging warns and keeps an existing conflicting basename by policy (`scripts/stage-release-assets.py:47`).

The merger's fixed-format parser synthesizes a path-only legacy entry with size zero, accepts any finite numeric explicit size, and loses fields outside its supported shape. Duplicate URLs overwrite prior metadata; preferred top-level metadata can depend on input order (`scripts/merge-latest-yml.ts:60`, `mergeFeeds` at 131). Existing tests cover basic parse, dual-architecture merge, version mismatch, and round-trip behavior (`tests/main/merge-latest-yml.test.ts`). These observations motivate the third challenge without changing release quorum or staging collision policy.

Beta publishing runs from develop/manual dispatch, computes per-version `beta.N`, suffixes binaries, and publishes a prerelease without replacing latest production (`.github/workflows/beta.yml`). The local shell wrapper supports beta packaging too (`build-macOS-dmg.sh`). `.python-version` pins Python `3.14.4`, while CD invokes runner `python3` without a matching setup step; actual runner resolution remains unknown.

## Developer Experience and Real-Project Use

The application/domain factories, injected clocks/schedulers, typed ports, and main façades are useful seams for another small desktop utility. They permit business-rule tests without Electron and keep OS adaptation localized. This is an application repository, not a published SDK: reuse still requires product/package metadata, platform behavior, and release ownership to be configured. `LICENSE` defines the repository's licensing terms; it does not establish provenance or licenses for every resolved third-party dependency.

The README gives product and development entry points, while `CODING_GUIDELINES.md`, `repository-brief.md`, and scoped `AGENTS.md` files explain local contracts. Version and test-count claims have drifted: `README.md:7` says `1.11.0`, root guidance says `1.12.1`, and the manifest says `1.13.2`. Historical plans under `docs/` describe already implemented work as well as intentions; they are not proof that a feature is missing. `docs/windows-qa-checklist.md` is a checklist, not a record of an executed Windows test pass.

Inference: the Settings duration wording may be read as a preference-only action even though it also starts a session. That is a product-copy question, not an established defect. `.sentrux/rules.toml` contains older coordinator/shortcut references; their current enforcement effectiveness was not executed. `opencode.json`, `skills-lock.json`, `.codegraph/.gitignore`, and ignore rules are development-tool metadata, not runtime dependencies.

## Constraints, Risks, and Opportunities

Preserve twelve application ports, sixteen public IPC names, private dialog isolation, sole WindowGraph creation, sole settings reaction ownership, and sole infrastructure blocker ownership. Do not move session state into settings, introduce a second quit owner, scatter platform APIs, or weaken strictness/coverage checks. These constraints come from the scoped guidance and the current composition/transport code, not a new proposed architecture.

Uncertainty reconciliation:

| Question | Reconciled result and remaining limit |
| --- | --- |
| Lifecycle races and late battery reads | Oracle confirmed the conditional source paths and warned against init/cleanup promise cycles; librarian confirmed normal quit can be cancelled but `app.exit()` bypasses normal quit events. Proposal 1 promises orderly in-process cleanup, not persistence through forced termination or Windows OS shutdown. |
| IPC centralization | Both reviews support sender validation at the transport boundary and preserving resolved fallback values instead of replacing them with thrown errors. Current callers already guard senders; no exploit is asserted. |
| Feed schema and compatibility | Oracle supported deterministic conflict checks and preserving legacy unknown-size behavior. Librarian could not establish the exact versioned builder/updater schema; moving upstream types are insufficient. Proposal 3 is limited to this repository's fixed format and shipped path-only fallback, not a universal YAML or updater compatibility claim. |
| Low-battery/reaction failure paths | Oracle confirmed conditional code behavior; librarian had no executed OS evidence. Whether relevant production dependencies fail in these ways remains untested. |
| Updater late manual join after a no-update event | `hybrid-auto-updater.ts:641` and `:689` inspect `result.updateInfo` for fallback feedback. The exact resolved no-update contract was not verified by the librarian; Oracle retained the question, so no bug conclusion or proposal relies on it. |
| Versions, platform support, CI, signing, Python, coverage | Manifest/configuration facts are established, but installed versions, minimum supported OS behavior, release assets, runner resolution, and successful execution remain unverified. Neither consultant established them. |
| Documentation, Sentrux, benchmark, UX | Source confirms documentation drift and baseline-only loading; stale-rule effectiveness and wording impact remain unresolved. No numeric performance target or undocumented quality score is proposed. |

Primary-source checks: [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc) describes invoke replies and rejection behavior; [Electron sender validation guidance](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages) supports frame-aware validation. Versioned [app documentation](https://raw.githubusercontent.com/electron/electron/v44.4.5/docs/api/app.md) documents normal quit, immediate exit, and Windows shutdown limitations; [powerMonitor documentation](https://raw.githubusercontent.com/electron/electron/v44.4.5/docs/api/power-monitor.md) does not guarantee time for arbitrary asynchronous cleanup. [Power-save blocker documentation](https://www.electronjs.org/docs/latest/api/power-save-blocker#powersaveblockerstarttype) distinguishes display and application-suspension modes without guaranteeing hardware behavior. The librarian's [moving builder type source](https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/builder-util-runtime/src/updateInfo.ts) is explicitly insufficient to settle version-specific feed compatibility. GitHub trigger and publication descriptions above are grounded in checked-in workflows, not a verified live workflow run.

The selected challenges address different owners: process lifecycle, IPC transport, and release tooling. Each requires cross-boundary reasoning, adversarial behavioral tests, and a real surface check; none is a naming-only cleanup. The following trace ties each rubric dimension to evidence and bounds the future work.

| Rubric | Evidence, affected surfaces, and justified acceptance |
| --- | --- |
| 1.1 Lifecycle state | `app-shell.ts:50`, `composition-root.ts:143`, `index.ts:62`: concurrent init, deferred settings completion, partial failure, and quit must converge to a terminal state. Both shell and composition continuations matter; fixing only the entry point leaves resource acquisition possible. Same-instance restart is not required. |
| 1.2 Resource disposal | `composition-root.ts:212`, `battery-monitor.ts:114`, `window-graph.ts:926`: remove reactions, session/power listeners, battery polling, shortcut, updater, blocker, tray/windows; suppress late samples. A throwing disposer must not skip later owners, and concurrent cleanup callers must observe completion. |
| 1.3 Existing contracts | `app-shell.ts:21` and `:80`, `index.ts:84`, main/application guidance: retain the 2000 ms settings-flush bound and ready/quit ordering, cancel the losing timeout, preserve persisted intent, benchmark updater suppression, twelve ports, and WindowGraph ownership. A pending initializer must be invalidated or settled without a circular wait. |
| 1.4 Verification | Existing `tests/main/{index,app-shell,composition-root,composition-wiring,battery-monitor}.test.ts` provide mocks/deferred promises/fake timers. Run `bun run test -- tests/main`, `bun run check`, `bun run test:coverage`, and `bun run build`; coverage retains 90% lines/functions/branches, with exclusions unchanged. Normal startup/quit needs a real app smoke check, separately from unit mocks. |
| 2.1 Invoke authorization | `ipc-utils.ts:77`, all invoke registrations in `ipc.ts`, `auto-updater.ts:23`: central guard with typed per-channel fallback preserves version/about/quit/settings/session/updater rejected responses, including current-settings snapshot for rejected settings writes. No protected handler runs for rejected senders. |
| 2.2 Payload boundary | `ipc.ts:124`, domain duration validation, `src/shared/types.ts`, `src/preload/index.ts:59`: validate the unknown session-start envelope before property access, preserve null indefinite and 1440 inclusive plus existing error reasons. Keep the public bridge and channel budget stable; domain owns duration rules. |
| 2.3 Raw channel lifecycle | `ipc.ts:39`, constants and WindowGraph popover destruction: sender validation remains explicit for raw height events, width 360 and height clamp 220..480 remain, bursts coalesce at 16 ms, and destruction cancels pending work/removes only this listener. Private utility-dialog ID-bound channels and their dedicated preload stay separate. |
| 2.4 Verification | `tests/main/{ipc,ipc-handlers,security-validation,preload,auto-updater,window-graph}.test.ts` and shared contract tests cover transport and neighboring isolation. Focused main/shared tests, `bun run check`, `bun run test:coverage` at unchanged 90% lines/functions/branches, and `bun run build` are applicable; a real app check exercises normal renderer calls. |
| 3.1 Parse compatibility | `parseLatestYml` at `scripts/merge-latest-yml.ts:60`: malformed present file lists must not become a legacy feed; retain valid path-only input and its unknown-size meaning. Numeric validation and LF/CRLF/quoted scalar fixtures must target the supported fixed format, not assume a newly discovered upstream schema. |
| 3.2 Merge integrity | `mergeFeeds:131`, `serializeLatestYml:171`: reject conflicting known metadata, deduplicate identical entries, validate top-level path/hash against file entries, preserve version rejection and non-arm64 preference, choose remaining ties deterministically. Path-only synthetic size zero is unknown, so it must not contradict known real size solely because it is zero. |
| 3.3 Delivery callers | `cd.yml:207` and `:227` have separate macOS/Windows and one/multiple feed paths; all must validate before staging. `stage-release-assets.py:47`, workflow guidance, and builder configuration preserve collision warnings, platform feed requirements, architecture quorum, signing/fuses, beta policy, and existing release skipping. |
| 3.4 Verification | `tests/main/merge-latest-yml.test.ts` is the established suite, imported tooling is checked through the tests project, and the CLI exits nonzero on failure before its output write. Test permutation/conflict/legacy cases with mocked I/O, then run the real CLI in scratch space for both feed names; run `bun run check`, `bun run test:coverage` with unchanged global 90% thresholds, and `bun run build`, without publishing. |

## Coverage Ledger

Review keys: A architecture/dependency boundaries; B product/runtime; C quality/security/performance; D build/delivery; E developer use/documentation. All five reviewers were read-only. The coordinator resolved inaccurate report paths and checked material claims in source. Counts below are the pre-output tracked inventory and sum to 249; nested guidance is included in its area's count.

| Inventoried area | Files | Assigned review and coverage |
| --- | ---: | --- |
| `src/domain/` | 10 | A, C: pure rules, settings migration/validation, duration and activity invariants |
| `src/application/` | 27 | A, B, C: ports, session/use-case ownership, reactions and failure paths |
| `src/infrastructure/` | 18 | B, C: every adapter family, updater policy and benchmark instrumentation |
| `src/main/` | 31 | A, B, C: lifecycle/composition, all façades, IPC/security/tray/utils, process/platform; D checks process config |
| `src/preload/` | 4 | B, C: both bridges, public wiring/private separation; coordinator closed direct-read gaps |
| `src/renderer/` | 24 | B, C, E: popover/settings/about/dialog behavior, HTML/CSS, visibility and subscriptions; source review, not rendered QA |
| `src/shared/` | 5 | A, C: public/private contracts, re-exports and channel budgets |
| `src/assets/`, `src/assets.d.ts` | 13 | D, E: asset guidance/declarations and generator/consumer coupling; eleven PNGs classified as binary generated runtime resources |
| `tests/` | 64 | A, C primary; B, D cross-check: application 9, domain 4, infrastructure 4, main 36, renderer 7, shared 2, root guidance/setup 2; placeholders classified, all test areas covered |
| `scripts/` | 10 | C, D: build/dev, benchmark, guards, both icon generators, feed merger, staging, guidance |
| `build/` | 8 | D, E: hooks, fuse/sign/notarize logic, entitlements, guidance; ICNS/ICO binaries classified via generators and package consumers |
| `.github/` | 4 | D: CI, CD, beta and workflow guidance; no remote execution claimed |
| `docs/` | 6 | E: `clean-architecture-refactor-plan.md`, `plans/deeper-improvements.md`, `plans/performance-enhancements.md`, `windows-arm64-development-plan.md`, `windows-qa-checklist.md`, `windows-support-development-plan.md`; historical intentions distinguished from current code |
| `assets/` | 1 | E: `setting-page.png` marketing screenshot, binary classified; visual freshness not established |
| `.codegraph/`, `.sentrux/` | 2 | E: tracked ignore file and architecture rules; generated graph database is not tracked source |
| Root | 22 | D, E, C: all files enumerated below, including configuration, docs, lockfile, licensing and tooling metadata |

The 22 root files are `.gitignore`, `.prettierrc`, `.python-version`, `AGENTS.md`, `CODING_GUIDELINES.md`, `LICENSE`, `README.md`, `build-macOS-dmg.sh`, `bun.lock`, `electron-builder.yml`, `eslint.config.mjs`, `opencode.json`, `package.json`, `repository-brief.md`, `rsbuild.config.ts`, `rslib.config.base.ts`, `rslib.config.preload.ts`, `rslib.config.ts`, `skills-lock.json`, `tsconfig.json`, `tsconfig.tests.json`, and `vitest.workspace.ts`. The lockfile was covered as dependency-resolution metadata, not a line-by-line security audit of transitive packages.

All eighteen applicable `AGENTS.md` files were included: root; `src/domain`, `src/application`, `src/infrastructure`, `src/infrastructure/benchmark`, `src/main`, `src/main/platform`, `src/preload`, `src/renderer`, `src/renderer/settings`, `src/shared`, `src/assets`; `tests`, `tests/main`, `tests/renderer`; `scripts`, `build`, `.github/workflows`. E reviewed guidance consistency; each area reviewer applied its governing files.

Ignored/local areas were explicitly classified: `node_modules/` is installed dependency content; `lib/` and `dist/` are build/package outputs; `artifacts/` and `coverage/` are generated reports/assets; `.tsbuildinfo`, graph databases/logs, and `.DS_Store` are caches/metadata; `.git/` is version-control state; `.agents/` and `.omo/` are local agent context. These do not require line-by-line product analysis and were not changed. This coverage is repository-wide static analysis, not an assertion that every dependency, binary pixel, or runtime interleaving was audited.

## Proposed Coding Challenges

### Proposal 1: Make Startup and Shutdown Race-Safe

#### Coding Prompt

Make Amphetamine's startup and shutdown safe when initialization is still waiting on settings, when startup fails partway through, or when callers request the same lifecycle operation twice. A quit during startup must not leave a tray, shortcut, sleep blocker, or background callback alive after cleanup completes.

Keep lifecycle coordination in `AppShell` and `createAppComposition`. Concurrent initialization should share one operation, concurrent cleanup should share completion, and closing should be terminal for that instance. Guard continuations after awaits and discard battery samples that arrive after disposal. Handle bootstrap rejection explicitly so it reaches cleanup instead of only the global rejection logger; avoid a circular wait between initialization and cleanup.

Preserve the existing ready and teardown order, the 2000 ms settings-flush bound, benchmark updater suppression, and persisted sleep preferences. Add deferred-promise and fake-timer tests for the adversarial interleavings, including a throwing disposer, then exercise normal startup and quit in the built app. Do not add a second quit handler or move resource ownership into a new container.

#### How I Would Use This Codebase

I would use this app on a development laptop that starts several login utilities together. I want to be able to quit Amphetamine immediately, even while its settings are loading, without leaving sleep prevention active or needing to kill the process manually.

#### Why This Is Challenging

A flag in the entry point cannot stop an awaited composition initializer from acquiring resources later. Battery reads also outlive their polling interval, while several cleanup operations can throw. The tests must control those boundaries independently and prove that completion means resource ownership has ended, without creating a deadlock between startup and shutdown.

#### Evaluation Rubric

1. Concurrent `init()` calls share initialization, concurrent `cleanup()` calls share completion, and closing prevents later initialization or readiness on the same instance. Deferred settings resolution, partial startup failure, and the bootstrap rejection path in `src/main/index.ts` cannot register IPC, tray, or updater work after completed cleanup, and do not deadlock.
2. Composition releases settings subscriptions, battery/session listeners and timers, sleep prevention, shortcuts, updater resources, and utility windows even when one disposer throws; AppShell still disposes tray and windows. A battery read resolving after disposal cannot report a sample, stop a session, or notify the user, and repeated cleanup does not repeat disposal effects.
3. Keep the existing startup/quit ordering, the 2000 ms settings-flush race with its losing timer cancelled, benchmark updater suppression, and persisted intent/default-duration behavior. Preserve the twelve-port architecture, sole WindowGraph factory, sole settings-reaction subscriber, and sole `before-quit` owner rather than bypassing adapters or adding a lifecycle container.
4. Extend `tests/main/app-shell.test.ts`, `tests/main/composition-root.test.ts`, `tests/main/index.test.ts`, and `tests/main/battery-monitor.test.ts` with controlled interleavings and failure assertions, retaining composition-wiring regressions. Run `bun run test -- tests/main`, `bun run check`, `bun run test:coverage` with unchanged 90% lines/functions/branches, and `bun run build`, then confirm normal startup and quit through the app without real OS calls in unit tests.

### Proposal 2: Enforce Public IPC Boundaries Consistently

#### Coding Prompt

Make public IPC authorization unavoidable at registration while preserving every existing rejected-sender reply. Move the common sender check into `typedHandle`, with a correctly typed rejection response supplied for each invoke channel, and migrate the handlers in `ipc.ts` and the updater facade. This should prevent a future handler from accidentally omitting authorization without changing what current renderers receive.

Validate the session-start request envelope before reading `durationMinutes`. Invalid envelopes should return `invalid-duration`, while valid indefinite and timed sessions keep their current behavior and error messages. Keep duration policy in the domain layer and leave the public preload API unchanged.

Also give the raw popover height listener a bounded lifetime: cancel pending resize work and remove its own listener when the window is destroyed, while retaining sender validation and burst coalescing. Keep the utility dialog's private channels separate. Add tests that prove rejected senders cannot invoke protected handlers, malformed requests cannot escape as property-access errors, and queued resize work cannot touch a destroyed window; check normal renderer calls in the built app.

#### How I Would Use This Codebase

I would build a small managed desktop utility on these preload and main-process seams. As the app gains commands, I want authorization to be part of registration so a new handler cannot silently weaken the boundary, while existing renderer integrations keep working unchanged.

#### Why This Is Challenging

The rejected replies differ by channel, including a current-settings snapshot and discriminated session results. A generic throw would change the wire contract. The resize path uses events rather than invokes, and the private dialog uses a different sender policy, so wrapping one helper cannot safely cover every transport path.

#### Evaluation Rubric

1. `typedHandle` validates before dispatch and requires a channel-correct rejection response for every public invoke registration in `src/main/ipc.ts` and `src/main/auto-updater.ts`. Preserve the existing version/about/quit/settings/session/updater fallback values, including the current snapshot for rejected `SETTINGS_SET`, and demonstrate that protected handlers are not called for rejected senders.
2. `SESSION_START` rejects null, arrays, primitives, and missing or invalid duration values with `invalid-duration` before unsafe property access, while rejected senders still receive `rejected`. Preserve `{durationMinutes: null}`, the inclusive 1440-minute limit, the existing over-limit reason, domain validation ownership, and the unchanged public preload API and sixteen-channel contract.
3. Raw `WINDOW_SET_HEIGHT` retains explicit sender checks, 16 ms coalescing, width 360, and the 220..480 height clamp, but cancels pending work and removes only its own listener on popover destruction. Do not broaden the public allowlist, expose generic IPC, weaken secure web preferences, or route private utility-dialog channels through public authorization.
4. Extend the IPC/handler/security-validation tests under `tests/main/`, preserving preload, updater, WindowGraph, and shared-contract regression coverage for packaged Windows/POSIX paths, development origins, and rejected frames. Run `bun run test -- tests/main tests/shared`, `bun run check`, `bun run test:coverage` with unchanged 90% lines/functions/branches, and `bun run build`, then exercise ordinary public renderer calls without changing reply shapes.

### Proposal 3: Reject Inconsistent Update Feeds Before Publishing

#### Coding Prompt

Make update-feed merging reject contradictory metadata and produce the same output regardless of input order. A repeated asset URL must not silently replace another checksum or known size, and the selected top-level path and checksum must agree with the corresponding file entry. Keep the existing preference for a non-arm64 generic path, with deterministic tie handling.

Work within `scripts/merge-latest-yml.ts` and the production CD feed step. Preserve valid path-only legacy feeds and distinguish their synthetic unknown size from a real size conflict. Reject malformed present file lists instead of treating them as legacy input, and cover the supported quoted scalars and line endings without turning this into a general YAML implementation.

Route both single-feed and multi-feed macOS and Windows paths through validation before staging. Keep the existing requirement for at least one feed per platform and the asset-staging collision policy. Add conflict, permutation, legacy, and malformed-input tests, then exercise the real CLI with scratch fixtures and verify that rejected input leaves an existing output untouched. Do not publish releases or change beta, signing, or architecture-quorum policy.

#### How I Would Use This Codebase

I would use this release pipeline for a desktop utility distributed to both Intel and ARM machines. I want a rerun or reordered artifact download to produce identical update metadata, and a contradictory feed to fail before users are offered the wrong asset or checksum.

#### Why This Is Challenging

The pipeline has separate single-feed and multi-feed branches for each platform, so improving the merger alone leaves a bypass. Legacy feeds also synthesize missing size information, which must not become a false conflict. Determinism requires consistent top-level selection as well as sorted file entries and explicit handling of contradictory metadata.

#### Evaluation Rubric

1. `parseLatestYml` distinguishes absent legacy `files` data from a present malformed or empty list, validates supported scalar/file fields, and rejects non-finite, negative, or fractional explicit sizes. Preserve valid path-only input and its unknown-size meaning, with LF/CRLF and quoted-scalar fixtures covering the repository's fixed format rather than claiming general YAML support.
2. `mergeFeeds` rejects mismatched versions and conflicting known hashes or sizes for duplicate URLs, deduplicates equivalent entries, and checks each input and output top-level path/checksum against its file metadata. Preserve legacy unknown-size compatibility and non-arm64 preference, and make serialization byte-identical across input permutations, including ties and differing release dates.
3. Both platform branches in `.github/workflows/cd.yml` validate one or multiple feeds through the merger before staging, and invalid input exits nonzero without replacing an existing output. Preserve the requirement for at least one feed per OS, release-skip behavior, the collision-warning policy in `scripts/stage-release-assets.py`, and current beta, signing/fuse, and architecture-quorum behavior.
4. Extend `tests/main/merge-latest-yml.test.ts` with conflict, malformed-list, legacy/known-size, top-level consistency, and permutation cases using mocked I/O where needed, then run `bun run scripts/merge-latest-yml.ts <inputs> --out <output>` against scratch fixtures for both feed names without publishing. Run `bun run test -- tests/main/merge-latest-yml.test.ts`, `bun run check`, `bun run test:coverage` with unchanged global 90% lines/functions/branches, and `bun run build`, without treating the source-only coverage threshold as script coverage.
