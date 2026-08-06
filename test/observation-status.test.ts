// 083 S1 — задача 4: `ObservationStatus`, переходы `revision`, гейт валидности строки архива.
//
// Что здесь пинуется (нумерация — Тесты брифа задачи 4):
//   1) замкнутость union'а: `switch` по `state` БЕЗ `default` компилируется, только если покрывает
//      все три ветки (типовая проверка — нужен `npx tsc -p tsconfig.test.json`, `tsx` типы стирает,
//      как и в `actor-market-events.test.ts`/`market-data-requirement.test.ts`);
//   2) `?? 0` над `.value` без предварительного сужения по `state` НЕ компилируется — главный
//      структурный якорь задачи: наивный аналог платформенного бага
//      (`r.has_liquidations ? (r.liq_long_usd ?? 0) : 0`, `extract_065_real_slice_fixture.mjs:36`)
//      на этом типе НЕВЫРАЗИМ — `.value` недостижимо ни у `never_observed`, ни у `gap`;
//   3) переходы `checkRevisionTransition`: `0 → 1` принят; тот же номер/то же содержимое —
//      идемпотентный дубль; тот же номер/другое содержимое — отказ (corruption); `final → что
//      угодно` — отказ (терминальность); пропуск номера — отказ (fail-closed по умолчанию,
//      явная `skipPolicy` снимает отказ);
//   4) `parseArchiveRow`: все пять строк таблицы валидности, включая обе corrupt-комбинации;
//   5) `hasKind=true, value=0` разбирается как настоящее наблюдение с нулём, а НЕ как gap — ГЛАВНЫЙ
//      кейс, ради которого всё сделано (прод-день: `has_liquidations` истинен на всех 1438
//      минутах, ненулевое значение — лишь на 154; остальные 1284 — настоящий ноль, не пропуск);
//   6) существующие тесты остаются зелёными — проверяется отдельным прогоном `npm run check`
//      (не дублируется здесь); дополнительно ниже — взаимная типовая совместимость
//      `ObservedRevision<T>` (эта задача) и `ObservedValue<T>` (задача 1, `event-driven.ts`), раз
//      согласованность декларирована прозой в обоих файлах, а не типовым импортом (см. doc
//      `ObservationStatus`, `observation-status.ts`).
// Run: npx tsx --test test/observation-status.test.ts
// Type-check (обязателен для пунктов 1, 2, 6): npx tsc -p tsconfig.test.json
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkRevisionTransition,
  parseArchiveRow,
  timestampUs,
  type ObservationStatus,
  type ObservedRevision,
  type ObservedValue,
} from '../src/research-contract/index.js';

const T1 = timestampUs(1_700_000_000_000_000);
const T2 = timestampUs(1_700_000_000_060_000);

// ─────────────────────────────────────────────────────────────────────────────
// Пункт 1 — замкнутость union'а: switch без default над `state` покрывает три ветки.
// ─────────────────────────────────────────────────────────────────────────────

/** Недостижимо, пока `ObservationStatus['state']` и вызывающий код согласованы. */
function assertNever(x: never): never {
  throw new Error(`assertNever: недостижимо, получено ${JSON.stringify(x)}`);
}

/**
 * Исчерпывающий диспетчер БЕЗ `default`: если бы в union завелась четвёртая ветка без своего
 * `case` здесь, `status` в конце функции не сузился бы до `never`, и `assertNever(status)`
 * оказался бы красным под `tsc -p tsconfig.test.json` — сборка ломается до рантайма.
 */
function describe(status: ObservationStatus<number>): string {
  switch (status.state) {
    case 'never_observed':
      return 'never_observed';
    case 'observed':
      return `observed(${status.value})`;
    case 'gap':
      return `gap(${status.expectedTsUs})`;
  }
  return assertNever(status);
}

