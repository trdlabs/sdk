// 017 — ModuleManifest (конверт) + кодовые модули + закрытая таксономия хуков/статусов/деклараций
// (FR-001/FR-002/FR-004/FR-032, data-model §2/§3/§4/§5/§14).

import type { OverlayDecision, StrategyDecision } from './decision.js';
import type { StrategyContext } from './context.js';
import type { StrategyLifecycle } from './event-driven.js';
import type { Ref } from './run.js';

/** Статус неизменяемой версии модуля; forward-only автомат (data-model §14). */
export type ModuleStatus = 'research_only' | 'reviewed' | 'promoted';

/** Дискриминатор вида модуля. */
export type ModuleKind = 'strategy' | 'overlay';

/** Происхождение автора — метаданные, НЕ привилегия (FR-030). */
export type Author = 'human' | 'agent';

/**
 * Закрытый набор lifecycle-хуков, курируемый платформой (FR-004, data-model §5).
 *
 * 083 E1 (аддитивно): `onEvent` — единственная точка входа формы `event_driven`. Добавлен В КОНЕЦ
 * (порядок существующих хуков не сдвигается — байт-идентичность нормализованных манифестов).
 */
export type LifecycleHook =
  | 'init'
  | 'onBarClose'
  | 'onPositionBar'
  | 'onPendingIntentBar'
  | 'dispose'
  | 'apply'
  | 'onEvent';

/**
 * Объявленные возможности модуля (FR-018, data-model §13.3). Любая из закрытого набора запрещённых
 * → `forbidden_capability`. Разрешено: только `platformSdk` + read-only контекст.
 *
 * Disambiguation: ОТДЕЛЬНЫЙ концепт от CapabilityDescriptor биржевого адаптера
 * (src/contracts/execution/capability-descriptor.ts). Разные домены — не переиспользовать.
 */
export interface CapabilityDeclaration {
  readonly exchangeDirect?: boolean;
  readonly brokerDirect?: boolean;
  readonly filesystem?: boolean;
  readonly network?: boolean;
  readonly process?: boolean;
  readonly env?: boolean;
  readonly dynamicEval?: boolean;
  readonly platformSdk?: boolean;
}

/**
 * Объявленная потребность в данных (FR-012, data-model §13.4).
 * forward/oracle/labeling/postTradeOutcome → `lookahead_violation`;
 * wallClock/uncontrolledRandom → `nondeterminism_violation`.
 *
 * 023 (аддитивно): `openInterest`/`liquidations` — легитимные point-in-time рыночные потребности
 * (каталог `SUPPORTED_MARKET_DATA_KINDS`, catalogs.ts). ДЕКЛАРАТИВНЫЙ контракт ожиданий, НЕ
 * permission gate: выставление `ctx.market` следует составу `MarketTape`, не декларации (FR-010).
 * Любой иной объявленный-`true` флаг вне замкнутого объединения каталогов → `unsupported_market_data_kind`.
 */
export interface DataNeedsDeclaration {
  readonly closedCandlesUpToCurrent?: boolean;
  readonly asOfIndicators?: boolean;
  // --- 023 (аддитивно): поддержанные point-in-time рыночные kind'ы ---
  readonly openInterest?: boolean;
  readonly liquidations?: boolean;
  // --- 030 (аддитивно): funding rate / raw taker buy-sell flow ---
  readonly funding?: boolean; // 030: потребность в funding rate
  readonly taker?: boolean; // 030: потребность в raw taker buy/sell flow
  readonly forwardBars?: boolean;
  readonly forwardWindow?: boolean;
  readonly oracle?: boolean;
  readonly labeling?: boolean;
  readonly postTradeOutcome?: boolean;
  readonly wallClock?: boolean;
  readonly uncontrolledRandom?: boolean;
}

/**
 * JSON-обёртка вокруг кодового модуля (FR-032). НЕ содержит логики стратегии (FR-033).
 * При submit `status` всегда `research_only` (FR-030).
 */
export interface ModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly kind: ModuleKind;
  readonly name: string;
  readonly summary: string;
  readonly rationale: string;
  readonly author: Author;
  readonly source?: string;
  readonly contractVersion: string;
  readonly status: ModuleStatus;
  /**
   * 083 E1 (аддитивно) — объявленная ФОРМА стратегии. Отсутствует ⇒ `single_position`: манифест
   * без этого поля описывает ровно ту же стратегию, что и до 083 (SC-008). Валидатор проверяет
   * соответствие объявленной формы набору хуков (`lifecycle_form_invalid`); исполнение формы —
   * зона рантайма (083 E2–E3), не 017.
   */
  readonly lifecycle?: StrategyLifecycle;
  /** Произвольная JSON Schema объявленных параметров (FR-034). */
  readonly paramsSchema: object;
  /** Payload параметров (валидируется против `paramsSchema`). */
  readonly params?: object;
  readonly capabilities: CapabilityDeclaration;
  readonly dataNeeds: DataNeedsDeclaration;
  readonly hooks: readonly LifecycleHook[];
  /** id целевой стратегии (только overlay). */
  readonly targetStrategyRef?: string;
  /** Ровно одна точка перехвата (только overlay). */
  readonly interceptionPoint?: string;
}

/** Один хук стратегии: read-only контекст → решение(я) | null. */
export type StrategyHook = (
  ctx: StrategyContext,
) => StrategyDecision | readonly StrategyDecision[] | null;

/**
 * Кодовый модуль самостоятельной стратегии (FR-001). `onBarClose` обязателен (минимальный
 * alpha-хук, FR-004). 017 валидирует manifest + author-supplied sampleDecisions; тело не исполняет.
 */
export interface StrategyModule {
  readonly manifest: ModuleManifest;
  readonly init?: (ctx: StrategyContext) => void;
  readonly onBarClose: StrategyHook;
  readonly onPositionBar?: StrategyHook;
  readonly onPendingIntentBar?: StrategyHook;
  readonly dispose?: (ctx: StrategyContext) => void;
}

/**
 * Кодовый модуль гипотезы-overlay (FR-002): вмешательство в РОВНО ОДНОЙ точке через `apply`.
 */
export interface HypothesisOverlayModule {
  readonly manifest: ModuleManifest;
  readonly apply: (
    ctx: StrategyContext,
  ) => OverlayDecision | readonly OverlayDecision[] | null;
}

/** Исход явного review (data-model §14). */
export type ReviewDecisionOutcome = 'approved' | 'rejected';

/** Явное решение review для продвижения. */
export interface ReviewDecision {
  readonly decision: ReviewDecisionOutcome;
  readonly reviewer?: string;
  readonly notes?: string;
}

/**
 * Запрос продвижения статуса неизменяемой версии модуля (data-model §14, FR-029/030/031).
 * Переходы forward-only по одному шагу: `research_only → reviewed → promoted`.
 *
 * Примечание: `fromStatus` — текущий статус версии, сообщаемый вызывающим. В stateless-валидаторе
 * 017 (без реестра) он нужен для проверки forward-only без обращения к хранилищу; будущий
 * registry/runner подставит авторитетный текущий статус.
 */
export interface PromotionRequest {
  readonly moduleRef: Ref;
  readonly fromStatus: ModuleStatus;
  readonly toStatus: ModuleStatus;
  readonly evidenceRef?: string;
  readonly reviewDecision?: ReviewDecision;
}
