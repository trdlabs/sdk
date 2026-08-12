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

## [0.16.0] - 2026-08-12

### Д3 3.3б — доступный интервал бэктеста и типизированный допуск окна

Аддитивно: существующие вызовы не меняются, новые поверхности добавляются рядом.

**`availability()` возвращает union четырёх состояний**, а не «интервал или `null`». `ready` —
границы названы; `empty` — индекс есть и корректен, но закрытых дней ещё нет; `not_initialized` —
индекса нет вовсе; `invalid` — индексу нельзя верить. Потребитель, схлопнувший их в «данных нет»,
не отличит пустой архив от ненастроенного сервиса, а тот — от испорченного индекса. Незнакомое
состояние даёт `invalid` с причиной, а не `not_initialized`: «сервер сказал что-то, чего я не
понимаю» и «индекса нет» — разные факты.

**`preflight(fromMs, toMs)` возвращает различимый результат**, а не одно исключение на все отказы.
Пять кодов (`AVAILABILITY_NOT_INITIALIZED`, `AVAILABILITY_INVALID`, `AVAILABILITY_EMPTY`,
`WINDOW_MALFORMED`, `WINDOW_OUTSIDE_AVAILABLE`), и по каждому своё действие: доделать выкатку,
чинить индекс, ждать первого закрытого дня, исправить запрос, исправить период.

Успешный допуск несёт и запрошенное окно, и фактическое, и флаг `clamped` — тихо суженный период
означал бы, что в evidence прогона записано одно, а протестировано другое. Плюс идентичность
решения: `archiveId`, `datasetId`, `availabilityId` (`sha256` байтов индекса) и `asOfMs`.

**Классификация только по точной тройке** «статус + код + форма тела». Знакомый код с чужим
статусом или в повреждённом теле результатом допуска не считается: так отвечает прокси или
страница ошибки, а не сервис, и принимать это за законный отказ значит отключить повтор там, где
он нужен. Отказ допуска не ретраится — но это **локальное свойство одного вызова**, а не приговор
состоянию: `not_initialized` кончится выкаткой, `invalid` — починкой индекса, и следующий вызов
законен.

`runAvailabilityConformance` в `@trdlabs/sdk/conformance` сверяет цель с таблицей ожиданий,
выписанной руками: обе стороны, real и mock, сходятся с ней порознь.

## [0.15.0] - 2026-08-11

### 083 S3 — `unsupported_lifecycle`, and the empty JSON Pointer made normative

`CONTRACT_VERSION` stays `017.4`. Nothing about what a manifest may *declare* changes here; what
changes is what a **validator may emit**. Manifests, the manifest schema, and every runtime that
validates them are untouched.

### Added

- `validation`: **`unsupported_lifecycle`** (error) — the host cannot execute the *declared* shape of
  a strategy. Deliberately distinct from `lifecycle_form_invalid`, and the difference is *whose
  problem it is*: `lifecycle_form_invalid` means the manifest contradicts itself (declared shape vs
  the hook set) and the author must fix it; `unsupported_lifecycle` means the manifest is flawless
  and the environment does not match — rollout is not permitted here, the host's execution mode is
  incompatible with the declared shape, or the executor lacks the capability. Those are fixed by
  different people, so a consumer switching on the code must be able to tell them apart.

  Deliberately **not** `invalid_module_ref`: the ref resolves fine, and reporting it would send an
  author to fix something that is not broken.

### Changed

- `research-contract`: `ValidationIssue.path` — the empty JSON Pointer `''` is now stated as
  **normative** for "the document as a whole" (RFC 6901 §5) rather than an aside in a one-line
  comment. It is the correct pointer for a cause with **no offending node**: `unsupported_lifecycle`
  arises from a valid request meeting an environment that cannot run it, and pointing at a valid node
  would be a lie with a plausible shape.

  `path` stays **required**. Allowing it to be omitted would create a second way to say "no node",
  and consumers would have to distinguish `undefined` from `''` — which mean the same thing.

  Doc-only for the type; the generated `validation-result` schema picks up the wording, and its
  `path` remains an unconstrained required string, so `''` was already accepted and still is.

### Migration

