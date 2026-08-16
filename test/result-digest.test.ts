// Д5 — общий оракул паритета транспортов.
//
// Предмет проверки — НЕ «дайджест считается», а «дайджест различает ровно то, что различают
// данные, и отказывает там, где паритет неопределён». Оракул один на row-JSON, Arrow IPC и
// files+range; склеит два разных набора строк — расхождение транспортов станет невидимым,
// разведёт два одинаковых — замер будет ловить собственную нестабильность.
//
// Порт гейта 107 из platform. Каждый случай ниже РАЗДЕЛЯЮЩИЙ: пара входов, которые неверная
// реализация оценила бы одинаково.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANONICAL_ROW_V2_FIELDS,
  ResultDigestError,
  canonicalRowLine,
  checkAgainstExpectation,
  checkParity,
  computeResultDigest,
  digestsAgree,
} from '../src/historical/index.js';
import type { DigestRow, ResultExpectation } from '../src/historical/index.js';

const MIN = 60_000;
const T0 = Date.parse('2026-07-04T00:00:00Z');

const row = (over: Record<string, unknown> = {}): DigestRow => ({
  schema_version: 2,
  minute_ts: T0,
  symbol: 'BTCUSDT',
  open: 1, high: 2, low: 0.5, close: 1.5,
  volume: 10, turnover: 100,
  oi_total_usd: 1000,
  funding_rate: 0.0001,
  liq_long_usd: 5, liq_short_usd: 6,
  has_oi: true, has_funding: true, has_liquidations: true,
  taker_buy_volume_usd: 7, taker_sell_volume_usd: 8,
  has_taker_flow: true,
  ...over,
});

const digestOf = (rows: ReadonlyArray<DigestRow>): string => computeResultDigest(rows).sha256;

function threw(fn: () => unknown, code: string): boolean {
  try { fn(); return false; } catch (e) {
    return e instanceof ResultDigestError && e.code === code;
  }
}

// ── схема ────────────────────────────────────────────────────────────────────

test('каноническая строка построена по схеме, а не по порядку ключей объекта', () => {
  assert.equal(CANONICAL_ROW_V2_FIELDS.length, 19);
  const line = canonicalRowLine(row());
  assert.equal(line.split('\x1f').length, 19);

  // РАЗДЕЛЯЮЩАЯ: те же значения, другой порядок ключей — строка обязана совпасть.
  // Реализация, обходящая Object.keys, дала бы разные строки.
  const shuffled: Record<string, unknown> = {};
  for (const k of [...CANONICAL_ROW_V2_FIELDS].reverse()) shuffled[k] = (row() as Record<string, unknown>)[k];
  assert.equal(canonicalRowLine(shuffled), line);
});

// ── порядок строк ────────────────────────────────────────────────────────────

test('порядок батчей не протекает в digest', () => {
  const a = [row({ minute_ts: T0 }), row({ minute_ts: T0 + MIN }), row({ minute_ts: T0 + 2 * MIN })];
  const b = [a[2], a[0], a[1]] as DigestRow[];
  assert.equal(digestOf(a), digestOf(b as ReadonlyArray<DigestRow>));

  // РАЗДЕЛЯЮЩАЯ: другой НАБОР строк — другой digest. Иначе сортировка «склеила» бы всё.
  const c = [a[0], a[1]] as DigestRow[];
  assert.notEqual(digestOf(a), digestOf(c));
});

test('ключ сортировки — (minute_ts, symbol), а не один из них', () => {
  const same = (s: string) => row({ symbol: s });
  const x = [same('BBB'), same('AAA')];
  const y = [same('AAA'), same('BBB')];
  assert.equal(digestOf(x), digestOf(y));
  // РАЗДЕЛЯЮЩАЯ: символы различают строки, а не только штампы.
  assert.notEqual(digestOf([same('AAA'), same('AAA2')]), digestOf([same('AAA'), same('BBB')]));
});

// ── целые ────────────────────────────────────────────────────────────────────

test('bigint и number в целом поле дают ОДНУ строку', () => {
  assert.equal(
    digestOf([row({ minute_ts: T0 })]),
    digestOf([row({ minute_ts: BigInt(T0) as unknown as number })]),
  );
});

