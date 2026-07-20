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

## [0.11.0] - 2026-07-20

### Added

- `conformance`: `runHistoricalConformance` now covers three `historical.2` semantics
  the harness previously left untested (control-center initiative
  `mock-contract-parity`, item 4; audit findings P0-1 / P1-1 / P2-3): the row range is
  half-open `[fromMs, toMs)` (the bar at `minute_ts == toMs` must not be returned, and
  `[t, t)` is empty); multi-symbol responses carry a global `(minute_ts ASC, symbol ASC)`
  total order rather than a per-symbol concatenation in request order; a page never
  exceeds either the requested `limit` or the `maxPageItems` the target advertises on
  `/historical/discover` (an available `rows` resource that declares no page cap is now a
  failure, not a pass), and an oversized `limit` clamps deterministically and losslessly
  (row-for-row, not just by count) instead of erroring or dropping rows. Note that a real
  clamp is unobservable on a conformance-sized dataset — the harness also requires an
  unpaginated request to return every row — so what is asserted is the falsifiable half:
  the target never serves more than it advertises.
- `conformance`: pagination is now bounded by two independent guards — a repeated cursor
  fails fast on its second sighting, and a per-query page budget (`opts.maxPages`,
  default 10 000) bounds a pager that keeps advancing with fresh cursors.
- `conformance`: new optional `opts.onSkip` reports checks a target's *dataset* could not
  exercise (e.g. multi-symbol ordering against a single-symbol fixture) instead of letting
  them count as passes. Structural limits that hold for every fixture are not reported as
  skips, so a downstream gate can fail on any non-empty skip list.
  The return value stays `{ ok: true }` — existing callers are unaffected.
- `test`: `test/historical-conformance.test.ts` runs the harness against a reference
  implementation of the platform semantics and asserts it rejects each divergence class.

## [0.10.0] - 2026-07-15

### Changed

- `historical`: `HistoricalClient` is now resilient by construction (P2-12).
  Requests get a per-request timeout spanning fetch **and** body read/parse
  (`timeoutMs`, default 30000), bounded retry with full-jitter capped backoff
  (`maxAttempts`/`retryBaseMs`/`retryMaxMs`), and `queryRows` fails closed on
  pagination cycles and on `maxPages`/`maxRows`/`operationDeadlineMs` caps.
  All new options are optional with safe defaults — no consumer migration
  required. `SDK_VERSION` now reports `0.10.0`.

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

[Unreleased]: https://github.com/trdlabs/sdk/compare/sdk-v0.11.0...HEAD
[0.11.0]: https://www.npmjs.com/package/@trdlabs/sdk/v/0.11.0
[0.10.0]: https://www.npmjs.com/package/@trdlabs/sdk/v/0.10.0
[0.9.5]: https://github.com/trdlabs/sdk/releases/tag/sdk-v0.9.5
[0.9.4]: https://www.npmjs.com/package/@trdlabs/sdk/v/0.9.4
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
