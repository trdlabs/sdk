// 023 — контракт исторической рыночной ленты (raw market input). Аддитивный слой поверх 017/018/019.
//
// Все типы — `readonly`, strict TypeScript/ESM, чистые (стираются при компиляции; контракт ФОРМЫ,
// не реализация). `Bar` импортируется type-only из './context.js' (источник правды формы свечи 017;
// импорт стирается → runtime-цикла нет). Источник имён сырых снимков — каноническая строка 010
// `CanonicalRow` (`oi_total_usd`, `liq_long_usd`, `liq_short_usd`, `minute_ts`). НЕ трогать
// `CONTRACT_VERSION` (research R2): bump сломал бы байт-идентичность 018 и content-hash'и 022.
import type { Bar } from './context.js';

// ─────────────────────────────────────────────────────────────────────────────
// §3. Сырые point-in-time снимки (ТОЛЬКО сырые скаляры; производные метрики — downstream).
// ─────────────────────────────────────────────────────────────────────────────

/** Снимок open interest: сырой OI notional в USD. Маппинг 010: oi_total_usd. */
export interface OpenInterestSnapshot {
  readonly ts: number; // minute_ts
  readonly oiTotalUsd: number; // сырой notional USD
}

/**
 * Снимок liquidations: сырые long/short USD bucket'а [minute_ts, minute_ts+60_000).
 * Маппинг 010: liq_long_usd / liq_short_usd. Покрытая минута без событий → { longUsd:0, shortUsd:0 }
 * (валидно, НЕ gap, §4/FR-012).
 */
export interface LiquidationSnapshot {
  readonly ts: number; // minute_ts
  readonly longUsd: number; // ≥ 0
  readonly shortUsd: number; // ≥ 0
}

/**
 * 030 — снимок funding rate. Маппинг: CanonicalRow `funding_rate`/`has_funding` (027, v1).
 * **Логическое change-point событие** (sparse): эмитится на первой present-минуте + каждом изменении
 * `fundingRate`; live-forward повторы НЕ хранятся как снимки (свойство чтения, не потока). `0`/отрицательный
 * `fundingRate` — валидное present-наблюдение (не missing).
 */
export interface FundingSnapshot {
  readonly ts: number; // change-point minute_ts (момент, с которого рейт держится); freshness-evidence
  readonly fundingRate: number; // aggregated 8h-equiv (027); 0/отрицательный — валидны
}

/**
 * 030 — снимок raw taker flow за минутный бакет [ts, ts+60_000). Маппинг: CanonicalRow
 * `taker_buy_volume_usd`/`taker_sell_volume_usd`/`has_taker_flow` (028, v2). **Per-minute bucket** (dense).
 * Покрытая минута без сделок → `{ buyUsd:0, sellUsd:0 }` (валидный present-zero, НЕ gap). delta taker —
 * **derived** (`buyUsd − sellUsd`), не хранится. cumulative CVD не хранится (derive-only).
 */
export interface TakerSnapshot {
  readonly ts: number; // minute_ts бакета [ts, ts+60s)
  readonly buyUsd: number; // cross-source SUM taker BUY quote-USD (≥ 0); 0 валиден
  readonly sellUsd: number; // cross-source SUM taker SELL quote-USD (≥ 0); 0 валиден
}

// ─────────────────────────────────────────────────────────────────────────────
// §2. MarketTapeEvent — закрытый дискриминированный union point-in-time рыночных событий.
// Имя `MarketTapeEvent` (НЕ `MarketEvent`): операционная таксономия runtime занимает `MarketEvent`
// (src/types/events.ts, constitution X) — таксономической коллизии нет.
// ─────────────────────────────────────────────────────────────────────────────

/** Закрытый перечень видов событий ленты (аддитивно расширяемый). 030: +funding/taker_snapshot. */
export type MarketTapeEventKind =
  | 'bar_close'
  | 'oi_snapshot'
  | 'liq_snapshot'
  | 'funding_snapshot'
  | 'taker_snapshot';

