// 083 S1 — задача 5: execution ledger, вывод `PositionView` из него.
//
// Спека: control-center `docs/superpowers/specs/2026-08-04-event-driven-actor-contract-design.md`
// (см. `.superpowers/sdd/2026-08-06-s1-actor-contract/task-5-brief.md`).
//
// Модуль — СОСЕД `event-driven.ts` (где живёт `ActorContext`/`PositionView`/`OpenOrderView`/
// `ActorStateValue`/`isPlainActorState`), не его часть. Зависимость — только В ОДНУ СТОРОНУ: этот
// файл импортирует `OrderSide`/`PositionView` ОТТУДА (типы), обратного импорта нет — та же
// дисциплина, что у `observation-status.ts` (см. шапку того файла): `event-driven.ts` НЕ
// импортирует ничего отсюда. Ревью раунда 1 (I-3) первоначально просило завести канал для
// авторского state-слота на `StrategyActor`/`ActorInit` — оба живут в `event-driven.ts`, поэтому
// `ActorStateValue`/`isPlainActorState` ПЕРЕЕХАЛИ туда же (были здесь в первой версии этого файла):
// оставлять их тут и заводить обратный импорт `event-driven.ts ⇐ actor-state.ts` замкнуло бы
// кольцо зависимостей поверх уже существующего `actor-state.ts ⇒ event-driven.ts`.
//
// ─────────────────────────────────────────────────────────────────────────────
// Что это НЕ. «Только формы и определения. Никакой реализации» (Global Constraint брифа задачи).
// ─────────────────────────────────────────────────────────────────────────────
//
// `derivePositionView` ниже — ЧИСТАЯ функция над ГОТОВЫМ ledger'ом: она не хранит состояние
// между вызовами, не читает файлы/сеть/часы, не решает, КОГДА и КАК филл попадает в ledger — она
// лишь ОПРЕДЕЛЯЕТ каноническую проекцию «ledger → текущая позиция», симметрично тому, как
// `checkRevisionTransition` (`observation-status.ts`, задача 4) — ЧИСТАЯ функция над парой
// значений, а не движок, ведущий поток ревизий. Движок, который АППЕНДИТ филлы в ledger по мере
// поступления событий, персистит его через чекпойнт изолята и вызывает эту проекцию на каждый
// `ctx.position()` — задача `@trdlabs/engine`, S2. Разница ровно та же, что между «функция сложения
// определена» и «калькулятор с этой функцией собран, подключён к сети и работает 24/7».
// Проверка ВХОДА (`isExecutionLedgerEntry` ниже, ревью раунда 1, I-5) в это разделение НЕ
// противоречит: «форма, не реализация» — про то, ЧТО функция делает с данными (не ведёт учёт сама),
// а не про то, доверяет ли она форме данных, которые ей передали через недоверенную JSON-границу.

import { isTimestampUs, type TimestampUs } from './time-us.js';
import type { OrderSide, PositionView } from './event-driven.js';

// ─────────────────────────────────────────────────────────────────────────────
// ЗАПРЕТ: контракт не заводит поля вида `tp1Done`/`tp2Done`/`breakEvenArmed` (требование 5).
// ─────────────────────────────────────────────────────────────────────────────
//
// Это НОРМАТИВНЫЙ запрет для любого БУДУЩЕГО расширения этого модуля, а не наблюдение о текущей
// форме. Причина записана как урок реального дефекта (см. doc задачи 5 в брифе): фича изменила
// поведение так, что тейк-профит стал ЧАСТИЧНЫМ выходом, но бухгалтерию не расширили —
// незажурналированный частичный выход не дренировал остаток количества, инвариант нарушился, бот
// встал. Флаг вида `tp1Done: boolean` фиксирует ОДИН заранее угаданный уровень частичного выхода;
// уровней в реальности может быть сколько угодно (`tp1`, `tp2`, …, `tpN`, безусловный частичный
// выход по любой другой причине) — ЛЮБОЙ фиксированный набор булевых полей воспроизводит РОВНО ТОТ
// ЖЕ класс ошибки под новым именем: набор изменился, а бухгалтерия, написанная под старый набор,
// снова не знает о новом случае. Единственная форма, которая закрывает этот класс СТРУКТУРНО —
// `ExecutionLedger` ниже: у него нет фиксированного количества «мест для флагов», куда что-то
// можно забыть дописать, — каждый частичный выход ПРОСТО ЕЩЁ ОДНА запись `fill` в уже открытом
// массиве, и остаток позиции ВСЕГДА пересчитывается заново по ВСЕМ записям, а не читается из
// отдельного числа, которое кто-то мог не обновить.