Additive to a closed taxonomy, and that is not free for everyone: a consumer that switches
**exhaustively** over `ValidationCode`, or builds a `Record<ValidationCode, …>`, gets a compile error
until it adds the new arm. That is the intended failure — it is how the consumer learns a new
rejection reason exists. Consumers that read `code` as a plain string are unaffected.

### Tests

- `test/validation-taxonomy.test.ts` — the runtime taxonomy and the schema enum must agree, in both
  directions. Each pair among the three homes of a code is already coupled by its own mechanism (the
  `Record<ValidationCode, Severity>` type; `gen-research-schemas --check` inside `npm run build`), but
  both are implementations and both are weakenable by a single edit. This test asserts the
  *property*, which survives a change of implementation.

## [0.14.0] - 2026-08-07

### 083 S1 — `event_driven` actor contract rewritten (SDK only; runtimes untouched)

Rewrites the `event_driven` kernel contract E1 that shipped in `0.13.0` under `CONTRACT_VERSION
017.3`. The epic's return trigger was lifted for Ф6 on 2026-08-06, so S1 is the first stage of a
now-unblocked decomposition rather than an early start: scope stays SDK-only per the S1 plan —
types, constants and the manifest validator — and no runtime in any repo is touched (the isolate
dispatch boundary, the engine and RiskEngine are S2/S3, the host-watchdog is S5).
`CONTRACT_VERSION` moves `017.3` → `017.4`; `017.1`–`017.3`
manifests keep validating for the default `single_position` shape (including one that names it
explicitly, `lifecycle: 'single_position'` — that declaration is untouched by S1 and still only
needs `017.3`, the version that introduced the `lifecycle` field itself). What actually requires
`017.4` is `lifecycle: 'event_driven'` specifically, or `onEvent`/`marketData`/`warmup` — see the
note under Changed for why `017.3`, which originally introduced that surface, no longer covers it.

> **This release removes six exports that shipped in `@trdlabs/sdk@0.13.0`.** `OpenOrderStatus`,
> `OpenOrderView`, `PositionView`, `FlatMarketSlice`, `ActorBarEvent` and `ActorTimerEvent` are gone.
> Three of the six
> names come back under `Added` below with **incompatible shapes** — a consumer importing
> `OpenOrderStatus`/`OpenOrderView`/`PositionView` by name still compiles, but a value or literal
> built against the `0.13.0` shape does not satisfy the new one (see Removed/Added for the exact
> field-level diff). Every actor-surface timestamp moves from plain `number` milliseconds to the
> branded µs types `TimestampUs`/`DurationUs`, and the timer command field
> `afterMs` is renamed `afterUs` to carry the new unit in its name — a silent, non-compile-time-
> visible unit change for any consumer that read these fields as raw milliseconds. **No actor input
> event carries a time coordinate of its own any more.** The five market events lost the legacy value
> shapes entirely: `Bar`/`OiPoint`/`LiqPoint`/`TakerPoint`/
> `FundingPoint` each had their own millisecond `ts`, which sat next to the envelope's branded
> `effectiveTsUs` as a second, unrelated coordinate for the same instant; the actor surface now uses
> its own `ts`-free value types (`CandleValue`/`OpenInterestValue`/`LiquidationsValue`/
> `TakerVolumeValue`/`FundingValue`) with `ObservedValue.effectiveTsUs` as the single time
> coordinate. The nine execution-side events (`order.accepted`/`denied`/`rejected`/`canceled`,
> `cancel.rejected`, `order.expired`, `fill`, the timer event and `trading_state.changed`) lost their
> `ts: TimestampUs` field for the same reason: an event happens in the frontier it is delivered in,
> so `ActorEnvelope.eventTsUs` is its only time coordinate. The timer event is the one exception, and
> it is not a second coordinate of the same instant — it is renamed `timer` → `timer.fired` (the name
> the normative spec §3.8.5 uses) and carries `dueTsUs`, the *original deadline*, which differs from
> the firing instant by construction: a timer materializes at the nearest data instant `U` where
> `U > T && U >= dueTs`, and the author reads the lateness as `envelope.eventTsUs - event.dueTsUs`.
> The legacy value types themselves are untouched and keep serving the `single_position` form.
> The legacy
> `MarketDataKind` (`'openInterest'|'liquidations'|'funding'|'taker'`, the `dataNeeds`-flag catalog)
> is renamed `LegacyMarketDataKind`; the bare name `MarketDataKind` now refers to the closed
> `MarketDataRequirement` catalog (five snake_case kinds, unrelated to the renamed one). And, as
> with `0.13.0`, this release adds sixteen new `ValidationCode` members — anything holding an
> exhaustive `Record<ValidationCode, Severity>` needs the same coordinated update `backtester`
> needed last time (see the note at the top of the `0.13.0` entry below for why this is
> source/build-breaking despite being wire-additive).
>
> An import sweep across all eight ecosystem repos (backtester, control-center, engine, lab,
> mock-platform, office, platform, sdk) found **no external import of any removed export** — not of
> the six removed names, not of the renamed `afterMs` field, not of the `timer` event kind. The
> machine-readable per-symbol, per-repo output is attached to the PR.
>
> **One renamed name is not clean, and the earlier claim that it was is withdrawn.** `backtester`
> *does* consume `MarketDataKind` from this package: `packages/research-contracts/src/research/
> market-tape.ts` re-exports it verbatim from `@trdlabs/sdk/research-contract` (dependency
> `^0.13.0`), and `apps/backtester/src/engine/market-tape.ts:98` builds
> `readonly MarketDataKind[] = ['openInterest', 'liquidations', 'funding', 'taker']` on it. After
> this release that name denotes the five snake_case `MarketDataRequirement` kinds, so `backtester`
> **fails to build** until it switches to `LegacyMarketDataKind` (or its own local copy). The task-3
> sweep missed it by stopping one hop out — the import there reads as coming from another package,
> which happens to be a thin re-export of this one. The break is loud (a type error), not silent.
> Anything importing these names from outside the tracked repos should treat this as breaking too.

