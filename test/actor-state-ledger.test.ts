// 083 S1 — задача 5: авторский state-слот, `PositionView` (derived `openedAt`, без `unrealizedPnl`),
// execution ledger.
//
// РЕВЬЮ РАУНДА 1 (2026-08-06, C-1/C-2/I-1/I-4/I-5/I-6) добавило: дробные лестницы количества (C-1);
// негативный контроль бранд-типа `PositionView` (C-2); символьный/неперечислимый ключ, sparse-
// массив, добавленное свойство массива (I-4); недоверенные записи ledger'а (I-5); порядок записей
// (I-6).
//
// РЕВЬЮ РАУНДА 2 (2026-08-06) — ВОСПРОИЗВЕЛО C-1/C-2 ЗАНОВО против собранного пакета:
//   - C-1 (снова): порог был АБСОЛЮТНЫМ (`1e-9`), а масштаб `qty` гуляет на порядки между
//     инструментами — на крупных количествах (мемкоин-перпы, `~1e8`–`1e9`) абсолютный порог снова
//     давал фиктивный флип. Заменён на ОТНОСИТЕЛЬНЫЙ к пиковому `|qty|` эры (`isNegligibleQty`,
//     `POSITION_QTY_RELATIVE_EPSILON`), применённый СИММЕТРИЧНО к открытию/закрытию/финальной
//     проверке — ниже тесты на масштабах РАЗНОГО порядка, не только мелких;
//   - C-2 (доработка): бренд НЕ переживает spread из уже полученного настоящего экземпляра — это
//     ПРИЗНАННЫЙ, ЗАДОКУМЕНТИРОВАННЫЙ остаточный риск (гарантия ловит забывчивость хоста, не
//     умышленную подделку), не дефект кода; тест переименован, чтобы не заявлять больше, чем
//     механизм даёт;
//   - новый дефект: `isPlainActorState` падала `RangeError` на глубине ~5000 (O(глубина²) от
//     копирования `Set` на каждом узле) — заменено на истинный backtracking (мутируемый `Set`,
//     `add`/`delete` в `finally`) с явным потолком глубины (fail-closed `false`, не исключение);
//   - Minor: `-0` теперь отклоняется (не переживает `JSON.stringify`/`JSON.parse` байт-в-байт).
//
// Что здесь пинуется (нумерация — Тесты брифа задачи 5 + правки ревью):
//   1) `isPlainActorState` отвергает: функцию-значение, замыкание, циклическую ссылку,
//      несериализуемое значение (NaN/Infinity, Date/Map, symbol/bigint, `-0`), И (I-4) функцию под
//      символьным ключом, неперечислимую функцию-свойство, sparse-массив, добавленное свойство
//      массива;
//   2) `isPlainActorState` принимает вложенную plain-data структуру любой глубины ДО ПОТОЛКА —
//      включая ДИАМАНТ (одна и та же ссылка из двух полей, не цикл) и широкий fan-out разделяемой
//      ссылки; глубже потолка — `false`, не падение стека;
//   3) `PositionView` не несёт `unrealizedPnl` — типовой тест (`@ts-expect-error`); И (C-2)
//      `PositionView` НЕВОЗМОЖНО собрать объектным литералом С НУЛЯ — только `derivePositionView`
//      (подделка из уже полученного результата — признанный остаточный риск, не проверяется здесь
//      как «баг», см. doc у теста);
//   4) `openedAt` выводится из execution ledger'а: добавление в ту же сторону не двигает
//      `openedAt`; флип позиции через ноль даёт `openedAt` от НОВОГО открытия; (C-1) флип НЕ
//      возникает фиктивно при точном закрытии позиции НИ НА ОДНОМ из проверенных масштабов
//      (дробном и крупном);
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