// ─────────────────────────────────────────────────────────────────────────────
// ExecutionLedger — fill-derived журнал (требование 4, центральная часть задачи).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Одна запись исполнения — постоянная, дозаписываемая форма события `fill` (`event-driven.ts`).
 * В отличие от `ActorFillEvent`, запись ledger'а несёт `side` ЯВНО (денормализовано из заявки,
 * которую филл исполняет, см. doc `ActorFillEvent` про намеренное отсутствие `side` там) — ledger
 * обязан быть САМОДОСТАТОЧНЫМ: производные (`derivePositionView` ниже) читают ТОЛЬКО его, не
 * обращаясь за стороной заявки в какое-то другое хранилище, которое могло уже забыть заявку.
 *
 * `qty` — ВСЕГДА положительный размер исполнения в базовой валюте; знак движения позиции несёт
 * `side`, не `qty` (симметрично `ActorFillEvent.qty`). ТИП это не запрещает (`{qty:-3}`
 * типизируется — ревью раунда 1, M-4) — `isExecutionLedgerFillEntry` ниже проверяет это рантаймом,
 * та же дисциплина, что `isValidRevisionNumber` в `observation-status.ts`.
 *
 * `fee` — комиссия ЭТОГО исполнения, В ВАЛЮТЕ КОТИРОВКИ инструмента (той же, что `qtyUsd`
 * `ActorPlaceCommand` — НЕ в базовой валюте, которой измеряется `qty`; ревью раунда 1, M-3: файл в
 * остальном одержим единицами, у этого поля единица была неявной). Требование 4: «комиссии»
 * фиксируются здесь, не отдельной сущностью — комиссия существует только КАК СВОЙСТВО конкретного
 * филла, у неё нет самостоятельного бытия без него.
 */
export interface ExecutionLedgerFillEntry {
  readonly kind: 'fill';
  readonly ts: TimestampUs;
  readonly clientOrderId: string;
  readonly side: OrderSide;
  readonly price: number;
  readonly qty: number;
  readonly fee: number;
  /** Последний филл СВОЕЙ заявки (заявка перешла в терминальный `filled`) — см. `ActorFillEvent.last`. */
  readonly last: boolean;
}

/**
 * Funding-расчёт (требование 4: «funding-settlement'ы» — отдельный вид записи, а не переиспользование
 * `fill`: funding — не исполнение заявки, у него нет ни `clientOrderId`, ни стороны сделки, только
 * знаковый денежный поток на открытую позицию). Форма МИНИМАЛЬНА нарочно (задача 5 — словарь, не
 * реализация: settlement в v1 архива не резолвится вовсе, см. doc `FundingMarketDataRequirement`,
 * `event-driven.ts`, задача 3) — запись существует, чтобы будущий резолв не требовал ломающего
 * расширения формы ledger'а.
 */
export interface ExecutionLedgerFundingSettlementEntry {
  readonly kind: 'funding_settlement';
  readonly ts: TimestampUs;
  /**
   * Знаковый денежный поток В ВАЛЮТЕ КОТИРОВКИ инструмента (та же единица, что `fee` выше и
   * `qtyUsd` `ActorPlaceCommand` — ревью раунда 1, M-3): получено (`> 0`) либо уплачено (`< 0`).
   */
  readonly amount: number;
}

/** Замкнутый union записей execution ledger'а. */
export type ExecutionLedgerEntry = ExecutionLedgerFillEntry | ExecutionLedgerFundingSettlementEntry;

/**
 * Execution ledger целиком — упорядоченный (по времени записи, `ts` НЕ убывает — см.
 * `derivePositionView`, ревью раунда 1, I-6) журнал, ОДИН на актора. Флип позиции через ноль
 * (требование 4) — НЕ отдельный вид записи: это факт, ВЫВОДИМЫЙ из последовательности
 * `fill`-записей самим `derivePositionView` (сделка противоположной стороны крупнее текущего
 * остатка), а не что-то, что вызывающий обязан распознать и записать отдельно — заводить для флипа
 * свой `kind` значило бы дублировать информацию, которую сама последовательность `fill`-ов уже
 * несёт, и создавать возможность рассинхронизации («флип был, а запись о нём — нет»), то есть ровно
 * ту дыру, ради закрытия которой существует этот файл.
 */
