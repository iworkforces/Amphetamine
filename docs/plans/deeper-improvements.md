# deeper-improvements - Work Plan

## TL;DR (For humans)

**What you'll get:** The tray icon will open the main control panel again so timed sessions are easy. Sleep prevention that stops for low battery will explain itself. Updates will say “missing download info” instead of blaming the network when metadata is wrong. Builds shipped from CI will get the same security hardening as local packages, and the countdown after waking from sleep will stay honest.

**Why this approach:** Multi-agent review of architecture, performance, security, tests/CI, and product UX. Work is ordered by user impact and release safety first, then quality and polish. Each item ships with a regression test and keeps existing settings and IPC contracts unless a todo explicitly expands them.

**What it will NOT do:** It will not add Linux, a UI framework, telemetry, a DI container, or a full multi-language product. It will not change battery thresholds or polling intervals. It will not require code-signing certificates in this plan (signing is documented as a follow-on).

**Effort:** Extra Large  
**Risk:** Medium–High for tray→popover and fuse packaging order; Low–Medium for pure correctness and copy fixes.  
**Decisions to sanity-check:** Left-click opens popover vs right-click opens menu (recommended); fuses in `afterPack` before archive (required for CI parity); CD skips re-release when tag already exists (recommended).

Your next move: start the worker with `$start-work deeper-improvements`, or request a high-accuracy review first. Full execution detail follows below.

---

> TL;DR (machine): XL TDD plan for tray-popover product fix, release safety (fuses + CD gate), reliability (post-sleep remaining, battery feedback, updater copy), architecture hygiene, renderer micro-opts, security defense-in-depth, and test/CI contracts. Grounded in multi-agent analysis of architecture, performance, security, test/CI/DX, and product/UX on branch state including perf-enhancements + updater feed fixes.

## Background and provenance

Synthesized from five read-only explore analyses after performance-enhancements and `latest-mac.yml` / `setFeedURL` work:

| Lens | Headline findings |
|------|-------------------|
| Architecture | CA Lite solid; unused `BatterySensorPort`; dual port construction; domain duration reimplemented at IPC; Get/Update settings use cases unwired |
| Performance | Remaining wins: countdown over-paint, redundant `getStatus` after start/cancel, full-snapshot settings saves |
| Security / reliability | CI artifacts unfused; post-sleep remainingSeconds skew; About Dock policy; openExternal too broad |
| Test / CI / DX | CD can re-publish same version; no fuse in CI; missing shortcut use-case tests; coverage not gated |
| Product / UX | **Tray never shows popover**; silent battery auto-stop; false “network” updater dialog |

Already completed (out of scope for re-work unless regression):

- Session-action mode stability, hide coalesce, settings write coalesce, updater single-flight  
- Parallel production build (`scripts/build-production.ts`)  
- Benchmark scenarios + battery counters  
- `setFeedURL` from package repo; CI mac yml/blockmap upload; CD `merge-latest-yml`  
- AGENTS refresh, version 1.10.2, iworkforces rehome  

## Scope

### Must have (P0)

1. **Tray left-click opens positioned popover** (right-click or secondary → context menu). Session chips become reachable again.  
2. **CI/CD/local fuse parity**: fuses applied to bits that end up inside DMG/ZIP/EXE/NSIS (not only leftover unpacked dirs). Fix `package:universal` fuse path if kept.  
3. **CD release gate**: do not re-attach production release assets for an existing `vX.Y.Z` unless explicitly intended (version bump or dispatch).  
4. **Post-resume session remaining** uses wall-clock remaining (or rewrites perf `expiresAt` on resume). Divergent-clock unit test.  
5. **Battery auto-stop feedback**: OS notification and/or dynamic tray tooltip; detector stays policy-free.  
6. **Updater failure taxonomy**: distinguish feed/HTTP-404 from true network; user-facing copy and optional Open Releases path stay.  
7. **About + Settings shared Dock/foreground refcount** on macOS; About not always-on-top unless intentional; updater restore uses same helper.  
8. Focused Vitest coverage for all of the above; full typecheck/layers/lint/test/build gates green.

### Should have (P1)

