// Д3 (3.3б) — четыре состояния доступности и пять различимых кодов отказа.
//
// Ожидания выписаны ЗДЕСЬ и руками. Взять их у платформенной реализации значило
// бы получить oracle, который краснеет только вместе с ней: сверка real/mock
// делается conformance-харнессом, а этот файл защищает разбор на стороне SDK.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HistoricalClient,
  PREFLIGHT_REJECT_CODES,
  isPreflightRejectCode,
  parseAvailabilityDescriptor,
} from '../src/historical/index.js';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(handler: (url: string) => Response): HistoricalClient {
  return new HistoricalClient({
    baseUrl: 'http://platform',
    fetchImpl: (async (url: string | URL) => handler(String(url))) as typeof globalThis.fetch,
    maxAttempts: 1,
  });
}

test('четыре состояния разбираются как четыре, а не как «есть/нет»', () => {
  assert.equal(parseAvailabilityDescriptor({ state: 'not_initialized' }).state, 'not_initialized');
  assert.equal(parseAvailabilityDescriptor({ state: 'invalid', reason: 'битый' }).state, 'invalid');

  const empty = parseAvailabilityDescriptor({
    state: 'empty', earliestAvailableDay: null, lastContiguousClosedDay: null, days: 0, datasetId: null, builtAtMs: 7,
  });
  assert.equal(empty.state, 'empty');
  assert.notEqual(empty.state, 'not_initialized');

  const ready = parseAvailabilityDescriptor({
    state: 'ready',
    earliestAvailableDay: '2026-06-10',
    lastContiguousClosedDay: '2026-06-12',
    days: 3,
    datasetId: 'ds-1',
    builtAtMs: 7,
  });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.state === 'ready' ? ready.lastContiguousClosedDay : null, '2026-06-12');
});

test('незнакомое состояние — invalid с причиной, а не not_initialized', () => {
  // «Сервер сказал что-то, чего я не понимаю» и «индекса нет» — разные факты.
  // Приняв первое за второе, потребитель объявил бы незавершённой выкатку,
  // которая давно завершена.
  const r = parseAvailabilityDescriptor({ state: 'какое-то новое' });
  assert.equal(r.state, 'invalid');
  assert.match(r.state === 'invalid' ? r.reason : '', /неизвестное состояние/);

  assert.equal(parseAvailabilityDescriptor(undefined).state, 'invalid');
  assert.equal(parseAvailabilityDescriptor({ state: 'ready' }).state, 'invalid'); // ready без границ
});

test('preflight: успех только у ready', async () => {
  const success = {
    ok: true,
    requestedFromMs: 1, requestedToMs: 2,
    effectiveFromMs: 1, effectiveToMs: 2,
    availableFromMs: 0, availableToMs: 9,
    earliestAvailableDay: '2026-06-10', lastContiguousClosedDay: '2026-06-12',
    archiveId: 'arch-1', datasetId: 'ds-1',
    availabilityId: `sha256:${'a'.repeat(64)}`, asOfMs: 5, clamped: false,
  };
  const c = clientWith(() => jsonResponse(200, success));
  const r = await c.preflight(1, 2);
  assert.equal(r.ok, true);
  assert.deepEqual(r, success);
});

test('три состояния индекса дают ТРИ РАЗНЫХ кода, а не одно исключение', async () => {
  const cases: ReadonlyArray<[number, string, string]> = [
    [503, 'AVAILABILITY_NOT_INITIALIZED', 'not_initialized'],
    [503, 'AVAILABILITY_INVALID', 'invalid'],
    [409, 'AVAILABILITY_EMPTY', 'empty'],
  ];
  const codes = new Set<string>();
  for (const [status, code, state] of cases) {
    const c = clientWith(() => jsonResponse(status, { ok: false, code, message: 'm', availabilityState: state }));
    const r = await c.preflight(1, 2);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, code);
    assert.equal(r.status, status);
    assert.equal(r.availabilityState, state);
    codes.add(r.code);
  }
  assert.equal(codes.size, 3, 'коды обязаны различаться');
});

test('отказ допуска не ретраится, хотя приезжает с 503', async () => {
  // Обычная политика клиента считает 5xx временной ошибкой. Здесь 503 —
  // осознанное состояние сервиса: три попытки с backoff дадут тот же ответ и
  // потеряют по дороге код.
  let calls = 0;
  const c = new HistoricalClient({
    baseUrl: 'http://platform',
    maxAttempts: 3,
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse(503, {
        ok: false, code: 'AVAILABILITY_NOT_INITIALIZED', message: 'm', availabilityState: 'not_initialized',
      });
    }) as typeof globalThis.fetch,
  });
  const r = await c.preflight(1, 2);
  assert.equal(r.ok, false);
  assert.equal(calls, 1, 'распознанный код отказа не повторяется');
});

