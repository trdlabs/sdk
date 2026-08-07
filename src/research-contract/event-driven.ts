// 083 E1 — kernel-контракт формы `event_driven`: стратегия как stateful-актор над order-flow.
//
// Эскиз и обоснование: platform `specs/083-event-driven-runtime-spike/research.md` §3 D1;
// нормативная форма — спека control-center `docs/superpowers/specs/
// 2026-08-04-event-driven-actor-contract-design.md` §3.
//
// **Состояние эпика — НЕ «ранний старт за триггером возврата»** (ревью владельца на PR sdk#34:
// шапка ссылалась на снятый триггер). Исходный E1 действительно приехал под early-start exception
// карточки `shared-execution-engine` (раздел Ф6, 2026-07-23), когда E2–E7 стояли за триггером
// возврата эпика, и был опубликован как `@trdlabs/sdk@0.13.0`. **Триггер снят решением владельца
// 2026-08-06 и распространён на Ф6** (cc#297, довод «сначала движок» к Ф6 применим сильнее, потому
// что Ф6 и есть движок): Ф6 разблокирована целиком, а ЭТОТ файл переписан этапом S1 той же
// декомпозиции. Вместе с триггером устарела и оговорка «изменение ЧИСТО АДДИТИВНОЕ»: S1 переписал
// surface формы `event_driven` ЦЕЛИКОМ и снёс released-экспорты (см. doc
// `EVENT_DRIVEN_MIN_CONTRACT_VERSION` ниже и блок у `OrderSide`). Аддитивным осталось ровно одно —
// форма `single_position` не тронута, манифест без поля `lifecycle` валиден как был.
//
// E2–E7 (граница изолята, движок, RiskEngine, event-spine) — не «за триггером», а следующие этапы
// той же декомпозиции: S2 (`@trdlabs/engine` — диспетчер, бюджеты, прогрев), S3 (`backtester`),
// S5 (`platform` — host-watchdog и проводка `TradingState`). Здесь по-прежнему только СЛОВАРЬ:
// рантаймов этот пакет не трогает.
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
import type { ObservationStatus } from './observation-status.js';
import {
  MAX_PLAIN_DATA_DEPTH,
  hasOnlyPlainArrayKeys,
  hasOnlyPlainOwnKeys,
  isPlainObjectPrototype,
} from './plain-data.js';
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
 * Версия контракта, ВВОДЯЩАЯ ПЕРЕПИСАННЫЙ surface актора: форма `lifecycle: 'event_driven'`
 * КОНКРЕТНО (не сам факт поля `lifecycle` — см. `LIFECYCLE_FIELD_MIN_CONTRACT_VERSION` ниже, это
 * ДРУГОЙ, более ранний порог), хук `onEvent`, `marketData`, `warmup`.
 *
 * Манифест, объявляющий этот surface под более ранней версией, отклоняется
 * (`unsupported_contract_version`): иначе bump был бы чисто декларативным — `contractVersion`
 * перестал бы говорить, какой конверт манифеста автор объявил, и версия потеряла бы способность
 * что-либо ограждать.
 *
 * **083 S1 задача 6: `017.3` → `017.4`.** Исходный E1 (released в `@trdlabs/sdk@0.13.0` под
 * `017.3`) обещал СОВСЕМ ДРУГОЙ surface формы `event_driven`, чем существует в пакете сейчас —
 * мс-таймстемпы вместо µs-бранд-типов, составной `ActorBarEvent` вместо пяти раздельных рыночных
 * событий, released `OpenOrderView`/`PositionView`/`FlatMarketSlice`, которых больше нет (см. doc
 * у `OrderSide` ниже). Задачи 1–5 этапа S1 переписали этот surface ЦЕЛИКОМ, не расширили его
 * аддитивно — значит держать гейт на `017.3` означало бы признавать манифесты, написанные ПРОТИВ
 * формы, которой в пакете больше нет физически. Не бамп-как-формальность: манифест, объявляющий
 * `lifecycle: 'event_driven'` (или `onEvent`/`marketData`/`warmup`) под `017.3`, теперь
 * отклоняется РОВНО ТАК ЖЕ, как раньше отклонялся под `017.1`/`017.2`, — `017.3` больше не
 * покрывает этот surface, несмотря на то что когда-то его вводила.
 *
 * **Задача 6, ревью раунда 1, I-1 (Important, исправлено).** До этой правки один и тот же порог
 * ошибочно применялся к самому факту наличия поля `lifecycle` — то есть `lifecycle:
 * 'single_position'`, объявленный ЯВНО (эквивалент дефолта, SC-008), тоже требовал бы `017.4`,
 * хотя эта форма НИЧЕМ не тронута задачами 1–5. Доказано сборкой на двух коммитах: один и тот же
 * манифест был `accepted` на базе задачи 5 и `rejected` после первой версии задачи 6. Причина —
 * структурная: константа схлопывала ДВА разных порога («поле `lifecycle` существует», введено
 * `017.3`, и «surface `event_driven` переписан», `017.4`) в один. Разведены обратно —
 * `validateSurfaceContractVersion` (`validate-module.ts`) теперь гейтит `lifecycle ===
 * 'event_driven'` этой константой, а голое присутствие поля (любое значение, включая
 * `single_position`) — отдельной, более ранней `LIFECYCLE_FIELD_MIN_CONTRACT_VERSION`.
 */
export const EVENT_DRIVEN_MIN_CONTRACT_VERSION = '017.4' as const;

/**
 * Версия контракта, ВВОДЯЩАЯ само ПОЛЕ `lifecycle` в конверте манифеста (083 E1, `0.13.0`) —
 * исходный E1-словарь целиком, независимо от значения поля. Задачи 1–5 этапа S1 её НЕ трогали:
 * `single_position` (явный или дефолтный) остаётся ровно той же формой, что была под `017.3` в
 * момент релиза `0.13.0`, — переписан только surface формы `event_driven`
 * (`EVENT_DRIVEN_MIN_CONTRACT_VERSION` выше, `017.4`).
 *
 * Отдельная константа от `EVENT_DRIVEN_MIN_CONTRACT_VERSION` (задача 6, ревью раунда 1, I-1) —
 * см. doc там же за полным обоснованием разведения. Манифест, объявляющий поле `lifecycle`
 * (ЛЮБОЕ значение, в том числе `single_position`) под `017.1`/`017.2`, отклоняется: тем версиям
 * это поле было физически неизвестно.
 */
export const LIFECYCLE_FIELD_MIN_CONTRACT_VERSION = '017.3' as const;

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

// ─────────────────────────────────────────────────────────────────────────────
// Значения рыночных событий — µs-чистые формы БЕЗ собственной метки времени.
// ─────────────────────────────────────────────────────────────────────────────

// **Одна временная координата на событие — `ObservedValue.effectiveTsUs`, и никакой другой**
// (финальная волна ревью ветки, Б-1). До этой правки пять рыночных событий несли ЛЕГАСИ-типы
// значений из `market-tape.ts`/`context.ts` (`Bar`, `OiPoint`, `LiqPoint`, `TakerPoint`,
// `FundingPoint`), у каждого из которых СВОЙ `ts: number` в МИЛЛИСЕКУНДАХ. На одном объекте
// события оказывались две метки одного и того же момента в РАЗНЫХ единицах: `candle.effectiveTsUs`
// (µs, бранд) и `candle.value.ts` (мс, голый `number`). Проверено прогоном: `event.candle.value.ts
// - ctx.clock.nowUs()` КОМПИЛИРУЕТСЯ — бранд ловит присваивание, но не арифметику; схема принимала
// событие, где обе метки не связаны ничем. Это делало ложными сразу две заявки: критерий этапа «в
// актор-поверхности не осталось ни одного поля в миллисекундах» и строку CHANGELOG про «every
// actor-surface timestamp moves to the branded µs types».
//
// Лечение — УБРАТЬ избыточную координату, а не приколотить её вторым бранд-полем: метка времени
// значения ДУБЛИРУЕТ `effectiveTsUs` конверта, и две координаты одного момента и есть дефект.
// Отсюда пять форм ниже: ровно поля-величины легаси-типов МИНУС их `ts`.
//
// Легаси-типы НЕ ТРОНУТЫ и трогать их нельзя: `Bar` — источник правды формы свечи 017 для формы
// `single_position` (`StrategyContext.bar`, `PointInTimeDataApi.closedCandles`), `OiPoint`/
// `LiqPoint`/`TakerPoint`/`FundingPoint` — для `PointInTimeMarketApi` (023/030). Там `ts: number`
// в мс — часть released-контракта, у которого свои потребители и своя единица; событийная
// поверхность актора просто перестала их переиспользовать.

