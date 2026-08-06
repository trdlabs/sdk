// 083 S1 — задача 2: пять раздельных рыночных событий + статус подписки, `ActorBarEvent` снесён.
//
// Этот файл проверяет ФОРМУ каталога `ActorInputEvent`, а не поведение `defineActor`
// (то пинует `event-driven.test.ts`):
//   1) замкнутость union'а — `switch` БЕЗ `default` над `ActorInputEvent['kind']` компилируется
//      только если покрывает все ветки; недостающая ветка ловится `assertNever`-паттерном —
//      типовая проверка, а не рантаймовая (нужен `tsc -p tsconfig.test.json`, `tsx` типы стирает);
//   2) `ACTOR_INPUT_EVENT_KINDS` согласован с `ActorInputEvent['kind']` в обе стороны: массив не
//      шире union'а (проверяет присваивание элементов массива параметру, типизированному над
//      `ActorInputEvent['kind']`) и не уже (проверяет исчерпывающий `switch` выше);
//   3) ни одно рыночное событие не несёт массив свечей — структурно, через excess-property-check
//      на литерале (`@ts-expect-error`, тот же приём, ради которого существует
//      `tsconfig.test.json`).
// Run: npx tsx --test test/actor-market-events.test.ts
// Type-check (обязателен для пункта 1 и 3 — `tsx` их НЕ ловит): npx tsc -p tsconfig.test.json
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTOR_INPUT_EVENT_KINDS,
  timestampUs,
  type ActorInputEvent,
  type FundingReading,
  type LiqPoint,
  type MarketCandleClosedEvent,
  type MarketFundingObservedEvent,
  type MarketLiquidationsBucketClosedEvent,
  type MarketOpenInterestObservedEvent,
  type MarketSubscriptionStatusChangedEvent,
  type MarketTakerVolumeBucketClosedEvent,
  type ObservedValue,
  type OiPoint,
  type TakerReading,
} from '../src/research-contract/index.js';

/** Обёртка значения в `ObservedValue<T>` — `final`/`0`, единственная законная комбинация v1. */
function observed<T>(value: T): ObservedValue<T> {
  return { effectiveTsUs: timestampUs(1_700_000_000_000_000), value, finality: 'final', revision: 0 };
}

const BAR = { ts: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };

/** Недостижимо, пока `ActorInputEvent['kind']` и вызывающий код согласованы (см. `labelOf`). */
function assertNever(x: never): never {
  throw new Error(`assertNever: недостижимо, получено ${JSON.stringify(x)}`);
}

/**
 * Исчерпывающий диспетчер БЕЗ `default`: каждая ветка `return`-ит явно, а строка после `switch`
 * достижима компилятору ТОЛЬКО если остался непокрытый вариант union'а — тогда `kind` там не
 * сужается до `never`, и `assertNever(kind)` красный. Само наличие этой функции в файле,
 * прогнанном через `tsc -p tsconfig.test.json`, и есть проверка замкнутости (Тесты п.1).
 */
function labelOf(kind: ActorInputEvent['kind']): string {
  switch (kind) {
    case 'market.candle.closed':
      return kind;
    case 'market.open_interest.observed':
      return kind;
    case 'market.liquidations.bucket_closed':
      return kind;
    case 'market.taker_volume.bucket_closed':
      return kind;
    case 'market.funding.observed':
      return kind;
    case 'market.subscription.status_changed':
      return kind;
    case 'order.accepted':
      return kind;
    case 'order.denied':
      return kind;
    case 'order.rejected':
      return kind;
    case 'order.canceled':
      return kind;
    case 'order.expired':
      return kind;
    case 'fill':
      return kind;
    case 'timer':
      return kind;
  }
  return assertNever(kind);
}

test('замкнутость union: switch без default над ActorInputEvent["kind"] покрывает все ветки', () => {
  // Каждый элемент массива передаётся параметру, типизированному над `ActorInputEvent['kind']`
  // напрямую (не над отдельным `ActorInputEventKind`) — если бы в массиве завёлся лишний вид,
  // не встречающийся ни у одного варианта `ActorInputEvent`, эта строка не скомпилировалась бы.
  for (const kind of ACTOR_INPUT_EVENT_KINDS) {
    assert.equal(labelOf(kind), kind);
  }
});

test('ACTOR_INPUT_EVENT_KINDS содержит ровно те виды, что различает исчерпывающий switch — не больше и не меньше', () => {
  const expected: readonly ActorInputEvent['kind'][] = [
    'market.candle.closed',
    'market.open_interest.observed',
    'market.liquidations.bucket_closed',
    'market.taker_volume.bucket_closed',
    'market.funding.observed',
    'market.subscription.status_changed',
    'order.accepted',
    'order.denied',
    'order.rejected',
    'order.canceled',
    'order.expired',
    'fill',
    'timer',
  ];
  assert.deepEqual([...ACTOR_INPUT_EVENT_KINDS].sort(), [...expected].sort());
  assert.equal(ACTOR_INPUT_EVENT_KINDS.length, expected.length);
  assert.equal(
    new Set(ACTOR_INPUT_EVENT_KINDS).size,
    ACTOR_INPUT_EVENT_KINDS.length,
    'без дублей в каталоге',
  );
});