test('503 БЕЗ распознанного кода остаётся обычной ошибкой транспорта', async () => {
  // Разделяющий негатив: иначе «не ретраим отказ допуска» превратилось бы в
  // «не ретраим ничего», и настоящий сбой сервиса перестал бы переживаться.
  const c = clientWith(() => jsonResponse(503, { error: 'upstream down' }));
  await assert.rejects(() => c.preflight(1, 2), /HTTP 503/);
});

test('знакомый код с ЧУЖИМ статусом результатом допуска не считается', async () => {
  // Так отвечает прокси или страница ошибки, а не наш сервис. Приняв это за
  // законный отказ, клиент отключил бы повтор ровно там, где повтор и нужен.
  for (const status of [500, 502, 200, 404]) {
    const c = clientWith(() => jsonResponse(status, {
      ok: false, code: 'AVAILABILITY_INVALID', message: 'm', availabilityState: 'invalid',
    }));
    await assert.rejects(() => c.preflight(1, 2), new RegExp(`HTTP ${status}`),
      `статус ${status} с кодом AVAILABILITY_INVALID обязан остаться ошибкой транспорта`);
  }
});

test('повреждённое тело результатом допуска не считается', async () => {
  const base = { ok: false, code: 'AVAILABILITY_EMPTY', message: 'm', availabilityState: 'empty' };
  const broken: ReadonlyArray<[string, unknown]> = [
    ['лишнее поле', { ...base, extra: 1 }],
    ['нет message', { ok: false, code: 'AVAILABILITY_EMPTY', availabilityState: 'empty' }],
    ['message не строка', { ...base, message: 42 }],
    ['неизвестное availabilityState', { ...base, availabilityState: 'какое-то' }],
    ['нет ok', { code: 'AVAILABILITY_EMPTY', message: 'm', availabilityState: 'empty' }],
    ['тело — массив', [base]],
  ];
  for (const [label, body] of broken) {
    const c = clientWith(() => jsonResponse(409, body));
    await assert.rejects(() => c.preflight(1, 2), /HTTP 409/, label);
  }
});

test('успех тоже классифицируется по точной форме', async () => {
  const success = {
    ok: true,
    requestedFromMs: 1, requestedToMs: 2, effectiveFromMs: 1, effectiveToMs: 2,
    availableFromMs: 0, availableToMs: 9,
    earliestAvailableDay: '2026-06-10', lastContiguousClosedDay: '2026-06-12',
    archiveId: 'arch-1', datasetId: 'ds-1',
    availabilityId: `sha256:${'a'.repeat(64)}`, asOfMs: 5, clamped: false,
  };
  // Лишнее поле — не наш ответ.
  const extra = clientWith(() => jsonResponse(200, { ...success, surprise: true }));
  await assert.rejects(() => extra.preflight(1, 2), /HTTP 200/);
  // Пропавшее поле — тоже.
  const { availabilityId: _drop, ...missing } = success;
  const lacking = clientWith(() => jsonResponse(200, missing));
  await assert.rejects(() => lacking.preflight(1, 2), /HTTP 200/);
});

test('non-retryable — свойство ОДНОГО вызова, а не приговор состоянию', async () => {
  // not_initialized кончится выкаткой, invalid — починкой индекса. Новый вызов
  // после изменения состояния законен и обязан вернуть новый результат.
  let phase = 0;
  const c = new HistoricalClient({
    baseUrl: 'http://platform',
    maxAttempts: 1,
    fetchImpl: (async () => {
      phase += 1;
      return phase === 1
        ? jsonResponse(503, {
            ok: false, code: 'AVAILABILITY_NOT_INITIALIZED', message: 'm', availabilityState: 'not_initialized',
          })
        : jsonResponse(409, {
            ok: false, code: 'AVAILABILITY_EMPTY', message: 'm', availabilityState: 'empty',
          });
    }) as typeof globalThis.fetch,
  });
  const first = await c.preflight(1, 2);
  const second = await c.preflight(1, 2);
  assert.equal(first.ok === false ? first.code : null, 'AVAILABILITY_NOT_INITIALIZED');
  assert.equal(second.ok === false ? second.code : null, 'AVAILABILITY_EMPTY');
});

test('словарь кодов закрыт', () => {
  assert.equal(PREFLIGHT_REJECT_CODES.length, 5);
  assert.ok(isPreflightRejectCode('WINDOW_OUTSIDE_AVAILABLE'));
  assert.ok(!isPreflightRejectCode('WINDOW_TOO_BIG'));
});

test('availability() читает состояние из discover', async () => {
  const c = clientWith((url) => {
    assert.match(url, /\/historical\/discover$/);
    return jsonResponse(200, {
      historicalContractVersion: 'historical.2',
      resources: [], symbols: [], timeframes: [],
      availability: { state: 'not_initialized' },
    });
  });
  assert.equal((await c.availability()).state, 'not_initialized');
});

test('discover без блока availability — invalid, а не «всё хорошо»', async () => {
  const c = clientWith(() => jsonResponse(200, {
    historicalContractVersion: 'historical.2', resources: [], symbols: [], timeframes: [],
  }));
  const a = await c.availability();
  assert.equal(a.state, 'invalid');
});
