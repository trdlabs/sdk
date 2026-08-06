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
// - ctx — PULL-модель (Nautilus Cache): к моменту вызова хендлера `ctx.orders.open()`/
//   `ctx.position()` УЖЕ отражают доставляемое событие (инвариант state-before-handler; НОСИТЕЛЬ
//   инварианта — `ctx`, НЕ конверт события — конверт окон/снапшотов не несёт вовсе, см. блок
//   ActorInputEvent ниже). Состав `orders()`/`position()` в `ActorContext` спроектирован задачей 5
//   (S1/5) — форма `PositionView`/`OpenOrderView` там же, `openedAt` позиции ВЫВЕДЕН из execution
//   ledger'а (`actor-state.ts`), а не хранится отдельным полем.

import type { MarketDataKind } from '../contract/constants.js';
import type { Bar } from './context.js';
import type {
  FundingReading,
  LiqPoint,
  OiPoint,
  TakerReading,
} from './market-tape.js';
import type { ObservationStatus } from './observation-status.js';
import type { TimeInForce } from './risk-execution.js';
import type { DurationUs, TimestampUs } from './time-us.js';

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

/**
 * Идентификатор подписки. Канонический и СТАБИЛЬНЫЙ — не UUID времени запуска (задача 5): он
 * входит в merge key порядка событий (§3.8.2), и случайный/временный ID сделал бы порядок
 * обработки НЕвоспроизводимым между прогонами с одним и тем же seed. Полный список разрешённых
 * `SubscriptionId` актор получает ОДИН РАЗ в `ActorInit.subscriptions`
 * (`ActorSubscriptionDescriptor`, ниже у `ActorInit`) — этот тип лишь называет форму значения.
 */
export type SubscriptionId = string;

/**
 * Конверт: инварианты (инструмент, `params`, `seed`, дескрипторы подписок) уезжают ОДИН РАЗ каким-
 * то статическим каналом на старте актора, здесь — только переменное. Спека §3.1 называет этим
 * каналом `ActorInit` — и с задачи 5 это уже НЕ обещание, а код: `ActorInit.subscriptions` несёт
 * закрытый список `ActorSubscriptionDescriptor` (см. ниже, у `ActorInit`), которым актор узнаёт
 * состав своих подписок ДО первого события. `subscriptionId` в `ActorEnvelope` ниже — ссылка на
 * элемент ИМЕННО этого списка, не свободная строка.
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

// `OpenOrderStatus`/`OpenOrderView`/`PositionView`/`FlatMarketSlice` — RELEASED API контракта
// (`@trdlabs/sdk@0.13.0`, `CHANGELOG.md:65`; введены исходным event_driven kernel-контрактом E1,
// коммит `4979fbc` — НЕ задачей 1 этапа S1). Их снос здесь — ЛОМАЮЩЕЕ изменение контракта (план
// 083 S1, Global Constraint: снос экспортов E1 ломающий, а не правка черновика), сделанное
// осознанно. Причина сноса: все четыре существовали ТОЛЬКО как опора формы `ActorContext`,
// сносимой этим же коммитом (`ctx.orders.open()` / `ctx.position()` / плоский рыночный срез
// `bar`-события) — оставлять их без единственного потребителя значило бы держать released API в
// подвешенном состоянии до задачи 5, которая проектирует pull-модель ctx заново и не обязана
// унаследовать именно эту форму. `find_usages` по всем восьми репозиториям экосистемы (см. отчёт
// задачи) подтвердил отсутствие внешних импортов: `OpenOrderStatus`/`OpenOrderView` встречаются
// только здесь; `PositionView` — здесь и в двух СТРУКТУРНО ДРУГИХ одноимённых локальных
// интерфейсах (`backtester`/`lab`, тестовые фикстуры long_oi), не импортированных из
// `@trdlabs/sdk`.
//
// Задача 5 проектирует `OpenOrderView`/`PositionView` ЗАНОВО (см. секцию «Актор» ниже, у
// `ActorContext`) — НЕ восстанавливает снесённые формы под старыми именами. Разница не
// косметическая: новый `PositionView.openedAt` ВЫВЕДЕН из execution ledger'а (`actor-state.ts`),
// а не хранится отдельным полем-флагом, и `unrealizedPnl` в нём НЕТ намеренно (см. doc
// `PositionView`). `OpenOrderStatus` ЗАВЕДЁН заново под старым именем, но с НОВЫМ, более узким
// составом (`'submitted' | 'accepted'` — ревью раунда 1, I-2: жизненный цикл заявки и
// исполненное количество — два ортогональных измерения, схлопывать их в одно нельзя), см. doc
// `OpenOrderView`.

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
  readonly candle: ObservedValue<Bar>;
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
 * Funding: rate либо settlement — ОБА варианта используют это же событие с тем же
 * `FundingReading`. Различение — НЕ по значению `{ts, fundingRate}`: периодический rate-тик и
 * settlement-выплата на границе интервала по этой паре структурно неотличимы. Различение
 * объявляется НА ПОДПИСКЕ (`form: 'rate' | 'settlement'`, задача 3 — здесь не опережается); в v1
 * `settlement` не резолвится вовсе, потому что датасета для него нет. Заводить здесь новый
 * value-тип для funding означало бы проектировать его заново, а задача просит ровно
 * `FundingReading` из `market-tape.js`.
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
// Форма статуса (задача 4, `observation-status.ts`): `MarketSubscriptionStatusChangedEvent`
// переиспользует ГОТОВУЮ gap-ветку полного union'а `ObservationStatus<T>` — не заводит вторую
// параллельную форму (задача 2 ввела МИНИМАЛЬНЫЙ `{status:'gap', expectedTsUs}` намеренно как
// заглушку, зная, что задача 4 расширит его). `Extract` берёт ровно эту ветку структурно, а не по
// соглашению: `never_observed`/`observed` этому событию недоступны СТРУКТУРНО, потому что обе
// причины их отсутствия здесь — не «пока не реализовано», а факт устройства события — «вида нет
// вовсе» узнаётся актором ДО первого события статическим каналом на старте, а НЕ ЭТИМ событием
// (см. doc в шапке `observation-status.ts`; канал — `ActorInit.subscriptions`, задача 5, см. doc
// у `ActorInit` ниже), а «наблюдение вернулось» не эмитится своим событием вовсе (см. абзац выше).
//
// `T = never`, а не `unknown`, в `Extract<ObservationStatus<never>, …>` (M-5 ревью): ЭТО событие
// никогда не несёт `value` (единственное место, где параметр `T` вообще участвовал бы, — ветка
// `observed`, а её сюда и не пропускает сам `Extract`); `never` точнее сигнализирует «этой
// переменной сюда физически нечего положить», тогда как `unknown` читался бы как «положить можно
// что угодно после проверки типа». На результат `Extract` выбор НЕ влияет (gap-ветка на `T`
// вообще не ссылается) — различие чисто документирующее.
/**
 * Изменение статуса подписки на `'gap'`. `status.expectedTsUs` — первая ожидаемая, но не
 * пришедшая точка (frontier, на котором обнаружен пропуск), не момент детекции (тот —
 * `eventTsUs` конверта); причина имени поля (не `sinceUs`) — doc `ObservationStatus`,
 * `observation-status.ts`, задача 4.
 */
export interface MarketSubscriptionStatusChangedEvent {
  readonly kind: 'market.subscription.status_changed';
  readonly status: Extract<ObservationStatus<never>, { readonly state: 'gap' }>;
}

// Шов на будущее (НЕ реализовывать здесь): `market.trade` / `market.quote` / `market.book.*`
// добавляются расширением этого замкнутого union'а — bump контракта, но не перепроектирование
// рантайма (диспетчер уже переключает по `kind` через `switch`+`assertNever`, новый `case` —
// локальное изменение). Форм этих событий эта задача не проектирует.

// `ts` во всех шести событиях ниже — `TimestampUs`, НЕ `number` (было так до раунда правок 1,
// I-7): пять рыночных событий и статус уже µs, а order.*/fill/timer оставались в мс — ровно то
// сосуществование двух единиц, ради защиты от которого §3.2 вводит бранд-типы (забытый `* 1000`
// перестаёт быть исполняемым кодом только когда ВСЯ поверхность актора в одной единице).

/** Заявка принята средой (venue/симулятором). */
export interface ActorOrderAcceptedEvent {
  readonly kind: 'order.accepted';
  readonly ts: TimestampUs;
  readonly clientOrderId: string;
}

/**
 * Заявка отклонена ЛОКАЛЬНО, до среды: RiskEngine (кламп не спас — потолок, rate-limit,
 * price-band, reduce-only в REDUCING). Терминальный. Отличим от `order.rejected` намеренно.
 */
export interface ActorOrderDeniedEvent {
  readonly kind: 'order.denied';
  readonly ts: TimestampUs;
  readonly clientOrderId: string;
  readonly reason: string;
}

/** Заявка отклонена СРЕДОЙ (venue/симулятор). Терминальный. */
export interface ActorOrderRejectedEvent {
  readonly kind: 'order.rejected';
  readonly ts: TimestampUs;
  readonly clientOrderId: string;
  readonly reason: string;
}

/** Заявка отменена (по команде `cancel` либо средой). Терминальный. */
export interface ActorOrderCanceledEvent {
  readonly kind: 'order.canceled';
  readonly ts: TimestampUs;
  readonly clientOrderId: string;
}