9. Domain `validateDurationMinutes` at SESSION_START (and optional engine guard).  
10. Wire `createGetSettings` / `createUpdateSettings` through composition into IPC.  
11. Renderer: no-op countdown ticks skip `paintControls`; drop redundant `getStatus` after start/cancel when push is authoritative.  
12. Settings UI `set(partial)` of changed keys only (keep debounce).  
13. Unit tests for `createRegisterAppShortcut`; IPC 16-channel budget contract test.  
14. CD hard-require `latest.yml` when Windows artifacts present (mirror mac `latest-mac.yml`).  
15. Settings session UX: split or clearly relabel preference vs “start session now”.  
16. Dynamic tray tooltip for effective state / short session summary.

### Could have (P2)

17. WindowGraph-scoped broadcast (not `getAllWindows`) for pushes.  
18. Global `web-contents-created` hardening + About openExternal limited to package repository URL (or dedicated IPC).  
19. Composition injects shared logger/notifier/clock/schedule; UpdaterPort owns IPC check path.  
20. Implement `BatterySensorPort` adapter or remove from ports budget documentation.  
21. `secureHandle` / typed wrapper that always validates sender.  
22. CI: optional coverage gate and Prettier check; umbrella `check` script.  
23. Background “Update available…” tray/menu hint.  
24. Post-resume sleep-blocker reassert if intent/session true but `!isActive()`.

### Must NOT have (guardrails)

- No Linux product path, UI framework, Electron major upgrade, or telemetry platform.  
- No DI container, Tray/Menu/BrowserWindow ports, DDD/CQRS/mediator.  
- No battery threshold or polling-interval policy change (feedback and measurement only).  
- No full i18n multi-locale product (string centralization in P1 is allowed; language packs are not).  
- No requiring notarization/Authenticode secrets in this plan (document follow-on only).  
- No edits under generated `lib/`, `dist/`, or committed `artifacts/` evidence.  
- No dual-subscribe settings reactions (keep SettingsReactionService sole system-side-effect owner).

## Verification strategy

> Zero human intervention for automated gates; tray→popover needs platform matrix notes for manual smoke.

- **TDD:** Vitest 4, Electron mocks, fake timers, jsdom renderer. Implementation + test = one todo.  
- **Evidence:** `.omo/evidence/deeper-improvements/task-<N>.md` (gitignored under `.omo/`).  
- **Gates (all todos that touch runtime):**  
  `bun run typecheck && bun run typecheck:tests && bun run typecheck:sticky && bun run typecheck:layers && bun run lint && bun run test && bun run build`  
- **Packaging todos:** additionally assert fuse-related afterPack path and CD workflow logic (unit/script level where possible).  
- **Manual smoke (F3):** macOS + Windows: tray left-click shows popover at tray; right-click menu; low-battery feedback (mocked if needed); Check for Updates copy with missing feed vs offline; About Dock open/close with Settings.

## Execution strategy

### Parallel execution waves

| Wave | Theme | Todos |
|------|--------|-------|
| 1 | Contracts & failing tests (lock behavior) | 1 |
| 2 | P0 product + reliability (independent after 1) | 2–7 |
| 3 | P0 packaging/CI safety | 8–10 |
| 4 | P1 architecture + perf micro + tests | 11–16 |
| 5 | P2 hardening + polish (optional if time) | 17–22 |
| 6 | Integration evidence + final gates | 23, F1–F4 |

### Dependency matrix

| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 2–22 | — |
| 2 | 1 | 7, 15, 23 | 3–6, 8–10 |
| 3 | 1 | 23 | 2, 4–6, 8–10 |
| 4 | 1 | 23 | 2–3, 5–6, 8–10 |
| 5 | 1 | 23 | 2–4, 6, 8–10 |
| 6 | 1 | 23 | 2–5, 8–10 |
| 7 | 1, 2 | 23 | 3–6, 8–10 |
| 8 | 1 | 9, 23 | 2–7, 10 |
| 9 | 1, 8 | 23 | 2–7, 10 |
| 10 | 1 | 23 | 2–9 |
| 11 | 1 | 23 | 12–16 |
| 12 | 1 | 23 | 11, 13–16 |
| 13 | 1 | 23 | 11–12, 14–16 |
| 14 | 1 | 23 | 11–13, 15–16 |
| 15 | 1, 2 | 23 | 11–14, 16 |
| 16 | 1 | 23 | 11–15 |
| 17–22 | 1 | 23 | each other (P2) |
| 23 | 2–16 (P0+P1 min) | F1–F4 | — |

