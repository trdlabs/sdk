/**
 * CanonicalRow v1 — авторитетная on-disk форма финализированного minute snapshot'а
 * для исторического хранилища (010-historical-market-storage).
 *
 * v1 — заморожен на 16 полях (immutable). 028 ввёл additive `CanonicalRowV2`
 * (schema_version=2, +taker buy/sell/has_taker_flow — см. ниже) через новое
 * под-дерево, без in-place миграции v1 partitions; reader v1∪v2.
 *
 * Forbidden fields см. specs/010-historical-market-storage/contracts/canonical-row.md
 * §Forbidden fields. Никаких per-exchange OI/liquidation, derived ratios, strategy
 * signals, execution events или raw payload'ов. delta выводится из buy/sell (не
 * колонка); cumulative-агрегаты не хранятся.
 */
export const SCHEMA_VERSION = 1;
/**
 * Exhaustive list канонических полей. Используется verify_historical_no_derived_fields.mjs
 * для machine-checkable schema-purity verification (FR-007, SC-007).
 */
export const CANONICAL_ROW_FIELDS = [
    'schema_version',
    'minute_ts',
    'symbol',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'turnover',
    'oi_total_usd',
    'funding_rate',
    'liq_long_usd',
    'liq_short_usd',
    'has_oi',
    'has_funding',
    'has_liquidations',
];
/**
 * CanonicalRow v2 — первый additive bump on-disk схемы (028-raw-taker-flow).
 *
 * v1 (16 полей) остаётся frozen и immutable: writer пишет v2 в отдельное
 * под-дерево `schema_version=2/`, v1-партиции не трогаются (immutability by
 * construction). Reader становится v1∪v2-aware (v1 → taker null/false, без 0).
 *
 * v2 строго additive OPTIONAL: 16 v1-полей + raw taker buy/sell + has_taker_flow.
 * Канон хранит только raw scalars: taker delta выводится из buy и sell при
 * чтении (lossless, не колонка); накопительные taker-агрегаты — downstream,
 * не хранятся. Per-exchange/derived поля по-прежнему запрещены в каноне.
 */
export const SCHEMA_VERSION_V2 = 2;
/**
 * Exhaustive list канонических полей v2 (19). Используется
 * verify_historical_no_derived_fields.mjs для schema-purity verification под v2.
 */
export const CANONICAL_ROW_V2_FIELDS = [
    'schema_version',
    'minute_ts',
    'symbol',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'turnover',
    'oi_total_usd',
    'funding_rate',
    'liq_long_usd',
    'liq_short_usd',
    'has_oi',
    'has_funding',
    'has_liquidations',
    'taker_buy_volume_usd',
    'taker_sell_volume_usd',
    'has_taker_flow',
];
//# sourceMappingURL=canonical-row.js.map