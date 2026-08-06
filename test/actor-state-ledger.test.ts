// 083 S1 — задача 5: авторский state-слот, `PositionView` (derived `openedAt`, без `unrealizedPnl`),
// execution ledger.
//
// РЕВЬЮ РАУНДА 1 (2026-08-06, C-1/C-2/I-1/I-4/I-5/I-6) добавило ниже: дробные лестницы количества
// (C-1 — точное сравнение float с нулём давало фиктивный флип на закрытии дробной позиции);
// негативный контроль бранд-типа `PositionView` (C-2 — объектный литерал больше НЕ типизируется
// как `PositionView`, только `derivePositionView`); символьный/неперечислимый ключ, sparse-массив,
// добавленное свойство массива (I-4 — `Object.values` их всех молча пропускал); недоверенные
// записи ledger'а — строка вместо числа, неизвестная сторона, `NaN`/отрицательное (I-5 —
// `derivePositionView` теперь бросает, а не молча портит `PositionView`); порядок записей (I-6).
//
// Что здесь пинуется (нумерация — Тесты брифа задачи 5 + правки ревью):
//   1) `isPlainActorState` отвергает: функцию-значение, замыкание, циклическую ссылку,
//      несериализуемое значение (NaN/Infinity, Date/Map, symbol/bigint), И (I-4) функцию под
//      символьным ключом, неперечислимую функцию-свойство, sparse-массив, добавленное свойство
//      массива;
//   2) `isPlainActorState` принимает вложенную plain-data структуру любой глубины — включая
//      ДИАМАНТ (одна и та же ссылка из двух полей, не цикл);
//   3) `PositionView` не несёт `unrealizedPnl` — типовой тест (`@ts-expect-error`); И (C-2)
//      `PositionView` НЕВОЗМОЖНО собрать объектным литералом — только `derivePositionView`;
//   4) `openedAt` выводится из execution ledger'а: добавление в ту же сторону не двигает
//      `openedAt`; флип позиции через ноль даёт `openedAt` от НОВОГО открытия; (C-1) флип НЕ
//      возникает фиктивно при точном закрытии ДРОБНОЙ позиции;
//   5) частичный выход отражается в ledger'е и уменьшает остаток;
//   6) существующие тесты остаются зелёными — проверяется отдельным прогоном `npm run check`.
//   7) (I-5) `derivePositionView`/`isExecutionLedgerEntry` отвергают недоверенные записи —
//      сторона вне `'buy'|'sell'`, нечисловые `price`/`qty`, `qty<=0`, `NaN`;
//   8) (I-6) `derivePositionView` требует неубывающий `ts` — тот же ledger в обратном порядке
//      либо бросает, либо не совпадает с прямым порядком (здесь — бросает).
// Run: npx tsx --test test/actor-state-ledger.test.ts
// Type-check (обязателен для пунктов 3, C-2): npx tsc -p tsconfig.test.json
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  derivePositionView,
  isExecutionLedger,
  isExecutionLedgerEntry,
  isPlainActorState,
  timestampUs,
  type ExecutionLedger,
  type ExecutionLedgerFillEntry,
  type PositionView,
} from '../src/research-contract/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Пункты 1–2 — isPlainActorState.
// ─────────────────────────────────────────────────────────────────────────────

test('isPlainActorState отвергает функцию-значение', () => {
  assert.equal(isPlainActorState({ onTick: () => 1 }), false);
  assert.equal(isPlainActorState(() => 1), false);
});

test('isPlainActorState отвергает замыкание (функцию, захватившую внешнюю переменную)', () => {
  function makeCounter() {
    let n = 0;
    return () => (n += 1);
  }
  const withClosure = { tick: makeCounter() };
  assert.equal(isPlainActorState(withClosure), false);
});