### Removed

- `research-contract`: `OpenOrderStatus` (`'submitted' | 'accepted' | 'triggered' |
  'partially_filled'`), `OpenOrderView` (`{ clientOrderId, side, type: OrderType, status, qtyUsd,
  filledQtyUsd, price?, stopPrice?, reduceOnly?, createdTs: number }`), `PositionView` (`{ side,
  qty, avgPrice, unrealizedPnl? }`) and `FlatMarketSlice` (`{ oi?, liq?, funding?, taker? }`) — the
  exact shapes released in `0.13.0`. `ActorBarEvent` (`{ kind: 'bar', ts: number, bar, closedCandles?,
  market?: FlatMarketSlice }`) is gone with them: a composite `market.bar.closed` cannot have a
  single `subscriptionId`/`datasetId` when its sources (OI, liquidations, taker, funding) arrive at
  different times with different value semantics (point observation vs. interval aggregate) — see
  the doc block atop `ActorInputEvent` in `event-driven.ts`.
- `research-contract`: `ActorTimerEvent` (`{ kind: 'timer', ts, timerId }`) and with it the event
  kind name `'timer'`. Replaced by `ActorTimerFiredEvent` (`{ kind: 'timer.fired', timerId,
  dueTsUs }`) under Added — the normative spec §3.8.5 names the event `timer.fired` (`timer` appears
  only in §3.1, an inconsistency of the spec itself, resolved in favour of the normative section)
  and requires the firing envelope to carry `eventTsUs = U` with the original deadline stored
  separately as `dueTsUs`. The `defineActor` handler is renamed with it, `onTimer` → `onTimerFired`
  — see the handler-naming entry under Changed for why the naming rule is kept total.

### Added (083 S1, tasks 1–6)

- `research-contract`: `TimestampUs`/`DurationUs` branded µs types (`time-us.ts`) — the actor
  surface's only internal time unit from here on, replacing `number` milliseconds on the envelope,
  the timer command fields, `OpenOrderView.createdTs`, the execution-ledger entries and the timer
  event's `dueTsUs`. Event payloads went further and dropped their time field altogether (see
  `ActorTimerFiredEvent` and the `*Value` types below).
