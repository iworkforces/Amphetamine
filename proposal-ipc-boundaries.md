### Proposal 2: Enforce Public IPC Boundaries Consistently

#### Context

I would build a small managed desktop utility on these preload and main-process seams. As the app gains commands, I want authorization to be part of registration so a new handler cannot silently weaken the boundary, while existing renderer integrations keep working unchanged.

#### Purpose

The rejected replies differ by channel, including a current-settings snapshot and discriminated session results. A generic throw would change the wire contract. The resize path uses events rather than invokes, and the private dialog uses a different sender policy, so wrapping one helper cannot safely cover every transport path.

#### Task

Make public IPC authorization unavoidable at registration while preserving every existing rejected-sender reply. Move the common sender check into `typedHandle`, with a correctly typed rejection response supplied for each invoke channel, and migrate the handlers in `ipc.ts` and the updater facade. This should prevent a future handler from accidentally omitting authorization without changing what current renderers receive.

Validate the session-start request envelope before reading `durationMinutes`. Invalid envelopes should return `invalid-duration`, while valid indefinite and timed sessions keep their current behavior and error messages. Keep duration policy in the domain layer and leave the public preload API unchanged.

Also give the raw popover height listener a bounded lifetime: cancel pending resize work and remove its own listener when the window is destroyed, while retaining sender validation and burst coalescing. Keep the utility dialog's private channels separate. Add tests that prove rejected senders cannot invoke protected handlers, malformed requests cannot escape as property-access errors, and queued resize work cannot touch a destroyed window; check normal renderer calls in the built app.

#### Evaluation Rubric

1. `typedHandle` validates before dispatch and requires a channel-correct rejection response for every public invoke registration in `src/main/ipc.ts` and `src/main/auto-updater.ts`. Preserve the existing version/about/quit/settings/session/updater fallback values, including the current snapshot for rejected `SETTINGS_SET`, and demonstrate that protected handlers are not called for rejected senders.
2. `SESSION_START` rejects null, arrays, primitives, and missing or invalid duration values with `invalid-duration` before unsafe property access, while rejected senders still receive `rejected`. Preserve `{durationMinutes: null}`, the inclusive 1440-minute limit, the existing over-limit reason, domain validation ownership, and the unchanged public preload API and sixteen-channel contract.
3. Raw `WINDOW_SET_HEIGHT` retains explicit sender checks, 16 ms coalescing, width 360, and the 220..480 height clamp, but cancels pending work and removes only its own listener on popover destruction. Do not broaden the public allowlist, expose generic IPC, weaken secure web preferences, or route private utility-dialog channels through public authorization.
4. Extend the IPC/handler/security-validation tests under `tests/main/`, preserving preload, updater, WindowGraph, and shared-contract regression coverage for packaged Windows/POSIX paths, development origins, and rejected frames. Run `bun run test -- tests/main tests/shared`, `bun run check`, `bun run test:coverage` with unchanged 90% lines/functions/branches, and `bun run build`, then exercise ordinary public renderer calls without changing reply shapes.