test('isPlainActorState отвергает циклическую ссылку', () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(isPlainActorState(cyclic), false);

  // Цикл на глубине (не в корне) — обязан ловиться так же.
  const nested: Record<string, unknown> = { level: 1, child: { level: 2 } };
  (nested.child as Record<string, unknown>).parent = nested;
  assert.equal(isPlainActorState(nested), false);
});

test('isPlainActorState отвергает несериализуемые значения', () => {
  assert.equal(isPlainActorState({ n: NaN }), false, 'NaN');
  assert.equal(isPlainActorState({ n: Infinity }), false, 'Infinity');
  assert.equal(isPlainActorState({ when: new Date() }), false, 'Date — экзотический объект');
  assert.equal(isPlainActorState({ items: new Map() }), false, 'Map — экзотический объект');
  assert.equal(isPlainActorState({ items: new Set() }), false, 'Set — экзотический объект');
  assert.equal(isPlainActorState(Symbol('x')), false, 'symbol');
  assert.equal(isPlainActorState(10n), false, 'bigint');
  assert.equal(isPlainActorState({ a: 1, b: undefined }), false, 'undefined-значение поля');
});

// I-4 ревью раунда 1: `Object.values`/`Object.keys` перечисляют ТОЛЬКО собственные ПЕРЕЧИСЛИМЫЕ
// СТРОКОВЫЕ ключи — четыре класса значений молча проходили мимо старой версии, все теряются при
// реальной `JSON.stringify`.
test('I-4: isPlainActorState отвергает функцию под символьным ключом', () => {
  const sym = Symbol('hidden');
  const withSymbolFn: Record<PropertyKey, unknown> = { a: 1, [sym]: () => 1 };
  assert.equal(isPlainActorState(withSymbolFn), false);
});

test('I-4: isPlainActorState отвергает неперечислимое свойство-функцию', () => {
  const obj: Record<string, unknown> = { a: 1 };
  Object.defineProperty(obj, 'hiddenFn', { value: () => 1, enumerable: false });
  assert.equal(isPlainActorState(obj), false);
});

test('I-4: isPlainActorState отвергает функцию в добавленном свойстве массива (не элементе)', () => {
  const arr: unknown[] = [1, 2, 3];
  (arr as unknown as Record<string, unknown>).extra = () => 1;
  assert.equal(isPlainActorState(arr), false);
});

test('I-4: isPlainActorState отвергает sparse-массив (дыра)', () => {
  // eslint-disable-next-line no-sparse-arrays
  const sparse = [1, , 3];
  assert.equal(isPlainActorState(sparse), false);
});

test('I-4: isPlainActorState по-прежнему отвергает функцию как ПЛОТНЫЙ элемент массива', () => {
  assert.equal(isPlainActorState([1, 2, () => 1]), false);
});

test('isPlainActorState принимает вложенную plain-data структуру любой глубины', () => {
  const nested = {
    counter: 3,
    label: 'x',
    flags: [true, false],
    history: [1, 2, { note: null, tags: ['a', 'b'] }],
    nested: { deeper: { deepest: 0 } },
  };
  assert.equal(isPlainActorState(nested), true);
  assert.equal(isPlainActorState(null), true);
  assert.equal(isPlainActorState([]), true);
  assert.equal(isPlainActorState({}), true);
});