- `research-contract`: `ActorTimerFiredEvent` (`{ kind: 'timer.fired', timerId, dueTsUs }`) —
  replaces the removed `ActorTimerEvent`/`'timer'`. `dueTsUs` is the original deadline, deliberately
  distinct from the firing instant carried by `ActorEnvelope.eventTsUs`: per §3.8.5 a timer set in
  frontier `T` materializes in the first frontier `U` where `U > T && U >= dueTs` — i.e. at the
  nearest *data* instant, never at a synthetic intra-bar tick — so lateness is observable as
  `envelope.eventTsUs - event.dueTsUs`. The actor's clock is strictly data-driven: **wall-clock as a
  source of advance is rejected** (§3.10, the D2 option from the 083 spike). Under sparse data it
  would fire a live timer somewhere a backtest never would, which is exactly the live/backtest
  divergence class Л4 has to prove absent; and with a dead feed the right action is to stop, not to
  execute a timed exit blind. Feed stalls are compensated by the host-watchdog and `TradingState`,
  outside the deterministic loop, not by advancing the clock inside it.
- `research-contract`: five separate market events replacing `ActorBarEvent` —
  `MarketCandleClosedEvent`, `MarketOpenInterestObservedEvent`,
  `MarketLiquidationsBucketClosedEvent`, `MarketTakerVolumeBucketClosedEvent`,
  `MarketFundingObservedEvent` — plus `MarketSubscriptionStatusChangedEvent` (one generic gap
  signal, task 4) and, closing this task, `ActorOrderCancelRejectedEvent` (`'cancel.rejected'`): the
  missing v1 outcome for "a `cancel` arrived after the order already reached a terminal state"
  (Nautilus `on_order_cancel_rejected` analogue) — without it an author's exit-policy FSM waiting on
  `order.canceled` after issuing `cancel` never gets a terminal signal. `ActorInputEvent` is now
  fifteen kinds (the fifteenth is `ActorTradingStateChangedEvent`, below);
  `ACTOR_INPUT_EVENT_KINDS` is kept in sync with it by a two-directional type
  guarantee (`as const satisfies readonly ActorInputEvent['kind'][]` plus
  `AssertNoUncoveredKind<Exclude<...>>`), not a hand-maintained list.
- `research-contract`: the market events' own value types — `CandleValue`, `OpenInterestValue`,
  `LiquidationsValue`, `TakerVolumeValue`, `FundingValue`. Each is the corresponding legacy shape
  minus its millisecond `ts`: the envelope's `ObservedValue.effectiveTsUs` is the event's **only**
  time coordinate, so an event can no longer carry two coordinates of the same instant in two
  different units. They also carry **present content only** — `TakerReading`/`FundingReading`
  (`present | stale | missing`) are no longer event payloads, because `market.taker_volume.
  bucket_closed` with `value: {state:'missing'}` was a schema-valid way to say "observed, finally,
  that there was no observation". Absence of an observation has exactly one channel on the actor
  surface, `market.subscription.status_changed` (`'gap'`), and "the kind is not in this run at all"
  has exactly one channel, `ActorInit.subscriptions`. The readings stay in `market-tape.ts` where
  the pull-shaped `PointInTimeMarketApi` (`single_position`) still needs them.
- `research-contract`: `TradingState` (`'normal' | 'reducing' | 'halted'`) with its closed catalog
  `TRADING_STATES`, the transition event `ActorTradingStateChangedEvent`
  (`'trading_state.changed'`, carrying both `previous` and `state`) and `ActorContext.tradingState`.
  Spec §3.10 requires the actor to *observe* the host-watchdog's transition into `reducing` /
  `halted`; without a named state an author could only infer it by parsing the free text of
  `order.denied.reason`. The watchdog itself — staleness thresholds, driving the state into the
  RiskEngine — remains an **S5** (`platform`) obligation; this release ships the vocabulary only.
- `research-contract`: `MarketDataRequirement` — the closed five-kind catalog
  (`candles`/`open_interest`/`liquidations`/`taker_volume`/`funding`, `MARKET_DATA_KINDS` in
  `contract/constants.ts`) a strategy declares instead of legacy `dataNeeds` flags;
  `ModuleManifest.marketData` (required, non-empty array, for `lifecycle: 'event_driven'`) and
  `ModuleManifest.warmup` (declared warm-up source, `'tape_replay' | 'kernel_prefetch'`).
- `research-contract`: `ObservationStatus<T>` (`observation-status.ts`) — three states of a market
  observation (`never_observed` / `observed` / `gap`, not two), `finality`/`revision` modelled as
  orthogonal axes (not a `provisional`/`final`/`revised` tri-state), plus `parseArchiveRow` and
  `checkRevisionTransition` — fail-closed gates for the archive-row and revision-stream invariants.
