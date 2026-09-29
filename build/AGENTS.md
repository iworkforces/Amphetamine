# Build Resources - Packaging and Signing

Source-controlled packaging resources for electron-builder. Product targets: **macOS** (arm64 + x64) and **Windows** (x64 + arm64). This directory is not disposable output; `dist/` is output.

## Files

| File | Role |
|------|------|
| `icon.icns` | macOS app icon consumed by electron-builder |
| `icon.ico` | Windows app icon consumed by electron-builder |
| `entitlements.mac.plist` | App entitlements: JIT + unsigned executable memory |
| `entitlements.mac.inherit.plist` | Child-process entitlements matching app needs |
| `after-pack.cjs` | Pre-archive: ARM64 strip/locales then **fail-closed** fuse flip (darwin/win32); CI’s fuse path for DMG/ZIP/NSIS |
| `flip-fuses.cjs` | Electron fuse hardening (mac + win; also called from after-pack via `AMPHETAMINE_FUSE_APP_PATH`) |
| `notarize.cjs` | Optional notarization hook; currently disabled by config |

Generate icons: `bun scripts/generate-app-icon.mjs` (writes `icon.icns` on macOS via iconutil, always writes `icon.ico` + hero PNG).

## Packaging Flow

### macOS

1. `bun run build`
2. `electron-builder --mac --<arch>`
3. `node build/flip-fuses.cjs mac <arch>` for distributable package scripts

`package:dir` builds an unpacked app only and does not automatically flip fuses.

`build-macOS-dmg.sh` is the local wrapper: install deps, clean `dist/`, build, package, sign Developer ID if available, otherwise deep ad-hoc re-sign the `.app` without hardened runtime, ad-hoc sign the DMG, and append the environment suffix (e.g. `--environment beta` → `*-beta.dmg`).

### Windows (x64 and arm64)

1. `bun run build` (arch-independent JS/CJS)
2. `electron-builder --win --x64` **or** `--win --arm64` (NSIS + portable)
3. `node build/flip-fuses.cjs win x64` → `dist/win-unpacked/Amphetamine.exe`  
   `node build/flip-fuses.cjs win arm64` → `dist/win-arm64-unpacked/Amphetamine.exe`

| Script | Arch |
|--------|------|
| `bun run package:win` / `package:win:dir` | x64 |
| `bun run package:win:arm64` / `package:win:dir:arm64` | arm64 |

Unsigned by default (`CSC_IDENTITY_AUTO_DISCOVERY: false` in CI). No native Node addons — app ASAR is the same JS for both arches; only the Electron binary differs.

**Release assets (Windows):** publish both arch EXEs (and blockmaps) plus `latest.yml` so electron-updater can pick the matching asset for `process.arch`.

**Release assets (macOS):** publish ZIP (required for electron-updater) plus DMG, **`latest-mac.yml`**, and blockmaps. CI must upload `dist/*.yml` / `dist/*.blockmap` with mac packages; CD merges dual-arch feeds. Missing `latest-mac.yml` makes "Check for Updates" fail with a false network-error dialog.

## CI Packaging Paths

| Pipeline | Branch | Artifact names | Fuses flipped in workflow? |
|----------|--------|----------------|----------------------------|
| CI `build` job | `main` push | `dist-mac-{arch}` (dmg/zip/**yml**/blockmap) | Yes via `afterPack` (fail-closed) |
| CI `build-windows` matrix | `main` push | `dist-win-x64`, `dist-win-arm64` (exe/yml/blockmap) | Yes via `afterPack` (fail-closed) |
| CD release | after main CI | merges multi-arch `latest-mac.yml` / `latest.yml` then publishes | N/A |
| Beta workflow | push to `develop` | mac/win beta artifacts renamed `*-beta-{N}.*` | Yes via `afterPack` (fail-closed) |
| Local `bun run package*` | developer machine | afterPack + post `flip-fuses` on leftover unpacked | Yes |

Windows matrix runners: `windows-latest` (x64), `windows-11-arm` (arm64 native). If arm runners are unavailable for the repo, fall back to cross-compile `--arm64` on `windows-latest` (document in PR).

If changing release packaging, keep CI/CD/Beta and local package scripts intentional about fuse/signing equivalence.

## electron-builder Constraints

- `hardenedRuntime: false` is intentional. Re-enable only with notarization and JIT entitlements.
- `notarize: false` by default. `notarize.cjs` requires `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`.
- `LSUIElement: true` keeps the app tray-only; Settings and About temporarily show the Dock icon at runtime via refcounted `utility-presentation` (same path as updater dialogs). User close hides (warm cache); quit force-destroys.
- `dmg.sign: false`; local wrapper owns ad-hoc DMG signing for quarantine compatibility.
- Windows signing is off by default; add Authenticode later via cert env vars.
- Windows `win.target` includes **x64 and arm64** for NSIS + portable; CI packages one arch per job.
- `electronLanguages: [en]` and after-pack locale stripping keep bundles small.
- `after-pack.cjs`: strip/locales first (arm64 mac only), then fuse flip last for darwin/win32. Fuse miss/failure **throws** (fail-closed).
- Packaged files include `src/assets/!(*Template).png` (template tray icons excluded).

## Flip Fuses

`flip-fuses.cjs` disables RunAsNode, inspect args, and `NODE_OPTIONS`; requires app load from ASAR; enables ASAR integrity and cookie encryption.

**macOS:** after flipping fuses, the script **must** deep re-sign the `.app` (ad-hoc when `CSC_NAME` is unset, else `CSC_NAME`) and `codesign --verify --deep --strict`. Fuse/strip without re-sign causes Apple Silicon `SIGKILL (Code Signature Invalid)` at launch.

```bash
node build/flip-fuses.cjs mac arm64   # dist/mac-arm64/Amphetamine.app
node build/flip-fuses.cjs win x64     # dist/win-unpacked/Amphetamine.exe
node build/flip-fuses.cjs win arm64   # dist/win-arm64-unpacked/Amphetamine.exe
node build/flip-fuses.cjs arm64       # legacy mac alias
```

## Anti-Patterns

- Never distribute a macOS app after fuse flip or strip without re-signing (and verifying) the bundle.
- Never distribute an app bundle before the intended fuse hardening path has run.
- Never enable hardened runtime alone; pair it with notarization and verified Electron/V8 entitlements.
- Never remove JIT/unsigned executable memory entitlements without testing macOS launch.
- Never sign DMG by default in `electron-builder.yml`; keep local ad-hoc behavior in `build-macOS-dmg.sh`.
- Never write generated package output under `build/`; use `dist/`.
- Never mark develop beta prereleases as latest production; tags must stay `vX.Y.Z-beta.N` with `prerelease: true`.
- Beta **filenames** use `-beta-N` (hyphen), e.g. `Amphetamine-2.0.5-arm64-beta-1.dmg`, matching tag sequence N.
- Never assume Windows artifacts are x64-only; release notes and CD must include arm64 when packaging both.

## Commands

```bash
bun run package
bun run package:x64
bun run package:dir
bun run package:win
bun run package:win:dir
bun run package:win:arm64
bun run package:win:dir:arm64
./build-macOS-dmg.sh --environment beta --arch arm64
./build-macOS-dmg.sh --environment stable --arch arm64
bun scripts/generate-app-icon.mjs
```
