// 083 S1 задача 3 — `MarketDataRequirement`: закрытый каталог рыночных данных на пять видов.
//
// Что здесь пинуется (раунд правок 1):
//   1) двусторонняя типовая гарантия «MARKET_DATA_KINDS ⇔ MarketDataRequirement['kind']»
//      (exhaustiveness) — типовая проверка, а не рантаймовая (нужен `npx tsc --noEmit`, `tsx`
//      типы стирает, как и в `actor-market-events.test.ts`);
//   2)-(6) пять v1-отклонений валидатора — каждое СВОИМ кодом, ни одно не «молча игнорируется»:
//      отсутствующий `lookback` (schema_invalid), `funding.form:'settlement'`
//      (unsupported_funding_form), `scope:'venue'` (unsupported_market_data_scope),
//      `revisionPolicy.mode:'provisional_and_revisions'` (unsupported_revision_policy),
//      неизвестный `kind` (schema_invalid по замкнутому union'у схемы);
//   7) обратная совместимость: `single_position` без `marketData` остаётся валидным, а
//      `event_driven` без `marketData` — нет (обязательность поля, требование 7).
// Item 8 (существующий `test/event-driven.test.ts` остаётся зелёным) проверяется отдельным
// прогоном этого же файла — здесь не дублируется.
//
// Раунд правок 2 (ревью нашло К-1/К-3/К-4/К-5/С-1/С-2/С-3/м-1/м-2/м-3/м-4/м-5/м-7/м-8) добавил:
//   К-1 marketData тоже ограждена версией контракта (017.1/017.2 + marketData → rejected);
//   К-4 три закрытые оси (scope/revisionPolicy.mode/funding.form) — белый список, проверено
//       произвольным неизвестным значением, не только буквальным 'venue'/…/'settlement';
//   К-5 дубль `id` внутри `marketData` одного манифеста отвергается;
//   м-1 числовые/строковые границы (lookback/interval/id/instrument) — не только присутствие;
//   м-7 overlay с marketData отвергается (поле принадлежит форме event_driven);
//   м-8 revisionPolicy опционален — отсутствие равносильно final_only;
//   С-2 warmup — объявлен в ModuleManifest, принимается и доезжает до normalized;
//   С-3/К-2 MARKET_DATA_KINDS/MarketDataKind достижимы из барреля research-contract, не только
//       из contract/constants напрямую; MarketDataScope — новое имя Scope (м-5).
// Run: npx tsx --test test/market-data-requirement.test.ts
// Type-check (обязателен для пункта 1): npx tsc --noEmit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MARKET_DATA_KINDS, type MarketDataKind } from '../src/contract/constants.js';
import {
  MARKET_DATA_KINDS as MARKET_DATA_KINDS_VIA_BARREL,
  durationUs,
  platformContractContext,
  timestampUs,
  type ActorReadiness,
  type ActorWarmupSource,
  type DeclaredDatasetSplice,
  type MarketDataRequirement,
  type MarketDataScope,
  type ModuleManifest,
} from '../src/research-contract/index.js';
import { ALL_VALIDATION_CODES, validate } from '../src/validation/index.js';

const CTX = platformContractContext();

const INSTRUMENT = { venue: 'binance', symbol: 'BTCUSDT' } as const;

const CANDLES_REQ: MarketDataRequirement = {
  kind: 'candles',
  id: 'req-candles',
  instrument: INSTRUMENT,
  interval: durationUs(60_000_000), // 1 минута в µs
  lookback: 200,
  revisionPolicy: { mode: 'final_only' },
  priceType: 'trade',
};

