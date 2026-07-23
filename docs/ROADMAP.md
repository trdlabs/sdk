# @trdlabs/sdk Roadmap

## B2C readiness (cross-repo, 2026-07-17)

Canonical status lives in the control-center
[initiative registry](../../control-center/docs/delivery/cross-repo-initiatives.md) —
local status only, no plan duplication.

- [b2c-f1-tenancy](../../control-center/docs/delivery/initiatives/b2c-f1-tenancy.md) — `proposed`.
  SDK part: optional `tenantId?` on intake/ops-read DTOs (additive minor, per the
  `proposedRiskProfile` 0.9.5 precedent) + a new `./tenancy` subpath (`Tenant`, `PlanId`).
  A **required** tenantId is breaking (bidirectional conformance gates + `ops.x` exact
  match) — enforcement happens via service-side flags, never at the wire seam.
- [b2c-cal](../../control-center/docs/delivery/initiatives/b2c-cal.md) — `proposed`.
  SDK part: new `./allocation` subpath (`AllocationConfig`, `AllocationResult`) and a typed
  `SizedRiskProfile` — today `sizing.baseOrderUsd` crosses the intake seam untyped
  (`src/intake/dto.ts:78`, `Record<string, unknown>`), and the research-contract
  `RiskProfile` is a different shape with the same name.
- [b2c-sdk-consolidation](../../control-center/docs/delivery/initiatives/b2c-sdk-consolidation.md) — `enabled`.
  Settled 2026-07-17 as Option A+ (full merge **rejected** with a revisit trigger):
  `@trdlabs/backtester-sdk` stays a standalone npm package; no `./backtester` subpath here.
  Remaining sdk-side stake: type dedup (`Ref`, `RunPeriod`, `BacktestRunRequest` re-sourced
  from this package). Three-package layout re-confirmed 2026-07-22 by
  [shared-execution-engine](../../control-center/docs/delivery/initiatives/shared-execution-engine.md).

Full analysis: control-center
[`docs/analysis/06-b2c-readiness-report.md`](../../control-center/docs/analysis/06-b2c-readiness-report.md)
(SDK contract inventory, tenancy gaps, versioning constraints).

## Mock-platform audit (cross-repo, 2026-07-18)

Canonical status lives in the control-center
[initiative registry](../../control-center/docs/delivery/cross-repo-initiatives.md) —
local status only, no plan duplication.

- [mock-contract-parity](../../control-center/docs/delivery/initiatives/mock-contract-parity.md) — `proposed`.
  SDK part: extend `runHistoricalConformance` with the divergence classes the mock
  currently passes despite — boundary bar (`minute_ts == toMs` must be excluded:
  half-open `[fromMs, toMs)`), multi-symbol global `(minute_ts, symbol)` ordering,
  limit clamp. Land the cases red against the unfixed mock first. Become the single
  harness source (mock currently vendors the platform-repo copy) and the target of
  mock's pin migration off the legacy `@trading-platform/sdk` 0.9.3 tarball.
  SDK item 4 delivered ([#22](https://github.com/trdlabs/sdk/pull/22)): the three case
  groups are in `runHistoricalConformance`, landed red against the unfixed mock, with
  `test/historical-conformance.test.ts` pinning each divergence class against a reference
  target. One caveat carries into the mock work — multi-symbol ordering reports a skip on
  the single-symbol `historical-golden` fixture, so a fail-on-skip gate there needs a
  two-symbol fixture first. Items 5 (pin / single harness source) and the mock-side fixes
  stay open.

Full audit: control-center
[`docs/analysis/09-mock-platform-audit.md`](../../control-center/docs/analysis/09-mock-platform-audit.md).

## Shared execution engine (cross-repo, 2026-07-22)

Canonical status lives in the control-center
[initiative registry](../../control-center/docs/delivery/cross-repo-initiatives.md) —
local status only, no plan duplication.

- [shared-execution-engine](../../control-center/docs/delivery/initiatives/shared-execution-engine.md) — `proposed`.
  Package-layout decision recorded 2026-07-22: `@trdlabs/sdk` stays the **zero-dependency
  vocabulary** (contracts, validation, consumer surface); the deterministic execution core
  ships as a separate public `@trdlabs/engine` that depends on this package — this **revises
  Q1-083** ("engine-core inside the SDK"; one owner of execution semantics is preserved, only
  the address changes). `@trdlabs/backtester-sdk` remains standalone (doc 07 A+ upheld).
  SDK part (Phase 1 of the card) — **delivered in 0.13.0** ([#26](https://github.com/trdlabs/sdk/pull/26), hardened in [#28](https://github.com/trdlabs/sdk/pull/28)):
  - Separate a **versioned `realityModel`** (fill/fee/slippage/latency — environment
    properties) out of the 017 `ExecutionProfile` (which keeps intent: order type, TIF,
    sizing, timeout/cancel). Additive, with a dual-read window per versioning-policy.
    Landed as `research-contract/reality-model.ts` + `BacktestRunRequest.realityModelRef` (the
    **single** binding point, mirroring `riskProfileRef`/`executionProfileRef` per FR-016) +
    `resolveRealityModel` — the one sanctioned read during the window, fail-closed on an
    unresolved ref, an `id@version` mismatch against the ref, or a split-vs-embedded conflict.
  - Tighten the `object`-typed model slots in `research-contract/risk-execution.ts`
    (`fillModel`/`feeModel`/`slippageModel`/`latency`) to closed discriminated catalogs
    (pattern: backtester `engine/profiles.ts`, e.g. `{kind:'fixed_bps', bps}`). Landed for all
    six slots (`+fundingModel`/`partialFill`), with `unsupported_fill_model_kind` (024) and the
    new `unsupported_reality_model_kind` owning off-catalog kinds instead of `schema_invalid`.

  Two things the SDK deliberately did **not** decide, and which stay with the Phase-1 semantics
  SSOT doc: which reality model applies in paper / backtest / live and with what values (the
  catalogs are vocabulary, not defaults), and when the embedded form stops being accepted — the
  dual-read window closes only after platform, backtester and lab consume the split form.
  Consumers were not migrated: no repo imports `ExecutionProfile` from this package today
  (`backtester` declares its own copy in `packages/research-contracts` — a dedup target).
- Phase 6 of the same card, **early-start exception recorded 2026-07-23**: E1 of platform epic 083
  (`specs/083-event-driven-runtime-spike`) — **delivered in 0.13.0**
  ([#27](https://github.com/trdlabs/sdk/pull/27), hardened in [#28](https://github.com/trdlabs/sdk/pull/28)). The additive `event_driven` kernel contract:
  `lifecycle` on `ModuleManifest` (default `single_position`), the
  `StrategyActor`/`ActorInputEvent`/`ActorCommand`/`ActorContext` vocabulary, the form validator
  (`lifecycle_form_invalid`), the `defineActor` sugar, and JSON schemas for the isolate envelope
  (the validated unit is the command **batch**, with `place`/`timer.set` split into closed
  variants so an ambiguous command fails at the schema). `CONTRACT_VERSION` `017.2` → `017.3`;
  prior versions still validate, but may not declare the surface `017.3` introduced —
  otherwise the bump would not have guarded anything.

  E2–E7 stay behind the epic's return trigger and behind Ф3 — nothing in this SDK release executes
  an actor. What E1 buys now is that `lab` can build event-driven authoring against a vocabulary
  that will not move under it.

Full analysis: control-center
[`docs/analysis/10-shared-execution-kernel.md`](../../control-center/docs/analysis/10-shared-execution-kernel.md).