test('целое за 2^53 отвергается независимо от типа', () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 2;
  assert.ok(threw(() => computeResultDigest([row({ minute_ts: unsafe })]), 'PRECISION_LOST'));
  assert.ok(threw(
    () => computeResultDigest([row({ minute_ts: BigInt(Number.MAX_SAFE_INTEGER) + 2n as unknown as number })]),
    'PRECISION_LOST',
  ));

  // РАЗДЕЛЯЮЩАЯ И ГЛАВНАЯ: отказ наступает ДО сортировки и поиска дублей. Пара выбрана точно
  // коллидирующей в Number — …992 и …993 дают одно и то же значение f64, поэтому реализация,
  // проверяющая точность ПОСЛЕ приведения ключа, объявила бы их дублем и вернула не тот код.
  const a = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const b = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
  assert.equal(Number(a), Number(b));
  assert.ok(threw(
    () => computeResultDigest([
      row({ minute_ts: a as unknown as number }),
      row({ minute_ts: b as unknown as number }),
    ]),
    'PRECISION_LOST',
  ));
});

test('нецелое в целом поле — TYPE_MISMATCH, а не PRECISION_LOST', () => {
  // РАЗДЕЛЯЮЩАЯ пара кодов: дробь в целом поле — это НЕ та же беда, что величина за 2^53.
  // Первое означает «поле объявлено целым, пришло другое»; второе — «значение точным уже не
  // является». Действия по ним разные, и слить их в один код значило бы дать одинаковый
  // диагноз ошибке схемы и потере точности.
  assert.ok(threw(() => computeResultDigest([row({ minute_ts: T0 + 0.5 })]), 'TYPE_MISMATCH'));
  assert.ok(threw(
    () => computeResultDigest([row({ minute_ts: Number.MAX_SAFE_INTEGER + 2 })]),
    'PRECISION_LOST',
  ));
});

// ── f64 ──────────────────────────────────────────────────────────────────────

test('bigint в f64-поле — TYPE_MISMATCH, а не тихое приведение', () => {
  assert.ok(threw(() => computeResultDigest([row({ open: 1n as unknown as number })]), 'TYPE_MISMATCH'));
});

test('NaN и ±Inf отвергаются', () => {
  for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.ok(threw(() => computeResultDigest([row({ open: v })]), 'NON_FINITE'));
  }
});

test('f64 различается на 17-й значащей цифре', () => {
  // РАЗДЕЛЯЮЩАЯ: 16 значащих цифр эти два числа склеили бы.
  const a = 1.0000000000000002;
  const b = 1.0000000000000004;
  assert.notEqual(a, b);
  assert.notEqual(digestOf([row({ open: a })]), digestOf([row({ open: b })]));
});

test('знак отрицательного числа сохраняется; -0 печатается как платформенный ноль', () => {
  assert.notEqual(digestOf([row({ open: -1 })]), digestOf([row({ open: 1 })]));
  // Свойство платформы, а не наша нормализация: ветка знака у toPrecision — `x < 0`,
  // а `-0 < 0` ложно. Пинится явно, чтобы смена движка не прошла молча.
  assert.equal((-0).toPrecision(17), (0).toPrecision(17));
});

// ── null / 0 / отсутствие ────────────────────────────────────────────────────

test('null, 0, отсутствие поля и undefined — различимые факты', () => {
  const withNull = digestOf([row({ oi_total_usd: null })]);
  const withZero = digestOf([row({ oi_total_usd: 0 })]);
  const absent = (() => { const r = { ...row() }; delete (r as Record<string, unknown>).oi_total_usd; return digestOf([r]); })();
  const undef = digestOf([row({ oi_total_usd: undefined })]);

  assert.notEqual(withNull, withZero);
  assert.notEqual(withNull, absent);
  assert.notEqual(withZero, absent);

  // РАЗДЕЛЯЮЩАЯ: на JSON-wire `undefined` означает ОТСУТСТВИЕ свойства
  // (`JSON.stringify({a: undefined})` === '{}'), поэтому он канонизируется как absent,
  // а не как null.
  assert.equal(undef, absent);
  assert.notEqual(undef, withNull);
});

// ── дубль ключа ──────────────────────────────────────────────────────────────

test('дубль (minute_ts, symbol) — отказ, а не дедуп', () => {
  assert.ok(threw(
    () => computeResultDigest([row({ oi_total_usd: 1 }), row({ oi_total_usd: 2 })]),
    'DUPLICATE_ROW_KEY',
  ));

  // РАЗДЕЛЯЮЩАЯ: различаются ТОЛЬКО не-ключевые поля, значения при этом разные — то есть
  // «выбрать правильную» нельзя ни по какому правилу, и дедуп был бы выдумыванием данных.
  assert.doesNotThrow(() => computeResultDigest([row(), row({ symbol: 'ETHUSDT' })]));
});