// 083 S1 задача 6: surface event_driven (lifecycle/onEvent/marketData) требует ≥017.4 — весь
// файл тестирует `marketData`, который сам этот surface и есть, поэтому BASE обязан нести версию
// ≥017.4, не 017.3 (тот больше не покрывает surface, который когда-то вводил — см. doc
// `EVENT_DRIVEN_MIN_CONTRACT_VERSION`, event-driven.ts).
const BASE: ModuleManifest = {
  id: 'm',
  version: '0.1.0',
  kind: 'strategy',
  name: 'M',
  summary: 's',
  rationale: 'r',
  author: 'agent',
  contractVersion: '017.4',
  status: 'research_only',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  capabilities: { platformSdk: true },
  dataNeeds: {},
  lifecycle: 'event_driven',
  hooks: ['init', 'onEvent', 'dispose'],
  marketData: [CANDLES_REQ],
};

const check = (manifest: ModuleManifest) => validate({ inputKind: 'module', manifest }, CTX);
const codesOf = (manifest: ModuleManifest) => check(manifest).issues.map((i) => i.code);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Exhaustiveness: switch без default над MarketDataKind покрывает все пять видов.
// ─────────────────────────────────────────────────────────────────────────────

/** Недостижимо, пока `MarketDataKind` и вызывающий код согласованы (см. `labelOf`). */
function assertNever(x: never): never {
  throw new Error(`assertNever: недостижимо, получено ${JSON.stringify(x)}`);
}

/**
 * Исчерпывающий диспетчер БЕЗ `default`: если бы в `MARKET_DATA_KINDS` завёлся шестой вид без
 * своей ветки здесь, `kind` в конце функции не сузился бы до `never`, и `assertNever(kind)`
 * оказался бы красным — сборка ломается ДО рантайма (тот же приём, что `labelOf` в
 * `actor-market-events.test.ts`).
 */
function labelOf(kind: MarketDataKind): string {
  switch (kind) {
    case 'candles':
      return kind;
    case 'open_interest':
      return kind;
    case 'liquidations':
      return kind;
    case 'taker_volume':
      return kind;
    case 'funding':
      return kind;
  }
  return assertNever(kind);
}

test('замкнутость: switch без default над MarketDataKind покрывает все пять видов', () => {
  for (const kind of MARKET_DATA_KINDS) {
    assert.equal(labelOf(kind), kind);
  }
  assert.equal(MARKET_DATA_KINDS.length, 5);
  assert.equal(new Set(MARKET_DATA_KINDS).size, 5, 'без дублей в каталоге');
  assert.deepEqual(
    [...MARKET_DATA_KINDS].sort(),
    ['candles', 'funding', 'liquidations', 'open_interest', 'taker_volume'],
  );
});

