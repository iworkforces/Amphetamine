# Platform Adapters — macOS + Windows

Thin main-process helpers that gate OS-specific Electron and shell behavior. Product targets: **darwin** and **win32**. Other Node platforms resolve to `"other"` and are not first-class product surfaces.

**Public entry:** import from `platform/index.js` at production call sites.

```ts
import { isDarwin, enterTrayOnlyMode, getBatteryPercent, createBatterySensor } from "./platform/index.js";
```

Implementation files remain importable for focused unit tests (e.g. `battery-percent.test.ts` → `battery-percent.js`).

## Files

| File | Role |
|------|------|
| `index.ts` | Public API surface (re-exports only) |
| `os.ts` | Pure identity: `isDarwin`, `isWin32`, `resolvePlatformId`, `isSupportedPlatform` |
| `shell.ts` | Activation policy, Dock icon, login-item settings builders |
| `utility-presentation.ts` | Refcounted Dock / foreground for Settings, About, and updater dialogs |
| `window-chrome.ts` | BrowserWindow chrome fragments (popover / settings / about / utility-dialog) + `appIconFileName` |
| `battery-percent.ts` | Charge percent: pmset (darwin) / PowerShell CIM (win32) |
| `battery-sensor.ts` | `BatterySensorPort`: percent + `powerMonitor` AC/battery/resume |

Shortcut defaults, reserved keys, and accelerator validation live in domain validators + application shortcut registration; settings UI labels use preload `platform.os`.

## Rules

- Prefer `isDarwin()` / `isWin32()` over raw `process.platform` string compares in main.
- Optional `platform` parameters on pure helpers exist for unit tests; production omits them.
- Do not put composition policy, settings validation, or renderer concerns here.
- Never call macOS-only APIs (`setActivationPolicy`, `app.dock`, vibrancy, `openAsHidden`) without a darwin guard.
- Physical path stays under `main/platform` (not moved to `infrastructure/`).
- Electron imports: `electron/main` for `app`; types such as `NativeImage` from `electron/common` where needed.
- Prefer `acquireUtilityForeground` / `releaseUtilityForeground` over raw `enterForegroundMode` / `enterTrayOnlyMode` for utility windows and dialogs so overlapping surfaces do not fight Dock policy.

## Call sites

| Concern | Call site | Via |
|---------|-----------|-----|
| Tray-only boot | `app-shell.ts` | `enterTrayOnlyMode()` |
| Settings / About Dock + foreground | WindowGraph show/close | `setUtilityDockIcon` + `acquireUtilityForeground` on ready-to-show; `releaseUtilityForeground` on closed |
| Popover / settings / about / utility-dialog chrome | `process/window-graph.ts` | `*WindowChrome()` / `utilityDialogWindowChrome()` |
| Login items | `auto-launch.ts` | `buildLoginItemSettings` |
| Battery % | `battery-monitor.ts` | `createBatterySensor()` → `getBatteryPercent` + `powerMonitor` |
| Updater dialog presentation | composition → `presentUtilityDialog` | WindowGraph acquires/releases utility foreground for the dialog lifetime |
| App / window icons | WindowGraph | `appIconFileName`, `settings-hero-icon.png` |

## Utility foreground (refcounted)

- `utility-presentation.ts` holds a refcount so closing one utility (or finishing a dialog) does not force tray-only while another still needs Dock presentation.
- `setUtilityDockIcon` caches the Dock image applied on the first acquire.
- Pair acquire/release carefully: WindowGraph only releases if the window actually acquired (`heldForeground` flag) so closed-before-ready cannot drop another surface's ref.
- Updater dialog path (WindowGraph `presentUtilityDialog`) acquires/releases its own utility foreground ref for the dialog lifetime; Settings/About keep independent refs.
- Test seam: `resetUtilityForegroundForTests()`.

## Window chrome summary

| Surface | macOS | Windows |
|---------|-------|---------|
| Popover | vibrancy popover, transparent, `skipTaskbar: true` | opaque frameless, `skipTaskbar: true` |
| Settings / About | vibrancy under-window, `hiddenInset`, Dock via utility-presentation | mica + `titleBarOverlay` caption buttons, taskbar visible (`skipTaskbar: false`) |
| Utility dialog | **opaque** `backgroundColor: #0D1117`, `hiddenInset` (system Close), no vibrancy (solid fill avoids shrink-wrap edge bleed) | opaque `#0D1117` + matching `titleBarOverlay`, no mica |

Renderer CSS owns the fixed dark `#app` fill (`--utility-window-bg` in `src/renderer/styles/utility-tokens.css`). Utility-dialog chrome **also** sets native `backgroundColor` to the same hex so shrink-wrapped content does not leave transparent/vibrancy edges.

## Battery percent

- `null` means unavailable — monitor must not auto-stop.
- darwin: `/usr/bin/pmset -g batt` → `parsePmsetOutput` (requires `InternalBattery`).
- win32: `powershell.exe` + `Win32_Battery.EstimatedChargeRemaining` → `parsePowerShellBatteryOutput`.
- Never call `pmset` or PowerShell outside `battery-percent.ts`.

## Anti-Patterns

- Never scatter unguarded darwin-only Electron calls outside platform adapters.
- Never add Linux product paths without an explicit product decision.
- Never put composition, settings validation, or product policy into platform adapters.