## Architecture / product decisions (locked for this plan)

1. **Tray interaction:** left-click → show/hide popover positioned near tray; right-click (or `right-click` / `click`+modifier where platform lacks secondary) → existing context menu. Do not remove menu items for Settings/About/Updates/Quit.  
2. **Utility windows (macOS):** shared refcount helper `acquireForeground()` / `releaseForeground()` used by Settings, About, and updater dialogs. Last release → `enterTrayOnlyMode()`.  
3. **Battery feedback:** application remains Electron-free via a small port or composition-injected callback (`UserNotifierPort` or existing logger + main adapter). Prefer OS `Notification` + tray tooltip.  
4. **Updater categories:** extend `categorizeUpdaterError` and dialog strings; do not change hybrid download/install policy or background non-download.  
5. **Fuses:** apply in packaging path such that **archived** outputs contain flipped fuses (prefer `afterPack` on unpacked app before DMG/ZIP/NSIS finalize, or equivalent verified order).  
6. **CD:** if tag `v{package.json.version}` already exists, skip asset publish (or require `workflow_dispatch` with force flag documented). Prefer skip by default.

## Todos

> Implementation + Test = ONE todo. Never separate.

### Wave 1 — Lock contracts

- [ ] 1. Lock deeper-improvement contracts and write failing regression tests  
  What to do / Must NOT do: Add failing tests (or marked stubs that fail assert) for: tray show popover on primary click; post-resume remainingSeconds with wall-only clock skew; battery auto-stop invokes notifier; updater 404/feed-missing category ≠ generic network copy; About/Settings foreground refcount; domain duration used at SESSION_START; register-app-shortcut publish on failure; IPC channel count === 16. Must NOT implement production fixes in this todo beyond minimal test hooks/exports if required for testability.  
  Parallelization: Wave 1 | Blocked by: none | Blocks: 2–23  
  References: `src/main/tray.ts`; `src/main/process/window-graph.ts`; `src/application/session/session-engine.ts`; `src/application/battery/handle-low-battery-auto-stop.ts`; `src/infrastructure/updater/auto-updater-utils.ts`; `src/infrastructure/updater/hybrid-auto-updater.ts`; `src/main/ipc.ts`; `src/domain/session/duration.ts`; `src/application/shortcut/register-app-shortcut.ts`; `src/shared/types.ts`; `tests/main/tray.test.ts`; `tests/application/session-engine.test.ts`; `tests/main/auto-updater.test.ts`; `tests/main/ipc-handlers.test.ts`.  
  Acceptance criteria: Focused suite fails for missing production behavior with assertions naming the contract.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/tray.test.ts tests/application/session-engine.test.ts tests/main/auto-updater.test.ts tests/main/ipc-handlers.test.ts tests/application/handle-low-battery-auto-stop.test.ts` (extend files as needed). Evidence `.omo/evidence/deeper-improvements/task-1.md`.  
  Commit: N  

### Wave 2 — P0 product + reliability

- [ ] 2. Wire tray primary click to positioned popover  
  What to do / Must NOT do: On primary tray click, show (or toggle) the popover BrowserWindow positioned near tray bounds (mac menu bar / Windows notification area); secondary click keeps context menu. Preserve checkbox intent vs icon effective-active. Multi-monitor and taskbar edge: clamp to work area. Must NOT remove context menu items or require a UI framework.  
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 7, 15, 23  
  References: `src/main/tray.ts`; `src/main/process/window-graph.ts` (`getPopoverWindow`, show/hide); `src/main/app-shell.ts`; `src/main/composition-root.ts` tray deps; `src/main/constants.ts`; `tests/main/tray.test.ts`; `tests/main/window-graph.test.ts`; `tests/main/app-shell.test.ts`; platform window chrome docs.  
  Acceptance criteria: Unit tests prove click handler shows popover and positions within work area for mocked tray bounds; menu still opens on secondary path; second-instance path still shows popover without crash.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/tray.test.ts tests/main/window-graph.test.ts tests/main/app-shell.test.ts`. Manual smoke note in evidence for mac+win. Evidence `.omo/evidence/deeper-improvements/task-2.md`.  
  Commit: N  

