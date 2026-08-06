// 083 S1 задача 6 — §3.10, `MARKET_KIND_RANK`, бамп контракта до `017.4`.
//
// Что здесь пинуется (см. task-6-brief.md, control-center):
//   1) `017.4` валидирует новый surface актора; `017.1`–`017.3` продолжают валидироваться для
//      манифестов БЕЗ этого surface (single_position);
//   2) манифест с новым surface (lifecycle/marketData) под `017.3` отвергается внятным кодом —
//      `017.3` когда-то ВВОДИЛ этот surface, но задачи 1–5 переписали его целиком, и порог
//      подвинулся на `017.4` (см. doc `EVENT_DRIVEN_MIN_CONTRACT_VERSION`, event-driven.ts);
//   3) `MARKET_KIND_RANK` согласован с `MARKET_DATA_KINDS` — ровно те же ключи, ни больше ни
//      меньше, проверено программно (не только типом `Record<MarketDataKind, number>`, который
//      уже даёт эту гарантию на этапе типов через excess-property-check);
//   4) `cancel.rejected` — в `ACTOR_INPUT_EVENT_KINDS` и в союзе `ActorInputEvent`, двусторонняя
//      гарантия (`AssertNoUncoveredKind`, event-driven.ts) не сломана;
//   5) бюджеты: `ActorDispatchBudget`/`ActorCumulativeFrontierBudget`/`ActorBudgets` — форма
//      per-dispatch и кумулятивная per-frontier ЕСТЬ, per-session — НЕТ (типовой тест на
//      отсутствие через excess-property-check);
//   6) дом RNG — `ActorContext.rng: ActorRng`, именованный тип, а не анонимная структура;
//      спрятанный в авторском состоянии генератор НЕЧЕКПОЙНТАБЕЛЕН — замыкание не переживает
//      `isPlainActorState` на границе состояния. Это НЕ «ambient-случайность физически
//      недостижима»: формулировка была опровергнута прогоном и сужена в доке `ActorRng`
//      (задача 6, ревью раунда 1, I-2) — `Math.random()`/`Date.now()` доступны прямо в хендлере,
//      module-scope замыкание переживает вызовы `onEvent`, и закрытие ЭТОГО класса (статик-гейт
//      плюс replay-гейт) — обязательство S2, а не форма `sdk`. Шапка приведена в соответствие с
//      контрактом финальной волной ревью ветки: файл утверждал опровергнутое;
//   7) `CONTRACT_VERSION`/`SUPPORTED_CONTRACT_VERSIONS` из ДВУХ мест (`contract/constants.ts` —
//      published root barrel; `research-contract/catalogs.ts` — активная копия, ведущая
//      валидацию) синхронизированы — иначе `@trdlabs/sdk` и `@trdlabs/sdk/research-contract`
//      отвечали бы на «какая версия контракта действует сейчас» по-разному.
//
// Существующие тесты (event-driven.test.ts, market-data-requirement.test.ts,
// actor-market-events.test.ts) остаются зелёными — правки версии там пункт 6 этого же файла.
// Run: npx tsx --test test/actor-budgets-and-order.test.ts
// Type-check (обязателен для пунктов 5/6 — @ts-expect-error): npx tsc -p tsconfig.test.json
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTRACT_VERSION as CONTRACT_VERSION_ROOT,
  MARKET_DATA_KINDS as MARKET_DATA_KINDS_ROOT,
  MARKET_KIND_RANK as MARKET_KIND_RANK_ROOT,
  SUPPORTED_CONTRACT_VERSIONS as SUPPORTED_CONTRACT_VERSIONS_ROOT,
} from '../src/contract/constants.js';
import {
  ACTOR_INPUT_EVENT_KINDS,
  CONTRACT_VERSION,
  EVENT_DRIVEN_MIN_CONTRACT_VERSION,
  MARKET_DATA_KINDS,
  MARKET_KIND_RANK,
  SUPPORTED_CONTRACT_VERSIONS,
  TRADING_STATES,
  durationUs,
  isPlainActorState,
  platformContractContext,
  timestampUs,
  type ActorBudgets,
  type ActorContext,
  type ActorCumulativeFrontierBudget,
  type ActorDispatchBudget,
  type ActorInit,
  type ActorInputEvent,
  type ActorRng,
  type MarketDataRequirement,
  type ModuleManifest,
  type TradingState,
} from '../src/research-contract/index.js';
import { validate } from '../src/validation/index.js';
import { createSchemaRegistry } from '../src/validation/schema-registry.js';