/**
 * Значение свечного события — `Bar` (017) БЕЗ собственного `ts`: момент закрытой свечи несёт
 * `ObservedValue.effectiveTsUs` конверта. Отдельный тип, а НЕ `Omit<Bar, 'ts'>`: `Omit` привязал бы
 * событийную форму к легаси-типу, который живёт своей жизнью (добавление поля в `Bar` для нужд
 * `single_position` молча расширило бы актор-поверхность), и такая связь читалась бы как обещание
 * совместимости, которого нет.
 */
export interface CandleValue {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Объём закрытой свечи, `≥ 0`. */
  readonly volume: number;
}

/**
 * Open interest — **point observation**: значение есть УРОВЕНЬ на момент `oi.effectiveTsUs`, а не
 * приращение с прошлого наблюдения (в отличие от liq/taker-бакетов ниже, которые суммируют события
 * ВНУТРИ интервала).
 */
export interface OpenInterestValue {
  /** Сырой OI notional в USD, `≥ 0` (маппинг канонической строки 010: `oi_total_usd`). */
  readonly oiTotalUsd: number;
}

/**
 * Ликвидации за закрытый бакет — **interval aggregate**. Покрытый бакет без единого каскада несёт
 * `{ longUsd: 0, shortUsd: 0 }` — НАСТОЯЩЕЕ наблюдение со значением ноль, не «данных не было» (см.
 * уровень 3 в шапке `observation-status.ts`).
 */
export interface LiquidationsValue {
  readonly longUsd: number; // ≥ 0
  readonly shortUsd: number; // ≥ 0
}

/**
 * Taker-объём за закрытый бакет — **interval aggregate**. Как и у ликвидаций, `{0, 0}` — валидное
 * present-наблюдение. delta (`buyUsd − sellUsd`) и кумулятивный CVD — derive-only, в контракте их
 * нет: производная величина, посчитанная хостом, была бы вторым источником истины для той же пары.
 */
export interface TakerVolumeValue {
  readonly buyUsd: number; // ≥ 0
  readonly sellUsd: number; // ≥ 0
}

/**
 * Funding: rate либо settlement — ОБА варианта используют это же событие с этим же значением.
 * Различение — НЕ по величине: периодический rate-тик и settlement-выплата на границе интервала
 * структурно неотличимы одним числом. Различение объявляется НА ПОДПИСКЕ (`form: 'rate' |
 * 'settlement'`, `FundingMarketDataRequirement` ниже); в v1 `settlement` не резолвится вовсе,
 * потому что колонки для него нет в архиве.
 */
export interface FundingValue {
  /** Aggregated 8h-equiv ставка (027). `0` и отрицательная — валидные наблюдения, не отсутствие. */
  readonly fundingRate: number;
}

// **Событие несёт ТОЛЬКО present-содержимое** (финальная волна ревью ветки, Б-2). До этой правки
// taker/funding несли трёхсостоянийные `TakerReading`/`FundingReading` (`present|stale|missing`)
// ВНУТРИ `ObservedValue` — и проверено по отгружаемой схеме, что
// `market.taker_volume.bucket_closed` со `value: {state:'missing'}` был ВАЛИДНЫМ событием. Словарь
// тем самым допускал самопротиворечивое высказывание: «наблюдено (observed, final, revision 0),
// что бакет закрыт; значение — бакета не было». Плюс пять событий были несогласованы между собой:
// oi/liq несли голые точки, taker/funding — ридинги, свеча — `Bar`.
//
// Отсутствие наблюдения выражается ЕДИНСТВЕННЫМ каналом — `market.subscription.status_changed`
// (§3.11.2, ветка `'gap'` полного `ObservationStatus`), а «вида нет в прогоне вовсе» — статическим
// `ActorInit.subscriptions` (§3.11.1). Три уровня «данных нет» и их носители перечислены в шапке
// `observation-status.ts`; ни один из них не является полем ЗНАЧЕНИЯ рыночного события.
//
// `stale` (bounded live-forward funding, незавершённый taker-бакет) не переехал в другое место
// контракта и не потерян: событие ЭМИТИТСЯ на ЗАКРЫТИИ бакета / на реальном наблюдении, то есть
// состояния «значение ещё не готово» на событийной поверхности не существует в принципе — оно было
// свойством PULL-модели `PointInTimeMarketApi` (`fundingAsOf()` спрашивают в произвольный момент,
// и он обязан ответить «снимок есть, но просрочен»). Ридинги остаются там, где им место, — в
// `market-tape.ts`, у формы `single_position`.

/** Закрытая (историческая) свеча по своему `subscriptionId`. */
export interface MarketCandleClosedEvent {
  readonly kind: 'market.candle.closed';
  readonly candle: ObservedValue<CandleValue>;
}

/** Open interest — point observation своего `subscriptionId` (см. `OpenInterestValue`). */
export interface MarketOpenInterestObservedEvent {
  readonly kind: 'market.open_interest.observed';
  readonly oi: ObservedValue<OpenInterestValue>;
}

/** Ликвидации — interval aggregate за закрытый бакет своего `subscriptionId`. */
export interface MarketLiquidationsBucketClosedEvent {
  readonly kind: 'market.liquidations.bucket_closed';
  readonly liq: ObservedValue<LiquidationsValue>;
}

/** Taker-объём — interval aggregate за закрытый минутный бакет своего `subscriptionId`. */
export interface MarketTakerVolumeBucketClosedEvent {
  readonly kind: 'market.taker_volume.bucket_closed';
  readonly taker: ObservedValue<TakerVolumeValue>;
}