- [ ] 3. Fix post-resume session remainingSeconds (wall vs perf)  
  What to do / Must NOT do: After sleep resume, remaining time and re-arm delay match wall-clock remaining; rewrite perf `expiresAt` and/or compute remaining from `wallClockExpiresAt - wallNow()`. Must NOT use `Date.now()` in domain; keep `ClockPort`. Must NOT change indefinite session behavior.  
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 23  
  References: `src/application/session/session-engine.ts` (`reconcileAfterResume`, `getStatus`); `src/main/session-timer.ts`; `src/renderer/index.ts` (`updateSessionAnchors`); `tests/application/session-engine.test.ts`; `tests/main/session-timer.test.ts`.  
  Acceptance criteria: Fake clock advances wall by N minutes with perf frozen (or different delta) → remainingSeconds and schedule delay equal wall remaining; timed expiry still fires; renderer anchor from status stays consistent.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/application/session-engine.test.ts tests/main/session-timer.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-3.md`.  
  Commit: N  

- [ ] 4. Battery auto-stop user feedback  
  What to do / Must NOT do: When low-battery auto-stop runs, notify the user (OS notification and/or tray tooltip update). Keep detector free of policy; inject feedback via port or composition callback. Must NOT change threshold semantics or polling interval.  
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 23  
  References: `src/application/battery/handle-low-battery-auto-stop.ts`; `src/main/battery-monitor.ts`; `src/main/composition-root.ts`; `src/main/tray.ts`; Electron `Notification` via main adapter only; `tests/application/handle-low-battery-auto-stop.test.ts`; `tests/main/battery-monitor.test.ts`.  
  Acceptance criteria: Use-case test asserts feedback port called once with percent/threshold; main adapter test mocks Notification/tooltip; no change to stop order (clear intent + cancel session).  
  QA: `bunx vitest run -c vitest.workspace.ts tests/application/handle-low-battery-auto-stop.test.ts tests/main/battery-monitor.test.ts tests/main/composition-wiring.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-4.md`.  
  Commit: N  

- [ ] 5. Updater error taxonomy and honest dialog copy  
  What to do / Must NOT do: Classify feed missing / HTTP 404 separately from true network failures; update `showCheckFailedDialog` (and related) strings; keep hybrid download policy, single-flight, SEMVER browser URLs. Must NOT auto-download on background checks.  
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 23  
  References: `src/infrastructure/updater/auto-updater-utils.ts`; `src/infrastructure/updater/hybrid-auto-updater.ts`; `tests/main/auto-updater-utils.test.ts`; `tests/main/auto-updater.test.ts`; `src/shared/types.ts` if status category expands.  
  Acceptance criteria: `HttpError: 404` / missing latest yml → non-network category and dialog text does not claim “could not reach the update server” as sole explanation; true ENOTFOUND still network.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/auto-updater-utils.test.ts tests/main/auto-updater.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-5.md`.  
  Commit: N  

- [ ] 6. Shared utility-window Dock / foreground presentation (macOS)  
  What to do / Must NOT do: Introduce acquire/release foreground helper used by Settings, About, and updater dialogs; About no longer skips Dock path; Settings close does not force tray-only while About open; `restoreTrayPresentation` uses same helper. Align About `alwaysOnTop` with product decision (default: false). Must NOT break Windows taskbar behavior.  
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 23  
  References: `src/main/platform/shell.ts`; `src/main/process/window-graph.ts`; `src/main/composition-root.ts` updater hooks; `src/main/settings-window.ts`; `src/main/about-window.ts`; `tests/main/window-graph.test.ts`; `tests/main/platform-shell-side-effects.test.ts`; `tests/main/about-window.test.ts`.  
  Acceptance criteria: Opening About alone calls foreground path on darwin; closing Settings while About open does not enter tray-only; last utility close restores tray-only; win32 paths no-op activation policy.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/window-graph.test.ts tests/main/platform*.test.ts tests/main/about-window.test.ts tests/main/settings-window*.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-6.md`.  
  Commit: N  

- [ ] 7. Dynamic tray tooltip and optional session menu affordance  
  What to do / Must NOT do: Tooltip reflects effective state and optional short session summary; optional menu item to cancel session when running. Must NOT rebuild menu on every countdown tick (only intent/session active transitions). Depends on tray deps already exposing effective/session state.  
  Parallelization: Wave 2 | Blocked by: 1, 2 | Blocks: 23  
  References: `src/main/tray.ts`; `src/main/constants.ts`; `src/main/composition-root.ts` tray deps; `tests/main/tray.test.ts`.  
  Acceptance criteria: Tooltip changes when effective active flips; session-running shows distinct tooltip; menu rebuild count does not increase on pure icon-only updates.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/tray.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-7.md`.  
  Commit: N  

