/**
 * Result digest — общий оракул паритета трёх транспортов Д5 (row-JSON, Arrow IPC, files+range).
 *
 * ПОЧЕМУ НЕ БАЙТЫ. JSON, Arrow IPC и parquet различаются на уровне представления ПО ПОСТРОЕНИЮ:
 * одно и то же значение f64 приезжает десятичным текстом, восемью байтами little-endian и
 * колоночной страницей. Байтовое равенство между путями невозможно, и требовать его значило бы
 * проверять транспорт вместо данных. Сравнивается КАНОНИЧЕСКИЙ НАБОР СТРОК ПОСЛЕ ДЕКОДИРОВАНИЯ.
 *
 * ОРАКУЛ ОДИН НА ВСЕ ТРИ ПУТИ. Два независимых канонизатора разошлись бы на первом же краевом
 * случае, и расхождение выглядело бы как дефект транспорта — то есть ровно как то, что замер
 * должен обнаруживать.
 *
 * ПОЧЕМУ ОН ЖИВЁТ В SDK, А НЕ В PLATFORM. «Один оракул» — это не пожелание, а условие
 * осмысленности замера, и оно держится только тем, что все стороны берут ОДИН И ТОТ ЖЕ код.
 * Стороны разные по репозиторию: platform отдаёт данные, бэктестер при форме «файлы + Range»
 * декодирует parquet сам и считает digest по своим материализованным строкам. Platform не
 * публикуемый пакет — из бэктестера до него не дотянуться, — поэтому оракул, оставленный там,
 * неизбежно породил бы вторую копию. Здесь он доступен обеим сторонам по пину версии.
 *
 * Модуль намеренно не имеет зависимостей, кроме `node:crypto` и локального описания строки:
 * всё, что он тянул бы из platform, вернуло бы ту же связанность, ради разрыва которой он и
 * переехал.
 *
 * ЧЕГО ОРАКУЛ НЕ ДЕЛАЕТ: он не чинит и не сглаживает. Всякий вход, на котором паритет
 * НЕОПРЕДЕЛЁН, — отказ, а не значение по умолчанию. Таких входов три: дубль ключа, `NaN`/`±Inf`
 * и целое, у которого точность уже потеряна. Молча канонизировать любой из них значило бы выдать
 * совпадение дайджестов там, где сравнивать нечего.
 */

import { createHash } from 'node:crypto';

import { CANONICAL_ROW_V2_FIELDS } from './canonical-row.js';

/**
 * Разделители выбраны из области, которой в данных нет: `symbol` нормализован до ASCII
 * upper-case, остальные поля числовые или булевы. Разделитель, встречающийся в значении, склеил
 * бы соседние поля в одно и сделал бы разные строки неразличимыми.
 */
const FIELD_SEP = '\x1f';
const ROW_SEP = '\x1e';

/** `null` и ОТСУТСТВИЕ поля — разные факты, и маркеры у них разные. */
const NULL_MARK = '\x00';
/**
 * Поле не приехало вовсе. Проекция `kinds` намеренно ОПУСКАЕТ непрошенный вид, а не присылает
 * его `null`: иначе «источника не было» стало бы неотличимо от «мы это не запрашивали».
 * Оракул обязан сохранять это различие, иначе полный ответ и проекция дали бы один digest.
 */
const ABSENT_MARK = '\x01';

/** Поля, значение которых ЦЕЛОЕ. Всё остальное числовое — f64. */
const INTEGER_FIELDS: ReadonlySet<string> = new Set(['schema_version', 'minute_ts']);
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set([
  'has_oi', 'has_funding', 'has_liquidations', 'has_taker_flow',
]);
const STRING_FIELDS: ReadonlySet<string> = new Set(['symbol']);

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Классы входов, на которых паритет НЕОПРЕДЕЛЁН.
 *
 * Именованный тип, а не встроенное объединение: это публичная поверхность пакета, и потребитель,
 * ветвящийся по `e.code`, должен иметь возможность назвать её в своей сигнатуре. Внутри platform
 * тип был встроенным — там его никто не импортировал.
 */
export type ResultDigestFailure =
  | 'DUPLICATE_ROW_KEY'
  | 'NON_FINITE'
  | 'PRECISION_LOST'
  | 'TYPE_MISMATCH';

export class ResultDigestError extends Error {
  readonly code: ResultDigestFailure;