/** Все виды событий ленты (для проверок полноты). 030: append-в-конце (byte-порядок не сдвигается). */
export const MARKET_TAPE_EVENT_KINDS: readonly MarketTapeEventKind[] = [
  'bar_close',
  'oi_snapshot',
  'liq_snapshot',
  'funding_snapshot',
  'taker_snapshot',
];

export interface BarCloseEvent {
  readonly kind: 'bar_close';
  readonly symbol: string;
  readonly ts: number; // = minute_ts закрытой свечи
  readonly bar: Bar; // 017 Bar (open/high/low/close/volume)
}

export interface OiSnapshotEvent {
  readonly kind: 'oi_snapshot';
  readonly symbol: string;
  readonly ts: number; // minute_ts
  readonly oi: OpenInterestSnapshot;
}

export interface LiqSnapshotEvent {
  readonly kind: 'liq_snapshot';
  readonly symbol: string;
  readonly ts: number; // minute_ts
  readonly liq: LiquidationSnapshot;
}

export interface FundingSnapshotEvent {
  readonly kind: 'funding_snapshot';
  readonly symbol: string;
  readonly ts: number; // change-point minute_ts
  readonly funding: FundingSnapshot;
}

export interface TakerSnapshotEvent {
  readonly kind: 'taker_snapshot';
  readonly symbol: string;
  readonly ts: number; // minute_ts бакета
  readonly taker: TakerSnapshot;
}

/**
 * Лента событий: OHLCV-only лента = поток, содержащий только `BarCloseEvent` (US6-AC2).
 * 030: + funding_snapshot (sparse change-point) / taker_snapshot (dense per-minute) — first-class члены.
 */
export type MarketTapeEvent =
  | BarCloseEvent
  | OiSnapshotEvent
  | LiqSnapshotEvent
  | FundingSnapshotEvent
  | TakerSnapshotEvent;

// ─────────────────────────────────────────────────────────────────────────────
// §7. CanonicalEventOrdering — детерминированный порядок ТОЛЬКО для serialization/диффа,
// НЕ порядок исполнения lifecycle (хук видит полный минутный snapshot для t).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intra-(symbol, ts) tie-breaker: bar_close → oi_snapshot → liq_snapshot → funding_snapshot →
 * taker_snapshot (§7). 030: append-в-конце — ordinal'ы existing kind'ов не меняются → golden'ы без
 * funding/taker событий байт-идентичны.
 */
export const CANONICAL_EVENT_ORDER: readonly MarketTapeEventKind[] = [
  'bar_close',
  'oi_snapshot',
  'liq_snapshot',
  'funding_snapshot',
  'taker_snapshot',
];

/**
 * Каноническое правило порядка событий ленты (§7): по symbol, затем ts (возрастание minute_ts),
 * затем intra-ts tie-breaker `CANONICAL_EVENT_ORDER`. Возвращает <0, 0 или >0 (Array.prototype.sort).
 */
export function compareMarketTapeEvents(a: MarketTapeEvent, b: MarketTapeEvent): number {
  if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
  if (a.ts !== b.ts) return a.ts - b.ts;
  return CANONICAL_EVENT_ORDER.indexOf(a.kind) - CANONICAL_EVENT_ORDER.indexOf(b.kind);
}

// ─────────────────────────────────────────────────────────────────────────────
// §1. MarketTape / HistoricalMarketTape — логическая событийная форма (сериализация/round-trip).
// ─────────────────────────────────────────────────────────────────────────────

/** Лента как упорядоченный поток типизированных рыночных событий (форма сериализации, §1.1). */
export interface MarketTape {
  readonly datasetRef: string;
  readonly timeframe: string; // напр. '1m' (минутная выравненность)
  /** Символы, присутствующие в ленте (детерминированный порядок). */
  readonly symbols: readonly string[];
  /** События в каноническом порядке (§7): по (symbol, ts), затем intra-ts tie-breaker. */
  readonly events: readonly MarketTapeEvent[];
}

