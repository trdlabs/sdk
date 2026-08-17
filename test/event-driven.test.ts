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
  LIFECYCLE_FIELD_MIN_CONTRACT_VERSION,
  STRATEGY_LIFECYCLES,
  SUPPORTED_CONTRACT_VERSIONS,
  defineActor,
  durationUs,
  findDuplicateSubscriptionIds,
  isPlainActorState,
  platformContractContext,
  timestampUs,
  type ActorCommand,
  type ActorContext,
  type ActorHandlers,
  type ActorInit,
  type ActorInputEvent,
  type ActorStateValue,
  type ActorSubscriptionDescriptor,
  type EventDrivenModule,
  type FundingValue,
  type LiquidationsValue,
  type MarketDataRequirement,
  type ModuleManifest,
  type ObservedValue,
  type OpenInterestValue,
  type OpenLimitOrderView,
  type OpenMarketOrderView,
  type OpenOrderView,
  type StrategyActor,
  type TakerVolumeValue,
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

// 083 S1 задача 3: marketData обязателен для event_driven (`missing_market_data_requirement`) —
// минимальное валидное требование, не влияющее на то, что именно эти тесты проверяют (lifecycle/
// хуки/версия контракта), но необходимое, чтобы манифест вообще мог быть принят.
const ACTOR_MARKET_DATA: readonly MarketDataRequirement[] = [
  {
    kind: 'candles',
    id: 'req-candles',
    instrument: { venue: 'binance', symbol: 'BTCUSDT' },
    interval: durationUs(60_000_000),
    lookback: 200,
    revisionPolicy: { mode: 'final_only' },
    priceType: 'trade',
  },
];

// 083 S1 задача 6: весь surface актора (lifecycle/onEvent/marketData/warmup) требует ≥017.4 —
// `BASE.contractVersion` (017.3) больше НЕ покрывает его, значит `ACTOR` переопределяет версию
// явно (см. doc `EVENT_DRIVEN_MIN_CONTRACT_VERSION`, event-driven.ts).
const ACTOR: ModuleManifest = {
  ...BASE,
  contractVersion: '017.5',
  lifecycle: 'event_driven',
  hooks: ['init', 'onEvent', 'dispose'],
  marketData: ACTOR_MARKET_DATA,
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
  assert.deepEqual([...SUPPORTED_CONTRACT_VERSIONS], ['017.1', '017.2', '017.3', '017.4', '017.5', '017.6']);
  assert.equal(CONTRACT_VERSION, '017.6');
  for (const contractVersion of ['017.1', '017.2', '017.3', '017.4', '017.5', '017.6']) {
    assert.equal(check({ ...BASE, contractVersion }).status, 'accepted', contractVersion);
  }
});

// --- версия контракта ограждает новый surface ---

