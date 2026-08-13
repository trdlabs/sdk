// @trdlabs/sdk/historical — целостность ключа дня (Д3).
//
// Контракт чтения объявляет `(minute_ts, symbol)` тотальным порядком: на нём
// построен keyset-курсор `/historical/rows`. Платформа проверяет это над всем
// загруженным днём и до нарезки на страницы, а нарушение отдаёт отказом.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ТИП, А НЕ `HTTP 409`. Под 409 у этого эндпоинта живут два
// разных факта, и действия по ним противоположны:
//
//   generation changed  — день переиздан repair'ом; перечитать с начала, и всё
//                         получится;
//   DUPLICATE_ROW_KEY   — в дне две строки с одним ключом; перечитывать
//                         бессмысленно, пока данные не починены.
//
// Свести их к одному статусу значит заставить потребителя разбирать текст, а
// чаще — ретраить вечно то, что само не пройдёт.
//
// NON-RETRYABLE ЗДЕСЬ — ЛОКАЛЬНОЕ СВОЙСТВО ОДНОГО ВЫЗОВА, а не приговор
// операции. Повтор ЭТОГО запроса даст тот же ответ; но после repair с evidence
// тот же период станет читаемым, и запрещать обращаться к нему навсегда никто
// не вправе. Клиент обязан не повторять вызов сам, а не объявлять данные
// мёртвыми.

/** Точный набор полей тела отказа. Лишнее или недостающее поле — расхождение контракта. */
const INTEGRITY_KEYS = [
  'code', 'date', 'error', 'generation', 'minuteTs', 'permanent', 'retryFromStart', 'symbol',
] as const;

const INTEGRITY_SHAPE = [...INTEGRITY_KEYS].sort().join(',');
const sortedKeys = (o: Record<string, unknown>): string => Object.keys(o).sort().join(',');

/** Код отказа целостности. Пока один — но код в теле есть, и он проверяется. */
export const DAY_INTEGRITY_CODE = 'DUPLICATE_ROW_KEY' as const;

/** ТОЧНЫЙ статус. Не «один из 4xx» — ровно 409. */
export const DAY_INTEGRITY_STATUS = 409;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Разобранный отказ целостности дня.
 *
 * Адресует нарушение полностью: какой день, какой символ, какая минута и какое
 * поколение читалось. Без этого «день недостоверен» нельзя ни проверить, ни
 * передать в repair.
 */
export interface DayIntegrityViolation {
  readonly code: typeof DAY_INTEGRITY_CODE;
  readonly date: string;
  readonly symbol: string;
  readonly minuteTs: number;
  /** Поколение дня, либо `null` для дня без sidecar'а. */
  readonly generation: number | null;
  readonly status: number;
}

/**
 * Ошибка, которую клиент бросает вместо голого `HTTP 409`.
 *
 * Сообщение НАМЕРЕННО сохраняет форму `<label>: HTTP 409`: существующие
 * классификаторы разбирают текст, и менять его значило бы чинить одно, ломая
 * другое. Поля приезжают ДОПОЛНИТЕЛЬНО, а не вместо.
 */
export class HistoricalDayIntegrityError extends Error {
  readonly code: typeof DAY_INTEGRITY_CODE;
  readonly date: string;
  readonly symbol: string;
  readonly minuteTs: number;
  readonly generation: number | null;
  readonly status: number;
  /**
   * Повтор ЭТОГО вызова бессмыслен. Не «данные мертвы навсегда»: после repair с
   * evidence тот же период читается.
   */
  readonly retryable = false as const;

  constructor(message: string, v: DayIntegrityViolation) {
    super(message);
    this.name = 'HistoricalDayIntegrityError';
    this.code = v.code;
    this.date = v.date;
    this.symbol = v.symbol;
    this.minuteTs = v.minuteTs;
    this.generation = v.generation;
    this.status = v.status;
  }
}

/**
 * Классификация по ТОЧНОЙ тройке: статус + код + форма тела.
 *
 * `null` означает «это не отказ целостности» — и тогда работает обычный путь
 * транспорта. Различие принципиальное: знакомый код с чужим статусом или в
 * повреждённом теле — признак того, что отвечал не наш сервис (прокси,
 * балансировщик, страница ошибки), а не законный отказ. Приняв такое за отказ,
 * клиент перестал бы повторять ровно там, где повтор и нужен.
 */
export function classifyDayIntegrityResponse(status: number, body: unknown): DayIntegrityViolation | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;

  if (o['code'] !== DAY_INTEGRITY_CODE) return null;
  if (status !== DAY_INTEGRITY_STATUS) return null;
  if (sortedKeys(o) !== INTEGRITY_SHAPE) return null;

  // Постоянство объявлено в теле и проверяется, а не выводится из кода. Ответ,
  // называющий себя повторяемым, отказом целостности не является — что бы ни
  // стояло в `code`.
  if (o['permanent'] !== true || o['retryFromStart'] !== false) return null;

  const date = o['date'];
  const symbol = o['symbol'];
  const minuteTs = o['minuteTs'];
  const generation = o['generation'];
  if (typeof date !== 'string' || !DATE_RE.test(date)) return null;
  if (typeof symbol !== 'string' || symbol.length === 0) return null;
  if (typeof minuteTs !== 'number' || !Number.isFinite(minuteTs)) return null;
  if (generation !== null && (typeof generation !== 'number' || !Number.isInteger(generation))) return null;
  if (typeof o['error'] !== 'string') return null;

  return { code: DAY_INTEGRITY_CODE, date, symbol, minuteTs, generation, status };
}
