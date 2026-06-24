// 017 — HypothesisBrief: высокоуровневая идея, не исполняемый артефакт (FR-003, data-model §1).

/**
 * Описательные метаданные гипотезы (вход для автора модуля). Не обязателен для приёма модуля;
 * валидируется только структурно (`schema_invalid` при грубом несоответствии).
 */
export interface HypothesisBrief {
  /** Постановка/проблема. */
  readonly statement: string;
  /** Интуиция/механизм. */
  readonly intuition?: string;
  /** id целевой стратегии или `null` для standalone-гипотезы. */
  readonly targetStrategyRef?: string | null;
  /** Ожидаемый эффект. */
  readonly expectedEffect?: string;
  /** Ограничения. */
  readonly constraints?: readonly string[];
}
