// 083 E1 — kernel-контракт `event_driven`: форма манифеста, валидатор формы, `defineActor`.
//
// Конформанс-гейт проверяет только «принято / отклонено»; здесь фиксируются коды причин, полнота
// диспетчера по замкнутому union'у событий и главный инвариант ранней посадки E1 — что существующие
// `single_position`-бандлы не затронуты вообще.
// Run: npx tsx --test test/event-driven.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTOR_COMMAND_KINDS,
  ACTOR_INPUT_EVENT_KINDS,
  CONTRACT_VERSION,
  DEFAULT_STRATEGY_LIFECYCLE,
  EVENT_DRIVEN_HOOKS,
  EVENT_DRIVEN_MIN_CONTRACT_VERSION,
  STRATEGY_LIFECYCLES,
  SUPPORTED_CONTRACT_VERSIONS,
  defineActor,
  platformContractContext,
  type ActorCommand,
  type ActorContext,
  type ActorInputEvent,
  type ModuleManifest,
} from '../src/research-contract/index.js';
import { validate, schemaAsset } from '../src/validation/index.js';
import { createSchemaRegistry } from '../src/validation/schema-registry.js';

const registry = createSchemaRegistry();

const CTX = platformContractContext();

const BASE: ModuleManifest = {
  id: 'm',
  version: '0.1.0',
  kind: 'strategy',
  name: 'M',
  summary: 's',
  rationale: 'r',
  author: 'agent',
  contractVersion: '017.3',
  status: 'research_only',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
  hooks: ['onBarClose'],
};

const ACTOR: ModuleManifest = {
  ...BASE,
  lifecycle: 'event_driven',
  hooks: ['init', 'onEvent', 'dispose'],
};

const check = (manifest: ModuleManifest) => validate({ inputKind: 'module', manifest }, CTX);
const codesOf = (manifest: ModuleManifest) => check(manifest).issues.map((i) => i.code);

// --- back-compat: ранний старт E1 не должен трогать существующие бандлы ---

test('манифест без lifecycle остаётся валидным и проецируется без поля формы', () => {
  const res = check(BASE);
  assert.equal(res.status, 'accepted');
  assert.ok(!('lifecycle' in (res.normalized as object)));
});

test('манифесты прежних версий контракта остаются поддержанными', () => {
  assert.deepEqual([...SUPPORTED_CONTRACT_VERSIONS], ['017.1', '017.2', '017.3']);
  assert.equal(CONTRACT_VERSION, '017.3');
  for (const contractVersion of ['017.1', '017.2', '017.3']) {
    assert.equal(check({ ...BASE, contractVersion }).status, 'accepted', contractVersion);
  }
});

// --- версия контракта ограждает новый surface ---

test('surface 083 E1 введён в 017.3 и под прежними версиями не принимается', () => {
  assert.equal(EVENT_DRIVEN_MIN_CONTRACT_VERSION, '017.3');
  for (const contractVersion of ['017.1', '017.2']) {
    for (const [label, manifest] of [
      ['lifecycle: event_driven', { ...ACTOR, contractVersion }],
      ['lifecycle: single_position', { ...BASE, lifecycle: 'single_position' as const, contractVersion }],
      ['хук onEvent', { ...ACTOR, lifecycle: undefined, contractVersion }],
    ] as const) {
      const res = check(manifest);
      assert.equal(res.status, 'rejected', `${contractVersion} / ${label}`);
      assert.ok(
        res.issues.some((i) => i.code === 'unsupported_contract_version' && i.path === '/contractVersion'),
        `${contractVersion} / ${label}: причина должна указывать на версию`,
      );
    }
  }
});

test('под 017.3 тот же surface принимается', () => {
  assert.equal(check({ ...ACTOR, contractVersion: '017.3' }).status, 'accepted');
});

test('манифест БЕЗ нового surface версией не ограждается', () => {
  for (const contractVersion of ['017.1', '017.2', '017.3']) {
    assert.equal(check({ ...BASE, contractVersion }).status, 'accepted', contractVersion);
  }
});

test('дефолтная форма — single_position', () => {
  assert.equal(DEFAULT_STRATEGY_LIFECYCLE, 'single_position');
  assert.deepEqual([...STRATEGY_LIFECYCLES], ['single_position', 'event_driven']);
});

test('явный single_position эквивалентен отсутствию поля, но попадает в проекцию', () => {
  const res = check({ ...BASE, lifecycle: 'single_position' });
  assert.equal(res.status, 'accepted');
  assert.equal((res.normalized as { lifecycle?: string }).lifecycle, 'single_position');
});

// --- валидатор формы ---

test('event_driven с единственной точкой входа принимается', () => {
  const res = check(ACTOR);
  assert.equal(res.status, 'accepted');
  assert.equal((res.normalized as { lifecycle?: string }).lifecycle, 'event_driven');
  assert.deepEqual((res.normalized as { hooks: string[] }).hooks, ['init', 'dispose', 'onEvent']);
});