export type ExecutionLedger = readonly ExecutionLedgerEntry[];

// ─────────────────────────────────────────────────────────────────────────────
// Рантайм-валидация ledger'а (ревью раунда 1, I-5): вход из-за JSON-границы чекпойнта.
// ─────────────────────────────────────────────────────────────────────────────
//
// Правило №7 операционных правил задачи: «гейт, полагающийся на типы вызывающего, гейтом не
// является». Ledger персистится через чекпойнт изолята (см. doc `ActorStateValue`, `event-driven.
// ts`) — то есть на входе `derivePositionView` он приходит из JSON, распарсенного вызывающим кодом
// с типом `any`/`unknown`, а не из доверенного TS-конструктора. Прогон ревью подтвердил: `side`
// строкой `"BUY"`, `price` строкой `"100"`, `qty:-5, price:NaN` — всё это раньше проходило БЕЗ
// проверки и давало испорченный `PositionView` (`side` неизвестное значение молча трактовалось как
// `'sell'`, потому что `entry.side === 'buy'` ложно для чего угодно, кроме точной строки `'buy'`).

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Белый список (rule: валидаторы — белым списком, не чёрным): РОВНО два разрешённых значения. */
function isOrderSide(value: unknown): value is OrderSide {
  return value === 'buy' || value === 'sell';
}

function isExecutionLedgerFillEntry(value: unknown): value is ExecutionLedgerFillEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === 'fill' &&
    isTimestampUs(v.ts) &&
    typeof v.clientOrderId === 'string' &&
    isOrderSide(v.side) &&
    isFiniteNumber(v.price) &&
    isFiniteNumber(v.qty) &&
    v.qty > 0 && // M-4: `qty` «всегда положителен» — доковый инвариант, проверенный рантаймом.
    isFiniteNumber(v.fee) &&
    typeof v.last === 'boolean'
  );
}

function isExecutionLedgerFundingSettlementEntry(
  value: unknown,
): value is ExecutionLedgerFundingSettlementEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'funding_settlement' && isTimestampUs(v.ts) && isFiniteNumber(v.amount);
}

/**
 * Рантайм-проверка ОДНОЙ записи ledger'а (требование I-5 ревью раунда 1) — та же дисциплина, что
 * `isPlainActorState` (`event-driven.ts`): недоверенное значение проверяется целиком, полю за
 * полем, белым списком по `kind`/`side`, а не молча приводится типом вызывающего.
 *
 * OR-цепочка двух ПО-ОТДЕЛЬНОСТИ проверенных предикатов (не `switch`, у него здесь нет
 * дискриминанта — `value` НЕ типа `ExecutionLedgerEntry`, а `unknown`, и переключаться в `switch`
 * буквально не на чем без предварительного сужения). Полноту вместо этого гарантирует ТИПОВАЯ
 * проверка ниже (Minor, ревью раунда 2): мутационная проба, добавляющая ТРЕТИЙ вариант в
 * `ExecutionLedgerEntry` без обновления этой функции, иначе заставила бы предикат МОЛЧА ВРАТЬ —
 * отклонять структурно валидные (по обновлённому типу) записи, потому что для их `kind` нет
 * проверяющей ветки. `_AssertExecutionLedgerEntryKindsCovered` красит СБОРКУ в этом случае, той же
 * идиомой, что `AssertNoUncoveredKind`/`ACTOR_INPUT_EVENT_KINDS`, `event-driven.ts` (I-1 задачи S1).
 */
export function isExecutionLedgerEntry(value: unknown): value is ExecutionLedgerEntry {
  return isExecutionLedgerFillEntry(value) || isExecutionLedgerFundingSettlementEntry(value);
}

/** Генерик-ограничение (не рантайм-значение) — локальная копия идиомы `AssertNoUncoveredKind`
 *  (`event-driven.ts`): компилируется, только если `T` действительно `never`. Не импортирована
 *  оттуда, чтобы не заводить обратный импорт `actor-state.ts ⇐ event-driven.ts` (см. doc в шапке
 *  файла про уже существующую одностороннюю зависимость) ради двухстрочной типовой утилиты. */
type AssertNoUncoveredEntryKind<T extends never> = T;

