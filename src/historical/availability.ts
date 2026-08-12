// @trdlabs/sdk/historical — доступный интервал бэктеста и допуск окна (Д3, 3.3б).
//
// Wire-типы объявлены ЗДЕСЬ и вручную, а не импортированы из платформы: контракт,
// выведенный из одной реализации, краснеет только вместе с ней. Настоящая сверка
// делается conformance-харнессом против ОБОИХ бэкендов, real и mock.
//
// ЧЕТЫРЕ СОСТОЯНИЯ, И НИ ОДНО НЕ СВОДИТСЯ К ДРУГОМУ:
//
//   ready            — индекс есть, границы названы;
//   empty            — индекс есть и корректен, границ нет: закрытых дней ещё
//                      не было. Это ОПУБЛИКОВАННОЕ «доступного нет»;
//   not_initialized  — индекса нет вовсе: закрытие дней не запускалось;
//   invalid          — индекс есть, но ему нельзя верить.
//
// `empty` против `not_initialized` — это «мы знаем, что доступного нет» против
// «мы не знаем ничего». `invalid` против обоих — «сломано», и чинится иначе.
// Потребитель, схлопнувший их в «данных нет», не отличит пустой архив от
// ненастроенного сервиса, а тот от испорченного индекса.

/** Состояние индекса доступности, как его сообщает `/historical/discover`. */
export type HistoricalAvailability =
  | {
      readonly state: 'ready';
      /** Первый закрытый день, `YYYY-MM-DD`. */
      readonly earliestAvailableDay: string;
      /** Последний день непрерывного префикса закрытых дней. */
      readonly lastContiguousClosedDay: string;
      readonly days: number;
      readonly datasetId: string | null;
      readonly builtAtMs: number;
    }
  | {
      readonly state: 'empty';
      readonly earliestAvailableDay: null;
      readonly lastContiguousClosedDay: null;
      readonly days: number;
      readonly datasetId: string | null;
      readonly builtAtMs: number;
    }
  | { readonly state: 'not_initialized' }
  | { readonly state: 'invalid'; readonly reason: string };

/**
 * Коды отказа допуска. Их пять, и они НЕ взаимозаменяемы:
 *
 *   AVAILABILITY_NOT_INITIALIZED — доделать выкатку;
 *   AVAILABILITY_INVALID         — чинить индекс;
 *   AVAILABILITY_EMPTY           — ждать первого закрытого дня;
 *   WINDOW_MALFORMED             — исправить запрос;
 *   WINDOW_OUTSIDE_AVAILABLE     — исправить период.
 *
 * Первые три означают «сервису нечего разрешить», последние два — «запрос не
 * тот». Свести их к одному исключению значило бы заставить потребителя
 * разбирать текст сообщения, чтобы понять, чинить ему конфиг, данные или вызов.
 */
export type PreflightRejectCode =
  | 'AVAILABILITY_NOT_INITIALIZED'
  | 'AVAILABILITY_INVALID'
  | 'AVAILABILITY_EMPTY'
  | 'WINDOW_MALFORMED'
  | 'WINDOW_OUTSIDE_AVAILABLE';

export const PREFLIGHT_REJECT_CODES: readonly PreflightRejectCode[] = [
  'AVAILABILITY_NOT_INITIALIZED',
  'AVAILABILITY_INVALID',
  'AVAILABILITY_EMPTY',
  'WINDOW_MALFORMED',
  'WINDOW_OUTSIDE_AVAILABLE',
];

export function isPreflightRejectCode(v: unknown): v is PreflightRejectCode {
  return typeof v === 'string' && (PREFLIGHT_REJECT_CODES as readonly string[]).includes(v);
}

/**
 * ТОЧНЫЙ статус для каждого кода. Не «один из допустимых» — ровно один.
 *
 * 400 — виноват запрос; 409 — виноват момент (данных ещё или уже нет);
 * 503 — виноват сервис: он не может сказать, чем располагает.
 */
export const PREFLIGHT_STATUS_BY_CODE: Readonly<Record<PreflightRejectCode, number>> = {
  WINDOW_MALFORMED: 400,
  WINDOW_OUTSIDE_AVAILABLE: 409,
  AVAILABILITY_EMPTY: 409,
  AVAILABILITY_NOT_INITIALIZED: 503,
  AVAILABILITY_INVALID: 503,
};

export const AVAILABILITY_STATES = ['ready', 'empty', 'not_initialized', 'invalid'] as const;

/** Точный набор полей отказа. Лишнее поле — тоже расхождение контракта. */
const REJECT_KEYS = ['availabilityState', 'code', 'message', 'ok'] as const;
/** Точный набор полей успеха. */
const SUCCESS_KEYS = [
  'archiveId', 'asOfMs', 'availabilityId', 'availableFromMs', 'availableToMs', 'clamped',
  'datasetId', 'earliestAvailableDay', 'effectiveFromMs', 'effectiveToMs',
  'lastContiguousClosedDay', 'ok', 'requestedFromMs', 'requestedToMs',
] as const;