/** Funding — наблюдение ставки своего `subscriptionId` (см. `FundingValue`). */
export interface MarketFundingObservedEvent {
  readonly kind: 'market.funding.observed';
  readonly funding: ObservedValue<FundingValue>;
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

// **Ни одно событие ниже НЕ несёт собственной временной координаты** (ревью владельца на PR sdk#34,
// Б-5). До этой правки каждое из девяти исполнительных событий несло поле `ts: TimestampUs` — то же
// самое дублирование, которое финальная волна ревью закрыла у ПЯТИ РЫНОЧНЫХ событий (Б-1, см. блок
// «Значения рыночных событий» выше) и которое та же волна ЗАВЕЛА ЗАНОВО на `trading_state.changed`,
// добавляя его. Довод дословно тот же: событие ПРОИСХОДИТ в том frontier, в котором доставлено,
// значит единственная его временная координата — `ActorEnvelope.eventTsUs`, а вторая метка на
// payload'е либо повторяет её (шум и второй источник истины), либо расходится с ней (и тогда
// непонятно, какая из двух — правда).
//
// Единица тут ни при чём: поля были уже µs-брандами (раунд правок 1, I-7 перевёл их из мс), и
// правка Б-5 не про единицы, а про ЧИСЛО координат. Ровно поэтому мс-заявка предыдущей волны
// («в актор-поверхности не осталось ни одного поля в миллисекундах») остаётся истинной и после
// сноса — сносится не мс-поле, а лишнее µs-поле.
//
// Исключение ровно одно и оно НЕ координата того же момента: `ActorTimerFiredEvent.dueTsUs` —
// исходный СРОК таймера, отличный от момента срабатывания по построению (§3.8.5), см. doc там.

/** Заявка принята средой (venue/симулятором). */
export interface ActorOrderAcceptedEvent {
  readonly kind: 'order.accepted';
  readonly clientOrderId: string;
}

/**
 * Заявка отклонена ЛОКАЛЬНО, до среды: RiskEngine (кламп не спас — потолок, rate-limit,
 * price-band, reduce-only в REDUCING). Терминальный. Отличим от `order.rejected` намеренно.
 */
export interface ActorOrderDeniedEvent {
  readonly kind: 'order.denied';
  readonly clientOrderId: string;
  readonly reason: string;
}

/** Заявка отклонена СРЕДОЙ (venue/симулятор). Терминальный. */
export interface ActorOrderRejectedEvent {
  readonly kind: 'order.rejected';
  readonly clientOrderId: string;
  readonly reason: string;
}

/** Заявка отменена (по команде `cancel` либо средой). Терминальный. */
export interface ActorOrderCanceledEvent {
  readonly kind: 'order.canceled';
  readonly clientOrderId: string;
}

/**
 * Отмена отклонена: команда `cancel` пришла, когда заявка уже была в терминальном состоянии
 * (чаще всего — уже полностью исполнилась) к моменту обработки. Недостающее событие v1 (§3.10,
 * задача 6) — цепочка `cancel → canceled` не знала этого исхода: гонку «отмена против исполнения»
 * в детерминированном бэктесте разрешает правило каскада (§3.8.4), а доставка самого исхода живёт
 * в **фазе 1** нормативного порядка §3.8.1: execution-события идут ПЕРВЫМИ — до due-таймеров, до
 * рыночных наблюдений и до каскада команд. Ссылки на `MARKET_KIND_RANK` здесь быть НЕ ДОЛЖНО
 * (ревью владельца на PR sdk#34): тот каталог (`contract/constants.ts`) ранжирует РЫНОЧНЫЕ виды
 * внутри фаз 3–4 merge key, к execution-фазе отношения не имеет, и прежняя ссылка уводила читателя
 * не туда. Результат ОБЯЗАН приехать событием — иначе
 * автор не может корректно завершить FSM своей политики выхода: хендлер, ждущий `order.canceled`
 * после поданного `cancel`, никогда не получил бы терминального сигнала и завис бы в
 * промежуточном состоянии политики навсегда. Аналог Nautilus `on_order_cancel_rejected`.
 * Терминальный (сама заявка остаётся в том состоянии, в котором была до `cancel` — как правило,
 * `filled`; повторный `cancel` той же уже-терминальной заявки — не новая гонка, а забытая ошибка
 * автора).
 */
export interface ActorOrderCancelRejectedEvent {
  readonly kind: 'cancel.rejected';
  readonly clientOrderId: string;
  readonly reason: string;
}

/** Заявка истекла по TIF/сроку. Терминальный. */
export interface ActorOrderExpiredEvent {
  readonly kind: 'order.expired';
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
  readonly clientOrderId: string;
  readonly price: number;
  /** Исполненный размер в базовой валюте инструмента. */
  readonly qty: number;
  readonly fee: number;
  /** Последний филл заявки (заявка перешла в терминальный `filled`). */
  readonly last: boolean;
}

/**
 * Срабатывание таймера, поставленного командой `timer.set` (§3.8.5). Таймерами владеет ХОСТ: у
 * изолята своих часов нет.
 *
 * **Имя вида — `timer.fired`, не `timer`** (ревью владельца на PR sdk#34). Так его называет
 * НОРМАТИВНЫЙ §3.8.5 спеки; `timer` мелькает в §3.1 — непоследовательность самой спеки, разрешённая
 * в пользу нормативного раздела. Released-имя `timer` и released-тип `ActorTimerEvent`
 * (`@trdlabs/sdk@0.13.0`) сняты — ломающее изменение того же класса, что снос `ActorBarEvent`
 * (см. блок у `OrderSide`); свип импортов по всем восьми репозиториям экосистемы пуст для обоих
 * имён, построчный вывод приложен к PR.
 *
 * **`dueTsUs` — исходный СРОК, а НЕ вторая координата момента срабатывания** (именно поэтому Б-5
 * снёс `ts`, но ЗАВЁЛ это поле). Таймер материализуется не в свой срок, а в первом frontier `U`,
 * для которого `U > T && U ≥ dueTs` (§3.8.5, `T` — frontier, в котором таймер поставлен), то есть
 * на БЛИЖАЙШЕМ ИНСТАНТЕ ДАННЫХ. Конверт несёт `eventTsUs = U` — момент срабатывания; это поле
 * несёт `dueTs`; опоздание автор выводит как `envelope.eventTsUs − event.dueTsUs`. Без поля
 * опоздание было бы ненаблюдаемо, и «сработал вовремя» стало бы неотличимо от «сработал через три
 * часа тишины в ленте» — а на разреженной ленте это разные торговые ситуации. `clock.nowUs()`
 * внутри диспатча таймера возвращает `U`, не `dueTs`.
 *
 * **Часы актора СТРОГО data-driven; wall-clock как источник advance ОТВЕРГНУТ** (§3.10). Прежняя
 * редакция этой доки обещала обратное — «в live дополнительно wall-clock-тик» — то есть ровно
 * вариант D2 спайка 083, который §3.10 отвергает дословно и по двум причинам: (1) при разреженных
 * данных таймер в live сработал бы НЕ ТАМ, где в бэктесте, а расхождение live/backtest — тот класс,
 * который контракт закрывает по построению и который обязана доказывать Л4 (cross-host parity);
 * (2) при мёртвом фиде рынок неизвестен, и правильное действие — ОСТАНОВИТЬСЯ, а не исполнить
 * таймерный выход вслепую. Простой фида компенсируют **host-watchdog и `TradingState`** (см.
 * `TradingState` ниже) — защита ВНЕ детерминированного контура, а не фальшивое продвижение часов
 * внутри него: при вставшем фиде frontier'ы не открываются и protective-таймеры честно замирают.
 */
export interface ActorTimerFiredEvent {
  readonly kind: 'timer.fired';
  readonly timerId: string;
  readonly dueTsUs: TimestampUs;
}

// ─────────────────────────────────────────────────────────────────────────────
// TradingState — режим торговли, назначаемый ХОСТОМ (§3.10).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Режим торговли инстанса, которым распоряжается ХОСТ, а не актор. Спека §3.10: при остановившемся
 * фиде бизнес-время не двигается, protective-таймеры актора честно замирают, и компенсирует это
 * **host-watchdog** — он наблюдает staleness источника и переводит `TradingState` в `'reducing'`
 * (растить экспозицию нельзя, отмены и reduce-only проходят) либо `'halted'` (только `cancel`).
 * Watchdog вне детерминированного контура, поэтому Л4 (cross-host parity) он не ломает.
 *
 * **Почему это S1, а не S5.** Спека §3.10 дословно: «Требование называется в S1 (актор наблюдает
 * переход), реализуется в S5». Без НАЗВАННОГО состояния LLM-автор не может выразить «не наращивай
 * экспозицию, хост в reducing» ничем, кроме парсинга свободного текста `order.denied.reason` — то
 * есть строил бы политику на строке, которую контракт не обязывался держать стабильной. Здесь —
 * ФОРМА (каталог, событие перехода, чтение текущего режима из `ctx`); сам watchdog, его пороги
 * staleness и проводка режима в RiskEngine — долг **S5** (`platform`), названный тем же способом,
 * что остальные долги этого файла (детектор breach бюджетов — S2, прогрев — S2, резолвер подписок
 * — задача 8).
 *
 * **Регистр значений.** Спека пишет `REDUCING`/`HALTED` капслоком — это прозаическое выделение
 * автомата, а не объявление литералов. В пакете ЕДИНЫЙ регистр закрытых каталогов (`'submitted'`,
 * `'final_only'`, `'single_position'`, `'stop_market'`, `'gtc'`), и ломать его ради типографики
 * прозы значило бы завести две конвенции в одном замороженном словаре.
 */
export type TradingState = 'normal' | 'reducing' | 'halted';

/**
 * Замкнутый каталог режимов торговли. Согласован с `TradingState` в ОБЕ стороны той же идиомой, что
 * `ACTOR_INPUT_EVENT_KINDS` ниже: `satisfies` — массив не шире типа, `_AssertNoUncoveredTradingState`
 * — тип не шире массива.
 */
export const TRADING_STATES = ['normal', 'reducing', 'halted'] as const satisfies readonly TradingState[];

/**
 * Переход режима торговли. Эмитится ХОСТОМ на САМОМ переходе — `previous !== state` всегда (режим,
 * не изменившийся на очередном тике watchdog'а, события не порождает: иначе актор получал бы шум на
 * каждом тике вместо сигнала об изменении — та же дисциплина, что у
 * `MarketSubscriptionStatusChangedEvent` выше). Равенство полей типом не запрещено (два одинаковых
 * литерала типизируются) — это инвариант ЭМИТТЕРА, как и «gap-событие ровно один раз».
 *
 * Событие несёт ОБА конца перехода, хотя `state` дублирует `ctx.tradingState` к моменту вызова
 * хендлера (инвариант state-before-handler, см. `ActorContext`). Это не то же дублирование, что
 * закрыл Б-1: событие — ЗАПИСЬ О СЛУЧИВШЕМСЯ, `ctx` — снимок ТЕКУЩЕГО; ровно так же устроен `fill`
 * (несёт `price`/`qty`, хотя `ctx.position()` их уже учёл). А `previous` из `ctx` не выводится
 * ВООБЩЕ — без него «вернулись в normal из halted» и «вернулись в normal из reducing» были бы для
 * автора одним и тем же наблюдением.
 *
 * А вот собственное поле `ts` этим событием несло РОВНО дублирование Б-1 — и было заведено ЗАНОВО
 * той самой волной, которая Б-1 закрывала (ревью владельца на PR sdk#34, Б-5). Снято: момент
 * перехода — `ActorEnvelope.eventTsUs` конверта, которым его доставили, и никакой другой.
 *
 * Поля `reason` НЕТ намеренно: закрытого каталога причин спека не даёт, а свободная строка
 * воспроизвела бы ровно ту дыру, ради закрытия которой это событие заведено (политика, построенная
 * на разборе человеческого текста). Диагностика причины — забота evidence прогона, не актора.
 */
export interface ActorTradingStateChangedEvent {
  readonly kind: 'trading_state.changed';
  readonly previous: TradingState;
  readonly state: TradingState;
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
  | ActorOrderCancelRejectedEvent
  | ActorOrderExpiredEvent
  | ActorFillEvent
  | ActorTimerFiredEvent
  | ActorTradingStateChangedEvent;

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
  'cancel.rejected',
  'order.expired',
  'fill',
  'timer.fired',
  'trading_state.changed',
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

/**
 * Обратное направление для каталога режимов торговли: значение `TradingState`, забытое в
 * `TRADING_STATES`, ломает сборку здесь же (TS2344). Прямое направление даёт `satisfies` на самом
 * массиве (см. `TRADING_STATES`).
 */
type _AssertNoUncoveredTradingState = AssertNoUncoveredKind<
  Exclude<TradingState, (typeof TRADING_STATES)[number]>
>;

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

/** Таймер через `afterUs` от `eventTsUs` обрабатываемого события. */
export interface ActorTimerSetAfterCommand {
  readonly kind: 'timer.set';
  readonly timerId: string;
  /**
   * Смещение от `ActorEnvelope.eventTsUs` события, породившего команду, — то есть от frontier `T`
   * его доставки (было «от `ts` события», пока у событий был собственный `ts`; Б-5 его снёс, и
   * единственная база отсчёта теперь одна — конверт). Срок `dueTs = eventTsUs + afterUs`
   * материализуется по правилу §3.8.5, см. `ActorTimerFiredEvent`.
   */
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
 *
 * **Fail-closed при отказе — задача 6, §3.8.4/§3.10. Два класса отказов разведены, а не смешаны
 * в один:**
 *
 * | класс | исход |
 * | --- | --- |
 * | штатный risk / domain rejection | prefix committed, suffix skipped, инстанс продолжает работу |
 * | throw из `dispatch`, невалидный по схеме батч, breach бюджета (`ActorBudgets`, ниже) | `halt+finalize` |
 *
 * Формулировка первого класса дословно (§3.8.4): если валидная по схеме команда получает штатный
 * domain/risk rejection, ранее успешно применённый префикс батча **не откатывается**, отклонённая
 * команда **не имеет частичных эффектов**, а оставшийся суффикс **не применяется**.
 * Соответствующее `order.rejected` / `order.denied` / `cancel.rejected` ставится в очередь и
 * доставляется актору ПОСЛЕ завершения батча (не синхронно внутри текущего `dispatch`). Причина
 * обрыва суффикса — fail-closed: команды ПОСЛЕ отклонённой вычислены под предположением, которое
 * только что опровергнуто (например, доступный notional после отклонённого `place`), и применять
 * их дальше значило бы исполнять план против уже устаревшего состояния.
 *
 * Отсутствие отката — не упрощение реализации, а физика: откатить уже отправленный в live ордер
 * невозможно, а разное поведение backtest/live на этом шве сломало бы Л4 (cross-host parity).
 *
 * Второй класс (`throw` из `dispatch`, батч, не прошедший схему на границе, breach любого
 * бюджета из `ActorBudgets`) — авария ядра, а не доменный факт: инстанс переводится в
 * `halt+finalize` целиком, потому что живая позиция при мёртвой стратегии — та же
 * рассинхронизация, что закрывает инвариант «оба состояния умирают вместе»
 * (`mem883ede17e9bfeb24`). Halt наблюдаем актором (может успеть получить `dispose`, если хост его
 * вызывает как часть finalize) — сам детектор breach и его проводка в `halt+finalize` реализуются
 * в S2 (`@trdlabs/engine`); здесь — только форма и наблюдаемое разведение двух классов.
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
 * подмножество JS-значений, у которых `JSON.parse(JSON.stringify(x))` восстанавливает КАЖДОЕ
 * СКАЛЯРНОЕ значение и структуру дерева без молчаливых искажений (в отличие, например, от объекта с
 * ключом `undefined`-значения, который `JSON.stringify` тихо роняет, или от `Date`, который
 * превращается в строку и теряет тип).
 *
 * **«Без потерь» — про значения, НЕ про идентичность ссылок** (финальная волна ревью ветки, F-1:
 * прежняя формулировка «восстанавливает БЕЗ потерь» была шире правды). Разделяемая ссылка
 * (легитимный DAG: два поля указывают на ОДИН объект) переживает границу как ДВЕ независимые копии
 * с тем же содержимым — разделение идентичности теряется, и вместе с ним теряется РАЗМЕР: `n`
 * объектов, каждый со ссылкой на предыдущий дважды, разворачиваются в `2ⁿ` узлов JSON.
 * `isPlainActorState` ниже поэтому считает не только глубину, но и размер развёртки
 * (`MAX_ACTOR_STATE_EXPANDED_NODES`) и отклоняет то, что физически не переживёт `JSON.stringify`.
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
 * Практический потолок глубины вложенности (ревью раунда 2, новый дефект: недоверенный ГЛУБОКИЙ
 * вход валил функцию, документированную КАК ГЕЙТ недоверенного JSON, необработанным
 * `RangeError: Maximum call stack size exceeded` на глубине ~5000 — сигнатура обещает `value is
 * ActorStateValue`, а не крах, и `RangeError` того же конструктора, что намеренно бросает
 * `derivePositionView` (`actor-state.ts`), неотличим вызывающим от НЕЙ).
 *
 * Значение живёт в `plain-data.ts` (`MAX_PLAIN_DATA_DEPTH`) с финальной волны ревью ветки: тот же
 * потолок применяет `deepValueEquals` (`observation-status.ts`), у которого нашли ровно тот же
 * дефект — `RangeError` вместо вердикта на глубоком и на циклическом значении.
 */
const MAX_ACTOR_STATE_DEPTH = MAX_PLAIN_DATA_DEPTH;

/**
 * Потолок РАЗМЕРА JSON-развёртки авторского состояния — число узлов (объектов, элементов массива и
 * скаляров), которые `JSON.stringify` обязан выписать (финальная волна ревью ветки, F-1).
 *
 * **Зачем отдельно от глубины.** Разделяемая (не циклическая) ссылка законна и `isPlainActorState`
 * её принимает — но через границу JSON она едет РАЗВЁРНУТОЙ, по копии на каждый путь к ней. DAG
 * глубиной `n`, где каждый узел ссылается на предыдущий ДВАЖДЫ, — это `n+1` объект в памяти и `2ⁿ`
 * узлов в JSON. Прогон финального ревью: 21 объект (`DAG(20)`) — `isPlainActorState` = `true` за
 * <1 мс, `JSON.stringify` = 22 020 085 символов за 263 мс; 28 объектов (`DAG(27)`) —
 * `isPlainActorState` = `true` мгновенно, `JSON.stringify` = **`RangeError: Invalid string length`
 * через 28.7 с**. Автору такое состояние стоит нуля, границе персиста — краха вдали от причины.
 *
 * **Величина — ИЗМЕРЕНА, не угадана.** Замер `JSON.stringify` по числу узлов на этой машине:
 * 1e5 → 0.59 МБ / 4 мс; **1e6 → 6.9 МБ / 45 мс**; 4e6 → 31 МБ / 186 мс; 1.6e7 → 133 МБ / 745 мс.
 * Измеренная плотность — 6.9…8.3 символа на узел; потолок строки V8 — 536 870 888 символов, то
 * есть РАСЧЁТНАЯ граница краха лежит около `6·10⁷` узлов, а НАБЛЮДЁННЫЙ крах — `DAG(27)` ≈ `4·10⁸`
 * узлов (расчётную границу он проскочил, потому что промежуточных замеров между 1.6e7 и 4e8 не
 * делалось). Выбранный `1e6` — чекпойнт, который заведомо сериализуется (6.9 МБ, 45 мс), с запасом
 * ~60× до расчётной границы и ~400× до наблюдённого краха.
 *
 * **Цена названа явно:** порог — БЮДЖЕТ, а не детектор патологии, и применяется одинаково к обеим
 * формам её достижения. Плоское окно на 1 000 000 элементов отклоняется тем же числом, что и
 * 21-объектный DAG, — предикат ФОРМЫ не может отличить «большое честное состояние» от «маленькое
 * состояние с экспоненциальной развёрткой», потому что для `JSON.stringify` это одно и то же.
 * Прежнее суждение («не load-bearing, чинится строкой доки») отменено владельцем: `isPlainActorState`
 * — документированная обязанность хоста на границе персиста и единственный заслон между
 * `snapshotState()` и крахом сериализации.
 */
const MAX_ACTOR_STATE_EXPANDED_NODES = 1_000_000;

/**
 * Что обход УЖЕ доказал про поддерево подтверждённого узла (memo-запись `confirmed`).
 *
 * - `height` — сколько уровней рекурсии поддерево ДОБАВЛЯЕТ сверх глубины самого узла;
 * - `expandedSize` — сколько узлов JSON-развёртки поддерево стоит, включая сам узел.
 *
 * Обе величины — свойства ПОДДЕРЕВА, а не его положения в графе, поэтому мемоизируются вместе и
 * переиспользуются на любом пути к узлу.
 */
interface ConfirmedSubtree {
  readonly height: number;
  readonly expandedSize: number;
}

/** Метрики примитива: сам узел стоит одного узла развёртки и не углубляет обход. */
const PRIMITIVE_SUBTREE: ConfirmedSubtree = { height: 0, expandedSize: 1 };

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
 * `confirmed` — ВТОРАЯ структура, ГЛОБАЛЬНАЯ на весь вызов `isPlainActorState` (НЕ backtracking,
 * никогда не уменьшается) — memo объектов, для которых обход УЖЕ доказал «весь их поддерево —
 * plain-data, без цикла» (ревью раунда 3, Important: `finally`-очистка `ancestors` даёт верный
 * O(глубина) на ПОСЕЩЕНИЕ, но число посещений не ограничено числом узлов на DAG'е — разделяемый
 * ПОДГРАФ обходится заново по КАЖДОМУ пути к нему, `2^глубина` при ветвлении; прогон ревью — 23
 * разделяемых объекта дали 4.1 с). Соответствует РЕАЛЬНОЙ угрозе: `snapshotState()` возвращает
 * внутрипроцессный объект (не результат `JSON.parse`, тот ВСЕГДА дерево), который волен разделять
 * ссылки свободно.
 *
 * `confirmed: Map<object, height>`, НЕ `Set<object>` (ревью раунда 4, C-4, Critical — РЕГРЕССИЯ
 * ИМЕННО ЭТОГО дифа): `Set`-версия хранила «доказано» БЕЗ глубины, на которой это доказано, —
 * memo-попадание возвращало `true` НА ЛЮБОЙ ГЛУБИНЕ, хотя `depth` считается по рекурсии, а
 * попадание в memo рекурсию (и вместе с ней — рост `depth`) ОТМЕНЯЕТ. Прогон ревью: персистентная
 * append-only цепочка (`{prev, value}`, `ticks` звеньев) ПЛЮС индекс-массив всех узлов цепочки в
 * порядке создания — `{index, head}` (мелкий узел `index[0]` подтверждается ПЕРВЫМ, дальше глубокий
 * `head === index[ticks-1]` дёшево подтверждается ЧЕРЕЗ memo мелкого) давал `true` на глубине 6001
 * и 12001, тогда как `{head, index}` (тот же объект, `head` первым, БЕЗ прогретого memo) на ТОЙ ЖЕ
 * структуре честно отклонял уже на глубине ~500 — вердикт зависел от ПОРЯДКА КЛЮЧЕЙ, а не от
 * данных, потолок стал fail-open, `JSON.stringify` результата ронял бы чекпойнт в рантайме, далеко
 * от места дефекта.
 *
 * `height(obj)` — сколько уровней рекурсии ДОБАВЛЯЕТ поддерево `obj` сверх глубины, на которой сам
 * `obj` встречен. `0` — у узла НЕТ потомков вовсе (пустой объект/массив: обход не идёт дальше);
 * `1` — все потомки примитивны (финальная волна ревью, F-4: прежняя доc называла этот случай
 * нулевым, тогда как код даёт единицу — `height` примитива-потомка `0`, плюс один за сам шаг
 * рекурсии); дальше — максимум по потомкам плюс один, где потомок дал СВОЙ `height`. При попадании
 * в `confirmed` вместо слепого `true` — проверка `depth + height <= MAX_ACTOR_STATE_DEPTH`: РОВНО
 * тот же порог, что дал бы честный обход БЕЗ memo, свернутый в O(1). Отрицательный исход этой
 * проверки НЕ мемоизируется (глубина, на которой обнаружен избыток, — свойство ТЕКУЩЕГО положения
 * объекта в графе, не самого объекта — на другой, более мелкой глубине тот же `obj` мог бы
 * уложиться).
 *
 * `expandedSize(obj)` (финальная волна ревью, F-1) — вторая мемоизируемая величина рядом с
 * `height`: число узлов, которые `JSON.stringify` выпишет для поддерева `obj`, ВКЛЮЧАЯ сам `obj`.
 * Считается ровно так же, как height, только суммой вместо максимума, и сравнивается с
 * `MAX_ACTOR_STATE_EXPANDED_NODES` НА КАЖДОМ шаге накопления — то есть обход прекращается на первом
 * же потомке, переполнившем бюджет, а не после того, как посчитает всю экспоненту (`2ⁿ` от
 * разделяемых ссылок никогда не материализуется как число). Переполнение — `false`, fail-closed,
 * и НЕ мемоизируется, как и любой отрицательный исход.
 *
 * Сложность — `O(V + E)` (различные объекты плюс рёбра/ссылки НА них), НЕ `O(V)` (Minor, ревью
 * раунда 4: доc `isPlainActorState` формулировала это как «O(число различных объектов)» — прогон
 * ревью, 2 различных объекта и 200 000 рёбер, дал 393 мс, то есть КАЖДОЕ ребро, даже ведущее к уже
 * подтверждённому узлу, всё равно стоит одного вызова этой функции и одного `Map.get`). Memo снимает
 * ПОВТОРНЫЙ ОБХОД поддерева (тем самым — экспоненту от ветвления), не сам факт посещения ребра.
 *
 * Мемоизация СОХРАНЯЕТ корректность обнаружения циклов (не изменено этим раундом; см. независимый
 * дифф-фаззинг, 20 000 графов, 0 расхождений): объект добавляется в `confirmed` ТОЛЬКО ПОСЛЕ того,
 * как его СОБСТВЕННОЕ поддерево полностью пройдено и не породило `false` — то есть только когда в
 * его поддереве СТРУКТУРНО нет цикла НИ С ОДНИМ узлом (совпадение объекта в `confirmed` с текущим
 * `ancestors` невозможно: попадание в `confirmed` происходит ПОСЛЕ выхода из `try`, когда `obj` уже
 * удалён из `ancestors` в `finally`).
 */
function isPlainDataValue(
  value: unknown,
  ancestors: Set<object>,
  confirmed: Map<object, ConfirmedSubtree>,
  depth: number,
): boolean {
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
  const known = confirmed.get(obj);
  if (known !== undefined) {
    // Memo-попадание НЕ возвращает `true` слепо (C-4) — тот же порог, что дал бы честный обход.
    // `expandedSize` здесь НЕ проверяется: он уже был ≤ бюджета (иначе узел не попал бы в memo), а
    // его вклад В СУММУ РОДИТЕЛЯ считает сам родитель, ниже по циклу.
    return depth + known.height <= MAX_ACTOR_STATE_DEPTH;
  }
  if (ancestors.has(obj)) return false; // настоящий цикл — см. doc выше.
  ancestors.add(obj);
  let ok = false;
  let height = 0; // Максимум по потомкам + 1; остаётся 0, если потомков, требующих рекурсии, нет.
  let expandedSize = 1; // Сам узел + сумма по потомкам; сравнивается с бюджетом на каждом шаге.
  try {
    if (Array.isArray(obj)) {
      if (hasOnlyPlainArrayKeys(obj)) {
        ok = true;
        for (const item of obj) {
          if (!isPlainDataValue(item, ancestors, confirmed, depth + 1)) {
            ok = false;
            break;
          }
          const child = childSubtree(item, confirmed);
          height = Math.max(height, child.height + 1);
          expandedSize += child.expandedSize;
          if (expandedSize > MAX_ACTOR_STATE_EXPANDED_NODES) {
            ok = false;
            break;
          }
        }
      }
    } else if (isPlainObjectPrototype(obj) && hasOnlyPlainOwnKeys(obj)) {
      // Экзотические объекты (Date/Map/Set/RegExp/класс-инстанс) отклонены прототипом — белый
      // список из двух разрешённых форм, см. doc `isPlainObjectPrototype` (`plain-data.ts`).
      ok = true;
      for (const v of Object.values(obj as Record<string, unknown>)) {
        if (!isPlainDataValue(v, ancestors, confirmed, depth + 1)) {
          ok = false;
          break;
        }
        const child = childSubtree(v, confirmed);
        height = Math.max(height, child.height + 1);
        expandedSize += child.expandedSize;
        if (expandedSize > MAX_ACTOR_STATE_EXPANDED_NODES) {
          ok = false;
          break;
        }
      }
    }
  } finally {
    // ОБЯЗАН выполниться на ВСЕХ путях выхода (включая ранние `return false` выше в блоке) — иначе
    // соседняя ветвь (диамант, не потомок) видит `obj` как предка и ложно отклоняет легитимную
    // разделяемую ссылку.
    ancestors.delete(obj);
  }
  // Мемо ТОЛЬКО положительного исхода — см. doc выше, почему. Раз `ok`, то и `expandedSize` уже
  // уложился в бюджет: цикл выше прерывается на первом же переполнении.
  if (ok) confirmed.set(obj, { height, expandedSize });
  return ok;
}

/**
 * Метрики ОДНОГО потомка `child` для накопления `height`/`expandedSize` родителя (см. doc
 * `isPlainDataValue`): примитив/`null` — `PRIMITIVE_SUBTREE` (обход не идёт глубже него, стоит он
 * один узел развёртки); объект/массив — его СОБСТВЕННЫЕ метрики, уже посчитанные (и, значит,
 * лежащие в `confirmed`, раз мы сюда попали ПОСЛЕ успешной рекурсии в него строкой выше).
 * Отдельная маленькая функция, а не инлайн: избегает пересчёта через повторный вызов
 * `isPlainDataValue` (который заново тратил бы `ancestors`/`depth` без надобности — метрики
 * примитива и уже подтверждённого объекта читаются, а не выводятся заново).
 */
function childSubtree(child: unknown, confirmed: ReadonlyMap<object, ConfirmedSubtree>): ConfirmedSubtree {
  if (child === null || typeof child !== 'object') return PRIMITIVE_SUBTREE;
  return confirmed.get(child) ?? PRIMITIVE_SUBTREE;
}

/**
 * Рантайм-проверка формы авторского state-слота (требование 1). Отвергает: функции (прямые,
 * замыкания, под символьным или неперечислимым ключом), accessor-свойства, циклические ссылки,
 * `symbol`/`bigint`/`undefined`-в-структуре, `NaN`/`Infinity`/`-0`, экзотические объекты
 * (`Date`/`Map`/`Set`/класс-инстанс), sparse-массивы, добавленные нечисловые свойства массива,
 * вложенность глубже `MAX_ACTOR_STATE_DEPTH` (fail-closed `false`, не исключение, НА ЛЮБОМ пути
 * достижения узла — раунд 4 закрыл memo-обход этой границы, см. doc `isPlainDataValue`) и
 * JSON-развёртку крупнее `MAX_ACTOR_STATE_EXPANDED_NODES` (финальная волна ревью, F-1: DAG из 28
 * объектов разворачивался в ~4·10⁸ узлов и ронял `JSON.stringify` `RangeError`'ом через 28.7 с —
 * гейт при этом отвечал `true`). Принимает вложенную структуру из
 * `null`/`boolean`/`string`/конечных `number`/плотных массивов/plain-объектов до предельной глубины
 * И в пределах бюджета развёртки, ДЕРЕВОМ либо DAG'ом — разделяемая (не циклическая) ссылка
 * учитывается по СТОИМОСТИ один раз через memo (`confirmed`, ревью раунда 3), а не переисследуется
 * по каждому пути к ней: стоимость — O(V + E) (различные объекты плюс рёбра/ссылки на них, а не
 * «O(число различных объектов)», как утверждала дока раунда 3 — прогон ревью раунда 4: 2 различных
 * объекта и 200 000 рёбер дали 393 мс, то есть каждое РЕБРО, даже к уже подтверждённому узлу, всё
 * равно стоит одного вызова функции), а НЕ экспоненциальная от ветвления путей.
 */
export function isPlainActorState(value: unknown): value is ActorStateValue {
  return isPlainDataValue(value, new Set(), new Map(), 0);
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
 * Единственный САНКЦИОНИРОВАННЫЙ источник случайности актора (задача 6, «дом авторского RNG»,
 * §3.6).
 *
 * **Дом — ЯДРО, не авторское состояние.** `ctx.rng` — capability ядра, засеиваемая от
 * `ActorInit.seed` прогона; её состояние ОБЯЗАНО лежать в `engineState.rng` чекпойнта ядра ВМЕСТЕ
 * с движковым состоянием (S2, `@trdlabs/engine`), а НЕ быть полем авторского state-слота — иначе
 * Л2 (recovery-equivalence) поймает расхождение на первом же чекпойнте стратегии, которая дёрнула
 * `rng.next()`: полный реплей от genesis переиграл бы тот же бросок, а восстановление из
 * чекпойнта дало бы уже другой бросок, если состояние генератора не чекпойнтится вместе с движком.
 *
 * **Что гейт state-слота ДАЁТ (задача 6, ревью раунда 1, I-2 — формулировка сужена).** Спрятать
 * генератор ВНУТРИ авторского state-слота (например, замыкание, сидированное один раз при `init`)
 * не выйдет: `ActorStateValue`/`isPlainActorState` (выше) структурно отклоняют функции — такое
 * замыкание НЕ ПЕРЕЖИВЁТ границу чекпойнта (`snapshotState`/`ActorInit.state`), то есть не может
 * быть источником случайности, СОГЛАСОВАННЫМ с чекпойнтом/восстановлением актора. Это гарантия
 * НЕЧЕКПОЙНТАБЕЛЬНОСТИ спрятанного генератора, а не его физической невозможности.
 *
 * **Чего гейт НЕ даёт (названо явно, а не обещано молча).** `Math.random()`/`Date.now()`,
 * вызванные ПРЯМО внутри хендлера, доступны обычному JS-коду и НЕ проходят ни через `ctx.rng`, ни
 * через state-слот — гейт их не видит и видеть не может (проверено прогоном против опубликованного
 * `dist`: оба вызова исполняются без ошибки внутри `onEvent`). Хуже того, module-scope
 * (замыкание, объявленное на верхнем уровне модуля стратегии, а не внутри state-слота) переживает
 * ПОСЛЕДОВАТЕЛЬНЫЕ вызовы `onEvent` одного и того же процесса изолята сам по себе, ни разу не
 * заходя в state-слот, — то есть может служить вторым источником случайности между вызовами
 * `onEvent`, чего дока прежней редакции отрицала. Закрытие ЭТОГО класса — статик-гейт (бан
 * `Date.now`/`Math.random`/несортированной итерации, Л1 «внутриконтрактная байт-идентичность»)
 * ПЛЮС replay-гейт — обязательство S2 (`@trdlabs/engine`), не форма `sdk`: `sdk` (S1) может
 * зафиксировать канал `ctx.rng` и закрыть его от чекпойнта, но не может статически проверить тело
 * авторского модуля на отсутствие обращений к глобальным источникам энтропии — эта проверка живёт
 * вне типов, в отдельном анализаторе кода стратегии.
 */
export interface ActorRng {
  readonly next: () => number;
}

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
 * детерминированным по определению (CH-5, задачи S1/2); `rng: ActorRng`, доc — «дом авторского
 * RNG» (см. `ActorRng` выше). `readiness` (задача 3, требование 6) —
 * без него `place` не может быть отклонена ДО прогрева нигде, кроме неявного соглашения хоста.
 * `orders`/`position` (задача 5, требование 2) — доступ к открытым заявкам и к позиции; ОБЕ формы
 * (`OpenOrderView`/`PositionView`, выше) читаются как СНИМОК на момент вызова, не как живая ссылка
 * — мутировать их нельзя, дальнейшее состояние актор получает только СЛЕДУЮЩИМ вызовом `onEvent`.
 * `tradingState` (§3.10, финальная волна ревью ветки, Б-3) — режим, назначенный ХОСТОМ; читается
 * тем же инвариантом state-before-handler, что и всё остальное в `ctx`: к моменту вызова хендлера
 * `trading_state.changed` поле УЖЕ несёт новый режим. Без него единственным способом узнать «хост в
 * reducing» был бы разбор свободного текста `order.denied.reason` (см. `TradingState`).
 *
 * `orders.open`/`position` — readonly-ПОЛЯ функционального типа, НЕ method-синтаксис (ревью раунда
 * 1, M-5: method-синтаксис в интерфейсе НЕ несёт `readonly`, то есть формально переприсваиваем —
 * `ctx.position = () => fake` типизировался бы, в отличие от соседних `clock`/`rng`/`readiness`).
 */
export interface ActorContext {
  readonly clock: { nowUs(): TimestampUs };
  readonly rng: ActorRng;
  readonly readiness: ActorReadiness;
  /** Режим торговли, назначенный хостом (§3.10). См. `TradingState`. */
  readonly tradingState: TradingState;
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
 * строже (закрывает СИММЕТРИЧНУЮ дыру «объявил снятие без параметризации типа»), но ценой ОДНОЙ
 * back-compat формы («просто передать `snapshotState`, не выписывая `defineActor<MyState>(...)`
 * отдельно»). ПОПРАВКА (ревью раунда 4): черновик этого решения (раунд 3) обосновывал выбор
 * ненадёжностью вывода `S` без явного типового аргумента — заявление было ПРОВЕРЕНО ревьюером
 * ЭМПИРИЧЕСКИ И ОПРОВЕРГНУТО: `defineActor({ snapshotState: () => ({ticks, sum}) })` без явного
 * `<S>` выводит `S` КОНКРЕТНЫМ типом `{ticks, sum}` (не расширяется до `ActorStateValue`) —
 * обратная совместимость и вывод типа работают ОДНОВРЕМЕННО, ничего не в конфликте. Решение
 * (дефолт `= ActorStateValue`) ОСТАЁТСЯ тем же самым, но по другой причине: `S = never` требовал
 * бы у ЧИТАТЕЛЯ типа (и у текста ошибки компилятора при несовпадении) держать в голове `never` как
 * содержательный сигнал «состояние ещё не объявлено» — приём, знакомый опытному TS-автору, но
 * менее очевидный по тексту самой ошибки, чем прямое несовпадение конкретных форм состояния,
 * которое даёт дефолт `ActorStateValue`; выбор — не про надёжность вывода (она одинакова), а про
 * читаемость сообщения об ошибке для автора, которым НЕ обязан быть эксперт по conditional types
 * TypeScript (в том числе LLM-написанный код, см. `brief.ts`/`market-tape.ts` doc про недоверенное
 * авторство). Оставшаяся дыра («хост объявил и снял состояние, но не вернул его при следующем
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

// ─────────────────────────────────────────────────────────────────────────────
// Бюджеты актора (задача 6, §3.10) — per-dispatch + кумулятивный per-frontier. НЕТ per-session.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Бюджет на ОДИН вызов dispatch (§3.10) — прототип: LEAN Isolator, «лимит на шаг, не на ран».
 * Все поля опциональны: хост включает ровно те измерения, что умеет мерить (например, paper-режим
 * может не иметь дешёвого способа измерить CPU-время и ограничиться только `maxCommandsPerBatch`).
 *
 * `maxCpuUs`/`maxWallUs` — раздельные измерения намеренно: CPU-время актора и wall-clock ОДНОГО
 * вызова `dispatch` расходятся под конкуренцией хоста (GC пауза, соседний изолят) — лимит на
 * одно не заменяет лимит на другое.
 */
export interface ActorDispatchBudget {
  readonly maxCpuUs?: DurationUs;
  readonly maxWallUs?: DurationUs;
  /** Максимум команд в ОДНОМ батче, который `onEvent` возвращает за один вызов. */
  readonly maxCommandsPerBatch?: number;
}

/**
 * Кумулятивный бюджет на ОДИН frontier (`businessTsUs`) — §3.8.4, прямое следствие каскадной
 * доставки domain/risk rejection (см. doc `ActorCommandBatch` выше). Раз `order.rejected` /
 * `cancel.rejected` приезжает В ТОМ ЖЕ frontier, актор может отвечать на отказ повтором той же
 * команды бесконечно, не превысив НИ ОДНОГО per-dispatch лимита — `ActorDispatchBudget` этот класс
 * зацикливания структурно не видит, потому что каждый отдельный `dispatch` внутри цепочки остаётся
 * дёшев.
 *
 * ОБА поля обязательны (в отличие от `ActorDispatchBudget`): именно они закрывают конкретную,
 * уже названную дыру, а не предоставляют опциональную защиту сверх.
 *
 * - `maxCascadeDepth` — глубина цепочки команда → событие → команда ВНУТРИ одного `businessTs`.
 * - `maxEventsPerFrontier` — общее число событий, доставленных актору в пределах одного frontier.
 */
export interface ActorCumulativeFrontierBudget {
  readonly maxCascadeDepth: number;
  readonly maxEventsPerFrontier: number;
}

/**
 * Полный набор бюджетов актора (§3.10) — ИСКЛЮЧИТЕЛЬНО per-dispatch и кумулятивный per-frontier.
 *
 * **Per-session бюджета здесь НЕТ, и это форма, а не пробел** (задача 6, требование 2 брифа: «per-
 * session бюджета быть не должно»). У актора «сессия» бесконечна по построению: `StrategyActor`
 * живёт от `init` до `dispose` произвольно долго, чекпойнтится и восстанавливается (§3.6), и не
 * имеет момента «конец сессии», которому лимит мог бы быть осмысленно привязан. Реальный прод-
 * отказ (F6, `backtester` sandbox timeout diagnosis) был РОВНО исчерпанием `wallTimeMsPerSession`
 * изолята — механизм, спроектированный для одноразового скрипта конечной длины, на долгоживущем
 * акторе деградирует в ГАРАНТИРОВАННЫЙ отказ, не в редкий: рано или поздно любой актор,
 * работающий достаточно долго, упирается в лимит, никак не связанный с тем, полезен он ещё или
 * нет. `ActorBudgets` несёт РОВНО два измерения — per-dispatch и per-frontier; третьего поля в
 * ЭТОЙ форме нет.
 *
 * **Точность заявления (Minor, ревью раунда 1 задачи 6): не «структурно невозможно», а «нет в
 * форме».** Отсутствие ловится компилятором ТОЛЬКО на СВЕЖЕМ объектном литерале, присвоенном
 * напрямую переменной этого типа (excess-property-check — см. тест на отсутствие) — так же, как и
 * любой другой TS-тип без индексной сигнатуры. Значение, собранное иначе (`const x = {...budgets,
 * perSession: {...}}`, приведение через `as ActorBudgets`, значение, пришедшее с недоверенной
 * JSON-границы) — TS не отловит, и рантайм-гейта для `ActorBudgets` в этом пакете НЕТ (в отличие
 * от `isPlainActorState`/`isExecutionLedgerEntry`, у которых он есть). Это ограничение
 * excess-property-check, а не свойство формы поверх него — то же самое верно для ЛЮБОГО TS-типа в
 * этом пакете и здесь называется явно, а не подразумевается.
 *
 * Breach ЛЮБОГО бюджета — `halt+finalize`, наблюдаемый актором (см. doc `ActorCommandBatch`
 * выше, второй класс отказов). Сам детектор breach — S2 (`@trdlabs/engine`); здесь только форма
 * лимитов, которые он обязан читать.
 */
export interface ActorBudgets {
  readonly perDispatch: ActorDispatchBudget;
  readonly perFrontier: ActorCumulativeFrontierBudget;
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
 *
 * `budgets` (задача 6, §3.10) — опционально: хост может не конфигурировать лимиты вовсе (например,
 * в контексте, где breach проверяется снаружи). См. `ActorBudgets`.
 *
 * `seed` — помимо детерминированного `clientOrderId` (см. doc в шапке файла), единственный
 * источник детерминированной случайности прогона: сидирует `ctx.rng` (`ActorRng`, doc у
 * `ActorContext` ниже) — «дом авторского RNG», §3.6. Актор НЕ получает `seed` напрямую и не может
 * засеять им СВОЙ генератор — единственный легальный канал случайности внутри хендлеров это
 * `ctx.rng.next()`.
 */
export interface ActorInit<S extends ActorStateValue = ActorStateValue> {
  readonly params: Readonly<Record<string, unknown>>;
  readonly seed: number;
  readonly symbol: string;
  readonly subscriptions: readonly ActorSubscriptionDescriptor[];
  readonly state?: S;
  /** Бюджеты исполнения (§3.10) — опционально: хост может не конфигурировать лимиты вовсе
   *  (например, в контексте, где breach проверяется снаружи). См. `ActorBudgets`. */
  readonly budgets?: ActorBudgets;
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
 * **Правило имени ТОТАЛЬНО, исключений нет** (решение владельца, ревью PR sdk#34):
 * `'on' + kind.split(/[._]/).map(capitalize).join('')`. То есть `order.accepted` →
 * `onOrderAccepted`, `market.taker_volume.bucket_closed` → `onMarketTakerVolumeBucketClosed`,
 * `cancel.rejected` → `onCancelRejected`, `timer.fired` → `onTimerFired`, `fill` → `onFill`.
 *
 * Тотальность здесь — не эстетика, а страховка от МОЛЧАЛИВОГО отказа. Все хендлеры опциональны, и
 * необъявленный хендлер — законная форма («вид игнорируется»), поэтому опечатка или память об
 * исключении дают не ошибку, а тишину: событие уедет в `onEvent`, а если и его нет — в пустой
 * батч. Ни тип, ни валидатор, ни схема этого не ловят и поймать не могут. Стратегии здесь пишет
 * LLM, для которой «помнить, что вот этот один вид называется иначе» — ровно тот вид требования,
 * который она нарушит молча.
 *
 * Правило не оставлено на память: `event-driven.test.ts` ВЫВОДИТ ожидаемое имя из каждого элемента
 * `ACTOR_INPUT_EVENT_KINDS` этой же формулой и требует, чтобы диспетчер его вызвал — новый вид
 * события без правильно названного хендлера роняет тест, а не тихо теряет событие. Тест проверен
 * фальсификацией: возврат `onTimerFired` к `onTimer` красит его, значит он не декоративен.
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
  /**
   * Переименован из `onOrderCancelRejected` ТОЙ ЖЕ правкой, что `onTimer` → `onTimerFired` (см. doc
   * ниже за полным доводом). Владелец, назначая правило тотальным, назвал это отображение как
   * `cancel.rejected` → `onCancelRejected` — а в коде стояло `onOrderCancelRejected`, то есть
   * правило БЫЛО НЕ ТОТАЛЬНЫМ и после переименования таймера осталось бы ровно одно исключение,
   * с тем же классом отказа (LLM-автор держит исключение в памяти, промах не ловится ничем).
   * Имя было заведено по аналогии с Nautilus `on_order_cancel_rejected`; аналогия проиграла
   * тотальности правила. Released-именем оно не было НИКОГДА: события `cancel.rejected` в
   * `0.13.0` не существовало вовсе (задача 6 этой же ветки его и завела), поэтому переименование
   * не стоит потребителям ничего.
   */
  onCancelRejected?(event: ActorOrderCancelRejectedEvent, ctx: ActorContext): ActorHandlerResult;
  onOrderExpired?(event: ActorOrderExpiredEvent, ctx: ActorContext): ActorHandlerResult;
  onFill?(event: ActorFillEvent, ctx: ActorContext): ActorHandlerResult;
  /**
   * Переименован из released-`onTimer` (`0.13.0`) вслед за видом события (решение владельца,
   * ревью PR sdk#34 — первая редакция этой правки имя сохраняла, довод «лишний слом released-имени
   * там, где он ничего не чинит» был отклонён).
   *
   * Польза не в самом имени, а в ТОТАЛЬНОСТИ правила отображения «вид события → имя хендлера»:
   * `order.accepted` → `onOrderAccepted`, `trading_state.changed` → `onTradingStateChanged`, значит
   * `timer.fired` → `onTimerFired`. Оставленный `onTimer` был бы исключением из ОДНОГО элемента, а
   * стратегии здесь пишет LLM: исключение придётся держать в памяти, и промах по нему не ловится
   * НИЧЕМ — ни типом (все хендлеры опциональны), ни валидатором; хендлер просто не позовут, молча.
   * Ветка ломающая по построению, одним переименованием её характер не меняется.
   */
  onTimerFired?(event: ActorTimerFiredEvent, ctx: ActorContext): ActorHandlerResult;
  onTradingStateChanged?(
    event: ActorTradingStateChangedEvent,
    ctx: ActorContext,
  ): ActorHandlerResult;
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
      case 'cancel.rejected':
        if (handlers.onCancelRejected) return toBatch(handlers.onCancelRejected(event, ctx));
        break;
      case 'order.expired':
        if (handlers.onOrderExpired) return toBatch(handlers.onOrderExpired(event, ctx));
        break;
      case 'fill':
        if (handlers.onFill) return toBatch(handlers.onFill(event, ctx));
        break;
      case 'timer.fired':
        if (handlers.onTimerFired) return toBatch(handlers.onTimerFired(event, ctx));
        break;
      case 'trading_state.changed':
        if (handlers.onTradingStateChanged) return toBatch(handlers.onTradingStateChanged(event, ctx));
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