/**
 * Проверенные в `isExecutionLedgerEntry` виды — ровно ДВА, перечислены здесь ЯВНО (не выведены из
 * рантайм-массива: рантайм-массив ради ЧИСТО типовой проверки завёл бы лишнее рантайм-ребро в
 * публикуемом пакете, тот же принцип, что `_AssertMarketDataKindCoveredByUnion`, `event-driven.ts`,
 * задача 3, раунд правок 2, м-3). Если `ExecutionLedgerEntry` получит третий вариант, а эту строку
 * не обновят, `Exclude<...>` перестанет быть `never`, и сборка ломается здесь же (TS2344).
 */
type _AssertExecutionLedgerEntryKindsCovered = AssertNoUncoveredEntryKind<
  Exclude<ExecutionLedgerEntry['kind'], 'fill' | 'funding_settlement'>
>;

/** Рантайм-проверка ВСЕГО ledger'а — массив, каждый элемент которого проходит `isExecutionLedgerEntry`. */
export function isExecutionLedger(value: unknown): value is ExecutionLedger {
  return Array.isArray(value) && value.every(isExecutionLedgerEntry);
}

// ─────────────────────────────────────────────────────────────────────────────
// derivePositionView — каноническая проекция ledger → PositionView (требования 3, 4).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Относительный допуск для сравнения количества с нулём (ревью раунда 2, C-1, Critical —
 * ВОСПРОИЗВЕДЕНО ПОВТОРНО против собранного пакета после первой правки). Первая версия
 * (`POSITION_QTY_EPSILON = 1e-9` АБСОЛЮТНЫЙ) чинила дробные лестницы, но `qty` измеряется в
 * базовой валюте, чей масштаб гуляет на много порядков между инструментами — `ulp(x)` уже
 * превышает `1e-9` при `x ≈ 4.5e6` (мемкоин-перп позиции в 1e8–1e9 базовых единиц — обычное
 * дело), и АБСОЛЮТНЫЙ порог на таком масштабе снова даёт фиктивный флип: прогон ревью, лестница
 * `987654321.7` двадцатью равными траншами, остаток `-2.24e-7` — больше `1e-9`, флип не пойман.
 * Больший константный порог не решает задачу — только сдвигает точку перехода на другой масштаб.
 *
 * Решение — допуск ОТНОСИТЕЛЬНЫЙ к пиковому `|qty|` ВНУТРИ ТЕКУЩЕЙ ЭРЫ (не всего ledger'а: разные
 * эры — разные позиции, разные уместные масштабы шума), см. `isNegligibleQty` и `FoldState.
 * peakAbsQty` ниже. Величина — `1e-9` относительно масштаба, а не абсолютная: для масштаба `≥1`
 * это `≥1e-9 × qty`, безопасный запас над накопленной IEEE754-ошибкой (одна операция даёт
 * относительную ошибку порядка `Number.EPSILON ≈ 2.22e-16`; ошибка на ~20 операциях остаётся на
 * много порядков ниже `1e-9`, что и подтверждает прогон ревью — относительная ошибка лестницы
 * `987654321.7`/20 составляет `~3.7e-16`, то есть порядка ОДНОГО `Number.EPSILON`, не более).
 * `Math.max(scale, 1)` — ПОЛ: при масштабе меньше `1` допуск не сжимается ниже абсолютного `1e-9`
 * — тот же порядок, что был константой раунда 1, и та же причина (запас на IEEE754-шум, на ОДИН
 * порядок меньше минимального шага размера ордера реальных venue, satoshi-класс `1e-8` BTC — не
 * на два: `1e-8 / 1e-9 = 10`, предыдущая версия доки здесь ошиблась в арифметике).
 */
export const POSITION_QTY_RELATIVE_EPSILON = 1e-9;

/**
 * «Пренебрежимо мало» — величина неотличима от нуля ОТНОСИТЕЛЬНО масштаба `scale` (пиковый `|qty|`
 * текущей эры, floor `1`). Единственная функция сравнения количества с нулём во всём модуле —
 * применяется СИММЕТРИЧНО и к ЗАКРЫТИЮ (остаток после выхода), и к ОТКРЫТИЮ (сам исполненный
 * размер относительно себя же, `scale = |fillSigned|`), и к финальному чтению `derivePositionView`
 * (ревью раунда 2, C-1, второе следствие): прежняя версия сравнивала «flat» ДВУМЯ разными
 * предикатами — `foldFill` эпсилоном, финальная проверка точным `state.qtySigned === 0` — из-за
 * чего суб-эпсилонное ОТКРЫТИЕ (`buy 1e-10` с чистого места) не схлопывалось вовсе (просто
 * присваивало `qtySigned` без всякой проверки), а суб-эпсилонный ВЫХОД схлопывался: одна и та же
 * по масштабу величина трактовалась по-разному в зависимости от направления. Теперь один порог,
 * одна функция, каждое место сравнения.
 */
