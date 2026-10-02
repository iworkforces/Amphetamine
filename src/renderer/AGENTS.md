# Renderer Process — UI Layer

Electron renderer web context. Vanilla TypeScript only. Four built entries (Rsbuild environments): **popover**, **settings**, **about**, **utility-dialog**.

## Files

| File | Role |
|------|------|
| `index.ts` | Popover: prevent-sleep toggle, session chips/cancel, status/timer, Settings/Quit |
| `index.html` | CSP-protected popover shell |
| `constants.ts` | Status strings, control labels, session duration chips |
| `benchmark-countdown.ts` | Renderer countdown timer counters for benchmark mode |
| `env.d.ts` | `Window.api` type derived from preload `Api` |
| `css.d.ts` | CSS module declarations |
| `styles/main.css` | Popover styling, dark mode, reduced motion |
| `styles/utility-tokens.css` | Shared Settings/About/utility-dialog surface tokens (e.g. `--utility-window-bg`) |
| `styles/icon-aurora.css` | Shared coffee-brown aurora (GogMeet-style: core/blobs, dual rings, sheen, flare) behind app icons |
| `icon-aurora-pause.ts` | Shared warm-cache pause wiring for fancy aurora stages (visibility/focus/blur/pageshow) |
| `settings/` | Settings-window renderer; see `settings/AGENTS.md` |
| `about/` | About-window renderer (package metadata + close) |
| `utility-dialog/` | Aurora alert dialog (Check for Updates + other main-owned alerts) |

## Popover flow

- Runs on `DOMContentLoaded`.
- Loads `settings.get()`, `session.getStatus()`, and `app.getVersion()` via `window.api`.
- `refreshSessionStatus()` before first paint to avoid stale flash.
- Subscribes to `onSessionStatusUpdate`, `onSettingsChanged`, `onWindowHide`.
- Resizes via `window.api.window.setHeight()` after layout changes.
- **Effective status** (dot/text): domain `isEffectivelyActive(preventSleep, sessionRunning)` from `src/domain/session/effective-active.ts` — do not reimplement the OR formula locally.
- Controls:
  - Prevent Sleep → `settings.set({ preventSleep })`
  - Duration chips → `session.start(duration)` only; **do not** write `defaultSessionDuration`
  - Cancel → `session.cancel()`
- Footer: Settings… / Quit.

## Session actions stability

- `#session-actions` rebuilds **only** when running/idle **mode** changes (not on every timer tick or same-mode status push).
- Click handling uses **one delegated** listener on the container (stable cancel-button DOM identity across ticks).
- Idle → chips; running → single cancel button; mode flip replaces the subtree once.

## Hide transitions

- `window:hide` and `visibilitychange` (hidden) share a transition path: ignore if already hidden so countdown stop/clear runs once.
- Becoming visible again re-arms the countdown only when a timed session is anchored.

## About flow

- Built entry `about.html` (Rsbuild env `about`); loaded by WindowGraph with shared preload.
- Classic macOS About panel: icon, name, version, description, copyright (`AboutInfo.author`). Dismiss via system Close / Escape (no in-content OK).
- Shared fixed dark surface (`--utility-window-bg` from `styles/utility-tokens.css`) + **opacity-only** open (scale lives on aurora bloom only); press feedback on icon under `prefers-reduced-motion: no-preference`.
- Bootstrap: `bindIconAuroraStagePause(root)` **before** any `await`, then `startOpenAnimation`, then blur any focused control (GitHub icon is first tabbable), then `window.api.app.getAbout()`.
- Open with **no focused control** (main also blurs after present). Icon stays `tabindex="0"` so Tab / Enter / Space still open the repo after the user tabs.
- Icon click / Enter / Space uses `window.open(repository)` — main allowlists the package repository URL (and paths under it on `github.com`) via `setWindowOpenHandler` + `shell.openExternal`.
- Escape uses `window.close()` → main **hide-on-close** warm cache (same as Settings); quit force-destroys. System Close chrome does the same. Warm-cache reopen blurs again (`visibilitychange` → visible, double rAF).
- Safe visibility: shell materializes even if `getAbout` fails (fallback copy).
- Hero icon: bundled `settings-hero-icon.png` via `import.meta.url` (not a main-process data URI); size via stage `--icon-size` (80px).
- Icon sits in `.icon-aurora-stage` with fancy coffee-brown aurora; decorative core/blobs/rings/sheen/flare are `aria-hidden` (GogMeet app-icon-aurora model).
- Bloom runs on `.icon-aurora` only (never the stage that wraps the app icon). Ambient leaf motion starts after `--aurora-ambient-delay` (~480ms).
- No separate `constants.ts`; copy comes from `AboutInfo` + static HTML structure.

## Utility dialog (updater alerts)