/** Синоним, подчёркивающий историческую природу ленты. */
export type HistoricalMarketTape = MarketTape;

// ─────────────────────────────────────────────────────────────────────────────
// §1.2. MarketTapeDataset — материализованный per-symbol minute-indexed доступ + bridge toTape().
// ─────────────────────────────────────────────────────────────────────────────

/** Минутно-выровненная колонка снимков: доступ по minute_ts; покрытие — отдельно (§4). */
export interface MinuteColumn<T> {
  /** Снимок ровно за minute_ts, если минута ПОКРЫТА и содержит снимок; иначе undefined (gap). */
  at(minuteTs: number): T | undefined;
  /** Покрыта ли минута наблюдением (различение «0/0» vs «gap», §4). */
  covered(minuteTs: number): boolean;
}

/**
 * Материализованная лента: минутно-индексированные колонки на символ + покрытие.
 * Суперсет 018 `CandleDataset`: для OHLCV-only ленты `openInterest()`/`liquidations()` →
 * `undefined`, `candles()` идентичен 018 → байт-идентичность OHLCV-only пути.
 */
export interface MarketTapeDataset {
  readonly datasetRef: string;
  readonly timeframe: string;
  symbols(): readonly string[];
  /** Закрытые свечи символа (как 018 CandleDataset; bar_close-колонка). */
  candles(symbol: string): readonly Readonly<Bar>[];
  /** Снимки OI символа по минутам (если лента несёт OI), иначе undefined. */
  openInterest(symbol: string): MinuteColumn<OpenInterestSnapshot> | undefined;
  /** Снимки liquidations символа по минутам (если лента несёт liq), иначе undefined. */
  liquidations(symbol: string): MinuteColumn<LiquidationSnapshot> | undefined;
  /** 030 — снимки funding символа по минутам (если лента несёт funding), иначе undefined. */
  funding(symbol: string): MinuteColumn<FundingSnapshot> | undefined;
  /** 030 — снимки taker flow символа по минутам (если лента несёт taker), иначе undefined. */
  taker(symbol: string): MinuteColumn<TakerSnapshot> | undefined;
  /** Детерминированная сводка покрытия/пропусков (§4). */
  coverage(): CoverageModel;
  /**
   * Детерминированная проекция в логическую ленту (§1.1) для сериализации/round-trip/диффа.
   * Переносит datasetRef/timeframe/symbols; события — в каноническом порядке §7
   * (через `compareMarketTapeEvents`). Проекция — ТОЛЬКО serialization/tie-breaker,
   * НЕ порядок исполнения lifecycle.
   */
  toTape(): MarketTape;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4. CoverageModel / MarketDataGap — явная детерминированная модель покрытия/пропусков.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Поддержанные market-data kind'ы (синхронно с catalogs.ts `SUPPORTED_MARKET_DATA_KINDS`).
 * Sync-инвариант: ручной mirror закрытого литерала каталога; гейт `verify_030_catalog_version` ассертит
 * согласованность. 030: +funding/taker.
 */
export type MarketDataKind = 'openInterest' | 'liquidations' | 'funding' | 'taker';

/** Непрерывное окно непокрытых минут [tsFrom, tsTo] (inclusive), minute-aligned. */
export interface MarketDataGap {
  readonly tsFrom: number;
  readonly tsTo: number;
}

/**
 * 030 — полная per-kind coverage-таксономия (platform-level). present-zero ≠ missing/stale/unsupported.
 * `unsupported` — kind не поддержан **ни одним** источником (platform-level capability-предикат), НЕ из
 * per-source breakdown (per-source diagnostics не протекают в research, FR-018). Заполняется для funding/taker;
 * oi/liq сохраняют 023-семантику covered/gap (`state` опционален).
 */
export type MarketDataCoverageState = 'present' | 'missing' | 'stale' | 'unsupported';

/** Сводка покрытия одного (symbol, kind) за запрошенный период. */
export interface KindCoverage {
  readonly symbol: string;
  readonly kind: MarketDataKind;
  /** Несёт ли лента этот kind для символа ВООБЩЕ (иначе — кандидат на missing_required, §R6). */
  readonly present: boolean;
  /** Кол-во покрытых минут (наблюдавшихся; снимок есть, в т.ч. liq 0/0). */
  readonly coveredMinutes: number;
  /** Кол-во минут периода без покрытия (gaps). */
  readonly gapMinutes: number;
  /** Затронутые пропусками окна (детерминированно отсортированы; FR-014). */
  readonly gaps: readonly MarketDataGap[];
  /** 030 — per-kind состояние (funding/taker); oi/liq → covered/gap как 023 (state опускается). */
  readonly state?: MarketDataCoverageState;
}

/** Полная модель покрытия ленты (детерминированный порядок: по symbol, затем kind). */
export interface CoverageModel {
  readonly entries: readonly KindCoverage[];
}

// ─────────────────────────────────────────────────────────────────────────────
// §5. PointInTimeMarketApi — аддитивная опциональная поверхность доступа к OI/liq.
// Строго `ts ≤ t`; gap → explicit undefined; carry-forward запрещён; НЕТ forward-методов;
// результат deep-frozen. Source of truth типов (context.ts делает type-only импорт).
// ─────────────────────────────────────────────────────────────────────────────

/** Точка OI as-of минуты (read-only). */
export interface OiPoint {
  readonly ts: number;
  readonly oiTotalUsd: number;
}

/** Точка liquidations as-of минуты (read-only). Покрытая-без-событий → {0,0}. */
export interface LiqPoint {
  readonly ts: number;
  readonly longUsd: number;
  readonly shortUsd: number;
}

/** 030 — точка funding as-of минуты (read-only). `ts` реального снимка, `ts ≤ t` (возраст = `t − ts`). */
export interface FundingPoint {
  readonly ts: number;
  readonly fundingRate: number; // 0/отрицательный — валидны
}

/**
 * 030 — freshness-aware funding reading для текущей закрытой минуты `t`. **3-state** (`present|stale|missing`);
 * `unsupported` — НЕ reading-состояние (выражается через отсутствие метода + coverage). `present`/`stale`
 * несут реальный снимок (`ts ≤ t`); `stale` = bounded live-forward (FR-007), НЕ запрещённый carry-forward.
 * `missing` — нет снимка `ts ≤ t` (не подменяется нулём).
 */
export type FundingReading =
  | { readonly state: 'present'; readonly point: FundingPoint } // вкл. 0/отрицательный rate
  | { readonly state: 'stale'; readonly point: FundingPoint } // снимок есть, просрочен (R6)
  | { readonly state: 'missing' };

/** 030 — точка raw taker flow за минутный бакет (read-only). delta = `buyUsd − sellUsd` (derived). */
export interface TakerPoint {
  readonly ts: number;
  readonly buyUsd: number;
  readonly sellUsd: number;
}

/**
 * 030 — taker reading за минутный бакет `[t, t+60s)`. **3-state** (`present|stale|missing`); `unsupported`
 * — НЕ reading-состояние. `present` несёт raw `{buyUsd,sellUsd}` (вкл. present-zero `{0,0}`); `stale` —
 * незавершённый бакет (point НЕ несётся, без carry-forward); `missing` — gap (не ноль).
 */
export type TakerReading =
  | { readonly state: 'present'; readonly point: TakerPoint } // вкл. present-zero {0,0}
  | { readonly state: 'stale' } // незавершённый бакет (no carry-forward)
  | { readonly state: 'missing' };

/**
 * Point-in-time доступ к рыночным снимкам. ТОЛЬКО назад. Отсутствие forward-методов —
 * структурный инвариант no-lookahead (FR-006, US3-AC2). Все значения ts ≤ t.
 */
export interface PointInTimeMarketApi {
  /** OI ровно за текущую минуту t; undefined если минута непокрыта (gap) или OI нет в ленте. */
  oiAsOf(): OiPoint | undefined;
  /** Liquidations за минуту t; covered-no-events → {longUsd:0,shortUsd:0}; gap → undefined. */
  liqAsOf(): LiqPoint | undefined;
  /**
   * Окно последних `lookback` минутных бакетов OI, заканчивающееся НА t включительно
   * (индекс len-1 = минута t). Каждый слот — точка или undefined (gap, без carry-forward).
   * Длина массива = min(lookback, доступные бакеты [0..t]).
   */
  oiWindow(lookback: number): readonly (OiPoint | undefined)[];
  /** Аналогично для liquidations (covered-no-events → {0,0}; gap → undefined). */
  liqWindow(lookback: number): readonly (LiqPoint | undefined)[];
  /**
   * 030 — funding as-of `t` (последний снимок `ts ≤ t`, bounded live-forward). Опционален: присутствует ⇔
   * лента несёт funding (composition-following). `FundingReading` различает present/stale/missing.
   */
  fundingAsOf?(): FundingReading;
  /**
   * 030 — окно funding, заканчивающееся на `t` включительно. **per-minute as-of live-forward**: один
   * `FundingPoint` (со своим `ts`) повторяется в слотах до stale-boundary, после → undefined. Длина
   * `min(lookback, доступные [0..t])`; без forward-слотов. Опционален (composition-following).
   */
  fundingWindow?(lookback: number): readonly (FundingPoint | undefined)[];
  /**
   * 030 — taker as-of `t` (бакет точно минуты `t`). Опционален: присутствует ⇔ лента несёт taker.
   * `TakerReading` различает present (вкл. present-zero) / stale / missing.
   */
  takerAsOf?(): TakerReading;
  /**
   * 030 — окно taker, заканчивающееся на `t` включительно. **per-minute exact**, без carry-forward
   * (gap → undefined, present-zero → реальная точка `{0,0}`). Длина `min(lookback, доступные [0..t])`;
   * без forward-слотов. Опционален (composition-following).
   */
  takerWindow?(lookback: number): readonly (TakerPoint | undefined)[];
}

// ─────────────────────────────────────────────────────────────────────────────
// §10/§8. RawMarketTapeSource (вход loader) + TapeBuildResult (исход построения).
// ─────────────────────────────────────────────────────────────────────────────

/** Per-symbol колонки сырого источника ленты (формат tape-фикстуры §10). */
export interface RawMarketTapeSymbolColumns {
  readonly bars: readonly Bar[];
  /** Опционально; отсутствие минуты в колонке = gap (не carry-forward). */
  readonly oi?: readonly OpenInterestSnapshot[];
  /** Опционально; покрытая минута без событий = {longUsd:0,shortUsd:0} (валидно). */
  readonly liq?: readonly LiquidationSnapshot[];
  /**
   * 030 — funding: **dense** (по одному снимку на каждую funding-покрытую минуту, live-forward).
   * Дедуп в change-point события и coverage-множество выполняется при материализации (R6).
   */
  readonly funding?: readonly FundingSnapshot[];
  /** 030 — taker: **dense** (по одному бакету на каждую покрытую минуту; present-zero {0,0} валиден). */
  readonly taker?: readonly TakerSnapshot[];
}

/**
 * Допустимый raw-market источник построения ленты (§8/§10). Несёт явный дискриминатор
 * `kind:'market_tape'` и только известные рыночные поля. Expected-output источники
 * (trades/fills/orders/…) отклоняются guard'ом со стабильной причиной `non_market_source`.
 */
export interface RawMarketTapeSource {
  readonly kind: 'market_tape';
  readonly datasetRef: string;
  readonly timeframe: string;
  readonly symbols: Readonly<Record<string, RawMarketTapeSymbolColumns>>;
}

/** Исход построения ленты из источника (§8). */
export type TapeBuildResult =
  | { readonly ok: true; readonly tape: MarketTapeDataset }
  | { readonly ok: false; readonly reason: 'non_market_source'; readonly detail: string };
