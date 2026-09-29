# GitHub Workflows - CI/CD

Workflow definitions for lint/test/build, production release publishing, and develop beta packaging. These files couple package versioning, CI artifacts, and runtime auto-updater release URLs.

## Files

| File | Role |
|------|------|
| `ci.yml` | Lint, sticky typecheck, test; main-branch macOS + Windows package artifacts |
| `cd.yml` | Release successful CI artifacts from main via `workflow_run` |
| `beta.yml` | Beta-suffixed macOS + Windows package artifacts on `develop` |

## CI Rules

- CI runs on push and pull request for `main` and `develop`.
- Concurrency: PR runs cancel outdated checks for the same PR number; push runs use
  `github.sha` and do **not** cancel in-progress work (avoids aborted develop/main
  merges when a second request for the same ref is queued).
- Node is pinned to `26.10.0`; Bun is pinned to `1.4.2`.
- Install uses `bun install --frozen-lockfile`.
- Lint job includes a source guard: fail if `OCWorkforces` appears under `src/`.
- Lint job runs: `typecheck`, `typecheck:tests`, `typecheck:sticky`, `typecheck:layers`, then `lint`.
- Build jobs run only for push to `main` after lint and test pass.
- macOS matrix packages arm64 on `macos-latest` and x64 on `macos-15-intel`.
- Windows matrix packages **x64** on `windows-latest` and **arm64** on `windows-11-arm` (NSIS + portable `.exe`).
- Artifacts: `dist-mac-{arch}` (dmg/zip/**yml**/blockmap) and `dist-win-{arch}` (`x64` / `arm64`, exe/yml/blockmap) for 14 days (no `-beta` suffix).
- **Mac update feed:** CI must upload `latest-mac.yml` (and blockmaps). CD merges arm64+x64 feeds into one release asset. Without `latest-mac.yml`, packaged macOS apps fail "Check for Updates" with a false network error.
- Packaging uses `electron-builder`; **fuses flip fail-closed via `build/after-pack.cjs`** on archived outputs (same path as local `bun run package*`, which also runs post `flip-fuses.cjs` on leftover unpacked apps).

## CD Rules

- CD triggers from successful CI `workflow_run` on `main`, not directly from tags.
- It checks out the CI head SHA with full history (`fetch-depth: 0`) and fetches tags.
- It creates and pushes `v<version>` only if the git tag is missing.
- Skip re-publish only when a **GitHub release already has assets** — not merely when the tag exists (allows recovery after tag-push + failed asset upload).
- It resolves the previous **production** tag (`vX.Y.Z` only) and calls GitHub
  `GET /repos/{owner}/{repo}/releases/generate-notes` for auto release notes.
- Release body includes a short production preamble plus the generated "What's Changed" section.
- It downloads `dist-mac-arm64`, `dist-mac-x64`, `dist-win-x64`, and `dist-win-arm64` artifacts from that CI run.
- It verifies at least one DMG, ZIP, or EXE before `softprops/action-gh-release` publishes.
- It **merges** multi-arch `latest-mac.yml` / `latest.yml` via `scripts/merge-latest-yml.ts` before attaching release assets (unique basenames on GitHub).
- Staging: `python3 scripts/stage-release-assets.py` → `artifacts/release-staging/` (feeds from `update-feed/`; binaries from arch dirs; collisions never fail the job).
- Publish uses `gh release create|upload --clobber` (not softprops) so existing tags without assets can recover cleanly.
- Do **not** embed large Python heredocs in `cd.yml` — GitHub can reject the workflow file as invalid YAML.
- Do **not** put Actions expression markers (dollar-brace-brace) in `run:` script comments; the workflow linter still parses them (`An expression was expected`).
- Release concurrency is global `release` with `cancel-in-progress: false`.
- **CD workflow file must exist on the default branch (`main`)** for `workflow_run` to fire.

## Beta Rules

- Beta triggers on **`push` to `develop`** (covers PR merges) and `workflow_dispatch` (manual re-run).
- **Why not `workflow_run`?** GitHub only registers `workflow_run` listeners from workflow files on the **default branch** (`main`). `beta.yml` is develop-oriented and is not required on `main`, so a `workflow_run` listener would never fire.
- Jobs: `lint` + `test` → **`prepare`** (version + beta N) → `package` / `package-windows` → **`release`**.
- Packaging: mac arm64/x64 plus Windows x64/arm64 (`package` + `package-windows` matrix).
- After `electron-builder`, basenames get a **`-beta-{N}`** suffix (e.g. `Amphetamine-1.10.9-arm64-beta-1.dmg`).
  Tag uses a dot (`v1.10.9-beta.1`); filenames use a hyphen before N (`-beta-1`).
- Artifacts: `dist-mac-beta-{arch}` and `dist-win-beta-{arch}` (`x64` / `arm64`) for 14 days.
- **`prepare` job** (after lint/test) computes a single N for the run so tags and filenames match.
- **`release` job** publishes a GitHub **prerelease** (not latest production):
  - Tag: `v{package.json.version}-beta.{N}` where **N restarts at 1** for each package
    version (max existing `vX.Y.Z-beta.*` + 1; not `github.run_number`)
  - Auto release notes via GitHub generate-notes API (range: previous `v*-beta.*`, else latest production `vX.Y.Z`)
  - Body: beta preamble + generated "What's Changed"
  - `prerelease: true`, `make_latest: false` so it does not replace production `vX.Y.Z` releases
  - Attaches `*-beta-{N}.dmg` / `*-beta-{N}.zip` / `*-beta-{N}.exe`
- Production CD still owns non-prerelease tags `vX.Y.Z` from `main`.
- Concurrency group is `beta-${{ github.ref }}` with `cancel-in-progress: true`.
- Local equivalent suffix: `./build-macOS-dmg.sh --environment beta --arch arm64`.

## Gotchas

- Actions are pinned by commit SHA; update comments and SHAs together.
- Keep CI Node/Bun pins aligned with `package.json` engines and package manager.
- Keep CI `electron-builder` + `afterPack` fuse flipping equivalent to local `package*` scripts (afterPack fail-closed + post `flip-fuses` on leftover unpacked where applicable).
- Runtime updater opens GitHub release URLs derived from package metadata; release tags must match `v<package.json.version>`.
- Do not put generated artifacts under workflow source directories; CI downloads into temporary `artifacts/` paths.
- CD still uses `workflow_run` and must remain defined on the default branch path that receives main CI successes.
- Do not confuse main artifacts (`dist-mac-arm64`) with beta artifacts (`dist-mac-beta-arm64`).