const registry = createSchemaRegistry();

const CTX = platformContractContext();
const check = (manifest: ModuleManifest) => validate({ inputKind: 'module', manifest }, CTX);

const CANDLES_REQ: MarketDataRequirement = {
  kind: 'candles',
  id: 'req-candles',
  instrument: { venue: 'binance', symbol: 'BTCUSDT' },
  interval: durationUs(60_000_000),
  lookback: 200,
  revisionPolicy: { mode: 'final_only' },
  priceType: 'trade',
};

const SINGLE_POSITION_BASE: ModuleManifest = {
  id: 'm',
  version: '0.1.0',
  kind: 'strategy',
  name: 'M',
  summary: 's',
  rationale: 'r',
  author: 'agent',
  contractVersion: '017.1',
  status: 'research_only',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
  hooks: ['onBarClose'],
};

const ACTOR_BASE: ModuleManifest = {
  ...SINGLE_POSITION_BASE,
  contractVersion: '017.4',
  lifecycle: 'event_driven',
  hooks: ['onEvent'],
  marketData: [CANDLES_REQ],
};

// ─────────────────────────────────────────────────────────────────────────────
// 1) 017.4 валидирует новый surface; 017.1–017.3 продолжают валидироваться (single_position).
// ─────────────────────────────────────────────────────────────────────────────

test('017.4 валидирует новый surface актора', () => {
  const res = check(ACTOR_BASE);
  assert.equal(res.status, 'accepted', JSON.stringify(res.issues));
});

