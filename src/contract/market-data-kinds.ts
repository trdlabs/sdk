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
 * **ПОПРАВКА (свип ревью владельца на PR sdk#34): для `backtester` переименование НЕ безопасно.**
 * Прежняя редакция этого блока утверждала «внешних импортов `MarketDataKind` из `@trdlabs/sdk`
 * нет», потому что свип задачи 3 остановился на ПЕРВОМ звене: у `backtester` импорт действительно
 * идёт «из другого пакета» — `@trading/research-contracts`. Но этот пакет — ТОНКИЙ РЕЭКСПОРТ:
 * `packages/research-contracts/src/research/market-tape.ts` содержит
 * `export type { …, MarketDataKind, … } from '@trdlabs/sdk/research-contract'` и зависит от
 * `@trdlabs/sdk: ^0.13.0`. Цепочка целиком: `apps/backtester/src/engine/market-tape.ts` →
 * `@trading/research-contracts/research` → `@trdlabs/sdk/research-contract` → ЭТОТ пакет. Реэкспорт
 * прозрачен, поэтому ссылка внешняя, и «импортирует из другого пакета» её не отменяет.
 *
 * Что именно ломается: `apps/backtester/src/engine/market-tape.ts:98` —
 * `const COVERAGE_KIND_ORDER: readonly MarketDataKind[] = ['openInterest', 'liquidations',
 * 'funding', 'taker']`. Диапазон `^0.13.0` подтянет новую версию, `MarketDataKind` станет пятёркой
 * snake_case, и `'openInterest'`/`'taker'` перестанут быть её членами — ошибка СБОРКИ у
 * потребителя, а не молчаливая подмена (`'liquidations'`/`'funding'` совпадают по написанию, но
 * это совпадение написания, не совместимость смысла). Правка — на стороне `backtester` (перейти на
 * `LegacyMarketDataKind` либо на собственную локальную копию); в этой ветке она вне скоупа, правило
 * ветки запрещает файлы вне `sdk`.
 *
 * Остальные семь репозиториев чисты: `lab`/`mock-platform`/`platform` держат СВОИ независимые
 * локальные копии этой формы и из `sdk` её не импортируют. Построчный свип (символ × дерево ×
 * коммит) приложен к PR.
 */
export type LegacyMarketDataKind = 'openInterest' | 'liquidations' | 'funding' | 'taker';

/** Per-kind coverage state (research market-data coverage taxonomy). */
export type MarketDataCoverageState = 'present' | 'missing' | 'stale' | 'unsupported';
