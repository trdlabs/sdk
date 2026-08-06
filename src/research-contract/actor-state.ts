// 083 S1 — задача 5: авторский state-слот актора, execution ledger, вывод `PositionView` из него.
//
// Спека: control-center `docs/superpowers/specs/2026-08-04-event-driven-actor-contract-design.md`
// (см. `.superpowers/sdd/2026-08-06-s1-actor-contract/task-5-brief.md`).
//
// Модуль — СОСЕД `event-driven.ts` (где живёт `ActorContext`/`PositionView`/`OpenOrderView`), не
// его часть. Зависимость — только В ОДНУ СТОРОНУ: этот файл импортирует `OrderSide`/`PositionView`
// ОТТУДА (типы), обратного импорта нет — та же дисциплина, что у `observation-status.ts`
// (см. шапку того файла): `event-driven.ts` НЕ импортирует ничего отсюда, только использует имена
// `PositionView`/`OpenOrderView`, которые сам же и объявляет. Кольца зависимостей поэтому нет,
// хотя обе стороны концептуально связаны (`ActorContext.position()` возвращает ровно то, что
// `derivePositionView` ниже вычисляет из ledger'а).
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

import type { OrderSide, PositionView } from './event-driven.js';
import type { TimestampUs } from './time-us.js';

// ─────────────────────────────────────────────────────────────────────────────
// Авторский state-слот (требование 1) — plain-data, проверяется РАНТАЙМОМ, не только типом.
// ─────────────────────────────────────────────────────────────────────────────

// Почему нужен рантайм-валидатор, а не только тип. Слот — собственное состояние актора МЕЖДУ
// вызовами `onEvent` (например: скользящие суммы, счётчики, ручные индикаторы, которые автору
// проще держать сам, чем пересчитывать из истории на каждый вызов). Состояние ОБЯЗАНО пережить
// чекпойнт и восстановление изолята (сбой хоста, миграция, холодный рестарт после простоя) — то
// есть обязано пройти через JSON туда и обратно байт-в-байт. Замыкание (функция, захватившая
// внешние переменные) сериализуется в `{}` или бросает при `JSON.stringify` — тип TS `unknown`/
// generic-параметр НЕ может отличить «этот объект переживёт сериализацию» от «этот объект выглядит
// как данные, но внутри держит функцию» на этапе компиляции: сериализуемость — рантайм-свойство
// КОНКРЕТНОГО значения, а не структурное свойство его статического типа (объект с полем-функцией
// типизируется нормально, `JSON.stringify` его не отвергнет — молча уронит поле или превратит в
// `undefined`). Отсюда — `isPlainActorState` ниже: единственный способ поймать «это не переживёт
// границу» ДО того, как оно эту границу попытается пересечь.

/**
 * Значение, законное в авторском state-слоте актора. Рекурсивный plain-data union — ровно то
 * подмножество JS-значений, что `JSON.parse(JSON.stringify(x))` восстанавливает БЕЗ потерь и без
 * молчаливых искажений (в отличие, например, от объекта с ключом `undefined`-значения, который
 * `JSON.stringify` тихо роняет, или от `Date`, который превращается в строку и теряет тип).
 *
 * Явно ЗАКРЫТ на верхнем уровне: `null`/`boolean`/`string`/конечное `number`/массив/plain-объект.
 * `NaN`/`Infinity` не входят (типовое ограничение `number` их не исключает, но `isPlainActorState`
 * отклоняет их рантаймом — та же дисциплина, что `isTimestampUs`/`isDurationUs` в `time-us.ts`:
 * тип называет НАМЕРЕНИЕ, рантайм-предикат его проверяет на недоверенном значении).
 */
export type ActorStateValue =
  | null
  | boolean
  | string
  | number
  | readonly ActorStateValue[]
  | { readonly [key: string]: ActorStateValue };

