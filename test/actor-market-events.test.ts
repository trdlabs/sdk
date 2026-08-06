// 083 S1 — задача 2: пять раздельных рыночных событий + статус подписки, `ActorBarEvent` снесён.
//
// Этот файл проверяет ФОРМУ каталога `ActorInputEvent`, а не поведение `defineActor`
// (то пинует `event-driven.test.ts`):
//   1) замкнутость union'а — `switch` БЕЗ `default` над `ActorInputEvent['kind']` компилируется
//      только если покрывает все ветки; недостающая ветка ловится `assertNever`-паттерном —
//      типовая проверка, а не рантаймовая (нужен `tsc -p tsconfig.test.json`, `tsx` типы стирает);
//   2) `ACTOR_INPUT_EVENT_KINDS` согласован с `ActorInputEvent['kind']` в обе стороны. ПЕРВИЧНАЯ
//      гарантия теперь в `src` (`event-driven.ts`: `satisfies readonly ActorInputEvent['kind'][]`
//      + `AssertNoUncoveredKind<Exclude<...>>` — раунд правок 1, I-1: массив, объявленный
//      `as const` без `satisfies`, страховал вывод `ActorInputEventKind` ТОЛЬКО от себя самого,
//      не от union'а). Здесь — дублирующая, но независимая проверка через `labelOf`: элементы
//      массива передаются параметру, типизированному напрямую над `ActorInputEvent['kind']`
//      (массив не шире union'а), а исчерпывающий `switch` в `labelOf` — что union не шире массива;
//   3) ни одно рыночное событие не несёт массив свечей — структурно, через excess-property-check
//      на литерале (`@ts-expect-error`, тот же приём, ради которого существует
//      `tsconfig.test.json`).
//
// Финальная волна ревью ветки добавила ниже два пункта, оба — И типом, И схемой (типовая половина
// ловит только свежий литерал, схемная работает там, где типов вызывающего нет вовсе):
//   Б-1) значение события не несёт СВОЕЙ метки времени — единственная координата `effectiveTsUs`
//        конверта, и в схеме события больше нет легаси-форм `Bar`/`OiPoint`/`LiqPoint`/`TakerPoint`/
//        `FundingPoint`, каждая из которых несла свой `ts` в миллисекундах;
//   Б-2) событие несёт ТОЛЬКО present-содержимое — `{state:'missing'|'stale'}` внутри значения
//        отвергается (раньше было валидным событием), отсутствие выражается единственным каналом
//        `market.subscription.status_changed`.
// Run: npx tsx --test test/actor-market-events.test.ts
// Type-check (обязателен для пункта 1 и 3 — `tsx` их НЕ ловит): npx tsc -p tsconfig.test.json
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTOR_INPUT_EVENT_KINDS,
  timestampUs,
  type ActorInputEvent,
  type CandleValue,
  type FundingValue,
  type LiquidationsValue,
  type MarketCandleClosedEvent,
  type MarketFundingObservedEvent,
  type MarketLiquidationsBucketClosedEvent,
  type MarketOpenInterestObservedEvent,
  type MarketSubscriptionStatusChangedEvent,
  type MarketTakerVolumeBucketClosedEvent,
  type ObservedValue,
  type OpenInterestValue,
  type TakerVolumeValue,
} from '../src/research-contract/index.js';
import { schemaAsset } from '../src/validation/index.js';
import { createSchemaRegistry } from '../src/validation/schema-registry.js';

const registry = createSchemaRegistry();

/** Обёртка значения в `ObservedValue<T>` — `final`/`0`, единственная законная комбинация v1. */
function observed<T>(value: T): ObservedValue<T> {
  return { effectiveTsUs: timestampUs(1_700_000_000_000_000), value, finality: 'final', revision: 0 };
}

