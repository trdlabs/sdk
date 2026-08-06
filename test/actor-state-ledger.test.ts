// 083 S1 — задача 5: авторский state-слот, `PositionView` (derived `openedAt`, без `unrealizedPnl`),
// execution ledger.
//
// Что здесь пинуется (нумерация — Тесты брифа задачи 5):
//   1) `isPlainActorState` отвергает: функцию-значение, замыкание, циклическую ссылку,
//      несериализуемое значение (NaN/Infinity, Date/Map, symbol/bigint);
//   2) `isPlainActorState` принимает вложенную plain-data структуру любой глубины — включая
//      ДИАМАНТ (одна и та же ссылка из двух полей, не цикл — отдельный негативный контроль на
//      backtracking-детектор циклов, чтобы не спутать разделяемую ссылку с настоящим циклом);
//   3) `PositionView` не несёт `unrealizedPnl` — типовой тест (`@ts-expect-error`), требует
//      `npx tsc -p tsconfig.test.json` (`tsx` типы стирает, не проверяя, как и в других файлах S1);
//   4) `openedAt` выводится из execution ledger'а: добавление в ту же сторону не двигает
//      `openedAt`; флип позиции через ноль даёт `openedAt` от НОВОГО открытия (флип-филла), а не
//      от исходного;
//   5) частичный выход отражается в ledger'е и уменьшает остаток — единственный способ получить
//      `PositionView` в этом контракте — `derivePositionView`, и она ВСЕГДА сворачивает ВЕСЬ
//      ledger заново, поэтому «частичный выход был, а остаток не изменился» не может возникнуть
//      из добросовестного использования контракта (нет отдельного мутируемого поля-остатка, которое
//      можно забыть обновить);
//   6) существующие тесты остаются зелёными — проверяется отдельным прогоном `npm run check`
//      (не дублируется здесь, та же дисциплина, что в `observation-status.test.ts`, пункт 6).
// Run: npx tsx --test test/actor-state-ledger.test.ts
// Type-check (обязателен для пункта 3): npx tsc -p tsconfig.test.json
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  derivePositionView,
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
// Пункт 3 — PositionView без unrealizedPnl (типовой тест).
// ─────────────────────────────────────────────────────────────────────────────

test('PositionView не несёт unrealizedPnl', () => {
  const position: PositionView = {
    side: 'long',
    qty: 1,
    avgEntryPrice: 100,
    openedAt: timestampUs(1_700_000_000_000_000),
  };
  // @ts-expect-error — PositionView намеренно НЕ несёт unrealizedPnl (задача 5, требование 3):
  // производная от текущей рыночной цены создавала бы второй источник истины.
  const leaked = position.unrealizedPnl;
  void leaked;
  assert.equal(position.side, 'long');
});

// ─────────────────────────────────────────────────────────────────────────────
// Пункты 4–5 — execution ledger → derivePositionView.
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

  // «Частичный выход был, а остаток не изменился» невыразимо: derivePositionView — единственный
  // способ получить PositionView в этом контракте, и она ВСЕГДА сворачивает ВЕСЬ ledger заново —
  // 10 → 7 доказано явно, нет отдельного мутируемого поля-остатка, которое можно забыть обновить.
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