/** Заявка истекла по TIF/сроку. Терминальный. */
export interface ActorOrderExpiredEvent {
  readonly kind: 'order.expired';
  readonly ts: TimestampUs;
  readonly clientOrderId: string;
}

/**
 * Исполнение (полное либо частичное — различает `last`). Инвариант state-before-handler в силе:
 * `ctx.orders.open()`/`ctx.position()` (задача 5, см. секцию «Актор» ниже) УЖЕ учитывают этот
 * филл к моменту вызова хендлера, доставившего это событие.
 *
 * Намеренно НЕ несёт `side` — сторона движения принадлежит ЗАЯВКЕ (`clientOrderId`), которую этот
 * филл исполняет, а не самому факту исполнения; хост, ведущий execution ledger (`actor-state.ts`),
 * обязан взять её из заявки (по `clientOrderId`), не гадать по `qty`/`price`. Дублировать `side`
 * здесь значило бы держать его в двух местах с риском разъехаться на отменённой/переиспользованной
 * заявке.
 */
export interface ActorFillEvent {
  readonly kind: 'fill';
  readonly ts: TimestampUs;
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
  readonly ts: TimestampUs;
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

/**
 * Все виды входных событий (для проверок полноты диспетчера).
 *
 * Согласованность с `ActorInputEvent` доказана НА ЭТАПЕ ТИПОВ в обе стороны, а не рукописным
 * совпадением списков (раунд правок 1, I-1 — до этого `ActorInputEventKind` лишь ВЫВОДИЛСЯ из
 * массива, и дрейф «вариант добавили в union, строку в массив забыли» ничем не ловился):
 * - `satisfies readonly ActorInputEvent['kind'][]` — массив НЕ ШИРЕ union'а: строка, не
 *   встречающаяся ни у одного варианта, не пройдёт присваивание;
 * - `_AssertNoUncoveredKind` ниже — union НЕ ШИРЕ массива: вариант, чей `kind` забыли дописать
 *   сюда, не удовлетворяет ограничению `extends never` и ломает сборку.
 * `ActorInputEventKind` по-прежнему ВЫВОДИТСЯ из этого массива (единственный практический
 * источник строк для рантайма, `eventOf`/тестов) — обе проверки страхуют этот вывод, не заменяют.
 */
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
] as const satisfies readonly ActorInputEvent['kind'][];

export type ActorInputEventKind = (typeof ACTOR_INPUT_EVENT_KINDS)[number];

/**
 * Генерик-ограничение (не рантайм-значение): `T extends never` компилируется, только если `T`
 * действительно `never`. Пустой массив-литерал (`const x: T[] = []`) для этой цели не годится —
 * `[]` присваивается ЛЮБОМУ `T[]` независимо от `T`, ничего не проверяя (эмпирически
 * перепроверено при разборе ревью — исходная формулировка ревью на этом ломалась молча).
 */
type AssertNoUncoveredKind<T extends never> = T;

/**
 * Вид `ActorInputEvent['kind']`, забытый в `ACTOR_INPUT_EVENT_KINDS`, ломает сборку прямо здесь:
 * `Exclude<...>` перестаёт быть `never`, и `AssertNoUncoveredKind` отказывается его принять
 * (`TS2344: Type "..." does not satisfy the constraint 'never'`).
 */
type _AssertNoUncoveredKind = AssertNoUncoveredKind<Exclude<ActorInputEvent['kind'], ActorInputEventKind>>;

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

// `atTs`/`afterUs` ниже — `TimestampUs`/`DurationUs`, не `number` (раунд правок 1, I-7 продолжение:
// таймеры — часть поверхности, для которой §3.2 называет µs единственной внутренней единицей,
// наравне с конвертом, scheduler'ом, execution ledger и canonical trace). `afterMs` переименован в
// `afterUs`: имя обязано смениться вместе с единицей — `afterMs: DurationUs` врало бы явно, то
// есть было бы хуже старого поля, а не просто неполной правкой.

/** Таймер на абсолютный business_ts. */
export interface ActorTimerSetAtCommand {
  readonly kind: 'timer.set';
  readonly timerId: string;
  /** Абсолютный business_ts срабатывания (часы данных, не wall-clock). */
  readonly atTs: TimestampUs;
}

/** Таймер через `afterUs` от `ts` обрабатываемого события. */
export interface ActorTimerSetAfterCommand {
  readonly kind: 'timer.set';
  readonly timerId: string;
  /** Смещение от `ts` события, породившего команду. */
  readonly afterUs: DurationUs;
}

/**
 * Поставить таймер: ЛИБО абсолютный `atTs`, ЛИБО относительный `afterUs` — строго одно из двух.
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
// MarketDataRequirement — S1 задача 3: закрытый каталог рыночных данных на пять видов.
// ─────────────────────────────────────────────────────────────────────────────

// Стратегия объявляет СМЫСЛ данных, а не МЕСТО их покупки: `MarketDataRequirement` НЕ несёт поля
// `provider`/`sourceRef` — конкретный источник выбирает host/run plan цепочкой
// `MarketDataRequirement → SubscriptionBinding → ProviderAdapter → канонические market events`
// (задача 3 отвечает только за первое звено; резолвер целиком — host/run-plan сущность, см.
// комментарий у `DeclaredDatasetSplice` ниже). Две оси намеренно разные, не одна в двух видах:
// `kind` — ЗАКРЫТЫЙ каталог, ядро обязано его валидировать fail-closed; `sourceRef` (живёт в
// evidence, НЕ здесь) — ОТКРЫТАЯ строка, ядро обязано её НЕ понимать. Смешать их в одном поле
// значило бы либо молча закрыть открытую ось, либо открыть закрытую — оба варианта нарушают
// инвариант задачи, поэтому в этом файле `sourceRef`/`provider` не появляются вовсе.

/**
 * Минимальная ссылка на инструмент. Состав НЕ угадывается здесь — резолвер (задача 8, host/run
 * plan) спроектирует полный instrument-mapping отдельно; пока хватает пары, однозначно
 * идентифицирующей рынок для `interval`/`lookback` ниже.
 */
export interface InstrumentRef {
  readonly venue: string;
  readonly symbol: string;
}

/**
 * Область агрегации значения. Тип ОСТАЁТСЯ двузначным, чтобы будущее добавление `'venue'` не было
 * ломающим изменением формы — но валидатор в v1 (`validate-module.ts`) ОТВЕРГАЕТ `'venue'`, а не
 * молча не находит данные (`unsupported_market_data_scope`).
 *
 * Решение владельца 2026-08-06, обе причины — СВОЙСТВО АРХИВА, не временный пробел реализации:
 * (1) ликвидационный каскад — явление РЫНОЧНОЕ, а не биржевое, и агрегат по восьми биржам ловит
 * его полнее и раньше любой отдельной книги; стакан этот контракт не моделирует (исполнение —
 * worst-case барными филлами), поэтому отсутствие `'venue'` дырок в модели не создаёт; (2) архив
 * по-источниковых (per-venue) значений НЕ хранит и хранить НЕ будет — это не вопрос приоритета.
 *
 * Названо `MarketDataScope`, а не голым `Scope` — пакет прямо сейчас разгребает коллизию имён
 * вокруг `MarketDataKind` (раунд правок 2, С-3/К-2); бронировать ещё одно предельно общее слово в
 * публичной поверхности значило бы плодить тот же класс проблемы намеренно.
 */
export type MarketDataScope = 'venue' | 'aggregate';

/**
 * Единица измерения значения (open_interest/taker_volume). Общий тип для обоих видов —
 * DRY-страховка: если бы `unit` был отдельным литералом в каждом интерфейсе, набор единиц двух
 * видов мог бы незаметно разъехаться правкой одного и забытым вторым.
 */
export type MarketDataUnit = 'base' | 'quote' | 'usd';

/**
 * Capability-политика ревизий значения (требование 4 задачи 3). В v1 валидатор принимает ТОЛЬКО
 * `{ mode: 'final_only' }` (`unsupported_revision_policy` иначе) — СВОЙСТВО АРХИВА, а не дорожная
 * карта (раунд правок 2, С-1: прежняя формулировка «не реализовано в v1» была ошибкой брифа,
 * владелец поправил прозой — governs проза, инлайн-комментарий кода ей противоречил).
 *
 * Причина буквально: колонок `finality`/`revision` в архиве нет — строка одна на
 * `(minute_ts, symbol)`, второй записи с тем же ключом физически негде лежать. Провизорного
 * случая в данных к тому же не существует вовсе: прогнозная funding rate, наблюдавшаяся в минуту
 * T, — окончательная запись факта «в T провайдер показывал X»; смена прогноза в T+1 — НОВОЕ point
 * observation, а не ревизия T. Поле входит в форму СРАЗУ (не отклоняется вовсе на уровне типа),
 * чтобы появление колонок ревизий не потребовало ломающего добавления поля — симметрично тому, как
 * `ObservedValue.finality`/`revision` уже несёт оба поля в v1.
 */
export type RevisionPolicy =
  | { readonly mode: 'final_only' }
  | { readonly mode: 'provisional_and_revisions' };