test('замкнутость: switch без default над ObservationStatus.state покрывает все три ветки', () => {
  const neverObserved: ObservationStatus<number> = { state: 'never_observed' };
  const observed: ObservationStatus<number> = {
    state: 'observed',
    value: 0,
    effectiveTsUs: T1,
    finality: 'final',
    revision: 0,
  };
  const gap: ObservationStatus<number> = { state: 'gap', expectedTsUs: T1 };

  assert.equal(describe(neverObserved), 'never_observed');
  assert.equal(describe(observed), 'observed(0)');
  assert.equal(describe(gap), `gap(${T1})`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Пункт 2 — `?? 0` над `.value` без сужения по `state` не компилируется.
// ─────────────────────────────────────────────────────────────────────────────

// Возврат из функции (а не голый литерал в `const`) — намеренно: `const x: ObservationStatus<T> =
// {state:'gap',...}` даёт TS control-flow-narrowing вниз ДО `state:'gap'` литерала уже на месте
// объявления (const никогда не переприсваивается), и тогда `status.state === 'observed'` ниже по
// коду сам не компилируется («no overlap») — искусственный эффект инструмента, не тест на форму
// типа. Через возврат функции CFA даёт ровно объявленный `ObservationStatus<number>`, без лишнего
// сужения — именно то, с чем работает вызывающий код в реальности (результат резолва подписки).
function gapStatus(): ObservationStatus<number> {
  return { state: 'gap', expectedTsUs: T1 };
}

test('доступ к .value без сужения по state недостижим — платформенный баг невыразим на этом типе', () => {
  const status = gapStatus();

  // Наивный аналог `r.has_liquidations ? (r.liq_long_usd ?? 0) : 0`: без предварительного
  // `switch(status.state)`/`if (status.state === 'observed')` свойство `value` не существует ни у
  // `never_observed`, ни у `gap` — TS2339, не только при `gap`, а СТРУКТУРНО у union'а целиком.
  // @ts-expect-error — ObservationStatus не несёт .value без сужения по status.state.
  const collapsed = status.value ?? 0;
  void collapsed;

  // Правильный путь: сужение делает value достижимым и снимает саму возможность подмены.
  const safe = status.state === 'observed' ? status.value : undefined;
  assert.equal(safe, undefined, 'gap не несёт value — сужение честно возвращает undefined, не 0');
});

// ─────────────────────────────────────────────────────────────────────────────
// Пункт 3 — checkRevisionTransition: нормативные переходы.
// ─────────────────────────────────────────────────────────────────────────────

function rev(revision: number, finality: 'provisional' | 'final', value = 1): ObservedRevision<number> {
  return { state: 'observed', value, effectiveTsUs: T1, finality, revision };
}

test('первая ревизия 0 принята; 0 → 1 принят', () => {
  const first = checkRevisionTransition<number>(undefined, rev(0, 'provisional'));
  assert.deepEqual(first, { outcome: 'accepted' });

  const bump = checkRevisionTransition<number>(rev(0, 'provisional'), rev(1, 'provisional'));
  assert.deepEqual(bump, { outcome: 'accepted' });
});

test('первая ревизия не 0 — отказ (пропуск)', () => {
  const res = checkRevisionTransition<number>(undefined, rev(2, 'provisional'));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_skipped');
});

test('тот же revision, то же содержимое — идемпотентный дубль', () => {
  const res = checkRevisionTransition<number>(rev(1, 'provisional', 5), rev(1, 'provisional', 5));
  assert.deepEqual(res, { outcome: 'duplicate' });
});

test('тот же revision, другое содержимое — отказ (corruption)', () => {
  const res = checkRevisionTransition<number>(rev(1, 'provisional', 5), rev(1, 'provisional', 6));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_conflict');
});

test('provisional(n) → final(n) — легитимная финализация той же ревизии, не дубль и не отказ', () => {
  const res = checkRevisionTransition<number>(rev(1, 'provisional', 5), rev(1, 'final', 5));
  assert.deepEqual(res, { outcome: 'accepted' });
});

test('provisional(n) → provisional(n+1) → final(n+1) — легальный путь целиком', () => {
  const step1 = checkRevisionTransition<number>(undefined, rev(0, 'provisional', 1));
  assert.equal(step1.outcome, 'accepted');
  const step2 = checkRevisionTransition<number>(rev(0, 'provisional', 1), rev(1, 'provisional', 2));
  assert.equal(step2.outcome, 'accepted');
  const step3 = checkRevisionTransition<number>(rev(1, 'provisional', 2), rev(1, 'final', 2));
  assert.equal(step3.outcome, 'accepted');
});

// Разделяющий случай (правка владельца после ревью, 2026-08-06): идемпотентный дубль побеждает
// терминальность. Повторная доставка того же revision с тем же содержимым легальна НЕЗАВИСИМО от
// finality — включая final → final побитово: доставка «хотя бы один раз» штатно приносит ту же
// финальную запись дважды, и fail-closed на этом — ложноположительное срабатывание гейта.
// Терминальность final ловит РОВНО два случая: тот же revision с ДРУГИМ содержимым, и ЛЮБОЙ другой
// revision (после того, как значение объявлено окончательным).
test('final(n) повторно с ИДЕНТИЧНЫМ содержимым — принят как идемпотентный дубль, терминальность не мешает', () => {
  const res = checkRevisionTransition<number>(rev(2, 'final', 7), rev(2, 'final', 7));
  assert.deepEqual(res, { outcome: 'duplicate' });
});

test('final(n) повторно с ИЗМЕНЁННЫМ содержимым — отказ (corruption, не терминальность)', () => {
  const res = checkRevisionTransition<number>(rev(2, 'final', 7), rev(2, 'final', 9));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_conflict');
});

test('final(n) → revision n+1 — отказ (терминальность в чистом виде)', () => {
  const res = checkRevisionTransition<number>(rev(2, 'final', 7), rev(3, 'provisional', 8));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_finalized');
});

test('пропуск номера — отказ по умолчанию', () => {
  const res = checkRevisionTransition<number>(rev(1, 'provisional'), rev(3, 'provisional'));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_skipped');
});

test('пропуск номера с явно объявленной skipPolicy — принят, не молча по умолчанию', () => {
  const withoutPolicy = checkRevisionTransition<number>(rev(1, 'provisional'), rev(5, 'provisional'));
  assert.equal(withoutPolicy.outcome, 'rejected');

  const withPolicy = checkRevisionTransition<number>(rev(1, 'provisional'), rev(5, 'provisional'), {
    skipPolicy: { allowed: true, rationale: 'провайдер X нумерует ревизии не подряд (repro: тест)' },
  });
  assert.deepEqual(withPolicy, { outcome: 'accepted' });
});

test('ревизия убывает — отказ (регресс монотонности)', () => {
  const res = checkRevisionTransition<number>(rev(3, 'provisional'), rev(2, 'provisional'));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_regressed');
});

// ─────────────────────────────────────────────────────────────────────────────
// Пункт 4 — parseArchiveRow: все пять строк таблицы валидности.
// ─────────────────────────────────────────────────────────────────────────────

test('has_kind=false, value=null — gap: наблюдения нет', () => {
  const res = parseArchiveRow<number>(false, null);
  assert.deepEqual(res, { ok: true, present: false });
});

test('has_kind=true, value=0 — настоящее наблюдение, значение ноль (ГЛАВНЫЙ кейс, пункт 5)', () => {
  const res = parseArchiveRow<number>(true, 0);
  assert.deepEqual(res, { ok: true, present: true, value: 0 });
  assert.equal((res as { present: boolean }).present, true, 'ноль — не gap');
});

test('has_kind=true, value≠null — настоящее наблюдение', () => {
  const res = parseArchiveRow<number>(true, 42);
  assert.deepEqual(res, { ok: true, present: true, value: 42 });
});

test('has_kind=true, value=null — corrupt, fail-closed', () => {
  const res = parseArchiveRow<number>(true, null);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'observation_archive_row_corrupt');
});

test('has_kind=false, value≠null — corrupt, fail-closed', () => {
  const res = parseArchiveRow<number>(false, 7);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'observation_archive_row_corrupt');
});

// ─────────────────────────────────────────────────────────────────────────────
// Пункт 6 (доп.) — ObservedRevision<T> согласован с ObservedValue<T> (задача 1) взаимно, а не по
// совпадению: любое поле, добавленное/убранное только с ОДНОЙ стороны, красит одну из двух строк
// ниже под tsc -p tsconfig.test.json.
// ─────────────────────────────────────────────────────────────────────────────

// `ObservedRevision<T>` несёт discriminant `state`, которого у `ObservedValue<T>` нет и не должно
// быть (ObservedValue — не размеченный union, ему нечего дискриминировать) — поэтому мутуальная
// проверка идёт по ОБЩИМ четырём полям (`Omit<…, 'state'>`), а не по типам целиком: полное
// взаимное `extends` было бы ложно отрицательным именно из-за `state`, ничего не говоря о
// реальном расхождении состава.
type ObservedRevisionFields<T> = Omit<ObservedRevision<T>, 'state'>;
type AssertExtends<A, B extends A> = B;
type _ObservedRevisionFieldsCoverObservedValue = AssertExtends<ObservedValue<number>, ObservedRevisionFields<number>>;
type _ObservedValueCoversObservedRevisionFields = AssertExtends<ObservedRevisionFields<number>, ObservedValue<number>>;

test('ObservedRevision<T> и ObservedValue<T> взаимно совместимы структурно (см. типовые проверки выше файла)', () => {
  const asObservedValue: ObservedValue<number> = { effectiveTsUs: T2, value: 9, finality: 'final', revision: 0 };
  const asObservedRevision: ObservedRevision<number> = { state: 'observed', ...asObservedValue };
  assert.equal(asObservedRevision.value, 9);
});