// Minor, ревью раунда 2: `-0` не переживает `JSON.stringify`/`JSON.parse` байт-в-байт
// (`JSON.stringify(-0) === '0'`, `JSON.parse('0') === +0`) — противоречило бы обещанию доки «без
// потерь и молчаливых искажений», поэтому отклонён явно, при том что `Number.isFinite(-0)` истинно.
test('Minor: isPlainActorState отвергает -0 (не переживает JSON-границу байт-в-байт)', () => {
  assert.equal(isPlainActorState(-0), false, '-0 на верхнем уровне');
  assert.equal(isPlainActorState({ n: -0 }), false, '-0 вложенное значение поля');
  assert.equal(isPlainActorState(0), true, 'обычный положительный ноль принимается');
  assert.equal(isPlainActorState({ n: 0 }), true, 'обычный положительный ноль во вложенном поле');
});

function deepPlainObject(depth: number): unknown {
  let value: unknown = { leaf: 1 };
  for (let i = 0; i < depth; i += 1) value = { child: value };
  return value;
}

// Новый дефект ревью раунда 2: функция, документированная КАК ГЕЙТ недоверенного JSON, падала
// необработанным RangeError (стек) на глубине ~5000, и ДО ТОГО (глубина 1000) стоила 45.4мс
// (O(глубина²) от копирования Set на каждом узле — доc уже тогда называла это «backtracking»,
// но копия — не backtracking). Обе части проверяются здесь: скорость на разумной глубине И
// fail-closed `false` (не исключение) за потолком.
test('isPlainActorState принимает вложенную структуру ДО потолка глубины — быстро, не O(глубина²)', () => {
  const t0 = performance.now();
  const result = isPlainActorState(deepPlainObject(400));
  const elapsedMs = performance.now() - t0;
  assert.equal(result, true);
  // O(глубина²) на глубине 400 стоил бы уже заметно больше единиц миллисекунд (round-2 прогон:
  // 45.4мс на глубине 1000); щедрый порог — маркер регрессии, не точная бюджетная цифра.
  assert.ok(elapsedMs < 20, `ожидался O(глубина), получено ${elapsedMs.toFixed(2)}мс на глубине 400`);
});

test('isPlainActorState отвергает вложенность глубже потолка — false, НЕ RangeError/падение стека', () => {
  assert.doesNotThrow(() => isPlainActorState(deepPlainObject(5000)));
  assert.equal(isPlainActorState(deepPlainObject(5000)), false);
});