function isNegligibleQty(value: number, scale: number): boolean {
  return Math.abs(value) <= POSITION_QTY_RELATIVE_EPSILON * Math.max(scale, 1);
}

/**
 * Промежуточное состояние свёртки: `qtySigned` — остаток со знаком (`> 0` long, `< 0` short,
 * `=== 0` flat — РОВНО ноль: `foldFill` ниже СНИМАЕТ float-шум через `isNegligibleQty` до того,
 * как записать его в `qtySigned`, поэтому здесь `=== 0` уже безопасно), `avgPrice`/`openedAtUs` —
 * характеристики ТЕКУЩЕЙ эры (не определены, пока `qtySigned === 0`). `peakAbsQty` — пиковый
 * `|qtySigned|`, достигнутый С НАЧАЛА ТЕКУЩЕЙ ЭРЫ (сбрасывается на каждом новом открытии/флипе) —
 * масштаб для `isNegligibleQty` (C-1, ревью раунда 2).
 */
interface FoldState {
  readonly qtySigned: number;
  readonly avgPrice: number;
  readonly openedAtUs: TimestampUs | undefined;
  readonly peakAbsQty: number;
}

const FLAT_STATE: FoldState = { qtySigned: 0, avgPrice: 0, openedAtUs: undefined, peakAbsQty: 0 };

function signedQtyOf(entry: ExecutionLedgerFillEntry): number {
  return entry.side === 'buy' ? entry.qty : -entry.qty;
}

function sameSign(a: number, b: number): boolean {
  return (a > 0 && b > 0) || (a < 0 && b < 0);
}

/**
 * Свернуть ОДИН `fill` в текущее состояние эры. Три ветки, зеркалящие реальный жизненный цикл
 * позиции — не одна формула на все случаи, потому что «добавление» и «выход» обновляют РАЗНЫЕ
 * поля (добавление меняет `avgPrice`, выход его СОХРАНЯЕТ), а флип обнуляет оба разом:
 *
 * 1. Старт с flat (`qtySigned === 0`) — потенциально новая эра. `isNegligibleQty` ПРИМЕНЯЕТСЯ И
 *    ЗДЕСЬ (C-1, ревью раунда 2, симметрия открытия/закрытия, см. `isNegligibleQty`): если сам
 *    `fillSigned` неотличим от нуля относительно себя же (масштаб — его собственная величина,
 *    поэтому реальный срабатывает только АБСОЛЮТНЫЙ пол — см. doc), это шум, а не открытие — эра
 *    не начинается. Иначе `avgPrice`/`openedAtUs`/`peakAbsQty` берутся с этого филла.
 * 2. Тот же знак, что текущий остаток (добавление в ТУ ЖЕ сторону) — средневзвешенная цена
 *    пересчитывается по ОБЪЁМУ (не по количеству филлов), `openedAtUs` НЕ меняется — эра та же;
 *    `peakAbsQty` обновляется на новый (больший) остаток.
 * 3. Противоположный знак (выход, полный либо частичный). `isNegligibleQty` ПЕРВЫМ (C-1 — порядок
 *    проверок важен: точный `remainingSigned === 0` почти никогда не выполняется побитово на
 *    накопленной арифметике, а знак шума случаен, из-за чего проверка знака ДО проверки «около
 *    нуля» иногда давала ФИКТИВНЫЙ флип): около нуля относительно `peakAbsQty` ЭТОЙ эры — эра
 *    закончилась, состояние СНИМАЕТСЯ до `FLAT_STATE` целиком (не только `qtySigned`: `peakAbsQty`
 *    тоже обязан обнулиться — иначе следующее ОТКРЫТИЕ унаследовало бы чужой масштаб эры и
 *    измеряло бы себя относительно позиции, которой уже нет). Иначе — знак остатка совпадает со
 *    знаком ДО: выход из ТОЙ ЖЕ эры, `avgPrice`/`openedAtUs` держатся, `peakAbsQty` НЕ уменьшается
 *    (выход не может увеличить пик, а уменьшать пик задним числом значило бы менять масштаб
 *    сравнения для уже случившихся шагов). Иначе — знак ПЕРЕВЁРНУТ: ФЛИП через ноль, часть филла,
 *    превышающая прежний остаток, открывает НОВУЮ эру ПО ЦЕНЕ и ВРЕМЕНИ ЭТОГО ЖЕ филла (требование
 *    брифа «openedAt от НОВОГО открытия»), `peakAbsQty` НОВОЙ эры — размер НОВОЙ позиции
 *    (`|remainingSigned|`), не исходный филл целиком (тот включал закрытую часть).
 */
