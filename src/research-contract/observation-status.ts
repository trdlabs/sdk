// 083 S1 — задача 4: три состояния наблюдения, нормативные переходы `revision` и исполняемый
// гейт валидности строки архива.
//
// Модуль — СОСЕД `event-driven.ts` (где живёт `ObservedValue<T>`, задача 1), а не его часть.
// Причина разнесения: третье состояние наблюдения нужно ДВУМ потребителям — конверту событий
// (`MarketSubscriptionStatusChangedEvent` берёт отсюда 'gap'-ветку, не заводит вторую
// параллельную форму, см. `event-driven.ts`) и БУДУЩЕЙ pull-проекции `ActorContext` (задача 5,
// здесь не проектируется). Зависимость — только В ОДНУ СТОРОНУ: `event-driven.ts` импортирует
// ОТСЮДА, обратного импорта нет (иначе кольцо `event-driven.ts ⇄ observation-status.ts`) — та же
// роль, что у `time-us.ts`, уже сосед `event-driven.ts` по тем же причинам.
//
// ─────────────────────────────────────────────────────────────────────────────
// Три уровня «данных нет» — различены МЕСТОМ, где актор о них узнаёт. Не путать между собой:
// разные субъекты, разные моменты, разные носители.
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. Вида нет в прогоне ВООБЩЕ — статический факт из манифеста/резолва `MarketDataRequirement`
//    (`event-driven.ts`, задача 3): какие подписки вообще существуют. Долетает в `ActorInit` ОДИН
//    РАЗ на старте актора; не событие, не поле бара и уж точно не `ObservationStatus` ниже — актор
//    узнаёт об этом ДО первого события, а не по ходу прогона.
// 2. Наблюдения нет В ЭТОМ frontier — вид объявлен и резолвится, но на проводе для текущего
//    момента тишина (`market.subscription.status_changed` эмитится РОВНО на переходе, задача 2).
//    Это `ObservationStatus.gap` ниже: статус читается ИЗ ПРОЕКЦИИ (будущий pull-API `ctx`, задача
//    5), а не выводится заново на каждый тик из последнего события.
// 3. Значение — НОЛЬ. Настоящее событие с настоящим значением `0` (или структурой, чьи числовые
//    поля нулевые) — это `ObservationStatus.observed`, а НЕ gap и не отсутствие. Ликвидации за
//    минуту без единого каскада — `{longUsd:0, shortUsd:0}` (см. doc `LiqPoint`, `market-tape.ts`),
//    настоящее покрытое наблюдение, не «данных не было».
//
// Смешение уровня 2 и 3 — ИМЕННО тот баг, ради недопущения которого написан этот файл (требование
// 4 брифа задачи, тест «`?? 0` не компилируется»): в `platform`
// `scripts/…/extract_065_real_slice_fixture.mjs:36` пишет
// `r.has_liquidations ? (r.liq_long_usd ?? 0) : 0` — `?? 0` подставляет ноль ТУДА, где сырое
// значение оказалось `null`/`undefined` при `has_liquidations` истинном, стирая разницу между
// «покрыто, но пусто» и «покрыто, значение действительно ноль» за одной и той же цифрой. Сосед
// `extract_049_replay_fixture.mjs:29` эту разницу сохраняет честно (`liqPoint: … : null`). Замкнутый
// размеченный union делает первую ошибку НЕВЫРАЗИМОЙ на уровне типов: `.value` недостижимо без
// `switch(status.state)` — см. `observation-status.test.ts`, пункт 2.

import type { TimestampUs } from './time-us.js';
import type { ValidationCode } from './validation.js';

// ─────────────────────────────────────────────────────────────────────────────
// ObservationStatus — три состояния наблюдения (требование 1).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Статус наблюдения значения вида `T` на момент чтения. Три ветки, а не `T | undefined`:
 * двузначное отсутствие уже дало платформенный баг (см. шапку файла) — `undefined` не различает
 * «наблюдение ещё не началось» от «наблюдали, но именно сейчас пропуск во frontier».
 *
 * Ветка `'observed'` несёт РОВНО те четыре поля, что и `ObservedValue<T>` (`event-driven.ts`,
 * задача 1) — согласовано вручную по составу и типам полей, НЕ типовым импортом: импорт в обратную
 * сторону завёл бы кольцо зависимостей (см. шапку файла). Расхождение между двумя формами ловится
 * `observation-status.test.ts` (взаимный `extends`-тест) и `ObservedRevision<T>` ниже, которая
 * извлекает эту ветку Extract'ом для `checkRevisionTransition` — единственное место, где состав
 * полей реально используется рантаймом этого файла.
 */