test('isPlainActorState принимает разделяемую ссылку (диамант) — это НЕ цикл', () => {
  // Одно и то же вложенное значение достижимо из двух разных полей по РАЗНЫМ путям — легитимно
  // сериализуется JSON'ом (просто теряет разделяемую идентичность), в отличие от настоящего
  // цикла выше. Негативный контроль: backtracking-детектор циклов обязан отличать эти два случая.
  const shared = { x: 1 };
  const diamond = { left: shared, right: shared };
  assert.equal(isPlainActorState(diamond), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Пункт 3 — PositionView без unrealizedPnl; C-2 — бранд-тип, только derivePositionView.
// ─────────────────────────────────────────────────────────────────────────────

const T1 = timestampUs(1_700_000_000_000_000);
const T2 = timestampUs(1_700_000_060_000_000);
const T3 = timestampUs(1_700_000_120_000_000);

function fill(
  ts: ReturnType<typeof timestampUs>,
  side: 'buy' | 'sell',
  price: number,
  qty: number,
  opts: { readonly last?: boolean; readonly fee?: number; readonly clientOrderId?: string } = {},
): ExecutionLedgerFillEntry {
  return {
    kind: 'fill',
    ts,
    clientOrderId: opts.clientOrderId ?? 'o-1',
    side,
    price,
    qty,
    fee: opts.fee ?? 0,
    last: opts.last ?? false,
  };
}

test('PositionView не несёт unrealizedPnl', () => {
  const position = derivePositionView([fill(T1, 'buy', 100, 1)]);
  assert.ok(position);
  // @ts-expect-error — PositionView намеренно НЕ несёт unrealizedPnl (задача 5, требование 3):
  // производная от текущей рыночной цены создавала бы второй источник истины.
  const leaked = position.unrealizedPnl;
  void leaked;
  assert.equal(position.side, 'long');
});

// C-2 ревью раунда 1 (Critical): ДО этой правки объектный литерал типизировался как PositionView
// без единого `as` — прогон ревью собрал ctx.position() с qty, расходящимся с ledger'ом. Негативный
// контроль (M-2 урок задачи 4: гарантия недоказана, пока не проверено, что она ДЕЙСТВИТЕЛЬНО
// отклоняет то, что должна): та же строка теперь обязана падать под tsc.
test('C-2: PositionView НЕВОЗМОЖНО собрать объектным литералом — только derivePositionView', () => {
  // @ts-expect-error — PositionView бранд-типизирован; литерал без POSITION_VIEW_BRAND не подходит.
  // Если эта строка перестала падать, бранд сломан и ничего не гарантирует (та же дисциплина, что
  // `_MustFailOnOptionalFieldDrift`, observation-status.test.ts, M-2).
  const fake: PositionView = { side: 'long', qty: 1, avgEntryPrice: 1, openedAt: T1 };
  void fake;
});

// ─────────────────────────────────────────────────────────────────────────────
// Пункты 4–5 — execution ledger → derivePositionView.
// ─────────────────────────────────────────────────────────────────────────────

test('пустой ledger — позиция flat (undefined)', () => {
  assert.equal(derivePositionView([]), undefined);
});

test('openedAt = момент открытия; добавление в ту же сторону НЕ двигает openedAt', () => {
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 100, 10, { clientOrderId: 'o-1' }),
    fill(T2, 'buy', 110, 5, { clientOrderId: 'o-2' }),
  ];
  const position = derivePositionView(ledger);
  assert.ok(position);
  assert.equal(position.side, 'long');
  assert.equal(position.qty, 15);
  assert.equal(position.openedAt, T1, 'openedAt остаётся от ПЕРВОГО открытия, не от добавления');
  // Средневзвешенная цена по ОБЪЁМУ: (100*10 + 110*5) / 15.
  assert.ok(Math.abs(position.avgEntryPrice - (100 * 10 + 110 * 5) / 15) < 1e-9);
});

test('флип позиции через ноль: openedAt — от НОВОГО открытия (флип-филла), не от исходного', () => {
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 100, 10, { clientOrderId: 'o-1', last: true }),
    // Продажа 15 при остатке 10: закрывает long 10 и открывает short 5 — флип через ноль.
    fill(T2, 'sell', 90, 15, { clientOrderId: 'o-2', last: true }),
  ];
  const position = derivePositionView(ledger);
  assert.ok(position);
  assert.equal(position.side, 'short');
  assert.equal(position.qty, 5);
  assert.equal(position.openedAt, T2, 'openedAt — момент флипа, НЕ T1 (исходное открытие)');
  assert.equal(position.avgEntryPrice, 90, 'цена входа новой эры — цена флип-филла, не старая');
});