function foldFill(state: FoldState, entry: ExecutionLedgerFillEntry): FoldState {
  const fillSigned = signedQtyOf(entry);

  if (state.qtySigned === 0) {
    if (isNegligibleQty(fillSigned, Math.abs(fillSigned))) {
      return FLAT_STATE;
    }
    return { qtySigned: fillSigned, avgPrice: entry.price, openedAtUs: entry.ts, peakAbsQty: Math.abs(fillSigned) };
  }

  if (sameSign(state.qtySigned, fillSigned)) {
    const priorAbs = Math.abs(state.qtySigned);
    const addedAbs = Math.abs(fillSigned);
    const totalAbs = priorAbs + addedAbs;
    const avgPrice = (state.avgPrice * priorAbs + entry.price * addedAbs) / totalAbs;
    return {
      qtySigned: state.qtySigned + fillSigned,
      avgPrice,
      openedAtUs: state.openedAtUs,
      peakAbsQty: Math.max(state.peakAbsQty, totalAbs),
    };
  }

  // Противоположный знак — остаток может уменьшиться (частичный выход), обнулиться (полный выход,
  // с float-шумом вместо точного нуля на накопленной арифметике — C-1) либо переменить знак (флип).
  const remainingSigned = state.qtySigned + fillSigned;
  if (isNegligibleQty(remainingSigned, state.peakAbsQty)) {
    // Полный выход. Весь FoldState — flat, включая peakAbsQty: следующая эра меряет себя СВОИМ
    // масштабом, не масштабом эры, которой больше нет.
    return FLAT_STATE;
  }
  if (sameSign(remainingSigned, state.qtySigned)) {
    // Частичный выход БЕЗ флипа — эра та же: avgPrice/openedAt/peakAbsQty держатся.
    return { qtySigned: remainingSigned, avgPrice: state.avgPrice, openedAtUs: state.openedAtUs, peakAbsQty: state.peakAbsQty };
  }
  // Флип: новая эра с этого самого филла — пик новой эры измеряется НОВЫМ остатком, не филлом целиком.
  return {
    qtySigned: remainingSigned,
    avgPrice: entry.price,
    openedAtUs: entry.ts,
    peakAbsQty: Math.abs(remainingSigned),
  };
}

/**
 * Свернуть ОДНУ запись ledger'а (не только `fill`) — исчерпывающий `switch`, а не `if (kind !==
 * 'fill') continue` (ревью раунда 1, I-1, Important: мутационная проба добавила гипотетический
 * вид записи `liquidation` с полем, меняющим размер позиции, — `if`-фильтр молча его игнорировал,
 * `tsc --strict` был чист. `switch` + `assertNever` делает то же самое НЕВОЗМОЖНЫМ: забытый case
 * для нового варианта `ExecutionLedgerEntry` красит сборку здесь же, идиома уже есть в файле у
 * `defineActor`, `event-driven.ts`).
 */
function foldEntry(state: FoldState, entry: ExecutionLedgerEntry): FoldState {
  switch (entry.kind) {
    case 'fill':
      return foldFill(state, entry);
    case 'funding_settlement':
      // Funding меняет P&L, а не размер/сторону позиции — `qty`/`side`/`openedAt`/`avgEntryPrice`
      // от него СТРУКТУРНО не зависят, поэтому состояние эры не меняется.
      return state;
    default: {
      const exhaustive: never = entry;
      throw new Error(
        `derivePositionView: неизвестный вид записи ledger'а "${String((exhaustive as { kind?: unknown }).kind)}"`,
      );
    }
  }
}