export type ObservationStatus<T> =
  | { readonly state: 'never_observed' }
  | {
      readonly state: 'observed';
      readonly value: T;
      readonly effectiveTsUs: TimestampUs;
      /**
       * Точечная семантика (не путать с revision-механикой — см. doc `checkRevisionTransition`):
       * `provisional` — значение этого `effectiveTsUs` МОЖЕТ ещё уточниться; `final` — по контракту
       * v1 не уточнится (final терминален). Это СВОЙСТВО того, что несёт архив, а не пробел
       * реализации: прогнозная funding rate, наблюдавшаяся в минуту T, — окончательная запись факта
       * «в T провайдер показывал X»; смена прогноза в T+1 — НОВОЕ point observation со своим
       * `effectiveTsUs`, а не ревизия T (тот же вывод с другой стороны контракта — `RevisionPolicy`,
       * `event-driven.ts`, задача 3). Настоящего `provisional`-случая в текущих данных поэтому нет
       * вовсе; `final_only` как единственная поддержанная v1-политика — не компромисс, а точное
       * отражение того, что архив физически несёт (одна строка на `(minute_ts, symbol)`).
       */
      readonly finality: 'provisional' | 'final';
      readonly revision: number;
    }
  | {
      readonly state: 'gap';
      /**
       * Первая ожидаемая, но не пришедшая точка — НЕ `sinceUs`. `sinceUs` двусмысленно ровно
       * потому, что у него два одинаково правдоподобных прочтения: «время последнего известного
       * значения» (backward-looking) или «первая пропущенная точка» (forward-looking) — по имени
       * поля нельзя понять, какое из двух имелось в виду, не заглянув в реализацию. `expectedTsUs`
       * называет ровно то, что нужно диспетчеру: frontier, на котором обнаружен пропуск (см.
       * `MarketSubscriptionStatusChangedEvent`, `event-driven.ts`, задача 2 — тот же смысл, то же
       * имя поля, не вторая параллельная форма).
       */
      readonly expectedTsUs: TimestampUs;
      /**
       * Последнее РЕАЛЬНО наблюдённое значение до пропуска — если оно вообще было (самый первый
       * пропуск в жизни подписки его не несёт). Только координата для диагностики «насколько давно
       * был последний сигнал»; carry-forward значения это НЕ делает — noise-free gap остаётся gap.
       */
      readonly lastObservedTsUs?: TimestampUs;
    };

/**
 * Ветка `'observed'` `ObservationStatus<T>`, извлечённая `Extract`'ом — единственная форма, к
 * которой применимо понятие ревизии (`'never_observed'`/`'gap'` его не несут, у обеих нет поля
 * `revision`). Используется как тип `previous`/`next` в `checkRevisionTransition` ниже —
 * переиспользование готовой ветки вместо третьего по счёту независимого набора тех же полей.
 */
export type ObservedRevision<T> = Extract<ObservationStatus<T>, { readonly state: 'observed' }>;

// ─────────────────────────────────────────────────────────────────────────────
// checkRevisionTransition — нормативные переходы revision (требование 2).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Явно объявленная provider policy, разрешающая пропуск номера ревизии (требование 2: «пропуск —
 * fail-closed, либо явно объявленная policy, но не молча»). Дисциплина поля `rationale` — та же,
 * что у `DeclaredDatasetSplice` (`event-driven.ts`, задача 3): булев флаг без обоснования легко
 * оставить включённым по инерции; текстовая причина заставляет вызывающего осознанно назвать
 * повод, а не молча ослабить fail-closed проверку по умолчанию.
 */
export interface DeclaredRevisionSkipPolicy {
  readonly allowed: true;
  readonly rationale: string;
}

/** Параметры `checkRevisionTransition`. Оба поля опциональны — дефолт остаётся fail-closed без
 *  исключений (пропуск номера отвергается, содержимое сравнивается структурно). */
