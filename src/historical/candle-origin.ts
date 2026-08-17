// @trdlabs/sdk/historical — происхождение свечей покрытия (cc#365).
//
// Wire-типы объявлены ЗДЕСЬ и вручную, а не импортированы из платформы: контракт, выведенный из
// одной реализации, краснеет только вместе с ней. Настоящая сверка — conformance-харнессом против
// ОБОИХ бэкендов, real и mock.
//
// ## Зачем это существует
//
// В канонической строке атрибуция источников есть у открытого интереса и ликвидаций
// (`oiSourceMask`, `liqSourceMask`), а у СВЕЧИ нет ни одного поля. Потребитель, получивший сутки,
// не может узнать, чья это цена — и не может сверить её с тем, что требует стратегия.
//
// ## Форма: сумма, а не пара полей
//
// Имя венью выразимо ТОЛЬКО внутри `kind: 'venue'`, а `venue` и означает однородность. Состояние
// «имя есть, а про однородность неизвестно» здесь не запрещено — оно НЕПРЕДСТАВИМО.
//
// Пара независимых полей (`candleVenue?` + `candleVenueHomogeneous?`) его допускала бы, и ловить
// пришлось бы проверкой на границе. Разница принципиальная: пока форма допускает дурное состояние,
// оно рано или поздно возникает — при рассинхроне версий, при частичной сериализации, у продюсера,
// который про правило не знал. Форма, в которой его нельзя выразить, не нуждается в правиле.
//
// ## Три факта, и ни один не сводится к другому
//
//   venue    — цена из ОДНОГО источника, он назван. Однородность доказана;
//   mixed    — источников было несколько, и вот какие. Это ЗНАНИЕ, а не отсутствие знания;
//   unknown  — доказательства нет, и названа причина.
//
// `mixed` в `unknown` не сворачивается. Потребитель, склеивший их, теряет установленное: список
// венью уже вычислен тем, кто отказ породил, и заставлять владельца датасета выяснять состав
// заново — терять работу, которая уже сделана.

/**
 * Закрытый словарь венью. Без нормализации и алиасов: `binance` и `BINANCE` — разные строки, и
 * вторая недопустима. Открытая строка через месяц дала бы три написания в трёх репозиториях.
 *
 * Тот же набор независимо сложился у CHD-конвейера, у писателя платформы и у потребителя.
 */
export const PRICE_SOURCE_VENUES = [
  'aster', 'binance', 'bitget', 'bybit', 'hyperliquid', 'okx',
] as const;

export type PriceSourceVenue = (typeof PRICE_SOURCE_VENUES)[number];

export function isPriceSourceVenue(v: unknown): v is PriceSourceVenue {
  return typeof v === 'string' && (PRICE_SOURCE_VENUES as readonly string[]).includes(v);
}

/**
 * Причины отсутствия доказательства. Пять, и они делятся на две группы, что важнее их числа.
 *
 * **Про АРХИВ** — сервер посмотрел и говорит, что нашёл:
 *   no_files       — суток нет вовсе;
 *   not_declared   — файлы есть, происхождение хотя бы у одного не объявлено;
 *   invalid_value  — объявление есть, но испорчено.
 *
 * **Про КАНАЛ** — наблюдение самого клиента, сервер о них не сообщает:
 *   not_reported   — сервер про происхождение не сказал НИЧЕГО. Это платформа старше cc#365;
 *   malformed      — сказал, но в форме, которой контракт не знает.
 *
 * Схлопнуть `not_reported` в `not_declared` — самая дорогая из возможных здесь ошибок: она
 * превращает «мы разговариваем со старым сервером» в «у ваших данных нет происхождения», и
 * владелец датасета пойдёт чинить архив вместо того, чтобы обновить платформу.
 *
 * Поэтому же `not_reported` и `malformed` НЕ принимаются от сервера (см. `parseCandleOrigin`):
 * это утверждения клиента о том, что он увидел, и сервер их сделать не может по построению.
 */
