// 017 Ф1 (инициатива `shared-execution-engine`) — `RealityModel`: объявленные свойства СРЕДЫ
// исполнения, отделённые от `ExecutionProfile` (намерение: тип ордера, TIF, sizing, timeout/cancel).
//
// Зачем разделение. Сегодня один и тот же бандл исполняется двумя семантически несовместимыми
// интерпретаторами (platform paper vs backtester), а слоты модели среды в `ExecutionProfile`
// типизированы как `object` — расхождение невыразимо в контракте и потому недоказуемо. `RealityModel`
// делает среду ЯВНОЙ и версионированной сущностью прогона (как `RiskProfile`/`ExecutionProfile`,
// привязка по `id+version`), а каждый слот — ЗАМКНУТЫМ discriminated-каталогом.
//
// Каталоги здесь фиксируют ФОРМУ и множество допустимых kind'ов, а НЕ семантические дефолты
// (какая модель применяется в paper/backtest/live и с какими значениями — решение Ф1-SSOT-документа
// в control-center, не этого файла). Каталог пополняется значением только когда появляется
// реализующий его интерпретатор — без молчаливого fallback.
//
// Источник форм: backtester `apps/backtester/src/engine/profiles.ts` (единственная сегодня
// реализация с типизированными kind'ами: `next_bar_open`/`same_bar_close`, `fixed_bps`,
// `per_minute_prorate`).

// ─────────────────────────────────────────────────────────────────────────────
// Fill — как заявка превращается в сделку относительно бара решения.
// ─────────────────────────────────────────────────────────────────────────────

/** Исполнение по `open` СЛЕДУЮЩЕГО бара (анти-lookahead: бар решения уже закрыт). */
export interface NextBarOpenFillModel {
  readonly kind: 'next_bar_open';
}

/** Исполнение по `close` бара решения (того же бара, на котором сработал `onBarClose`). */
export interface SameBarCloseFillModel {
  readonly kind: 'same_bar_close';
}

/** Замкнутый каталог fill-моделей. */
export type FillModel = NextBarOpenFillModel | SameBarCloseFillModel;

