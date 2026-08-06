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
//   отражает доставляемое событие (инвариант state-before-handler). Сам состав `orders()`/
//   `position()` в `ActorContext` эта задача (S1/2) НЕ вводит — заглушка ждёт задачу 5.

import type { Bar } from './context.js';
import type {
  FundingReading,
  LiqPoint,
  OiPoint,
  TakerReading,
} from './market-tape.js';
import type { TimeInForce } from './risk-execution.js';
import type { TimestampUs } from './time-us.js';

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
// Конверт события (S1, спека §3.1).
// ─────────────────────────────────────────────────────────────────────────────

/** Внешний порядок событий. Назначает scheduler, не автор. */
export type Seq = number;

/** Идентификатор подписки. Канонический и СТАБИЛЬНЫЙ — не UUID времени запуска. */
export type SubscriptionId = string;

/**
 * Конверт: инварианты (инструмент, `params`, `seed`, дескрипторы подписок) уезжают один раз в
 * `ActorInit`, здесь — только переменное.
 *
 * `eventTsUs` — **frontier диспатча U**, а не время значения. Разница выглядит избыточной,
 * пока `U === T` (v1 всегда так), и вводится сразу по единственной причине: будущая ревизия
 * минуты T, приехавшая во frontier `U > T`, иначе не имеет законного места. Её пришлось бы
 * либо вставлять назад в уже дренированный frontier T (запрещено §3.8.2), либо двигать
 * `clock.now()` назад (запрещено §3.1). Одна координата делает два уже принятых запрета
 * несовместимыми с самой возможностью ревизий.
 */
export interface ActorEnvelope<E> {
  readonly seq: Seq;
  readonly eventTsUs: TimestampUs;
  readonly subscriptionId: SubscriptionId;
  readonly event: E;
}

/**
 * Внутренняя запись scheduler'а. `observedTsUs` живёт ЗДЕСЬ и в run evidence, но НЕ в
 * capability boundary актора.
 *
 * Жёсткость намеренная: «поле видно, но использовать его как часы нельзя» — дисциплинарный
 * запрет, а недоверенная (тем более LLM-написанная) стратегия всё равно примет по нему решение.
 * Прецедент — Ф0 (platform#145, #147), где бизнес-окна специально переводили на data-clock
 * (дефект B1); привязка таймеров ко времени наблюдения воспроизвела бы его, но уже без дешёвого
 * детектора (B1 ловился сравнением `speed=1` и `speed=60`).
 */
export interface ScheduledRecord<E> extends ActorEnvelope<E> {
  readonly observedTsUs: TimestampUs;
}

/**
 * Наблюдённое значение с собственной временной координатой.
 *
 * `effectiveTsUs` — бизнес-минута T, к которой значение относится; `finality` и `revision`
 * ортогональны (§3.11.3): тройка `provisional / final / revised` была ошибкой моделирования,
 * потому что ревизованное значение само либо provisional, либо final.
 *
 * В v1 законна ровно одна комбинация — `final` / `0`; resolver отвергает поток с ревизиями
 * fail-closed. Поля входят в форму сразу, чтобы позднее добавление ревизий не ломало форму
 * события.
 */
