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

## [0.12.0] - 2026-07-23

Phase 1 of the cross-repo initiative `shared-execution-engine` (control-center
`docs/delivery/initiatives/shared-execution-engine.md`; local status in
[docs/ROADMAP.md](docs/ROADMAP.md)) — contract shape only. It deliberately decides **nothing**
about which reality model applies in
paper / backtest / live, or with what values: those are the Phase-1 semantics SSOT document's
call, and this release exists so that decision has a vocabulary to be written in.

### Added

- `research-contract`: new **`RealityModel`** — the declared properties of the execution
  *environment*, split out of `ExecutionProfile` (which keeps *intent*). Runner-owned and
  versioned by `id`+`version` exactly like `RiskProfile`/`ExecutionProfile`, bound to a run
  through the new optional `BacktestRunRequest.realityModelRef`. Rationale: the same bundle is
  today executed by two semantically incompatible interpreters (platform paper vs backtester),
  and with the model slots typed as bare `object` that divergence was not expressible in the
  contract — therefore not provable.
- `research-contract`: every environment slot is now a **closed discriminated catalog** instead of
  `object` — `FillModel` (`next_bar_open` | `same_bar_close`), `FeeModel` / `SlippageModel`
  (`fixed_bps`), `FundingModel` (`per_minute_prorate`), `LatencyModel` (`zero` | `fixed_ms`),
  `PartialFillModel` (`none`). Shapes are taken from the only implementation that already types
  them (backtester `engine/profiles.ts`); a catalog gains a member when an interpreter implements
  it, not before. Exported alongside the kind literals (`FILL_MODEL_KINDS`, …) and
  `REALITY_MODEL_KIND_CATALOG` for consumers that need the closed set at runtime.
- `research-contract`: **`resolveRealityModel(executionProfile, realityModel?)`** — the one
  sanctioned read during the dual-read window. Split form and embedded form both resolve; if both
  are present and agree, the split form wins; if they *disagree* it fails with
  `conflicting_reality_model` rather than silently picking one, and a missing/incomplete model
  fails with `missing_reality_model` rather than defaulting (constitution XIV — no silent
  fallback). The embedded form resolves without a `ref`: an `ExecutionProfile`'s identity is not
  the reality model's identity.
- `validation`: new input arm `inputKind: 'reality_model'` plus the sixth core schema
  `reality-model.schema.json` (`SCHEMA_FILES` / `SCHEMA_IDS` / `schemaAsset`). An off-catalog
  `kind` gets its own machine-readable code rather than a generic `schema_invalid`, mirroring
  `unknown_metric` / `unsupported_market_data_kind`: `fillModel` keeps the more specific 024 code
  `unsupported_fill_model_kind`, and the remaining slots report the new
  `unsupported_reality_model_kind`. A *recognised* kind carrying a malformed payload stays
  `schema_invalid`.
- `research-contract`: `ExecutionProfile` gains optional intent slots `orderType`
  (`market` | `limit` | `stop_market`) and `timeInForce` (`gtc` | `ioc`), the vocabulary spec 083
  already uses. Sizing is deliberately still absent — size ceilings are `RiskProfile`'s hard
  authority (FR-013/FR-015) and must not be restated here.

### Changed

- `research-contract`: `ExecutionProfile.fillModel` / `feeModel` / `slippageModel` are now
  **optional and `@deprecated`**, and they plus `latency` / `partialFill` are typed to the closed
  catalogs instead of `object`. They remain accepted for the whole dual-read window — nothing is
  rejected by this release. Two type-level notes for consumers compiling against these fields:
  reading them now yields `T | undefined` (a profile that delegates to a `realityModelRef` carries
  no embedded slots), and assigning an off-catalog object no longer type-checks. No repo in the
  ecosystem imports `ExecutionProfile` from this package today — `backtester` declares its own
  copy in `packages/research-contracts` — so the practical blast radius is zero; use
  `resolveRealityModel` rather than reading the slots directly.
- `research-contract`: `fundingModel` (035, backtester-only until now) is part of the contract for
  the first time, as a `RealityModel` slot and a deprecated `ExecutionProfile` slot.

### Migration

Additive; no consumer has to move. During the dual-read window an `ExecutionProfile` may carry the
model slots inline as before. To adopt the split form, register the environment as a `RealityModel`
and point at it with `realityModelRef` (on the run request, or on the execution profile). The
embedded form stops being accepted only after platform, backtester and lab consume the split form
— one minor plus one major cycle away, announced separately.

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

[Unreleased]: https://github.com/trdlabs/sdk/compare/sdk-v0.12.0...HEAD
[0.12.0]: https://www.npmjs.com/package/@trdlabs/sdk/v/0.12.0
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
