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
 */
export function isExecutionLedgerEntry(value: unknown): value is ExecutionLedgerEntry {
  return isExecutionLedgerFillEntry(value) || isExecutionLedgerFundingSettlementEntry(value);
}

/** Рантайм-проверка ВСЕГО ledger'а — массив, каждый элемент которого проходит `isExecutionLedgerEntry`. */
export function isExecutionLedger(value: unknown): value is ExecutionLedger {
  return Array.isArray(value) && value.every(isExecutionLedgerEntry);
}

// ─────────────────────────────────────────────────────────────────────────────
// derivePositionView — каноническая проекция ledger → PositionView (требования 3, 4).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Допуск для сравнения остатка позиции с нулём (ревью раунда 1, C-1, Critical). Плавающая точка
 * ГАРАНТИРОВАННО не даёт точного нуля на дробных лестницах (`0.1 + 0.2 - 0.3 !== 0` в IEEE754,
 * побитово) — сравнение `=== 0` здесь неприменимо НЕ по недосмотру, а по устройству арифметики с
 * плавающей точкой: прогон ревью на реальной лестнице тейк-профитов (`0.15` тремя траншами по
 * `0.05`) дал остаток `1.3877787807814457e-17` с ФИКТИВНЫМ флипом через ноль (позиция «закрыта
 * полностью» отчиталась новым `openedAt`, которого не было).
 *
 * Величина — `1e-9`: на два порядка меньше минимального шага размера ордера реальных venue
 * (satoshi-класс точности, `1e-8` BTC) — допуск не должен поглотить легитимный дробный остаток
 * целиком, только шум округления IEEE754 (типично `~1e-16`..`~1e-17` на операцию).
 */
export const POSITION_QTY_EPSILON = 1e-9;

function isNearZero(qty: number): boolean {
  return Math.abs(qty) < POSITION_QTY_EPSILON;
}

/**
 * Промежуточное состояние свёртки: `qtySigned` — остаток со знаком (`> 0` long, `< 0` short,
 * `=== 0` flat — РОВНО ноль: `foldFill` ниже СНИМАЕТ float-шум через `isNearZero` до того, как
 * записать его в `qtySigned`, поэтому здесь `=== 0` уже безопасно), `avgPrice`/`openedAtUs` —
 * характеристики ТЕКУЩЕЙ эры (не определены, пока `qtySigned === 0`).
 */
interface FoldState {
  readonly qtySigned: number;
  readonly avgPrice: number;
  readonly openedAtUs: TimestampUs | undefined;
}

const FLAT_STATE: FoldState = { qtySigned: 0, avgPrice: 0, openedAtUs: undefined };

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
 * 1. Старт с flat (`qtySigned === 0`) — новая эра целиком: `avgPrice`/`openedAtUs` берутся с
 *    этого филла.
 * 2. Тот же знак, что текущий остаток (добавление в ТУ ЖЕ сторону) — средневзвешенная цена
 *    пересчитывается по ОБЪЁМУ (не по количеству филлов), `openedAtUs` НЕ меняется — эра та же.
 * 3. Противоположный знак (выход, полный либо частичный). `isNearZero` ПЕРВЫМ (C-1, Critical —
 *    порядок проверок важен: на дробных количествах точный `remainingSigned === 0` ПОЧТИ НИКОГДА
 *    не выполняется побитово, а знак float-шума случаен, из-за чего проверка знака ДО проверки
 *    «около нуля» иногда давала ФИКТИВНЫЙ флип на закрытии дробной позиции): около нуля — эра
 *    закончилась, `qtySigned` СНИМАЕТСЯ до ровно `0`, `avgPrice`/`openedAtUs` сохраняются про запас
 *    (следующая новая эра их всё равно перезапишет с чистого места). Иначе — знак остатка совпадает
 *    со знаком ДО: выход из ТОЙ ЖЕ эры, `avgPrice`/`openedAtUs` держатся. Иначе — знак ПЕРЕВЁРНУТ:
 *    ФЛИП через ноль, часть филла, превышающая прежний остаток, открывает НОВУЮ эру ПО ЦЕНЕ и
 *    ВРЕМЕНИ ЭТОГО ЖЕ филла — ровно требование брифа «openedAt от НОВОГО открытия, а не от исходного».
 */
function foldFill(state: FoldState, entry: ExecutionLedgerFillEntry): FoldState {
  const fillSigned = signedQtyOf(entry);

  if (state.qtySigned === 0) {
    return { qtySigned: fillSigned, avgPrice: entry.price, openedAtUs: entry.ts };
  }

  if (sameSign(state.qtySigned, fillSigned)) {
    const priorAbs = Math.abs(state.qtySigned);
    const addedAbs = Math.abs(fillSigned);
    const totalAbs = priorAbs + addedAbs;
    const avgPrice = (state.avgPrice * priorAbs + entry.price * addedAbs) / totalAbs;
    return { qtySigned: state.qtySigned + fillSigned, avgPrice, openedAtUs: state.openedAtUs };
  }

  // Противоположный знак — остаток может уменьшиться (частичный выход), обнулиться (полный выход,
  // с float-шумом вместо точного нуля на дробных количествах — C-1) либо переменить знак (флип).
  const remainingSigned = state.qtySigned + fillSigned;
  if (isNearZero(remainingSigned)) {
    // Полный выход. `qtySigned: 0` — РОВНО ноль, не остаточный шум: следующий fill (если будет)
    // откроет новую эру с чистого места веткой `state.qtySigned === 0` выше.
    return { qtySigned: 0, avgPrice: state.avgPrice, openedAtUs: state.openedAtUs };
  }
  if (sameSign(remainingSigned, state.qtySigned)) {
    // Частичный выход БЕЗ флипа — эра та же: avgPrice/openedAt держатся.
    return { qtySigned: remainingSigned, avgPrice: state.avgPrice, openedAtUs: state.openedAtUs };
  }
  // Флип: новая эра с этого самого филла.
  return { qtySigned: remainingSigned, avgPrice: entry.price, openedAtUs: entry.ts };
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
  if (state.qtySigned === 0) return undefined;
  // Инвариант свёртки: qtySigned !== 0 ⇒ openedAtUs всегда установлен (любая ветка foldFill,
  // покидающая flat, устанавливает его) — приведение типа здесь не ослабляет проверку, а называет
  // то, что свёртка уже гарантирует структурно.
  //
  // `as PositionView` — ЕДИНСТВЕННОЕ место в пакете, которому разрешено произвести `PositionView`
  // (см. doc бранд-символа `POSITION_VIEW_BRAND`, `event-driven.ts`): плоский объект здесь СТРУКТУРНО
  // — это ровно форма `PositionView` без бранд-поля, TS разрешает сужающий `as` в эту сторону
  // (`PositionView` assignable ВНИЗ к безбрандовой форме, обратное — нет), а получить `unique symbol`
  // `POSITION_VIEW_BRAND` для литеральной сборки объекта неоткуда — он не экспортирован и не имеет
  // рантайм-значения (`declare const`).
  return {
    side: state.qtySigned > 0 ? 'long' : 'short',
    qty: Math.abs(state.qtySigned),
    avgEntryPrice: state.avgPrice,
    openedAt: state.openedAtUs as TimestampUs,
  } as PositionView;
}