// 083 S1 задача 6: бамп подвинул порог ПЕРЕПИСАННОГО surface с 017.3 на 017.4 — 017.3, введший
// исходный E1-surface, больше его не покрывает (тот surface переписан целиком, см. doc
// EVENT_DRIVEN_MIN_CONTRACT_VERSION). Явный `lifecycle: 'single_position'` сюда НЕ входит — он
// живёт под отдельным, более низким порогом (см. следующий тест, I-1).
//
// 083 S3 (ADR-0012/0013): порог подвинулся ещё раз, с 017.4 на 017.5, и по той же причине — surface
// снова переписан: дескриптор источника стал замкнутым union'ом с хостовым вариантом, а
// `OpenOrderView` сменил состав полей (`qty` → `filledQtyUsd` плюс необязательные оценка и факт).
// Поэтому 017.4 теперь в списке ОТВЕРГАЮЩИХ: версия, описывающая форму, которой в пакете больше
// нет, не вправе её заявлять.
test('surface event_driven (lifecycle: event_driven/onEvent/marketData/warmup) требует >=017.5; 017.1-017.4 отвергают его', () => {
  assert.equal(EVENT_DRIVEN_MIN_CONTRACT_VERSION, '017.5');
  for (const contractVersion of ['017.1', '017.2', '017.3', '017.4'] as const) {
    for (const [label, manifest] of [
      ['lifecycle: event_driven', { ...ACTOR, contractVersion }],
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

// I-1 (ревью раунда 1 задачи 6, Important - исправлена регрессия). Явный `lifecycle:
// 'single_position'` - та же форма, что и дефолт (SC-008), НЕ переписанный surface `event_driven`:
// требует лишь `LIFECYCLE_FIELD_MIN_CONTRACT_VERSION` (017.3, порог самого поля `lifecycle`,
// введённого 083 E1 в 0.13.0), а не `EVENT_DRIVEN_MIN_CONTRACT_VERSION` (017.4). Первая версия
// задачи 6 гейтила ЛЮБОЕ значение поля `lifecycle` порогом 017.4 - доказано сборкой на двух
// коммитах: один и тот же манифест был `accepted` на базе задачи 5 и `rejected` после первой
// версии задачи 6 (см. doc `EVENT_DRIVEN_MIN_CONTRACT_VERSION`, event-driven.ts).
test('lifecycle: single_position требует лишь >=017.3 (поле, не переписанный surface) - 017.3 принимается', () => {
  assert.equal(LIFECYCLE_FIELD_MIN_CONTRACT_VERSION, '017.3');
  for (const contractVersion of ['017.1', '017.2'] as const) {
    const res = check({ ...BASE, lifecycle: 'single_position' as const, contractVersion });
    assert.equal(res.status, 'rejected', contractVersion);
    assert.ok(
      res.issues.some((i) => i.code === 'unsupported_contract_version' && i.path === '/contractVersion'),
      `${contractVersion}: причина должна указывать на версию`,
    );
  }
  const accepted = check({ ...BASE, lifecycle: 'single_position' as const, contractVersion: '017.3' });
  assert.equal(accepted.status, 'accepted', JSON.stringify(accepted.issues));
});

test('под 017.5 тот же surface принимается', () => {
  assert.equal(check({ ...ACTOR, contractVersion: '017.5' }).status, 'accepted');
});

test('манифест БЕЗ нового surface версией не ограждается', () => {
  for (const contractVersion of ['017.1', '017.2', '017.3', '017.4', '017.5']) {
    assert.equal(check({ ...BASE, contractVersion }).status, 'accepted', contractVersion);
  }
});

test('дефолтная форма — single_position', () => {
  assert.equal(DEFAULT_STRATEGY_LIFECYCLE, 'single_position');
  assert.deepEqual([...STRATEGY_LIFECYCLES], ['single_position', 'event_driven']);
});

test('явный single_position эквивалентен отсутствию поля, но попадает в проекцию', () => {
  // I-1 (задача 6): явное поле `lifecycle` — surface исходного E1-словаря (017.3), НЕ
  // переписанный surface `event_driven` (017.4) — BASE.contractVersion (017.3) уже достаточен,
  // override не нужен.
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
  // hooks содержит 'onEvent' — уже surface, версия ≥017.5 нужна, чтобы изолировать код именно
  // lifecycle_form_invalid (а не смешать его с unsupported_contract_version).
  const codes = codesOf({ ...BASE, contractVersion: '017.5', hooks: ['onBarClose', 'onEvent'] });
  assert.deepEqual(codes, ['lifecycle_form_invalid']);
});

test('overlay не может объявить форму актора', () => {
  const overlay: ModuleManifest = {
    ...BASE,
    contractVersion: '017.5',
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
  // I-1 (задача 6): поле lifecycle присутствует (хотя бы и с мусорным значением), но это НЕ
  // 'event_driven' — гейтится порогом 017.3 (LIFECYCLE_FIELD_MIN_CONTRACT_VERSION), которому
  // BASE.contractVersion уже удовлетворяет; override не нужен.
  const codes = codesOf({ ...BASE, lifecycle: 'multi_position' as never });
  assert.deepEqual(codes, ['schema_invalid']);
});

test('event_driven НЕ требует onBarClose (правило принадлежит фазовой модели)', () => {
  assert.ok(!codesOf(ACTOR).includes('schema_invalid'));
  assert.deepEqual([...EVENT_DRIVEN_HOOKS], ['init', 'onEvent', 'dispose']);
});

// --- defineActor ---

const CTX_STUB: ActorContext = {
  clock: { nowUs: () => timestampUs(1_700_000_000_000_000) },
  rng: { next: () => 0.5 },
  // 083 S1 задача 3: ActorContext вырос на readiness; для тестов диспетчера/хендлеров ниже
  // конкретное значение не важно (они не проверяют place-gate), фиксируем 'ready'.
  readiness: 'ready',
  // 083 S1, финальная волна ревью ветки (Б-3): ActorContext вырос на tradingState — режим, который
  // назначает хост (§3.10). Тесты диспетчера ниже его не читают, фиксируем штатный 'normal'.
  tradingState: 'normal',
  // 083 S1 задача 5: ActorContext вырос на orders/position (pull-модель). Тесты диспетчера ниже
  // не читают ни то ни другое — flat/без открытых заявок достаточно, чтобы типизироваться.
  orders: { open: () => [] },
  position: () => undefined,
};

/** Обёртка значения в `ObservedValue<T>` — `final`/`0`, единственная законная комбинация v1. */
function observed<T>(value: T): ObservedValue<T> {
  return { effectiveTsUs: timestampUs(1_700_000_000_000_000), value, finality: 'final', revision: 0 };
}

const CANDLE_CLOSED: ActorInputEvent = {
  kind: 'market.candle.closed',
  candle: observed({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }),
};

const PLACE: ActorCommand = {
  kind: 'place',
  clientOrderId: 'o-1',
  side: 'buy',
  type: 'limit',
  qtyUsd: 100,
  price: 1.4,
};

// --- ActorInit (задача 5, требование 1a): subscriptions ---

test('ActorInit несёт закрытый список ActorSubscriptionDescriptor; EventDrivenModule.createActor его получает', () => {
  const subscriptions: readonly ActorSubscriptionDescriptor[] = [
    { subscriptionId: 'binance:BTCUSDT:candles:1m', kind: 'candles', requirementId: 'req-candles' },
  ];
  const init: ActorInit = { params: {}, seed: 1, symbol: 'BTCUSDT', subscriptions };
  let seenInit: ActorInit | undefined;
  const module: EventDrivenModule = {
    createActor: (i) => {
      seenInit = i;
      return defineActor({});
    },
  };
  const actor = module.createActor(init);
  assert.deepEqual(seenInit?.subscriptions, subscriptions);
  assert.deepEqual(actor.onEvent(CANDLE_CLOSED, CTX_STUB), []);
});

// M-4 ревью раунда 1: дубли subscriptionId — типом не исключены, проверяются рантаймом.
test('findDuplicateSubscriptionIds: пусто без дублей, дубль возвращается один раз', () => {
  const noDup: readonly ActorSubscriptionDescriptor[] = [
    { subscriptionId: 'sub-1', kind: 'candles', requirementId: 'req-candles' },
    { subscriptionId: 'sub-2', kind: 'funding', requirementId: 'req-funding' },
  ];
  assert.deepEqual(findDuplicateSubscriptionIds(noDup), []);

  const withDup: readonly ActorSubscriptionDescriptor[] = [
    { subscriptionId: 'sub-1', kind: 'candles', requirementId: 'req-candles' },
    { subscriptionId: 'sub-1', kind: 'candles', requirementId: 'req-candles-2' },
    { subscriptionId: 'sub-2', kind: 'funding', requirementId: 'req-funding' },
  ];
  assert.deepEqual(findDuplicateSubscriptionIds(withDup), ['sub-1']);
});

// --- state-слот: ActorInit<S>.state / StrategyActor<S>.snapshotState (ревью раунда 1, I-3;
// раунд 2 — три Important на этой же поверхности: defineActor не мог произвести snapshotState
// вовсе (пункт 1, ЗАКРЫТО), снятие/восстановление не были связаны типом (пункт 2, дженерик S,
// ЗАКРЫТО), двойная опциональность делает потерю ненаблюдаемой (пункт 3, раунд 2 объявил границей
// слоя — ревью раунда 3 построило и скомпилировало контрпример: суждение было неверным именно
// ПОТОМУ, что дженерик уже введён, см. StrategyActor<S>/ActorHandlers<S>) ---

// I-3.2 (Minor, ревью раунда 3): своя форма `S` — `type`-псевдоним, НЕ `interface` (см. doc
// `ActorStateValue`, event-driven.ts, откуда взята эта рекомендация дословно) — `interface` без
// явной индексной сигнатуры не удовлетворяет `S extends ActorStateValue` (TS2344).
type CounterState = { readonly counter: number };
type SmaState = { readonly ticks: number; readonly sma: number };

test('I-3: StrategyActor.snapshotState/ActorInit.state — пара «снять/вернуть при чекпойнте»', () => {
  const priorState: CounterState = { counter: 3 };
  assert.ok(isPlainActorState(priorState), 'фикстура сама обязана быть валидным state-слотом');

  const init: ActorInit<CounterState> = {
    params: {},
    seed: 1,
    symbol: 'BTCUSDT',
    subscriptions: [],
    state: priorState,
  };

  let capturedInit: ActorInit<CounterState> | undefined;
  const module: EventDrivenModule<CounterState> = {
    createActor: (i) => {
      capturedInit = i;
      let counter = i.state?.counter ?? 0;
      const actor: StrategyActor<CounterState> = {
        onEvent: () => {
          counter += 1;
          return [];
        },
        snapshotState: () => ({ counter }),
      };
      return actor;
    },
  };

  const actor = module.createActor(init);
  assert.deepEqual(capturedInit?.state, priorState);
  actor.onEvent(CANDLE_CLOSED, CTX_STUB);
  const snapshot = actor.snapshotState();
  assert.ok(isPlainActorState(snapshot), 'снятое состояние обязано пройти isPlainActorState на границе хоста');
  assert.deepEqual(snapshot, { counter: 4 });

  // Первый запуск актора — состояния снимать ещё не с чего, `state` опционален.
  const firstRunInit: ActorInit<CounterState> = { params: {}, seed: 2, symbol: 'ETHUSDT', subscriptions: [] };
  assert.equal(firstRunInit.state, undefined);
});

// I-3 ревью раунда 2, пункт 2 (Important): снятие и восстановление были ДВУМЯ независимыми полями
// одного и того же широкого ActorStateValue — «снял одно, вернул другое» компилировалось. Дженерик
// `S` теперь связывает `StrategyActor<S>.snapshotState(): S` и `ActorInit<S>.state?: S` ОДНИМ
// параметром типа — несовпадение форм красит СБОРКУ, не рантайм.
test('I-3 раунд 2, п.2: параметризованные StrategyActor<S>/ActorInit<S> связывают снятие и восстановление типом', () => {
  // Совместимая пара — типизируется и работает.
  const compatibleModule: EventDrivenModule<SmaState> = {
    createActor: (init) => ({
      onEvent: () => [],
      snapshotState: () => ({ ticks: (init.state?.ticks ?? 0) + 1, sma: init.state?.sma ?? 0 }),
    }),
  };
  const compatibleInit: ActorInit<SmaState> = {
    params: {},
    seed: 1,
    symbol: 'BTCUSDT',
    subscriptions: [],
    state: { ticks: 1, sma: 100 },
  };
  const compatibleActor = compatibleModule.createActor(compatibleInit);
  assert.deepEqual(compatibleActor.snapshotState(), { ticks: 2, sma: 100 });

  // Несовместимая пара — актор снимает SmaState, но объявлен как StrategyActor<string> (голая
  // строка вместо структурированного состояния): раньше (общий ActorStateValue с обеих сторон)
  // компилировалось молча; с дженериком — ошибка компиляции РОВНО там, где формы разошлись.
  const mismatched: StrategyActor<string> = {
    onEvent: () => [],
    // @ts-expect-error — snapshotState возвращает SmaState, не string: несовпадение типового
    // параметра между декларацией StrategyActor<string> и телом, которое снимает объект.
    snapshotState: (): SmaState => ({ ticks: 1, sma: 100 }),
  };
  void mismatched;
});

// I-3 ревью раунда 2, пункт 1 (Important): собственный сахар SDK (`defineActor`) не мог произвести
// `snapshotState` вовсе — `Reflect.ownKeys(actor)` был `['onEvent']` ПРИ ЛЮБЫХ переданных
// хендлерах. Тест ниже — РОВНО проверка ревью, обеими сторонами (с хендлером и без).
test('I-3 раунд 2, п.1: defineActor производит snapshotState, когда handlers.snapshotState передан', () => {
  const stateless = defineActor({});
  assert.deepEqual(Reflect.ownKeys(stateless), ['onEvent'], 'без хендлера — поля snapshotState нет вовсе');
  assert.equal(stateless.snapshotState, undefined);

  const stateful = defineActor({ snapshotState: () => ({ n: 1 }) });
  assert.deepEqual(
    Reflect.ownKeys(stateful),
    ['onEvent', 'snapshotState'],
    'с хендлером — поле присутствует симметрично объявленному',
  );
  assert.deepEqual(stateful.snapshotState?.(), { n: 1 });
});

// ─────────────────────────────────────────────────────────────────────────────
// I-3.3 (ревью раунда 3): условный тип делает snapshotState ОБЯЗАТЕЛЬНЫМ, когда S параметризован
// конкретным сужением — раунд 2 объявил дважды-опциональность «границей слоя, не решаемой типами»;
// ревьюер построил и скомпилировал контрпример против установленного пакета, суждение было
// неверным. ActorStateValue extends S истинно ТОЛЬКО когда S — сам дефолт (S = ActorStateValue);
// для любого конкретного сужения (StrategyActor<Sma>) ветвь становится { snapshotState(): S } —
// обязательной.
// ─────────────────────────────────────────────────────────────────────────────

test('I-3.3: StrategyActor<S> С конкретным S требует snapshotState — компилируется, когда он есть', () => {
  const withState: StrategyActor<SmaState> = {
    onEvent: () => [],
    snapshotState: () => ({ ticks: 1, sma: 100 }),
  };
  assert.deepEqual(withState.snapshotState(), { ticks: 1, sma: 100 });
});

test('I-3.3: StrategyActor<S> БЕЗ snapshotState — ошибка компиляции (раньше молча терялось состояние)', () => {
  // @ts-expect-error — StrategyActor<SmaState> ОБЯЗАН нести snapshotState: ActorStateValue extends
  // SmaState ложно (SmaState — конкретное сужение), ветвь условного типа — { snapshotState(): S }.
  const missingSnapshot: StrategyActor<SmaState> = { onEvent: () => [] };
  void missingSnapshot;
});

test('I-3.3: defineActor<S>(...) БЕЗ handlers.snapshotState — ошибка компиляции (прогон ревью буквально)', () => {
  // Прогон ревью: `defineActor<Sma>({ onFill: () => [] })` типизировался (актор с рантайм-ownKeys
  // === ['onEvent']) — автор явно объявил ТИП состояния и получил актора, который его никогда не
  // снимет. ActorHandlers<S> несёт то же условие, что StrategyActor<S> — теперь это ошибка сборки.
  // @ts-expect-error — ActorHandlers<SmaState> требует snapshotState(): SmaState.
  const actor = defineActor<SmaState>({ onFill: () => [] });
  void actor;
});

test('I-3.3: EventDrivenModule<S>, возвращающий актора без snapshotState — ошибка компиляции', () => {
  const badModule: EventDrivenModule<SmaState> = {
    // @ts-expect-error — StrategyActor<SmaState> (возвращаемый тип createActor) требует
    // snapshotState; { onEvent } его не несёт.
    createActor: () => ({ onEvent: () => [] }),
  };
  void badModule;
});

test('I-3.3: непараметризованный StrategyActor (дефолт) остаётся ПОЛНОСТЬЮ обратно совместимым', () => {
  // Три формы из доки ревью — все компилируются: непараметризованный без состояния,
  // непараметризованный со snapshotState, явный <ActorStateValue>.
  const stateless: StrategyActor = { onEvent: () => [] };
  const stateful: StrategyActor = { onEvent: () => [], snapshotState: () => ({ n: 1 }) };
  const explicit: StrategyActor<ActorStateValue> = { onEvent: () => [] };
  assert.equal(stateless.snapshotState, undefined);
  assert.deepEqual(stateful.snapshotState?.(), { n: 1 });
  assert.equal(explicit.snapshotState, undefined);
});

// Новый Important, ревью раунда 3: извлечение `handlers.snapshotState` в переменную перед вызовом
// теряет `this` — все остальные хендлеры зовутся как `handlers.onX(...)` (this = handlers), а
// вырванный `snapshotState` звался бы «голым». Каноническая форма актора с состоянием (методы на
// объекте хендлеров, читающие `this`) типизировалась и падала TypeError.
test('Новый дефект раунда 3: defineActor сохраняет `this = handlers` при вызове snapshotState', () => {
  const handlers = {
    count: 0,
    onFill(): readonly ActorCommand[] {
      this.count += 1;
      return [];
    },
    snapshotState(): ActorStateValue {
      return { count: this.count };
    },
  };
  const actor = defineActor(handlers);
  actor.onEvent({ kind: 'fill', clientOrderId: 'o-1', price: 1, qty: 1, fee: 0, last: true }, CTX_STUB);
  assert.doesNotThrow(() => actor.snapshotState?.(), 'this внутри snapshotState обязан указывать на handlers');
  assert.deepEqual(actor.snapshotState?.(), { count: 1 });
});

// --- OpenOrderView: дискриминированный union по type (ревью раунда 1, I-7); status (I-2) ---

test('I-7: OpenOrderView — market/limit/stop_market дискриминированы, как ActorPlaceCommand', () => {
  const market: OpenMarketOrderView = {
    clientOrderId: 'o-1',
    side: 'buy',
    type: 'market',
    status: 'accepted',
    qtyUsd: 100,
    filledQtyUsd: 0,
    estimatedQty: 0.002,
    filledQty: 0,
    createdTs: timestampUs(1_700_000_000_000_000),
  };
  const limit: OpenLimitOrderView = {
    clientOrderId: 'o-2',
    side: 'sell',
    type: 'limit',
    status: 'submitted',
    qtyUsd: 100,
    filledQtyUsd: 0,
    estimatedQty: 0.002,
    filledQty: 0,
    price: 55_000,
    createdTs: timestampUs(1_700_000_000_000_000),
  };
  const views: readonly OpenOrderView[] = [market, limit];
  assert.equal(views[0]?.type, 'market');
  assert.equal(views[1]?.type, 'limit');

  // Остаток заявки вычислим — и считается он в ЕДИНИЦЕ ЗАЯВКИ (ADR-0013, `017.5`). Прежде здесь
  // стояло `qty − filledQty` в базовой валюте; base-величина оказалась невыразимой у хоста без цены
  // пересчёта и подставлялась нулём, из-за чего остаток читался как «исполнена целиком».
  assert.equal(market.qtyUsd - market.filledQtyUsd, 100);
  // Базовые величины при этом остаются доступными — но как оценка и факт, а не как основа остатка.
  assert.equal(market.estimatedQty, 0.002);
  assert.equal(market.filledQty, 0);

  // @ts-expect-error — лимитная заявка без price неоднозначна, симметрично ActorPlaceLimitCommand.
  const missingPrice: OpenLimitOrderView = {
    clientOrderId: 'o-3',
    side: 'buy',
    type: 'limit',
    status: 'accepted',
    qtyUsd: 100,
    filledQtyUsd: 0,
    estimatedQty: 0.002,
    filledQty: 0,
    createdTs: timestampUs(1),
  };
  void missingPrice;

  const marketWithPrice: OpenMarketOrderView = {
    clientOrderId: 'o-4',
    side: 'buy',
    type: 'market',
    status: 'accepted',
    qtyUsd: 100,
    filledQtyUsd: 0,
    estimatedQty: 0.002,
    filledQty: 0,
    // @ts-expect-error — рыночная заявка с ценой неоднозначна, симметрично ActorPlaceMarketCommand.
    price: 50_000,
    createdTs: timestampUs(1),
  };
  void marketWithPrice;
});

test('I-2: status различает submitted/accepted — ортогонально filledQty', () => {
  const submitted: OpenMarketOrderView = {
    clientOrderId: 'o-1',
    side: 'buy',
    type: 'market',
    status: 'submitted',
    qtyUsd: 100,
    filledQtyUsd: 0,
    estimatedQty: 0.002,
    filledQty: 0,
    createdTs: timestampUs(1),
  };
  const accepted: OpenMarketOrderView = { ...submitted, status: 'accepted' };
  // Оба несут filledQty:0 — status различает их РОВНО там, где filledQty не может (прогон ревью:
  // старая форма без status давала побайтово идентичные объекты для этих двух стадий).
  assert.notDeepEqual(submitted, accepted);
  assert.equal(submitted.filledQty, accepted.filledQty);
});

// Minor, ревью раунда 2: довод «управлять живой заявкой», которым в раунде 1 вернули createdTs,
// применим к time-in-force ровно так же — актор не может решить, ждать/отменять заявку, не зная
// её условия исполнения. `tif` опционален (симметрично `ActorPlaceCommand.tif`).
test('Minor: OpenOrderView несёт опциональный tif — та же единица, что ActorPlaceCommand.tif', () => {
  const withTif: OpenLimitOrderView = {
    clientOrderId: 'o-1',
    side: 'buy',
    type: 'limit',
    status: 'accepted',
    qtyUsd: 100,
    filledQtyUsd: 0,
    estimatedQty: 0.002,
    filledQty: 0,
    price: 50_000,
    tif: 'ioc',
    createdTs: timestampUs(1),
  };
  assert.equal(withTif.tif, 'ioc');

  // Опционален: литерал без tif остаётся валидным (существующие вызывающие не ломаются).
  const withoutTif: OpenLimitOrderView = {
    clientOrderId: 'o-2',
    side: 'buy',
    type: 'limit',
    status: 'accepted',
    qtyUsd: 100,
    filledQtyUsd: 0,
    estimatedQty: 0.002,
    filledQty: 0,
    price: 50_000,
    createdTs: timestampUs(1),
  };
  assert.equal(withoutTif.tif, undefined);
});

test('defineActor: специфичный хендлер получает событие своего вида', () => {
  const actor = defineActor({ onMarketCandleClosed: () => [PLACE] });
  assert.deepEqual(actor.onEvent(CANDLE_CLOSED, CTX_STUB), [PLACE]);
});

test('defineActor: одиночная команда и null нормализуются к батчу', () => {
  assert.deepEqual(defineActor({ onMarketCandleClosed: () => PLACE }).onEvent(CANDLE_CLOSED, CTX_STUB), [
    PLACE,
  ]);
  assert.deepEqual(defineActor({ onMarketCandleClosed: () => null }).onEvent(CANDLE_CLOSED, CTX_STUB), []);
  assert.deepEqual(
    defineActor({ onMarketCandleClosed: () => undefined }).onEvent(CANDLE_CLOSED, CTX_STUB),
    [],
  );
});

test('defineActor: вид без своего хендлера уходит в catch-all onEvent', () => {
  const seen: string[] = [];
  const actor = defineActor({
    onMarketCandleClosed: () => [],
    onEvent: (e) => {
      seen.push(e.kind);
      return [];
    },
  });
  for (const kind of ACTOR_INPUT_EVENT_KINDS) {
    if (kind === 'market.candle.closed') continue;
    actor.onEvent(eventOf(kind), CTX_STUB);
  }
  assert.deepEqual(
    seen,
    ACTOR_INPUT_EVENT_KINDS.filter((k) => k !== 'market.candle.closed'),
  );
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
    onMarketCandleClosed: (e) => void handled.push(e.kind),
    onMarketOpenInterestObserved: (e) => void handled.push(e.kind),
    onMarketLiquidationsBucketClosed: (e) => void handled.push(e.kind),
    onMarketTakerVolumeBucketClosed: (e) => void handled.push(e.kind),
    onMarketFundingObserved: (e) => void handled.push(e.kind),
    onMarketSubscriptionStatusChanged: (e) => void handled.push(e.kind),
    onOrderAccepted: (e) => void handled.push(e.kind),
    onOrderDenied: (e) => void handled.push(e.kind),
    onOrderRejected: (e) => void handled.push(e.kind),
    onOrderCanceled: (e) => void handled.push(e.kind),
    onCancelRejected: (e) => void handled.push(e.kind),
    onOrderExpired: (e) => void handled.push(e.kind),
    onFill: (e) => void handled.push(e.kind),
    onTimerFired: (e) => void handled.push(e.kind),
    onTradingStateChanged: (e) => void handled.push(e.kind),
    onEvent: () => assert.fail('catch-all не должен вызываться: все виды имеют свой хендлер'),
  });
  for (const kind of ACTOR_INPUT_EVENT_KINDS) actor.onEvent(eventOf(kind), CTX_STUB);
  assert.deepEqual(handled, [...ACTOR_INPUT_EVENT_KINDS]);
});

test('defineActor: неизвестный вид события — отказ, а не молчаливое игнорирование', () => {
  const actor = defineActor({ onEvent: () => [] });
  assert.throws(
    () => actor.onEvent({ kind: 'order.filled' } as unknown as ActorInputEvent, CTX_STUB),
    /неизвестный вид события/,
  );
});

// Решение владельца (ревью PR sdk#34): правило «вид события → имя хендлера» ТОТАЛЬНО. Пинуется
// ФОРМУЛОЙ, а не списком: список пришлось бы держать согласованным руками — ровно та работа, от
// которой правило избавляет. Тест обязателен именно здесь, потому что промах по имени НЕ ловится
// ничем в рантайме: все хендлеры опциональны, необъявленный — законная форма «вид игнорируется»,
// так что неправильно названный хендлер даёт не ошибку, а тишину (событие уедет в catch-all
// `onEvent`, а без него — в пустой батч). Тест ловил бы и `onTimer` при `timer.fired`, и
// `onOrderCancelRejected` при `cancel.rejected` — оба исключения, снятые этой правкой.
test('defineActor: имя хендлера ВЫВОДИТСЯ из вида события — тотально, без исключений', () => {
  const handlerNameOf = (kind: string): string =>
    'on' +
    kind
      .split(/[._]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');

  // Самопроверка формулы на двух заведомо известных концах: без неё сломанная формула совпадала бы
  // сама с собой, и тест был бы зелёным, не проверяя ничего.
  assert.equal(handlerNameOf('fill'), 'onFill');
  assert.equal(handlerNameOf('market.taker_volume.bucket_closed'), 'onMarketTakerVolumeBucketClosed');

  for (const kind of ACTOR_INPUT_EVENT_KINDS) {
    const expected = handlerNameOf(kind);
    const called: string[] = [];
    const actor = defineActor({
      [expected]: () => void called.push(kind),
      onEvent: () => assert.fail(`вид ${kind}: диспетчер не нашёл хендлер по имени ${expected}`),
    } as ActorHandlers);

    actor.onEvent(eventOf(kind), CTX_STUB);
    assert.deepEqual(called, [kind], `вид ${kind} обязан попасть в ${expected}`);
  }
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
  const batch = defineActor({ onMarketCandleClosed: () => [PLACE] }).onEvent(CANDLE_CLOSED, CTX_STUB);
  assert.deepEqual(registry.validateCore('actor-command-batch', batch), []);
  assert.deepEqual(registry.validateCore('actor-command-batch', []), []);
  assert.ok(registry.validateCore('actor-command-batch', PLACE).length > 0, 'не массив');
});

test('неоднозначные команды отклоняются схемой, а не трактуются движком', () => {
  const ambiguous: readonly [string, unknown][] = [
    ['timer.set без atTs/afterUs', { kind: 'timer.set', timerId: 't' }],
    ['timer.set сразу с обоими', { kind: 'timer.set', timerId: 't', atTs: 1, afterUs: 2 }],
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
    { kind: 'timer.set', timerId: 't', afterUs: 60_000 },
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
    case 'market.candle.closed':
      return CANDLE_CLOSED;
    case 'market.open_interest.observed':
      return { kind, oi: observed<OpenInterestValue>({ oiTotalUsd: 1_000 }) };
    case 'market.liquidations.bucket_closed':
      return { kind, liq: observed<LiquidationsValue>({ longUsd: 0, shortUsd: 0 }) };
    case 'market.taker_volume.bucket_closed':
      return { kind, taker: observed<TakerVolumeValue>({ buyUsd: 0, sellUsd: 0 }) };
    case 'market.funding.observed':
      return { kind, funding: observed<FundingValue>({ fundingRate: 0.0001 }) };
    case 'market.subscription.status_changed':
      return { kind, status: { state: 'gap', expectedTsUs: timestampUs(1_700_000_000_000_000) } };
    case 'order.accepted':
      return { kind, clientOrderId: 'o-1' };
    case 'order.denied':
      return { kind, clientOrderId: 'o-1', reason: 'max_notional' };
    case 'order.rejected':
      return { kind, clientOrderId: 'o-1', reason: 'venue' };
    case 'order.canceled':
      return { kind, clientOrderId: 'o-1' };
    case 'cancel.rejected':
      return { kind, clientOrderId: 'o-1', reason: 'already_filled' };
    case 'order.expired':
      return { kind, clientOrderId: 'o-1' };
    case 'fill':
      return { kind, clientOrderId: 'o-1', price: 1.5, qty: 10, fee: 0.01, last: true };
    case 'timer.fired':
      return { kind, timerId: 't-1', dueTsUs: timestampUs(1) };
    case 'trading_state.changed':
      return { kind, previous: 'normal', state: 'reducing' };
  }
}
