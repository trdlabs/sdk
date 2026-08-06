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
//      (не дублируется здесь); дополнительно ниже — ТОЧНАЯ (не только взаимная mutual-extends,
//      слепая к дрейфу опциональных полей — M-2 ревью) типовая совместимость `ObservedRevision<T>`
//      (эта задача) и `ObservedValue<T>` (задача 1, `event-driven.ts`).
//
// Раунд правок ревью (2026-08-06, C-1/I-1..I-6/M-1/M-2/M-3/M-7 — см. коммит) добавил ниже: NaN/
// дробный/отрицательный `revision` отклоняется (I-1); неизвестное значение `finality` за пределами
// типа отклоняется белым списком, не проваливается в accepted (I-2); дефолтный компаратор различает
// `NaN`/`Infinity`, `0`/`-0` и объект с явным `undefined`-полем (I-3); несовпадающий `effectiveTsUs`
// между `previous`/`next` отклоняется (I-4); `skipPolicy` действует и на первом наблюдении, не
// только посреди потока (I-6); пустой/whitespace-only `rationale` не активирует `skipPolicy` (M-1);
// `final(n) → provisional(n)` с тем же содержимым — ОТКАЗ, не дубль (M-3, отдельный код); коды
// «не начали с 0» и «перескочили номер» разведены (M-7); `parseArchiveRow(hasKind, undefined)`
// разбирается так же, как `null` (C-1 — критический дефект: раньше `(true, undefined)` объявлял
// отсутствие данных настоящим наблюдением).
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

// I-1 ревью: revision — TS `number`, NaN/дробь/отрицательное типом не запрещены. Прогон ревьюера:
// prov(3) → prov(NaN) и prov(NaN) → prov(4) оба проходили как accepted (все сравнения с NaN ложны).
test('I-1: NaN/дробный/отрицательный revision отклоняется — fail-closed на входе, не fail-open', () => {
  const nextIsNaN = checkRevisionTransition<number>(rev(3, 'provisional'), rev(NaN, 'provisional'));
  assert.equal(nextIsNaN.outcome, 'rejected');
  assert.equal((nextIsNaN as { code: string }).code, 'observation_revision_invalid');

  const previousIsNaN = checkRevisionTransition<number>(rev(NaN, 'provisional'), rev(4, 'provisional'));
  assert.equal(previousIsNaN.outcome, 'rejected');
  assert.equal((previousIsNaN as { code: string }).code, 'observation_revision_invalid');

  const fractional = checkRevisionTransition<number>(rev(3, 'provisional'), rev(3.5, 'provisional'));
  assert.equal(fractional.outcome, 'rejected');
  assert.equal((fractional as { code: string }).code, 'observation_revision_invalid');

  const negative = checkRevisionTransition<number>(undefined, rev(-1, 'provisional'));
  assert.equal(negative.outcome, 'rejected');
  assert.equal((negative as { code: string }).code, 'observation_revision_invalid');
});

test('первая ревизия 0 принята; 0 → 1 принят', () => {
  const first = checkRevisionTransition<number>(undefined, rev(0, 'provisional'));
  assert.deepEqual(first, { outcome: 'accepted' });

  const bump = checkRevisionTransition<number>(rev(0, 'provisional'), rev(1, 'provisional'));
  assert.deepEqual(bump, { outcome: 'accepted' });
});

