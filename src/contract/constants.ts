// @trdlabs/sdk — contract capability/versioning constants (standalone, SDK-owned).
//
// Initiative #2 (Stage 1): the research vendored snapshot (contract/research/**) is SHED. The root
// surface only needs the capability/versioning constants, so they are inlined here as the SDK's own
// source of truth. These values mirror the platform research contract catalogs; bumping them is
// policed downstream by the platform's contract gates.

/**
 * Research contract version (platform 030 bumped to `017.2`; 083 E1 to `017.3`; 083 S1 задача 6
 * to `017.4`).
 *
 * `017.3` → `017.4`: задачи 1–5 этапа S1 переписали ВЕСЬ surface, который `017.3` вводил, —
 * µs-бранд-типы вместо мс на каждом поле актора, `MarketCandleClosedEvent.candle` вместо
 * снесённого `ActorBarEvent`, `OpenOrderView`/`PositionView` спроектированы заново с ДРУГИМ
 * составом полей, авторский state-слот и его дженерик — ни одного из этого surface `017.3` не
 * обещал. Оставить гейт на `017.3` значило бы разрешить манифесту заявить версию, которая
 * описывает форму E1, уже не существующую в этом пакете. См. `EVENT_DRIVEN_MIN_CONTRACT_VERSION`
 * (`research-contract/event-driven.ts`) — фактический гейт, эта константа лишь мирроит его отсюда.
 */
export const CONTRACT_VERSION = '017.4' as const;

/** Supported research contract versions (back-compat: `017.1`–`017.3` manifests remain valid). */
export const SUPPORTED_CONTRACT_VERSIONS = ['017.1', '017.2', '017.3', '017.4'] as const;

/**
 * @deprecated Для нового авторства не использовать — см. `MARKET_DATA_KINDS` ниже
 * (`MarketDataRequirement`, форма `event_driven`, 083 S1 задача 3).
 *
 * Эта КОПИЯ — только реэкспорт значения наружу (`src/index.ts`); поведение валидатора она НЕ
 * определяет. Действующий экземпляр, который `platformContractContext().supportedMarketDataKinds`
 * реально передаёт в `validate-module.ts` для проверки `unsupported_market_data_kind` (легаси
 * `DataNeedsDeclaration`-флаги манифестов `017.1`–`017.3`), — отдельно объявленная копия в
 * `research-contract/catalogs.ts::SUPPORTED_MARKET_DATA_KINDS`; тег `@deprecated` там несёт то же
 * значение («не для нового кода», НЕ «сломано» — этот механизм остаётся действующим, пока
 * `017.1`–`017.3` валидны) и разбирает оба смысла подробно. Имя `SUPPORTED_MARKET_DATA_KINDS`
 * сохранено байт-в-байт в ОБЕИХ копиях — удалять нельзя.
 */
export const SUPPORTED_MARKET_DATA_KINDS = [
  'openInterest',
  'liquidations',
  'funding',
  'taker',
] as const;

/**
 * 083 S1 задача 3 — закрытый каталог видов рыночных данных `MarketDataRequirement` (форма
 * `event_driven`; согласован по смыслу с шестью market-событиями задачи 2 —
 * `market.candle.closed`/`market.open_interest.observed`/`market.liquidations.bucket_closed`/
 * `market.taker_volume.bucket_closed`/`market.funding.observed`, минус generic
 * `market.subscription.status_changed`, который не носитель значения и требования не имеет).
 * Решение владельца 2026-08-06: мигрировать с camelCase-четвёрки `SUPPORTED_MARKET_DATA_KINDS` на
 * snake_case-пятёрку спеки (`candles` добавлен, спека новее и прошла ревью). Тип ВЫВОДИТСЯ из
 * массива — добавление вида остаётся ОДНОЙ правкой, а не «не забыть поправить список»
 * (двусторонняя гарантия согласованности с union'ом `MarketDataRequirement['kind']` —
 * `research-contract/event-driven.ts`, та же идиома, что `ACTOR_INPUT_EVENT_KINDS`).
 */
export const MARKET_DATA_KINDS = [
  'candles',
  'open_interest',
  'liquidations',
  'taker_volume',
  'funding',
] as const;

/** Вид `MarketDataRequirement` — см. `MARKET_DATA_KINDS`. */
export type MarketDataKind = (typeof MARKET_DATA_KINDS)[number];

/**
 * 083 S1 задача 6 (§3.8.2) — нормативный ранг вида рыночного НАБЛЮДЕНИЯ внутри merge key
 * диспетча актора. Единственный источник порядка: экспортирован из `sdk`, чтобы `@trdlabs/engine`
 * и `backtester` не завели каждый свою копию (§3.8.2 явно требует «нормативный ключ, а не
 * сохранённый глобальный ingest sequence» — разъехавшиеся копии ранга были бы ровно тем самым
 * несогласованным вторым источником). Сам scheduler, читающий эту константу, — S2
 * (`@trdlabs/engine`); здесь только константа и её документация (задача 6 не реализует
 * диспетчер).
 *
 * **Нормативный порядок целиком** (переписан из спеки control-center `docs/superpowers/specs/
 * 2026-08-04-event-driven-actor-contract-design.md` §3.8.1, чтобы жить в коде, а не только в
 * спеке):
 *
 * ```text
 * priority:
 *   1. execution-события (fill, order.accepted/rejected, canceled, cancel.rejected)
 *   2. due-таймеры
 *   3. рыночные наблюдения: open_interest → liquidations → taker_volume → funding
 *   4. market.candle.closed
 *   5. каскад команд
 * ```
 *
 * **Полный merge key** (§3.8.2), после которого `seq` назначает scheduler (`seq` — производная
 * ключа, не независимый источник порядка):
 *
 * ```text
 * mergeKey = (
 *   businessTsUs,
 *   phasePriority,          // приоритет фазы из таблицы выше
 *   marketKindRank,         // эта константа — только для фаз 3–4
 *   stableSubscriptionId,
 *   sourceSequence          // локальный порядок ВНУТРИ одной подписки
 * )
 * ```
 *
 * **Почему свеча последней.** `market.candle.closed` служит КАНОНИЧЕСКОЙ точкой решения: к её
 * вызову актор уже видел open_interest, ликвидации, taker и funding этого frontier — ровно то,
 * что раньше давал атомарный минутный снимок, но без снимка. Каноническая — не значит
 * единственная: порядок не запрещает нативному актору торговать на `open_interest` или `funding`
 * раньше свечи; отдельный запрет (readiness-гейт, политика профиля) из одного лишь порядка не
 * следует.
 *
 * `stableSubscriptionId` в merge key ОБЯЗАН быть каноническим стабильным идентификатором из
 * `ActorSubscriptionDescriptor.subscriptionId` (`research-contract/event-driven.ts`) — случайный
 * UUID времени запуска в роли tie-break делает порядок невоспроизводимым между прогонами с одним
 * и тем же seed.
 *
 * Ключи — РОВНО каталог `MARKET_DATA_KINDS` (проверено программно в тестах, не только типом
 * `Record<MarketDataKind, number>` ниже, который уже отвергает лишний/пропущенный ключ на этапе
 * типов через excess-property-check объектного литерала). Добавление вида в закрытый каталог §3.3
 * или перестановка рангов меняет наблюдаемый trace ⇒ бамп контракта (та же дисциплина, что уже
 * применена к `ACTOR_INPUT_EVENT_KINDS`).
 */
export const MARKET_KIND_RANK: Readonly<Record<MarketDataKind, number>> = {
  open_interest: 1,
  liquidations: 2,
  taker_volume: 3,
  funding: 4,
  candles: 5,
};
