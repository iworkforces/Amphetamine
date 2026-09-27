# Settings Renderer — Window UI

Separate Rsbuild renderer entry for the settings BrowserWindow. Vanilla TypeScript; no Electron or `electron-log` imports.

## Files

| File | Role |
|------|------|
| `index.ts` | Form render, debounced saves, shortcut recording, shortcut-failure push |
| `index.html` | CSP-protected shell |
| `constants.ts` | All UI copy (sections, labels, options, indicators) |
| `styles.css` | System Settings–style grouped lists, controls; imports shared utility tokens + icon aurora |
| `env.d.ts` | Local ambient types if needed |

## Visual language

- `#app` uses shared fixed dark surface `var(--utility-window-bg)` from `../styles/utility-tokens.css` (do not hardcode `#0D1117` here). Matches About and the updater utility dialog.
- Adaptive tokens (`--group-bg`, text, controls) still respond to `prefers-color-scheme` / reduced transparency / contrast for inset groups and chrome (on top of the fixed dark canvas).
- Grouped inset lists with hairline separators; edge-to-edge panel (no nested card chrome). No second `backdrop-filter`.
- Identity strip: 48px hero icon in `.icon-aurora-stage.settings-hero-icon-stage` (`--icon-size: 48px`) with **static** shared coffee-brown aurora (`icon-aurora--static` — no infinite animation, no pause wiring, no fancy leaf markup).
- Hero img size uses `var(--icon-size)` (same token as the stage).
- Section headers: General / Session / Power. No emoji in labels. No footer copyright (About owns that).
- Instant press feedback on toggles and controls (`:active` scale); open animation is opt-in (`.pre-animate` → `.ready`).
- Escape closes the window (when not recording a shortcut). Windows uses `titleBarOverlay` caption buttons.
- Respect `prefers-reduced-motion`, `prefers-reduced-transparency`, and `prefers-contrast` for controls, group materials, and the static icon aurora.

## Warm cache (main WindowGraph)

- User close hides the BrowserWindow; the renderer stays loaded (no second cold start).
- On `visibilitychange` → visible: clear control focus (double rAF) so reopen does not restore Launch at Login or last focused control.
- Main also blurs form focus after Settings present (deferred `executeJavaScript`).
- Quit drains pending renderer saves (including while hidden) before force-destroying the window (real unload / `beforeunload` cleanup).

## Form flow

- Render into `#app`; attach listeners after render / `updateSettingsUI`.
- Load via `window.api.settings.get()`; save via `settings.set` (debounced after local merge).
- Subscribe to `onSettingsChanged` and `onShortcutRegistrationFailed` once (init); keep while hidden.
- Duration select: `session.start(duration)` **and** save `defaultSessionDuration`.
- Sleep block mode select: persist `sleepBlockMode` only.
- `settings.set` returns `{ settings, rejectedKeys }` — surface rejected keys if present.

## Controls

| Control | Field / action |
|---------|----------------|
| Launch at Login | `launchAtLogin` |
| Prevent Sleep | `preventSleep` |
| Activate for | `defaultSessionDuration` + `session.start` |
| Battery threshold | `batteryThreshold` |
| Sleep block mode | `sleepBlockMode` |
| Toggle shortcut | `shortcut` (recorder) |

## Save rules

- Debounced (~300ms); queue latest snapshot if a save is in flight.
- On the private quit drain request, cancel debounce and flush pending edits through the serialized queue. Acknowledge only when quiescent, freeze further saves after success, and fail without retrying indefinitely after a rejected write.
- Display save state via constants; errors use `textContent` on the error element.
- Validation is enforced on main (domain validators); do not reimplement full validation in UI.

## Shortcut recorder

- Local UI recording state; persist through `settings.set({ shortcut })`.
- Display: macOS symbols vs Windows text via `window.api.platform.os`.
- On Windows, Win key maps to `Super` (not Ctrl); Ctrl maps to `CommandOrControl`.
- Failures from main shortcut registration push: show `${SHORTCUT_REGISTRATION_FAILED_PREFIX}: ${accelerator}`.
- Unsubscribe on `beforeunload` (destroy only — not on hide).

## Anti-Patterns

- Never import Electron, Node APIs, or `electron-log`.
- Never hardcode UI strings in `index.ts` (use `constants.ts`).
- Never treat `defaultSessionDuration` as live session state after the timer stops.
- Never leave a focused form control after warm-cache reopen (blur on visible).