/**
 * Рекурсивный обход с отслеживанием ТЕКУЩЕГО ПУТИ предков (не всех когда-либо посещённых узлов):
 * `ancestors` пополняется ПЕРЕД рекурсией в потомков и очищается ПОСЛЕ (backtracking) — так
 * отличается настоящий ЦИКЛ (узел ссылается сам на себя через цепочку потомков) от легитимного
 * ДИАМАНТА (два разных поля указывают на ОДИН И ТОТ ЖЕ вложенный объект, но не по кругу: JSON это
 * прекрасно сериализует, просто теряя разделяемую идентичность, что для plain-data не является
 * пороком). Глобальный «посещённый» `Set` без backtracking спутал бы диамант с циклом и отклонял
 * бы законные значения.
 */
function isPlainDataValue(value: unknown, ancestors: ReadonlySet<object>): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value as number);
  // function/symbol/bigint/undefined — НЕ plain-data. `undefined` внутри структуры (не как
  // отсутствующий ключ, а как явное значение) тоже отклонён: `JSON.stringify` роняет такие ключи
  // молча, то есть значение до/после границы JSON — уже не одно и то же значение.
  if (t !== 'object') return false;

  if (ancestors.has(value as object)) return false; // настоящий цикл — см. doc выше.
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value as object);

  if (Array.isArray(value)) {
    return value.every((item) => isPlainDataValue(item, nextAncestors));
  }

  // Экзотические объекты (Date/Map/Set/RegExp/класс-инстанс) отклонены: их прототип — не
  // Object.prototype и не null (`Object.create(null)` — легитимный plain-объект без прототипа,
  // тоже должен проходить). Белый список (rule: валидаторы — белым списком, не чёрным): вместо
  // перечисления запрещённых конструкторов (который расширяющийся JS никогда не даст исчерпать)
  // проверяется РОВНО принадлежность к двум разрешённым формам прототипа.
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) return false;

  return Object.values(value as Record<string, unknown>).every((v) => isPlainDataValue(v, nextAncestors));
}

/**
 * Рантайм-проверка формы авторского state-слота (требование 1). Отвергает: функции (прямые и как
 * значения полей — то есть замыкания, раз JS не различает «функцию» и «замыкание» на уровне
 * значения), циклические ссылки, `symbol`/`bigint`/`undefined`-в-структуре, `NaN`/`Infinity`,
 * экзотические объекты (`Date`/`Map`/`Set`/класс-инстанс). Принимает вложенную структуру из
 * `null`/`boolean`/`string`/конечных `number`/массивов/plain-объектов любой глубины.
 */
export function isPlainActorState(value: unknown): value is ActorStateValue {
  return isPlainDataValue(value, new Set());
}

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
 * `side`, не `qty` (симметрично `ActorFillEvent.qty`). `fee` — комиссия ЭТОГО исполнения
 * (требование 4: «комиссии» фиксируются здесь, не отдельной сущностью — комиссия существует
 * только КАК СВОЙСТВО конкретного филла, у неё нет самостоятельного бытия без него).
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
 * знаковый денежный поток на открытую позицию). `amount` — получено (`> 0`) либо уплачено (`< 0`);
 * форма МИНИМАЛЬНА нарочно (задача 5 — словарь, не реализация: settlement в v1 архива не резолвится
 * вовсе, см. doc `FundingMarketDataRequirement`, `event-driven.ts`, задача 3) — запись существует,
 * чтобы будущий резолв не требовал ломающего расширения формы ledger'а.
 */
export interface ExecutionLedgerFundingSettlementEntry {
  readonly kind: 'funding_settlement';
  readonly ts: TimestampUs;
  /** Знаковый денежный поток: получено (+) или уплачено (-). */
  readonly amount: number;
}

/** Замкнутый union записей execution ledger'а. */
export type ExecutionLedgerEntry = ExecutionLedgerFillEntry | ExecutionLedgerFundingSettlementEntry;

/**
 * Execution ledger целиком — упорядоченный (по времени записи, старые первыми) журнал, ОДИН на
 * актора. Флип позиции через ноль (требование 4) — НЕ отдельный вид записи: это факт, ВЫВОДИМЫЙ
 * из последовательности `fill`-записей самим `derivePositionView` (сделка противоположной стороны
 * крупнее текущего остатка), а не что-то, что вызывающий обязан распознать и записать отдельно —
 * заводить для флипа свой `kind` значило бы дублировать информацию, которую сама
 * последовательность `fill`-ов уже несёт, и создавать возможность рассинхронизации («флип был, а
 * запись о нём — нет»), то есть ровно ту дыру, ради закрытия которой существует этот файл.
 */
