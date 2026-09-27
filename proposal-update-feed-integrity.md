### Proposal 3: Reject Inconsistent Update Feeds Before Publishing

#### Context

I would use this release pipeline for a desktop utility distributed to both Intel and ARM machines. I want a rerun or reordered artifact download to produce identical update metadata, and a contradictory feed to fail before users are offered the wrong asset or checksum.

#### Purponse

The pipeline has separate single-feed and multi-feed branches for each platform, so improving the merger alone leaves a bypass. Legacy feeds also synthesize missing size information, which must not become a false conflict. Determinism requires consistent top-level selection as well as sorted file entries and explicit handling of contradictory metadata.

#### Task

Make update-feed merging reject contradictory metadata and produce the same output regardless of input order. A repeated asset URL must not silently replace another checksum or known size, and the selected top-level path and checksum must agree with the corresponding file entry. Keep the existing preference for a non-arm64 generic path, with deterministic tie handling.

Work within `scripts/merge-latest-yml.ts` and the production CD feed step. Preserve valid path-only legacy feeds and distinguish their synthetic unknown size from a real size conflict. Reject malformed present file lists instead of treating them as legacy input, and cover the supported quoted scalars and line endings without turning this into a general YAML implementation.

Route both single-feed and multi-feed macOS and Windows paths through validation before staging. Keep the existing requirement for at least one feed per platform and the asset-staging collision policy. Add conflict, permutation, legacy, and malformed-input tests, then exercise the real CLI with scratch fixtures and verify that rejected input leaves an existing output untouched. Do not publish releases or change beta, signing, or architecture-quorum policy.

#### Evaluation Rubric

1. `parseLatestYml` distinguishes absent legacy `files` data from a present malformed or empty list, validates supported scalar/file fields, and rejects non-finite, negative, or fractional explicit sizes. Preserve valid path-only input and its unknown-size meaning, with LF/CRLF and quoted-scalar fixtures covering the repository's fixed format rather than claiming general YAML support.
2. `mergeFeeds` rejects mismatched versions and conflicting known hashes or sizes for duplicate URLs, deduplicates equivalent entries, and checks each input and output top-level path/checksum against its file metadata. Preserve legacy unknown-size compatibility and non-arm64 preference, and make serialization byte-identical across input permutations, including ties and differing release dates.
3. Both platform branches in `.github/workflows/cd.yml` validate one or multiple feeds through the merger before staging, and invalid input exits nonzero without replacing an existing output. Preserve the requirement for at least one feed per OS, release-skip behavior, the collision-warning policy in `scripts/stage-release-assets.py`, and current beta, signing/fuse, and architecture-quorum behavior.
4. Extend `tests/main/merge-latest-yml.test.ts` with conflict, malformed-list, legacy/known-size, top-level consistency, and permutation cases using mocked I/O where needed, then run `bun run scripts/merge-latest-yml.ts <inputs> --out <output>` against scratch fixtures for both feed names without publishing. Run `bun run test -- tests/main/merge-latest-yml.test.ts`, `bun run check`, `bun run test:coverage` with unchanged global 90% lines/functions/branches, and `bun run build`, without treating the source-only coverage threshold as script coverage.