  constructor(code: ResultDigestFailure, detail: string) {
    super(`result digest: ${detail}`);
    this.name = 'ResultDigestError';
    this.code = code;
  }
}

/** Минимум, который нужен оракулу. Полная строка не требуется. */
export type DigestRow = Readonly<Record<string, unknown>>;

export interface ResultDigest {
  readonly sha256: string;
  /**
   * Без счётчика пустой ответ имеет совершенно валидный digest и выглядит успехом. Критерий
   * приёмки Д5 требует обратного: короткий ответ ≠ успех, успех положительно доказуем.
   */
  readonly rowCount: number;
  readonly minMinuteTs: number | null;
  readonly maxMinuteTs: number | null;
}

/**
 * Целое → десятичная строка.
 *
 * `bigint` и `number` обязаны дать ОДНУ строку: Arrow отдаёт int64 как `bigint`, JSON — как
 * `number`, и это одно и то же значение. Поэтому целые поля канонизируются десятично, а НЕ через
 * представление f64: `toPrecision` дал бы `1.7825184000000000e+12` для числа и `1782518400000`
 * для bigint, то есть развёл бы пути на ровном месте.
 *
 * Число вне безопасного диапазона — ОТКАЗ. За 2^53 `number` уже не различает соседние целые:
 * канонизировать такое значит зафиксировать потерю точности как факт и сравнить её с точным
 * `bigint` другого пути.
 */
function canonicalInteger(v: unknown, field: string): string {
  if (typeof v === 'bigint') {
    // Симметрия с number обязательна. Принимать точный bigint и отвергать неточный number
    // означало бы, что допустимость значения зависит от того, каким транспортом оно приехало.
    // Хуже: точность сохранялась бы ТОЛЬКО в хеше, а ключ, границы и детектор дублей всё равно
    // проходят через `Number` — то есть два разных unsafe значения дали бы разные дайджесты и
    // при этом считались бы одной строкой при сортировке и одним ключом при поиске дубля.
    if (v > MAX_SAFE || v < MIN_SAFE) {
      throw new ResultDigestError(
        'PRECISION_LOST',
        `${field}=${v}: целое вне 2^53 — ключ, границы и детектор дублей его не удержат`,
      );
    }
    return v.toString(10);
  }
  if (typeof v !== 'number') {
    throw new ResultDigestError('TYPE_MISMATCH', `${field}: ожидалось целое, пришло ${typeof v}`);
  }
  if (!Number.isFinite(v)) throw new ResultDigestError('NON_FINITE', `${field}=${v}`);
  if (!Number.isInteger(v)) {
    throw new ResultDigestError('TYPE_MISMATCH', `${field}=${v}: поле объявлено целым`);
  }
  if (!Number.isSafeInteger(v)) {
    throw new ResultDigestError(
      'PRECISION_LOST',
      `${field}=${v}: за пределами 2^53 number не различает соседние целые`,
    );
  }
  return v.toString(10);
}

/**
 * f64 → 17 значащих цифр.
 *
 * 17 — минимум, гарантирующий round-trip двоичного f64 через десятичную запись. Меньше склеило бы
 * различимые значения (0.1 + 0.2 и 0.3 — разные числа, и разными обязаны остаться), больше не
 * добавляет информации.
 *
 * `-0` отдельной нормализации НЕ требует, и это проверено, а не предположено: `toPrecision` не
 * печатает знак нуля, потому что ветка знака у него — `x < 0`, а `-0 < 0` ложно. Обе записи дают
 * `0.0000000000000000`. Прежняя редакция несла защиту `(v === 0 ? 0 : v)` с обоснованием, что без
 * неё вышло бы `-0.0000000000000000`; обоснование было неверным, защита — мёртвой, и мутация,
 * снявшая её, осталась зелёной. Убрано вместе с обоснованием; гейт вместо этого пинит СВОЙСТВО
 * ПЛАТФОРМЫ, чтобы смена поведения движка не прошла молча.
 */
function canonicalFloat(v: unknown, field: string): string {
  // bigint в вещественном поле — не «целое значение f64», а НЕ ТОТ ТИП на проводе: колонка
  // объявлена f64, и целочисленное представление означает, что декодер прочитал её схемой
  // другого пути. Тихая конвертация спрятала бы ровно то расхождение, которое замер ищет.
  if (typeof v === 'bigint') {
    throw new ResultDigestError('TYPE_MISMATCH', `${field}: поле объявлено f64, пришёл bigint`);
  }
  if (typeof v !== 'number') {
    throw new ResultDigestError('TYPE_MISMATCH', `${field}: ожидалось число, пришло ${typeof v}`);
  }
  // NaN и ±Infinity в JSON невыразимы вовсе. Их появление означает, что расхождение путей УЖЕ
  // произошло, и превращать его в значение нельзя.
  if (!Number.isFinite(v)) throw new ResultDigestError('NON_FINITE', `${field}=${v}`);
  return v.toPrecision(17);
}

