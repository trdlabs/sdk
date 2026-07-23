// 083 E1 — kernel-контракт формы `event_driven`: стратегия как stateful-актор над order-flow.
//
// Эскиз и обоснование: platform `specs/083-event-driven-runtime-spike/research.md` §3 D1.
// Ранний старт E1 разрешён карточкой `shared-execution-engine` (раздел Ф6, exception 2026-07-23):
// изменение ЧИСТО АДДИТИВНОЕ, рантаймов не трогает, все существующие бандлы остаются валидны с
// дефолтным `single_position`. E2–E7 (граница изолята, движок, RiskEngine, event-spine) — за
// триггером возврата эпика; здесь только СЛОВАРЬ, чтобы lab мог готовить авторство заранее.
//
// Две формы стратегии, не одна с флагом:
// - `single_position` — чистая decision-функция над flat-snapshot; lifecycle позиции держит хост
//   (`StrategyDecision`, хуки `onBarClose`/`onPositionBar`/`onPendingIntentBar`). Не меняется.
// - `event_driven` — актор с ОДНОЙ точкой входа `onEvent` (урок LEAN `IAlgorithm`: узкое ядро,
//   sugar снаружи) и явными ордерными командами.
//
// Ключевые решения 083, зафиксированные формой этих типов:
// - `clientOrderId` генерирует СТРАТЕГИЯ (детерминированно от seed/счётчика) — OrderTicket-паттерн
//   без хендла через JSON-границу изолята: актор ссылается на свои заявки своими ID.
// - `qtyUsd` явный, а не `sizingHint` (Q2): grid/MM-логика невыразима косвенностью. Доверия к
//   размеру это не даёт — RiskEngine клампит по `RiskProfile` (философия 086/087: стратегия
//   просит, платформа зажимает).
// - `modify` в v1 ОТСУТСТВУЕТ (Q3): place-after-cancel; FSM минимальна, proof проще.
// - `order.denied` (локальный отказ риска) ≠ `order.rejected` (отказ venue/симулятора) —
//   заимствовано у Nautilus; различимость нужна стратегии, чтобы не долбиться в закрытую дверь.
// - ctx — PULL-модель (Nautilus Cache): снапшот `orders`/`position` в конверте события УЖЕ
//   отражает доставляемое событие (инвариант state-before-handler).

import type { Bar } from './context.js';
import type {
  FundingReading,
  LiqPoint,
  OiPoint,
  TakerReading,
} from './market-tape.js';
import type { OrderType, TimeInForce } from './risk-execution.js';

// ─────────────────────────────────────────────────────────────────────────────
// Форма стратегии.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Объявленная форма стратегии. Дефолт — `single_position`: манифест без поля `lifecycle`
 * описывает ровно ту же стратегию, что и до 083 (back-compat, SC-008).
 */
export type StrategyLifecycle = 'single_position' | 'event_driven';

/** Замкнутый каталог форм стратегии. */
export const STRATEGY_LIFECYCLES = ['single_position', 'event_driven'] as const;

/** Форма, подразумеваемая манифестом без явного `lifecycle`. */
export const DEFAULT_STRATEGY_LIFECYCLE: StrategyLifecycle = 'single_position';

/**
 * Версия контракта, ВВОДЯЩАЯ surface 083 E1 (поле `lifecycle` и хук `onEvent`).
 *
 * Манифест, объявляющий этот surface под более ранней версией, отклоняется
 * (`unsupported_contract_version`): иначе bump `017.2 → 017.3` был бы чисто декларативным —
 * `contractVersion` перестал бы говорить, какой конверт манифеста автор объявил, и версия
 * потеряла бы способность что-либо ограждать.
 */
export const EVENT_DRIVEN_MIN_CONTRACT_VERSION = '017.3';

/** Хуки, допустимые для `event_driven` (единая точка входа + опциональный жизненный цикл). */
export const EVENT_DRIVEN_HOOKS = ['init', 'onEvent', 'dispose'] as const;