const CANDLE: CandleValue = { open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };

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
    case 'cancel.rejected':
      return kind;
    case 'order.expired':
      return kind;
    case 'fill':
      return kind;
    case 'timer':
      return kind;
    case 'trading_state.changed':
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
    'cancel.rejected',
    'order.expired',
    'fill',
    'timer',
    'trading_state.changed',
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
    candle: observed(CANDLE),
    // @ts-expect-error — MarketCandleClosedEvent не несёт closedCandles (снесено вместе с ActorBarEvent).
    closedCandles: [CANDLE],
  };

  const oi: MarketOpenInterestObservedEvent = {
    kind: 'market.open_interest.observed',
    oi: observed<OpenInterestValue>({ oiTotalUsd: 1 }),
    // @ts-expect-error — MarketOpenInterestObservedEvent — point observation, окна не бывает.
    closedCandles: [CANDLE],
  };

  const liq: MarketLiquidationsBucketClosedEvent = {
    kind: 'market.liquidations.bucket_closed',
    liq: observed<LiquidationsValue>({ longUsd: 0, shortUsd: 0 }),
    // @ts-expect-error — MarketLiquidationsBucketClosedEvent — один закрытый бакет, не окно.
    closedCandles: [CANDLE],
  };

  const taker: MarketTakerVolumeBucketClosedEvent = {
    kind: 'market.taker_volume.bucket_closed',
    taker: observed<TakerVolumeValue>({ buyUsd: 0, sellUsd: 0 }),
    // @ts-expect-error — MarketTakerVolumeBucketClosedEvent — один закрытый бакет, не окно.
    closedCandles: [CANDLE],
  };

  const funding: MarketFundingObservedEvent = {
    kind: 'market.funding.observed',
    funding: observed<FundingValue>({ fundingRate: 0.0001 }),
    // @ts-expect-error — MarketFundingObservedEvent — одно наблюдение, не окно.
    closedCandles: [CANDLE],
  };

  // Статус подписки — не носитель значения вовсе, но проверяем и его: та же дисциплина.
  const status: MarketSubscriptionStatusChangedEvent = {
    kind: 'market.subscription.status_changed',
    status: { state: 'gap', expectedTsUs: timestampUs(1) },
    // @ts-expect-error — MarketSubscriptionStatusChangedEvent не несёт closedCandles.
    closedCandles: [CANDLE],
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
    { kind: 'market.candle.closed', candle: observed(CANDLE) },
    { kind: 'market.open_interest.observed', oi: observed<OpenInterestValue>({ oiTotalUsd: 1 }) },
    {
      kind: 'market.liquidations.bucket_closed',
      liq: observed<LiquidationsValue>({ longUsd: 0, shortUsd: 0 }),
    },
    {
      kind: 'market.taker_volume.bucket_closed',
      taker: observed<TakerVolumeValue>({ buyUsd: 0, sellUsd: 0 }),
    },
    { kind: 'market.funding.observed', funding: observed<FundingValue>({ fundingRate: -0.0002 }) },
    {
      kind: 'market.subscription.status_changed',
      status: { state: 'gap', expectedTsUs: timestampUs(1) },
    },
  ];
  assert.equal(events.length, 6);
  for (const e of events) assert.equal(typeof e.kind, 'string');
});

// ─────────────────────────────────────────────────────────────────────────────
// Финальная волна ревью ветки, Б-1: одна временная координата на событие.
// ─────────────────────────────────────────────────────────────────────────────

test('Б-1: значение рыночного события не несёт СВОЕЙ метки времени — единственная координата в конверте', () => {
  // Типовая половина: `ts` на значении — лишнее поле (excess-property-check на СВЕЖЕМ литерале;
  // на значении, собранном иначе, TS его не ловит — та же оговорка, что у `ActorBudgets`).
  const candleValue: CandleValue = {
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
    // @ts-expect-error — у CandleValue нет `ts`: момент свечи несёт ObservedValue.effectiveTsUs.
    ts: 1_700_000_000_000,
  };
  void candleValue;

  // Схемная половина: то же самое на отгружаемой схеме, где типов вызывающего нет вовсе
  // (правило №7: гейт, полагающийся на типы вызывающего, гейтом не является).
  const withLegacyTs = {
    kind: 'market.candle.closed',
    candle: {
      effectiveTsUs: 1_700_000_000_000_000,
      value: { ts: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      finality: 'final',
      revision: 0,
    },
  };
  assert.ok(
    registry.validateCore('actor-input-event', withLegacyTs).length > 0,
    'мс-метка внутри значения обязана отклоняться схемой',
  );

  // И в самой схеме не осталось легаси-форм значений, несущих `ts` в миллисекундах.
  const definitions = Object.keys(
    (schemaAsset('actor-input-event') as { definitions: Record<string, unknown> }).definitions,
  );
  for (const legacy of ['Bar', 'OiPoint', 'LiqPoint', 'TakerPoint', 'FundingPoint']) {
    assert.ok(!definitions.includes(legacy), `схема события всё ещё ссылается на легаси-форму ${legacy}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Финальная волна ревью ветки, Б-2: событие несёт ТОЛЬКО present-содержимое.
// ─────────────────────────────────────────────────────────────────────────────

test('Б-2: «наблюдено, что наблюдения не было» невыразимо — ни типом, ни схемой', () => {
  // @ts-expect-error — значение taker-события это TakerVolumeValue, а не 3-состоянийный ридинг.
  const takerMissing: TakerVolumeValue = { state: 'missing' };
  void takerMissing;

  for (const [label, event] of [
    [
      'taker: missing',
      { kind: 'market.taker_volume.bucket_closed', taker: { effectiveTsUs: 1, value: { state: 'missing' }, finality: 'final', revision: 0 } },
    ],
    [
      'taker: stale',
      { kind: 'market.taker_volume.bucket_closed', taker: { effectiveTsUs: 1, value: { state: 'stale' }, finality: 'final', revision: 0 } },
    ],
    [
      'funding: missing',
      { kind: 'market.funding.observed', funding: { effectiveTsUs: 1, value: { state: 'missing' }, finality: 'final', revision: 0 } },
    ],
  ] as const) {
    assert.ok(
      registry.validateCore('actor-input-event', event).length > 0,
      `схема обязана отклонять самопротиворечивое событие — ${label}`,
    );
  }

  // Отсутствие выражается ЕДИНСТВЕННЫМ каналом — и он валиден.
  assert.deepEqual(
    registry.validateCore('actor-input-event', {
      kind: 'market.subscription.status_changed',
      status: { state: 'gap', expectedTsUs: 1_700_000_000_000_000 },
    }),
    [],
  );
});