test('isPlainActorState принимает вложенную plain-data структуру любой глубины (до потолка)', () => {
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

test('isPlainActorState: широкий fan-out одной разделяемой ссылки — НЕ ложный цикл', () => {
  // Мутируемый Set backtracking'а (ревью раунда 2) корректен и на ШИРОКОМ дереве, не только на
  // глубоком: одна и та же ссылка, встреченная МНОГО раз на одном уровне (не по кругу), не должна
  // ложно отклоняться — каждая ветвь удаляет себя из ancestors ПЕРЕД тем, как её встретит соседняя.
  const shared = { x: 1 };
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 200; i += 1) wide[`k${i}`] = shared;
  assert.equal(isPlainActorState(wide), true);
});

// Новый Important, ревью раунда 3: `finally`-очистка ancestors даёт верный O(глубина) на
// ПОСЕЩЕНИЕ, но число посещений не ограничено числом узлов на DAG'е — разделяемый ПОДГРАФ (не
// только лист) без memo обходится заново по каждому пути к нему, 2^глубина при ветвлении надвое на
// каждом уровне (прогон ревью: 23 разделяемых объекта → 4.1с). Угроза реальна ИМЕННО здесь:
// snapshotState() возвращает внутрипроцессный объект, не JSON.parse (тот всегда дерево), и волен
// разделять ссылки свободно.
function buildDiamondDag(levels: number): unknown {
  let node: unknown = { leaf: 1 };
  for (let i = 0; i < levels; i += 1) node = { left: node, right: node };
  return node;
}

test('isPlainActorState: DAG с разделяемыми поддеревьями — O(узлы), не O(2^глубина)', () => {
  // 50 уровней двоичного ветвления БЕЗ memo — 2^50 узлов, физически недостижимо за разумное время;
  // прогон ревью зафиксировал экспоненциальный рост уже на 17–23 уровнях (65мс → 4.1с).
  for (const levels of [23, 30, 50]) {
    const t0 = performance.now();
    const result = isPlainActorState(buildDiamondDag(levels));
    const elapsedMs = performance.now() - t0;
    assert.equal(result, true, `levels=${levels}`);
    assert.ok(elapsedMs < 100, `levels=${levels} заняло ${elapsedMs.toFixed(2)}мс — подозрение на экспоненциальный обход`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// C-4 (Critical, ревью раунда 4) — РЕГРЕССИЯ раунда 3: memo (`confirmed`) обходил потолок глубины,
// потому что хранил «доказано» без ГЛУБИНЫ, на которой это доказано. Воспроизведение — не
// искусственное: append-only цепочка (авторский аудит-лог/история версий) плюс индекс-массив,
// обычный функциональный паттерн. Починка — `confirmed: Map<object, height>`, проверка
// `depth + height <= MAX_ACTOR_STATE_DEPTH` на каждом memo-попадании.
// ─────────────────────────────────────────────────────────────────────────────

/** Append-only цепочка `ticks` звеньев ПЛЮС индекс-массив всех узлов в порядке создания — тот же
 *  объект `head` (== `index[ticks-1]`) достижим и напрямую, и (дёшево, через уже подтверждённый
 *  меньший узел) из массива. */
function chainWithIndex(ticks: number): { readonly index: readonly unknown[]; readonly head: unknown } {
  let head: unknown = null;
  const index: unknown[] = [];
  for (let i = 0; i < ticks; i += 1) {
    head = { prev: head, value: i };
    index.push(head);
  }
  return { index, head };
}

test('C-4: memo НЕ обходит потолок глубины — вердикт не зависит от порядка ключей', () => {
  // Дословный сценарий ревью: {index, head} (мелкий узел подтверждается первым, глубокий head
  // дёшево проходит через memo) раньше давал true на глубине 6001/12001; {head, index} (тот же
  // объект, без прогретого memo) честно отклонял на той же структуре — вердикт зависел от порядка
  // ключей, не от данных. После правки оба порядка обязаны СОВПАДАТЬ на каждом масштабе.
  for (const ticks of [3000, 6000, 12000]) {
    const stateIndexFirst = chainWithIndex(ticks);
    const stateHeadFirst = { head: stateIndexFirst.head, index: stateIndexFirst.index };
    const withIndexFirst = isPlainActorState(stateIndexFirst);
    const withHeadFirst = isPlainActorState(stateHeadFirst);
    assert.equal(withIndexFirst, false, `ticks=${ticks}, {index,head}: глубина ${ticks + 1} превышает потолок`);
    assert.equal(withHeadFirst, false, `ticks=${ticks}, {head,index}: тот же вердикт независимо от порядка ключей`);
    assert.equal(withIndexFirst, withHeadFirst, `ticks=${ticks}: вердикт не должен зависеть от порядка ключей`);
  }
});

test('C-4: в пределах потолка глубины memo по-прежнему принимает — порог не пересолен в обратную сторону', () => {
  // Негативный контроль: правка C-4 не должна сделать порог СТРОЖЕ, чем документированный потолок.
  for (const ticks of [100, 400, 498]) {
    const stateIndexFirst = chainWithIndex(ticks);
    const stateHeadFirst = { head: stateIndexFirst.head, index: stateIndexFirst.index };
    assert.equal(isPlainActorState(stateIndexFirst), true, `ticks=${ticks}, {index,head}`);
    assert.equal(isPlainActorState(stateHeadFirst), true, `ticks=${ticks}, {head,index}`);
  }
});

test('C-4: цикл ЧЕРЕЗ разделяемый (memo-подтверждённый) узел по-прежнему даёт false', () => {
  // Регрессионный тест на риск, названный явно ревью раунда 4: новая форма мемоизации (height-
  // aware) не должна была потерять то, что подтвердил дифф-фаззинг раунда 3 (20 000 графов против
  // независимого оракула, 0 расхождений) — цикл, СОСЕДСТВУЮЩИЙ с легитимной разделяемой ссылкой,
  // обязан ловиться, а сама разделяемая ссылка — не ложно отклоняться из-за соседства с циклом.
  const shared = { x: 1 };

  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const combinedWithCycle = { sharedRef: shared, alsoShared: { nested: shared }, bad: cyclic };
  assert.equal(isPlainActorState(combinedWithCycle), false, 'цикл рядом с разделяемым узлом обязан ловиться');

  const combinedNoCycle = { sharedRef: shared, alsoShared: { nested: shared }, more: [shared, shared] };
  assert.equal(isPlainActorState(combinedNoCycle), true, 'та же разделяемая ссылка без цикла — легальна');

  // Цикл, ОБНАРУЖЕННЫЙ через узел, который в ДРУГОЙ ветке уже подтверждён (memo) как валидный:
  // сам факт присутствия в confirmed не должен «защищать» соседний цикл через тот же узел.
  const hub = { value: shared }; // hub сам по себе валиден и попадёт в confirmed.
  const loopy: Record<string, unknown> = { via: hub };
  loopy.backToLoopy = loopy;
  const mixed = { first: hub, second: { hubAgain: hub, loop: loopy } };
  assert.equal(isPlainActorState(mixed), false, 'hub легален и мемоизируется, но loopy рядом всё равно цикличен');
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
// Область теста — РОВНО то, что бренд гарантирует (ревью раунда 2, C-2: прежняя формулировка
// «произвести его может ТОЛЬКО derivePositionView» была заявкой сильнее гарантии). Создание С НУЛЯ
// (объектный литерал, `satisfies`, structural widening, `Object.assign({}, flat)`) закрыто и
// проверяется здесь. Подделка ИЗ УЖЕ ПОЛУЧЕННОГО настоящего экземпляра через spread
// (`{ ...derivePositionView(ledger)!, qty: 1_000_000 }`) НЕ закрыта и не может быть закрыта этим
// механизмом (intersection-бренд без рантайм-носителя) — остаточный риск назван в doc у
// `POSITION_VIEW_BRAND` (`event-driven.ts`), а не проверяется здесь как «баг»: тестировать «spread
// компилируется» было бы тестом на отсутствие гарантии, которой сознательно нет.
test('C-2: PositionView НЕВОЗМОЖНО собрать объектным литералом С НУЛЯ — только derivePositionView', () => {
  // @ts-expect-error — PositionView бранд-типизирован; литерал без POSITION_VIEW_BRAND не подходит.
  // Если эта строка перестала падать, бренд сломан и ничего не гарантирует (та же дисциплина, что
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
// C-1 (Critical, ВОСПРОИЗВЕДЕНО РЕВЬЮ РАУНДА 2) — АБСОЛЮТНЫЙ порог ловил дробные лестницы, но не
// КРУПНЫЕ количества: масштаб `qty` гуляет на порядки между инструментами, `ulp(x)` превышает
// `1e-9` уже при `x ≈ 4.5e6`. Ниже — РОВНО сценарии прогона ревью, разных порядков величины, не
// только мелких (требование раунда 2: «тесты на дробных количествах разных масштабов»).
// ─────────────────────────────────────────────────────────────────────────────

/** Открыть позицию `open` и закрыть её `n` РАВНЫМИ траншами (`open / n` на транш) — воспроизводит
 *  форму прогона ревью. Уникальный `clientOrderId` на каждый транш, `ts` строго неубывающий. */
function ladder(open: number, legs: number): ExecutionLedger {
  const each = open / legs;
  const entries: ExecutionLedgerFillEntry[] = [
    fill(timestampUs(1_700_000_000_000_000), 'buy', 100, open, { clientOrderId: 'open' }),
  ];
  for (let i = 0; i < legs; i += 1) {
    entries.push(
      fill(timestampUs(1_700_000_000_000_000 + (i + 1) * 1_000), 'sell', 100, each, {
        clientOrderId: `exit-${i}`,
      }),
    );
  }
  return entries;
}

test('C-1 раунд 2: масштаб 17000000.3, 3 транша — flat (прежний абсолютный порог давал фиктивный long)', () => {
  assert.equal(derivePositionView(ladder(17_000_000.3, 3)), undefined);
});

test('C-1 раунд 2: масштаб 17000000.3, 20 траншей — flat (прежний абсолютный порог давал фиктивный short)', () => {
  assert.equal(derivePositionView(ladder(17_000_000.3, 20)), undefined);
});

test('C-1 раунд 2: масштаб 1700000000.3, 20 траншей — flat (остаток порядка 1e-7 при пороге 1e-9)', () => {
  assert.equal(derivePositionView(ladder(1_700_000_000.3, 20)), undefined);
});

test('C-1 раунд 2: масштаб 987654321.7, 20 РАВНЫХ траншей — flat, БЕЗ фиктивного флипа с новым openedAt', () => {
  // Дословный сценарий ревью: «чистый полный выход двадцатью равными траншами даёт side=short,
  // qty=2.2e-7 с новым openedAt» на прежней (абсолютной) версии порога.
  assert.equal(derivePositionView(ladder(987_654_321.7, 20)), undefined);
});

test('C-1 раунд 2: симметрия открытия/закрытия — суб-эпсилонное ОТКРЫТИЕ с чистого места тоже не создаёт позицию', () => {
  // Второе следствие абсолютного порога (раунд 2): суб-эпсилонное открытие раньше НЕ проверялось
  // вовсе (прямое присваивание без сравнения с нулём) — один и тот же по масштабу шум трактовался
  // по-разному в зависимости от направления. Теперь isNegligibleQty симметрична. Величина —
  // 1e-13 (ниже нового пола 1e-12 раунда 3, см. POSITION_QTY_RELATIVE_EPSILON), НЕ 1e-10 (раунд 2
  // использовал 1e-10 против прежнего пола 1e-9 — с ужесточённым в раунде 3 порогом 1e-10 уже ВЫШЕ
  // пола и по праву открывает позицию, см. следующий тест).
  const ledger: ExecutionLedger = [fill(T1, 'buy', 100, 1e-13, { clientOrderId: 'o-1' })];
  assert.equal(derivePositionView(ledger), undefined, 'qty=1e-13 ниже нового абсолютного пола 1e-12 — не открывает позицию');
});

test('C-1 раунд 2: обычное дробное открытие (0.01, выше пола) по-прежнему открывает позицию', () => {
  // Негативный контроль к предыдущему тесту: порог не должен поглощать легитимные малые позиции.
  const ledger: ExecutionLedger = [fill(T1, 'buy', 100, 0.01, { clientOrderId: 'o-1' })];
  const position = derivePositionView(ledger);
  assert.ok(position);
  assert.equal(position.qty, 0.01);
});

test('C-1 раунд 2: крупный масштаб — реальный частичный выход (не флип, не шум) остаётся открытым', () => {
  // Негативный контроль: относительный порог не должен поглощать РЕАЛЬНЫЙ остаток на крупном
  // масштабе — только шум, на много порядков меньше самой позиции.
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 100, 987_654_321.7, { clientOrderId: 'o-1' }),
    fill(T2, 'sell', 100, 87_654_321.7, { clientOrderId: 'o-2' }), // остаток 900000000 — не шум.
  ];
  const position = derivePositionView(ledger);
  assert.ok(position);
  assert.equal(position.side, 'long');
  assert.ok(Math.abs(position.qty - 900_000_000) < 1, `остаток обязан быть ~900000000, получено ${position.qty}`);
  assert.equal(position.openedAt, T1, 'реальный частичный выход не открывает новую эру');
});

// ─────────────────────────────────────────────────────────────────────────────
// C-1 (Critical, ВОСПРОИЗВЕДЕНО РЕВЬЮ РАУНДА 3) — сама КОНСТАНТА раунда 2 (1e-9) была пересолена:
// при пике эры 1e9 порог = 1e-9×1e9 = ЦЕЛАЯ базовая единица, и настоящий остаток в 1 (или 1000 при
// пике 1e12) единицу поглощался как «шум» — симметрия, о которой просил раунд 2, была нарушена
// ровно наоборот тому, что чинил раунд 2. Хуже: peakAbsQty липкий на всю эру, поэтому ЖИВАЯ
// позиция, схлопнутая посреди жизни, переоткрывалась следующим филлом со сфабрикованным openedAt.
// Новая константа 1e-12 (ИЗМЕРЕНА: максимум накопленной относительной ошибки на 108 прогонах
// ревью — 8.8e-16, запас ~1000×) закрывает это без возврата фантомов на дробных/крупных лестницах.
// ─────────────────────────────────────────────────────────────────────────────

test('C-1 раунд 3: buy 1e9, sell 1e9-1 — настоящий остаток 1 базовая единица, НЕ flat', () => {
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 100, 1e9, { clientOrderId: 'o-1' }),
    fill(T2, 'sell', 100, 1e9 - 1, { clientOrderId: 'o-2' }),
  ];
  const position = derivePositionView(ledger);
  assert.ok(position, 'остаток в 1 базовую единицу на масштабе 1e9 — реальная позиция, не шум');
  assert.equal(position.side, 'long');
  assert.equal(position.qty, 1);
  assert.equal(position.openedAt, T1);
});

test('C-1 раунд 3: buy 1e12, sell 1e12-1000 — настоящий остаток 1000 единиц, НЕ flat', () => {
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 100, 1e12, { clientOrderId: 'o-1' }),
    fill(T2, 'sell', 100, 1e12 - 1000, { clientOrderId: 'o-2' }),
  ];
  const position = derivePositionView(ledger);
  assert.ok(position, 'остаток в 1000 единиц на масштабе 1e12 — реальная позиция, не шум');
  assert.equal(position.side, 'long');
  assert.equal(position.qty, 1000);
});

test('C-1 раунд 3: buy 1e9, sell 1e9+1 — настоящий флип в short 1, НЕ flat', () => {
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 100, 1e9, { clientOrderId: 'o-1' }),
    fill(T2, 'sell', 100, 1e9 + 1, { clientOrderId: 'o-2' }),
  ];
  const position = derivePositionView(ledger);
  assert.ok(position, 'настоящий флип в short на 1 единицу — не шум');
  assert.equal(position.side, 'short');
  assert.equal(position.qty, 1);
  assert.equal(position.openedAt, T2, 'флип на 1 единицу — тоже НОВАЯ эра, а не проигнорированный шум');
});

test('C-1 раунд 3: «проглоченная эра» — живая позиция посреди жизни НЕ схлопывается и НЕ фабрикует openedAt', () => {
  // Дословный сценарий ревью: buy 1e9 → sell 1e9-10 (остаток 10, та же эра) → sell 9 (остаток 1,
  // РЕАЛЬНЫЙ, не шум — раунд 2 здесь ошибочно давал FLAT и уничтожал эру) → buy 5 (добавление к
  // ТОЙ ЖЕ живой позиции, не новая эра). Итог обязан быть {long, qty:6, openedAt:T1}, а не
  // {long, qty:5, openedAt:t(buy 5)} с потерянной 1 единицей и сфабрикованным openedAt.
  const ledger: ExecutionLedger = [
    fill(T1, 'buy', 100, 1e9, { clientOrderId: 'o-1' }),
    fill(T2, 'sell', 110, 1e9 - 10, { clientOrderId: 'o-2' }),
    fill(T3, 'sell', 120, 9, { clientOrderId: 'o-3' }),
    fill(timestampUs(1_700_000_180_000_000), 'buy', 130, 5, { clientOrderId: 'o-4' }),
  ];
  const position = derivePositionView(ledger);
  assert.ok(position);
  assert.equal(position.side, 'long');
  assert.equal(position.qty, 6, 'остаток 1 (после sell 9) плюс добавленные 5 — эра НЕ прерывалась');
  assert.equal(position.openedAt, T1, 'openedAt обязан остаться от ИСХОДНОГО открытия — эра не прерывалась');
  // avgEntryPrice: смешанная цена оставшейся 1 единицы (100, цена исходного открытия — выходы не
  // меняют avgEntryPrice) и добавленных 5 по 130: (100*1 + 130*5) / 6.
  const expectedAvg = (100 * 1 + 130 * 5) / 6;
  assert.ok(Math.abs(position.avgEntryPrice - expectedAvg) < 1e-6, `avgEntryPrice ${position.avgEntryPrice} !== ${expectedAvg}`);
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

test('Minor: isExecutionLedgerEntry отвергает лишний ключ — та же строгость, что isPlainActorState', () => {
  // Прогон ревью: `{...goodFill, rogue: () => 1}` проходил как `true` — isPlainActorState
  // (event-driven.ts) функцию под лишним ключом отвергает, а этот гейт той же границы (чекпойнт
  // изолята) — нет. Два гейта одной JSON-границы обязаны быть одинаково строги.
  const goodFill = {
    kind: 'fill',
    ts: 1,
    clientOrderId: 'o',
    side: 'buy' as const,
    price: 100,
    qty: 10,
    fee: 0,
    last: false,
  };
  assert.equal(isExecutionLedgerEntry(goodFill), true, 'фикстура сама обязана быть валидной записью');
  assert.equal(isExecutionLedgerEntry({ ...goodFill, rogue: () => 1 }), false, 'лишний ключ с функцией отвергается');
  assert.equal(isExecutionLedgerEntry({ ...goodFill, rogue: 'harmless string' }), false, 'лишний ключ отвергается, даже если plain-data');

  const goodFunding = { kind: 'funding_settlement', ts: 1, amount: -1.5 };
  assert.equal(isExecutionLedgerEntry(goodFunding), true, 'фикстура сама обязана быть валидной записью');
  assert.equal(isExecutionLedgerEntry({ ...goodFunding, rogue: 1 }), false, 'то же для funding_settlement');
});

// Important, ревью раунда 4: паритет с isPlainActorState был ЗАЯВЛЕН доc-комментарием
// hasExactOwnKeys (раунд 3), но не достигнут — прогон ревью нашёл class-инстанс, get-accessor и
// неперечислимое поле, которые проходили здесь и отклонялись isPlainActorState. Accessor даёт
// настоящий TOCTOU (проверка читает поле один раз, derivePositionView/foldFill — второй): значение
// может измениться между валидацией и использованием. Починка — isPlainRecordShape переиспользует
// hasOnlyPlainOwnKeys (event-driven.ts) буквально, не копирует.
test('Important: isExecutionLedgerEntry отвергает class-инстанс, get-accessor и неперечислимое поле — паритет с isPlainActorState', () => {
  class Fill {
    kind = 'fill' as const;
    ts = 1;
    clientOrderId = 'o';
    side = 'buy' as const;
    price = 100;
    qty = 10;
    fee = 0;
    last = false;
  }
  assert.equal(isExecutionLedgerEntry(new Fill()), false, 'class-инстанс верной формы — не plain-объект');

  const withAccessor: Record<string, unknown> = {
    kind: 'fill',
    ts: 1,
    clientOrderId: 'o',
    side: 'buy',
    price: 100,
    fee: 0,
    last: false,
  };
  // TOCTOU буквально: get возвращает 10 при проверке, но ничто не мешает ему вернуть другое
  // значение при следующем чтении (foldFill).
  Object.defineProperty(withAccessor, 'qty', { get: () => 10, enumerable: true, configurable: true });
  assert.equal(isExecutionLedgerEntry(withAccessor), false, 'qty через get-accessor — TOCTOU, отвергается');

  const withNonEnumerable: Record<string, unknown> = {
    kind: 'fill',
    ts: 1,
    clientOrderId: 'o',
    side: 'buy',
    price: 100,
    fee: 0,
    last: false,
  };
  Object.defineProperty(withNonEnumerable, 'qty', { value: 10, enumerable: false, configurable: true });
  assert.equal(isExecutionLedgerEntry(withNonEnumerable), false, 'qty неперечислимо — та же строгость, что isPlainActorState');
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
