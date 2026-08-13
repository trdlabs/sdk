// ГЕЙТЫ ДВУХ ПРИНЯТЫХ РЕШЕНИЙ ПО КОНТРАКТУ АКТОРА (083 S3, `017.5`).
//
// ADR-0012 — источники событий. Список в `ActorInit` закрыт, хостовый источник объявлен явно.
// Правило автора становится ОДНИМ и без исключений: `subscriptionId` конверта всегда есть в списке.
// До этого половина каталога §3.5 (филл, четыре ордерных события, таймер) не имела законного
// значения вовсе, и хост-реализация подставляла собственную строку — то есть поведение стратегии
// зависело от того, на каком хосте она исполняется.
//
// ADR-0013 — единица заявки. Первичен нотионал; базовый размер расщеплён на ОЦЕНКУ (необязательную)
// и ФАКТ исполнения. Прежнее поле `qty` объявлялось «размером, принятым риском» — утверждение, за
// которым не стояло ни риска, ни размера: хост без цены пересчёта подставлял ноль, и по формуле
// остатка `qty − filledQty` это читалось как «исполнена целиком».
//
// Проверяется ФОРМА, а не поведение: обе правки типовые, и их нарушение обязано краснеть сборкой.
// Типовые утверждения выражены через excess-property-check на литералах и через сужение union'а —
// то, что рантайм-assert проверить не может в принципе.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isHostSourceDescriptor,
  findDuplicateSubscriptionIds,
  timestampUsFromMillis,
} from '../src/research-contract/index.js';
import type {
  ActorHostSourceDescriptor,
  ActorInit,
  ActorMarketSourceDescriptor,
  ActorSubscriptionDescriptor,
  OpenOrderView,
  OpenLimitOrderView,
} from '../src/research-contract/index.js';

const TS = timestampUsFromMillis(1_700_000_000_000);

const market: ActorMarketSourceDescriptor = {
  subscriptionId: 'sub-candles-1',
  kind: 'candles',
  requirementId: 'req-candles',
};

const host: ActorHostSourceDescriptor = {
  subscriptionId: 'sub-host',
  kind: 'host',
};

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0012 — источники
// ─────────────────────────────────────────────────────────────────────────────

test('ADR-0012: хостовый источник — член того же списка, что и рыночный', () => {
  // Главное утверждение решения: список ОДИН и закрытый. Хостовый дескриптор кладётся в
  // `ActorInit.subscriptions` наравне с рыночным, поэтому правило автора «subscriptionId всегда
  // есть в списке» выполнимо без единого исключения.
  const init: ActorInit = {
    params: {},
    seed: 7,
    symbol: 'BTCUSDT',
    subscriptions: [market, host],
  };
  assert.equal(init.subscriptions.length, 2);
  assert.deepEqual(
    init.subscriptions.map((s) => s.subscriptionId),
    ['sub-candles-1', 'sub-host'],
  );
});

test('ADR-0012: union сужается по kind, и у хостового источника требования манифеста НЕТ', () => {
  const sources: readonly ActorSubscriptionDescriptor[] = [market, host];
  const hosts = sources.filter(isHostSourceDescriptor);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0]?.subscriptionId, 'sub-host');

  // Сужение работает и в обратную сторону: не-хостовый вариант несёт `requirementId`, и читать его
  // можно только ПОСЛЕ проверки вида. Это и есть причина, по которой дескриптор разложен на два
  // варианта, а не получил опциональное поле: опциональность позволила бы рыночному источнику
  // приехать без требования и не быть замеченным.
  const markets = sources.filter((s): s is ActorMarketSourceDescriptor => !isHostSourceDescriptor(s));
  assert.deepEqual(
    markets.map((s) => s.requirementId),
    ['req-candles'],
  );
});

test('ADR-0012: хостовый дескриптор с requirementId не типизируется', () => {
  // @ts-expect-error — у хостового источника требования манифеста нет и быть не может.
  const bad: ActorHostSourceDescriptor = { subscriptionId: 'sub-host', kind: 'host', requirementId: 'req-x' };
  assert.ok(bad);
});