test('дубль ловится отдельным проходом ДО хеширования', () => {
  // РАЗДЕЛЯЮЩАЯ: ключ целый и безопасный, поэтому диагноз обязан быть именно про дубль,
  // а не про точность — иначе две защиты прикрывали бы друг друга.
  try {
    computeResultDigest([row({ schema_version: 2 }), row({ schema_version: 2 })]);
    assert.fail('ожидался отказ');
  } catch (e) {
    assert.ok(e instanceof ResultDigestError);
    assert.equal((e as ResultDigestError).code, 'DUPLICATE_ROW_KEY');
  }
});

// ── равенство путей ──────────────────────────────────────────────────────────

test('digestsAgree сравнивает все четыре поля, а не только хеш', () => {
  const d = computeResultDigest([row()]);
  assert.ok(digestsAgree(d, { ...d }));
  assert.ok(!digestsAgree(d, { ...d, rowCount: d.rowCount + 1 }));
  assert.ok(!digestsAgree(d, { ...d, minMinuteTs: 0 }));
  assert.ok(!digestsAgree(d, { ...d, maxMinuteTs: 0 }));
});

// ── вердикт паритета: fail-closed ────────────────────────────────────────────

const three = (rows: ReadonlyArray<DigestRow>) =>
  ['row-json', 'arrow-ipc', 'files-range'].map((path) => ({ path, digest: computeResultDigest(rows) }));

const full: ResultExpectation = {
  rowCount: 1,
  withinRange: { tsFrom: T0, tsTo: T0 + 86_400_000 },
};

test('полный вердикт: верные ответы проходят', () => {
  assert.deepEqual(checkParity(three([row()]), full), []);
});

test('ГЛАВНОЕ: checkParity(paths, {}) — ОТКАЗ, а не молчаливое согласие', () => {
  // Три одинаково ПУСТЫХ ответа согласуются между собой идеально. Прежняя редакция принимала
  // `{}`, потому что все поля ожидания опциональны, и вердикт сводился к одному равенству.
  const problems = checkParity(three([]), {});
  assert.ok(problems.some((m) => m.includes('ожидание неполно')));

  // РАЗДЕЛЯЮЩАЯ: равенство при этом действительно выполняется — отказ идёт НЕ из-за расхождения.
  assert.ok(!problems.some((m) => m.includes('разошлись')));
});

test('неполное ожидание — само по себе нарушение', () => {
  const onlyCount = checkParity(three([row()]), { rowCount: 1 });
  assert.ok(onlyCount.some((m) => m.includes('ожидание неполно')));

  const onlyRange = checkParity(three([row()]), { withinRange: full.withinRange });
  assert.ok(onlyRange.some((m) => m.includes('ожидание неполно')));

  // РАЗДЕЛЯЮЩАЯ: minRowCount точный rowCount НЕ заменяет — «хотя бы одна строка» пропустит
  // ответ из пяти строк там, где их сто.
  const minOnly = checkParity(three([row()]), { minRowCount: 1, withinRange: full.withinRange });
  assert.ok(minOnly.some((m) => m.includes('ожидание неполно')));
});

test('три одинаково усечённых ответа не проходят полное ожидание', () => {
  const rows = [row(), row({ minute_ts: T0 + MIN })];
  const expectation: ResultExpectation = { rowCount: 2, withinRange: full.withinRange };
  assert.deepEqual(checkParity(three(rows), expectation), []);

  // РАЗДЕЛЯЮЩАЯ: тот же набор, усечённый на одну строку — все пути согласны, вердикт красный.
  const cut = checkParity(three([row()]), expectation);
  assert.ok(cut.length > 0);
  assert.ok(!cut.some((m) => m.includes('разошлись')));
});

test('одного пути мало для вердикта паритета', () => {
  const one = checkParity([{ path: 'row-json', digest: computeResultDigest([row()]) }], full);
  assert.ok(one.some((m) => m.includes('сравнивать нечего')));
});

test('окно ловит строки извне запрошенного диапазона', () => {
  const outside = computeResultDigest([row({ minute_ts: T0 + 86_400_000 })]);
  const bad = checkAgainstExpectation(outside, full);
  assert.ok(bad.length > 0);
  // РАЗДЕЛЯЮЩАЯ: пустой ответ диапазону не противоречит — пустоту ловит счётчик, не окно.
  assert.deepEqual(
    checkAgainstExpectation(computeResultDigest([]), { withinRange: full.withinRange }),
    [],
  );
});
