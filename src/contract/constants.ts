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
 * @deprecated Legacy-каталог (research 023/027/028): camelCase, четыре вида, свечей нет. Это
 * набор ДЛЯ `DataNeedsDeclaration` — булевых flag'ов point-in-time потребностей манифестов
 * `017.1`–`017.3`, а НЕ каталог видов `MarketDataRequirement` (083 S1 задача 3, `event_driven`).
 *
 * Эта КОПИЯ здесь — только реэкспорт наружу (`src/index.ts`); валидацию `unsupported_market_data_kind`
 * фактически ведёт ОТДЕЛЬНАЯ, независимо объявленная копия того же массива в
 * `research-contract/catalogs.ts` (через `platformContractContext().supportedMarketDataKinds` →
 * `validate-module.ts`) — доверять этому файлу как источнику поведения валидатора неверно (раунд
 * правок 1 ошибочно сделал именно это; исправлено). Имя `SUPPORTED_MARKET_DATA_KINDS` сохранено
 * байт-в-байт в ОБЕИХ копиях — удалять нельзя, но оно больше НЕ единственный источник истины о
 * «видах рыночных данных» в этом пакете. Новый каталог — `MARKET_DATA_KINDS` ниже.
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