test('event_driven без onEvent отклоняется', () => {
  assert.deepEqual(codesOf({ ...ACTOR, hooks: ['init', 'dispose'] }), ['lifecycle_form_invalid']);
});

test('event_driven с хуками фазовой модели отклоняется — по хуку на причину', () => {
  const res = check({ ...ACTOR, hooks: ['onEvent', 'onBarClose', 'onPositionBar'] });
  assert.equal(res.status, 'rejected');
  assert.deepEqual(
    res.issues.map((i) => [i.code, i.path]),
    [
      ['lifecycle_form_invalid', '/hooks/1'],
      ['lifecycle_form_invalid', '/hooks/2'],
    ],
  );
});

test('single_position с onEvent отклоняется', () => {
  const codes = codesOf({ ...BASE, hooks: ['onBarClose', 'onEvent'] });
  assert.deepEqual(codes, ['lifecycle_form_invalid']);
});

test('overlay не может объявить форму актора', () => {
  const overlay: ModuleManifest = {
    ...BASE,
    kind: 'overlay',
    lifecycle: 'event_driven',
    hooks: ['apply'],
    targetStrategyRef: 'm',
    interceptionPoint: 'post_decision',
  };
  const codes = validate(
    { inputKind: 'module', manifest: overlay },
    platformContractContext(['m']),
  ).issues.map((i) => i.code);
  assert.ok(codes.includes('lifecycle_form_invalid'));
});

test('неизвестная форма — schema_invalid по enum, без причин о наборе хуков', () => {
  const codes = codesOf({ ...BASE, lifecycle: 'multi_position' as never });
  assert.deepEqual(codes, ['schema_invalid']);
});

test('event_driven НЕ требует onBarClose (правило принадлежит фазовой модели)', () => {
  assert.ok(!codesOf(ACTOR).includes('schema_invalid'));
  assert.deepEqual([...EVENT_DRIVEN_HOOKS], ['init', 'onEvent', 'dispose']);
});

// --- defineActor ---

const CTX_STUB: ActorContext = {
  clock: { now: () => 1_700_000_000_000 },
  rng: { next: () => 0.5 },
  orders: { open: () => [] },
  position: () => null,
};