/** Замкнутый каталог `fillModel.kind`. Иной kind → `unsupported_fill_model_kind` (024, R6). */
export const FILL_MODEL_KINDS = ['next_bar_open', 'same_bar_close'] as const;
export type FillModelKind = (typeof FILL_MODEL_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Fee / slippage — стоимость исполнения.
// ─────────────────────────────────────────────────────────────────────────────

/** Комиссия фиксированными базисными пунктами нотионала. */
export interface FixedBpsFeeModel {
  readonly kind: 'fixed_bps';
  /** Базисные пункты (1 bps = 1/10 000). `0` — валидное объявление «без комиссии». */
  readonly bps: number;
}

/** Замкнутый каталог fee-моделей. */
export type FeeModel = FixedBpsFeeModel;

/** Замкнутый каталог `feeModel.kind`. */
export const FEE_MODEL_KINDS = ['fixed_bps'] as const;
export type FeeModelKind = (typeof FEE_MODEL_KINDS)[number];

/** Проскальзывание фиксированными базисными пунктами (направление — неблагоприятно к стороне). */
export interface FixedBpsSlippageModel {
  readonly kind: 'fixed_bps';
  /** Базисные пункты (1 bps = 1/10 000). `0` — валидное объявление «без проскальзывания». */
  readonly bps: number;
}

/** Замкнутый каталог slippage-моделей. */
export type SlippageModel = FixedBpsSlippageModel;

/** Замкнутый каталог `slippageModel.kind`. */
export const SLIPPAGE_MODEL_KINDS = ['fixed_bps'] as const;
export type SlippageModelKind = (typeof SLIPPAGE_MODEL_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Funding — стоимость удержания перп-позиции.
// ─────────────────────────────────────────────────────────────────────────────

/** Поминутное пропорциональное начисление ставки, выраженной за `intervalHours` (перпы: 8h). */
export interface PerMinuteProrateFundingModel {
  readonly kind: 'per_minute_prorate';
  /** Интервал, за который выражена ставка ленты; поминутный делитель = `intervalHours * 60`. */
  readonly intervalHours: number;
}

/** Замкнутый каталог funding-моделей. */
export type FundingModel = PerMinuteProrateFundingModel;

/** Замкнутый каталог `fundingModel.kind`. */
export const FUNDING_MODEL_KINDS = ['per_minute_prorate'] as const;
export type FundingModelKind = (typeof FUNDING_MODEL_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Latency — задержка между командой и её приёмом средой.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Задержка не моделируется. Это ЕДИНСТВЕННЫЙ kind, который сегодня реализует хоть один
 * интерпретатор (и paper платформы, и backtester исполняют без задержки) — констатация
 * состояния кода, не предписание дефолта.
 */
export interface ZeroLatencyModel {
  readonly kind: 'zero';
}

/** Фиксированная задержка в миллисекундах. Реализующего интерпретатора пока НЕТ. */
export interface FixedMsLatencyModel {
  readonly kind: 'fixed_ms';
  /** Задержка приёма заявки средой. */
  readonly submitMs: number;
  /** Задержка приёма отмены; отсутствует ⇒ равна `submitMs`. */
  readonly cancelMs?: number;
}

/** Замкнутый каталог latency-моделей. */
export type LatencyModel = ZeroLatencyModel | FixedMsLatencyModel;

/** Замкнутый каталог `latency.kind`. */
export const LATENCY_MODEL_KINDS = ['zero', 'fixed_ms'] as const;
export type LatencyModelKind = (typeof LATENCY_MODEL_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Partial fill — дробит ли среда заявку на частичные исполнения.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Заявка исполняется целиком либо не исполняется. Единственный kind каталога: симуляция частичных
 * филлов сознательно вне скоупа (083 §2.7, §5 «вне скоупа»; LEAN тоже их не моделирует).
 */
export interface NoPartialFillModel {
  readonly kind: 'none';
}

/** Замкнутый каталог partial-fill-моделей. */
export type PartialFillModel = NoPartialFillModel;

/** Замкнутый каталог `partialFill.kind`. */
export const PARTIAL_FILL_MODEL_KINDS = ['none'] as const;
export type PartialFillModelKind = (typeof PARTIAL_FILL_MODEL_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// RealityModel — сущность прогона.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Слоты модели среды БЕЗ идентичности. Отдельный тип от `RealityModel`: во время dual-read-окна
 * те же слоты могут прийти встроенными в `ExecutionProfile`, у которого своя пара `id+version` —
 * выдавать её за идентичность модели среды нельзя (`resolveRealityModel`, risk-execution.ts).
 */
export interface RealityModelSlots {
  readonly fillModel: FillModel;
  readonly feeModel: FeeModel;
  readonly slippageModel: SlippageModel;
  /** Отсутствует ⇒ фандинг не начисляется (035: opt-in). */
  readonly fundingModel?: FundingModel;
  readonly latency?: LatencyModel;
  readonly partialFill?: PartialFillModel;
}

/**
 * `RealityModel` — версионированная модель среды исполнения. Runner-owned: не объявляется внутри
 * модуля, привязывается на уровне прогона по `id+version` (`BacktestRunRequest.realityModelRef`),
 * ровно как `RiskProfile`/`ExecutionProfile` (FR-016).
 */
export interface RealityModel extends RealityModelSlots {
  readonly id: string;
  readonly version: string;
}

/** Имена слотов модели среды (порядок — канонический, для детерминированной нормализации). */
export const REALITY_MODEL_SLOTS = [
  'fillModel',
  'feeModel',
  'slippageModel',
  'fundingModel',
  'latency',
  'partialFill',
] as const;
export type RealityModelSlotName = (typeof REALITY_MODEL_SLOTS)[number];

/** Имя слота → замкнутый каталог его `kind`'ов (единственный источник для валидатора). */
export const REALITY_MODEL_KIND_CATALOG: Readonly<Record<RealityModelSlotName, readonly string[]>> = {
  fillModel: FILL_MODEL_KINDS,
  feeModel: FEE_MODEL_KINDS,
  slippageModel: SLIPPAGE_MODEL_KINDS,
  fundingModel: FUNDING_MODEL_KINDS,
  latency: LATENCY_MODEL_KINDS,
  partialFill: PARTIAL_FILL_MODEL_KINDS,
};
