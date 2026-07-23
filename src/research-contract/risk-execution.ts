// 017 — runner-owned профили риска и исполнения (FR-013/FR-014, data-model §9/§10).
// Не объявляются внутри модуля; привязываются на уровне прогона (FR-016).
//
// Ф1 `shared-execution-engine`: модель СРЕДЫ исполнения (fill/fee/slippage/funding/latency/
// partialFill) вынесена в отдельную версионированную сущность `RealityModel` (reality-model.ts).
// `ExecutionProfile` остаётся документом НАМЕРЕНИЯ (тип ордера, TIF, bracket-политика).
// Импорт type-only → раннтайм-ребра между файлами нет (reality-model.ts сюда не импортирует).

import type {
  FeeModel,
  FillModel,
  FundingModel,
  LatencyModel,
  PartialFillModel,
  RealityModel,
  RealityModelSlots,
  SlippageModel,
} from './reality-model.js';
import type { Ref } from './run.js';

/** Границы дистанции (stop/take). */
export interface Bounds {
  readonly min: number;
  readonly max: number;
}

/**
 * RiskProfile — единственный hard-authority слой финального accept/clamp/reject для hints модуля
 * (FR-013). Привязывается к прогону по id+version.
 */
export interface RiskProfile {
  readonly id: string;
  readonly version: string;
  readonly maxConcurrentPositions: number;
  readonly exposureLimits: object;
  readonly allowedSides: readonly ('long' | 'short')[];
  readonly stopBounds?: Bounds;
  readonly takeBounds?: Bounds;
  readonly dcaLimits?: object;
  readonly scaleInLimits?: object;
  readonly validatorRefs?: readonly string[];
}

/** Тип заявки, которым выражается намерение исполнения (вокабуляр 083 `ActorCommand.type`). */
export type OrderType = 'market' | 'limit' | 'stop_market';

/** Time-in-force заявки (вокабуляр 083 `ActorCommand.tif`). */
export type TimeInForce = 'gtc' | 'ioc';

/**
 * ExecutionProfile — assumptions исполнения (FR-014). Привязывается к прогону по id+version.
 *
 * Ф1: профиль сужается до НАМЕРЕНИЯ. Слоты модели среды сохранены и принимаются (dual-read-окно),
 * но помечены `@deprecated` — их место в `RealityModel`, привязываемой через `realityModelRef`.
 * Читать обе формы следует ТОЛЬКО через `resolveRealityModel` (fail-closed на расхождении).
 *
 * Sizing здесь сознательно отсутствует: потолки размера — hard authority `RiskProfile`
 * (`exposureLimits`), дублировать их в профиле исполнения нельзя (FR-013/FR-015).
 */
export interface ExecutionProfile {
  readonly id: string;
  readonly version: string;

  // --- Намерение ---

  /** Тип заявки по умолчанию для прогона. */
  readonly orderType?: OrderType;
  /** Time-in-force по умолчанию для прогона. */
  readonly timeInForce?: TimeInForce;
  /**
   * Политика защитных заявок (stop/take) и их отмены по таймауту. Остаётся `object`: типизированного
   * потребителя у слота пока нет — сужать до каталога нечем (каталог пополняется по реализации).
   */
  readonly bracketPolicy?: object;

  // --- Модель среды (dual-read-окно; переезжает в RealityModel) ---
  //
  // Привязки модели среды здесь НЕТ намеренно: единственная точка привязки — уровень прогона
  // (`BacktestRunRequest.realityModelRef`), как у `riskProfileRef`/`executionProfileRef` (FR-016).
  // Второй ref на профиле дал бы два источника истины без правила разрешения конфликта.