export type CandleOriginUnknownReason =
  | 'no_files'
  | 'not_declared'
  | 'invalid_value'
  | 'not_reported'
  | 'malformed';

/** Причины, которые вправе назвать сервер: только факты об архиве. */
export const CANDLE_ORIGIN_ARCHIVE_REASONS = ['no_files', 'not_declared', 'invalid_value'] as const;

/** Причины, которые устанавливает клиент по виду ответа. Сервер их не эмитит. */
export const CANDLE_ORIGIN_CHANNEL_REASONS = ['not_reported', 'malformed'] as const;

export type CandleOrigin =
  | { readonly kind: 'venue'; readonly venue: PriceSourceVenue }
  | { readonly kind: 'mixed'; readonly venues: readonly PriceSourceVenue[] }
  | { readonly kind: 'unknown'; readonly reason: CandleOriginUnknownReason };

const unknown = (reason: CandleOriginUnknownReason): CandleOrigin => ({ kind: 'unknown', reason });

const isArchiveReason = (v: unknown): v is 'no_files' | 'not_declared' | 'invalid_value' =>
  typeof v === 'string' && (CANDLE_ORIGIN_ARCHIVE_REASONS as readonly string[]).includes(v);

/**
 * Разбор происхождения из ответа сервера — fail-closed на каждом шаге.
 *
 * Отсутствие поля (`undefined`) даёт `not_reported`, а НЕ `not_declared`: «сервер ничего не
 * сказал» и «сервер сказал, что файлы молчат» — разные факты, и первый лечится обновлением
 * платформы, а второй не лечится вовсе.
 *
 * `null` тоже `not_reported`: сериализаторы отдают отсутствующее значение и так, и так, и
 * различать их значило бы делать вывод из формы JSON-кодировщика.
 *
 * Всё, что не разобралось, — `malformed`, а не «наверное это венью». Одна попытка угадать здесь
 * даёт правдоподобное имя вместо честного отказа, а правдоподобное хуже отсутствующего: его не
 * перепроверяют.
 */
export function parseCandleOrigin(raw: unknown): CandleOrigin {
  if (raw === undefined || raw === null) return unknown('not_reported');
  if (typeof raw !== 'object' || Array.isArray(raw)) return unknown('malformed');
  const o = raw as Record<string, unknown>;

  if (o['kind'] === 'venue') {
    return isPriceSourceVenue(o['venue']) ? { kind: 'venue', venue: o['venue'] } : unknown('malformed');
  }

  if (o['kind'] === 'mixed') {
    const vs = o['venues'];
    if (!Array.isArray(vs)) return unknown('malformed');
    // Меньше двух — не `mixed`: у однородного случая уже есть свой конструктор, и второй способ
    // сказать то же самое означал бы продюсера, пишущего не по правилу.
    if (vs.length < 2) return unknown('malformed');
    if (!vs.every(isPriceSourceVenue)) return unknown('malformed');
    if (new Set(vs as readonly string[]).size !== vs.length) return unknown('malformed');
    return { kind: 'mixed', venues: [...(vs as readonly PriceSourceVenue[])].sort() };
  }

  if (o['kind'] === 'unknown') {
    // Канальную причину от сервера не принимаем: `not_reported` означает «сервер промолчал», а
    // сервер, который её произносит, себе противоречит — он не молчит.
    return isArchiveReason(o['reason']) ? unknown(o['reason']) : unknown('malformed');
  }

  return unknown('malformed');
}

/**
 * Происхождение свечей записи покрытия.
 *
 * Вынесено функцией, а не полем типа `CandleOrigin` в `HistoricalCoverageEntry`, намеренно: клиент
 * отдаёт тело ответа как есть, и типизированное поле было бы УТВЕРЖДЕНИЕМ, которого никто не
 * проверял. Тип, обещающий больше, чем проверено, — тот же класс, что и подстановка дефолта:
 * читатель верит, потому что компилятор не спорит.
 */
export function coverageEntryCandleOrigin(entry: { readonly candleOrigin?: unknown }): CandleOrigin {
  return parseCandleOrigin(entry.candleOrigin);
}