### Wave 3 — P0 packaging / CI safety

- [ ] 8. Apply Electron fuses to distributed package outputs  
  What to do / Must NOT do: Ensure fuses run such that final DMG/ZIP/NSIS/portable contain flipped Electron binary (prefer `build/after-pack.cjs` or verified pre-archive step). Wire CI + beta packaging paths. Fix `package:universal` fuse arch or remove script. Must NOT disable ASAR integrity incorrectly; document order relative to signing.  
  Parallelization: Wave 3 | Blocked by: 1 | Blocks: 9, 23  
  References: `build/flip-fuses.cjs`; `build/after-pack.cjs`; `package.json` package scripts; `.github/workflows/ci.yml`; `.github/workflows/beta.yml`; `build/AGENTS.md`; `electron-builder.yml`.  
  Acceptance criteria: Documented command path + automated check (script unit or CI step) proves fuse flip runs for mac and win package jobs; universal script fixed or deleted; AGENTS match reality.  
  QA: unit/script assertions + `bun run package:dir` / `:win:dir` smoke where environment allows. Evidence `.omo/evidence/deeper-improvements/task-8.md`.  
  Commit: N  

- [ ] 9. CD: skip production re-release when tag already exists  
  What to do / Must NOT do: If `v{version}` tag already exists, skip softprops publish (or only allow via explicit dispatch input). Keep tag create-if-missing logic. Must NOT break first-time release for new versions.  
  Parallelization: Wave 3 | Blocked by: 1, 8 | Blocks: 23  
  References: `.github/workflows/cd.yml`; `.github/workflows/AGENTS.md`.  
  Acceptance criteria: Workflow YAML gates publish on new tag OR explicit force; AGENTS documents behavior.  
  QA: static review of workflow conditions + dry-run documentation in evidence. Evidence `.omo/evidence/deeper-improvements/task-9.md`.  
  Commit: N  

- [ ] 10. CD: require Windows `latest.yml` when win artifacts present  
  What to do / Must NOT do: Mirror mac hard-fail for missing `latest-mac.yml` when win packages are in the artifact set. Keep merge-latest-yml path. Must NOT break mac-only experimental builds if not applicable (both arches currently always built).  
  Parallelization: Wave 3 | Blocked by: 1 | Blocks: 23  
  References: `.github/workflows/cd.yml`; `scripts/merge-latest-yml.ts`; `.github/workflows/AGENTS.md`; `build/AGENTS.md`.  
  Acceptance criteria: Missing win feed fails CD with clear error; merge still produces single basename.  
  QA: inspect workflow + `bunx vitest run -c vitest.workspace.ts tests/main/merge-latest-yml.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-10.md`.  
  Commit: N  

### Wave 4 — P1 architecture, perf micro, tests, UX polish

