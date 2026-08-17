// cc#365 — происхождение свечей покрытия: словарь, форма, разбор.
//
// Предмет — не «поле парсится», а четыре различения, каждое из которых можно потерять, не сломав
// ни одного другого теста:
//
//   1. «сервер промолчал» ≠ «сервер сказал: файлы молчат» — первое лечится обновлением платформы;
//   2. `mixed` ≠ `unknown` — перечень венью это знание, а не его отсутствие;
//   3. словарь закрыт и не нормализуется;
//   4. непонятое НИКОГДА не угадывается — только `malformed`.
//
// Run: npx tsx --test test/candle-origin.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_SOURCE_VENUES,
  CANDLE_ORIGIN_ARCHIVE_REASONS,
  CANDLE_ORIGIN_CHANNEL_REASONS,
  isPriceSourceVenue,
  parseCandleOrigin,
  coverageEntryCandleOrigin,
  type CandleOrigin,
} from '../src/historical/index.js';

const reasonOf = (o: CandleOrigin): string => (o.kind === 'unknown' ? o.reason : `не-unknown:${o.kind}`);

test('словарь закрыт, согласован тремя репозиториями', () => {
  assert.deepEqual([...PRICE_SOURCE_VENUES].sort(), [
    'aster', 'binance', 'bitget', 'bybit', 'hyperliquid', 'okx',
  ]);
});

test('РАЗДЕЛЯЮЩАЯ: словарь без нормализации — BINANCE не то же, что binance', () => {
  assert.equal(isPriceSourceVenue('binance'), true);
  assert.equal(isPriceSourceVenue('BINANCE'), false);
  assert.equal(isPriceSourceVenue('binance-futures'), false);
});

test('ГЛАВНАЯ РАЗДЕЛЯЮЩАЯ: поля нет — not_reported, а НЕ not_declared', () => {
  // Самая дорогая из возможных здесь ошибок: она превращает «мы разговариваем со старым
  // сервером» в «у ваших данных нет происхождения», и владелец идёт чинить архив вместо
  // того, чтобы обновить платформу.
  assert.equal(reasonOf(parseCandleOrigin(undefined)), 'not_reported');
  assert.equal(reasonOf(parseCandleOrigin(null)), 'not_reported');
  assert.notEqual(reasonOf(parseCandleOrigin(undefined)), 'not_declared');
});

test('РАЗДЕЛЯЮЩАЯ: запись покрытия без поля даёт ту же причину', () => {
  assert.equal(reasonOf(coverageEntryCandleOrigin({ symbol: 'BTCUSDT' } as never)), 'not_reported');
  assert.equal(
    reasonOf(coverageEntryCandleOrigin({ candleOrigin: { kind: 'unknown', reason: 'not_declared' } })),
    'not_declared',
  );
});

test('ГЛАВНАЯ РАЗДЕЛЯЮЩАЯ: сервер не вправе назвать КАНАЛЬНУЮ причину', () => {
  // `not_reported` означает «сервер промолчал»; сервер, который её произносит, себе противоречит.
  for (const r of CANDLE_ORIGIN_CHANNEL_REASONS) {
    assert.equal(reasonOf(parseCandleOrigin({ kind: 'unknown', reason: r })), 'malformed',
      `канальная причина ${r} не должна приниматься от сервера`);
  }
});

test('причины про архив принимаются как есть', () => {
  for (const r of CANDLE_ORIGIN_ARCHIVE_REASONS) {
    assert.equal(reasonOf(parseCandleOrigin({ kind: 'unknown', reason: r })), r);
  }
});

test('предусловие: множества причин не пересекаются', () => {
  const a = new Set<string>(CANDLE_ORIGIN_ARCHIVE_REASONS);
  assert.ok(CANDLE_ORIGIN_CHANNEL_REASONS.every((r) => !a.has(r)),
    'иначе предыдущая проверка не различала бы ничего');
});

test('одна венью — kind venue, имя названо', () => {
  const o = parseCandleOrigin({ kind: 'venue', venue: 'bybit' });
  assert.equal(o.kind, 'venue');
  assert.equal(o.kind === 'venue' ? o.venue : null, 'bybit');
});

test('ГЛАВНАЯ РАЗДЕЛЯЮЩАЯ: у venue нет отдельного поля однородности — состояние непредставимо', () => {
  // Пара полей (venue? + homogeneous?) допускала бы «имя есть, про однородность неизвестно», и
  // ловить это пришлось бы проверкой на границе. Здесь ловить нечего: поля просто нет.
  const o = parseCandleOrigin({ kind: 'venue', venue: 'bybit', candleVenueHomogeneous: false });
  assert.deepEqual(Object.keys(o).sort(), ['kind', 'venue']);
});

