# Changelog

All notable changes to `@trdlabs/sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each entry notes the contract-area version it touches (e.g. `OPS_READ_CONTRACT_VERSION`)
and, where relevant, the originating platform capability. Additive, optional
changes are minor bumps; behaviour-breaking changes call out a migration note.

This log was reconstructed from git tags and commit history on 2026-07-11; the
pre-public early entries (0.4.0–0.5.0) are summarised from their release commits.

## [Unreleased]

## [0.9.5] - 2026-07-04

### Added

- `intake`: `proposedRiskProfile` on `PaperCandidateIntakeRequest` (platform 087).
  Additive and optional — no consumer migration required.

## [0.9.4] - 2026-07-04

First public npm release on the `@trdlabs/sdk` name (published to the npm
registry as `latest`). No API change over 0.9.3 — this was the release-prep /
publish cut. Note: this version was published but not tagged in-repo; the git
tag sequence jumps 0.9.3 → 0.9.5.

## [0.9.3] - 2026-07-03

### Fixed

- `ops-read`: bump `OPS_READ_CONTRACT_VERSION` `ops.5` → `ops.6` to match the DTO
  that already carried `bundleId` (corrects a 0.9.2 version oversight).

## [0.9.2] - 2026-07-03

### Added

- `ops-read`: `BotRunRecord.bundleId` — the `candidateId` ↔ run join key
  (platform 074).

## [0.9.1] - 2026-07-03

### Added

- `intake`: identity fields on `PaperCandidateStrategyInput` — `strategyName`,
  `side`, `params` (platform 062).

## [0.9.0] - 2026-06-30

### Added

- `ops-read`: ops.5 close-reason surface — `CloseReason` enum and
  `closeReasonRaw` on `ClosedTrade` / `TradeEvidence`.

## [0.8.0] - 2026-06-29

### Added

- `ops-read`: ops.4 trade-evidence surface — `ClosedTrade` entry/exit and
  `TradeEvidence` / lifecycle types.

## [0.7.2] - 2026-06-24

### Added

- `validation`: export the 017 schema-assets from `./validation` (042 FU2).

## [0.7.1] - 2026-06-24

### Added

- `validation`: export `CODE_SEVERITY` and `ALL_VALIDATION_CODES` from
  `./validation`.

## [0.7.0] - 2026-06-24

### Added

- `validation`: strategy-contract and validator kernel (042 Phase A).

## [0.6.0] - 2026-06-24

### Changed

- `intake`: drop `researchJobRef` from the intake DTO.

## [0.5.0] - 2026-06-22

### Removed

- Internal plan doc and stray compiled artifacts removed before public release.
  (Shares a release commit with 0.4.0; the delta is packaging cleanup only.)

## [0.4.0] - 2026-06-22

### Added

- Initial standalone SDK scaffold: kept the consumer surface (ops-read, intake,
  historical, conformance), shed builder/agent/research internals. Materialised
  the historical `CanonicalRowV2` DTO and a self-contained historical
  conformance harness. Added Apache-2.0 license, README, publish allowlist gate,
  and the sdk-release workflow.

[Unreleased]: https://github.com/trdlabs/sdk/compare/sdk-v0.9.5...HEAD
[0.9.5]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.9.5
[0.9.4]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.9.5
[0.9.3]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.9.3
[0.9.2]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.9.2
[0.9.1]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.9.1
[0.9.0]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.9.0
[0.8.0]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.8.0
[0.7.2]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.7.2
[0.7.1]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.7.1
[0.7.0]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.7.0
[0.6.0]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.6.0
[0.5.0]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.5.0
[0.4.0]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.4.0