test('частичный выход отражается в ledger и уменьшает остаток, не трогая openedAt/avgEntryPrice', () => {
  const opened: ExecutionLedger = [fill(T1, 'buy', 100, 10, { clientOrderId: 'o-1' })];
  const afterOpen = derivePositionView(opened);
  assert.ok(afterOpen);
  assert.equal(afterOpen.qty, 10);

  // Частичный выход — ЕЩЁ ОДНА запись `fill` в уже открытом ledger'е, не мутация существующей.
  const afterPartialExit: ExecutionLedger = [
    ...opened,
    fill(T2, 'sell', 105, 3, { clientOrderId: 'o-2', last: false }),
  ];
  const partial = derivePositionView(afterPartialExit);
  assert.ok(partial);
  assert.equal(partial.side, 'long');
  assert.equal(partial.qty, 7, 'остаток уменьшился РОВНО на количество частичного выхода');
  assert.equal(partial.openedAt, T1, 'частичный выход не начинает новую эру');
  assert.equal(partial.avgEntryPrice, 100, 'частичный выход не двигает цену входа оставшейся части');
  assert.notEqual(afterOpen.qty, partial.qty);

  // Полный выход остатка (7) закрывает позицию целиком — flat, не «остаток 0 с прежними полями».
  const afterFullExit: ExecutionLedger = [
    ...afterPartialExit,
    fill(T3, 'sell', 107, 7, { clientOrderId: 'o-3', last: true }),
  ];
  assert.equal(derivePositionView(afterFullExit), undefined);
});

test('funding_settlement в ledger не влияет на qty/side/openedAt позиции', () => {
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 100, 10, { clientOrderId: 'o-1' }),
    { kind: 'funding_settlement', ts: T2, amount: -1.5 },
  ];
  const position = derivePositionView(ledger);
  assert.ok(position);
  assert.equal(position.qty, 10);
  assert.equal(position.openedAt, T1);
});

// ─────────────────────────────────────────────────────────────────────────────
// C-1 (Critical) — дробные количества: точное сравнение float с нулём неприменимо по построению.
// ─────────────────────────────────────────────────────────────────────────────

test('C-1: лестница тейк-профитов 0.15 → 3×0.05 закрывает позицию РОВНО (flat, без фиктивного флипа)', () => {
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 33_000, 0.15, { clientOrderId: 'o-1' }),
    fill(T2, 'sell', 33_100, 0.05, { clientOrderId: 'o-2' }),
    fill(T2, 'sell', 33_200, 0.05, { clientOrderId: 'o-3' }),
    fill(T3, 'sell', 33_300, 0.05, { clientOrderId: 'o-4' }),
  ];
  assert.equal(derivePositionView(ledger), undefined, 'три транша по 0.05 закрывают 0.15 без остатка');
});

test('C-1: 0.1 + 0.2 − 0.3 закрывает позицию РОВНО (классический IEEE754 нетривиальный случай)', () => {
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 100, 0.1, { clientOrderId: 'o-1' }),
    fill(T1, 'buy', 100, 0.2, { clientOrderId: 'o-2' }),
    fill(T2, 'sell', 100, 0.3, { clientOrderId: 'o-3' }),
  ];
  assert.equal(derivePositionView(ledger), undefined, '0.1+0.2-0.3 обязано дать flat, не остаток 5.5e-17');
});

test('C-1: дробный ЧАСТИЧНЫЙ выход (без полного закрытия) остаётся частичным, не флипом', () => {
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 33_000, 0.15, { clientOrderId: 'o-1' }),
    fill(T2, 'sell', 33_100, 0.05, { clientOrderId: 'o-2' }),
  ];
  const position = derivePositionView(ledger);
  assert.ok(position);
  assert.equal(position.side, 'long', 'частичный дробный выход не переворачивает сторону');
  assert.ok(Math.abs(position.qty - 0.1) < 1e-9);
  assert.equal(position.openedAt, T1, 'частичный выход не открывает новую эру');
});