- `research-contract`: the authored state slot — `ActorStateValue` (closed recursive plain-data
  union), `isPlainActorState` (runtime gate: rejects functions/closures under any key, cycles,
  non-plain objects, `NaN`/`Infinity`/`-0`, sparse arrays, accessor properties, and nesting past
  `MAX_ACTOR_STATE_DEPTH`), `StrategyActor<S>` / `ActorInit<S>` / `EventDrivenModule<S>` /
  `ActorHandlers<S>` parameterized by the state type, and the `snapshotState`/`ActorInit.state`
  checkpoint pair. `defineActor` now emits `snapshotState` on the returned actor exactly when the
  author declares one (it could not produce it at all before this task).
- `research-contract`: `OpenOrderView`/`PositionView` **redesigned from scratch** — not a
  restoration of the removed `0.13.0` shapes. `OpenOrderView` is now a discriminated union by order
  type (`OpenMarketOrderView | OpenLimitOrderView | OpenStopMarketOrderView`), with
  `status: 'submitted' | 'accepted'` orthogonal to `filledQty` (a base-currency `qty`/`filledQty`
  pair, not the old `filledQtyUsd`, which could not express "how much of this order is left").
  `PositionView` is brand-sealed — only producible via `derivePositionView` (`actor-state.ts`) — and
  carries a derived `openedAt` (absent from the `0.13.0` shape); `unrealizedPnl` is deliberately
  omitted (see doc `PositionView`, `event-driven.ts`, for why keeping it live would have meant
  reintroducing per-bar position updates).
- `contract`: `MARKET_KIND_RANK` (`contract/constants.ts`) — the normative rank of each market-
  observation kind inside the dispatch merge key (`(businessTsUs, phasePriority, marketKindRank,
  stableSubscriptionId, sourceSequence)`): `open_interest`=1, `liquidations`=2, `taker_volume`=3,
  `funding`=4, `candles`=5 (the candle close is the canonical decision point — by the time it fires,
  the actor has already seen this frontier's OI/liquidations/taker/funding, which is what the old
  atomic minute snapshot gave for free). The single source of this order for `@trdlabs/engine` and
  `backtester` to import instead of each maintaining its own copy; the scheduler that reads it is
  S2, not this package.
- `research-contract`: `ActorRng` — the actor's only randomness capability, now a named type (was
  an anonymous `{ next(): number }` on `ActorContext.rng`) documenting that its home is the engine
  checkpoint (`engineState.rng`), seeded from `ActorInit.seed`, never the authored state slot —
  a closure-based RNG hidden inside authored state cannot survive `isPlainActorState` at the
  checkpoint boundary, so the "no ambient randomness" requirement is enforced structurally, not by
  convention.
- `research-contract`: `ActorDispatchBudget` / `ActorCumulativeFrontierBudget` / `ActorBudgets`
  (`ActorInit.budgets`, optional) — per-dispatch CPU-time/wall-time/command-count limits, plus a
  cumulative `maxCascadeDepth`/`maxEventsPerFrontier` budget for one frontier (`businessTsUs`).
  Deliberately **no per-session budget**: an actor's "session" is unbounded by construction
  (`init` → `dispose`, checkpointed and restored indefinitely), and `wallTimeMsPerSession` on a
  long-lived actor is exactly the mechanism that produced a real production timeout (`backtester`
  sandbox diagnosis, F6) — a limit designed for a one-shot script degrades into a guaranteed failure
  on an actor with no natural end. The cumulative frontier budget closes a companion hole: because a
  domain/risk rejection is delivered as a cascade **within the same frontier** (§3.8.4), an actor
  can retry the same rejected command indefinitely without ever breaching a per-dispatch limit.
- `research-contract`: `ActorCommandBatch` now documents the fail-closed contract for command
  rejection verbatim — a domain/risk rejection commits the already-applied batch prefix, gives the
  rejected command no partial effect, and skips the remaining suffix (no rollback: a live order
  already sent cannot be un-sent); a `dispatch` throw, a batch that fails schema validation, or a
  budget breach is `halt+finalize` instead. The two classes were previously undocumented.
