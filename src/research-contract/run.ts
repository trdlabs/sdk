// 017 — самодостаточный запрос прогона и форма его результата (FR-024/FR-025, data-model §11/§12).
// 017 валидирует структуру запроса; не исполняет прогон (D10).

/** Ссылка на модуль/профиль по id+version. */
export interface Ref {
  readonly id: string;
  readonly version: string;
}

/** Период данных прогона. */
export interface RunPeriod {
  readonly from: string;
  readonly to: string;
}

/**
 * Самодостаточный запрос для будущего runner'а (FR-024). `overlayRefs` — ЯВНО упорядоченный
 * массив (implicit ordering запрещён); метрики — имена из `MetricCatalog`.
 */
export interface BacktestRunRequest {
  readonly runId: string;
  readonly mode: 'research' | 'review' | 'promotion';
  /** baseline-модуль по ссылке+версии (FR-026). */
  readonly moduleRef: Ref;
  /** Явно упорядоченный массив overlays; дубликат ref/version → `duplicate_overlay_ref`. */
  readonly overlayRefs?: readonly Ref[];
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: RunPeriod;
  readonly params?: object;
  /** Обязателен, если конфиг способен открыть позицию (FR-027). */
  readonly riskProfileRef?: Ref;
  readonly executionProfileRef?: Ref;
  readonly parameterGrid?: object;
  /** Детерминизм (FR-028). */
  readonly seed: number;
  /** Имена из `MetricCatalog` (FR-026); неизвестное → `unknown_metric`. */
  readonly metrics: readonly string[];
  readonly robustnessChecks?: readonly string[];
  readonly artifacts?: readonly string[];
}

/**
 * Evidence bundle прогона (FR-025). 017 определяет ФОРМУ; не производит (прогон — будущий runner).
 */
export interface BacktestRunResult {
  readonly runId: string;
  readonly summary: object;
  readonly metrics: Readonly<Record<string, number>>;
  readonly trades: readonly object[];
  readonly decisionRecords: readonly object[];
  readonly validationIssues: readonly object[];
  readonly artifactRefs: readonly string[];
  readonly evidence: object;
}