// ─────────────────────────────────────────────────────────────────────────────
// I-5 — рантайм-валидация недоверенного ledger'а (JSON-граница чекпойнта).
// ─────────────────────────────────────────────────────────────────────────────

test('I-5: isExecutionLedgerEntry отвергает недоверенную запись (as из JSON)', () => {
  // "Как из JSON": сторона строкой в неверном регистре, цена строкой, ts=1 (валидный TimestampUs,
  // но по форме — не то, чему тип поля должен верить без проверки).
  const corrupted = { kind: 'fill', ts: 1, clientOrderId: 'o', side: 'BUY', price: '100', qty: 10, fee: 0, last: false };
  assert.equal(isExecutionLedgerEntry(corrupted), false, 'side="BUY" не входит в белый список buy/sell');

  const stringPrice = { kind: 'fill', ts: 1, clientOrderId: 'o', side: 'buy', price: '100', qty: 10, fee: 0, last: false };
  assert.equal(isExecutionLedgerEntry(stringPrice), false, 'price строкой отвергается');

  const negativeQtyNaNPrice = {
    kind: 'fill',
    ts: 1,
    clientOrderId: 'o',
    side: 'sell',
    price: NaN,
    qty: -5,
    fee: 0,
    last: false,
  };
  assert.equal(isExecutionLedgerEntry(negativeQtyNaNPrice), false, 'qty<=0 и price=NaN оба отвергаются');

  assert.equal(isExecutionLedger([corrupted, stringPrice]), false);
});

test('I-5: derivePositionView бросает на недоверенной записи, а не молча портит PositionView', () => {
  // Прогон ревью: side="BUY" молча трактовалось как sell (entry.side === 'buy' ложно для чего
  // угодно, кроме точной строки 'buy'). Теперь — RangeError, не тихий неверный PositionView.
  const corrupted = [
    { kind: 'fill', ts: T1, clientOrderId: 'o', side: 'BUY', price: 100, qty: 10, fee: 0, last: false },
  ] as unknown as ExecutionLedger;
  assert.throws(() => derivePositionView(corrupted), RangeError);

  const negativeQtyNaNPrice = [
    { kind: 'fill', ts: T1, clientOrderId: 'o', side: 'sell', price: NaN, qty: -5, fee: 0, last: false },
  ] as unknown as ExecutionLedger;
  assert.throws(() => derivePositionView(negativeQtyNaNPrice), RangeError);

  const unknownKind = [{ kind: 'liquidation', ts: T1, closedQty: 5 }] as unknown as ExecutionLedger;
  assert.throws(() => derivePositionView(unknownKind), RangeError);
});

// ─────────────────────────────────────────────────────────────────────────────
// I-6 — порядок ledger'а: свёртка структурно зависит от него, значит проверяется.
// ─────────────────────────────────────────────────────────────────────────────

test('I-6: ledger с записями не по возрастанию ts — derivePositionView бросает', () => {
  const outOfOrder: ExecutionLedger = [
    fill(T2, 'buy', 100, 10, { clientOrderId: 'o-1' }),
    fill(T1, 'buy', 100, 10, { clientOrderId: 'o-2' }), // T1 < T2 — назад по времени.
  ];
  assert.throws(() => derivePositionView(outOfOrder), RangeError);
});

test('I-6: одинаковый ts у соседних записей (тай) — легален, не бросает', () => {
  const sameTs: ExecutionLedger = [
    fill(T1, 'buy', 100, 5, { clientOrderId: 'o-1' }),
    fill(T1, 'buy', 100, 5, { clientOrderId: 'o-2' }),
  ];
  const position = derivePositionView(sameTs);
  assert.ok(position);
  assert.equal(position.qty, 10);
});
