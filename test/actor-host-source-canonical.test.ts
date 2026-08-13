// ГЕЙТ: идентификатор хостового источника выбирает КОНТРАКТ, а не хост (083 S3, ADR-0012).
//
// Тип `ActorHostSourceDescriptor` разрешает любую строку в `subscriptionId` — и этого мало.
// Идентификатор наблюдаем автором: он приезжает в каждом конверте хостового события, автор кладёт
// его в свой FSM и по нему ветвится. Выбери значение хост — бэктестер, платформа и живая торговля
// выберут разные, и один и тот же код стратегии поведёт себя в трёх средах по-разному, причём
// молча: форма у всех трёх одинаковая, и ни одна проверка формы этого не заметит.
//
// Ровно это и случилось: бэктестер придумал себе `'sub-internal'`, потому что взять значение было
// неоткуда.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOST_SOURCE_DESCRIPTOR,
  HOST_SUBSCRIPTION_ID,
  findDuplicateSubscriptionIds,
  isHostSourceDescriptor,
  isHostSubscriptionId,
} from '../src/research-contract/index.js';
import type { ActorInit, ActorMarketSourceDescriptor } from '../src/research-contract/index.js';

const market: ActorMarketSourceDescriptor = {
  subscriptionId: 'sub-candles-1',
  kind: 'candles',
  requirementId: 'req-candles',
};

test('канонический дескриптор — хостовый и несёт канонический идентификатор', () => {
  assert.equal(isHostSourceDescriptor(HOST_SOURCE_DESCRIPTOR), true);
  assert.equal(HOST_SOURCE_DESCRIPTOR.subscriptionId, HOST_SUBSCRIPTION_ID);
  assert.equal(HOST_SOURCE_DESCRIPTOR.kind, 'host');
  // Ровно два поля: требования манифеста у хостового источника нет и быть не может.
  assert.deepEqual(Object.keys(HOST_SOURCE_DESCRIPTOR).sort(), ['kind', 'subscriptionId']);
});

test('дескриптор ЗАМОРОЖЕН — хост не может подправить его под себя', () => {
  // Иначе «канонический» держалось бы вежливостью: один вызывающий переписал бы поле, и значение
  // разошлось бы у всех, кто взял ту же ссылку.
  assert.equal(Object.isFrozen(HOST_SOURCE_DESCRIPTOR), true);
  assert.throws(() => {
    (HOST_SOURCE_DESCRIPTOR as { subscriptionId: string }).subscriptionId = 'sub-internal';
  });
  assert.equal(HOST_SOURCE_DESCRIPTOR.subscriptionId, HOST_SUBSCRIPTION_ID);
});

test('предикат по идентификатору согласован с предикатом по дескриптору', () => {
  // Две дороги к одному факту обязаны сходиться: конверт несёт только идентификатор, список
  // источников — дескрипторы, и разойтись им негде.
  assert.equal(isHostSubscriptionId(HOST_SUBSCRIPTION_ID), true);
  assert.equal(isHostSubscriptionId(market.subscriptionId), false);
  assert.equal(isHostSourceDescriptor(market), false);
});

test("ПРОВЕРКА ПРОВЕРКИ: 'sub-internal' каноническим НЕ является", () => {
  // Значение, придуманное хостом в 083 S3. Проба существует, чтобы попытка вернуть его как
  // «тоже хостовый» краснела здесь, а не обнаруживалась у автора на чужом хосте.
  assert.equal(isHostSubscriptionId('sub-internal'), false);
});

test('канонический источник кладётся в ActorInit наравне с рыночными', () => {
  const init: ActorInit = {
    params: {},
    seed: 3,
    symbol: 'BTCUSDT',
    subscriptions: [market, HOST_SOURCE_DESCRIPTOR],
  };
  // Правило автора остаётся ОДНИМ: `subscriptionId` конверта всегда есть в этом списке.
  assert.equal(
    init.subscriptions.some((s) => s.subscriptionId === HOST_SUBSCRIPTION_ID),
    true,
  );
  // И канонический идентификатор не сталкивается с рыночными: проверка дублей его видит.
  assert.deepEqual([...findDuplicateSubscriptionIds(init.subscriptions)], []);
  assert.deepEqual(
    [...findDuplicateSubscriptionIds([...init.subscriptions, HOST_SOURCE_DESCRIPTOR])],
    [HOST_SUBSCRIPTION_ID],
  );
});