function canonicalField(row: DigestRow, field: string): string {
  if (!(field in row)) return ABSENT_MARK;
  const v = row[field];
  // `undefined` — ОТСУТСТВИЕ свойства, а не `null`. На JSON-проводе его не существует:
  // `JSON.stringify({a: undefined})` даёт `{}`, поэтому путь, где поле было `undefined`, и путь,
  // где его не было вовсе, обязаны дать один digest. Приравнять `undefined` к `null` значило бы
  // объявить «источника не было» там, где было «мы это не запрашивали».
  if (v === undefined) return ABSENT_MARK;
  if (v === null) return NULL_MARK;
  if (STRING_FIELDS.has(field)) {
    if (typeof v !== 'string') {
      throw new ResultDigestError('TYPE_MISMATCH', `${field}: ожидалась строка, пришло ${typeof v}`);
    }
    return v;
  }
  if (BOOLEAN_FIELDS.has(field)) {
    if (typeof v !== 'boolean') {
      throw new ResultDigestError('TYPE_MISMATCH', `${field}: ожидался boolean, пришло ${typeof v}`);
    }
    return v ? '1' : '0';
  }
  return INTEGER_FIELDS.has(field) ? canonicalInteger(v, field) : canonicalFloat(v, field);
}

/** Каноническая строка. Порядок полей берётся ИЗ СХЕМЫ, а не переписывается здесь. */
export function canonicalRowLine(row: DigestRow): string {
  const parts: string[] = [];
  for (const field of CANONICAL_ROW_V2_FIELDS) parts.push(canonicalField(row, field));
  return parts.join(FIELD_SEP);
}

/**
 * Ключ строки, извлечённый и ПРОВЕРЕННЫЙ до сортировки.
 *
 * Раньше ключ брался «на лету» через `Number(v)`, и это было половинчато: хеш строился по точной
 * десятичной записи, а сортировка, границы и детектор дублей — по потерявшему точность `number`.
 * Два разных значения за 2^53 получали разные дайджесты и одновременно считались одной строкой.
 * Теперь недопустимое значение отсекается ЗДЕСЬ, и всё, что дальше, работает на проверенном
 * `number` — точность гарантирована конструкцией, а не надеждой.
 */
interface ExactRowKey {
  readonly minuteTs: number;
  readonly symbol: string;
}

function exactRowKey(row: DigestRow): ExactRowKey {
  const raw = row['minute_ts'];
  let minuteTs: number;
  if (typeof raw === 'bigint') {
    if (raw > MAX_SAFE || raw < MIN_SAFE) {
      throw new ResultDigestError(
        'PRECISION_LOST',
        `minute_ts=${raw}: целое вне 2^53 не может служить ключом сортировки и дубля`,
      );
    }
    minuteTs = Number(raw);
  } else if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new ResultDigestError('NON_FINITE', `minute_ts=${raw}`);
    if (!Number.isInteger(raw)) {
      throw new ResultDigestError('TYPE_MISMATCH', `minute_ts=${raw}: поле объявлено целым`);
    }
    if (!Number.isSafeInteger(raw)) {
      throw new ResultDigestError('PRECISION_LOST', `minute_ts=${raw}: вне 2^53`);
    }
    minuteTs = raw;
  } else {
    throw new ResultDigestError('TYPE_MISMATCH', `minute_ts: ожидалось целое, пришло ${typeof raw}`);
  }
  const symbol = row['symbol'];
  if (typeof symbol !== 'string') {
    throw new ResultDigestError('TYPE_MISMATCH', `symbol: ожидалась строка, пришло ${typeof symbol}`);
  }
  return { minuteTs, symbol };
}