test('несколько венью — kind mixed, перечень назван и отсортирован', () => {
  const o = parseCandleOrigin({ kind: 'mixed', venues: ['okx', 'binance'] });
  assert.equal(o.kind, 'mixed');
  assert.deepEqual(o.kind === 'mixed' ? [...o.venues] : [], ['binance', 'okx']);
});

test('РАЗДЕЛЯЮЩАЯ: перечень сортируется — два ответа по одним суткам совпадают', () => {
  const a = parseCandleOrigin({ kind: 'mixed', venues: ['okx', 'binance'] });
  const b = parseCandleOrigin({ kind: 'mixed', venues: ['binance', 'okx'] });
  assert.deepEqual(a, b);
});

test('ГЛАВНАЯ РАЗДЕЛЯЮЩАЯ: mixed и unknown различимы, хотя оба «не одна венью»', () => {
  const mixed = parseCandleOrigin({ kind: 'mixed', venues: ['binance', 'bybit'] });
  const unk = parseCandleOrigin({ kind: 'unknown', reason: 'not_declared' });
  assert.notEqual(mixed.kind, unk.kind);
  assert.deepEqual(mixed.kind === 'mixed' ? [...mixed.venues] : [], ['binance', 'bybit'],
    'перечень обязан доехать до потребителя, а не потеряться в «не доказано»');
});

test('РАЗДЕЛЯЮЩАЯ: mixed из одного элемента — malformed, второго способа сказать то же нет', () => {
  assert.equal(reasonOf(parseCandleOrigin({ kind: 'mixed', venues: ['bybit'] })), 'malformed');
  assert.equal(reasonOf(parseCandleOrigin({ kind: 'mixed', venues: [] })), 'malformed');
});

test('РАЗДЕЛЯЮЩАЯ: дубль внутри перечня — malformed', () => {
  assert.equal(reasonOf(parseCandleOrigin({ kind: 'mixed', venues: ['bybit', 'bybit'] })), 'malformed');
});

test('РАЗДЕЛЯЮЩАЯ: чужое имя не пропускается насквозь — ни в venue, ни в перечне', () => {
  assert.equal(reasonOf(parseCandleOrigin({ kind: 'venue', venue: 'BINANCE' })), 'malformed');
  assert.equal(reasonOf(parseCandleOrigin({ kind: 'venue', venue: 'kraken' })), 'malformed');
  assert.equal(reasonOf(parseCandleOrigin({ kind: 'mixed', venues: ['bybit', 'kraken'] })), 'malformed');
});

test('РАЗДЕЛЯЮЩАЯ: venue без имени — malformed, а не venue с пустым значением', () => {
  assert.equal(reasonOf(parseCandleOrigin({ kind: 'venue' })), 'malformed');
  assert.equal(reasonOf(parseCandleOrigin({ kind: 'venue', venue: null })), 'malformed');
  assert.equal(reasonOf(parseCandleOrigin({ kind: 'venue', venue: '' })), 'malformed');
});

test('непонятое НИКОГДА не угадывается', () => {
  for (const raw of [
    { kind: 'homogeneous' },            // незнакомый дискриминатор
    { kind: 'unknown' },                // без причины
    { kind: 'unknown', reason: 'why' }, // причина вне набора
    { venue: 'bybit' },                 // без дискриминатора
    ['bybit'],                          // массив
    'bybit',                            // голая строка
    42,
    true,
  ]) {
    assert.equal(reasonOf(parseCandleOrigin(raw)), 'malformed', `угадано вместо отказа: ${JSON.stringify(raw)}`);
  }
});

test('РАЗДЕЛЯЮЩАЯ: голая строка с именем венью тоже malformed — форма важна, не только значение', () => {
  // Соблазнительная «совместимость»: сервер прислал просто "bybit". Принять её значило бы
  // завести второй формат, который через версию разойдётся с первым.
  assert.equal(reasonOf(parseCandleOrigin('bybit')), 'malformed');
});

test('разбор чистый — вход не мутируется', () => {
  const raw = { kind: 'mixed', venues: ['okx', 'binance'] };
  parseCandleOrigin(raw);
  assert.deepEqual(raw.venues, ['okx', 'binance'], 'сортировка обязана идти по копии');
});
