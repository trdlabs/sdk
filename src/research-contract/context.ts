// 017 — read-only point-in-time контекст хуков (FR-010/FR-011, data-model §8).
//
// 020 (additive): `IndicatorApi` расширен методом `query()` — типы подключаются через
// `import type` из './indicators.js' (стираются при компиляции; форма 017 сохранена).
import type { IndicatorRequest, IndicatorValue } from './indicators.js';
//
// 023 (additive): опциональная point-in-time рыночная поверхность `market?` — тип `PointInTimeMarketApi`
// импортируется type-only из './market-tape.js' (source of truth типов; импорт стирается при компиляции,
// `market-tape.ts` зеркально импортирует `Bar` отсюда type-only → runtime-цикла нет).
import type { PointInTimeMarketApi } from './market-tape.js';
//
// В 017 это ТИПОВОЙ контракт: фиксирует, что доступно хукам и чего нет. Форму обеспечивает
// будущий runner. Структурная гарантия no-lookahead: в PointInTimeDataApi НЕТ forward-поверхности
// (нет аналога getNextCandles), нет oracle/labeling (FR-011, US4-AC3).

/** Закрытая (исторически завершённая) свеча. */
export interface Bar {
  readonly ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Snapshot текущей позиции. */
export interface PositionSnapshot {
  readonly side: 'long' | 'short';
  readonly size: number;
  readonly entryPrice: number;
  readonly stop?: number;
  readonly take?: number;
}

/** Snapshot pending-intent'а (не исполненного намерения). */
export interface IntentSnapshot {
  readonly kind: string;
  readonly side?: 'long' | 'short';
  readonly createdTs: number;
}

/** Snapshot портфеля. */
export interface PortfolioSnapshot {
  readonly equity: number;
  readonly openPositions: number;
}

/**
 * Point-in-time доступ к рыночным данным. ТОЛЬКО назад: закрытые свечи до текущего бара и
 * индикаторы as-of. Отсутствие forward-методов — структурный инвариант no-lookahead (FR-011).
 */
export interface PointInTimeDataApi {
  /** Закрытые свечи строго ДО текущего бара (as-of), не более `lookback`. */
  closedCandles(lookback: number): readonly Readonly<Bar>[];
  /** Значение объявленного индикатора as-of текущего бара. */
  indicatorAsOf(name: string): number | undefined;
}

/** Детерминированные indicator/helper'ы (platform SDK; data-model §15). */
export interface IndicatorApi {
  /**
   * Legacy scalar (017/018 back-compat): `value('sma', period)`. Делегирует движку.
   * Инвариант: `value('sma', N) === data.indicatorAsOf('sma_<N>')` (требует verify_018_lookahead).
   */
  value(name: string, ...args: readonly number[]): number | undefined;

  /**
   * 020 — per-bar query по name+params+source. `undefined` в warmup; бросает
   * `IndicatorValidationError` при невалидном ключе (fail-closed; 020 data-model §6).
   */
  query(request: IndicatorRequest): IndicatorValue | undefined;
}

/** Сведения о прогоне, видимые хуку. */
export interface RunInfo {
  readonly runId: string;
  readonly mode: string;
  readonly seed: number;
}

/**
 * Read-only (deep-frozen) контекст, передаваемый хукам. `clock`/`rng` — детерминированные
 * (симулированные часы + seeded RNG; FR-019), не wall-clock и не неуправляемая случайность.
 */
export interface StrategyContext {
  readonly run: RunInfo;
  readonly params: Readonly<Record<string, unknown>>;
  readonly symbol: string;
  readonly bar: Readonly<Bar>;
  readonly position: Readonly<PositionSnapshot> | null;
  readonly pendingIntent: Readonly<IntentSnapshot> | null;
  readonly portfolio: Readonly<PortfolioSnapshot>;
  readonly clock: { now(): number };
  readonly data: PointInTimeDataApi;
  readonly indicators: IndicatorApi;
  readonly rng: { next(): number };
  /**
   * 023 — point-in-time рыночные снимки (OI/liquidations). Присутствует ТОЛЬКО если `MarketTape`
   * несёт соответствующий kind (composition-following, FR-008/FR-010), НЕ из-за декларации `dataNeeds`.
   * OHLCV-only лента → поле отсутствует → форма контекста и выходы 018 неизменны.
   */
  readonly market?: PointInTimeMarketApi;
}

/** Синоним, подчёркивающий point-in-time-природу контекста (data-model §8). */
export type PointInTimeContext = StrategyContext;
