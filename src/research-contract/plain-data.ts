// 083 S1 — общие предикаты «это plain-data» для ТРЁХ границ недоверенного значения.
//
// Модуль — ЛИСТ графа зависимостей: не импортирует НИЧЕГО (даже `time-us.ts`). Так и задумано —
// его импортируют `event-driven.ts` (гейт авторского state-слота), `actor-state.ts` (гейт записи
// execution ledger'а) и `observation-status.ts` (компаратор содержимого ревизии), а обратного
// импорта ниоткуда нет по построению.
//
// Почему отдельный файл, а не копии на местах (финальная волна ревью ветки, находки 1/4). Раунд 4
// задачи 5 уже ловил ровно этот класс: `hasExactOwnKeys` (`actor-state.ts`) ЗАЯВЛЯЛА паритет
// строгости с гейтом state-слота, но паритет копированием не достигается — прогон нашёл три входа,
// которые один гейт принимал, а другой отклонял. Тогда паритет починили переиспользованием одной
// функции; финальное ревью нашло ЧЕТВЁРТУЮ границу с тем же расхождением (`deepValueEquals`
// пропускал разреженный массив, который `isPlainActorState` отклоняет). Одно определение на три
// границы закрывает класс структурно, а `event-driven.ts ⇄ observation-status.ts` (кольцо, если
// импортировать вторую границу из первой) не заводится.

/**
 * Практический потолок глубины рекурсивного обхода недоверенного значения.
 *
 * Введён задачей 5 (ревью раунда 2) для `isPlainActorState`: недоверенный ГЛУБОКИЙ вход валил
 * функцию, документированную КАК ГЕЙТ, необработанным `RangeError: Maximum call stack size
 * exceeded` — сигнатура обещает вердикт, а не крах. Финальное ревью ветки нашло ВТОРУЮ функцию
 * того же класса (`deepValueEquals`, `observation-status.ts`: `checkRevisionTransition` на
 * циклическом и на глубоком `value` бросала вместо вердикта — воспроизведено на глубине 6000 и
 * 12000), поэтому константа переехала сюда и применяется ОБЕИМИ.
 *
 * `500` — на порядок больше любой реалистичной глубины авторского состояния или рыночного значения
 * (счётчики/скользящие окна/индикаторы — считанные уровни вложенности, не тысячи) и безопасно ниже
 * предела стека V8 для обеих функций.
 */
export const MAX_PLAIN_DATA_DEPTH = 500;

/**
 * @internal Экспортирована только ради переиспользования между тремя границами этого пакета (см.
 * шапку файла); публичной поверхностью контракта НЕ является и может измениться без бампа.
 *
 * «Чистота» собственных ключей ОБЪЕКТА (не массива — см. `hasOnlyPlainArrayKeys` ниже, у массива
 * есть законный неперечислимый `length`). Отвергает символьный ключ, неперечислимый ключ, accessor
 * (get/set) — `Object.values`/`Object.keys` перечисляют ТОЛЬКО собственные ПЕРЕЧИСЛИМЫЕ СТРОКОВЫЕ
 * ключи и потому МОЛЧА пропускают все три (задача 5, ревью раунда 1, I-4, прогон: функция под
 * символьным ключом и неперечислимое свойство-функция обе принимались бы прежней версией).
 * `Reflect.ownKeys` перечисляет буквально ВСЁ — единственный способ увидеть то, что `Object.values`
 * прячет.
 *
 * **Поведение на не-объекте: БРОСАЕТ `TypeError`** (`Reflect.ownKeys(null)`), не возвращает
 * `false` (финальное ревью, F-5). Сигнатура `obj: object` называет это условие, но TS его не
 * гарантирует на значении с недоверенной границы — все вызывающие в пакете обязаны проверить
 * `typeof value === 'object' && value !== null` ДО вызова (и проверяют). Оборачивать проверку
 * внутрь было бы хуже: предикат «у не-объекта нет нечистых ключей» ложно-истинен, и молчаливый
 * `true`/`false` на `null` спрятал бы ошибку вызывающего вместо того, чтобы её назвать.
 */
export function hasOnlyPlainOwnKeys(obj: object): boolean {
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === 'symbol') return false;
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (descriptor === undefined || !descriptor.enumerable) return false;
    if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
  }
  return true;
}

