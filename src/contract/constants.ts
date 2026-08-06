// @trdlabs/sdk — contract capability/versioning constants (standalone, SDK-owned).
//
// Initiative #2 (Stage 1): the research vendored snapshot (contract/research/**) is SHED. The root
// surface only needs the capability/versioning constants, so they are inlined here as the SDK's own
// source of truth. These values mirror the platform research contract catalogs; bumping them is
// policed downstream by the platform's contract gates.

/** Research contract version (platform 030 bumped to `017.2`; 083 E1 to `017.3`). */
export const CONTRACT_VERSION = '017.3' as const;

/** Supported research contract versions (back-compat: `017.1`/`017.2` manifests remain valid). */
export const SUPPORTED_CONTRACT_VERSIONS = ['017.1', '017.2', '017.3'] as const;

/**
 * @deprecated Для нового авторства не использовать — см. `MARKET_DATA_KINDS` ниже
 * (`MarketDataRequirement`, форма `event_driven`, 083 S1 задача 3).
 *
 * Эта КОПИЯ — только реэкспорт значения наружу (`src/index.ts`); поведение валидатора она НЕ
 * определяет. Действующий экземпляр, который `platformContractContext().supportedMarketDataKinds`
 * реально передаёт в `validate-module.ts` для проверки `unsupported_market_data_kind` (легаси
 * `DataNeedsDeclaration`-флаги манифестов `017.1`–`017.3`), — отдельно объявленная копия в
 * `research-contract/catalogs.ts::SUPPORTED_MARKET_DATA_KINDS`; тег `@deprecated` там несёт то же
 * значение («не для нового кода», НЕ «сломано» — этот механизм остаётся действующим, пока
 * `017.1`–`017.3` валидны) и разбирает оба смысла подробно. Имя `SUPPORTED_MARKET_DATA_KINDS`
 * сохранено байт-в-байт в ОБЕИХ копиях — удалять нельзя.
 */
export const SUPPORTED_MARKET_DATA_KINDS = [
  'openInterest',
  'liquidations',
  'funding',
  'taker',
] as const;

/**
 * 083 S1 задача 3 — закрытый каталог видов рыночных данных `MarketDataRequirement` (форма
 * `event_driven`; согласован по смыслу с шестью market-событиями задачи 2 —
 * `market.candle.closed`/`market.open_interest.observed`/`market.liquidations.bucket_closed`/
 * `market.taker_volume.bucket_closed`/`market.funding.observed`, минус generic
 * `market.subscription.status_changed`, который не носитель значения и требования не имеет).
 * Решение владельца 2026-08-06: мигрировать с camelCase-четвёрки `SUPPORTED_MARKET_DATA_KINDS` на
 * snake_case-пятёрку спеки (`candles` добавлен, спека новее и прошла ревью). Тип ВЫВОДИТСЯ из
 * массива — добавление вида остаётся ОДНОЙ правкой, а не «не забыть поправить список»
 * (двусторонняя гарантия согласованности с union'ом `MarketDataRequirement['kind']` —
 * `research-contract/event-driven.ts`, та же идиома, что `ACTOR_INPUT_EVENT_KINDS`).
 */
export const MARKET_DATA_KINDS = [
  'candles',
  'open_interest',
  'liquidations',
  'taker_volume',
  'funding',
] as const;

/** Вид `MarketDataRequirement` — см. `MARKET_DATA_KINDS`. */
export type MarketDataKind = (typeof MARKET_DATA_KINDS)[number];