/** Хуки, принадлежащие ИСКЛЮЧИТЕЛЬНО фазовой модели `single_position`. */
export const SINGLE_POSITION_ONLY_HOOKS = [
  'onBarClose',
  'onPositionBar',
  'onPendingIntentBar',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Читаемое состояние (pull-модель ctx).
// ─────────────────────────────────────────────────────────────────────────────

/** Сторона заявки. Отдельно от `'long' | 'short'` решений 017: заявка — buy/sell, не позиция. */
export type OrderSide = 'buy' | 'sell';

/**
 * Статус ОТКРЫТОЙ заявки — нетерминальное подмножество ордер-FSM. Терминальные статусы
 * (`filled`/`canceled`/`rejected`/`denied`/`expired`) в `ctx.orders.open()` не встречаются: они
 * доставляются событиями. Полная FSM — зона движка (E3), здесь только то, что видит стратегия.
 */
export type OpenOrderStatus = 'submitted' | 'accepted' | 'triggered' | 'partially_filled';

/** Снимок открытой заявки в контексте актора. */
export interface OpenOrderView {
  readonly clientOrderId: string;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly status: OpenOrderStatus;
  /** Запрошенный нотионал заявки в USD. */
  readonly qtyUsd: number;
  /** Уже исполненная часть нотионала (0, пока филлов не было). */
  readonly filledQtyUsd: number;
  readonly price?: number;
  readonly stopPrice?: number;
  readonly reduceOnly?: boolean;
  /** business_ts подачи заявки (часы данных, не wall-clock). */
  readonly createdTs: number;
}

/** Снимок позиции в контексте актора (NETTING: одна позиция на инструмент). */
export interface PositionView {
  readonly side: 'long' | 'short';
  /** Размер в базовой валюте инструмента. */
  readonly qty: number;
  readonly avgPrice: number;
  readonly unrealizedPnl?: number;
}

/**
 * Плоский point-in-time рыночный срез, прикладываемый к `bar`-событию. В отличие от
 * `PointInTimeMarketApi` (017/023, методы) — ЧИСТЫЕ ДАННЫЕ: конверт события пересекает
 * JSON-границу изолята, функции через неё не проходят.
 *
 * Слот присутствует по тому же composition-following правилу, что и `StrategyContext.market`:
 * по составу ленты, а НЕ по декларации `dataNeeds` (FR-010).
 */
export interface FlatMarketSlice {
  readonly oi?: OiPoint;
  readonly liq?: LiqPoint;
  readonly funding?: FundingReading;
  readonly taker?: TakerReading;
}

// ─────────────────────────────────────────────────────────────────────────────
// ActorInputEvent — что хост доставляет актору.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Закрытие бара. Несёт окно закрытых свечей: у актора нет `data`-API — всё, что он может
 * прочитать о прошлом, приходит в конверте. Forward-поверхности нет структурно (FR-011).
 */
export interface ActorBarEvent {
  readonly kind: 'bar';
  readonly ts: number;
  readonly bar: Bar;
  /** Закрытые свечи строго ДО `bar`, не более объявленного статического max-lookback. */
  readonly closedCandles?: readonly Bar[];
  readonly market?: FlatMarketSlice;
}

/** Заявка принята средой (venue/симулятором). */
export interface ActorOrderAcceptedEvent {
  readonly kind: 'order.accepted';
  readonly ts: number;
  readonly clientOrderId: string;
}

/**
 * Заявка отклонена ЛОКАЛЬНО, до среды: RiskEngine (кламп не спас — потолок, rate-limit,
 * price-band, reduce-only в REDUCING). Терминальный. Отличим от `order.rejected` намеренно.
 */
export interface ActorOrderDeniedEvent {
  readonly kind: 'order.denied';
  readonly ts: number;
  readonly clientOrderId: string;
  readonly reason: string;
}

/** Заявка отклонена СРЕДОЙ (venue/симулятор). Терминальный. */
export interface ActorOrderRejectedEvent {
  readonly kind: 'order.rejected';
  readonly ts: number;
  readonly clientOrderId: string;
  readonly reason: string;
}

/** Заявка отменена (по команде `cancel` либо средой). Терминальный. */
export interface ActorOrderCanceledEvent {
  readonly kind: 'order.canceled';
  readonly ts: number;
  readonly clientOrderId: string;
}

/** Заявка истекла по TIF/сроку. Терминальный. */
export interface ActorOrderExpiredEvent {
  readonly kind: 'order.expired';
  readonly ts: number;
  readonly clientOrderId: string;
}

/**
 * Исполнение (полное либо частичное — различает `last`). Инвариант state-before-handler:
 * `ctx.position()`/`ctx.orders.open()` УЖЕ учитывают этот филл к моменту вызова хендлера.
 */
export interface ActorFillEvent {
  readonly kind: 'fill';
  readonly ts: number;
  readonly clientOrderId: string;
  readonly price: number;
  /** Исполненный размер в базовой валюте инструмента. */
  readonly qty: number;
  readonly fee: number;
  /** Последний филл заявки (заявка перешла в терминальный `filled`). */
  readonly last: boolean;
}

/**
 * Срабатывание таймера, поставленного командой `timer.set`. Таймерами владеет ХОСТ: у изолята
 * нет часов. В backtest/paper время двигают бары, в live дополнительно wall-clock-тик — business_ts
 * события в обоих случаях из ленты, нового недетерминизма нет.
 */
export interface ActorTimerEvent {
  readonly kind: 'timer';
  readonly ts: number;
  readonly timerId: string;
}

/** Замкнутый union входных событий актора. */
export type ActorInputEvent =
  | ActorBarEvent
  | ActorOrderAcceptedEvent
  | ActorOrderDeniedEvent
  | ActorOrderRejectedEvent
  | ActorOrderCanceledEvent
  | ActorOrderExpiredEvent
  | ActorFillEvent
  | ActorTimerEvent;

/** Все виды входных событий (для проверок полноты диспетчера). */
export const ACTOR_INPUT_EVENT_KINDS = [
  'bar',
  'order.accepted',
  'order.denied',
  'order.rejected',
  'order.canceled',
  'order.expired',
  'fill',
  'timer',
] as const;

export type ActorInputEventKind = (typeof ACTOR_INPUT_EVENT_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// ActorCommand — что актор просит у хоста.
// ─────────────────────────────────────────────────────────────────────────────

// Заявка разложена на ветку НА ТИП ОРДЕРА, а не на один тип с опциональными ценами: `limit` без
// `price` и `stop_market` без `stopPrice` неисполнимы, а `market` с ценой неоднозначен. Команды
// приходят из НЕДОВЕРЕННОГО кода через JSON-границу — двусмысленная команда должна отваливаться на
// схеме у хоста, а не доезжать до движка, где её пришлось бы трактовать.

/** Рыночная заявка: исполняется по состоянию среды, цены не несёт. */
export interface ActorPlaceMarketCommand {
  readonly kind: 'place';
  readonly type: 'market';
  readonly clientOrderId: string;
  readonly side: OrderSide;
  /** Запрашиваемый нотионал в USD (до клампа риском). */
  readonly qtyUsd: number;
  readonly tif?: TimeInForce;
  /** Заявка только уменьшает экспозицию; проходит и в состоянии REDUCING. */
  readonly reduceOnly?: boolean;
  readonly tags?: readonly string[];
  readonly rationale?: string;
}

/** Лимитная заявка: `price` обязателен, триггера нет. */
export interface ActorPlaceLimitCommand {
  readonly kind: 'place';
  readonly type: 'limit';
  readonly clientOrderId: string;
  readonly side: OrderSide;
  readonly qtyUsd: number;
  /** Лимитная цена. */
  readonly price: number;
  readonly tif?: TimeInForce;
  readonly reduceOnly?: boolean;
  readonly tags?: readonly string[];
  readonly rationale?: string;
}

/** Стоп-маркет заявка: `stopPrice` обязателен, лимитной цены нет. */
export interface ActorPlaceStopMarketCommand {
  readonly kind: 'place';
  readonly type: 'stop_market';
  readonly clientOrderId: string;
  readonly side: OrderSide;
  readonly qtyUsd: number;
  /** Триггерная цена. */
  readonly stopPrice: number;
  readonly tif?: TimeInForce;
  readonly reduceOnly?: boolean;
  readonly tags?: readonly string[];
  readonly rationale?: string;
}

/**
 * Подать заявку. `clientOrderId` — свой, детерминированный (от seed/счётчика); повтор
 * уже живого ID — ошибка хоста, а не молчаливая замена. `qtyUsd` — ПРОСЬБА: RiskEngine клампит
 * или отказывает (`order.denied`).
 */
export type ActorPlaceCommand =
  | ActorPlaceMarketCommand
  | ActorPlaceLimitCommand
  | ActorPlaceStopMarketCommand;

/** Отменить свою заявку по её `clientOrderId`. `modify` в v1 нет — place-after-cancel (Q3). */
export interface ActorCancelCommand {
  readonly kind: 'cancel';
  readonly clientOrderId: string;
}

/** Таймер на абсолютный business_ts. */
export interface ActorTimerSetAtCommand {
  readonly kind: 'timer.set';
  readonly timerId: string;
  /** Абсолютный business_ts срабатывания (часы данных, не wall-clock). */
  readonly atTs: number;
}

/** Таймер через `afterMs` от `ts` обрабатываемого события. */
export interface ActorTimerSetAfterCommand {
  readonly kind: 'timer.set';
  readonly timerId: string;
  /** Смещение от `ts` события, породившего команду. */
  readonly afterMs: number;
}

/**
 * Поставить таймер: ЛИБО абсолютный `atTs`, ЛИБО относительный `afterMs` — строго одно из двух.
 * Ни то ни другое (когда будить?) и оба сразу (какое из них истина?) — неоднозначные команды,
 * и обе формы закрыты на уровне схемы, а не соглашением.
 */
export type ActorTimerSetCommand = ActorTimerSetAtCommand | ActorTimerSetAfterCommand;

/** Снять ранее поставленный таймер. */
export interface ActorTimerCancelCommand {
  readonly kind: 'timer.cancel';
  readonly timerId: string;
}

/** Только метаданные в трассу — без действия (аналог `AnnotateDecision` в 017). */
export interface ActorAnnotateCommand {
  readonly kind: 'annotate';
  readonly note: string;
  readonly tags?: readonly string[];
}

/** Замкнутый union команд актора. */
export type ActorCommand =
  | ActorPlaceCommand
  | ActorCancelCommand
  | ActorTimerSetCommand
  | ActorTimerCancelCommand
  | ActorAnnotateCommand;

/** Все виды команд (для проверок полноты диспетчера хоста). */
export const ACTOR_COMMAND_KINDS = [
  'place',
  'cancel',
  'timer.set',
  'timer.cancel',
  'annotate',
] as const;

export type ActorCommandKind = (typeof ACTOR_COMMAND_KINDS)[number];

/**
 * Батч команд — то, что актор возвращает из одного `onEvent` и что пересекает JSON-границу
 * изолята. Хост валидирует именно ЕГО (схема `actor-command-batch`): единичная команда — деталь
 * внутри батча, отдельно через границу не ходит.
 */
export type ActorCommandBatch = readonly ActorCommand[];

// ─────────────────────────────────────────────────────────────────────────────
// Актор.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read-only контекст актора. Реконструируется шимом внутри изолята из конверта события —
 * как 017-`StrategyContext` сегодня. `clock.now()` = `ts` события, `rng` — от seed прогона
 * (CH-5): ambient-времени и неуправляемой случайности у актора нет физически.
 */
export interface ActorContext {
  readonly clock: { now(): number };
  readonly rng: { next(): number };
  readonly orders: { open(): readonly OpenOrderView[] };
  position(): PositionView | null;
}

/**
 * Актор: ОДНА точка входа «событие → команды». Не набор методов на живом объекте — форма
 * продиктована JSON-границей изолята (`event-in → CommandBatch-out`, один маршалинг на событие).
 * Пустой массив — валидный ответ (событие проигнорировано).
 */
export interface StrategyActor {
  onEvent(event: ActorInputEvent, ctx: ActorContext): readonly ActorCommand[];
}

/** Параметры создания экземпляра актора (один экземпляр на символ). */
export interface ActorInit {
  readonly params: Readonly<Record<string, unknown>>;
  readonly seed: number;
  readonly symbol: string;
}

/** Кодовый модуль стратегии формы `event_driven` (аналог `StrategyModule` для `single_position`). */
export interface EventDrivenModule {
  createActor(init: ActorInit): StrategyActor;
}

// ─────────────────────────────────────────────────────────────────────────────
// defineActor — sugar. В SDK, а НЕ в kernel-контракте (урок LEAN: узкое ядро, sugar снаружи).
// ─────────────────────────────────────────────────────────────────────────────

/** Что может вернуть удобный хендлер: батч, одна команда, либо ничего. */
export type ActorHandlerResult = readonly ActorCommand[] | ActorCommand | null | undefined;

/**
 * Удобные хендлеры по видам событий. Все опциональны; `onEvent` — catch-all для видов без
 * своего хендлера (паттерн Nautilus `on_event`). Ни один не объявлен → актор ничего не делает,
 * что валидно (и полезно как заглушка).
 */
export interface ActorHandlers {
  onBar?(event: ActorBarEvent, ctx: ActorContext): ActorHandlerResult;
  onOrderAccepted?(event: ActorOrderAcceptedEvent, ctx: ActorContext): ActorHandlerResult;
  onOrderDenied?(event: ActorOrderDeniedEvent, ctx: ActorContext): ActorHandlerResult;
  onOrderRejected?(event: ActorOrderRejectedEvent, ctx: ActorContext): ActorHandlerResult;
  onOrderCanceled?(event: ActorOrderCanceledEvent, ctx: ActorContext): ActorHandlerResult;
  onOrderExpired?(event: ActorOrderExpiredEvent, ctx: ActorContext): ActorHandlerResult;
  onFill?(event: ActorFillEvent, ctx: ActorContext): ActorHandlerResult;
  onTimer?(event: ActorTimerEvent, ctx: ActorContext): ActorHandlerResult;
  /** Catch-all: получает события, для которых нет специфичного хендлера. */
  onEvent?(event: ActorInputEvent, ctx: ActorContext): ActorHandlerResult;
}

/** Нормализовать ответ хендлера к батчу (единственная точка, где `null`/одиночка расширяются). */
function toBatch(result: ActorHandlerResult): readonly ActorCommand[] {
  if (result === null || result === undefined) return [];
  return Array.isArray(result) ? result : [result as ActorCommand];
}

/**
 * Собрать `StrategyActor` из набора удобных хендлеров: диспетчер по `event.kind` компилируется
 * в единый `onEvent` kernel-контракта. Специфичный хендлер имеет приоритет над catch-all
 * `onEvent`; вид без обоих даёт пустой батч (игнорирование события — не ошибка).
 *
 * Диспетч — явный switch по замкнутому union'у: ни итерации по объекту, ни динамического
 * построения имени метода. Порядок и результат зависят ТОЛЬКО от `event.kind` (требование
 * детерминизма движка E3, п. 5 определения).
 */
export function defineActor(handlers: ActorHandlers): StrategyActor {
  return {
    onEvent(event: ActorInputEvent, ctx: ActorContext): readonly ActorCommand[] {
      switch (event.kind) {
        case 'bar':
          if (handlers.onBar) return toBatch(handlers.onBar(event, ctx));
          break;
        case 'order.accepted':
          if (handlers.onOrderAccepted) return toBatch(handlers.onOrderAccepted(event, ctx));
          break;
        case 'order.denied':
          if (handlers.onOrderDenied) return toBatch(handlers.onOrderDenied(event, ctx));
          break;
        case 'order.rejected':
          if (handlers.onOrderRejected) return toBatch(handlers.onOrderRejected(event, ctx));
          break;
        case 'order.canceled':
          if (handlers.onOrderCanceled) return toBatch(handlers.onOrderCanceled(event, ctx));
          break;
        case 'order.expired':
          if (handlers.onOrderExpired) return toBatch(handlers.onOrderExpired(event, ctx));
          break;
        case 'fill':
          if (handlers.onFill) return toBatch(handlers.onFill(event, ctx));
          break;
        case 'timer':
          if (handlers.onTimer) return toBatch(handlers.onTimer(event, ctx));
          break;
        default: {
          // Замкнутый union: недостижимо, пока каталог и типы согласованы.
          const exhaustive: never = event;
          throw new Error(
            `defineActor: неизвестный вид события "${String((exhaustive as { kind?: unknown }).kind)}"`,
          );
        }
      }
      return handlers.onEvent ? toBatch(handlers.onEvent(event, ctx)) : [];
    },
  };
}