export type ExecutionLedger = readonly ExecutionLedgerEntry[];

// ─────────────────────────────────────────────────────────────────────────────
// derivePositionView — каноническая проекция ledger → PositionView (требования 3, 4).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Промежуточное состояние свёртки: `qtySigned` — остаток со знаком (`> 0` long, `< 0` short,
 * `=== 0` flat), `avgPrice`/`openedAtUs` — характеристики ТЕКУЩЕЙ эры (не определены, пока
 * `qtySigned === 0`).
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
 * 3. Противоположный знак (выход, полный либо частичный). Если знак остатка ПОСЛЕ филла
 *    совпадает со знаком ДО (или остаток — ровно ноль) — это выход из ТОЙ ЖЕ эры: `avgPrice`
 *    сохраняется (частичный/полный выход не меняет цену входа оставшейся части), `openedAtUs` не
 *    меняется. Если знак остатка ПОСЛЕ филла ПЕРЕВЁРНУТ относительно знака ДО — это ФЛИП через
 *    ноль: часть филла, превышающая прежний остаток, открывает НОВУЮ эру ПО ЦЕНЕ ЭТОГО ЖЕ филла
 *    (единственная цена, по которой эта часть реально исполнилась) СО ВРЕМЕНЕМ ЭТОГО ЖЕ филла —
 *    ровно требование брифа «openedAt от НОВОГО открытия, а не от исходного».
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

  // Противоположный знак — остаток может уменьшиться (частичный выход), обнулиться (полный выход)
  // либо переменить знак (флип через ноль).
  const remainingSigned = state.qtySigned + fillSigned;
  if (remainingSigned === 0 || sameSign(remainingSigned, state.qtySigned)) {
    // Частичный либо полный выход БЕЗ флипа — эра (если осталась) та же: avgPrice/openedAt держатся.
    return { qtySigned: remainingSigned, avgPrice: state.avgPrice, openedAtUs: state.openedAtUs };
  }
  // Флип: новая эра с этого самого филла.
  return { qtySigned: remainingSigned, avgPrice: entry.price, openedAtUs: entry.ts };
}

/**
 * Каноническая ЧИСТАЯ проекция «execution ledger → текущая позиция» (требования 3, 4). Свёртка ПО
 * ВСЕЙ истории заново на каждый вызов — не инкрементальный движок с собственным хранимым
 * состоянием: та же дисциплина, что у `checkRevisionTransition` (задача 4), где вызывающий держит
 * `previous`/`next` сам, а функция лишь СРАВНИВАЕТ. Здесь вызывающий держит ledger целиком, а
 * функция лишь ПРОЕЦИРУЕТ его в снимок — реализация того, КАК/КОГДА ledger пополняется по мере
 * поступления `fill`-событий, живёт в движке (S2, `@trdlabs/engine`), не здесь.
 *
 * `funding_settlement`-записи НЕ участвуют в свёртке ниже: funding меняет P&L, а не размер/сторону
 * позиции — `qty`/`side`/`openedAt`/`avgEntryPrice` от него не зависят СТРУКТУРНО, поэтому свёртка
 * фильтрует только `fill`.
 *
 * Возвращает `undefined`, если по итогам всей истории позиция flat (`qtySigned === 0`) — ровно то,
 * что несёт `ActorContext.position()`.
 */
export function derivePositionView(ledger: ExecutionLedger): PositionView | undefined {
  let state = FLAT_STATE;
  for (const entry of ledger) {
    if (entry.kind !== 'fill') continue;
    state = foldFill(state, entry);
  }
  if (state.qtySigned === 0) return undefined;
  // Инвариант свёртки: qtySigned !== 0 ⇒ openedAtUs всегда установлен (любая ветка foldFill,
  // покидающая flat, устанавливает его) — приведение типа здесь не ослабляет проверку, а называет
  // то, что свёртка уже гарантирует структурно.
  return {
    side: state.qtySigned > 0 ? 'long' : 'short',
    qty: Math.abs(state.qtySigned),
    avgEntryPrice: state.avgPrice,
    openedAt: state.openedAtUs as TimestampUs,
  };
}