  /** @deprecated Ф1 — перенесено в `RealityModel.fillModel`; принимается до конца dual-read-окна. */
  readonly fillModel?: FillModel;
  /** @deprecated Ф1 — перенесено в `RealityModel.feeModel`; принимается до конца dual-read-окна. */
  readonly feeModel?: FeeModel;
  /** @deprecated Ф1 — перенесено в `RealityModel.slippageModel`; принимается до конца dual-read-окна. */
  readonly slippageModel?: SlippageModel;
  /** @deprecated Ф1 — перенесено в `RealityModel.fundingModel`; принимается до конца dual-read-окна. */
  readonly fundingModel?: FundingModel;
  /** @deprecated Ф1 — перенесено в `RealityModel.latency`; принимается до конца dual-read-окна. */
  readonly latency?: LatencyModel;
  /** @deprecated Ф1 — перенесено в `RealityModel.partialFill`; принимается до конца dual-read-окна. */
  readonly partialFill?: PartialFillModel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dual-read: единственная санкционированная точка чтения модели среды на время окна.
// ─────────────────────────────────────────────────────────────────────────────

/** Откуда прочитана модель среды. */
export type RealityModelSource = 'reality_model' | 'execution_profile_embedded';

/** Причина, по которой модель среды не прочитана (fail-closed; молчаливого fallback нет). */
export type RealityModelResolutionFailure =
  /** Ни разделённой, ни встроенной формы: обязательные слоты не объявлены. */
  | 'missing_reality_model'
  /** Обе формы присутствуют и НЕ совпадают — какая из них истина, контракт не решает. */
  | 'conflicting_reality_model'
  /** Прогон привязал модель по ref, но вызывающий её не разрезолвил (реестр не отдал). */
  | 'unresolved_reality_model_ref'
  /** Разрезолвленная модель — НЕ та, что привязана прогоном: `id@version` не совпадает с ref. */
  | 'reality_model_ref_mismatch'
  /**
   * Модель передана БЕЗ привязки прогона. Зеркало `reality_model_ref_mismatch`: там прогон
   * привязал одну модель, а подсунули другую; здесь прогон не привязывал НИЧЕГО, а модель всё
   * равно подана. Принять её значило бы, что идентичность модели удостоверяет сама модель, —
   * тогда единственная точка привязки (`BacktestRunRequest.realityModelRef`) обходится тривиально.
   */
  | 'unbound_reality_model';

/** Исход dual-read-чтения. */
export type RealityModelResolution =
  | {
      readonly ok: true;
      readonly source: RealityModelSource;
      readonly slots: RealityModelSlots;
      /** Идентичность модели среды; отсутствует у встроенной формы (у неё её нет). */
      readonly ref?: Ref;
    }
  | { readonly ok: false; readonly reason: RealityModelResolutionFailure };

/** Вход чтения, когда прогон модель среды НЕ привязывал: читается встроенная форма. */
export interface EmbeddedRealityModelReadInput {
  readonly executionProfile: ExecutionProfile;
  /** Привязки нет. Поле объявлено явно, чтобы `realityModel` было нечем «протащить» мимо ref. */
  readonly realityModelRef?: undefined;
  readonly realityModel?: undefined;
}

/** Вход чтения, когда прогон привязал модель среды по ref. */
export interface BoundRealityModelReadInput {
  readonly executionProfile: ExecutionProfile;
  /** Привязка прогона (`BacktestRunRequest.realityModelRef`). */
  readonly realityModelRef: Ref;
  /**
   * Модель, разрезолвленная вызывающим по `realityModelRef`. Может отсутствовать (реестр не
   * отдал) — тогда чтение падает в `unresolved_reality_model_ref`, а не читает встроенную форму.
   */
  readonly realityModel?: RealityModel;
}

/**
 * Вход dual-read-чтения. Union, а не один интерфейс с двумя опциональными полями: модель среды
 * может прийти ТОЛЬКО вместе с привязкой прогона. Иначе идентичность модели удостоверяла бы
 * сама модель, и заявленная единственная точка привязки не значила бы ничего.
 *
 * Тип закрывает это на компиляции; `unbound_reality_model` — тот же инвариант в рантайме, для
 * вызывающих из JS и для данных, пришедших с границы нетипизированными.
 */
export type RealityModelReadInput =
  | EmbeddedRealityModelReadInput
  | BoundRealityModelReadInput;

/** Детерминированная сериализация с отсортированными ключами (сравнение форм, не хранение). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const body = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`)
    .join(',');
  return `{${body}}`;
}

/** Слоты модели среды в каноническом порядке, с опущенными отсутствующими. */
function slotsOf(src: RealityModelSlots | ExecutionProfile): RealityModelSlots | undefined {
  const { fillModel, feeModel, slippageModel, fundingModel, latency, partialFill } = src;
  if (fillModel === undefined || feeModel === undefined || slippageModel === undefined) {
    return undefined;
  }
  return {
    fillModel,
    feeModel,
    slippageModel,
    ...(fundingModel !== undefined ? { fundingModel } : {}),
    ...(latency !== undefined ? { latency } : {}),
    ...(partialFill !== undefined ? { partialFill } : {}),
  };
}

/**
 * Прочитать модель среды прогона в dual-read-окне Ф1.
 *
 * Правила (fail-closed, конституция XIV — без молчаливого fallback):
 * - модель передана без привязки прогона → отказ `unbound_reality_model`;
 * - ref привязан, модель не передана → отказ `unresolved_reality_model_ref`;
 * - ref привязан, но у модели другой `id@version` → отказ `reality_model_ref_mismatch`
 *   (вместе с предыдущим правилом это закрывает подмену с ОБЕИХ сторон: нельзя ни подменить
 *   привязанную модель другой, ни подать модель, которую прогон не привязывал, — ровно те
 *   подмены, ради исключения которых модель вообще сделана версионированной);
 * - только разделённая форма → `reality_model`;
 * - только встроенная в `ExecutionProfile` → `execution_profile_embedded`;
 * - обе и они СОВПАДАЮТ послотно → `reality_model` (миграция консистентна);
 * - обе и они РАСХОДЯТСЯ → отказ `conflicting_reality_model`;
 * - ни одной полной формы → отказ `missing_reality_model`.
 *
 * Precedence разделённой формы — правило чтения, а не семантика исполнения: какая модель среды
 * применяется в paper/backtest/live, решает Ф1-SSOT-документ, не этот контракт.
 */
export function resolveRealityModel(input: RealityModelReadInput): RealityModelResolution {
  const { executionProfile, realityModelRef, realityModel } = input;
  const embedded = slotsOf(executionProfile);

  if (realityModelRef === undefined) {
    // Непривязанная модель не «почти привязанная»: без ref прогона её нечем удостоверить.
    if (realityModel !== undefined) return { ok: false, reason: 'unbound_reality_model' };
  } else {
    if (realityModel === undefined) return { ok: false, reason: 'unresolved_reality_model_ref' };
    if (realityModel.id !== realityModelRef.id || realityModel.version !== realityModelRef.version) {
      return { ok: false, reason: 'reality_model_ref_mismatch' };
    }
  }

  if (realityModel === undefined) {
    return embedded === undefined
      ? { ok: false, reason: 'missing_reality_model' }
      : { ok: true, source: 'execution_profile_embedded', slots: embedded };
  }

  const split = slotsOf(realityModel);
  if (split === undefined) return { ok: false, reason: 'missing_reality_model' };
  if (embedded !== undefined && canonical(embedded) !== canonical(split)) {
    return { ok: false, reason: 'conflicting_reality_model' };
  }
  return {
    ok: true,
    source: 'reality_model',
    slots: split,
    ref: { id: realityModel.id, version: realityModel.version },
  };
}