/**
 * Общие поля пяти требований ниже. НЕ экспортирован — пять интерфейсов используют его через
 * `extends`; сам он не часть публичной поверхности (раунд правок 2, К-3: прежний отказ от
 * `extends` был основан на неверном предположении, что экспортный интерфейс не может наследовать
 * неэкспортный без поломки `.d.ts` — опровергнуто прогоном `tsc --declaration
 * --emitDeclarationOnly` с флагами `tsconfig.json`, exit 0; TS4020 относится к именам,
 * НЕНАЗЫВАЕМЫМ в `.d.ts`, module-scope интерфейс называем всегда).
 */
interface RequirementBase {
  /** Идентификатор требования ВНУТРИ манифеста (НЕ `SubscriptionId`: тот назначает биндинг при
   *  резолве, задача 8, а не автор манифеста). Валидатор в v1 отвергает пустую строку и дубли
   *  среди требований одного манифеста (`invalid_market_data_requirement` /
   *  `duplicate_market_data_requirement_id`) — `id` единственная ручка связи требования с
   *  binding'ом ниже по цепочке, неоднозначность здесь распространяется дальше. */
  readonly id: string;
  readonly instrument: InstrumentRef;
  /** Гранулярность/период, `DurationUs` (S1 §3.2 — микросекунды, единственная внутренняя единица;
   *  НЕ `number`, чтобы забытый `* 1000` не был исполняемым кодом). Валидатор в v1 отвергает
   *  `interval <= 0` (`invalid_market_data_requirement`) — нулевой или отрицательный период не
   *  описывает никакой реальный поток данных. */
  readonly interval: DurationUs;
  /**
   * Сколько истории проекция ядра ОБЯЗАНА держать, В ЕДИНИЦАХ `interval` — то есть число шагов
   * длиной `interval` назад от текущего момента, а не µs и не абстрактных «баров». Валидатор в v1
   * отвергает нецелое или отрицательное значение (`invalid_market_data_requirement`): тот же файл
   * заводит бранд-типы специально ради того, чтобы забытая единица не была исполняемым кодом, и
   * голый `number` без названной единицы был бы той же двусмысленностью.
   */
  readonly lookback: number;
  /**
   * Capability-политика ревизий (см. `RevisionPolicy`). ОПЦИОНАЛЬНО: отсутствие равносильно
   * `{ mode: 'final_only' }` — единственному законному значению в v1 (раунд правок 2, м-8).
   * Обязательное поле с одним легальным значением заставляло бы каждый манифест — включая
   * написанные LLM — нести шаблонный блок без единой степени свободы; гарантия та же, шума меньше.
   */
  readonly revisionPolicy?: RevisionPolicy;
}

/** Закрытые (исторические) свечи. Единственный ценовой ряд — `priceType` замкнут на `'trade'`. */
export interface CandlesMarketDataRequirement extends RequirementBase {
  readonly kind: 'candles';
  readonly priceType: 'trade';
}

/** Open interest — point observation (см. `MarketOpenInterestObservedEvent`, задача 2). */
export interface OpenInterestMarketDataRequirement extends RequirementBase {
  readonly kind: 'open_interest';
  readonly scope: MarketDataScope;
  readonly unit: MarketDataUnit;
}

/** Ликвидации — interval aggregate за закрытый бакет (см. `MarketLiquidationsBucketClosedEvent`). */
export interface LiquidationsMarketDataRequirement extends RequirementBase {
  readonly kind: 'liquidations';
  readonly scope: MarketDataScope;
}

/** Taker-объём — interval aggregate (см. `MarketTakerVolumeBucketClosedEvent`). */
export interface TakerVolumeMarketDataRequirement extends RequirementBase {
  readonly kind: 'taker_volume';
  readonly scope: MarketDataScope;
  readonly unit: MarketDataUnit;
}

/**
 * Funding: `form` различает periodic rate-тик от settlement-выплаты (см. doc `MarketFundingObservedEvent`
 * — на уровне СОБЫТИЯ они структурно неотличимы, различение живёт на ПОДПИСКЕ, то есть здесь).
 *
 * `form: 'settlement'` в v1 НЕ РЕЗОЛВИТСЯ (`unsupported_funding_form`) — СВОЙСТВО АРХИВА: колонки
 * settlement в архиве физически нет. Как только появится колонка, `form: 'settlement'`
 * резолвится без изменения формы этого типа.
 */
export interface FundingMarketDataRequirement extends RequirementBase {
  readonly kind: 'funding';
  readonly scope: MarketDataScope;
  readonly form: 'rate' | 'settlement';
}

/** Замкнутый union требований к рыночным данным формы `event_driven` (закрытый каталог, требование 1). */
export type MarketDataRequirement =
  | CandlesMarketDataRequirement
  | OpenInterestMarketDataRequirement
  | LiquidationsMarketDataRequirement
  | TakerVolumeMarketDataRequirement
  | FundingMarketDataRequirement;

/**
 * Двусторонняя типовая гарантия «`MarketDataKind` ⇔ `MarketDataRequirement['kind']`» — та же
 * идиома, что `ACTOR_INPUT_EVENT_KINDS`/`ActorInputEvent` выше (раунд правок 1, I-1), но ЦЕЛИКОМ
 * на типах: `MarketDataKind` импортирован как `import type` (см. шапку файла) — ни здесь, ни где-
 * либо в файле нет рантайм-значения `MARKET_DATA_KINDS` (раунд правок 2, м-3: прежняя форма с
 * `satisfies` на самом массиве создавала лишний рантайм-импорт `research-contract → contract` в
 * публикуемом `dist` ради проверки, которая целиком решается на этапе типов — стёрлась бы вместе
 * со всем остальным `import type`).
 */
type _AssertMarketDataKindCoveredByUnion = AssertNoUncoveredKind<
  Exclude<MarketDataKind, MarketDataRequirement['kind']>
>;

/**
 * Обратное направление: вариант `MarketDataRequirement`, чей `kind` забыли дописать в
 * `MARKET_DATA_KINDS` (`contract/constants.ts`), не удовлетворяет `extends never` и ломает сборку
 * здесь (TS2344).
 */
type _AssertNoUncoveredMarketDataKind = AssertNoUncoveredKind<
  Exclude<MarketDataRequirement['kind'], MarketDataKind>
>;

/**
 * Явное declared-склеивание истории поперёк границы `datasetId` (требование 5 задачи 3). Прогон
 * НЕ МОЖЕТ молча пересечь границу: агрегат из восьми бирж и агрегат внешнего провайдера — РАЗНЫЕ
 * величины, а не одна с разной точностью; окно на 90 дней через такой переход дало бы результат,
 * которого нет ни на одном источнике по отдельности.
 *
 * Форма ЗДЕСЬ фиксирует только ЧТО можно объявить (два `datasetId` + момент перехода) и повод для
 * кода отказа `dataset_boundary_violation` (`research-contract/validation.ts`), которым размечается
 * НЕобъявленный переход. Саму проверку — что запрошенное окно действительно не пересекает
 * необъявленную границу — исполняет run plan (host-сущность), НЕ `sdk` (требование 8 ниже:
 * резолвер целиком вне `sdk`).
 */
export interface DeclaredDatasetSplice {
  readonly fromDatasetId: string;
  readonly toDatasetId: string;
  /** Момент перехода: точки строго ДО этого ts принадлежат `fromDatasetId`, начиная с него — `toDatasetId`. */
  readonly boundaryTsUs: TimestampUs;
  /** Почему склейка обоснована (например: миграция провайдера, замена источника на равноценный). */
  readonly rationale: string;
}

// Требование к резолверу (задача 8; host/run-plan сущность — здесь только ЗАПИСАНО, НЕ
// реализовано, поэтому ниже НЕ JSDoc: этот абзац не документирует ни один экспортируемый тип).
// Резолвер обязан быть fail-closed ПО ВСЕМ семантически значимым измерениям: `kind`, `scope`,
// `unit`, instrument mapping, interval/granularity, finality/revision policy, coverage.
// Агрегированный OI и venue-OI различаются не только смыслом, но и ПОРЯДКОМ ВЕЛИЧИНЫ; неявное
// агрегирование, конверсия единиц или подмена venue ↔ aggregate допустимы ТОЛЬКО как отдельный
// версионированный transform с НОВЫМ `datasetId` — никогда как молчаливая подстановка внутри
// резолва одного и того же требования. Сам резолвер (`MarketDataRequirement →
// SubscriptionBinding → ProviderAdapter`) — host/run-plan сущность; в `sdk` его нет и не будет.

/**
 * Готовность актора к ТОРГОВЫМ правам (требование 6 задачи 3). До `'ready'` хост ОБЯЗАН отклонять
 * команды `place` — но события всё равно доставляются, чтобы проекции и авторское состояние
 * успевали построиться К моменту готовности (иначе первый торгующий бар был бы недетерминирован:
 * его решение зависело бы от того, сколько истории актор случайно успел увидеть). Реализация
 * прогрева — S2; здесь только ФОРМА, которую видит актор через `ActorContext.readiness`.
 */
export type ActorReadiness = 'warming_up' | 'ready';

/**
 * Источник прогрева актора ДО первого торгового бара (требование 6 задачи 3). Выбор фиксируется
 * В КОНТРАКТЕ, а НЕ на деплое: от него зависит, что именно актор успеет увидеть до готовности —
 * то есть детерминизм первого торгующего бара. Реализации прогрева здесь НЕТ (S2); тип фиксирует
 * только сам выбор.
 *
 * - `tape_replay` — прогрев реплеем исторической ленты: актор строит проекции/состояние из уже
 *   прошедших событий так, как если бы они доставлялись в реальном времени.
 * - `kernel_prefetch` — прогрев префетчем ядра: движок материализует нужное окно истории и
 *   передаёт готовое состояние без пере-проигрывания событий через `onEvent`.
 */