/**
 * Digest набора строк.
 *
 * Сортировка ЯВНАЯ, по тому же тотальному порядку `(minute_ts, symbol)`, что у контракта чтения.
 * Она делает результат независимым от порядка доставки батчей: bulk-путь отдаёт row-group'ами,
 * row-JSON — страницами, и совпадать эти нарезки не обязаны.
 *
 * Дубль ключа — ОТКАЗ, а не строка в наборе. На таком дне паритет не нарушен, он НЕОПРЕДЕЛЁН:
 * row-JSON отвечает 409 и не отдаёт ничего, а bulk-путь отдал бы обе копии. Согласовано с
 * `assertUniqueRowKeys`, который держит тот же инвариант на стороне читалки.
 */
export function computeResultDigest(rows: ReadonlyArray<DigestRow>): ResultDigest {
  // Ключи проверяются ДО сортировки: значение, которое не может быть ключом, обязано уронить
  // сборку, а не отсортироваться приблизительно.
  const keyed = rows.map((row) => ({ row, key: exactRowKey(row) }));
  keyed.sort((a, b) => {
    const t = a.key.minuteTs - b.key.minuteTs;
    if (t !== 0) return t;
    return a.key.symbol < b.key.symbol ? -1 : a.key.symbol > b.key.symbol ? 1 : 0;
  });

  // Дубли — ОТДЕЛЬНЫМ проходом, до хеширования. Дубль есть свойство НАБОРА, и устанавливать его
  // посреди подсчёта хеша значит делать диагноз зависящим от того, на какой строке порядок
  // споткнулся раньше: набор с двумя разными дефектами возвращал бы то один код, то другой в
  // зависимости от сортировки.
  for (let i = 1; i < keyed.length; i += 1) {
    const prev = (keyed[i - 1] as { key: ExactRowKey }).key;
    const cur = (keyed[i] as { key: ExactRowKey }).key;
    if (prev.minuteTs === cur.minuteTs && prev.symbol === cur.symbol) {
      throw new ResultDigestError(
        'DUPLICATE_ROW_KEY',
        `(${cur.minuteTs}, ${cur.symbol}) встречается дважды — паритет на этом наборе неопределён`,
      );
    }
  }

  const hash = createHash('sha256');
  for (let i = 0; i < keyed.length; i += 1) {
    if (i > 0) hash.update(ROW_SEP, 'utf8');
    hash.update(canonicalRowLine((keyed[i] as { row: DigestRow }).row), 'utf8');
  }

  const first = keyed[0];
  const last = keyed[keyed.length - 1];
  return {
    sha256: hash.digest('hex'),
    rowCount: keyed.length,
    minMinuteTs: first === undefined ? null : first.key.minuteTs,
    maxMinuteTs: last === undefined ? null : last.key.minuteTs,
  };
}

/**
 * Совпали ли результаты путей. Сравниваются ВСЕ четыре поля, а не только `sha256`.
 *
 * ЧТО ЭТА ФУНКЦИЯ ДОКАЗЫВАЕТ И ЧТО НЕТ. Она доказывает РАВЕНСТВО путей — и ничего больше. Три
 * пустых ответа согласуются идеально; три одинаково усечённых — тоже. Обе ситуации выглядят как
 * успешный паритет, будучи полным провалом замера: общий дефект (не тот день, схлопнувшийся
 * фильтр, оборванный поток) поражает все пути ОДИНАКОВО и потому равенством не ловится.
 *
 * Поэтому равенство — необходимое условие, а не достаточное. Достаточность даёт
 * `checkAgainstExpectation` с ожиданием из НЕЗАВИСИМОГО источника.
 */
export function digestsAgree(a: ResultDigest, b: ResultDigest): boolean {
  return (
    a.sha256 === b.sha256 &&
    a.rowCount === b.rowCount &&
    a.minMinuteTs === b.minMinuteTs &&
    a.maxMinuteTs === b.maxMinuteTs
  );
}

/**
 * Ожидание, полученное НЕ из сравниваемых ответов.
 *
 * Источник обязан быть независимым от измеряемого пути — иначе проверка сведётся к сравнению
 * ответа с самим собой. Для дня архива такой источник есть: число строк лежит в метаданных
 * parquet-файлов, а границы задаются запрошенным окном.
 */
export interface ResultExpectation {
  /** Точное число строк, если известно. */
  readonly rowCount?: number;
  /** Минимум строк — когда точное число неизвестно, но пустота недопустима. */
  readonly minRowCount?: number;
  /** Полуоткрытый диапазон, за который штампы выходить не вправе. */
  readonly withinRange?: { readonly tsFrom: number; readonly tsTo: number };
  readonly minMinuteTs?: number;
  readonly maxMinuteTs?: number;
}

