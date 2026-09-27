### Proposal 1: Make Startup and Shutdown Race-Safe

#### Context

I would use this app on a development laptop that starts several login utilities together. I want to be able to quit Amphetamine immediately, even while its settings are loading, without leaving sleep prevention active or needing to kill the process manually.

#### Purpose

A flag in the entry point cannot stop an awaited composition initializer from acquiring resources later. Battery reads also outlive their polling interval, while several cleanup operations can throw. The tests must control those boundaries independently and prove that completion means resource ownership has ended, without creating a deadlock between startup and shutdown.

#### Task

Make Amphetamine's startup and shutdown safe when initialization is still waiting on settings, when startup fails partway through, or when callers request the same lifecycle operation twice. A quit during startup must not leave a tray, shortcut, sleep blocker, or background callback alive after cleanup completes.

Keep lifecycle coordination in `AppShell` and `createAppComposition`. Concurrent initialization should share one operation, concurrent cleanup should share completion, and closing should be terminal for that instance. Guard continuations after awaits and discard battery samples that arrive after disposal. Handle bootstrap rejection explicitly so it reaches cleanup instead of only the global rejection logger; avoid a circular wait between initialization and cleanup.

Preserve the existing ready and teardown order, the 2000 ms settings-flush bound, benchmark updater suppression, and persisted sleep preferences. Add deferred-promise and fake-timer tests for the adversarial interleavings, including a throwing disposer, then exercise normal startup and quit in the built app. Do not add a second quit handler or move resource ownership into a new container.

#### Evaluation Rubric

1. Concurrent `init()` calls share initialization, concurrent `cleanup()` calls share completion, and closing prevents later initialization or readiness on the same instance. Deferred settings resolution, partial startup failure, and the bootstrap rejection path in `src/main/index.ts` cannot register IPC, tray, or updater work after completed cleanup, and do not deadlock.
2. Composition releases settings subscriptions, battery/session listeners and timers, sleep prevention, shortcuts, updater resources, and utility windows even when one disposer throws; AppShell still disposes tray and windows. A battery read resolving after disposal cannot report a sample, stop a session, or notify the user, and repeated cleanup does not repeat disposal effects.
3. Keep the existing startup/quit ordering, the 2000 ms settings-flush race with its losing timer cancelled, benchmark updater suppression, and persisted intent/default-duration behavior. Preserve the twelve-port architecture, sole WindowGraph factory, sole settings-reaction subscriber, and sole `before-quit` owner rather than bypassing adapters or adding a lifecycle container.
4. Extend `tests/main/app-shell.test.ts`, `tests/main/composition-root.test.ts`, `tests/main/index.test.ts`, and `tests/main/battery-monitor.test.ts` with controlled interleavings and failure assertions, retaining composition-wiring regressions. Run `bun run test -- tests/main`, `bun run check`, `bun run test:coverage` with unchanged 90% lines/functions/branches, and `bun run build`, then confirm normal startup and quit through the app without real OS calls in unit tests.