export type ActorWarmupSource = { readonly kind: 'tape_replay' } | { readonly kind: 'kernel_prefetch' };

// ─────────────────────────────────────────────────────────────────────────────
// Актор.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Авторский state-слот (требование 1) — plain-data, проверяется РАНТАЙМОМ, не только типом.
// ─────────────────────────────────────────────────────────────────────────────

// Почему нужен рантайм-валидатор, а не только тип. Слот — собственное состояние актора МЕЖДУ
// вызовами `onEvent` (например: скользящие суммы, счётчики, ручные индикаторы, которые автору
// проще держать сам, чем пересчитывать из истории на каждый вызов). Состояние ОБЯЗАНО пережить
// чекпойнт и восстановление изолята (сбой хоста, миграция, холодный рестарт после простоя) — то
// есть обязано пройти через JSON туда и обратно байт-в-байт. Замыкание (функция, захватившая
// внешние переменные) сериализуется в `{}` или бросает при `JSON.stringify` — тип TS `unknown`/
// generic-параметр НЕ может отличить «этот объект переживёт сериализацию» от «этот объект выглядит
// как данные, но внутри держит функцию» на этапе компиляции: сериализуемость — рантайм-свойство
// КОНКРЕТНОГО значения, а не структурное свойство его статического типа. Отсюда — `isPlainActorState`
// ниже: единственный способ поймать «это не переживёт границу» ДО того, как оно её попытается
// пересечь.
//
// Точка крепления в контракте (ревью раунда 1, I-3: до этой правки тип/валидатор существовали САМИ
// ПО СЕБЕ, ни на что не надетые) — `StrategyActor.snapshotState`/`ActorInit.state` ниже, пара
// «снять/вернуть при чекпойнте». Тип и валидатор объявлены ИМЕННО здесь, а не в `actor-state.ts`
// (где были раньше): оба места, где `ActorStateValue` реально используется как тип поля
// (`StrategyActor`, `ActorInit`), живут в ЭТОМ файле — перенос в сосед потребовал бы обратного
// импорта оттуда сюда и замкнул бы кольцо (`actor-state.ts` и так импортирует ОТСЮДА `OrderSide`/
// `PositionView`, см. doc `actor-state.ts`).

/**
 * Значение, законное в авторском state-слоте актора. Рекурсивный plain-data union — ровно то
 * подмножество JS-значений, что `JSON.parse(JSON.stringify(x))` восстанавливает БЕЗ потерь и без
 * молчаливых искажений (в отличие, например, от объекта с ключом `undefined`-значения, который
 * `JSON.stringify` тихо роняет, или от `Date`, который превращается в строку и теряет тип).
 *
 * Явно ЗАКРЫТ на верхнем уровне: `null`/`boolean`/`string`/конечное `number`/массив/plain-объект.
 * `NaN`/`Infinity` не входят (типовое ограничение `number` их не исключает, но `isPlainActorState`
 * отклоняет их рантаймом — та же дисциплина, что `isTimestampUs`/`isDurationUs` в `time-us.ts`:
 * тип называет НАМЕРЕНИЕ, рантайм-предикат его проверяет на недоверенном значении).
 *
 * **Своя форма состояния (`StrategyActor<S>`/`ActorInit<S>`) — `type`-псевдоним, НЕ `interface`**
 * (Minor, ревью раунда 3, I-3.2): `type MyState = { readonly counter: number }` удовлетворяет
 * `S extends ActorStateValue` без ничего лишнего, а структурно ИДЕНТИЧНЫЙ `interface MyState {
 * readonly counter: number }` — НЕТ (`TS2344: Index signature for type 'string' is missing`,
 * известное расхождение TS: object-type-псевдонимам компилятор выводит неявную индексную сигнатуру
 * в позиции generic-ограничения, именованным `interface` — нет, они номинальны). Если `interface`
 * необходим (например, чтобы состояние расширяли другие `interface`), добавьте индексную сигнатуру
 * явно: `interface MyState { readonly [key: string]: ActorStateValue; readonly counter: number }`
 * — но учтите цену: индексная сигнатура делает форму ОТКРЫТОЙ (`{counter: 1, anythingElse: 2}`
 * тоже пройдёт структурную проверку `S`), тогда как `type`-псевдоним без нужды в ней остаётся
 * ЗАКРЫТЫМ (лишний ключ на объекте, ЛИТЕРАЛЬНО присвоенном переменной этого типа, поймает excess-
 * property check). Естественная авторская форма (`interface` без индексной сигнатуры) падает с
 * TS2344 без объяснения причины в тексте ошибки — теперь она объяснена здесь.
 */
export type ActorStateValue =
  | null
  | boolean
  | string
  | number
  | readonly ActorStateValue[]
  | { readonly [key: string]: ActorStateValue };

/**
 * «Чистота» собственных ключей ОБЪЕКТА (не массива — см. `hasOnlyPlainArrayKeys` ниже, у массива
 * есть законный неперечислимый `length`). Отвергает символьный ключ, неперечислимый ключ, accessor
 * (get/set) — `Object.values`/`Object.keys` перечисляют ТОЛЬКО собственные ПЕРЕЧИСЛИМЫЕ СТРОКОВЫЕ
 * ключи и потому МОЛЧА пропускают все три (ревью раунда 1, I-4, прогон: функция под символьным
 * ключом и неперечислимое свойство-функция обе принимались бы прежней версией). `Reflect.ownKeys`
 * перечисляет буквально ВСЁ — единственный способ увидеть то, что `Object.values` прячет.
 */
function hasOnlyPlainOwnKeys(obj: object): boolean {
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === 'symbol') return false;
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (descriptor === undefined || !descriptor.enumerable) return false;
    if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
  }
  return true;
}

/**
 * «Чистота» собственных ключей МАССИВА: РОВНО канонические индексы `0..length-1` строками плюс
 * встроенный неперечислимый `length` — и ничего сверх. Ловит оба array-специфичных пробела I-4
 * ревью: sparse-дыру (`[1, , 3]` — `Reflect.ownKeys` не перечисляет ОТСУТСТВУЮЩИЙ индекс 1, значит
 * `keys.length !== arr.length + 1`; `JSON.stringify` превращает дыру в `null` — значение до/после
 * границы уже не одно и то же) и добавленное нечисловое свойство (`arr.extra = fn` — по умолчанию
 * ПЕРЕЧИСЛИМО, но `.every()` по индексам его никогда не увидит, раз оно не индекс).
 */
function hasOnlyPlainArrayKeys(arr: readonly unknown[]): boolean {
  const keys = Reflect.ownKeys(arr);
  if (keys.length !== arr.length + 1) return false; // +1 — встроенный `length`.
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key === 'symbol') return false;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= arr.length) return false;
    const descriptor = Object.getOwnPropertyDescriptor(arr, key);
    if (descriptor === undefined || !descriptor.enumerable) return false;
    if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
  }
  return true;
}

/**
 * Практический потолок глубины вложенности (ревью раунда 2, новый дефект: недоверенный ГЛУБОКИЙ
 * вход валил функцию, документированную КАК ГЕЙТ недоверенного JSON, необработанным
 * `RangeError: Maximum call stack size exceeded` на глубине ~5000 — сигнатура обещает `value is
 * ActorStateValue`, а не крах, и `RangeError` того же конструктора, что намеренно бросает
 * `derivePositionView` (`actor-state.ts`), неотличим вызывающим от НЕЙ). `500` — на порядок больше
 * любой реалистичной глубины авторского состояния (счётчики/скользящие окна/индикаторы — считанные
 * уровни вложенности, не тысячи) и безопасно ниже предела стека V8 для этой функции.
 */
const MAX_ACTOR_STATE_DEPTH = 500;