export interface RevisionTransitionOptions<T> {
  readonly skipPolicy?: DeclaredRevisionSkipPolicy;
  /**
   * Сравнение содержимого `value` при совпадающем `revision`. По умолчанию — структурное
   * сравнение через `JSON.stringify` (обе стороны — readonly data-only объекты канонической формы
   * ОДНОГО источника с фиксированным порядком построения полей: `OiPoint`/`LiqPoint`/
   * `FundingReading`/`TakerReading`/`Bar`, не литералы, произвольно набранные разными авторами в
   * разном порядке). Передайте свой компаратор для `T`, где это допущение не держится.
   */
  readonly valueEquals?: (a: T, b: T) => boolean;
}

/**
 * Итог проверки одного перехода. Три исхода, не булево «ок/не ок»: идемпотентный дубль ЗАКОНЕН
 * (требование 2), но отличим от «новая ревизия принята» — вызывающему может быть важно не повторить
 * побочный эффект (например, запись в trace) на дубле, которая уместна только на новой ревизии.
 */
export type RevisionTransitionVerdict =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'rejected'; readonly code: ValidationCode; readonly reason: string };

function rejected(code: ValidationCode, reason: string): RevisionTransitionVerdict {
  return { outcome: 'rejected', code, reason };
}

/** Дефолтный компаратор содержимого — см. doc `RevisionTransitionOptions.valueEquals`. */
function defaultValueEquals<T>(a: T, b: T): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Проверить переход `previous → next` для ОДНОГО ключа `(subscriptionId, effectiveTsUs)`.
 * Ключевание держит ВЫЗЫВАЮЩИЙ (per-key state у резолвера/scheduler'а) — эта функция сравнивает
 * уже отобранную пару и ничего не знает про `subscriptionId`. Нормативные правила (код, не только
 * проза брифа):
 *
 * - `revision` первого наблюдения ключа обязана быть `0` — иное трактуется как пропуск (см. ниже);
 * - `revision` монотонна: `next.revision < previous.revision` — отказ (регресс);
 * - тот же `revision`, то же `value` (по `valueEquals`), та же `finality` — идемпотентный дубль;
 * - тот же `revision`, то же `value`, но `finality` `provisional → final` — легитимная
 *   финализация ТОЙ ЖЕ ревизии (`provisional(n) → final(n)`), не дубль и не отказ;
 * - тот же `revision`, но ДРУГОЕ `value` — fail-closed corruption: два разных содержимых под одним
 *   номером физически означают повреждённый поток, не переиграть детерминированно;
 * - `next.revision === previous.revision + 1` — новая ревизия, принята (`final` следующей ревизии
 *   допустим сразу, без обязательного промежуточного `provisional` на ТОМ ЖЕ номере — легален путь
 *   `provisional(n) → provisional(n+1) → final(n+1)`, но не единственно возможный);
 * - `next.revision > previous.revision + 1` — пропуск номера: отказ, ЕСЛИ вызывающий явно не
 *   передал `skipPolicy` (см. `DeclaredRevisionSkipPolicy`) — тихого прохождения нет;
 * - `previous.finality === 'final'` — ЛЮБОЙ `next` отклоняется: `final` терминален в v1 (см. doc
 *   `finality` у `ObservationStatus`), включая побитово идентичный повтор. Ревизии после `final`
 *   структурно не ожидаются вообще — вызов сюда после final сигнализирует апстрим-аномалию (баг
 *   резолвера либо испорченная доставка), которую нельзя тихо проглотить как «очередной дубль».
 */
export function checkRevisionTransition<T>(
  previous: ObservedRevision<T> | undefined,
  next: ObservedRevision<T>,
  options: RevisionTransitionOptions<T> = {},
): RevisionTransitionVerdict {
  const valueEquals = options.valueEquals ?? defaultValueEquals;

  if (previous === undefined) {
    if (next.revision !== 0) {
      return rejected(
        'observation_revision_skipped',
        `первая ревизия ключа обязана начинаться с 0, получено ${next.revision}`,
      );
    }
    return { outcome: 'accepted' };
  }

  if (previous.finality === 'final') {
    return rejected(
      'observation_revision_finalized',
      `final терминален в v1 — переход после final(${previous.revision}) запрещён`,
    );
  }

  if (next.revision === previous.revision) {
    if (!valueEquals(next.value, previous.value)) {
      return rejected(
        'observation_revision_conflict',
        `ревизия ${next.revision} с другим содержимым при том же номере — fail-closed corruption`,
      );
    }
    if (next.finality === previous.finality) {
      return { outcome: 'duplicate' };
    }
    // previous.finality === 'provisional' (иначе поймано выше), next.finality === 'final':
    // легитимная финализация той же ревизии, не дубль и не отказ.
    return { outcome: 'accepted' };
  }

  if (next.revision < previous.revision) {
    return rejected(
      'observation_revision_regressed',
      `ревизия убывает: ${previous.revision} → ${next.revision}`,
    );
  }

  if (next.revision > previous.revision + 1 && options.skipPolicy?.allowed !== true) {
    return rejected(
      'observation_revision_skipped',
      `ревизия перескочила ${previous.revision} → ${next.revision} без объявленной provider policy`,
    );
  }

  return { outcome: 'accepted' };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseArchiveRow — валидность строки архива (требование 3).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Итог разбора одной строки архива. `present: false` — не ошибка, это законный «нет наблюдения
 * здесь» (см. таблицу у `parseArchiveRow`); `ok: false` — обе противоречивые комбинации, которые
 * схема архива допускает физически, но которые семантически не могут быть правдой одновременно.
 */
export type ArchiveRowVerdict<T> =
  | { readonly ok: true; readonly present: false }
  | { readonly ok: true; readonly present: true; readonly value: T }
  | { readonly ok: false; readonly code: ValidationCode; readonly reason: string };

/**
 * Разбор одной пары `(hasKind, value)` из строки архива — исполняемый гейт, не проза (требование
 * 3). Схема архива допускает обе противоречивые комбинации ФИЗИЧЕСКИ (колонка `has_<kind>` и
 * значение независимы друг от друга как хранение), поэтому «разумная» комбинация не выводится сама
 * собой — гейт нужен явный:
 *
 * | `hasKind` | `value`   | Исход                                                  |
 * |-----------|-----------|---------------------------------------------------------|
 * | `false`   | `null`    | нет наблюдения — вида в этой строке нет (gap)            |
 * | `true`    | `0`       | настоящее наблюдение, значение ноль (ГЛАВНЫЙ кейс задачи)|
 * | `true`    | `≠ null`  | настоящее наблюдение                                     |
 * | `true`    | `null`    | corrupt — покрытие есть, значения нет — fail-closed       |
 * | `false`   | `≠ null`  | corrupt — вида нет, а значение есть — fail-closed         |
 *
 * `has_<kind>` означает «вид ПОКРЫТ», а НЕ «событие было» — установлено замером на прод-дне:
 * `has_liquidations` истинен на всех 1438 минутах суток, а ненулевое значение — лишь на 154;
 * остальные 1284 минуты — настоящие покрытые интервалы БЕЗ ликвидаций (`0`), не пропуски. Функция
 * поэтому не трактует `value === 0` как повод усомниться в `hasKind` — только `null` разводит
 * «наблюдения нет» от «наблюдали и посчитали ноль». Сравнение здесь СТРОГО `=== null`/`!== null`,
 * а не `!value`/`== null` (последнее поймало бы и `0`, и `''`, воспроизведя ровно тот баг, ради
 * недопущения которого функция написана — см. шапку файла).
 */
export function parseArchiveRow<T>(hasKind: boolean, value: T | null): ArchiveRowVerdict<T> {
  if (!hasKind && value === null) {
    return { ok: true, present: false };
  }
  if (hasKind && value !== null) {
    return { ok: true, present: true, value };
  }
  if (hasKind) {
    // hasKind === true, value === null.
    return {
      ok: false,
      code: 'observation_archive_row_corrupt',
      reason: 'has_kind=true, value=null: покрытие заявлено, а значения нет (fail-closed)',
    };
  }
  // hasKind === false, value !== null.
  return {
    ok: false,
    code: 'observation_archive_row_corrupt',
    reason: 'has_kind=false, value≠null: вида нет, а значение присутствует (fail-closed)',
  };
}