const sortedKeys = (o: Record<string, unknown>): string => Object.keys(o).sort().join(',');
const REJECT_SHAPE = [...REJECT_KEYS].sort().join(',');
const SUCCESS_SHAPE = [...SUCCESS_KEYS].sort().join(',');

/**
 * Классификация ответа допуска по ТОЧНОЙ тройке: статус + код + форма тела.
 *
 * `null` означает «это не результат допуска» — и тогда работает обычный путь
 * транспорта с ретраями. Различие принципиальное: знакомый код, приехавший с
 * ЧУЖИМ статусом или в повреждённом теле, — признак того, что отвечал не наш
 * сервис (прокси, балансировщик, страница ошибки), а вовсе не законный отказ
 * допуска. Приняв такое за отказ, клиент отключил бы повтор ровно там, где
 * повтор и нужен.
 */
export function classifyPreflightResponse(status: number, body: unknown): PreflightResult | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;

  if (o['ok'] === true) {
    if (status !== 200) return null;
    if (sortedKeys(o) !== SUCCESS_SHAPE) return null;
    return o as unknown as PreflightResult;
  }

  if (o['ok'] !== false) return null;
  const code = o['code'];
  if (!isPreflightRejectCode(code)) return null;
  if (status !== PREFLIGHT_STATUS_BY_CODE[code]) return null;
  if (sortedKeys(o) !== REJECT_SHAPE) return null;
  if (typeof o['message'] !== 'string') return null;
  const state = o['availabilityState'];
  if (typeof state !== 'string' || !(AVAILABILITY_STATES as readonly string[]).includes(state)) return null;

  return {
    ok: false,
    code,
    message: o['message'],
    availabilityState: state as HistoricalAvailability['state'],
    status,
  };
}

/**
 * Успешный допуск. Несёт и запрошенное окно, и фактическое, и признак обрезки —
 * тихо суженный период означал бы, что в evidence прогона записано одно, а
 * протестировано другое.
 *
 * Идентичность решения (`archiveId`, `datasetId`, `availabilityId`, `asOfMs`)
 * отвечает на вопрос «чем это разрешено»: без неё «мне разрешили период X»
 * нельзя ни воспроизвести, ни оспорить.
 */
export interface PreflightSuccess {
  readonly ok: true;
  readonly requestedFromMs: number;
  readonly requestedToMs: number;
  readonly effectiveFromMs: number;
  readonly effectiveToMs: number;
  readonly availableFromMs: number;
  readonly availableToMs: number;
  readonly earliestAvailableDay: string;
  readonly lastContiguousClosedDay: string;
  readonly archiveId: string | null;
  readonly datasetId: string | null;
  /** Содержательный адрес редакции индекса: `sha256:<hex>`. */
  readonly availabilityId: string;
  readonly asOfMs: number;
  readonly clamped: boolean;
}

export interface PreflightReject {
  readonly ok: false;
  readonly code: PreflightRejectCode;
  readonly message: string;
  /** Состояние индекса в момент отказа — для диагностики. */
  readonly availabilityState: HistoricalAvailability['state'];
  /** HTTP-статус ответа: 400 — запрос, 409 — момент, 503 — сервис. */
  readonly status: number;
}

export type PreflightResult = PreflightSuccess | PreflightReject;

/**
 * Разбор состояния доступности из ответа `/historical/discover`.
 *
 * Незнакомое или отсутствующее состояние даёт `invalid` с названной причиной, а
 * НЕ `not_initialized`: «сервер сказал что-то, чего я не понимаю» и «индекса
 * нет» — разные факты, и принимать первое за второе значит молча объявить
 * незавершённой выкатку, которая давно завершена.
 */
export function parseAvailabilityDescriptor(raw: unknown): HistoricalAvailability {
  if (raw === null || typeof raw !== 'object') {
    return { state: 'invalid', reason: 'discover не содержит блока availability' };
  }
  const o = raw as Record<string, unknown>;
  const state = o['state'];
  if (state === 'not_initialized') return { state: 'not_initialized' };
  if (state === 'invalid') {
    return { state: 'invalid', reason: typeof o['reason'] === 'string' ? o['reason'] : 'причина не названа' };
  }
  if (state !== 'ready' && state !== 'empty') {
    return { state: 'invalid', reason: `неизвестное состояние availability: ${JSON.stringify(state)}` };
  }
  const days = typeof o['days'] === 'number' ? o['days'] : 0;
  const datasetId = typeof o['datasetId'] === 'string' ? o['datasetId'] : null;
  const builtAtMs = typeof o['builtAtMs'] === 'number' ? o['builtAtMs'] : 0;
  if (state === 'empty') {
    return { state: 'empty', earliestAvailableDay: null, lastContiguousClosedDay: null, days, datasetId, builtAtMs };
  }
  const earliest = o['earliestAvailableDay'];
  const last = o['lastContiguousClosedDay'];
  if (typeof earliest !== 'string' || typeof last !== 'string') {
    return { state: 'invalid', reason: 'состояние ready без границ диапазона' };
  }
  return {
    state: 'ready',
    earliestAvailableDay: earliest,
    lastContiguousClosedDay: last,
    days,
    datasetId,
    builtAtMs,
  };
}
