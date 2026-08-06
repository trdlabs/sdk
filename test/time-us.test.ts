// 083 S1 — µs как единственная внутренняя единица времени (спека §3.2).
//
// Тест пинует не «функция работает», а четыре нормативных правила, каждое из которых
// защищает от конкретной ошибки, найденной в разборе:
//   1) дробное/NaN/отрицательное отвергается, а не приводится молча;
//   2) нормализация из мс — truncate, а не round (round переставил бы события);
//   3) safe-integer проверяется ПОСЛЕ арифметики, а не только на входе;
//   4) конвертер ровно один — неявного `* 1000` в ядре быть не должно.
// Run: npx tsx --test test/time-us.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TIMESTAMP_US,
  MICROS_PER_MILLI,
  addUs,
  diffUs,
  durationUs,
  isDurationUs,
  isTimestampUs,
  timestampUs,
  timestampUsFromMillis,
  timestampUsToMillis,
} from '../src/research-contract/time-us.js';

test('момент: дробное, NaN, Infinity и отрицательное отвергаются', () => {
  for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, -1, -0.0001]) {
    assert.throws(() => timestampUs(bad), RangeError, `должно отвергнуть ${bad}`);
    assert.equal(isTimestampUs(bad), false);
  }
});

test('момент: ноль и граница safe-диапазона принимаются', () => {
  assert.equal(timestampUs(0), 0);
  assert.equal(timestampUs(MAX_TIMESTAMP_US), MAX_TIMESTAMP_US);
});

test('момент: за safe-диапазоном отвергается', () => {
  assert.throws(() => timestampUs(Number.MAX_SAFE_INTEGER + 2), RangeError);
});

test('длительность: отрицательная законна, дробная — нет', () => {
  assert.equal(durationUs(-5), -5);
  assert.equal(isDurationUs(-5), true);
  assert.throws(() => durationUs(0.5), RangeError);
});

test('нормализация из мс — truncate, а не round', () => {
  // 1.0009999 мс = 1000.9999 µs. Round дал бы 1001 и переставил бы это наблюдение
  // относительно события, честно пришедшего на 1001 µs. Truncate сохраняет порядок.
  assert.equal(timestampUsFromMillis(1.0009999), 1000);
  assert.equal(timestampUsFromMillis(1.9999), 1999);
  assert.equal(timestampUsFromMillis(0), 0);
});

test('нормализация: единственный конвертер, и он явный', () => {
  const ms = 1_754_000_000_000;
  assert.equal(timestampUsFromMillis(ms), ms * MICROS_PER_MILLI);
  assert.equal(timestampUsToMillis(timestampUsFromMillis(ms)), ms);
});

test('нормализация: нечисло и отрицательное отвергаются', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.throws(() => timestampUsFromMillis(bad), RangeError);
  }
});

test('арифметика: выход за safe-диапазон ловится ПОСЛЕ операции', () => {
  // Оба операнда по отдельности безопасны — проверка входа их пропустила бы.
  const near = timestampUs(Number.MAX_SAFE_INTEGER - 1);
  const step = durationUs(10);
  assert.throws(() => addUs(near, step), RangeError);
});

test('арифметика: разность моментов сохраняет знак', () => {
  const a = timestampUs(1_000);
  const b = timestampUs(2_500);
  assert.equal(diffUs(b, a), 1_500);
  assert.equal(diffUs(a, b), -1_500);
});
