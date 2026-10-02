# Preload — Context Bridge

Sandboxed Electron preloads. Public renderers get `window.api` only; the utility dialog gets a separate minimal bridge. Security-critical: no Node APIs or raw `ipcRenderer` to any renderer.

## Files

| File | Role | Build output |
|------|------|----------------|
| `index.ts` | Typed `window.api`, `invoke<K>()`, push subscriptions, benchmark env helper, channel exhaustiveness | `lib/preload/index.cjs` |
| `utility-dialog.ts` | Aurora utility dialog only: `window.utilityDialogApi` | `lib/preload/utility-dialog.cjs` |

Both entries are produced by multi-entry Rslib (`rslib.config.preload.ts`, filename `[name].cjs`).

## API shape

| Namespace | Methods | Pattern |
|-----------|---------|---------|
| `window` | `setHeight(n)` | validated fire-and-forget send |
| `app` | `getVersion()`, `getAbout()`, `quit()` | `ipcRenderer.invoke` |
| `settings` | `get()`, `set(partial)`, `open()`; `onQuitDrain(cb)`, `ackQuitDrain(ack)` | invoke; private correlated quit request/ack bridge |
| `session` | `start`, `cancel`, `getStatus` | invoke |
| `autoUpdater` | `checkForUpdates()`, `onStatus(cb)` | invoke + push |
| `benchmark` | `isEnabled()` | env bridge read-only (`AMPHETAMINE_BENCHMARK`) |
| `platform` | `os` | host identity for UI labels (`process.platform` in preload only) |
| root | `onSettingsChanged`, `onWindowHide`, `onSessionStatusUpdate`, `onShortcutRegistrationFailed` | push subscriptions |

## Push subscription pattern

```typescript
onXxx: (callback: (data: T) => void) => {
  const listener = (_event: IpcRendererEvent, data: T) => callback(data);
  ipcRenderer.on(CHANNEL, listener);
  return () => ipcRenderer.removeListener(CHANNEL, listener);
};
```

Always return unsubscribe. Payload types from `IpcChannelMap` / push responses.
`settings.onQuitDrain` also returns an unsubscribe function; its private channel names and payload types come from `src/shared/settings-quit.ts`, not the public channel map.

## Utility dialog API (`utilityDialogApi`)

| Method | Channel | Notes |
|--------|---------|-------|
| `getPayload()` | `utility-dialog:get-payload` | Invoke; active payload incl. `presentationId` (main checks cached webContents + current main frame) |
| `respond(presentationId, index)` | `utility-dialog:respond` | Invoke; settles that presentation if still active (main hides warm shell); stale ids ignored |
| `setHeight(presentationId, px)` | `utility-dialog:set-height` | Invoke; main clamps then `setContentSize` only for the active id (renderer awaits before open fade) |
| `onApply(cb)` | `utility-dialog:apply` | Push listener; `{ kind: "present", payload }` or `{ kind: "retire", presentationId }` |
| `os` | (sync) | `process.platform` for optional body class |

Channel name literals live in `src/shared/utility-dialog.ts` — **not** in public `IPC_CHANNELS`.

## Type safety

- Exported `Api` derived from concrete `api` object.
- `invoke<K>()` parameterized by shared `IpcChannelMap`.
- `WiredChannels` exhaustiveness fails typecheck if shared channels are not wired (all 16 `IPC_CHANNELS` names, including `APP_GET_ABOUT`).
- Imports: **shared** contracts only — never `application`, `infrastructure`, or `main`.
- Use `from "electron"` (preload context); not `electron/main`.

## Anti-Patterns

- Never expose `ipcRenderer`, `shell`, `fs`, full `process`, or arbitrary channel names.
- Never put utility-dialog private channels on public `window.api`.
- Never disable `contextIsolation` to simplify renderer code.
- Never add a push listener without cleanup return.
- Never make renderer import Electron; extend the appropriate preload instead.