- `validation`: sixteen new `ValidationCode` members shipped across tasks 3–4 —
  `missing_market_data_requirement`, `unsupported_market_data_scope`, `unsupported_revision_policy`,
  `unsupported_funding_form`, `dataset_boundary_violation`, `invalid_market_data_requirement`,
  `duplicate_market_data_requirement_id` (task 3, `MarketDataRequirement` validation);
  `observation_revision_conflict`, `observation_revision_finalized`, `observation_revision_skipped`,
  `observation_revision_regressed`, `observation_revision_invalid`,
  `observation_revision_key_mismatch`, `observation_revision_start_invalid`,
  `observation_finality_demoted`, `observation_archive_row_corrupt` (task 4, observation revision
  stream). **Source-breaking for consumers holding an exhaustive `Record<ValidationCode,
  Severity>`** — see the warning block at the top of this entry and the equivalent note on `0.13.0`
  below.

### Changed

- `research-contract` / `contract`: `CONTRACT_VERSION` `017.3` → `017.4`; `SUPPORTED_CONTRACT_
  VERSIONS` appends `017.4` (both the published root copy in `contract/constants.ts` and the active
  copy in `research-contract/catalogs.ts` that `platformContractContext()` actually validates
  against — kept in lockstep). **Two distinct thresholds, not one** (a first draft of this release
  collapsed them into one and was caught by review before landing — see below): the `lifecycle`
  field's mere presence (any value, including an explicit `lifecycle: 'single_position'`, the same
  form as the default per SC-008) is the original E1 vocabulary from `0.13.0` and still only needs
  `017.3`; **`lifecycle: 'event_driven'` specifically, or `onEvent`/`marketData`/`warmup`, now
  require `017.4`** — a manifest declaring any of those under `017.3` is REJECTED
  (`unsupported_contract_version`), even though `017.3` is the version that originally introduced
  the `event_driven` surface in `0.13.0`. This is not a formality: tasks 1–5 rewrote that surface
  in its entirety (µs types replacing ms, `OpenOrderView`/`PositionView` redesigned, the authored
  state slot and its generic added, `ActorBarEvent` removed) rather than extending it additively —
  `017.3` no longer describes a shape this package can produce, so a manifest declaring the
  rewritten surface under `017.3` is declaring a contract this package does not honor. `warmup` is
  folded into the `017.4` gate for the first time in this release (it existed as a field since task
  3 but was not yet version-gated — the same class of gap the `marketData` version gate closed
  earlier in S1). New exported constant: `LIFECYCLE_FIELD_MIN_CONTRACT_VERSION` (`017.3`), alongside
  the existing `EVENT_DRIVEN_MIN_CONTRACT_VERSION` (now `017.4`) — `research-contract/event-driven.ts`.
- `research-contract`: `ActorTimerSetAfterCommand.afterMs: number` → `afterUs: DurationUs`; every
  remaining `atTs` / `createdTs` / ledger `ts` on the actor surface moves from `number` (implicitly
  milliseconds) to
  `TimestampUs` / `DurationUs` (µs, the sole internal unit `§3.2` of the actor spec requires) so
  that a forgotten `* 1000` stops being executable code. `ActorTimerSetAfterCommand.afterUs` is now
  documented as an offset from the *envelope's* `eventTsUs`, since events no longer have a `ts` to
  offset from.
- `research-contract`: **the `defineActor` handler-name rule is now total, and two handlers were
  renamed to make it so** — `onTimer` → `onTimerFired` (`timer.fired`) and `onOrderCancelRejected` →
  `onCancelRejected` (`cancel.rejected`). The rule is
  `'on' + kind.split(/[._]/).map(capitalize).join('')` for every kind, with no exceptions:
  `order.accepted` → `onOrderAccepted`, `market.taker_volume.bucket_closed` →
  `onMarketTakerVolumeBucketClosed`, `fill` → `onFill`. Totality is a safety property, not a style
  preference: every handler is optional and an undeclared one is a legal way to say "ignore this
  kind", so a misremembered name produces **silence** — the event falls through to the catch-all
  `onEvent`, or to an empty batch — and neither the type checker, the validator nor the schema can
  catch it. `onTimer` was released in `0.13.0` and this rename does break it; `onOrderCancelRejected`
  never shipped (`cancel.rejected` is new in this release), so that one costs consumers nothing. A
  test now derives the expected name from each member of `ACTOR_INPUT_EVENT_KINDS` and asserts the
  dispatcher calls it, so the rule is enforced rather than remembered.