test('ADR-0012: рыночный дескриптор без requirementId не типизируется', () => {
  // @ts-expect-error — рыночный источник обязан называть требование, по которому он разрешён.
  const bad: ActorMarketSourceDescriptor = { subscriptionId: 'sub-candles-2', kind: 'candles' };
  assert.ok(bad);
});

test("ADR-0012: 'host' — не рыночный вид, и в рыночном варианте он невыразим", () => {
  // Иначе `kind: 'host'` мог бы приехать как рыночный вид с требованием — то есть ровно то
  // смешение, ради устранения которого union и заведён.
  // @ts-expect-error — 'host' не входит в MarketDataRequirement['kind'].
  const bad: ActorMarketSourceDescriptor = { subscriptionId: 's', kind: 'host', requirementId: 'r' };
  assert.ok(bad);
});

test('ADR-0012: проверка дублей видит оба вида источников одинаково', () => {
  // Дубли ловятся по `subscriptionId`, а он есть у обоих вариантов — иначе хостовый источник мог бы
  // столкнуться с рыночным и остаться незамеченным.
  const dupes = findDuplicateSubscriptionIds([market, host, { ...host }]);
  assert.deepEqual([...dupes], ['sub-host']);
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0013 — единица заявки
// ─────────────────────────────────────────────────────────────────────────────

test('ADR-0013: нотионал первичен, обе quote-величины обязательны', () => {
  const view: OpenLimitOrderView = {
    clientOrderId: 'o1',
    side: 'buy',
    status: 'accepted',
    type: 'limit',
    price: 50,
    qtyUsd: 1000,
    filledQtyUsd: 400,
    createdTs: TS,
  };
  // Остаток считается БЕЗ всякой цены — обе части одной единицы.
  assert.equal(view.qtyUsd - view.filledQtyUsd, 600);
  // Предикат частичного исполнения живёт в той же единице.
  assert.ok(view.filledQtyUsd > 0 && view.filledQtyUsd < view.qtyUsd);
  // Базовых величин нет вовсе — и это законная заявка, а не неполная.
  assert.equal(view.estimatedQty, undefined);
  assert.equal(view.filledQty, undefined);
});

test('ADR-0013: базовые величины опциональны, но типизированы, когда есть', () => {
  const view: OpenOrderView = {
    clientOrderId: 'o2',
    side: 'sell',
    status: 'accepted',
    type: 'market',
    qtyUsd: 1000,
    filledQtyUsd: 0,
    estimatedQty: 9.95,
    createdTs: TS,
  };
  assert.equal(view.estimatedQty, 9.95);
  // Оценка НЕ обязана совпадать с будущим исполнением — она и не обещает этого.
  assert.equal(view.filledQty, undefined);
});

test('ADR-0013: поля qty больше нет — прежняя форма не типизируется', () => {
  const view = {
    clientOrderId: 'o3',
    side: 'buy',
    status: 'accepted',
    type: 'market',
    qtyUsd: 1000,
    filledQtyUsd: 0,
    createdTs: TS,
    // @ts-expect-error — `qty` («размер, принятый риском») упразднён решением ADR-0013.
    qty: 10,
  } satisfies OpenOrderView;
  assert.ok(view);
});

test('ADR-0013: filledQtyUsd обязателен — остаток заявки обязан быть вычислим', () => {
  // @ts-expect-error — без него `qtyUsd − filledQtyUsd` не считается, и предикат частичного
  // исполнения теряется вместе с ним.
  const bad: OpenOrderView = {
    clientOrderId: 'o4',
    side: 'buy',
    status: 'accepted',
    type: 'market',
    qtyUsd: 1000,
    createdTs: TS,
  };
  assert.ok(bad);
});

test('ADR-0013: ПРОВЕРКА ПРОВЕРКИ — законная заявка без базовых величин типизируется', () => {
  // Иначе `@ts-expect-error` выше зеленели бы у формы, отвергающей вообще всё.
  const ok: OpenOrderView = {
    clientOrderId: 'o5',
    side: 'buy',
    status: 'submitted',
    type: 'stop_market',
    stopPrice: 120,
    qtyUsd: 500,
    filledQtyUsd: 0,
    reduceOnly: true,
    createdTs: TS,
  };
  assert.equal(ok.qtyUsd, 500);
});