test('первая ревизия не 0 — отказ (start_invalid, M-7: код ОТДЕЛЬНЫЙ от пропуска посреди потока)', () => {
  const res = checkRevisionTransition<number>(undefined, rev(2, 'provisional'));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_start_invalid');
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

// I-3 ревью: прежний JSON.stringify-компаратор путал NaN/Infinity (оба → "null"), 0/-0 (оба →
// "0") и терял объектные ключи с явным undefined-значением. NaN в числовой рыночной колонке —
// самый вероятный вид повреждения потока; компаратор, который путает его с легитимным значением,
// не гейтит вообще ничего.
test('I-3: NaN и Infinity — разное содержимое, не путаются через JSON.stringify', () => {
  const res = checkRevisionTransition<number>(rev(1, 'provisional', NaN), rev(1, 'provisional', Infinity));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_conflict');
});

test('I-3: NaN против NaN — SameValue равны, законный идемпотентный дубль', () => {
  const res = checkRevisionTransition<number>(rev(1, 'provisional', NaN), rev(1, 'provisional', NaN));
  assert.deepEqual(res, { outcome: 'duplicate' });
});

test('I-3: 0 и -0 — разное содержимое (Object.is различает знак нуля, JSON.stringify — нет)', () => {
  const res = checkRevisionTransition<number>(rev(1, 'provisional', 0), rev(1, 'provisional', -0));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_conflict');
});

test('I-3: объект с явным undefined-полем отличается от объекта без этого поля', () => {
  interface Obj {
    readonly a: number;
    readonly b?: number;
  }
  const withUndefinedKey: Obj = { a: 1, b: undefined };
  const withoutKey: Obj = { a: 1 };
  const res = checkRevisionTransition<Obj>(
    { state: 'observed', value: withUndefinedKey, effectiveTsUs: T1, finality: 'provisional', revision: 1 },
    { state: 'observed', value: withoutKey, effectiveTsUs: T1, finality: 'provisional', revision: 1 },
  );
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_conflict');
});

// I-4 ревью: ключ ревизии — (subscriptionId, effectiveTsUs); subscriptionId функции недоступен, но
// effectiveTsUs несут оба аргумента — баг кеевания резолвера (две разные минуты под одним номером)
// иначе проходил бы как идемпотентный дубль.
test('I-4: previous.effectiveTsUs !== next.effectiveTsUs — отказ (перепутанный ключ), не дубль', () => {
  const previous = rev(3, 'provisional', 5);
  const next = { ...rev(3, 'provisional', 5), effectiveTsUs: T2 };
  const res = checkRevisionTransition<number>(previous, next);
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_key_mismatch');
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

// I-2 ревью: белый список (`previous.finality !== 'provisional'`), не чёрный
// (`previous.finality === 'final'`). Проверяем через недоверенный вход, обходящий тип TS (`as
// unknown as`, как реальный JSON.parse-результат): значение finality, которого в объявленном
// union'е нет вовсе, обязано попасть в отказ, а не молча провалиться в accepted.
test('I-2: неизвестное значение finality (за пределами типа) — отказ белым списком, не accepted', () => {
  const corrupted = { ...rev(1, 'provisional', 5), finality: 'weird' } as unknown as ObservedRevision<number>;
  const res = checkRevisionTransition<number>(corrupted, rev(2, 'provisional', 6));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_finalized');
});

// M-3 — уточнение владельца после первого раунда: «дубль независимо от finality» было СЛИШКОМ
// широким и накрывало снятие окончательности. Терминальность ловит появление НОВОЙ информации
// после объявления окончательной; снятие final → provisional — ровно новая информация, а не
// повторная доставка. Отдельный код (не conflict — содержимое совпало; не finalized — тот код про
// смену revision, а не finality).
test('M-3: final(n) → provisional(n) с тем же содержимым — отказ (finality_demoted), НЕ дубль', () => {
  const res = checkRevisionTransition<number>(rev(2, 'final', 7), rev(2, 'provisional', 7));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_finality_demoted');
});

test('пропуск номера посреди потока — отказ по умолчанию (код skipped, отдельный от start_invalid)', () => {
  const res = checkRevisionTransition<number>(rev(1, 'provisional'), rev(3, 'provisional'));
  assert.equal(res.outcome, 'rejected');
  assert.equal((res as { code: string }).code, 'observation_revision_skipped');
});

test('пропуск номера посреди потока с явно объявленной skipPolicy — принят, не молча по умолчанию', () => {
  const withoutPolicy = checkRevisionTransition<number>(rev(1, 'provisional'), rev(5, 'provisional'));
  assert.equal(withoutPolicy.outcome, 'rejected');

  const withPolicy = checkRevisionTransition<number>(rev(1, 'provisional'), rev(5, 'provisional'), {
    skipPolicy: { allowed: true, rationale: 'провайдер X нумерует ревизии не подряд (repro: тест)' },
  });
  assert.deepEqual(withPolicy, { outcome: 'accepted' });
});

// I-6 ревью: доказательство брифа/доки — «первая ревизия обязана быть 0, ИЛИ пропуск явно объявлен
// provider policy» — раньше держалось только для СЕРЕДИНЫ потока; провайдер, нумерующий с 1, не
// спасался задекларированной policy на самом первом наблюдении.
test('I-6: skipPolicy действует и на ПЕРВОМ наблюдении ключа, не только посреди потока', () => {
  const withoutPolicy = checkRevisionTransition<number>(undefined, rev(1, 'provisional'));
  assert.equal(withoutPolicy.outcome, 'rejected');
  assert.equal((withoutPolicy as { code: string }).code, 'observation_revision_start_invalid');

  const withPolicy = checkRevisionTransition<number>(undefined, rev(1, 'provisional'), {
    skipPolicy: { allowed: true, rationale: 'провайдер Y нумерует ревизии с 1, а не с 0 (repro: тест)' },
  });
  assert.deepEqual(withPolicy, { outcome: 'accepted' });
});

// M-1 ревью: вся аргументация DeclaredRevisionSkipPolicy («не булев флаг, а обязательная причина»)
// держится только на том, что rationale реально проверяется. Пустая/whitespace-only строка не
// должна активировать policy — иначе поле существует чисто декоративно.
test('M-1: пустой либо whitespace-only rationale НЕ активирует skipPolicy — гейт остаётся в силе', () => {
  const emptyRationale = checkRevisionTransition<number>(rev(1, 'provisional'), rev(5, 'provisional'), {
    skipPolicy: { allowed: true, rationale: '' },
  });
  assert.equal(emptyRationale.outcome, 'rejected');
  assert.equal((emptyRationale as { code: string }).code, 'observation_revision_skipped');

  const whitespaceRationale = checkRevisionTransition<number>(rev(1, 'provisional'), rev(5, 'provisional'), {
    skipPolicy: { allowed: true, rationale: '   ' },
  });
  assert.equal(whitespaceRationale.outcome, 'rejected');

  const emptyOnFirstObservation = checkRevisionTransition<number>(undefined, rev(1, 'provisional'), {
    skipPolicy: { allowed: true, rationale: '' },
  });
  assert.equal(emptyOnFirstObservation.outcome, 'rejected');
  assert.equal((emptyOnFirstObservation as { code: string }).code, 'observation_revision_start_invalid');
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

// C-1 ревью (Critical): `undefined`, не только `null`, обязан разбираться идентично `null` — эта
// функция единственный гейт для НЕДОВЕРЕННОГО источника (host читает Parquet/JSON через
// any-типизированную читалку, где пропущенная колонка даёт undefined, а не null). Первая версия
// (`=== null`) объявляла `(true, undefined)` настоящим наблюдением — ровно та ошибка, против
// которой написан весь файл, только со стороны JS-платформы.
test('C-1: has_kind=false, value=undefined — тот же исход, что value=null (gap)', () => {
  const res = parseArchiveRow<number>(false, undefined);
  assert.deepEqual(res, { ok: true, present: false });
});

test('C-1: has_kind=true, value=undefined — corrupt (НЕ настоящее наблюдение с value:undefined)', () => {
  const res = parseArchiveRow<number>(true, undefined);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'observation_archive_row_corrupt');
});

// ─────────────────────────────────────────────────────────────────────────────
// Пункт 6 (доп.) — ObservedRevision<T> согласован с ObservedValue<T> (задача 1) взаимно, а не по
// совпадению: любое поле, добавленное/убранное только с ОДНОЙ стороны, красит одну из двух строк
// ниже под tsc -p tsconfig.test.json.
// ─────────────────────────────────────────────────────────────────────────────

// `ObservedRevision<T>` несёт discriminant `state`, которого у `ObservedValue<T>` нет и не должно
// быть (ObservedValue — не размеченный union, ему нечего дискриминировать) — поэтому проверка идёт
// по ОБЩИМ четырём полям (`Omit<…, 'state'>`), а не по типам целиком.
type ObservedRevisionFields<T> = Omit<ObservedRevision<T>, 'state'>;

// M-2 ревью (поднято до Important): обычный ВЗАИМНЫЙ `extends` СЛЕП к дрейфу ОПЦИОНАЛЬНОГО поля.
// `{a:number,b?:string}` и `{a:number}` взаимно `extends` друг друга (опциональность допускает
// отсутствие `b` с обеих сторон — B `extends` A, потому что "b?" не обязывает B его нести, и A
// `extends` B тривиально, потому что B — это A с более узкими требованиями), поэтому предыдущая
// пара `AssertExtends` прошла бы дрейф `b?` МОЛЧА. У `ObservationStatus` опциональное поле уже
// есть (`lastObservedTsUs?` на gap-ветке) — слепое пятно не гипотетическое.
//
// Приём (microsoft/TypeScript#27024, тот же, что используют tsd/expect-type): сравнение через
// СТРУКТУРНУЮ идентичность двух generic-функциональных типов под conditional type. TS сравнивает
// `(<T>() => T extends A ? 1 : 2)` и `(<T>() => T extends B ? 1 : 2)` НАЦЕЛО (два generic-типа
// функций либо идентичны, либо нет — не через двустороннюю assignability их РЕЗУЛЬТАТОВ), и эта
// идентичность чувствительна к модификатору `?`, в отличие от `A extends B`/`B extends A` порознь.
type IsExactType<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;

/** Проваливает сборку (`T extends true` не выполняется), если `IsExactType<A,B>` — `false`. Та же
 *  идиома генерик-ограничения, что `AssertNoUncoveredKind` в `event-driven.ts` (раунд правок 1,
 *  I-1) — не рантайм-значение, чистая типовая проверка. */
type AssertExactMatch<T extends true> = T;

type _ObservedRevisionFieldsExactlyObservedValue = AssertExactMatch<
  IsExactType<ObservedRevisionFields<number>, ObservedValue<number>>
>;

// Негативный контроль: доказываем, что `IsExactType` ДЕЙСТВИТЕЛЬНО ловит дрейф опционального поля,
// а не просто выглядит как решение — без этого теста заявка «дрейф ловится» была бы той же
// непроверенной уверенностью, за которую поймали первый раунд (M-2 само по себе).
type _WithOptionalField = { readonly a: number; readonly b?: string };
type _WithoutOptionalField = { readonly a: number };
// @ts-expect-error — IsExactType обязана отличить {a,b?} от {a}: если эта строка перестала падать,
// IsExactType сломан и ничего не гарантирует — тест на ГАРАНТИЮ, а не на конкретную пару типов.
type _MustFailOnOptionalFieldDrift = AssertExactMatch<IsExactType<_WithOptionalField, _WithoutOptionalField>>;

test('ObservedRevision<T> и ObservedValue<T> взаимно совместимы структурно (см. типовые проверки выше файла)', () => {
  const asObservedValue: ObservedValue<number> = { effectiveTsUs: T2, value: 9, finality: 'final', revision: 0 };
  const asObservedRevision: ObservedRevision<number> = { state: 'observed', ...asObservedValue };
  assert.equal(asObservedRevision.value, 9);
});