/** Нарушения ожидания. Пустой массив — ответ соответствует; иначе перечислено, чем именно нет. */
export function checkAgainstExpectation(
  digest: ResultDigest,
  expectation: ResultExpectation,
): string[] {
  const bad: string[] = [];
  if (expectation.rowCount !== undefined && digest.rowCount !== expectation.rowCount) {
    bad.push(`rowCount ${digest.rowCount} вместо ${expectation.rowCount}`);
  }
  if (expectation.minRowCount !== undefined && digest.rowCount < expectation.minRowCount) {
    bad.push(`rowCount ${digest.rowCount} меньше минимума ${expectation.minRowCount}`);
  }
  if (expectation.minMinuteTs !== undefined && digest.minMinuteTs !== expectation.minMinuteTs) {
    bad.push(`minMinuteTs ${digest.minMinuteTs} вместо ${expectation.minMinuteTs}`);
  }
  if (expectation.maxMinuteTs !== undefined && digest.maxMinuteTs !== expectation.maxMinuteTs) {
    bad.push(`maxMinuteTs ${digest.maxMinuteTs} вместо ${expectation.maxMinuteTs}`);
  }
  const range = expectation.withinRange;
  if (range !== undefined) {
    // Пустой ответ диапазону не противоречит и потому здесь НЕ отвергается: пустоту ловит
    // `minRowCount`. Смешать эти два вопроса значило бы дать «нет строк» и «строки не оттуда»
    // один диагноз.
    if (digest.minMinuteTs !== null && digest.minMinuteTs < range.tsFrom) {
      bad.push(`minMinuteTs ${digest.minMinuteTs} раньше окна ${range.tsFrom}`);
    }
    if (digest.maxMinuteTs !== null && digest.maxMinuteTs >= range.tsTo) {
      bad.push(`maxMinuteTs ${digest.maxMinuteTs} не раньше конца окна ${range.tsTo}`);
    }
  }
  return bad;
}

/**
 * Чего не хватает ожиданию, чтобы на нём можно было вынести вердикт.
 *
 * Достаточным считается ТОЧНЫЙ `rowCount` плюс границы окна. Ни то, ни другое по отдельности не
 * годится: `minRowCount: 1` пропускает ответ из пяти строк там, где их сто, а одни границы
 * молчат про объём. Всё остальное (`minMinuteTs`, `maxMinuteTs`) — уточнения поверх, не замена.
 */
function expectationGaps(e: ResultExpectation): string[] {
  const gaps: string[] = [];
  if (e.rowCount === undefined) gaps.push('точный rowCount');
  if (e.withinRange === undefined) gaps.push('границы окна');
  return gaps;
}

/**
 * Полный вердикт паритета: пути равны МЕЖДУ СОБОЙ и каждый соответствует независимому ожиданию.
 *
 * Оба условия обязательны. Без первого пути могли бы разойтись; без второго они могли бы сойтись
 * на общем дефекте — и это ровно тот случай, который равенством не обнаруживается.
 *
 * ВЕРДИКТ FAIL-CLOSED. Неполное ожидание — само по себе нарушение, а не «проверим, что дали».
 * Прежняя редакция принимала `{}`: все поля `ResultExpectation` опциональны, поэтому вызов без
 * ожидания сводил вердикт к одному лишь равенству — и три одинаково пустых или одинаково
 * усечённых ответа проходили как паритет. Забытый аргумент не должен ослаблять проверку; он
 * должен её ронять.
 */
export function checkParity(
  digests: ReadonlyArray<{ readonly path: string; readonly digest: ResultDigest }>,
  expectation: ResultExpectation,
): string[] {
  const problems: string[] = [];
  const gaps = expectationGaps(expectation);
  if (gaps.length > 0) {
    problems.push(`ожидание неполно (нет: ${gaps.join(', ')}) — вердикт паритета невыносим`);
  }
  if (digests.length < 2) problems.push(`путей ${digests.length} — сравнивать нечего`);
  const head = digests[0];
  if (head !== undefined) {
    for (const other of digests.slice(1)) {
      if (!digestsAgree(head.digest, other.digest)) {
        problems.push(`${head.path} и ${other.path} разошлись`);
      }
    }
  }
  for (const d of digests) {
    for (const bad of checkAgainstExpectation(d.digest, expectation)) {
      problems.push(`${d.path}: ${bad}`);
    }
  }
  return problems;
}
