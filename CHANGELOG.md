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

## [0.13.0] - 2026-07-23

Two contract changes ship together. **0.12.0 was prepared but never published** — npm went
`0.11.0 → 0.13.0` — so its changes are part of this release, listed under «Ф1 …» below rather
than in a section of their own.

### Ф1 — versioned `RealityModel` (initiative `shared-execution-engine`)

Contract shape only. It deliberately decides **nothing** about which reality model applies in
paper / backtest / live, or with what values: those are the Phase-1 semantics SSOT document's
call, and this release exists so that decision has a vocabulary to be written in. Local status:
[docs/ROADMAP.md](docs/ROADMAP.md).

### 083 E1 — additive `event_driven` kernel contract

Feature E1 of platform epic 083 (`specs/083-event-driven-runtime-spike`) — the kernel contract for
strategies shaped as stateful actors over order flow. Landed ahead of the epic's return trigger
under the early-start exception recorded 2026-07-23 in the `shared-execution-engine` card (Ф6):
E1 is purely additive vocabulary, changes no runtime in any repo, and leaves every existing bundle
valid under the default `single_position`. E2–E7 (isolate dispatch boundary, engine, order-flow
RiskEngine, event spine) stay behind the trigger — nothing here executes anything.
`CONTRACT_VERSION` moves `017.2` → `017.3`; `017.1` and `017.2` manifests stay supported, but they
may not declare the surface `017.3` introduced.

### Added (083 E1 — `event_driven`)

- `research-contract`: **`lifecycle`** on `ModuleManifest` — the declared *shape* of a strategy,
  `'single_position' | 'event_driven'`. Absent means `single_position`, so a manifest written
  before 083 describes exactly the same strategy it always did (SC-008).