- Built entry `utility-dialog.html` (Rsbuild env `utility-dialog`); dedicated preload `lib/preload/utility-dialog.cjs` exposing `window.utilityDialogApi` only (not `window.api`).
- Presented by WindowGraph `presentUtilityDialog` for hybrid updater dialogs (up-to-date, check failed, install ready, unpackaged). **Hide-on-close warm cache** (re-apply payload via `onApply`); single-flight in main; quit force-destroys.
- Opaque dark surface (`--utility-window-bg`) + fancy multi-layer coffee-brown aurora; system Close chrome. Stage `--icon-size: 72px`.
- **Open order:** hold `#app.pre-animate` → measure → `setHeight` → **then** opacity fade-in. Never race bloom/filters with window resize (first-open edge fringe).
- `#app` uses `overflow: hidden` (clips corona to the dialog surface). No focus outline on `#app` when info-only surfaces call `root.focus()`.
- **Info-only** (single button, e.g. OK): hide the action row; dismiss via system Close / Esc / Enter → `cancelId`. Multi-button: secondary left / primary right; Esc → `cancelId`; Enter → `defaultId` when no button focused.
- Private IPC (not in public `IPC_CHANNELS` budget): `get-payload` / `respond` / `set-height` / push `apply`.
- Presentation lifetimes: only the newest live `presentationId` may build controls, respond, resize, or reveal. Older/equal ids (stale initial read, duplicate APPLY, retired) are ignored — no rebuild, refocus, re-measure, or re-armed response. Late `setHeight` / animation-frame / fallback-timer completions check liveness first.
- Initial focus survives warm reopen: Chromium resets focus to the first tab stop / document when the shell is shown or activated (a `focusout` with no related target, or window `focus` alone). Until the user presses a key, points, or deliberately moves focus (assistive technology), the live presentation restores its default button (or `#app` for info-only) one task later.
- Dispose (APPLY subscription, aurora pause binding, keydown/pointerdown/focus/focusout guards, pending frames/timers) on `pagehide` that is not persisted — never on warm hide. Bootstrap failure declines only the presentation live at that moment (`getPayload` → `respond(id, cancelId)`).
- Always assign message/detail/button labels with `textContent` (never `innerHTML`).
- Wire `bindIconAuroraStagePause(root)` at bootstrap start (before async payload).

## Utility window surface

- Settings, About, and utility-dialog `@import` `styles/utility-tokens.css` and paint `#app` with `var(--utility-window-bg)`.
- Keep the hex only in `utility-tokens.css` so utility surfaces stay aligned.
- All three also `@import` `styles/icon-aurora.css`. About + utility-dialog use fancy animated aurora (core + 3 blobs, dual rings, sheen, flare — sized via CSS `--icon-size` on the stage class; hero/dialog imgs use `var(--icon-size)`). Settings uses `icon-aurora--static` (no pause wiring). Stage size: 80 / 72 / 48.
- Fancy surfaces wire `bindIconAuroraStagePause()` → `.is-paused` from `document.hidden` / `visibilityState`, re-sync on `focus` / `blur` / `pageshow` + short timeouts (Electron `show:false` race). Pause freezes **leaf** loops only; demotes `will-change`.
- Respect `prefers-reduced-motion` (single static wash; hide fancy leaves) / `prefers-reduced-transparency` / `prefers-contrast` (opacity keyframes killed so preference opacities stick).

## Countdown

- Anchors map main remaining seconds into renderer `performance.now()`.
- Local remaining derivation; no per-second IPC polling.
- Ticker only when popover visible **and** timed session anchored.
- Status/control paints through `paintControls` / `updateStatusUI` (RAF for timer text; timer text skip when unchanged).
- Benchmark counters only when `window.api.benchmark.isEnabled()`.

## IPC boundary

- Never import `electron`, Node APIs, or `electron-log`.
- All Electron access through `window.api` (preload).
- Domain pure helpers are allowed (e.g. `isEffectivelyActive`).
- Push subscriptions return unsubscribe functions; clean up on teardown.
- No DOM `CustomEvent` for IPC-like events.

## Anti-Patterns

- Never rebuild `#session-actions` on every countdown tick or same-mode push.
- Never read `status.remainingSeconds` for display after anchoring without local recompute.
- Never hardcode UI strings; use `constants.ts` (or about static copy in HTML carefully).
- Never update `defaultSessionDuration` from popover chips (settings window owns preference).
- Never duplicate settings-window rules; see `settings/AGENTS.md`.
- Never import shared preload `window.api` into the utility-dialog entry (dedicated preload only).
- Never re-hardcode `#0D1117` outside `styles/utility-tokens.css`.
- Never put aurora bloom on `.icon-aurora-stage` (would hide the app icon under `.is-paused` + fill-mode).
- Never start utility-dialog open fade before `setHeight` settles on first present.
- Never inline `style="--icon-size: …"` in HTML (stage classes own the token in CSS).
- Never leave the About GitHub icon focused on show (blur on bootstrap / visibility).

## Commands

```bash
bun run test -- tests/renderer
bun run build:renderer
```