const BAR: ActorInputEvent = {
  kind: 'bar',
  ts: 1_700_000_000_000,
  bar: { ts: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
};

const PLACE: ActorCommand = {
  kind: 'place',
  clientOrderId: 'o-1',
  side: 'buy',
  type: 'limit',
  qtyUsd: 100,
  price: 1.4,
};

test('defineActor: специфичный хендлер получает событие своего вида', () => {
  const actor = defineActor({ onBar: () => [PLACE] });
  assert.deepEqual(actor.onEvent(BAR, CTX_STUB), [PLACE]);
});

test('defineActor: одиночная команда и null нормализуются к батчу', () => {
  assert.deepEqual(defineActor({ onBar: () => PLACE }).onEvent(BAR, CTX_STUB), [PLACE]);
  assert.deepEqual(defineActor({ onBar: () => null }).onEvent(BAR, CTX_STUB), []);
  assert.deepEqual(defineActor({ onBar: () => undefined }).onEvent(BAR, CTX_STUB), []);
});

test('defineActor: вид без своего хендлера уходит в catch-all onEvent', () => {
  const seen: string[] = [];
  const actor = defineActor({
    onBar: () => [],
    onEvent: (e) => {
      seen.push(e.kind);
      return [];
    },
  });
  for (const kind of ACTOR_INPUT_EVENT_KINDS) {
    if (kind === 'bar') continue;
    actor.onEvent(eventOf(kind), CTX_STUB);
  }
  assert.deepEqual(seen, ACTOR_INPUT_EVENT_KINDS.filter((k) => k !== 'bar'));
});

test('defineActor: специфичный хендлер имеет приоритет над catch-all', () => {
  const actor = defineActor({ onFill: () => [PLACE], onEvent: () => [] });
  assert.deepEqual(actor.onEvent(eventOf('fill'), CTX_STUB), [PLACE]);
});

test('defineActor: без хендлеров актор ничего не делает на каждом виде события', () => {
  const actor = defineActor({});
  for (const kind of ACTOR_INPUT_EVENT_KINDS) {
    assert.deepEqual(actor.onEvent(eventOf(kind), CTX_STUB), [], kind);
  }
});

test('defineActor: диспетчер покрывает ровно замкнутый каталог видов событий', () => {
  const handled: string[] = [];
  const actor = defineActor({
    onBar: (e) => void handled.push(e.kind),
    onOrderAccepted: (e) => void handled.push(e.kind),
    onOrderDenied: (e) => void handled.push(e.kind),
    onOrderRejected: (e) => void handled.push(e.kind),
    onOrderCanceled: (e) => void handled.push(e.kind),
    onOrderExpired: (e) => void handled.push(e.kind),
    onFill: (e) => void handled.push(e.kind),
    onTimer: (e) => void handled.push(e.kind),
    onEvent: () => assert.fail('catch-all не должен вызываться: все виды имеют свой хендлер'),
  });
  for (const kind of ACTOR_INPUT_EVENT_KINDS) actor.onEvent(eventOf(kind), CTX_STUB);
  assert.deepEqual(handled, [...ACTOR_INPUT_EVENT_KINDS]);
});

test('defineActor: неизвестный вид события — отказ, а не молчаливое игнорирование', () => {
  const actor = defineActor({ onEvent: () => [] });
  assert.throws(
    () => actor.onEvent({ kind: 'order.filled', ts: 1 } as unknown as ActorInputEvent, CTX_STUB),
    /неизвестный вид события/,
  );
});

// --- схемы конверта изолята ---

test('обе стороны конверта «событие → команды» забандлены как схемы', () => {
  for (const [name, kinds] of [
    ['actor-input-event', ACTOR_INPUT_EVENT_KINDS],
    ['actor-command', ACTOR_COMMAND_KINDS],
  ] as const) {
    const schema = schemaAsset(name);
    const text = JSON.stringify(schema);
    for (const kind of kinds) assert.ok(text.includes(`"${kind}"`), `${name} без ветки ${kind}`);
  }
});

test('через границу изолята валидируется БАТЧ, как его возвращает onEvent', () => {
  const batch = defineActor({ onBar: () => [PLACE] }).onEvent(BAR, CTX_STUB);
  assert.deepEqual(registry.validateCore('actor-command-batch', batch), []);
  assert.deepEqual(registry.validateCore('actor-command-batch', []), []);
  assert.ok(registry.validateCore('actor-command-batch', PLACE).length > 0, 'не массив');
});

test('неоднозначные команды отклоняются схемой, а не трактуются движком', () => {
  const ambiguous: readonly [string, unknown][] = [
    ['timer.set без atTs/afterMs', { kind: 'timer.set', timerId: 't' }],
    ['timer.set сразу с обоими', { kind: 'timer.set', timerId: 't', atTs: 1, afterMs: 2 }],
    ['limit без price', { kind: 'place', type: 'limit', clientOrderId: 'o', side: 'buy', qtyUsd: 1 }],
    [
      'stop_market без stopPrice',
      { kind: 'place', type: 'stop_market', clientOrderId: 'o', side: 'buy', qtyUsd: 1 },
    ],
    [
      'market с лимитной ценой',
      { kind: 'place', type: 'market', clientOrderId: 'o', side: 'buy', qtyUsd: 1, price: 5 },
    ],
    [
      'limit с триггерной ценой',
      {
        kind: 'place',
        type: 'limit',
        clientOrderId: 'o',
        side: 'buy',
        qtyUsd: 1,
        price: 5,
        stopPrice: 4,
      },
    ],
  ];
  for (const [label, cmd] of ambiguous) {
    assert.ok(registry.validateCore('actor-command', cmd).length > 0, `команда: ${label}`);
    assert.ok(registry.validateCore('actor-command-batch', [cmd]).length > 0, `батч: ${label}`);
  }
});

test('однозначные варианты тех же команд принимаются', () => {
  const wellFormed: readonly unknown[] = [
    { kind: 'timer.set', timerId: 't', atTs: 1 },
    { kind: 'timer.set', timerId: 't', afterMs: 60_000 },
    { kind: 'place', type: 'market', clientOrderId: 'o', side: 'buy', qtyUsd: 1 },
    { kind: 'place', type: 'limit', clientOrderId: 'o', side: 'buy', qtyUsd: 1, price: 5 },
    { kind: 'place', type: 'stop_market', clientOrderId: 'o', side: 'sell', qtyUsd: 1, stopPrice: 4 },
    { kind: 'cancel', clientOrderId: 'o' },
    { kind: 'timer.cancel', timerId: 't' },
    { kind: 'annotate', note: 'n' },
  ];
  for (const cmd of wellFormed) {
    assert.deepEqual(registry.validateCore('actor-command', cmd), [], JSON.stringify(cmd));
  }
  assert.deepEqual(registry.validateCore('actor-command-batch', wellFormed), []);
});

/** Минимальное событие каждого вида (для проверок диспетчера). */
function eventOf(kind: (typeof ACTOR_INPUT_EVENT_KINDS)[number]): ActorInputEvent {
  switch (kind) {
    case 'bar':
      return BAR;
    case 'order.accepted':
      return { kind, ts: 1, clientOrderId: 'o-1' };
    case 'order.denied':
      return { kind, ts: 1, clientOrderId: 'o-1', reason: 'max_notional' };
    case 'order.rejected':
      return { kind, ts: 1, clientOrderId: 'o-1', reason: 'venue' };
    case 'order.canceled':
      return { kind, ts: 1, clientOrderId: 'o-1' };
    case 'order.expired':
      return { kind, ts: 1, clientOrderId: 'o-1' };
    case 'fill':
      return { kind, ts: 1, clientOrderId: 'o-1', price: 1.5, qty: 10, fee: 0.01, last: true };
    case 'timer':
      return { kind, ts: 1, timerId: 't-1' };
  }
}