/**
 * @internal См. `hasOnlyPlainOwnKeys` — та же оговорка о публичности.
 *
 * «Чистота» собственных ключей МАССИВА: РОВНО канонические индексы `0..length-1` строками плюс
 * встроенный неперечислимый `length` — и ничего сверх. Ловит оба array-специфичных пробела
 * (задача 5, ревью раунда 1, I-4): sparse-дыру (`[1, , 3]` — `Reflect.ownKeys` не перечисляет
 * ОТСУТСТВУЮЩИЙ индекс 1, значит `keys.length !== arr.length + 1`; `JSON.stringify` превращает
 * дыру в `null` — значение до/после границы уже не одно и то же) и добавленное нечисловое свойство
 * (`arr.extra = fn` — по умолчанию ПЕРЕЧИСЛИМО, но `.every()`/индексный обход его никогда не
 * увидят, раз оно не индекс). Accessor-индекс (`Object.defineProperty(arr, 1, {get})`) ловится
 * проверкой дескриптора — финальное ревью, F-2: `isExecutionLedger` принимал ровно его.
 */
export function hasOnlyPlainArrayKeys(arr: readonly unknown[]): boolean {
  const keys = Reflect.ownKeys(arr);
  if (keys.length !== arr.length + 1) return false; // +1 — встроенный `length`.
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key === 'symbol') return false;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= arr.length) return false;
    const descriptor = Object.getOwnPropertyDescriptor(arr, key);
    if (descriptor === undefined || !descriptor.enumerable) return false;
    if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
  }
  return true;
}

/**
 * @internal См. `hasOnlyPlainOwnKeys` — та же оговорка о публичности.
 *
 * Прототип объекта — РОВНО одна из двух разрешённых форм: `Object.prototype` (объектный литерал,
 * `JSON.parse`) либо `null` (`Object.create(null)` — легитимный plain-объект без прототипа).
 * Экзотические объекты (`Date`/`Map`/`Set`/`RegExp`/класс-инстанс) отклоняются. Белый список:
 * вместо перечисления запрещённых конструкторов (которое расширяющийся JS никогда не даст
 * исчерпать) проверяется принадлежность к двум разрешённым.
 *
 * Бросает `TypeError` на `null` — та же оговорка, что у `hasOnlyPlainOwnKeys`.
 */
export function isPlainObjectPrototype(obj: object): boolean {
  const proto = Object.getPrototypeOf(obj);
  return proto === Object.prototype || proto === null;
}

/** Максимальная длина строки, которую `safeStringify` кладёт в текст сообщения об ошибке. */
const SAFE_STRINGIFY_MAX_CHARS = 500;

/**
 * @internal См. `hasOnlyPlainOwnKeys` — та же оговорка о публичности.
 *
 * `JSON.stringify` для ТЕКСТА СООБЩЕНИЯ ОБ ОШИБКЕ — не бросающий и ограниченный по длине
 * (финальное ревью, F-6). Прямой `JSON.stringify(value)` в тексте `throw` — известная ловушка:
 * `derivePositionView` (`actor-state.ts`) документирует `RangeError` на недопустимой записи
 * ledger'а, но на ЦИКЛИЧЕСКОЙ записи и на `bigint` в поле падал `TypeError` из самого
 * `JSON.stringify` (воспроизведено: `Converting circular structure to JSON` /
 * `Do not know how to serialize a BigInt`) — то есть ровно на самых испорченных входах вызывающий
 * получал НЕ тот класс ошибки, который документирован, и без единого слова о том, какая запись
 * виновата.
 *
 * Цикл и разделяемая ссылка не различаются (`[повтор ссылки]` в обоих случаях): для строки
 * диагностики это различие не стоит второго прохода, а честное имя маркера не вводит в заблуждение.
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  let text: string;
  try {
    text =
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === 'bigint') return `${item}n`;
        if (typeof item === 'function') return `[функция ${item.name || 'без имени'}]`;
        if (typeof item === 'symbol') return item.toString();
        if (typeof item === 'object' && item !== null) {
          if (seen.has(item)) return '[повтор ссылки]';
          seen.add(item);
        }
        return item;
      }) ?? String(value);
  } catch (error) {
    text = `[несериализуемое значение: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return text.length > SAFE_STRINGIFY_MAX_CHARS ? `${text.slice(0, SAFE_STRINGIFY_MAX_CHARS)}…` : text;
}
