// Д3 — целостность ключа дня: классификация по ТОЧНОЙ тройке и её последствия.
//
// Предмет проверки — не «умеем разобрать тело», а два свойства, ради которых
// разбор и заводился: распознанный отказ НЕ повторяется, а не распознанный
// остаётся обычным HTTP-отказом и ведёт себя по-прежнему.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DAY_INTEGRITY_CODE,
  HistoricalClient,
  HistoricalDayIntegrityError,
  classifyDayIntegrityResponse,
} from '../src/historical/index.js';

const DATE = '2026-08-12';
const SYMBOL = '0GUSDT';
const MINUTE_TS = 1_786_570_440_000;

/** Каноническое тело отказа — ровно то, что отдаёт платформа. */
const body = (over: Record<string, unknown> = {}) => ({
  error: 'day integrity violated',
  code: DAY_INTEGRITY_CODE,
  permanent: true,
  retryFromStart: false,
  date: DATE,
  symbol: SYMBOL,
  minuteTs: MINUTE_TS,
  generation: 3,
  ...over,
});

/** Тело настоящего `generation changed` — второй факт под тем же 409. */
const generationChangedBody = {
  error: 'generation changed',
  date: DATE,
  requestedGeneration: 2,
  currentGeneration: 3,
  retryFromStart: true,
};

test('точная тройка: 409 + code + полная форма → нарушение разобрано', () => {
  const v = classifyDayIntegrityResponse(409, body());
  assert.ok(v);
  assert.equal(v.date, DATE);
  assert.equal(v.symbol, SYMBOL);
  assert.equal(v.minuteTs, MINUTE_TS);
  assert.equal(v.generation, 3);
});

test('generation=null — день без sidecar, законный случай', () => {
  assert.equal(classifyDayIntegrityResponse(409, body({ generation: null }))?.generation, null);
});

test('чужой статус при знакомом коде — НЕ отказ целостности', () => {
  // Знакомый код с чужим статусом означает, что отвечал не наш сервис. Приняв
  // это за отказ, клиент перестал бы повторять ровно там, где повтор нужен:
  // 500 и 503 транзиентны.
  for (const status of [200, 400, 500, 503]) {
    assert.equal(classifyDayIntegrityResponse(status, body()), null, `статус ${status}`);
  }
});

test('второй факт под тем же 409 не перехватывается', () => {
  // `generation changed` разрешается перечитыванием с начала. Спутать его с
  // постоянным отказом значит объявить мёртвым день, который просто переиздан.
  assert.equal(classifyDayIntegrityResponse(409, generationChangedBody), null);
});

test('форма тела: лишнее и недостающее поле одинаково отвергаются', () => {
  assert.equal(classifyDayIntegrityResponse(409, { ...body(), extra: 1 }), null, 'лишнее поле');
  const short = body();
  delete (short as Record<string, unknown>)['symbol'];
  assert.equal(classifyDayIntegrityResponse(409, short), null, 'недостающее поле');
});

test('постоянство проверяется, а не выводится из кода', () => {
  // Ответ, называющий себя повторяемым, отказом целостности не является — что
  // бы ни стояло в `code`.
  assert.equal(classifyDayIntegrityResponse(409, body({ permanent: false })), null);
  assert.equal(classifyDayIntegrityResponse(409, body({ retryFromStart: true })), null);
});

test('типы полей проверяются', () => {
  assert.equal(classifyDayIntegrityResponse(409, body({ date: '12.08.2026' })), null);
  assert.equal(classifyDayIntegrityResponse(409, body({ symbol: '' })), null);
  assert.equal(classifyDayIntegrityResponse(409, body({ minuteTs: '1786570440000' })), null);
  assert.equal(classifyDayIntegrityResponse(409, body({ generation: 1.5 })), null);
});

test('не-объект не роняет классификатор', () => {
  for (const raw of [null, undefined, 'текст', 42, [body()]]) {
    assert.equal(classifyDayIntegrityResponse(409, raw), null);
  }
});

// ── Поведение клиента ────────────────────────────────────────────────────────

const mkClient = (respond: () => Response, over: Record<string, unknown> = {}) => {
  let calls = 0;
  const client = new HistoricalClient({
    baseUrl: 'http://p',
    maxAttempts: 3,
    sleepImpl: async () => {},
    fetchImpl: (async () => { calls += 1; return respond(); }) as unknown as typeof globalThis.fetch,
    ...over,
  });
  return { client, calls: () => calls };
};

const json = (status: number, b: unknown) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

test('queryRows: распознанный отказ → типизированная ошибка, вызов НЕ повторяется', async () => {
  const { client, calls } = mkClient(() => json(409, body()));
  let err: unknown;
  try {
    for await (const _ of client.queryRows({ symbols: [SYMBOL] })) { /* не дойдёт */ }
  } catch (e) { err = e; }

  assert.ok(err instanceof HistoricalDayIntegrityError);
  assert.equal(err.date, DATE);
  assert.equal(err.symbol, SYMBOL);
  assert.equal(err.minuteTs, MINUTE_TS);
  assert.equal(err.retryable, false);
  // Non-retryable — локальное свойство ОДНОГО вызова: повтор этого запроса даст
  // тот же ответ. Три попытки здесь означали бы три одинаковых отказа подряд.
  assert.equal(calls(), 1);
});

test('сообщение сохраняет форму `HTTP 409` — классификаторы по тексту не ломаются', async () => {
  const { client } = mkClient(() => json(409, body()));
  let err: Error | undefined;
  try {
    for await (const _ of client.queryRows({ symbols: [SYMBOL] })) { /* не дойдёт */ }
  } catch (e) { err = e as Error; }
  assert.match(err!.message, /HTTP 409/);
  assert.match(err!.message, /historical\/rows/);
});

test('нераспознанный 409 остаётся обычной ошибкой и тоже не повторяется', async () => {
  const { client, calls } = mkClient(() => json(409, generationChangedBody));
  let err: Error | undefined;
  try {
    for await (const _ of client.queryRows({ symbols: [SYMBOL] })) { /* не дойдёт */ }
  } catch (e) { err = e as Error; }
  assert.ok(!(err instanceof HistoricalDayIntegrityError));
  assert.match(err!.message, /HTTP 409/);
  assert.equal(calls(), 1);
});

test('транзиентные статусы по-прежнему повторяются — путь не подменён', async () => {
  // Разделяющая проверка: иначе «не повторяем отказ целостности» незаметно
  // превратилось бы в «не повторяем ничего».
  const { client, calls } = mkClient(() => json(503, { error: 'unavailable' }));
  try {
    for await (const _ of client.queryRows({ symbols: [SYMBOL] })) { /* не дойдёт */ }
  } catch { /* ожидаемо */ }
  assert.equal(calls(), 3);
});

test('непарсящееся тело 409 не роняет клиента', async () => {
  // Тело читается через `.catch(() => undefined)`: страница ошибки от прокси —
  // не JSON, и падать на ней разбором нельзя.
  const { client, calls } = mkClient(() => new Response('<html>502</html>', { status: 409 }));
  let err: Error | undefined;
  try {
    for await (const _ of client.queryRows({ symbols: [SYMBOL] })) { /* не дойдёт */ }
  } catch (e) { err = e as Error; }
  assert.ok(!(err instanceof HistoricalDayIntegrityError));
  assert.match(err!.message, /HTTP 409/);
  assert.equal(calls(), 1);
});