/**
 * Каноническая ЧИСТАЯ проекция «execution ledger → текущая позиция» (требования 3, 4). Свёртка ПО
 * ВСЕЙ истории заново на каждый вызов — не инкрементальный движок с собственным хранимым
 * состоянием: та же дисциплина, что у `checkRevisionTransition` (задача 4), где вызывающий держит
 * `previous`/`next` сам, а функция лишь СРАВНИВАЕТ. Здесь вызывающий держит ledger целиком, а
 * функция лишь ПРОЕЦИРУЕТ его в снимок — реализация того, КАК/КОГДА ledger пополняется по мере
 * поступления `fill`-событий, живёт в движке (S2, `@trdlabs/engine`), не здесь.
 *
 * Валидирует КАЖДУЮ запись (`isExecutionLedgerEntry`, ревью раунда 1, I-5) и ПОРЯДОК (`ts` не
 * убывает, I-6: свёртка структурно зависит от порядка — те же две записи в обратной
 * последовательности дают другой `openedAt`/`avgEntryPrice`, а тип `ExecutionLedger` порядок
 * массива никак не проверяет) — бросает `RangeError` на первом нарушении (та же дисциплина, что
 * `timestampUs`/`durationUs`, `time-us.ts`: пара «конструктор/проекция значения» здесь бросает,
 * `checkRevisionTransition`/`parseArchiveRow` там, где вызывающему важно различать исходы по коду,
 * возвращают вердикт — `derivePositionView` ближе к первой паре по форме сигнатуры).
 *
 * Возвращает `undefined`, если по итогам всей истории позиция flat — ровно то, что несёт
 * `ActorContext.position()`.
 */
export function derivePositionView(ledger: ExecutionLedger): PositionView | undefined {
  let state = FLAT_STATE;
  let lastTs: TimestampUs | undefined;
  for (const entry of ledger) {
    if (!isExecutionLedgerEntry(entry)) {
      throw new RangeError(`derivePositionView: недопустимая запись execution ledger'а: ${JSON.stringify(entry)}`);
    }
    if (lastTs !== undefined && entry.ts < lastTs) {
      throw new RangeError(
        `derivePositionView: ledger не по неубывающему ts (${lastTs} → ${entry.ts}) — свёртка структурно ` +
          'зависит от порядка записей',
      );
    }
    lastTs = entry.ts;
    state = foldEntry(state, entry);
  }
  // ОДНА функция сравнения с нулём здесь и внутри foldFill — не точный `=== 0` рядом с эпсилоном
  // (ревью раунда 2, C-1, второе следствие: «flat» и «есть позиция» были двумя разными предикатами
  // в одном и том же файле). Поведенчески эквивалентно `=== 0` (foldFill уже снимает шум до РОВНО
  // нуля через `FLAT_STATE`), но называет ОДИН канонический критерий вместо двух молчаливо
  // согласованных.
  if (isNegligibleQty(state.qtySigned, state.peakAbsQty)) return undefined;
  // Инвариант свёртки: qtySigned !== 0 ⇒ openedAtUs всегда установлен (любая ветка foldFill,
  // покидающая flat, устанавливает его) — приведение типа здесь не ослабляет проверку, а называет
  // то, что свёртка уже гарантирует структурно.
  //
  // `as PositionView` — ЕДИНСТВЕННОЕ место в пакете, которому разрешено произвести `PositionView`
  // «С НУЛЯ» (см. doc бранд-символа `POSITION_VIEW_BRAND`, `event-driven.ts`, ГДЕ ЖЕ — после ревью
  // раунда 2, C-2 — записана ОДНОСТОРОННОСТЬ этой гарантии: создание с нуля закрыто, подделка
  // spread'ом из уже полученного результата ЭТОЙ ЖЕ функции — нет и не может быть, это другой класс
  // угрозы). Плоский объект здесь СТРУКТУРНО — это ровно форма `PositionView` без бранд-поля, TS
  // разрешает сужающий `as` в эту сторону (`PositionView` assignable ВНИЗ к безбрандовой форме,
  // обратное — нет), а получить `unique symbol` `POSITION_VIEW_BRAND` для литеральной сборки
  // объекта неоткуда — он не экспортирован и не имеет рантайм-значения (`declare const`).
  return {
    side: state.qtySigned > 0 ? 'long' : 'short',
    qty: Math.abs(state.qtySigned),
    avgEntryPrice: state.avgPrice,
    openedAt: state.openedAtUs as TimestampUs,
  } as PositionView;
}
