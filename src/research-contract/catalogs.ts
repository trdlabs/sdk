// 017 — курируемые платформой каталоги и версия контракта (research D12/D13, data-model §13.1/§15).
// Замкнутые наборы именованных built-in значений; расширяются только платформой.

/** Стартовая версия контракта 017 (research D12). Единая экспортируемая константа.
 *  030: bump `'017.1' → '017.2'` (явное контрактное изменение — funding/taker как research-facing
 *  point-in-time capability). Прежние `017.1`-манифесты остаются валидны через `SUPPORTED_CONTRACT_VERSIONS`.
 *  083 E1: bump `'017.2' → '017.3'` — конверт манифеста получил поле `lifecycle` и хук `onEvent`.
 *  Манифесты `017.1`/`017.2` остаются валидны (их форма — дефолтный `single_position`). */
export const CONTRACT_VERSION = '017.3';

/** Замкнутый каталог метрик (data-model §15). Неизвестное имя в запросе → `unknown_metric`. */
export const METRIC_CATALOG = ['pnl', 'sharpe', 'max_drawdown', 'win_rate', 'total_trades', 'profit_factor', 'top_trade_contribution_pct'] as const;

/** Замкнутый каталог robustness-проверок (data-model §15). Неизвестное имя → `unknown_metric`. */
export const ROBUSTNESS_CATALOG = ['walk_forward', 'oos_split'] as const;

/** Закрытый набор запрещённых capabilities (data-model §13.3). Любая объявленная → `forbidden_capability`. */
export const FORBIDDEN_CAPABILITIES = [
  'exchangeDirect',
  'brokerDirect',
  'filesystem',
  'network',
  'process',
  'env',
  'dynamicEval',
] as const;

/** Поддерживаемый набор версий контракта (data-model §13.1, D12).
 *  030: явный список `['017.1','017.2']` (а не `[CONTRACT_VERSION]`) для back-compat — `017.1`-манифесты
 *  валидны наряду с `017.2` (SC-008). 083 E1: +`017.3` (append-в-конце). */
export const SUPPORTED_CONTRACT_VERSIONS = ['017.1', '017.2', '017.3'] as const;

/**
 * 023 — замкнутый каталог поддержанных point-in-time рыночных kind'ов (research R4/R5). Объявленный
 * `dataNeeds`-флаг вне объединения этого каталога со structural/lookahead/nondeterminism-наборами →
 * `unsupported_market_data_kind`. Аналог `METRIC_CATALOG`/`unknown_metric`.
 */
export const SUPPORTED_MARKET_DATA_KINDS = [
  'openInterest',
  'liquidations',
  'funding',
  'taker',
] as const;

/** Форма каталога именованных значений (метрики / robustness). */
export type MetricCatalog = readonly string[];

/**
 * Версия контракта + каталоги + набор известных strategy-id (data-model §13.1).
 * Второй аргумент валидатора; от него зависит детерминизм результата (FR-022, SC-004).
 */
export interface ContractContext {
  readonly supportedContractVersions: readonly string[];
  readonly metricCatalog: MetricCatalog;
  readonly robustnessCatalog: readonly string[];
  readonly knownStrategyRefs: readonly string[];
  readonly forbiddenCapabilities: readonly string[];
  /** 023 — поддержанные рыночные data-kind'ы (для `unsupported_market_data_kind`, research R4/R5). */
  readonly supportedMarketDataKinds: readonly string[];
}

/**
 * Платформенный `ContractContext`: поддерживаемые версии + каталоги + закрытый набор запрещённых
 * capabilities. `knownStrategyRefs` привязывается на уровне вызова (для `unknown_strategy_ref`).
 */
export function platformContractContext(
  knownStrategyRefs: readonly string[] = [],
): ContractContext {
  return {
    supportedContractVersions: SUPPORTED_CONTRACT_VERSIONS,
    metricCatalog: METRIC_CATALOG,
    robustnessCatalog: ROBUSTNESS_CATALOG,
    knownStrategyRefs,
    forbiddenCapabilities: FORBIDDEN_CAPABILITIES,
    supportedMarketDataKinds: SUPPORTED_MARKET_DATA_KINDS,
  };
}