- [ ] 11. Domain duration validation at SESSION_START (+ optional engine guard)  
  What to do / Must NOT do: Replace magic `1440` / duplicated checks in `ipc.ts` with `validateDurationMinutes` from domain; optionally validate inside session engine or start-session use case. Must NOT change allowed range (null, 1–1440).  
  Parallelization: Wave 4 | Blocked by: 1 | Blocks: 23  
  References: `src/domain/session/duration.ts`; `src/main/ipc.ts`; `src/application/session/session-engine.ts`; `tests/main/ipc-handlers.test.ts`; `tests/domain/duration.test.ts`; `tests/application/session-engine.test.ts`.  
  Acceptance criteria: SESSION_START goldens still pass; domain is single source of truth; invalid values never schedule timers if engine-guarded.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/ipc-handlers.test.ts tests/domain/duration.test.ts tests/application/session-engine.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-11.md`.  
  Commit: N  

- [ ] 12. Wire GetSettings / UpdateSettings use cases in composition  
  What to do / Must NOT do: Composition constructs `createGetSettings` / `createUpdateSettings` over the store and passes them to IPC deps. Keep UpdateSettings persist-only (no reactions). Must NOT dual-subscribe reactions.  
  Parallelization: Wave 4 | Blocked by: 1 | Blocks: 23  
  References: `src/application/settings/*`; `src/main/composition-root.ts`; `src/main/ipc.ts`; `src/main/settings.ts`; `tests/main/composition-root.test.ts`; `tests/application/update-settings.test.ts`.  
  Acceptance criteria: Production IPC path uses use cases; existing settings IPC tests pass; reactions still only via SettingsReactionService.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/composition*.test.ts tests/main/ipc-handlers.test.ts tests/application/update-settings.test.ts tests/application/get-settings.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-12.md`.  
  Commit: N  

- [ ] 13. Renderer countdown paint skip + drop redundant getStatus after start/cancel  
  What to do / Must NOT do: When timer text unchanged, do not call full `paintControls`; only update timer text when needed. After successful start/cancel, rely on push (keep getStatus for init/errors). Must NOT reintroduce session-actions rebuild-on-tick.  
  Parallelization: Wave 4 | Blocked by: 1 | Blocks: 23  
  References: `src/renderer/index.ts`; `tests/renderer/index.test.ts`; session push paths.  
  Acceptance criteria: Tests prove pure ticks do not re-set status/toggle DOM; start/cancel still update UI via push without extra getStatus mock call.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/renderer/index.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-13.md`.  
  Commit: N  

- [ ] 14. Settings renderer saves partials only  
  What to do / Must NOT do: Debounced save sends only changed keys (or last partial merge), not entire snapshot every time. Keep 300ms debounce and rejectedKeys handling.  
  Parallelization: Wave 4 | Blocked by: 1 | Blocks: 23  
  References: `src/renderer/settings/index.ts`; `tests/renderer/settings.test.ts`.  
  Acceptance criteria: Changing one field invokes `settings.set` with a partial containing that field (not necessarily every key).  
  QA: `bunx vitest run -c vitest.workspace.ts tests/renderer/settings.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-14.md`.  
  Commit: N  

- [ ] 15. Settings session UX: preference vs start  
  What to do / Must NOT do: Split or relabel “Activate for” so preference update and session start are not confusingly one control; keep popover chips start-only. Must NOT remove ability to start from Settings without a replacement. Prefer: separate default duration control + explicit Start, or copy that says “Start session for…”.  
  Parallelization: Wave 4 | Blocked by: 1, 2 | Blocks: 23  
  References: `src/renderer/settings/index.ts`; `src/renderer/settings/constants.ts`; `src/renderer/settings/index.html`; `tests/renderer/settings.test.ts`; `src/renderer/settings/AGENTS.md`.  
  Acceptance criteria: User-visible strings and tests document new behavior; no unintended preference write from popover chips.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/renderer/settings.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-15.md`.  
  Commit: N  

- [ ] 16. register-app-shortcut tests + IPC 16-channel contract  
  What to do / Must NOT do: Unit-test `createRegisterAppShortcut` (success, default accelerator, failure publish). Add shared/main test that `IPC_CHANNELS` count and map/handler/preload wiring stay complete (16 names).  
  Parallelization: Wave 4 | Blocked by: 1 | Blocks: 23  
  References: `src/application/shortcut/register-app-shortcut.ts`; `src/shared/types.ts`; `src/preload/index.ts`; `src/main/ipc.ts`; `tests/application/`; `tests/main/preload.test.ts`; `tests/main/ipc-handlers.test.ts`.  
  Acceptance criteria: New application test file green; channel contract fails if a channel is added without map/preload/handler.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/application tests/main/preload.test.ts tests/main/ipc-handlers.test.ts tests/shared`. Evidence `.omo/evidence/deeper-improvements/task-16.md`.  
  Commit: N  

### Wave 5 — P2 optional hardening (include if capacity; else defer)

- [ ] 17. WindowGraph-scoped push broadcast  
  What to do / Must NOT do: Broadcast only popover/settings/about from registry, not ambient `getAllWindows()`. Must NOT drop a legitimate subscriber.  
  Parallelization: Wave 5 | Blocked by: 1 | Blocks: 23  
  References: `src/main/utils/broadcast.ts`; `src/main/process/window-graph.ts`; `tests/main/broadcast.test.ts`.  
  Acceptance criteria: Extra mock BrowserWindow outside graph does not receive pushes.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/broadcast.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-17.md`.  
  Commit: N  

- [ ] 18. Global web-contents hardening + About repository-only openExternal  
  What to do / Must NOT do: `app.on("web-contents-created")` deny-by-default navigation/window-open; About allows only package repository (or IPC open-repo). Must NOT break github.com icon open for configured repo.  
  Parallelization: Wave 5 | Blocked by: 1 | Blocks: 23  
  References: `src/main/security.ts`; `src/main/index.ts` / app-shell bootstrap order; `src/main/process/window-graph.ts`; `tests/main/security.test.ts`; `tests/main/about-window.test.ts`.  
  Acceptance criteria: Non-repo github URL denied; global hook registered before first window in tests.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/security.test.ts tests/main/about-window.test.ts tests/main/window-graph.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-18.md`.  
  Commit: N  

- [ ] 19. Composition-owned shared ports + UpdaterPort IPC check  
  What to do / Must NOT do: Inject shared logger/notifier/clock/schedule into session-timer and shortcut; route IPC auto-updater check through UpdaterPort. Must NOT reintroduce module-level session globals.  
  Parallelization: Wave 5 | Blocked by: 1 | Blocks: 23  
  References: `src/main/composition-root.ts`; `src/main/session-timer.ts`; `src/main/global-shortcut.ts`; `src/application/ports/updater.port.ts`; `src/infrastructure/updater/electron-updater-port.ts`; `src/main/auto-updater.ts`; related tests.  
  Acceptance criteria: Session-timer no longer constructs independent notifier/logger; IPC check uses port method.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/session-timer.test.ts tests/main/composition*.test.ts tests/main/auto-updater.test.ts tests/infrastructure/updater-port.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-19.md`.  
  Commit: N  

- [ ] 20. BatterySensorPort implement or retire  
  What to do / Must NOT do: Either implement port + adapter and wire detector, or remove from ports budget and AGENTS. Prefer implement if extracting improves tests without policy change.  
  Parallelization: Wave 5 | Blocked by: 1 | Blocks: 23  
  References: `src/application/ports/battery-sensor.port.ts`; `src/main/battery-monitor.ts`; `src/main/platform/battery-percent.ts`; AGENTS ports tables.  
  Acceptance criteria: Ports budget matches runtime; tests green; no battery policy change.  
  QA: battery + ports-compile tests. Evidence `.omo/evidence/deeper-improvements/task-20.md`.  
  Commit: N  

- [ ] 21. secureHandle / always-validate IPC wrapper  
  What to do / Must NOT do: Centralize sender validation in typed handle so new channels cannot skip it. Migrate existing handlers.  
  Parallelization: Wave 5 | Blocked by: 1 | Blocks: 23  
  References: `src/main/ipc-utils.ts`; `src/main/ipc.ts`; `tests/main/ipc.test.ts`; `tests/main/ipc-handlers.test.ts`.  
  Acceptance criteria: Invalid sender never reaches handler body for all registered channels.  
  QA: `bunx vitest run -c vitest.workspace.ts tests/main/ipc.test.ts tests/main/ipc-handlers.test.ts`. Evidence `.omo/evidence/deeper-improvements/task-21.md`.  
  Commit: N  

- [ ] 22. DX/CI polish: check script, optional coverage + Prettier  
  What to do / Must NOT do: Add `bun run check` umbrella; optionally gate PR coverage and prettier --check. Must NOT weaken sticky/layer guards.  
  Parallelization: Wave 5 | Blocked by: 1 | Blocks: 23  
  References: `package.json`; `.github/workflows/ci.yml`; `vitest.workspace.ts`; `eslint.config.mjs`.  
  Acceptance criteria: One local command matches CI lint+type gates; CI docs updated.  
  QA: `bun run check`. Evidence `.omo/evidence/deeper-improvements/task-22.md`.  
  Commit: N  

### Wave 6 — Integration

- [ ] 23. Full quality gates and evidence rollup  
  What to do / Must NOT do: Run full gate suite; run benchmark idle + active-session; summarize P0 manual smoke checklist. Must NOT commit generated artifacts or claim single benchmark sample as regression proof.  
  Parallelization: Wave 6 | Blocked by: 2–16 (P0+P1 minimum; include 17–22 if done) | Blocks: F1–F4  
  References: `package.json` scripts; `scripts/benchmark-performance.ts`; README benchmark section.  
  Acceptance criteria: typecheck×4, lint, test, build all exit 0; benchmarks produce valid scenario artifacts; evidence index lists pass/fail per todo.  
  QA: full commands in acceptance. Evidence `.omo/evidence/deeper-improvements/task-23.md`.  
  Commit: N  

## Final verification wave

> Runs in parallel after ALL required todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.

- [ ] F1. Plan compliance audit  
  Verify every Must-have todo’s must/must-not, TDD sequence, evidence path, and acceptance criteria against this artifact. Reject generated-file edits and scope breaches. Evidence `.omo/evidence/deeper-improvements/f1-plan-compliance.md`.  

- [ ] F2. Code quality review  
  Type safety, layer boundaries, no `as any` / suppressions in `src/`, concurrency/cleanup correctness, no dual settings reactions. Evidence `.omo/evidence/deeper-improvements/f2-code-quality.md`.  

- [ ] F3. Real / manual QA  
  Automated gates + platform smoke: tray popover position (mac+win if available), battery feedback path, updater copy, About/Settings Dock, fuse packaging path. Evidence `.omo/evidence/deeper-improvements/f3-manual-qa.md`.  

- [ ] F4. Scope fidelity  
  Confirm no Linux, no UI framework, no battery policy change, no DI container, no notarization secret requirement, no lib/dist commits. Evidence `.omo/evidence/deeper-improvements/f4-scope-fidelity.md`.  

## Commit strategy

No commits are authorized by default for execution work unless the user requests them. If commits are requested later: one atomic conventional commit per completed todo after `git status` / `git diff` / recent subject style.

Suggested prefixes: `feat(tray):`, `fix(session):`, `fix(updater):`, `fix(ci):`, `feat(battery):`, `refactor(composition):`, `perf(renderer):`, `test:`, `docs:`.

## Success criteria

- Primary tray interaction opens the popover; context menu remains available; session chips usable without opening Settings.  
- Low-battery auto-stop is visible to the user; post-sleep countdown matches wall remaining.  
- Updater failures do not mislabel feed/404 as pure network; production releases still require `latest-mac.yml` / `latest.yml`.  
- CI/beta/local packaging apply fuse hardening to shipped bits; CD does not silently re-release the same version.  
- Domain duration rules and settings use cases are on the production path; register-shortcut and IPC budget have tests.  
- Renderer countdown and settings saves avoid needless work without UX regression.  
- All automated gates pass; final verification F1–F4 approved by user.

## Follow-on (explicitly out of this plan)

- Code signing + notarization + Authenticode for true in-app install trust.  
- Full i18n and high-contrast design system.  
- Lazy BrowserWindow creation for RSS reduction (measure first).  
- Beta channel update feeds (or document beta as manual-install-only).  
- Playwright/Spectron E2E harness.

## Suggested first implementation sprint (1–2 weeks)

| Day focus | Todos |
|-----------|--------|
| 1 | Todo 1 (failing tests) |
| 2–4 | Todos 2, 3, 5 (popover, resume remaining, updater copy) |
| 4–5 | Todos 4, 6, 7 (battery feedback, Dock refcount, tooltip) |
| 6–7 | Todos 8–10 (fuses, CD gate, win latest.yml) |
| 8–10 | Todos 11–16 (architecture + perf micro + tests + settings UX) |
| 11 | Todo 23 + F1–F4 |

P2 todos 17–22 as stretch.