/**
 * Рекурсивный обход с отслеживанием ТЕКУЩЕГО ПУТИ предков (не всех когда-либо посещённых узлов):
 * `ancestors` — ОДИН изменяемый `Set`, пополняемый ПЕРЕД рекурсией в потомков и очищаемый ПОСЛЕ
 * (`finally`, backtracking в буквальном смысле — O(1) на узел) — так отличается настоящий ЦИКЛ
 * (узел ссылается сам на себя через цепочку потомков) от легитимного ДИАМАНТА (два разных поля
 * указывают на ОДИН И ТОТ ЖЕ вложенный объект, но не по кругу: JSON это прекрасно сериализует,
 * просто теряя разделяемую идентичность, что для plain-data не является пороком).
 *
 * ИСПРАВЛЕНО (ревью раунда 2, новый дефект): предыдущая версия КОПИРОВАЛА `ancestors` (`new
 * Set(ancestors)`) НА КАЖДОМ узле — доc уже тогда называла это «backtracking», но копия целого
 * множества размера O(глубина) на каждом из O(глубина) узлов линейной цепочки даёт O(глубина²), не
 * O(глубина): прогон — глубина 1000 стоила 45.4 мс. Здесь — РОВНО то, что описывает доc: одно
 * множество, `add` перед рекурсией, `delete` в `finally` после (сохраняет корректность на
 * диамантах — тот же узел, встреченный ПОВТОРНО НЕ по кругу, к моменту повторной встречи уже
 * удалён из `ancestors`, потому что первая ветвь успела вернуться).
 *
 * `confirmed` — ВТОРОЕ множество, ГЛОБАЛЬНОЕ на весь вызов `isPlainActorState` (НЕ backtracking,
 * никогда не уменьшается) — memo объектов, для которых обход УЖЕ доказал «весь их поддерево —
 * plain-data, без цикла» (ревью раунда 3, новый Important: `finally`-очистка `ancestors` даёт
 * верный O(глубина) на ПОСЕЩЕНИЕ, но число посещений не ограничено числом узлов на DAG'е —
 * разделяемый ПОДГРАФ (не только лист) обходится заново по КАЖДОМУ пути к нему, `2^глубина` при
 * ветвлении; прогон ревью — 23 разделяемых объекта дали 4.1 с). Соответствует РЕАЛЬНОЙ угрозе:
 * `snapshotState()` возвращает внутрипроцессный объект (не результат `JSON.parse`, тот ВСЕГДА
 * дерево), который волен разделять ссылки свободно — гейт, охраняющий именно ЭТУ границу, обязан
 * быть безопасен и на DAG, не только на дереве.
 *
 * Мемоизация СОХРАНЯЕТ корректность обнаружения циклов: объект добавляется в `confirmed` ТОЛЬКО
 * ПОСЛЕ того, как его СОБСТВЕННОЕ поддерево полностью пройдено и не породило `false` — то есть
 * только когда в его поддереве СТРУКТУРНО нет цикла НИ С ОДНИМ узлом (совпадение объекта в
 * `confirmed` с текущим `ancestors` невозможно: попадание в `confirmed` происходит ПОСЛЕ выхода
 * из `try`, когда `obj` уже удалён из `ancestors` в `finally`). Ложноположительных «plain-data»
 * из-за memo быть не может: единственное, что мемоизируется, — уже доказанный факт про САМ объект,
 * не зависящий от того, ОТКУДА к нему пришли повторно. Ложноотрицательные (мемо `false`) НЕ
 * делаются намеренно: `false` мог произойти из-за `ancestors.has(obj)` — факта, специфичного для
 * ТЕКУЩЕГО пути, а не для объекта вообще; тот же объект с ДРУГОГО пути мог бы оказаться валиден.
 */
function isPlainDataValue(value: unknown, ancestors: Set<object>, confirmed: Set<object>, depth: number): boolean {
  if (depth > MAX_ACTOR_STATE_DEPTH) return false; // fail-closed, не падение стека — см. doc выше.
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  // `-0` отклонён явно (Minor, ревью раунда 2): `JSON.stringify(-0) === '0'`, `JSON.parse('0') ===
  // 0` (положительный) — `-0` НЕ переживает границу JSON байт-в-байт, хотя `Number.isFinite(-0)`
  // истинно. Та же дисциплина, что `deepValueEquals` в `observation-status.ts` уже применяет к
  // сравнению (`0` и `-0` — РАЗНЫЕ значения через `Object.is`), только здесь — не сравнение двух
  // значений, а гарантия «переживёт JSON» одного значения. Готча (Minor, ревью раунда 3, одна
  // строка доки, как и просили): `-0` получается ОБЫЧНОЙ арифметикой, не только литералом —
  // `0 * -1`, `-1 * 0`, `0 / -1` все дают `-0`; счётчик автора, дошедший до такого выражения,
  // отклоняется здесь ЦЕЛИКОМ при следующем чекпойнте, если его не нормализовать (`x + 0` перед
  // снятием состояния превращает `-0` обратно в `+0`).
  if (t === 'number') return Number.isFinite(value as number) && !Object.is(value, -0);
  // function/symbol/bigint/undefined — НЕ plain-data. `undefined` внутри структуры (не как
  // отсутствующий ключ, а как явное значение) тоже отклонён: `JSON.stringify` роняет такие ключи
  // молча, то есть значение до/после границы JSON — уже не одно и то же значение.
  if (t !== 'object') return false;

  const obj = value as object;
  if (confirmed.has(obj)) return true; // уже доказано целиком — см. doc выше.
  if (ancestors.has(obj)) return false; // настоящий цикл — см. doc выше.
  ancestors.add(obj);
  let ok: boolean;
  try {
    if (Array.isArray(obj)) {
      ok = hasOnlyPlainArrayKeys(obj) && obj.every((item) => isPlainDataValue(item, ancestors, confirmed, depth + 1));
    } else {
      // Экзотические объекты (Date/Map/Set/RegExp/класс-инстанс) отклонены: их прототип — не
      // Object.prototype и не null (`Object.create(null)` — легитимный plain-объект без прототипа,
      // тоже должен проходить). Белый список: вместо перечисления запрещённых конструкторов
      // (который расширяющийся JS никогда не даст исчерпать) проверяется РОВНО принадлежность к
      // двум разрешённым формам прототипа.
      const proto = Object.getPrototypeOf(obj);
      ok =
        (proto === Object.prototype || proto === null) &&
        hasOnlyPlainOwnKeys(obj) &&
        Object.values(obj as Record<string, unknown>).every((v) => isPlainDataValue(v, ancestors, confirmed, depth + 1));
    }
  } finally {
    // ОБЯЗАН выполниться на ВСЕХ путях выхода (включая ранние `return false` выше в блоке) — иначе
    // соседняя ветвь (диамант, не потомок) видит `obj` как предка и ложно отклоняет легитимную
    // разделяемую ссылку.
    ancestors.delete(obj);
  }
  if (ok) confirmed.add(obj); // мемо ТОЛЬКО положительного исхода — см. doc выше, почему.
  return ok;
}

/**
 * Рантайм-проверка формы авторского state-слота (требование 1). Отвергает: функции (прямые,
 * замыкания, под символьным или неперечислимым ключом), accessor-свойства, циклические ссылки,
 * `symbol`/`bigint`/`undefined`-в-структуре, `NaN`/`Infinity`/`-0`, экзотические объекты
 * (`Date`/`Map`/`Set`/класс-инстанс), sparse-массивы, добавленные нечисловые свойства массива,
 * вложенность глубже `MAX_ACTOR_STATE_DEPTH` (fail-closed `false`, не исключение). Принимает
 * вложенную структуру из `null`/`boolean`/`string`/конечных `number`/плотных массивов/plain-
 * объектов до предельной глубины, ДЕРЕВОМ либо DAG'ом — разделяемая (не циклическая) ссылка
 * учитывается ОДИН раз через memo (`confirmed`, ревью раунда 3), а не переисследуется по каждому
 * пути к ней: стоимость — O(число различных достижимых объектов), а не экспоненциальная от
 * ветвления путей.
 */