test('017.1–017.3 продолжают валидироваться для манифестов БЕЗ нового surface', () => {
  for (const contractVersion of ['017.1', '017.2', '017.3'] as const) {
    const res = check({ ...SINGLE_POSITION_BASE, contractVersion });
    assert.equal(res.status, 'accepted', contractVersion);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Манифест с новым surface под 017.3 отвергается внятным кодом (017.3 больше НЕ покрывает
//    surface, который когда-то вводил).
// ─────────────────────────────────────────────────────────────────────────────

test('манифест с surface актора под 017.1/017.2/017.3 отвергается unsupported_contract_version', () => {
  for (const contractVersion of ['017.1', '017.2', '017.3'] as const) {
    const res = check({ ...ACTOR_BASE, contractVersion });
    assert.equal(res.status, 'rejected', contractVersion);
    const issue = res.issues.find((i) => i.code === 'unsupported_contract_version');
    assert.ok(issue, `${contractVersion}: код должен быть unsupported_contract_version, получено ${JSON.stringify(res.issues)}`);
    assert.equal(issue?.path, '/contractVersion');
    // «внятный код» — сообщение обязано называть требуемый порог, а не просто «версия не та».
    assert.match(issue?.message ?? '', /017\.4/);
  }
});

test('warmup — тоже часть surface (долг задачи 3, закрыт здесь): под 017.1 отвергается', () => {
  const withWarmup: ModuleManifest = {
    ...SINGLE_POSITION_BASE,
    contractVersion: '017.1',
    warmup: { kind: 'tape_replay' },
  };
  const res = check(withWarmup);
  assert.equal(res.status, 'rejected');
  assert.ok(res.issues.some((i) => i.code === 'unsupported_contract_version' && i.path === '/contractVersion'));
});

test('warmup под 017.4 принимается', () => {
  const withWarmup: ModuleManifest = {
    ...SINGLE_POSITION_BASE,
    contractVersion: '017.4',
    warmup: { kind: 'tape_replay' },
  };
  assert.equal(check(withWarmup).status, 'accepted');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) MARKET_KIND_RANK — единственный источник порядка, ключи ровно MARKET_DATA_KINDS.
// ─────────────────────────────────────────────────────────────────────────────

test('MARKET_KIND_RANK: ключи ровно MARKET_DATA_KINDS, ни больше ни меньше', () => {
  assert.deepEqual(Object.keys(MARKET_KIND_RANK).sort(), [...MARKET_DATA_KINDS].sort());
  assert.equal(Object.keys(MARKET_KIND_RANK).length, MARKET_DATA_KINDS.length);
});

test('MARKET_KIND_RANK: значения — перестановка 1..5 без дублей', () => {
  const values = Object.values(MARKET_KIND_RANK).sort((a, b) => a - b);
  assert.deepEqual(values, [1, 2, 3, 4, 5]);
});

test('MARKET_KIND_RANK: нормативный порядок §3.8.2 — candle последним, open_interest первым', () => {
  assert.equal(MARKET_KIND_RANK.open_interest, 1);
  assert.equal(MARKET_KIND_RANK.liquidations, 2);
  assert.equal(MARKET_KIND_RANK.taker_volume, 3);
  assert.equal(MARKET_KIND_RANK.funding, 4);
  assert.equal(MARKET_KIND_RANK.candles, 5);
  // "Свеча последней" — буквально: её ранг СТРОГО больше ранга любого другого вида.
  for (const kind of MARKET_DATA_KINDS) {
    if (kind === 'candles') continue;
    assert.ok(MARKET_KIND_RANK.candles > MARKET_KIND_RANK[kind], `candles должен быть после ${kind}`);
  }
});

test('MARKET_KIND_RANK достижим и идентичен из @trdlabs/sdk и из @trdlabs/sdk/research-contract', () => {
  assert.deepEqual(MARKET_KIND_RANK_ROOT, MARKET_KIND_RANK);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) cancel.rejected — в ACTOR_INPUT_EVENT_KINDS и в союзе; двусторонняя гарантия не сломана.
// ─────────────────────────────────────────────────────────────────────────────

test('cancel.rejected присутствует в ACTOR_INPUT_EVENT_KINDS ровно один раз', () => {
  const occurrences = ACTOR_INPUT_EVENT_KINDS.filter((k) => k === 'cancel.rejected');
  assert.deepEqual(occurrences, ['cancel.rejected']);
});

test('cancel.rejected: замкнутый союз ActorInputEvent принимает форму и различает kind структурно', () => {
  const event: ActorInputEvent = {
    kind: 'cancel.rejected',
    ts: timestampUs(1_700_000_000_000_000),
    clientOrderId: 'o-1',
    reason: 'already_filled',
  };
  assert.equal(event.kind, 'cancel.rejected');

  // @ts-expect-error — cancel.rejected несёт reason (терминальный отказ), как order.rejected/denied;
  // литерал без него не должен типизироваться как ActorInputEvent.
  const missingReason: ActorInputEvent = {
    kind: 'cancel.rejected',
    ts: timestampUs(1),
    clientOrderId: 'o-1',
  };
  void missingReason;
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Бюджеты: per-dispatch и кумулятивный per-frontier — форма есть; per-session — НЕТ.
// ─────────────────────────────────────────────────────────────────────────────

test('ActorDispatchBudget: все поля — per-dispatch, опциональны', () => {
  const empty: ActorDispatchBudget = {};
  const full: ActorDispatchBudget = {
    maxCpuUs: durationUs(5_000),
    maxWallUs: durationUs(10_000),
    maxCommandsPerBatch: 32,
  };
  assert.deepEqual(empty, {});
  assert.equal(full.maxCommandsPerBatch, 32);
});

test('ActorCumulativeFrontierBudget: maxCascadeDepth/maxEventsPerFrontier обязательны', () => {
  const budget: ActorCumulativeFrontierBudget = { maxCascadeDepth: 8, maxEventsPerFrontier: 256 };
  assert.equal(budget.maxCascadeDepth, 8);
  assert.equal(budget.maxEventsPerFrontier, 256);

  // @ts-expect-error — оба поля обязательны (не опциональны, в отличие от ActorDispatchBudget):
  // именно они закрывают конкретную, названную в §3.10 дыру бесконечного каскада внутри frontier.
  const missing: ActorCumulativeFrontierBudget = { maxCascadeDepth: 8 };
  void missing;
});

test('ActorBudgets: per-dispatch + per-frontier типизируются и попадают в ActorInit.budgets', () => {
  const budgets: ActorBudgets = {
    perDispatch: { maxCpuUs: durationUs(5_000), maxWallUs: durationUs(10_000), maxCommandsPerBatch: 32 },
    perFrontier: { maxCascadeDepth: 8, maxEventsPerFrontier: 256 },
  };
  const init: ActorInit = {
    params: {},
    seed: 1,
    symbol: 'BTCUSDT',
    subscriptions: [],
    budgets,
  };
  assert.equal(init.budgets?.perDispatch.maxCommandsPerBatch, 32);
  assert.equal(init.budgets?.perFrontier.maxCascadeDepth, 8);

  // budgets опционален — хост может не конфигурировать лимиты вовсе.
  const withoutBudgets: ActorInit = { params: {}, seed: 1, symbol: 'BTCUSDT', subscriptions: [] };
  assert.equal(withoutBudgets.budgets, undefined);
});

// Требование 2 брифа задачи 6, дословно: «Per-session бюджета быть не должно» — типовой тест на
// ОТСУТСТВИЕ, не на присутствие. `ActorBudgets` — закрытая форма (никакой index-сигнатуры), и
// избыточное поле на СВЕЖЕМ литерале ловится excess-property-check компилятора.
test('ActorBudgets: per-session бюджета НЕТ в форме (excess-property-check на литерале)', () => {
  const budgets: ActorBudgets = {
    perDispatch: {},
    perFrontier: { maxCascadeDepth: 1, maxEventsPerFrontier: 1 },
  };
  assert.ok(budgets.perDispatch);

  // ActorBudgets не несёт (и не может, без правки формы) поля `perSession`: «сессия» актора
  // бесконечна по построению (см. doc ActorBudgets, event-driven.ts) — F6 (backtester sandbox
  // timeout diagnosis) был ровно исчерпанием session-бюджета изолята на долгоживущем акторе,
  // механизм для одноразового скрипта на нём деградирует в гарантированный отказ.
  //
  // Minor (ревью раунда 1 задачи 6): `maxWallMs` здесь — НЕ опечатка µs-контракта. Литерал
  // сознательно зеркалит имя РЕАЛЬНОГО отклонённого поля из F6 (`wallTimeMsPerSession`, мс) —
  // именно ТАКАЯ форма и есть то, чему в `ActorBudgets` нет места; писать её в µs
  // (`maxWallUs`) стёрло бы связь с историческим инцидентом, который эта форма отвергает.
  const withSession: ActorBudgets = {
    perDispatch: {},
    perFrontier: { maxCascadeDepth: 1, maxEventsPerFrontier: 1 },
    // @ts-expect-error — 'perSession' does not exist in type 'ActorBudgets'.
    perSession: { maxWallMs: 30_000 },
  };
  void withSession;
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Дом RNG — ActorContext.rng: ActorRng (именованная форма). Гарантия — НЕЧЕКПОЙНТАБЕЛЬНОСТЬ
//    спрятанного генератора (замыкание не переживает isPlainActorState), а НЕ его физическая
//    невозможность: см. doc `ActorRng` (event-driven.ts) и шапку этого файла.
// ─────────────────────────────────────────────────────────────────────────────

test('ActorRng — именованная форма, structurally совместима с {next: () => number}', () => {
  const rng: ActorRng = { next: () => 0.5 };
  const ctx: Pick<ActorContext, 'rng'> = { rng };
  assert.equal(ctx.rng.next(), 0.5);
});

test('дом RNG: замыкание-генератор, спрятанное в авторском состоянии, отклоняется isPlainActorState', () => {
  // Гипотетическая попытка «своего» RNG в state-слоте — функция (замыкание) в любом месте
  // структуры уже отклонена isPlainActorState (задача 5). Это и есть ровно та гарантия, которую
  // контракт даёт: спрятанный генератор НЕ СОГЛАСОВАН с чекпойнтом/восстановлением, потому что
  // не переживает границу состояния. Гарантии «такого генератора не бывает» контракт не даёт —
  // и это названо явно в doc `ActorRng`.
  let seed = 42;
  const fakeRng = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  assert.equal(isPlainActorState({ myOwnRng: fakeRng }), false);
  assert.equal(isPlainActorState({ myOwnRng: { next: fakeRng } }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Две копии CONTRACT_VERSION/SUPPORTED_CONTRACT_VERSIONS (contract/constants.ts — published
//    root barrel; research-contract/catalogs.ts — активная копия, реально ведущая валидацию через
//    platformContractContext) синхронизированы. Тот же класс дисциплины, что уже применён к
//    SUPPORTED_MARKET_DATA_KINDS/MARKET_DATA_KINDS (обе копии существуют по отдельной причине, но
//    версия — не тот случай: расхождение здесь означало бы, что @trdlabs/sdk и
//    @trdlabs/sdk/research-contract расходятся в ответе на «какая версия действует».
// ─────────────────────────────────────────────────────────────────────────────

test('CONTRACT_VERSION синхронна между contract/constants.ts и research-contract barrel', () => {
  assert.equal(CONTRACT_VERSION_ROOT, CONTRACT_VERSION);
  assert.equal(CONTRACT_VERSION, '017.4');
});

test('SUPPORTED_CONTRACT_VERSIONS синхронен между contract/constants.ts и research-contract barrel', () => {
  assert.deepEqual([...SUPPORTED_CONTRACT_VERSIONS_ROOT], [...SUPPORTED_CONTRACT_VERSIONS]);
  assert.deepEqual([...SUPPORTED_CONTRACT_VERSIONS], ['017.1', '017.2', '017.3', '017.4']);
});

test('MARKET_DATA_KINDS достижим и идентичен из обеих копий', () => {
  assert.deepEqual([...MARKET_DATA_KINDS_ROOT], [...MARKET_DATA_KINDS]);
});

// Minor (ревью раунда 1 задачи 6): было `assert.equal(EVENT_DRIVEN_MIN_CONTRACT_VERSION,
// CONTRACT_VERSION)` — кодировало «surface актора ВСЕГДА вводится ТЕКУЩЕЙ версией», случайный
// инвариант этой задачи, а не требование контракта. Следующий несвязанный бамп CONTRACT_VERSION
// (не трогающий surface event_driven) сделал бы этот тест красным на ровном месте. Опечатку в
// самом пороге (например, `'017.5'` вместо `'017.4'`) ловит членство в SUPPORTED_CONTRACT_VERSIONS
// — та же гарантия, но без ложной связи с CONTRACT_VERSION.
test('EVENT_DRIVEN_MIN_CONTRACT_VERSION — валидный член SUPPORTED_CONTRACT_VERSIONS (не опечатка в пороге)', () => {
  assert.ok(
    (SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(EVENT_DRIVEN_MIN_CONTRACT_VERSION),
    `EVENT_DRIVEN_MIN_CONTRACT_VERSION="${EVENT_DRIVEN_MIN_CONTRACT_VERSION}" отсутствует в SUPPORTED_CONTRACT_VERSIONS`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Б-3 (финальная волна ревью ветки) — TradingState наблюдаем актором, как требует §3.10.
// ─────────────────────────────────────────────────────────────────────────────

test('Б-3: TRADING_STATES — замкнутый каталог с двусторонней гарантией', () => {
  assert.deepEqual([...TRADING_STATES], ['normal', 'reducing', 'halted']);
  assert.equal(new Set(TRADING_STATES).size, TRADING_STATES.length, 'без дублей');

  // Массив не шире типа — `satisfies` в src; тип не шире массива — `_AssertNoUncoveredTradingState`
  // там же. Здесь — независимая рантайм-половина: каждый элемент присваивается переменной типа.
  for (const state of TRADING_STATES) {
    const typed: TradingState = state;
    assert.equal(typeof typed, 'string');
  }

  // @ts-expect-error — каталог замкнут: `paused` не является TradingState.
  const unknownState: TradingState = 'paused';
  void unknownState;
});

test('Б-3: переход режима приезжает СОБЫТИЕМ в замкнутом union и назван в каталоге видов', () => {
  const occurrences = ACTOR_INPUT_EVENT_KINDS.filter((k) => k === 'trading_state.changed');
  assert.deepEqual(occurrences, ['trading_state.changed']);

  const event: ActorInputEvent = {
    kind: 'trading_state.changed',
    ts: timestampUs(1_700_000_000_000_000),
    previous: 'normal',
    state: 'reducing',
  };
  assert.equal(event.kind, 'trading_state.changed');

  // Событие несёт ОБА конца перехода: `previous` из ctx невыводим, и без него «вернулись в normal
  // из halted» неотличимо от «вернулись в normal из reducing».
  // @ts-expect-error — previous обязателен.
  const withoutPrevious: ActorInputEvent = {
    kind: 'trading_state.changed',
    ts: timestampUs(1),
    state: 'reducing',
  };
  void withoutPrevious;

  // И то же самое на отгружаемой схеме — там типов вызывающего нет вовсе.
  assert.deepEqual(
    registry.validateCore('actor-input-event', {
      kind: 'trading_state.changed',
      ts: 1_700_000_000_000_000,
      previous: 'normal',
      state: 'halted',
    }),
    [],
  );
  assert.ok(
    registry.validateCore('actor-input-event', {
      kind: 'trading_state.changed',
      ts: 1_700_000_000_000_000,
      previous: 'normal',
      state: 'paused',
    }).length > 0,
    'схема обязана отвергнуть режим вне каталога',
  );
});

test('Б-3: текущий режим читается из ctx — политика не обязана парсить текст order.denied.reason', () => {
  const ctx: ActorContext = {
    clock: { nowUs: () => timestampUs(1_700_000_000_000_000) },
    rng: { next: () => 0.5 },
    readiness: 'ready',
    tradingState: 'reducing',
    orders: { open: () => [] },
    position: () => undefined,
  };
  // Ровно то высказывание, которое до Б-3 было невыразимо: «не наращивай экспозицию, хост в
  // reducing» — предикат над ЗНАЧЕНИЕМ каталога, а не над свободной строкой причины отказа.
  const mayGrowExposure = ctx.tradingState === 'normal';
  assert.equal(mayGrowExposure, false);

  // @ts-expect-error — tradingState обязателен: контекст без режима не типизируется.
  const withoutState: ActorContext = {
    clock: { nowUs: () => timestampUs(1) },
    rng: { next: () => 0.5 },
    readiness: 'ready',
    orders: { open: () => [] },
    position: () => undefined,
  };
  void withoutState;
});

// ─────────────────────────────────────────────────────────────────────────────
// Б-4 (финальная волна ревью ветки) — схема требует ровно того, что обещает дока.
// ─────────────────────────────────────────────────────────────────────────────

test('Б-4: схема отвергает дробные и отрицательные µs-метки — не только тип', () => {
  // Прогон ревью по схемам из dist ДО правки: все пять входов ниже были ВАЛИДНЫ. `TimestampUs` в
  // схеме был `{"type":"number"}` с докой «целое, неотрицательное, safe-integer», которую
  // constraint не исполнял; рантайм-конструкторы `timestampUs`/`durationUs` на границе изолята не
  // участвуют вовсе — там только схема (правило №7).
  for (const [label, command] of [
    ['atTs дробный', { kind: 'timer.set', timerId: 't', atTs: 1.5 }],
    ['atTs отрицательный', { kind: 'timer.set', timerId: 't', atTs: -1000 }],
    ['afterUs дробный', { kind: 'timer.set', timerId: 't', afterUs: 1.5 }],
    ['qtyUsd = 0', { kind: 'place', type: 'market', clientOrderId: 'o', side: 'buy', qtyUsd: 0 }],
    ['qtyUsd отрицательный', { kind: 'place', type: 'market', clientOrderId: 'o', side: 'buy', qtyUsd: -5 }],
  ] as const) {
    assert.ok(registry.validateCore('actor-command', command).length > 0, `команда должна отклоняться: ${label}`);
    assert.ok(registry.validateCore('actor-command-batch', [command]).length > 0, `батч: ${label}`);
  }

  // Отрицательный `afterUs` законен: `DurationUs` — разность моментов, знак допустим по доке.
  assert.deepEqual(registry.validateCore('actor-command', { kind: 'timer.set', timerId: 't', afterUs: -60_000 }), []);
});

test('Б-4: схема отвергает дробный ts, неположительный qty и невалидный revision в событиях', () => {
  const baseFill = { kind: 'fill', ts: 1_700_000_000_000_000, clientOrderId: 'o', price: 100, fee: 0, last: true };
  assert.deepEqual(registry.validateCore('actor-input-event', { ...baseFill, qty: 1.5 }), [], 'дробный qty легален');

  for (const [label, event] of [
    ['ts дробный', { ...baseFill, ts: 1.5, qty: 1 }],
    ['ts отрицательный', { ...baseFill, ts: -1, qty: 1 }],
    ['qty = 0', { ...baseFill, qty: 0 }],
    ['qty отрицательный', { ...baseFill, qty: -5 }],
    [
      'revision дробный',
      {
        kind: 'market.candle.closed',
        candle: {
          effectiveTsUs: 1_700_000_000_000_000,
          value: { open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
          finality: 'final',
          revision: -1.5,
        },
      },
    ],
    [
      'отрицательный объём свечи',
      {
        kind: 'market.candle.closed',
        candle: {
          effectiveTsUs: 1_700_000_000_000_000,
          value: { open: 1, high: 2, low: 0.5, close: 1.5, volume: -10 },
          finality: 'final',
          revision: 0,
        },
      },
    ],
  ] as const) {
    assert.ok(registry.validateCore('actor-input-event', event).length > 0, `событие должно отклоняться: ${label}`);
  }
});