- `research-contract`: the actor vocabulary (`src/research-contract/event-driven.ts`) —
  `StrategyActor` (one entry point, `onEvent`), `ActorInputEvent` (`bar`, `order.accepted` /
  `denied` / `rejected` / `canceled` / `expired`, `fill`, `timer`), `ActorCommand` (`place`,
  `cancel`, `timer.set`, `timer.cancel`, `annotate`), `ActorContext`, `EventDrivenModule`,
  plus the `OpenOrderView` / `PositionView` / `FlatMarketSlice` shapes the envelope carries.
  Three 083 decisions are load-bearing in these types: the strategy mints its own
  `clientOrderId` (OrderTicket without a handle across the isolate's JSON boundary); size is an
  explicit `qtyUsd` *request* that the RiskEngine clamps rather than an indirect hint (Q2); and
  `modify` is deliberately absent in v1 — place-after-cancel keeps the FSM and its proof small
  (Q3). `order.denied` (local risk refusal) stays distinct from `order.rejected` (venue refusal).
- `research-contract`: **`defineActor(handlers)`** — sugar that compiles per-kind handlers into
  the single `onEvent` of the kernel contract, so the contract itself stays narrow (the LEAN
  `IAlgorithm` lesson). A specific handler wins over the catch-all `onEvent`; an unhandled kind
  yields an empty batch; an unknown kind throws rather than being silently dropped. Dispatch is
  an explicit switch over the closed union — no object iteration, no computed method names, as
  the engine's determinism definition requires.
- `research-contract`: `onEvent` added to `LifecycleHook` (appended last, so the canonical hook
  order of existing manifests does not shift), plus `STRATEGY_LIFECYCLES`,
  `DEFAULT_STRATEGY_LIFECYCLE`, `EVENT_DRIVEN_HOOKS`, `SINGLE_POSITION_ONLY_HOOKS`,
  `ACTOR_INPUT_EVENT_KINDS`, `ACTOR_COMMAND_KINDS`.
- `validation`: form validator for the declared shape — new code `lifecycle_form_invalid`. The two
  shapes are kept disjoint rather than layered: `event_driven` must declare `onEvent` and may not
  carry the phase-model hooks, `single_position` must declare `onBarClose` (unchanged) and may not
  carry `onEvent`, and an overlay may not declare the actor shape at all (interception is defined
  only for the phase model). A mixed hook set means the author has not chosen a shape — rejected
  at submit time rather than at runtime (083 D5: the shapes are built beside each other, never on
  top of each other).
- `validation`: three bundled schemas for the isolate envelope —
  `actor-input-event.schema.json`, `actor-command.schema.json` and
  `actor-command-batch.schema.json`. What crosses the boundary is the **batch** a single `onEvent`
  returns, so `ActorCommandBatch` is the schema a host validates; the single-command schema is its
  `$ref` target and stays available for spot checks. Reachable through `schemaAsset` /
  `SCHEMA_IDS` / `validateCore`. They are wire forms, not submit-time artifacts, so `validate()`
  gains no arm for them.
- `research-contract`: the `place` and `timer.set` commands are **split into closed variants** so
  an ambiguous command cannot type-check or pass AJV. `place` branches on order type — `market`
  carries no price, `limit` requires `price`, `stop_market` requires `stopPrice` — and `timer.set`
  is an exclusive choice between absolute `atTs` and relative `afterMs`. Commands arrive from
  untrusted code across a JSON boundary; an under-specified command has to fail at the schema, not
  reach the engine and get interpreted there.

### Changed (083 E1 — `event_driven`)

- `research-contract`: `CONTRACT_VERSION` `017.2` → `017.3` (the manifest envelope gained
  `lifecycle` and `onEvent`); `SUPPORTED_CONTRACT_VERSIONS` appends `017.3`. Manifests declaring
  `017.1`/`017.2` keep validating — their shape is the default `single_position` — but declaring
  `lifecycle` or the `onEvent` hook under them is now rejected with `unsupported_contract_version`
  (`EVENT_DRIVEN_MIN_CONTRACT_VERSION`). Without that rule the bump would have been decorative:
  `contractVersion` would no longer tell you which manifest envelope the author wrote against.
  The code's documented meaning widens accordingly — «version outside the supported set **or** not
  covering the declared surface».
- `validation`: `NormalizedManifest` echoes `lifecycle` **only when it was declared explicitly**,
  appended last. Substituting the default would shift the projection — and the content hash — of
  every module that predates 083; read an absent field through `DEFAULT_STRATEGY_LIFECYCLE`.

### Migration (083 E1 — `event_driven`)

None. No consumer has to move and no existing bundle changes meaning. Authoring an
`event_driven` module is opt-in and, until 083 E2–E3 land, nothing executes one — the value of
shipping E1 now is that `lab` can prepare event-driven authoring against a stable vocabulary.

### Added (Ф1 — `RealityModel`)

- `research-contract`: new **`RealityModel`** — the declared properties of the execution
  *environment*, split out of `ExecutionProfile` (which keeps *intent*). Runner-owned and
  versioned by `id`+`version` exactly like `RiskProfile`/`ExecutionProfile`, bound to a run
  through the new optional `BacktestRunRequest.realityModelRef`. Rationale: the same bundle is
  today executed by two semantically incompatible interpreters (platform paper vs backtester),
  and with the model slots typed as bare `object` that divergence was not expressible in the
  contract — therefore not provable.
- `research-contract`: every environment slot is now a **closed discriminated catalog** instead of
  `object` — `FillModel` (`next_bar_open` | `same_bar_close`), `FeeModel` / `SlippageModel`
  (`fixed_bps`), `FundingModel` (`per_minute_prorate`), `LatencyModel` (`zero`),
  `PartialFillModel` (`none`). Shapes are taken from the only implementation that already types
  them (backtester `engine/profiles.ts`); a catalog gains a member when an interpreter implements
  it, not before — which is why `LatencyModel` ships with `zero` alone and no speculative
  `fixed_ms`. Exported alongside the kind literals (`FILL_MODEL_KINDS`, …) and
  `REALITY_MODEL_KIND_CATALOG` for consumers that need the closed set at runtime.
- `research-contract`: **`resolveRealityModel({ executionProfile, realityModelRef?, realityModel? })`**
  — the one sanctioned read during the dual-read window, and the only place the run's binding is
  checked against what the caller actually resolved. Every ambiguity fails closed rather than
  resolving to something (constitution XIV — no silent fallback): a bound `realityModelRef` with
  no resolved model → `unresolved_reality_model_ref`; a resolved model whose `id@version` differs
  from the ref → `reality_model_ref_mismatch` (otherwise a run would execute against an
  environment it never declared — precisely the substitution that versioning the model is meant to
  prevent); both forms present and disagreeing → `conflicting_reality_model`; neither present →
  `missing_reality_model`. The embedded form resolves without a `ref`: an `ExecutionProfile`'s
  identity is not the reality model's identity.
- **The reality model is bound in exactly one place** — `BacktestRunRequest.realityModelRef`,
  mirroring `riskProfileRef`/`executionProfileRef` (FR-016). `ExecutionProfile` deliberately
  carries no ref of its own: a second binding point would be a second source of truth with no rule
  for resolving the two against each other.
- `validation`: new input arm `inputKind: 'reality_model'` plus the core schema
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

### Changed (Ф1 — `RealityModel`)

- `research-contract`: `ExecutionProfile.fillModel` / `feeModel` / `slippageModel` are now
  **optional and `@deprecated`**, and they plus `latency` / `partialFill` are typed to the closed
  catalogs instead of `object`. They remain accepted for the whole dual-read window — nothing is
  rejected by this release. Two type-level notes for consumers compiling against these fields:
  reading them now yields `T | undefined` (a profile that delegates to a `realityModelRef` carries
  no embedded slots), and assigning an off-catalog object no longer type-checks.

  **This is a source-breaking change shipped in a minor**, which `0.x` permits — see the rule now
  written down in [README §Versioning](README.md#pre-10-a-minor-bump-may-be-source-breaking) and
  AGENTS.md. No repo in the trdlabs ecosystem imports `ExecutionProfile` from this package today
  (`backtester` declares its own copy in `packages/research-contracts`), but that says nothing
  about external npm consumers, so treat it as breaking and read the slots through
  `resolveRealityModel` rather than directly.
- `research-contract`: `fundingModel` (035, backtester-only until now) is part of the contract for
  the first time, as a `RealityModel` slot and a deprecated `ExecutionProfile` slot.

### Migration (Ф1 — `RealityModel`)

Additive at the wire/validation layer; no consumer has to move. During the dual-read window an
`ExecutionProfile` may carry the model slots inline as before. To adopt the split form, register the environment as a `RealityModel`
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

[Unreleased]: https://github.com/trdlabs/sdk/compare/sdk-v0.13.0...HEAD
[0.13.0]: https://www.npmjs.com/package/@trdlabs/sdk/v/0.13.0
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