- `research-contract`: **every actor input event lost its own time field.** The five market events'
  payloads went first, to `ts`-free value types (see Added) — until they did, "no millisecond field
  is left on the actor surface" was not yet true. The nine execution-side events
  (`order.accepted`/`denied`/`rejected`/`canceled`, `cancel.rejected`, `order.expired`, `fill`, the
  timer event, `trading_state.changed`) followed for the same reason, one review round later: their
  `ts` was already a branded µs field, so this is not a unit change but a *count* change — an event
  happens in the frontier it is delivered in, so two coordinates of one instant on one object either
  duplicate each other or disagree, and `ActorEnvelope.eventTsUs` is the one that survives. The only
  time field left on any event payload is `ActorTimerFiredEvent.dueTsUs`, which is a different
  instant by construction, not a copy of `eventTsUs`.
- `validation`: the bundled JSON Schemas now enforce the numeric constraints the contract documents
  and previously only stated in prose. `TimestampUs` is `{"type":"integer","minimum":0}` (was
  `{"type":"number"}`), `DurationUs` is `integer` (sign still allowed — it is a difference of two
  instants), `ObservedValue.revision` is a non-negative integer, `qty`/`qtyUsd` carry
  `exclusiveMinimum: 0`, and the non-negative market quantities (`volume`, `oiTotalUsd`,
  `longUsd`/`shortUsd`, `buyUsd`/`sellUsd`) carry `minimum: 0`. Until this release, `timer.set` with
  `atTs: 1.5` or `atTs: -1000`, an event with a fractional or negative µs instant, a `fill` with
  `qty: -5`, and `revision: -1.5` were all
  **valid** against the shipped schemas — the schema is the only gate on the isolate boundary, where
  the `timestampUs()`/`durationUs()` runtime constructors never run. A side effect on the manifest
  path: a fractional `MarketDataRequirement.interval` is now rejected as `schema_invalid` (before, it
  passed both the schema and the semantic validator, which only checked `interval <= 0`).
  `price`/`stopPrice`/`fee`/`fundingRate` are deliberately left unconstrained beyond finiteness —
  the contract promises nothing more about them, and negative values are legitimate for the last two.
- `contract`: the legacy `MarketDataKind` (`'openInterest' | 'liquidations' | 'funding' | 'taker'`,
  the `dataNeeds`-flag catalog that still governs `017.1`–`017.3` manifests) is renamed
  `LegacyMarketDataKind` (`contract/market-data-kinds.ts`); the bare name `MarketDataKind` now names
  the new `MARKET_DATA_KINDS` catalog (`contract/constants.ts`) — the two catalogs are unrelated in
  shape (`camelCase` four kinds vs. `snake_case` five kinds) and had been sharing one name before
  this rename.

### Migration

No consumer imports the six removed exports from `@trdlabs/sdk` today — verified by an import sweep
across all eight ecosystem repos (per-symbol output attached to the PR). **`MarketDataKind` is the
exception**, and it needs a fix in `backtester` in exactly two places:
`packages/research-contracts/src/research/market-tape.ts` (the verbatim
`export type { …, MarketDataKind, … } from '@trdlabs/sdk/research-contract'` — re-export
`LegacyMarketDataKind` instead, or stop re-exporting the name) and
`apps/backtester/src/engine/market-tape.ts:98` (the use site,
`const COVERAGE_KIND_ORDER: readonly MarketDataKind[] = ['openInterest', 'liquidations', 'funding',
'taker']` — retype it to `LegacyMarketDataKind`). This release ships first and that consumer is
fixed in a follow-up PR, deliberately: the break is a type error at build time, not a silent
behaviour change. Authoring
(or generating) an `event_driven` module against the `0.13.0` shapes does need to move: bump
`contractVersion` to `017.4`; construct every actor-surface timestamp with `timestampUs()`/
`durationUs()` instead of a raw millisecond number; rename `afterMs` to `afterUs`; drop the `ts`
field from **every** event — market payloads read their instant from `ObservedValue.effectiveTsUs`,
execution events read theirs from `ActorEnvelope.eventTsUs` (and stop expecting
`{state:'missing'|'stale'}` inside a market event — subscribe to
`market.subscription.status_changed` for that); rename the `timer` event to `timer.fired` and read
`dueTsUs` (the deadline) rather than a firing timestamp; rename the handlers `onTimer` →
`onTimerFired` and `onOrderCancelRejected` → `onCancelRejected` (**a missed handler rename is
silent** — the event falls through to `onEvent` or to nothing; see the handler-naming entry under
Changed); and read
`OpenOrderView`/`PositionView` against their redesigned shape (see Added above), not the `0.13.0`
one — there is no compatibility shim between the two. Nothing here executes yet: this release
changes no runtime in any repo — the dispatcher, budgets and warm-up are S2 (`@trdlabs/engine`),
the host-watchdog driving `TradingState` is S5 (`platform`).