test('манифест с корректным marketData принимается', () => {
  const res = check(BASE);
  assert.equal(res.status, 'accepted');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Манифест без lookback отвергается.
// ─────────────────────────────────────────────────────────────────────────────

test('требование без lookback отвергается', () => {
  const malformed: Record<string, unknown> = { ...CANDLES_REQ };
  delete malformed.lookback;
  const manifest = { ...BASE, marketData: [malformed] } as unknown as ModuleManifest;

  const res = check(manifest);
  assert.equal(res.status, 'rejected');
  assert.ok(
    res.issues.some((i) => i.code === 'schema_invalid' && i.path === '/marketData/0/lookback'),
    JSON.stringify(res.issues),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. funding с form:'settlement' отвергается в v1 с внятным кодом (датасета нет).
// ─────────────────────────────────────────────────────────────────────────────

test('funding с form settlement отвергается: датасета (колонки settlement) в архиве нет', () => {
  const funding: MarketDataRequirement = {
    kind: 'funding',
    id: 'req-funding',
    instrument: INSTRUMENT,
    interval: durationUs(60_000_000),
    lookback: 100,
    revisionPolicy: { mode: 'final_only' },
    scope: 'aggregate',
    form: 'settlement',
  };
  assert.deepEqual(codesOf({ ...BASE, marketData: [funding] }), ['unsupported_funding_form']);
});

test('funding с form rate — тот же scope, но резолвится (принимается)', () => {
  const funding: MarketDataRequirement = {
    kind: 'funding',
    id: 'req-funding',
    instrument: INSTRUMENT,
    interval: durationUs(60_000_000),
    lookback: 100,
    revisionPolicy: { mode: 'final_only' },
    scope: 'aggregate',
    form: 'rate',
  };
  assert.equal(check({ ...BASE, marketData: [funding] }).status, 'accepted');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. scope: 'venue' отвергается явным кодом — именно отвергается, а не игнорируется.
// ─────────────────────────────────────────────────────────────────────────────

test('scope venue отвергается явным кодом (архив не хранит по-источниковые значения)', () => {
  const oi: MarketDataRequirement = {
    kind: 'open_interest',
    id: 'req-oi',
    instrument: INSTRUMENT,
    interval: durationUs(60_000_000),
    lookback: 50,
    revisionPolicy: { mode: 'final_only' },
    scope: 'venue',
    unit: 'usd',
  };
  const res = check({ ...BASE, marketData: [oi] });
  assert.equal(res.status, 'rejected');
  assert.deepEqual(res.issues.map((i) => i.code), ['unsupported_market_data_scope']);
  assert.equal(res.issues[0]?.path, '/marketData/0/scope');
});

test('scope aggregate — тот же вид, но резолвится (принимается)', () => {
  const oi: MarketDataRequirement = {
    kind: 'open_interest',
    id: 'req-oi',
    instrument: INSTRUMENT,
    interval: durationUs(60_000_000),
    lookback: 50,
    revisionPolicy: { mode: 'final_only' },
    scope: 'aggregate',
    unit: 'usd',
  };
  assert.equal(check({ ...BASE, marketData: [oi] }).status, 'accepted');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. revisionPolicy.mode: 'provisional_and_revisions' отвергается в v1.
// ─────────────────────────────────────────────────────────────────────────────

test('revisionPolicy provisional_and_revisions отвергается в v1 (не реализован)', () => {
  const req: MarketDataRequirement = { ...CANDLES_REQ, revisionPolicy: { mode: 'provisional_and_revisions' } };
  assert.deepEqual(codesOf({ ...BASE, marketData: [req] }), ['unsupported_revision_policy']);
});

test('revisionPolicy final_only — принимается (единственная резолвящаяся политика v1)', () => {
  assert.equal(check(BASE).status, 'accepted');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Неизвестный kind отвергается.
// ─────────────────────────────────────────────────────────────────────────────

test('неизвестный kind отвергается (закрытый union схемы не пропускает лишнюю ветку)', () => {
  const bogus = { ...CANDLES_REQ, kind: 'quote' } as unknown as MarketDataRequirement;
  const res = check({ ...BASE, marketData: [bogus] });
  assert.equal(res.status, 'rejected');
  assert.ok(res.issues.every((i) => i.code === 'schema_invalid'), JSON.stringify(res.issues));
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. single_position без marketData остаётся валидным; event_driven без marketData — нет.
// ─────────────────────────────────────────────────────────────────────────────

test('манифест single_position без marketData остаётся валидным — существующие бандлы не затронуты', () => {
  const legacy: ModuleManifest = {
    id: 'm2',
    version: '0.1.0',
    kind: 'strategy',
    name: 'M2',
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
  const res = check(legacy);
  assert.equal(res.status, 'accepted');
  assert.ok(!('marketData' in (res.normalized as object)), 'marketData не должно появляться из ниоткуда');
});

test('event_driven без marketData отвергается — поле обязательно именно для этой формы', () => {
  const noMarketData: ModuleManifest = { ...BASE, marketData: undefined };
  const res = check(noMarketData);
  assert.equal(res.status, 'rejected');
  assert.ok(res.issues.some((i) => i.code === 'missing_market_data_requirement'));
});

test('event_driven с пустым marketData тоже отвергается — пустой массив не считается объявленным', () => {
  const res = check({ ...BASE, marketData: [] });
  assert.equal(res.status, 'rejected');
  assert.ok(res.issues.some((i) => i.code === 'missing_market_data_requirement'));
});

test('marketData принятого event_driven-манифеста доезжает до normalized (не пропадает молча)', () => {
  const res = check(BASE);
  assert.equal(res.status, 'accepted');
  assert.deepEqual((res.normalized as { marketData?: unknown }).marketData, [CANDLES_REQ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Требование 5 — форма и код отказа для declared-склеивания через границу datasetId
// (сама проверка окна — вне sdk, здесь только то, что задача обещает: тип + код).
// ─────────────────────────────────────────────────────────────────────────────

test('DeclaredDatasetSplice и dataset_boundary_violation — форма и код зарегистрированы', () => {
  assert.ok(ALL_VALIDATION_CODES.includes('dataset_boundary_violation'));
  const splice: DeclaredDatasetSplice = {
    fromDatasetId: 'binance-8ex-aggregate',
    toDatasetId: 'coinglass-aggregate',
    boundaryTsUs: timestampUs(1_700_000_000_000_000),
    rationale: 'миграция провайдера агрегата OI',
  };
  assert.equal(splice.fromDatasetId, 'binance-8ex-aggregate');
});

// ─────────────────────────────────────────────────────────────────────────────
// Требование 6 — форма выбора источника прогрева + readiness (реализация — S2, не здесь).
// ─────────────────────────────────────────────────────────────────────────────

test('ActorReadiness/ActorWarmupSource — форма выбора прогрева зафиксирована', () => {
  const readiness: ActorReadiness = 'warming_up';
  const replay: ActorWarmupSource = { kind: 'tape_replay' };
  const prefetch: ActorWarmupSource = { kind: 'kernel_prefetch' };
  assert.equal(readiness, 'warming_up');
  assert.deepEqual([replay.kind, prefetch.kind], ['tape_replay', 'kernel_prefetch']);
});

test('С-2: warmup объявлен В КОНТРАКТЕ (ModuleManifest), принимается и доезжает до normalized', () => {
  const warmup: ActorWarmupSource = { kind: 'tape_replay' };
  const res = check({ ...BASE, warmup });
  assert.equal(res.status, 'accepted', JSON.stringify(res.issues));
  assert.deepEqual((res.normalized as { warmup?: unknown }).warmup, warmup);
});

// ─────────────────────────────────────────────────────────────────────────────
// Раунд правок 2 — К-1: marketData тоже часть surface 083 E1/S1, ограждена версией контракта.
// Репро ревью: манифест 017.1 с hooks:['onBarClose'] и блоком marketData раньше принимался с
// нулём issues — версия конверта переставала говорить, какой surface объявлен.
// ─────────────────────────────────────────────────────────────────────────────

// 083 S1 задача 6: `017.3` (когда-то вводивший surface) больше его НЕ покрывает — весь surface
// переписан задачами 1–5 и теперь требует ≥017.4 (см. doc `EVENT_DRIVEN_MIN_CONTRACT_VERSION`).
test('К-1/задача 6: marketData под контрактом 017.1/017.2/017.3 отвергается — surface требует ≥017.4', () => {
  for (const contractVersion of ['017.1', '017.2', '017.3'] as const) {
    const manifest: ModuleManifest = {
      id: 'm3',
      version: '0.1.0',
      kind: 'strategy',
      name: 'M3',
      summary: 's',
      rationale: 'r',
      author: 'agent',
      contractVersion,
      status: 'research_only',
      paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
      capabilities: { platformSdk: true },
      dataNeeds: {},
      hooks: ['onBarClose'],
      marketData: [CANDLES_REQ],
    };
    const res = check(manifest);
    assert.equal(res.status, 'rejected', contractVersion);
    assert.ok(
      res.issues.some((i) => i.code === 'unsupported_contract_version' && i.path === '/contractVersion'),
      `${contractVersion}: ${JSON.stringify(res.issues)}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Раунд правок 2 — К-4: белый список вместо чёрного. Произвольное третье значение отвергается,
// не только буквально 'venue' / 'provisional_and_revisions' / 'settlement'.
// ─────────────────────────────────────────────────────────────────────────────

test('К-4: scope с произвольным неизвестным значением отвергается (белый список)', () => {
  const oi = {
    ...CANDLES_REQ,
    kind: 'open_interest',
    scope: 'city',
    unit: 'usd',
  } as unknown as MarketDataRequirement;
  const res = check({ ...BASE, marketData: [oi] });
  assert.equal(res.status, 'rejected');
  assert.ok(res.issues.some((i) => i.code === 'unsupported_market_data_scope'), JSON.stringify(res.issues));
});

test('К-4: revisionPolicy.mode с произвольным неизвестным значением отвергается (белый список)', () => {
  const req = {
    ...CANDLES_REQ,
    revisionPolicy: { mode: 'eventually_consistent' },
  } as unknown as MarketDataRequirement;
  const res = check({ ...BASE, marketData: [req] });
  assert.equal(res.status, 'rejected');
  assert.ok(res.issues.some((i) => i.code === 'unsupported_revision_policy'), JSON.stringify(res.issues));
});

test('К-4: funding.form с произвольным неизвестным значением отвергается (белый список)', () => {
  const funding = {
    kind: 'funding',
    id: 'req-funding',
    instrument: INSTRUMENT,
    interval: durationUs(60_000_000),
    lookback: 100,
    scope: 'aggregate',
    form: 'predicted',
  } as unknown as MarketDataRequirement;
  const res = check({ ...BASE, marketData: [funding] });
  assert.equal(res.status, 'rejected');
  assert.ok(res.issues.some((i) => i.code === 'unsupported_funding_form'), JSON.stringify(res.issues));
});

// ─────────────────────────────────────────────────────────────────────────────
// Раунд правок 2 — К-5: дубль id внутри marketData одного манифеста отвергается — id единственная
// ручка связи требования с binding'ом ниже по цепочке (задача 8).
// ─────────────────────────────────────────────────────────────────────────────

test('К-5: дубль id внутри marketData отвергается', () => {
  const dup: MarketDataRequirement = {
    kind: 'liquidations',
    id: 'req-candles', // тот же id, что у CANDLES_REQ
    instrument: INSTRUMENT,
    interval: durationUs(60_000_000),
    lookback: 30,
    scope: 'aggregate',
  };
  const res = check({ ...BASE, marketData: [CANDLES_REQ, dup] });
  assert.equal(res.status, 'rejected');
  assert.ok(
    res.issues.some((i) => i.code === 'duplicate_market_data_requirement_id' && i.path === '/marketData/1/id'),
    JSON.stringify(res.issues),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Раунд правок 2 — м-1: числовые/строковые границы. Ранее принимались отрицательный/дробный
// lookback, нулевой/отрицательный interval, пустые id/venue/symbol.
// ─────────────────────────────────────────────────────────────────────────────

test('м-1: lookback отрицательный или дробный отвергается', () => {
  for (const lookback of [-5, 1.5]) {
    const res = check({ ...BASE, marketData: [{ ...CANDLES_REQ, lookback }] });
    assert.equal(res.status, 'rejected', String(lookback));
    assert.ok(
      res.issues.some((i) => i.code === 'invalid_market_data_requirement' && i.path === '/marketData/0/lookback'),
      `${lookback}: ${JSON.stringify(res.issues)}`,
    );
  }
});

test('м-1: interval нулевой или отрицательный отвергается', () => {
  for (const interval of [0, -60_000_000]) {
    const req = { ...CANDLES_REQ, interval } as unknown as MarketDataRequirement;
    const res = check({ ...BASE, marketData: [req] });
    assert.equal(res.status, 'rejected', String(interval));
    assert.ok(
      res.issues.some((i) => i.code === 'invalid_market_data_requirement' && i.path === '/marketData/0/interval'),
      `${interval}: ${JSON.stringify(res.issues)}`,
    );
  }
});

test('м-1: пустой id требования отвергается', () => {
  const res = check({ ...BASE, marketData: [{ ...CANDLES_REQ, id: '' }] });
  assert.equal(res.status, 'rejected');
  assert.ok(
    res.issues.some((i) => i.code === 'invalid_market_data_requirement' && i.path === '/marketData/0/id'),
    JSON.stringify(res.issues),
  );
});

test('м-1: пустые venue/symbol инструмента отвергаются', () => {
  const resVenue = check({
    ...BASE,
    marketData: [{ ...CANDLES_REQ, instrument: { venue: '', symbol: 'BTCUSDT' } }],
  });
  const resSymbol = check({
    ...BASE,
    marketData: [{ ...CANDLES_REQ, instrument: { venue: 'binance', symbol: '' } }],
  });
  assert.ok(
    resVenue.issues.some((i) => i.code === 'invalid_market_data_requirement' && i.path === '/marketData/0/instrument/venue'),
    JSON.stringify(resVenue.issues),
  );
  assert.ok(
    resSymbol.issues.some((i) => i.code === 'invalid_market_data_requirement' && i.path === '/marketData/0/instrument/symbol'),
    JSON.stringify(resSymbol.issues),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Раунд правок 2 — м-7: overlay с marketData отвергается — поле принадлежит форме event_driven,
// overlay перехватывает решение фазовой модели single_position.
// ─────────────────────────────────────────────────────────────────────────────

test('м-7: overlay с marketData отвергается', () => {
  const overlay: ModuleManifest = {
    id: 'ov1',
    version: '0.1.0',
    kind: 'overlay',
    name: 'OV',
    summary: 's',
    rationale: 'r',
    author: 'agent',
    contractVersion: '017.4',
    status: 'research_only',
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    capabilities: { platformSdk: true },
    dataNeeds: {},
    hooks: ['apply'],
    targetStrategyRef: 'm',
    interceptionPoint: 'post_decision',
    marketData: [CANDLES_REQ],
  };
  const res = validate({ inputKind: 'module', manifest: overlay }, platformContractContext(['m']));
  assert.equal(res.status, 'rejected');
  assert.ok(
    res.issues.some((i) => i.code === 'lifecycle_form_invalid' && i.path === '/marketData'),
    JSON.stringify(res.issues),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Раунд правок 2 — м-8: revisionPolicy опционален, отсутствие равносильно final_only.
// ─────────────────────────────────────────────────────────────────────────────

test('м-8: revisionPolicy опущен целиком — по умолчанию final_only, принимается', () => {
  const { revisionPolicy: _unused, ...withoutPolicy } = CANDLES_REQ;
  void _unused;
  const res = check({ ...BASE, marketData: [withoutPolicy as MarketDataRequirement] });
  assert.equal(res.status, 'accepted', JSON.stringify(res.issues));
});

// ─────────────────────────────────────────────────────────────────────────────
// Раунд правок 2 — С-3/К-2: новый каталог достижим из ДВУХ путей (contract/constants напрямую и
// research-contract barrel), легаси-каталог переименован, MarketDataScope — новое имя Scope (м-5).
// ─────────────────────────────────────────────────────────────────────────────

test('С-3/К-2: MARKET_DATA_KINDS достижим из research-contract barrel, не только из contract/constants', () => {
  assert.deepEqual([...MARKET_DATA_KINDS_VIA_BARREL], [...MARKET_DATA_KINDS]);
});

test('м-5: MarketDataScope — тип доступен под новым именем (переименован из Scope)', () => {
  const s: MarketDataScope = 'aggregate';
  assert.equal(s, 'aggregate');
});
