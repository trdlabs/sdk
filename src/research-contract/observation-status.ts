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
//    (`event-driven.ts`, задача 3): какие подписки вообще существуют. Не событие, не поле бара и
//    уж точно не `ObservationStatus` ниже — актор должен узнавать об этом ДО первого события, а не
//    по ходу прогона, каким-то статическим каналом на старте актора. ВАЖНО (I-5 ревью, поправлено
//    после того, как формулировка ошибочно утверждала уже существующий канал): сегодняшний
//    `ActorInit` (`event-driven.ts`) — это РОВНО `{ params, seed, symbol }`, полей подписок или
//    разрешённых binding'ов в нём НЕТ. Состав такого канала эта задача не проектирует и не
//    угадывает — фиксируем только необходимость его существования, не механизм (та же дисциплина,
//    что у `ActorContext`/`ActorWarmupSource`, где будущее устройство не выдаётся за факт).
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
 * `observation-status.test.ts` (ТОЧНАЯ типовая эквивалентность через `IsExactType`, не просто
 * взаимный `extends` — M-2 ревью: обычный взаимный `extends` слеп к дрейфу ОПЦИОНАЛЬНОГО поля) и
 * `ObservedRevision<T>` ниже, которая извлекает эту ветку Extract'ом для `checkRevisionTransition`
 * — единственное место, где состав полей реально используется рантаймом этого файла.
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
   * Сравнение содержимого `value` при совпадающем `revision`. По умолчанию — рекурсивная
   * структурная эквивалентность (`deepValueEquals` ниже), НЕ `JSON.stringify` (первая версия этого
   * файла использовала `JSON.stringify`-сравнение — I-3 ревью нашло, что оно путает `NaN` с
   * `Infinity`, `0` с `-0` и теряет ключи с явным `undefined`-значением; `NaN` в числовой рыночной
   * колонке — самый вероятный вид повреждения потока, и гейт, который путает его с легитимным
   * значением, ничего не гейтит). Передайте свой компаратор для `T`, где нужна другая семантика
   * равенства (например, сравнение с допуском для чисел с плавающей точкой).
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

/**
 * Рекурсивная структурная эквивалентность (I-3 ревью — замена `JSON.stringify`-компаратора).
 * `Object.is` — база сравнения примитивов: `SameValue`, а не `===` — `NaN` равен `NaN` (легитимно:
 * одно и то же повреждённое значение, доставленное дважды, обязано остаться дублем, а не мнимым
 * конфликтом), но `0` и `-0` РАЗЛИЧНЫ (в отличие от `JSON.stringify`, где оба сериализуются в
 * `"0"`) и `NaN`/`Infinity` РАЗЛИЧНЫ (в отличие от `JSON.stringify`, где оба дают `"null"`).
 * Объекты/массивы — рекурсивно, по СОБСТВЕННЫМ перечислимым ключам через `Object.keys` (значит,
 * ключ с явным значением `undefined` УЧАСТВУЕТ в сравнении длины набора ключей — `JSON.stringify`
 * такой ключ тихо роняет, из-за чего `{a:1,b:undefined}` и `{a:1}` ошибочно совпадали).
 */
function deepValueEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;
  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepValueEquals(item, (b as readonly unknown[])[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepValueEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Дефолтный компаратор содержимого — см. doc `RevisionTransitionOptions.valueEquals`. */
function defaultValueEquals<T>(a: T, b: T): boolean {
  return deepValueEquals(a, b);
}

/** `revision` — TS `number`, тип не запрещает `NaN`/дробь/отрицательное на границе недоверенного
 *  источника (в отличие от `TimestampUs`/`DurationUs` из `time-us.ts`, которые валидируют
 *  целостность рантаймом, не только типом). I-1 ревью: без этой проверки `prov(3) → prov(NaN)`
 *  проходил как `accepted` (все сравнения с `NaN` ложны, выполнение проваливалось в финальный
 *  `return`). Дисциплина уже заведена задачей 3 для `lookback`/`interval` (не целые/не
 *  положительные — отказ) — тот же принцип, применённый здесь. */
function isValidRevisionNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * `skipPolicy` действует, только если ОБА условия выполнены: явное `allowed: true` И непустой
 * (после `trim`) `rationale` (M-1 ревью). Пустая или whitespace-only строка молча ослабляла бы
 * гейт — вся аргументация `DeclaredRevisionSkipPolicy` («не булев флаг, а обязательная причина»)
 * держится только на том, что причина реально проверяется, а не просто присутствует как поле.
 */
function skipAllowed(policy: DeclaredRevisionSkipPolicy | undefined): boolean {
  return policy !== undefined && policy.allowed === true && policy.rationale.trim().length > 0;
}

/**
 * Проверить переход `previous → next` для ОДНОГО ключа `(subscriptionId, effectiveTsUs)`.
 * Ключевание держит ВЫЗЫВАЮЩИЙ (per-key state у резолвера/scheduler'а) — `subscriptionId` этой
 * функции недоступен, но `effectiveTsUs` несут ОБА аргумента, и функция его сверяет (I-4 ревью,
 * см. ниже). Нормативные правила (код, не только проза брифа), в порядке проверки:
 *
 * 1. **Валидность формата.** `revision` обеих сторон обязана быть целым неотрицательным числом
 *    (`observation_revision_invalid` иначе — I-1 ревью: `NaN`/дробь/отрицательное иначе проходили
 *    fail-open).
 * 2. **Сверка ключа.** Если `previous` задан, его `effectiveTsUs` обязан совпасть с
 *    `next.effectiveTsUs` (`observation_revision_key_mismatch` иначе — I-4 ревью): ключ ревизии —
 *    `(subscriptionId, effectiveTsUs)`, и баг кеевания резолвера (две разные минуты под одним
 *    number-ключом карты) иначе проходил бы как идемпотентный дубль.
 * 3. **Старт с нуля.** Первое наблюдение ключа (`previous === undefined`) обязано нести
 *    `revision === 0` — ИЛИ явно объявленную `skipPolicy` (I-6 ревью: доке всегда обещала это
 *    исключение, реализация раньше его не давала — провайдер, нумерующий с 1, не спасался
 *    задекларированной policy). Код при отказе — `observation_revision_start_invalid`, ОТДЕЛЬНЫЙ
 *    от кода пропуска посреди потока (M-7 ревью): потребитель, различающий по коду, обязан суметь
 *    отличить «не начали с 0» от «перескочили номер в середине».
 * 4. **Тот же `revision`.** Сначала содержимое, НЕЗАВИСИМО от `finality` обеих сторон (включая
 *    `previous.finality === 'final'` — идемпотентный дубль побеждает терминальность, решение
 *    владельца после первого раунда ревью): другое `value` — ВСЕГДА `observation_revision_conflict`
 *    (в том числе после `final`); то же `value` разбирается по паре `finality`:
 *    - обе стороны совпадают — идемпотентный дубль (доставка «хотя бы один раз» штатно приносит
 *      одну и ту же запись дважды; ронять прогон на этом — ложноположительное срабатывание гейта,
 *      которое хуже его отсутствия — оно приучает гейт выключать);
 *    - `provisional → final` — ЕДИНСТВЕННЫЙ смысловой переход при неизменном содержимом
 *      (объявление окончательности) — `accepted`;
 *    - `final → provisional` — **уточнение M-3** (владелец сузил первоначальное «дубль независимо
 *      от finality» после того, как оно накрыло и эту ветку): терминальность ловит появление НОВОЙ
 *      информации после объявления окончательной, а снятие окончательности — ровно новая
 *      информация, не повторная доставка. Отдельный код `observation_finality_demoted` — НЕ
 *      `observation_revision_conflict` (содержимое совпало) и НЕ `observation_revision_finalized`
 *      (тот код — про смену `revision`, эта ветка про смену `finality` на том же `revision`).
 * 5. **Терминальность.** `previous.finality !== 'provisional'` (БЕЛЫЙ список — I-2 ревью, было
 *    `=== 'final'`: расширение `finality` третьим значением молча проваливалось бы в `accepted`
 *    ниже; форма `!== 'provisional'` fail-closed по умолчанию для чего угодно, кроме явно
 *    известного безопасного состояния — та же дисциплина, что `validate-module.ts:118/132/146`) И
 *    `next.revision !== previous.revision` (сюда попадаем, только если пункт 4 не сработал, то
 *    есть `revision` РАЗНЫЙ) — отказ `observation_revision_finalized`: новая информация («другой
 *    revision») не может явиться после того, как значение объявлено окончательным.
 * 6. **Монотонность.** `next.revision < previous.revision` при `previous.finality === 'provisional'`
 *    — отказ `observation_revision_regressed`.
 * 7. **Новая ревизия.** `next.revision === previous.revision + 1` — принята (`final` следующей
 *    ревизии допустим сразу, без обязательного промежуточного `provisional` на ТОМ ЖЕ номере —
 *    легален путь `provisional(n) → provisional(n+1) → final(n+1)`, но не единственно возможный).
 * 8. **Пропуск номера.** `next.revision > previous.revision + 1` — отказ `observation_revision_skipped`,
 *    ЕСЛИ вызывающий явно не передал `skipPolicy` (см. `DeclaredRevisionSkipPolicy`) — тихого
 *    прохождения нет.
 */
export function checkRevisionTransition<T>(
  previous: ObservedRevision<T> | undefined,
  next: ObservedRevision<T>,
  options: RevisionTransitionOptions<T> = {},
): RevisionTransitionVerdict {
  const valueEquals = options.valueEquals ?? defaultValueEquals;

  if (
    !isValidRevisionNumber(next.revision) ||
    (previous !== undefined && !isValidRevisionNumber(previous.revision))
  ) {
    return rejected(
      'observation_revision_invalid',
      `revision обязана быть целым неотрицательным числом: previous=${previous?.revision}, next=${next.revision}`,
    );
  }

  if (previous !== undefined && previous.effectiveTsUs !== next.effectiveTsUs) {
    return rejected(
      'observation_revision_key_mismatch',
      `previous.effectiveTsUs=${previous.effectiveTsUs} !== next.effectiveTsUs=${next.effectiveTsUs} — ` +
        'разные ключи (subscriptionId, effectiveTsUs) сравниваются как один',
    );
  }

  if (previous === undefined) {
    if (next.revision !== 0 && !skipAllowed(options.skipPolicy)) {
      return rejected(
        'observation_revision_start_invalid',
        `первая ревизия ключа обязана начинаться с 0 (или пропуск явно объявлен provider policy), получено ${next.revision}`,
      );
    }
    return { outcome: 'accepted' };
  }

  // Тот же revision — сначала содержимое, НЕЗАВИСИМО от finality (включая previous.finality
  // === 'final'): идемпотентный дубль обязан пройти даже после final, а конфликт содержимого
  // обязан отказать даже после final — терминальность здесь ни при чём в обоих случаях.
  if (next.revision === previous.revision) {
    if (!valueEquals(next.value, previous.value)) {
      return rejected(
        'observation_revision_conflict',
        `ревизия ${next.revision} с другим содержимым при том же номере — fail-closed corruption`,
      );
    }
    if (previous.finality === next.finality) {
      return { outcome: 'duplicate' };
    }
    if (previous.finality === 'provisional' && next.finality === 'final') {
      // Единственный СМЫСЛОВОЙ переход при неизменном содержимом: объявление окончательности.
      return { outcome: 'accepted' };
    }
    // Единственная оставшаяся комбинация при двух значениях finality: previous:'final',
    // next:'provisional' — снятие окончательности при том же revision и том же содержимом. Это
    // НОВАЯ информация (обратное направление), а не повторная доставка (M-3 уточнение).
    return rejected(
      'observation_finality_demoted',
      `finality снята с final на provisional при том же revision ${next.revision} и том же содержимом`,
    );
  }

  // С этой точки next.revision !== previous.revision — терминальность final срабатывает именно
  // здесь и ровно за то, для чего существует: новая информация («другой revision») не может
  // явиться после того, как значение объявлено окончательным. Белый список (I-2): проверяем
  // ИЗВЕСТНОЕ безопасное состояние, а не конкретное известное опасное.
  if (previous.finality !== 'provisional') {
    return rejected(
      'observation_revision_finalized',
      `final терминален в v1 — после final(${previous.revision}) не может прийти revision ${next.revision}`,
    );
  }

  if (next.revision < previous.revision) {
    return rejected(
      'observation_revision_regressed',
      `ревизия убывает: ${previous.revision} → ${next.revision}`,
    );
  }

  if (next.revision > previous.revision + 1 && !skipAllowed(options.skipPolicy)) {
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
 * | `hasKind` | `value`            | Исход                                                     |
 * |-----------|--------------------|-------------------------------------------------------------|
 * | `false`   | `null`/`undefined` | нет наблюдения — вида в этой строке нет (gap)              |
 * | `true`    | `0`                | настоящее наблюдение, значение ноль (ГЛАВНЫЙ кейс задачи)  |
 * | `true`    | иное не-отсутствие | настоящее наблюдение                                       |
 * | `true`    | `null`/`undefined` | corrupt — покрытие есть, значения нет — fail-closed        |
 * | `false`   | не-отсутствие      | corrupt — вида нет, а значение есть — fail-closed          |
 *
 * `has_<kind>` означает «вид ПОКРЫТ», а НЕ «событие было» — установлено замером на прод-дне:
 * `has_liquidations` истинен на всех 1438 минутах суток, а ненулевое значение — лишь на 154;
 * остальные 1284 минуты — настоящие покрытые интервалы БЕЗ ликвидаций (`0`), не пропуски. Функция
 * поэтому не трактует `value === 0` как повод усомниться в `hasKind` — только «отсутствие»
 * разводит «наблюдения нет» от «наблюдали и посчитали ноль».
 *
 * **`value` принимает `T | null | undefined`, не только `T | null` (C-1 ревью — критический
 * дефект первой версии).** Эта функция — ЕДИНСТВЕННЫЙ гейт для НЕДОВЕРЕННОГО источника: хост читает
 * Parquet/JSON через `any`-типизированную читалку, где пропущенная колонка даёт `undefined`, а не
 * `null`. TS-сигнатура `T | null` ничего не гарантирует РАНТАЙМУ вызывающего — гейт, полагающийся
 * на типы вызывающего, гейтом не является: `parseArchiveRow(true, undefined)` в первой версии
 * (сравнение `=== null`) проходил как `{ok:true, present:true, value:undefined}` — «данных не было»
 * объявлялось «настоящим наблюдением», ровно та ошибка, против которой написан весь файл, только
 * со стороны JS-платформы, а не со стороны провайдера.
 *
 * Сравнение — `== null`/`!= null` (loose), НЕ `=== null`/`!== null`, как было в первой версии.
 * **Обоснование первой версии было ошибочным** (сама эта функция проверена в узле:
 * `0 == null` → `false`, `'' == null` → `false`) — `== null` НЕ путает `0`/`''` с отсутствием
 * значения; это делает falsy-проверка `!value` (которая ловит и `0`, и `''`, и `NaN`, и `false`),
 * с ней `== null` спутывать нельзя. Правильная причина выбрать `== null`: это ЕДИНСТВЕННЫЙ простой
 * оператор JS, ловящий РОВНО ОБЕ формы отсутствия (`null` архивного NULL и `undefined` пропущенного
 * JS-поля) ОДНИМ сравнением, не задевая `0`.
 */
export function parseArchiveRow<T>(hasKind: boolean, value: T | null | undefined): ArchiveRowVerdict<T> {
  if (!hasKind && value == null) {
    return { ok: true, present: false };
  }
  if (hasKind && value != null) {
    return { ok: true, present: true, value };
  }
  if (hasKind) {
    // hasKind === true, value == null (null либо undefined).
    return {
      ok: false,
      code: 'observation_archive_row_corrupt',
      reason: 'has_kind=true, value отсутствует (null/undefined): покрытие заявлено, а значения нет (fail-closed)',
    };
  }
  // hasKind === false, value != null (значение присутствует).
  return {
    ok: false,
    code: 'observation_archive_row_corrupt',
    reason: 'has_kind=false, value присутствует: вида нет, а значение есть (fail-closed)',
  };
}
