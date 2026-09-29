# Renderer Tests — jsdom UI

Renderer Vitest suites run in jsdom and assert DOM behavior for vanilla TypeScript entries. They do not launch Electron.

## Files

| File | Role |
|------|------|
| `index.test.ts` | Popover render, status/timer, controls, pushes, effective-active OR matrix, session-action identity, hide dedupe, benchmark API mock |
| `settings.test.ts` | Settings form, sections, debounced save, rejectedKeys, sleep mode, shortcut-failure subscription |
| `about.test.ts` | About metadata fill, copyright/author, Escape close (no in-content OK), icon open, no autofocus on show, fancy aurora leaf fixture + warm-cache `.is-paused` toggle, getAbout failure visibility |
| `utility-dialog.test.ts` | Payload apply, fancy aurora leaf fixture, warm-cache `.is-paused` toggle |
| `delegation.test.ts` | Event delegation on `#app` |

Settings warm-cache focus clear and main hide-on-close are covered primarily in `tests/main/window-graph.test.ts` (main process). Utility-dialog presentation (WindowGraph / hybrid-updater) stays covered in main tests; renderer pause/payload smoke lives in `utility-dialog.test.ts`.

## Setup

- Build DOM explicitly (`#app`).
- Install `window.api` mock before importing renderer modules (popover / settings / about).
- Utility-dialog: install `window.utilityDialogApi` (`getPayload`, `respond`, `setHeight`, `onApply`, `os`) — not `window.api`.
- Include `window.api.benchmark.isEnabled()` when importing popover code.
- Include `window.api.platform.os` when testing settings shortcut labels.
- Import entry after mocks, then dispatch `DOMContentLoaded` when the entry listens for it.
- Fake timers for countdown, debounced saves, RAF, delayed indicators, aurora pause resync timeouts.
- Settings fixtures: spread `DEFAULT_SETTINGS`.
- For utility-dialog height settle tests, stub `HTMLElement.prototype.scrollHeight` (jsdom often reports 0).

## Assertions

- Prefer visible DOM and user-event paths over private helpers.
- Popover: prevent-sleep and session chips call `settings.set` / `session.start` / `session.cancel` as designed.
- Popover chips need not persist `defaultSessionDuration`.
- Session actions: cancel-button node identity stable across same-mode pushes/ticks; mode flip replaces chips↔cancel once.
- Duplicate hide signals clear countdown interval only once.
- Effective active: status stays on when session running even if `preventSleep` is false (domain OR rule).
- Settings: duration select starts session + saves preference; sleep mode saves `sleepBlockMode`.
- Settings save path handles `{ settings, rejectedKeys }` responses.
- About / utility-dialog: visibilitychange → stage `.is-paused` toggles; fancy leaf counts (4 blobs, 2 rings, sheen, flare); `aria-hidden` on `.icon-aurora`.
- About: GitHub icon is not `document.activeElement` after open or warm-cache `visibilitychange` → visible.
- Utility-dialog: payload text applied; `setHeight` called after measure when scrollHeight is stubbed; `#app.ready` after height settles.

## Mocking

- `window.api` mirrors preload shape for the entry under test.
- Settings tests mock `settings.get` / `set` (`{ settings, rejectedKeys }`), `onSettingsChanged`, `onShortcutRegistrationFailed`.
- Popover tests mock session status/pushes, `window.setHeight`, `app.getVersion`, settings/session/app methods as needed.
- About: mock `app.getAbout()` returning `AboutInfo` (author/copyright, repository open).
- Utility-dialog: mock `utilityDialogApi` (not public `api`); `matchMedia` exact-query for reduced-motion when needed.
- Do not mock `electron-log` for renderer (modules must not import it).

## Anti-Patterns

- Never import Electron, Node APIs, or main-process modules.
- Never call private renderer helpers via module internals.
- Never leave global `window.api` or fake timers dirty between tests.