export function isPlainActorState(value: unknown): value is ActorStateValue {
  return isPlainDataValue(value, new Set(), new Set(), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Открытые заявки — `ctx.orders.open()`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Стадия жизненного цикла ОТКРЫТОЙ заявки — измерение, ОРТОГОНАЛЬНОЕ количеству (ревью раунда 1,
 * I-2: «нет второго источника истины» неверно применялось к ЭТОМУ полю — `filledQty` ниже отвечает
 * «сколько исполнено», `status` отвечает «на какой стадии сама заявка», и оба факта не выводятся
 * друг из друга: `filledQty === 0` не отличает «ещё не подтверждена венью» от «подтверждена, но
 * исполнения не было» — прогон ревью получил побайтово идентичные объекты для обеих стадий на
 * прежней форме без статуса).
 *
 * Замкнут на ДВУХ значениях: `'triggered'`/`'not triggered'` для `stop_market` сюда НЕ входит — у
 * контракта пока нет события `order.triggered` (`ActorInputEvent`, замкнутый union), и заводить
 * статус, который неоткуда корректно заполнить, значило бы завести поле без источника истины для
 * НЕГО САМОГО. Расширение этого каталога вместе с событием `order.triggered` — задача 6 (§3.10).
 */
export type OpenOrderStatus = 'submitted' | 'accepted';

/**
 * Общие поля трёх вариантов `OpenOrderView` ниже — НЕ экспортирован, тот же приём, что
 * `RequirementBase` у `MarketDataRequirement` выше (неэкспортный интерфейс, используемый только
 * через `extends`, называем в `.d.ts` штатно).
 */
interface OpenOrderViewBase {
  readonly clientOrderId: string;
  readonly side: OrderSide;
  readonly status: OpenOrderStatus;
  /** Запрошенный нотионал в USD, ДО клампа риском (см. `ActorPlaceCommand.qtyUsd`) — своя единица,
   *  НЕ смешивается с `qty`/`filledQty` ниже (ревью раунда 1, C-3). */
  readonly qtyUsd: number;
  /**
   * Размер, ПРИНЯТЫЙ риском, В БАЗОВОЙ ВАЛЮТЕ инструмента — та же единица и та же величина, что
   * `PositionView.qty`/`ExecutionLedgerFillEntry.qty` (`actor-state.ts`). Остаток заявки —
   * `qty - filledQty`, ОБЕ части одной единицы. Без этого поля остаток был НЕВЫЧИСЛИМ: `qtyUsd`
   * (запрос ДО клампа, USD) и `filledQty` (исполнение, базовая валюта) — разные измерения, вычесть
   * одно из другого бессмысленно (ревью раунда 1, C-3, прогон: заявка на 100 USD исполнена целиком
   * — 0.002 BTC при цене 50 000 — предикат «частично» без `qty` неотличим от «исполнена целиком»).
   */
  readonly qty: number;
  /** Исполненная часть, ТА ЖЕ единица что `qty` выше. `0 < filledQty < qty` ⇔ частичное исполнение. */
  readonly filledQty: number;
  readonly reduceOnly?: boolean;
  /** Как заявка была подана — см. `ActorPlaceCommand.tif` (ревью раунда 2, Minor: `createdTs`
   *  восстановлен доводом «управлять живой заявкой»; тот же довод относится к `tif` ровно так же
   *  — актор не может решить, стоит ли отменять/ждать заявку, не зная её условия исполнения). */
  readonly tif?: TimeInForce;
  /** Момент, когда хост впервые узнал об этой заявке (ревью раунда 1, M-2: без времени управление
   *  по возрасту заявки невозможно — снос в исходном черновике был недосмотром, не решением). */
  readonly createdTs: TimestampUs;
}

/** Рыночная открытая заявка: цены не несёт (см. `ActorPlaceMarketCommand`). */
export interface OpenMarketOrderView extends OpenOrderViewBase {
  readonly type: 'market';
}

/** Лимитная открытая заявка: `price` обязателен (см. `ActorPlaceLimitCommand`). */
export interface OpenLimitOrderView extends OpenOrderViewBase {
  readonly type: 'limit';
  readonly price: number;
}

/** Стоп-маркет открытая заявка: `stopPrice` обязателен (см. `ActorPlaceStopMarketCommand`). */
export interface OpenStopMarketOrderView extends OpenOrderViewBase {
  readonly type: 'stop_market';
  readonly stopPrice: number;
}

/**
 * Одна открытая (нетерминальная) заявка актора — `ctx.orders.open()`. Разложена НА ТИП ЗАЯВКИ,
 * СИММЕТРИЧНО `ActorPlaceCommand` выше (ревью раунда 1, I-7): плоские `price?`/`stopPrice?` на
 * одном интерфейсе типизировали бы `{type:'limit'}` без `price` и `{type:'market', stopPrice:1}` —
 * тот же класс двусмысленности, ради недопущения которого `ActorPlaceCommand` уже разложен на три
 * варианта (doc там же: «неоднозначная команда должна отваливаться на схеме, а не доезжать до
 * движка»); вид, ЧИТАЮЩИЙ заявки, не обязан быть слабее вида, которым их ПОДАЮТ.
 */
export type OpenOrderView = OpenMarketOrderView | OpenLimitOrderView | OpenStopMarketOrderView;

// ─────────────────────────────────────────────────────────────────────────────
// PositionView — снимок текущей позиции, `ctx.position()`.
// ─────────────────────────────────────────────────────────────────────────────

// Бранд-символ НЕ экспортирован (та же идиома, что `TIMESTAMP_US`/`DURATION_US`, `time-us.ts`):
// значения не существует в рантайме (`declare const`), поэтому объектный литерал БЕЗ прохода через
// `derivePositionView` (`actor-state.ts`) никогда не удовлетворит этот тип — TS откажет на
// отсутствующем свойстве. Заведён ПОСЛЕ ревью раунда 1 (C-2): прогон без единого `as` собрал
// `ctx.position()`, разошедшийся с `ledger`/`ctx.orders.open()` — «главная цель задачи не
// достигнута» до этой правки, ничто в типах не обязывало `position()` быть результатом
// `derivePositionView`.
//
// ГАРАНТИЯ ОДНОСТОРОННЯЯ — записано явно после ревью раунда 2 (C-2, ВОСПРОИЗВЕДЕНО ПОВТОРНО
// против собранного пакета: прежняя формулировка «произвести его может ТОЛЬКО derivePositionView»
// была заявкой сильнее, чем гарантирует механизм). Модель угрозы, которую бренд закрывает, — ХОСТ,
// ЗАБЫВШИЙ вывести вид из журнала: собрать `PositionView` из собственной бухгалтерии «с нуля»
// (объектный литерал, `satisfies`, structural widening, `Object.assign({}, flat)`) НЕВОЗМОЖНО —
// каждый путь требует значения бранд-поля, а взять его неоткуда (`POSITION_VIEW_BRAND` не
// экспортирован и не существует в рантайме). Это закрыто и подтверждено прогоном (все четыре пути
// не компилируются).
//
// Модель угрозы, которую бренд НЕ закрывает и закрыть НЕ может выбранным механизмом (intersection-
// бренд), — ПРЕДНАМЕРЕННАЯ подделка ИЗ УЖЕ ПОЛУЧЕННОГО настоящего экземпляра: `derivePositionView`
// — публичный экспорт, поэтому `{ ...derivePositionView(ledger)!, qty: 1_000_000 }` типизируется
// как `PositionView` без единого `as` — spread копирует ВСЕ поля исходного объекта, включая
// бранд-поле, и TS не различает «бранд-поле присутствует, потому что объект настоящий» от «бранд-
// поле присутствует, потому что его скопировали». Подмена этим путём требует уже ИМЕТЬ настоящий
// экземпляр — то есть деривация уже произошла; бренд ловит забывчивость («не вызвал
// derivePositionView вовсе»), а не умысел («вызвал, а потом подделал возвращённое значение»).
// Остаточный риск реален и называется явно, а не умалчивается: любой TS nominal-бренд на основе
// intersection уязвим ровно так же — закрыть его можно только рантайм-непрозрачным носителем
// (например, `WeakSet` с проверкой на чтении), что для read-only снимка данных, пересекающего
// JSON-подобную границу движка (S2), было бы избыточным усложнением ради угрозы вне модели («хост
// добросовестно реализует ctx, но злонамеренно портит уже полученные значения» — не тот класс
// дефекта, которым была подтверждена находка C-1 раунда 1; там хост НЕ ВЫВОДИЛ вид из журнала
// вовсе, что бренд и ловит).
//
// Тот же остаток названия (Minor, ревью раунда 3): `const p: PositionView = JSON.parse(str)`
// ТОЖЕ компилируется без единого `as` и без настоящего экземпляра вообще — но не потому, что бренд
// слаб, а потому, что `JSON.parse` возвращает `any`, а `any` по определению обходит ЛЮБУЮ
// структурную проверку TS, брендированную или нет (то же самое верно для ЛЮБОГО другого типа в
// пакете, не только `PositionView`). Это НЕ третий путь обхода бренда — это ОБЩАЯ граница TS
// (`any`/`unknown` от недоверенного источника), та же самая, ради которой существует
// `isExecutionLedgerEntry`/`isPlainActorState`: хост, читающий `PositionView`-подобную структуру
// из строки/сети, обязан ПРОВЕРИТЬ её рантаймом (в этом пакете такого гейта для `PositionView`
// целиком нет — только для `ExecutionLedger`, из которого `PositionView` ВЫВОДИТСЯ; отдельного
// runtime-валидатора формы `PositionView` не заведено, потому что единственный легитимный источник
// `PositionView` в системе — сам `derivePositionView`, а не десериализация чужого JSON).
declare const POSITION_VIEW_BRAND: unique symbol;

/**
 * Снимок ТЕКУЩЕЙ позиции актора — то, что видит `ctx.position()` (`undefined`, если позиции нет,
 * то есть актор flat). Спроектирован ЗАНОВО этой задачей (см. doc выше у `OrderSide` про снос
 * released `PositionView`), не является правкой снесённой формы.
 *
 * `openedAt` — момент фактического открытия ТЕКУЩЕЙ позиции. ВЫВЕДЕН из execution ledger'а
 * (`derivePositionView`, `actor-state.ts`) сверткой по филлам, а НЕ хранится отдельным полем,
 * которое кто-то обязан не забыть проставить/сбросить: если позиция ФЛИПНУЛА через ноль (сделка
 * противоположной стороны крупнее остатка), `openedAt` — момент ИМЕННО флип-филла (новое
 * открытие), а не момент исходного открытия до флипа. Старый released `PositionSnapshot` не нёс
 * ни `openedAt`, ни признаков частичного выхода, хотя хост их держал где-то ещё — этот тип закрывает
 * ровно эту дыру (задача 5, требование 3 брифа). Гарантия «выведен, а не задан» — на уровне ТИПОВ
 * (бранд выше), не только доки: см. `derivePositionView`.
 *
 * `unrealizedPnl` ОТСУТСТВУЕТ НАМЕРЕННО — не пробел, а решение (требование 3 брифа, не тащить его
 * обратно). Он — производная от ТЕКУЩЕЙ рыночной цены, а цена в актор-модели приходит СОБЫТИЕМ
 * (`MarketCandleClosedEvent` и т.п.), не постоянно доступна ctx как значение вне обработки такого
 * события. Поле в снимке позиции завело бы ВТОРОЙ источник истины для той же величины — снимок,
 * прочитанный между двумя ценовыми событиями, либо был бы протухшим, либо требовал бы скрытого
 * пересчёта хостом на КАЖДОЕ чтение `ctx.position()`, то есть тайно тянул бы за собой рыночную
 * цену как незадекларированную зависимость. Актору, которому нужен unrealizedPnl, ничто не мешает
 * посчитать его самому из `avgEntryPrice` и последней увиденной цены — единственного места, где
 * эта величина не лжёт по построению.
 */
export type PositionView = {
  readonly side: 'long' | 'short';
  /** Остаток позиции в базовой валюте инструмента. Всегда положителен — знак несёт `side`. */
  readonly qty: number;
  /**
   * Средневзвешенная цена входа ТЕКУЩЕЙ позиции (эры, начавшейся в `openedAt`). Выходы (полные и
   * частичные) её не меняют — только добавления В ТУ ЖЕ сторону; после флипа через ноль
   * пересчитывается заново от цены флип-филла (см. `openedAt` выше и `derivePositionView`).
   */
  readonly avgEntryPrice: number;
  readonly openedAt: TimestampUs;
} & { readonly [POSITION_VIEW_BRAND]: 'derivePositionView' };

/**
 * Read-only контекст актора — pull-модель (Nautilus Cache), задача 5.
 *
 * Инвариант **state-before-handler**: к МОМЕНТУ вызова хендлера, которому доставлено какое-то
 * событие, `orders.open()`/`position()` УЖЕ отражают ЭТО событие — филл, зачисленный конвертом
 * `fill`, виден в `position()` того же самого вызова `onEvent`, а не со следующего. Актор поэтому
 * никогда не «опаздывает» на своё собственное состояние ровно на один тик — читать `ctx` внутри
 * хендлера и читать его же сразу после (гипотетически) должны давать один и тот же ответ.
 *
 * Состав: `clock.nowUs()`/`rng.next()` — минимум, без которого хендлер не может быть
 * детерминированным по определению (CH-5, задачи S1/2). `readiness` (задача 3, требование 6) —
 * без него `place` не может быть отклонена ДО прогрева нигде, кроме неявного соглашения хоста.
 * `orders`/`position` (задача 5, требование 2) — доступ к открытым заявкам и к позиции; ОБЕ формы
 * (`OpenOrderView`/`PositionView`, выше) читаются как СНИМОК на момент вызова, не как живая ссылка
 * — мутировать их нельзя, дальнейшее состояние актор получает только СЛЕДУЮЩИМ вызовом `onEvent`.
 *
 * `orders.open`/`position` — readonly-ПОЛЯ функционального типа, НЕ method-синтаксис (ревью раунда
 * 1, M-5: method-синтаксис в интерфейсе НЕ несёт `readonly`, то есть формально переприсваиваем —
 * `ctx.position = () => fake` типизировался бы, в отличие от соседних `clock`/`rng`/`readiness`).
 */
export interface ActorContext {
  readonly clock: { nowUs(): TimestampUs };
  readonly rng: { next(): number };
  readonly readiness: ActorReadiness;
  readonly orders: { readonly open: () => readonly OpenOrderView[] };
  readonly position: () => PositionView | undefined;
}

/**
 * Актор: ОДНА точка входа «событие → команды». Не набор методов на живом объекте — форма
 * продиктована JSON-границей изолята (`event-in → CommandBatch-out`, один маршалинг на событие).
 * Пустой массив — валидный ответ (событие проигнорировано).
 *
 * `snapshotState` (ревью раунда 1, I-3) — ВТОРАЯ, необязательная точка входа, парная
 * `ActorInit<S>.state` ниже: хост вызывает её МЕЖДУ вызовами `onEvent` (после обработки события,
 * перед возможным чекпойнтом изолята) и обязан персистить ПОСЛЕДНЕЕ снятое значение — то самое,
 * что вернётся актору через `ActorInit<S>.state` при следующем восстановлении. Опциональность
 * симметрична: актор без собственного состояния между вызовами её не объявляет. ЭТА функция сама
 * рантайм-проверку не делает — `isPlainActorState` (выше) обязанность ХОСТА на границе персиста,
 * симметрично тому, как `derivePositionView`/`isExecutionLedgerEntry` (`actor-state.ts`) проверяют
 * СВОЮ границу.
 *
 * Дженерик `S` (ревью раунда 2, I-3, пункт 2) — снятое и восстановленное состояние были ДВУМЯ
 * НЕЗАВИСИМЫМИ полями одного и того же широкого `ActorStateValue`: «снял `{ticks, sma}`, вернули
 * голой строкой» компилировалось и исполнялось, каждый автор был вынужден писать `init.state as
 * MyState` — приведение РОВНО на той JSON-границе, которой пакет не доверяет больше нигде (для
 * ledger'а есть `isExecutionLedgerEntry`, для авторского состояния приведения не было ничем
 * прикрыто). `S extends ActorStateValue = ActorStateValue` связывает `snapshotState(): S` здесь и
 * `ActorInit<S>.state?: S` в одном типовом параметре — автор, параметризовавший `StrategyActor<
 * MyState>`, получает несовпадение форм КАК ОШИБКУ КОМПИЛЯЦИИ, а не риск времени исполнения. Дефолт
 * `ActorStateValue` держит НЕпараметризованное использование (как раньше) валидным без изменений.
 *
 * `snapshotState` ОБЯЗАТЕЛЕН, когда `S` параметризован КОНКРЕТНЫМ типом уже НЕПОСРЕДСТВЕННО на
 * этом уровне — не только опечаткой доки, а типовым УСЛОВИЕМ (ревью раунда 3, I-3.3: раунд 2
 * объявил дважды-опциональность «границей слоя, не решаемой типами» — ревьюер построил и
 * скомпилировал контрпример, суждение было неверным именно ПОТОМУ, что дженерик уже введён).
 * `ActorStateValue extends S` истинно ТОЛЬКО когда `S` — сам НЕпараметризованный дефолт
 * (`ActorStateValue` не ýже никакого своего собственного сужения, кроме себя самого) — тогда
 * `snapshotState` остаётся `?`, как раньше. Для ЛЮБОГО конкретного сужения (`StrategyActor<Sma>`)
 * `ActorStateValue extends S` ложно, и ветвь становится `{ snapshotState(): S }` — ОБЯЗАТЕЛЬНЫМ.
 * Автор, объявивший ТИП своего состояния, но не реализовавший его снятие, теперь получает ошибку
 * СБОРКИ там, где раньше получал молчаливую потерю на каждом чекпойнте (см. также
 * `ActorHandlers<S>`/`defineActor`, куда то же условие продолжено, чтобы `defineActor<Sma>({...})`
 * без `snapshotState` тоже не собиралось).
 *
 * Выбор дефолта — `S extends ActorStateValue = ActorStateValue` (не `S = never` с обратным
 * условием, «нельзя объявить snapshotState без явного `<S>`»): ревьюер проверил и такой вариант —
 * строже (закрывает СИММЕТРИЧНУЮ дыру «объявил снятие без параметризации типа»), но ценой back-
 * compat формы «просто передать `snapshotState`, не выписывая `defineActor<MyState>(...)`
 * отдельно» — вывод `S` из формы `snapshotState` при НЕуказанном явном типовом аргументе менее
 * надёжен, чем явная параметризация, и для пакета, часть авторов которого — LLM (см. `brief.ts`,
 * `market-tape.ts` doc про недоверенный/LLM-написанный код), лишний источник запутывающих ошибок
 * вывода типа — худший компромисс, чем сохранённая, уже проверенная (раунд 2) полная обратная
 * совместимость. Оставшаяся дыра («хост объявил и снял состояние, но не вернул его при следующем
 * `createActor`») — РАНТАЙМОВАЯ, не типовая, её ЭТА конструкция не касается (см. `ActorInit.state`).
 */
export type StrategyActor<S extends ActorStateValue = ActorStateValue> = {
  onEvent(event: ActorInputEvent, ctx: ActorContext): readonly ActorCommand[];
} & (ActorStateValue extends S ? { snapshotState?(): S } : { snapshotState(): S });

/**
 * Разрешённый дескриптор ОДНОЙ подписки актора — элемент `ActorInit.subscriptions` (задача 5,
 * требование 1a, передано из задачи 4). Статический канал, которым актор узнаёт СОСТАВ своих
 * подписок ДО первого события: этим он отличается от `MarketSubscriptionStatusChangedEvent`
 * (`'gap'`) — тот сигнализирует ДИНАМИЧЕСКОЕ «наблюдения нет в ЭТОМ frontier» уже ПОСЛЕ старта, а
 * этот дескриптор — статический факт «вид вообще присутствует в прогоне», известный заранее (см.
 * doc в шапке `observation-status.ts`, уровень 1 «данных нет»). Без поля в `ActorInit` эти два
 * состояния были бы неразличимы для актора — оба выглядели бы как «событий этого вида не было».
 *
 * `subscriptionId` — КАНОНИЧЕСКИЙ и СТАБИЛЬНЫЙ (см. doc у `SubscriptionId` выше), назначается
 * резолвером на этапе биндинга (задача 8), НЕ порождается ad hoc при старте изолята: он участвует
 * в merge key порядка событий (§3.8.2), и случайный/временный ID сделал бы порядок обработки
 * НЕвоспроизводимым между прогонами с одним и тем же `seed` — тот же класс требования, ради
 * которого `ActorInit` несёт детерминированный `seed`, а не полагается на источник энтропии рантайма.
 */
export interface ActorSubscriptionDescriptor {
  readonly subscriptionId: SubscriptionId;
  readonly kind: MarketDataRequirement['kind'];
  /**
   * Требование каталога (`MarketDataRequirement.id`), по которому эта подписка разрешена —
   * ручка, которой актор может связать входящее событие с ИСХОДНЫМ манифестным требованием, не
   * догадываясь об этом по совпадению `kind`/`instrument` (при нескольких требованиях одного
   * `kind` на разные инструменты/интервалы совпадение по `kind` одному неоднозначно).
   */
  readonly requirementId: MarketDataRequirement['id'];
}

/**
 * Дубли `subscriptionId` внутри одного `ActorInit.subscriptions` — ТИПОМ не исключены (массив из
 * одинаковых записей типизируется без ошибки; ревью раунда 1, M-4). Резолвер (задача 8/S2) обязан
 * гарантировать уникальность fail-closed при сборке `ActorInit` — эта функция даёт готовую,
 * переиспользуемую проверку той же дисциплины, что уже применена к `MarketDataRequirement.id`
 * (`duplicate_market_data_requirement_id`, `src/validation`), но НЕ встроена в `validate()`:
 * `ActorInit` — не JSON-граница недоверенного манифеста, а параметр вызова `createActor` от
 * host/engine, у которого нет отдельного submit-time прохода валидации, куда это можно включить.
 */
export function findDuplicateSubscriptionIds(
  subscriptions: readonly ActorSubscriptionDescriptor[],
): readonly SubscriptionId[] {
  const seen = new Set<SubscriptionId>();
  const duplicates = new Set<SubscriptionId>();
  for (const descriptor of subscriptions) {
    if (seen.has(descriptor.subscriptionId)) duplicates.add(descriptor.subscriptionId);
    seen.add(descriptor.subscriptionId);
  }
  return [...duplicates];
}

/**
 * Параметры создания экземпляра актора (один экземпляр на символ).
 *
 * `subscriptions` (задача 5, требование 1a) — ЗАКРЫТЫЙ список разрешённых подписок, уезжающий
 * актору ОДИН РАЗ вместе с остальными инвариантами (`params`/`seed`/`symbol`), а не узнаваемый по
 * ходу прогона из потока событий. До этой задачи `ActorInit` был РОВНО `{ params, seed, symbol }`
 * — доc-комментарии в трёх местах файла (`ActorEnvelope`, `MarketSubscriptionStatusChangedEvent`,
 * `observation-status.ts`) утверждали состав подписок как «будущий канал»; с этой задачи канал
 * настоящий, и все три места поправлены на ссылку сюда.
 *
 * `state` (ревью раунда 1, I-3) — восстановленное авторское состояние, парная точка
 * `StrategyActor<S>.snapshotState` выше (ОДИН и тот же `S`, ревью раунда 2, I-3 пункт 2 — см. doc
 * там): `undefined` — ПЕРВЫЙ запуск актора (снимать ещё нечего); иначе — ПОСЛЕДНЕЕ значение,
 * снятое `snapshotState` перед чекпойнтом, которое хост обязан вернуть байт-в-байт (после прохода
 * через `isPlainActorState` на своей стороне).
 *
 * **Остаточный риск (ревью раунда 2, I-3 пункт 3) — назван явно, не решён на этом слое.** Все
 * четыре комбинации присутствия типизируются: `snapshotState` объявлен + `state` пришёл (штатный
 * цикл), `snapshotState` объявлен + `state` НЕ пришёл (тихий рестарт с нуля — хост забыл
 * персистить/передать), `snapshotState` НЕ объявлен + `state` пришёл (хост передал состояние
 * актору, которому неоткуда его принять — тихая недостижимость), `snapshotState` НЕ объявлен +
 * `state` не пришёл (штатный stateless-цикл). ДВЕ из четырёх — потеря данных, и НИ ТИП, НИ
 * РАНТАЙМ этого слоя её не ловят — в отличие от `derivePositionView` (`actor-state.ts`), который
 * БРОСАЕТ на недоверенном ledger'е. Причина асимметрии структурная, не недосмотр: `derivePositionView`
 * — ЧИСТАЯ функция над данными, которые ей передали В ЭТОМ ЖЕ вызове, и может проверить их на
 * месте; «хост забыл вызвать `snapshotState` между вызовами `onEvent`» и «хост забыл передать
 * `state` при следующем `createActor`» — факты о ПОВЕДЕНИИ ДВИЖКА ВО ВРЕМЕНИ, а не о форме
 * значения в руках у функции — `sdk` (S1, только формы) в принципе не может проверить то, что
 * ещё не произошло и происходит не внутри вызова, который он контролирует. Закрыть это может
 * ТОЛЬКО S2 (`@trdlabs/engine`): например, детектировать «actor.snapshotState существует, но
 * между двумя чекпойнтами не вызывался» рантайм-инвариантом движка. Здесь — явное имя риска, не
 * умолчание (та же дисциплина, что применена к C-2 этого же раунда).
 */
export interface ActorInit<S extends ActorStateValue = ActorStateValue> {
  readonly params: Readonly<Record<string, unknown>>;
  readonly seed: number;
  readonly symbol: string;
  readonly subscriptions: readonly ActorSubscriptionDescriptor[];
  readonly state?: S;
}

/** Кодовый модуль стратегии формы `event_driven` (аналог `StrategyModule` для `single_position`). */
export interface EventDrivenModule<S extends ActorStateValue = ActorStateValue> {
  createActor(init: ActorInit<S>): StrategyActor<S>;
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
 *
 * `snapshotState` (ревью раунда 2, I-3, пункт 1, Important): без этого поля `defineActor` не имел
 * НИ ОДНОГО способа произвести `StrategyActor` с `snapshotState` — прогон ревью подтвердил
 * `Reflect.ownKeys(actor) === ['onEvent']` ПРИ ЛЮБЫХ переданных хендлерах, то есть собственный
 * рекомендуемый сахар SDK был единственным путём, на котором авторское состояние молча умирает на
 * каждом чекпойнте, без ошибки компиляции и без сигнала в рантайме — ровно та форма отказа, против
 * которой написан нормативный блок `actor-state.ts` про `tp1Done`-подобные флаги (механизм
 * расширили в `StrategyActor`/`ActorInit`, бухгалтерию сахара вокруг него — нет).
 */
export type ActorHandlers<S extends ActorStateValue = ActorStateValue> = {
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
} & (ActorStateValue extends S
  ? {
      /** Снять авторское состояние — см. doc `StrategyActor.snapshotState`. Опционально: стейтлес-
       *  актор его не объявляет, и `defineActor` тогда НЕ добавляет `snapshotState` в возвращаемый
       *  объект. ОБЯЗАТЕЛЬНО, когда `defineActor` параметризован конкретным `S` (ревью раунда 3,
       *  I-3.3) — то же условие, что у `StrategyActor<S>`, продолженное сюда, чтобы
       *  `defineActor<Sma>({...})` без `snapshotState` тоже не собиралось. */
      snapshotState?(): S;
    }
  : { snapshotState(): S });

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
 *
 * `snapshotState` присутствует на возвращённом акторе ⟺ `handlers.snapshotState` был передан
 * (ревью раунда 2, I-3, пункт 1) — `Reflect.ownKeys` возвращаемого объекта либо `['onEvent']`,
 * либо `['onEvent', 'snapshotState']`, СИММЕТРИЧНО тому, что автор фактически объявил, а не
 * `['onEvent']` всегда: до этой правки `defineActor` не мог произвести `snapshotState` вовсе.
 *
 * `as StrategyActor<S>` на обоих `return` ниже — ЕДИНСТВЕННЫЙ каст функции: `StrategyActor<S>`
 * (ревью раунда 3, I-3.3) — условный тип (`ActorStateValue extends S ? … : …`), а условные типы,
 * зависящие от ЕЩЁ НЕ РАЗРЕШЁННОГО дженерик-параметра, TS не «раскрывает» ВНУТРИ тела дженерик-
 * функции (известное ограничение проверки типов, не специфика этого файла) — снаружи, на стороне
 * ВЫЗЫВАЮЩЕГО (где `S` уже конкретен), проверка условной ветки работает штатно и ловит несовпадение
 * (см. тесты). Рантайм-ветвление `if (handlers.snapshotState)` — правильное И полное покрытие обеих
 * ветвей типа; каст только называет то, что код уже гарантирует, компилятору, который не может
 * этого вывести сам на этом конкретном шаге.
 */
export function defineActor<S extends ActorStateValue = ActorStateValue>(
  handlers: ActorHandlers<S>,
): StrategyActor<S> {
  const onEvent = (event: ActorInputEvent, ctx: ActorContext): readonly ActorCommand[] => {
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
  };

  // `() => handlers.snapshotState!()` — НЕ `const f = handlers.snapshotState; () => f()` (ревью
  // раунда 3, новый Important): извлечение метода в отдельную переменную теряет `this` — все
  // остальные хендлеры зовутся как `handlers.onX(...)` (this = handlers), а вырванный
  // `snapshotState` звался бы «голым», `this === undefined` в строгом режиме. Каноническая форма
  // актора с состоянием (`{ count: 0, onFill() { this.count += 1 }, snapshotState() { return
  // {count: this.count} } }`) типизировалась и падала `TypeError` РОВНО на той функции, ради
  // починки которой заведён весь I-3.1. Вызов через `handlers.snapshotState!()` — свойство,
  // немедленно вызванное — сохраняет `this = handlers`, как у всех остальных вызовов в этом файле.
  if (handlers.snapshotState) {
    return { onEvent, snapshotState: () => handlers.snapshotState!() } as StrategyActor<S>;
  }
  return { onEvent } as StrategyActor<S>;
}
