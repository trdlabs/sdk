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
- [b2c-sdk-consolidation](../../control-center/docs/delivery/initiatives/b2c-sdk-consolidation.md) — `proposed`.
  Receive `@trading-backtester/sdk` (contracts + client + builder) as a `./backtester`
  subpath with a conformance gate mirroring the intake/ops-read pattern.

Full analysis: control-center
[`docs/analysis/06-b2c-readiness-report.md`](../../control-center/docs/analysis/06-b2c-readiness-report.md)
(SDK contract inventory, tenancy gaps, versioning constraints).