test('составного market.candle.closed-имени с другим написанием в каталоге нет — свечное событие ровно одно', () => {
  // Приведение к `readonly string[]` — намеренное: тип `ACTOR_INPUT_EVENT_KINDS` уже НЕ содержит
  // `'bar'` (доказано типами выше), но здесь нужна рантайм-проверка старой строки как значения,
  // а не типовое сравнение (которое TS справедливо отверг бы как заведомо ложное).
  const kinds: readonly string[] = ACTOR_INPUT_EVENT_KINDS;
  assert.equal(kinds.includes('bar'), false, 'старый kind "bar" не должен вернуться');
  const candleKinds = ACTOR_INPUT_EVENT_KINDS.filter((k) => k.includes('candle'));
  assert.deepEqual(candleKinds, ['market.candle.closed']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Пункт 3: ни одно рыночное событие не несёт массив свечей (структурно, на литерале).
// ─────────────────────────────────────────────────────────────────────────────

test('рыночные события не несут поле-массив свечей — лишнее поле отклоняется на этапе типов', () => {
  // Каждый блок ниже — excess-property-check TypeScript на СВЕЖЕМ литерале, присвоенном
  // напрямую типизированной переменной: если бы какой-то `Market*Event` унаследовал старое
  // поле `closedCandles` (было у снесённого `ActorBarEvent`), `@ts-expect-error` оказался бы
  // ЛИШНИМ и `tsc -p tsconfig.test.json` упал бы с TS2578 (см. комментарий файла-конфига).

  const candle: MarketCandleClosedEvent = {
    kind: 'market.candle.closed',
    bar: observed(BAR),
    // @ts-expect-error — MarketCandleClosedEvent не несёт closedCandles (снесено вместе с ActorBarEvent).
    closedCandles: [BAR],
  };

  const oi: MarketOpenInterestObservedEvent = {
    kind: 'market.open_interest.observed',
    oi: observed<OiPoint>({ ts: 1, oiTotalUsd: 1 }),
    // @ts-expect-error — MarketOpenInterestObservedEvent — point observation, окна не бывает.
    closedCandles: [BAR],
  };

  const liq: MarketLiquidationsBucketClosedEvent = {
    kind: 'market.liquidations.bucket_closed',
    liq: observed<LiqPoint>({ ts: 1, longUsd: 0, shortUsd: 0 }),
    // @ts-expect-error — MarketLiquidationsBucketClosedEvent — один закрытый бакет, не окно.
    closedCandles: [BAR],
  };

  const taker: MarketTakerVolumeBucketClosedEvent = {
    kind: 'market.taker_volume.bucket_closed',
    taker: observed<TakerReading>({ state: 'missing' }),
    // @ts-expect-error — MarketTakerVolumeBucketClosedEvent — один закрытый бакет, не окно.
    closedCandles: [BAR],
  };

  const funding: MarketFundingObservedEvent = {
    kind: 'market.funding.observed',
    funding: observed<FundingReading>({ state: 'missing' }),
    // @ts-expect-error — MarketFundingObservedEvent — одно наблюдение, не окно.
    closedCandles: [BAR],
  };

  // Статус подписки — не носитель значения вовсе, но проверяем и его: та же дисциплина.
  const status: MarketSubscriptionStatusChangedEvent = {
    kind: 'market.subscription.status_changed',
    status: 'gap',
    expectedTsUs: timestampUs(1),
    // @ts-expect-error — MarketSubscriptionStatusChangedEvent не несёт closedCandles.
    closedCandles: [BAR],
  };

  // Литералы существуют только чтобы их присвоение проверил компилятор; рантайм тут не судья.
  void candle;
  void oi;
  void liq;
  void taker;
  void funding;
  void status;
  assert.ok(true);
});

test('валидные рыночные литералы (без лишнего поля) типизируются и попадают в ActorInputEvent', () => {
  const events: readonly ActorInputEvent[] = [
    { kind: 'market.candle.closed', bar: observed(BAR) },
    { kind: 'market.open_interest.observed', oi: observed<OiPoint>({ ts: 1, oiTotalUsd: 1 }) },
    {
      kind: 'market.liquidations.bucket_closed',
      liq: observed<LiqPoint>({ ts: 1, longUsd: 0, shortUsd: 0 }),
    },
    {
      kind: 'market.taker_volume.bucket_closed',
      taker: observed<TakerReading>({ state: 'missing' }),
    },
    { kind: 'market.funding.observed', funding: observed<FundingReading>({ state: 'missing' }) },
    { kind: 'market.subscription.status_changed', status: 'gap', expectedTsUs: timestampUs(1) },
  ];
  assert.equal(events.length, 6);
  for (const e of events) assert.equal(typeof e.kind, 'string');
});