## [0.13.0] - 2026-07-23

Two contract changes ship together. **0.12.0 was prepared but never published** — npm went
`0.11.0 → 0.13.0` — so its changes are part of this release, listed under «Ф1 …» below rather
than in a section of their own.

> **Read this before treating anything below as purely additive.** Two kinds of change in this
> release are additive *on the wire* — no payload that validated before stops validating — yet
> **source- or build-breaking for consumers that enumerate the contract**:
>
> - **A new `ValidationCode` member.** Anything holding an exhaustive
>   `Record<ValidationCode, Severity>` over the re-sourced union stops compiling until it adds the
>   new codes. `backtester` does exactly this and did stop compiling.
> - **A new bundled schema.** Anything that copies the schema *files* while iterating the kernel's
>   `SCHEMA_IDS` asks for a file it never copied and dies at registry-construction time.
>   `backtester`'s `copy-schemas.mjs` held a hardcoded list of five and produced 34 failures.
>
> Neither is visible from the wire format, which is why "additive" alone is the wrong summary. A
> consumer that only *reads* codes and schemas is unaffected; a consumer that *enumerates* them
> needs a coordinated change. Additionally, `CONTRACT_VERSION` is not a free-floating string —
> see the note under Changed (083 E1).

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
  gains no arm for them. **Build-breaking for schema-copying consumers** — see the note at the top
  of this release.
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

  **`CONTRACT_VERSION` is a cross-repo anchor, not a label.** Two consequences were understated
  when this shipped, both found while rolling 0.13.0 out. Downstream, `backtester` writes the
  constant into `RunEvidence`, which feeds the run content hash — so the bump changes **every**
  `result_hash` and invalidates its committed byte-identity goldens. Upstream, the platform owns
  the gates that police the constant (as `src/contract/constants.ts` already claimed): a bump has
  to be ratified there, and every new `ValidationCode` needs a taxonomy check. Bumping it is a
  sequenced cross-repo change — platform first, then this package, then consumers — not a
  one-line edit here.
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
  resolving to something (constitution XIV — no silent fallback): a model passed with **no** run
  binding → `unbound_reality_model`; a bound `realityModelRef` with no resolved model →
  `unresolved_reality_model_ref`; a resolved model whose `id@version` differs from the ref →
  `reality_model_ref_mismatch`; both forms present and disagreeing → `conflicting_reality_model`;
  neither present → `missing_reality_model`. The first and third close substitution from both
  directions — you can neither swap the bound model for another nor supply one the run never
  bound — which is the whole point of versioning the model. The input type is a union, so
  «model without ref» does not type-check either; the runtime outcome covers JS callers and data
  arriving untyped from a boundary. The embedded form resolves without a `ref`: an `ExecutionProfile`'s
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
  `schema_invalid`. **Adding a code is source-breaking for consumers holding an exhaustive
  severity map** — see the note at the top of this release.
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
`ExecutionProfile` may carry the model slots inline as before. To adopt the split form, register
the environment as a `RealityModel` and point at it with `BacktestRunRequest.realityModelRef` —
the run request is the **only** place the model binds, so a resolved model always travels with
the ref that bound it. The embedded form stops being accepted only after platform, backtester and
lab consume the split form — one minor plus one major cycle away, announced separately.

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

[Unreleased]: https://github.com/trdlabs/sdk/compare/sdk-v0.14.0...HEAD
[0.14.0]: https://www.npmjs.com/package/@trdlabs/sdk/v/0.14.0
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
