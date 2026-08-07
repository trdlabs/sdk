// 083 S1 — микросекунды как ЕДИНСТВЕННАЯ внутренняя единица времени актор-контракта.
//
// Спека: control-center `docs/superpowers/specs/2026-08-04-event-driven-actor-contract-design.md` §3.2.
//
// Зачем отдельный модуль и зачем бранд-типы. Сегодня всё в миллисекундах. Актор-контракт
// переводит на микросекунды конверт, scheduler, таймеры, execution ledger и canonical trace —
// и сосуществование двух единиц гарантированно даст ошибку пересчёта, которую поймают не
// компилятором, а нулевым PnL через месяц. Бранд делает `ms` и `µs` разными типами, поэтому
// забытый `* 1000` перестаёт быть исполняемым кодом.
//
// Нормативные правила §3.2, реализованные здесь:
// - запрет дробных значений, `NaN` и нецелых JSON-чисел;
// - ЕДИНСТВЕННОЕ нормализующее преобразование на ingest (`timestampUsFromMillis`);
// - НИКАКОГО неявного `* 1000` внутри ядра — конвертер один и он явный;
// - субмикросекундная точность источника: truncate/floor, а не round (округление вверх
//   переставило бы события относительно друг друга — порядок важнее последней цифры);
// - `Number.isSafeInteger` проверяется ПОСЛЕ арифметики, не только на входе.

declare const TIMESTAMP_US: unique symbol;
declare const DURATION_US: unique symbol;

/** Момент времени в микросекундах эпохи. Целое, неотрицательное, safe-integer. */
export type TimestampUs = number & { readonly [TIMESTAMP_US]: 'TimestampUs' };

/** Длительность в микросекундах. Целое; знак допустим (разность моментов). */
export type DurationUs = number & { readonly [DURATION_US]: 'DurationUs' };

export const MICROS_PER_MILLI = 1_000;
export const MICROS_PER_SECOND = 1_000_000;
export const MICROS_PER_MINUTE = 60_000_000;

/**
 * Верхняя граница представимого момента.
 *
 * µs эпохи ≈ 1.75·10¹⁵ при `Number.MAX_SAFE_INTEGER` ≈ 9.007·10¹⁵ — запас есть, но он
 * КОНЕЧНЫЙ, поэтому граница названа числом, а не оставлена «оно точно влезет». Значение
 * соответствует 2255-06-05T23:47:34Z: дальше арифметика ещё безопасна, но датасет с такими
 * метками почти наверняка означает ошибку единицы, а не данные из будущего.
 */
export const MAX_TIMESTAMP_US = 9_007_199_254_740_991 as TimestampUs;

function isIntegerInRange(value: number): boolean {
  return Number.isSafeInteger(value);
}

/** Момент — целый, неотрицательный, в safe-диапазоне. */
export function isTimestampUs(value: unknown): value is TimestampUs {
  return typeof value === 'number' && isIntegerInRange(value) && value >= 0;
}

/** Длительность — целая; отрицательная законна (разность моментов может идти назад). */
export function isDurationUs(value: unknown): value is DurationUs {
  return typeof value === 'number' && isIntegerInRange(value);
}

/**
 * Ввод момента. Дробное, `NaN`, `Infinity`, отрицательное и выход за safe-диапазон —
 * отказ, а не молчаливое приведение.
 */
export function timestampUs(value: number): TimestampUs {
  if (!isTimestampUs(value)) {
    throw new RangeError(`TimestampUs требует целое неотрицательное safe-число µs, получено: ${value}`);
  }
  return value;
}

/** Ввод длительности. Те же правила, кроме знака. */
export function durationUs(value: number): DurationUs {
  if (!isDurationUs(value)) {
    throw new RangeError(`DurationUs требует целое safe-число µs, получено: ${value}`);
  }
  return value;
}

/**
 * ЕДИНСТВЕННОЕ нормализующее преобразование на ingest (§3.2).
 *
 * Дробные миллисекунды приходят от поставщиков с субмикросекундной точностью. Правило —
 * **truncate/floor**, а не round: округление вверх могло бы переставить два события,
 * различающиеся долями микросекунды, а порядок наблюдений — часть идентичности прогона.
 * Исходная точность и версия нормализации пишутся в evidence вызывающей стороной; здесь
 * только само преобразование, чтобы оно существовало в одном месте.
 */
export function timestampUsFromMillis(ms: number): TimestampUs {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`Нормализация в µs требует конечное неотрицательное число мс, получено: ${ms}`);
  }
  return timestampUs(Math.floor(ms * MICROS_PER_MILLI));
}

/** Обратное преобразование — только для границ наружу (evidence, логи), не для арифметики ядра. */
export function timestampUsToMillis(ts: TimestampUs): number {
  return ts / MICROS_PER_MILLI;
}

/**
 * Проверка результата арифметики.
 *
 * `Number.isSafeInteger` на ВХОДЕ не спасает: сумма двух безопасных целых может выйти за
 * границу, и дальше сравнения начнут врать бесшумно. Поэтому каждое сложение/вычитание
 * моментов и длительностей проходит через эту функцию (§3.2, п. 5).
 */
export function assertSafeUs(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Арифметика µs вышла за safe-диапазон в ${what}: ${value}`);
  }
  return value;
}

/** Сложение момента и длительности с проверкой результата. */
export function addUs(ts: TimestampUs, delta: DurationUs): TimestampUs {
  return timestampUs(assertSafeUs(ts + delta, 'addUs'));
}

/** Разность моментов. Знак сохраняется — это длительность, а не момент. */
export function diffUs(a: TimestampUs, b: TimestampUs): DurationUs {
  return durationUs(assertSafeUs(a - b, 'diffUs'));
}
