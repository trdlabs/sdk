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
// - ctx — PULL-модель (Nautilus Cache): к моменту вызова хендлера `ctx.orders()`/`ctx.position()`
//   УЖЕ отражают доставляемое событие (инвариант state-before-handler; НОСИТЕЛЬ инварианта —
//   `ctx`, НЕ конверт события — конверт окон/снапшотов не несёт вовсе, см. блок ActorInputEvent
//   ниже). Сам состав `orders()`/`position()` в `ActorContext` эта задача (S1/2) НЕ вводит —
//   заглушка ждёт задачу 5.

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

/** Идентификатор подписки. Канонический и СТАБИЛЬНЫЙ — не UUID времени запуска. */
export type SubscriptionId = string;

/**
 * Конверт: инварианты (инструмент, `params`, `seed`, дескрипторы подписок) уезжают ОДИН РАЗ каким-
 * то статическим каналом на старте актора, здесь — только переменное. Формулировка спеки §3.1
 * называет этим каналом `ActorInit` — но СЕГОДНЯШНИЙ `ActorInit` (задача 1, ниже в этом файле) это
 * ровно `{ params, seed, symbol }`, дескрипторов подписок не несёт: расходится не текст со
 * спекой, а код со спекой. Расширение `ActorInit` до состава, который называет спека, — задача 5
 * (там же живёт инициализация актора; делать это здесь значило бы размазать одну сущность по двум
 * задачам) — до тех пор это НЕЗАКРЫТЫЙ пункт, а не описка.
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
// вовсе» узнаётся актором ДО первого события каким-то статическим каналом на старте, а НЕ ЭТИМ
// событием (см. doc в шапке `observation-status.ts`, I-5 ревью: сегодняшний `ActorInit` такого
// канала не несёт — фиксируем только необходимость, не конкретный механизм), а «наблюдение
// вернулось» не эмитится своим событием вовсе (см. абзац выше).
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
 * Исполнение (полное либо частичное — различает `last`). Инвариант state-before-handler
 * остаётся в силе НА БУДУЩЕЕ, носитель — `ctx` (см. шапку файла), не это событие: когда задача 5
 * введёт `ctx.orders()`/`ctx.position()`, они будут УЖЕ учитывать этот филл к моменту вызова
 * хендлера. Минимальный `ActorContext` этой задачи (S1/2) обоих методов ещё не содержит.
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

/**
 * Read-only контекст актора — МИНИМАЛЬНАЯ форма на задачи S1/2 и S1/3.
 *
 * Заведена как заглушка ИМЕННО под задачу 5: без неё `StrategyActor`/`ActorHandlers` перестали
 * бы типизироваться после сноса старой формы (`ctx.orders.open()`/`ctx.position()`, реконструкция
 * шимом из конверта события). Состав `orders()`/`position()` здесь НЕ угадывается — pull-модель
 * ctx (composition-following, инвариант state-before-handler) спроектирует задача 5 отдельно.
 * `clock.nowUs()`/`rng.next()` — минимум, без которого не типизируется вообще ничего: без
 * детерминированных часов и RNG хендлер не может быть детерминированным по определению (CH-5).
 * `readiness` (задача 3, требование 6) — единственное поле сверх минимума: без него команда
 * `place` не может быть отклонена ДО прогрева НИГДЕ, кроме как по неявному соглашению хоста, а
 * события при этом обязаны доставляться уже сейчас (см. `ActorReadiness` выше).
 */
export interface ActorContext {
  readonly clock: { nowUs(): TimestampUs };
  readonly rng: { next(): number };
  readonly readiness: ActorReadiness;
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