export interface ObservedValue<T> {
  readonly effectiveTsUs: TimestampUs;
  readonly value: T;
  readonly finality: 'provisional' | 'final';
  readonly revision: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Сторона заявки — общий тип для команд ниже.
// ─────────────────────────────────────────────────────────────────────────────

// `OpenOrderStatus`/`OpenOrderView`/`PositionView`/`FlatMarketSlice` (017/S1-задача-1 черновик)
// снесены вместе со старой формой `ActorContext`: они существовали ТОЛЬКО как её опора
// (`ctx.orders.open()` / `ctx.position()` / плоский рыночный срез `bar`-события). Задача 5
// проектирует pull-модель ctx заново, начиная с чистого места, — оставлять эти типы висящими
// без потребителя значило бы выдавать черновую форму за уже принятое решение.

/** Сторона заявки. Отдельно от `'long' | 'short'` решений 017: заявка — buy/sell, не позиция. */
export type OrderSide = 'buy' | 'sell';

// ─────────────────────────────────────────────────────────────────────────────
// ActorInputEvent — что хост доставляет актору.
// ─────────────────────────────────────────────────────────────────────────────

// Составного `market.bar.closed` НЕТ (был `ActorBarEvent`, снесён вместе с `closedCandles` и
// `FlatMarketSlice`). У КАЖДОГО `subscriptionId` ровно один binding и один `datasetId` (S1,
// конверт §3.1, `ActorEnvelope`) — составное событие не имеет однозначно ни того ни другого:
// у него по определению нет единственного источника. Источники к тому же приходят в разное
// время (funding — sparse change-point, taker/liq — dense per-minute бакеты, OI — point
// observation) и несут разную семантику значения (уровень vs интервальный агрегат) — склеивать
// их в один JSON-объект означало бы либо ждать самого медленного источника перед эмиссией
// (искусственная задержка), либо слать событие с полями-дырами (какие обязательны?). Пять
// раздельных `kind`, по одному типу значения на каждый, устраняют оба вопроса структурно, а не
// соглашением.
//
// Каждое рыночное событие несёт `subscriptionId` НЕ своим полем, а через `ActorEnvelope`,
// которым его доставляет хост (§3.1) — дублировать идентификатор подписки внутри `event`
// значило бы держать два источника истины для одного и того же ID. Окон (свечей, oi, портфеля,
// позиции) события тоже не несут: актор либо получает значение как поток отдельных наблюдений
// (эта форма), либо как окно через будущий pull-API ctx (задача 5) — конверт события не смешивает
// оба способа доступа.

/** Закрытая (историческая) свеча по своему `subscriptionId`. Значение — `Bar` (017). */
export interface MarketCandleClosedEvent {
  readonly kind: 'market.candle.closed';
  readonly bar: ObservedValue<Bar>;
}

/**
 * Open interest — **point observation**: `oi.value` есть УРОВЕНЬ на момент `oi.effectiveTsUs`,
 * а не приращение с прошлого наблюдения (в отличие от liq/taker-бакетов ниже, которые суммируют
 * события ВНУТРИ интервала).
 */
export interface MarketOpenInterestObservedEvent {
  readonly kind: 'market.open_interest.observed';
  readonly oi: ObservedValue<OiPoint>;
}

/** Ликвидации — **interval aggregate** за закрытый бакет своего `subscriptionId`. */
export interface MarketLiquidationsBucketClosedEvent {
  readonly kind: 'market.liquidations.bucket_closed';
  readonly liq: ObservedValue<LiqPoint>;
}

/** Taker-объём — **interval aggregate** за закрытый минутный бакет своего `subscriptionId`. */
export interface MarketTakerVolumeBucketClosedEvent {
  readonly kind: 'market.taker_volume.bucket_closed';
  readonly taker: ObservedValue<TakerReading>;
}

/**
 * Funding: rate либо settlement — различаются явно через `FundingReading`/`FundingPoint` (030),
 * а не отдельными `kind` этой задачи. Расщепление «периодический rate-тик» vs «settlement-выплата
 * на границе интервала» — по значению `fundingRate`/`ts` в уже существующем типе, не по форме
 * события: заводить здесь новый value-тип означало бы проектировать его заново, а задача просит
 * ровно `FundingReading` из `market-tape.js`.
 */
export interface MarketFundingObservedEvent {
  readonly kind: 'market.funding.observed';
  readonly funding: ObservedValue<FundingReading>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Статус подписки — ОДНО генерическое событие, не `market.<kind>.gap_started` на каждый вид.
// ─────────────────────────────────────────────────────────────────────────────

// Вид уже однозначно определён `subscriptionId` (один binding + один datasetId на подписку,
// §3.1) — per-kind форма (`market.candle.gap_started`, `market.funding.gap_started`, …) множила
// бы замкнутый union на размер каталога рыночных kind'ов и требовала бы bump'а контракта на
// КАЖДЫЙ новый вид данных, хотя переход `observed → gap` значит одно и то же для всех пяти.
//
// Эмитится РОВНО ОДИН РАЗ на самом переходе: повторов на каждый последующий пустой frontier нет
// (иначе актор получал бы шум на каждом тике без наблюдения, а не сигнал об изменении). Возврата
// `gap → observed` как отдельного события НЕТ — само появление следующего рыночного события
// того же `subscriptionId` УЖЕ сигнализирует возврат; симметричное «gap ended» дублировало бы
// информацию, которую поток несёт и так.
//
// Форма статуса — МИНИМАЛЬНАЯ: только `'gap'`. Полный union `ObservationStatus` вводит задача 4;
// здесь его решение не предвосхищается — состав мог бы оказаться другим.
/**
 * Изменение статуса подписки на `'gap'`. `expectedTsUs` — первая ожидаемая, но не пришедшая
 * точка (frontier, на котором обнаружен пропуск), не момент детекции (тот — `eventTsUs`
 * конверта).
 */
export interface MarketSubscriptionStatusChangedEvent {
  readonly kind: 'market.subscription.status_changed';
  readonly status: 'gap';
  readonly expectedTsUs: TimestampUs;
}

// Шов на будущее (НЕ реализовывать здесь): `market.trade` / `market.quote` / `market.book.*`
// добавляются расширением этого замкнутого union'а — bump контракта, но не перепроектирование
// рантайма (диспетчер уже переключает по `kind` через `switch`+`assertNever`, новый `case` —
// локальное изменение). Форм этих событий эта задача не проектирует.

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
  | MarketCandleClosedEvent
  | MarketOpenInterestObservedEvent
  | MarketLiquidationsBucketClosedEvent
  | MarketTakerVolumeBucketClosedEvent
  | MarketFundingObservedEvent
  | MarketSubscriptionStatusChangedEvent
  | ActorOrderAcceptedEvent
  | ActorOrderDeniedEvent
  | ActorOrderRejectedEvent
  | ActorOrderCanceledEvent
  | ActorOrderExpiredEvent
  | ActorFillEvent
  | ActorTimerEvent;

/** Все виды входных событий (для проверок полноты диспетчера). */
export const ACTOR_INPUT_EVENT_KINDS = [
  'market.candle.closed',
  'market.open_interest.observed',
  'market.liquidations.bucket_closed',
  'market.taker_volume.bucket_closed',
  'market.funding.observed',
  'market.subscription.status_changed',
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
 * Read-only контекст актора — МИНИМАЛЬНАЯ форма на эту задачу (S1/задача 2).
 *
 * Заведена как заглушка ИМЕННО под задачу 5: без неё `StrategyActor`/`ActorHandlers` перестали
 * бы типизироваться после сноса старой формы (`ctx.orders.open()`/`ctx.position()`, реконструкция
 * шимом из конверта события). Состав `orders()`/`position()` здесь НЕ угадывается — pull-модель
 * ctx (composition-following, инвариант state-before-handler) спроектирует задача 5 отдельно.
 * `clock.nowUs()`/`rng.next()` — минимум, без которого не типизируется вообще ничего: без
 * детерминированных часов и RNG хендлер не может быть детерминированным по определению (CH-5).
 */
export interface ActorContext {
  readonly clock: { nowUs(): TimestampUs };
  readonly rng: { next(): number };
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
  onMarketCandleClosed?(event: MarketCandleClosedEvent, ctx: ActorContext): ActorHandlerResult;
  onMarketOpenInterestObserved?(
    event: MarketOpenInterestObservedEvent,
    ctx: ActorContext,
  ): ActorHandlerResult;
  onMarketLiquidationsBucketClosed?(
    event: MarketLiquidationsBucketClosedEvent,
    ctx: ActorContext,
  ): ActorHandlerResult;
  onMarketTakerVolumeBucketClosed?(
    event: MarketTakerVolumeBucketClosedEvent,
    ctx: ActorContext,
  ): ActorHandlerResult;
  onMarketFundingObserved?(event: MarketFundingObservedEvent, ctx: ActorContext): ActorHandlerResult;
  onMarketSubscriptionStatusChanged?(
    event: MarketSubscriptionStatusChangedEvent,
    ctx: ActorContext,
  ): ActorHandlerResult;
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
        case 'market.candle.closed':
          if (handlers.onMarketCandleClosed) {
            return toBatch(handlers.onMarketCandleClosed(event, ctx));
          }
          break;
        case 'market.open_interest.observed':
          if (handlers.onMarketOpenInterestObserved) {
            return toBatch(handlers.onMarketOpenInterestObserved(event, ctx));
          }
          break;
        case 'market.liquidations.bucket_closed':
          if (handlers.onMarketLiquidationsBucketClosed) {
            return toBatch(handlers.onMarketLiquidationsBucketClosed(event, ctx));
          }
          break;
        case 'market.taker_volume.bucket_closed':
          if (handlers.onMarketTakerVolumeBucketClosed) {
            return toBatch(handlers.onMarketTakerVolumeBucketClosed(event, ctx));
          }
          break;
        case 'market.funding.observed':
          if (handlers.onMarketFundingObserved) {
            return toBatch(handlers.onMarketFundingObserved(event, ctx));
          }
          break;
        case 'market.subscription.status_changed':
          if (handlers.onMarketSubscriptionStatusChanged) {
            return toBatch(handlers.onMarketSubscriptionStatusChanged(event, ctx));
          }
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
