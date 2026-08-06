// @trdlabs/sdk — market-data shared contract types (standalone, SDK-owned).
//
// Initiative #2 (Stage 1): these two types previously lived in the SHED research barrel
// (contract/research/market-tape.ts). The root surface re-exports them, so they are inlined here as
// the SDK's own source of truth. They mirror the platform research contract.

/**
 * Closed set of point-in-time market data kinds (research 023/027/028).
 *
 * Renamed from `MarketDataKind` → `LegacyMarketDataKind` (083 S1 задача 3, раунд правок 2,
 * С-3/К-2): пакет завёл ВТОРОЙ, семантически другой каталог видов — `MarketDataKind` из
 * `contract/constants.ts` (`MARKET_DATA_KINDS`, пятёрка snake_case для `MarketDataRequirement`).
 * Держать оба под одним именем значило бы закрепить именно ту коллизию, ради устранения которой
 * задача затевалась: потребитель `import type { MarketDataKind } from '@trdlabs/sdk'` получал бы
 * ЭТОТ (camelCase, четыре вида), не имеющий отношения к `MarketDataRequirement['kind']`.
 * Проверено 2026-08-06 прямым grep по всем восьми репозиториям экосистемы (backtester,
 * control-center, engine, lab, mock-platform, office, platform, sdk) — внешних импортов
 * `MarketDataKind` из `@trdlabs/sdk` нет: `lab`/`mock-platform`/`platform` держат СВОИ независимые
 * локальные копии этой формы (не импортируют её из sdk), `backtester` импортирует одноимённый тип
 * из другого пакета (`@trading/research-contracts`). Переименование безопасно.
 */
export type LegacyMarketDataKind = 'openInterest' | 'liquidations' | 'funding' | 'taker';

/** Per-kind coverage state (research market-data coverage taxonomy). */
export type MarketDataCoverageState = 'present' | 'missing' | 'stale' | 'unsupported';
