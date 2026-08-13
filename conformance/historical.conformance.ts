// Переиспользуемый conformance-харнес контракта historical.2. given baseUrl → проверки.
// Юнит, который извлечёт Инициатива #2 (@trdlabs/sdk).
import type { CanonicalRowV2 } from '@trdlabs/sdk/historical';

export interface HistoricalConformanceTarget { readonly baseUrl: string; readonly token?: string }

/** A check the target's dataset could not exercise (e.g. a single-symbol fixture cannot
 *  prove multi-symbol ordering). Reported when `opts.onSkip` is supplied. */
export interface HistoricalConformanceSkip { readonly check: string; readonly reason: string }

const assert = (cond: unknown, msg: string): void => { if (!cond) throw new Error(`historical-conformance: ${msg}`); };

async function getJson(t: HistoricalConformanceTarget, path: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = t.token ? { authorization: `Bearer ${t.token}` } : {};
  const res = await fetch(`${t.baseUrl.replace(/\/+$/, '')}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const ROW_FIELDS = ['schema_version','minute_ts','symbol','open','high','low','close','volume','turnover','oi_total_usd','funding_rate','liq_long_usd','liq_short_usd','has_oi','has_funding','has_liquidations','taker_buy_volume_usd','taker_sell_volume_usd','has_taker_flow'] as const;

function normalizeRow(r: Record<string, unknown>): string {
  const o: Record<string, unknown> = {};
  for (const f of ROW_FIELDS) o[f] = r[f] ?? null;
  return JSON.stringify(o);
}

const tsOf = (r: any): number => r?.minute_ts as number;

/** Default ceiling on pages drained from one query — the backstop for a pager that keeps
 *  advancing with fresh cursors forever, which the repeat check cannot see. Sized well
 *  above a realistic conformance fixture (a week of 1m bars drains ~3.3k pages at
 *  limit=3); raise it via `opts.maxPages` for a larger target. */
const DEFAULT_MAX_PAGES = 10_000;

/** Collect every page of a rows query, following nextCursor. Two independent guards:
 *  a repeated cursor fails fast on its second sighting (non-advancing pager), and a
 *  finite page budget bounds a pager that advances forever. */
async function drainRows(
  t: HistoricalConformanceTarget,
  query: string,
  label: string,
  maxPages: number,
): Promise<{ items: any[]; pages: number }> {
  const items: any[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const p = await getJson(t, `${query}${cursor ? `&cursor=${cursor}` : ''}`);
    assert(p.status === 200, `${label}: status ${p.status}`);
    assert(Array.isArray(p.body?.items), `${label}: page has no items array`);
    pages++;
    assert(pages <= maxPages, `${label}: pagination did not terminate within ${maxPages} pages`);
    items.push(...p.body.items);
    const next: string | null = p.body.nextCursor ?? null;
    if (next !== null) {
      assert(!seen.has(next), `${label}: pagination cursor repeated (${next}) — the pager does not advance`);
      seen.add(next);
    }
    cursor = next;
  } while (cursor);
  return { items, pages };
}

// ── Д3 (3.3б): доступный интервал и допуск окна ──────────────────────────────
//
// БУКВАЛЬНОЕ равенство real и mock достигается не сравнением двух живых
// серверов, а тем, что ОБА сверяются с одной таблицей ожиданий, которая живёт
// здесь. Совпасть с ней порознь — то же, что совпасть друг с другом, но
// проверяется каждой стороной у себя и не требует поднимать два бэкенда разом.
//
// Таблица выписана РУКАМИ. Возьми её из платформенной реализации — и харнесс
// краснел бы только вместе с ней, доказывая совпадение реализации с самой собой.

/** Состояние индекса, в которое вызывающий привёл цель перед прогоном. */
export type AvailabilityScenario = 'ready' | 'empty' | 'not_initialized' | 'invalid';

/** Статус и код отказа preflight для каждого состояния. Пять кодов, не один. */
export const PREFLIGHT_CONTRACT: Readonly<Record<AvailabilityScenario, { status: number; code: string | null }>> = {
  ready: { status: 200, code: null },
  empty: { status: 409, code: 'AVAILABILITY_EMPTY' },
  not_initialized: { status: 503, code: 'AVAILABILITY_NOT_INITIALIZED' },
  invalid: { status: 503, code: 'AVAILABILITY_INVALID' },
};

/** Точный набор полей успешного допуска. Лишнее поле — тоже расхождение. */
export const PREFLIGHT_SUCCESS_KEYS = [
  'archiveId', 'asOfMs', 'availabilityId', 'availableFromMs', 'availableToMs', 'clamped',
  'datasetId', 'earliestAvailableDay', 'effectiveFromMs', 'effectiveToMs',
  'lastContiguousClosedDay', 'ok', 'requestedFromMs', 'requestedToMs',
] as const;

/** Точный набор полей отказа. */
export const PREFLIGHT_REJECT_KEYS = ['availabilityState', 'code', 'message', 'ok'] as const;

const keysOf = (o: unknown): string[] => Object.keys((o ?? {}) as Record<string, unknown>).sort();

/**
 * Сверка контракта доступности для цели, приведённой в состояние `scenario`.
 *
 * Вызывающий обязан САМ привести цель в это состояние — харнесс проверяет, что
 * состояние наблюдаемо и что допуск ведёт себя ровно так, как записано в
 * таблице выше.
 */
export async function runAvailabilityConformance(
  t: HistoricalConformanceTarget,
  scenario: AvailabilityScenario,
): Promise<{ ok: true }> {
  const d = await getJson(t, '/historical/discover');
  assert(d.status === 200, `availability: discover status ${d.status}`);
  assert(
    d.body?.availability?.state === scenario,
    `availability: discover сообщает ${JSON.stringify(d.body?.availability?.state)}, ожидалось ${scenario}`,
  );

  const expected = PREFLIGHT_CONTRACT[scenario];
  // Окно заведомо широкое: при `ready` оно обрежется, при остальных состояниях
  // до обрезки дело не дойдёт вовсе.
  const pre = await getJson(t, '/historical/preflight?fromMs=0&toMs=9999999999999');
  assert(pre.status === expected.status, `preflight[${scenario}]: status ${pre.status}, ожидался ${expected.status}`);

  if (expected.code === null) {
    assert(pre.body?.ok === true, `preflight[${scenario}]: ok !== true`);
    assert(
      JSON.stringify(keysOf(pre.body)) === JSON.stringify([...PREFLIGHT_SUCCESS_KEYS].sort()),
      `preflight[ready]: набор полей ${keysOf(pre.body).join(',')}`,
    );
    assert(pre.body.clamped === true, 'preflight[ready]: заведомо широкое окно обязано быть обрезано');
    assert(
      pre.body.requestedFromMs === 0 && pre.body.requestedToMs === 9999999999999,
      'preflight[ready]: запрошенное окно обязано вернуться КАК БЫЛО',
    );
    assert(
      pre.body.effectiveFromMs >= pre.body.availableFromMs && pre.body.effectiveToMs <= pre.body.availableToMs,
      'preflight[ready]: фактическое окно вне доступного',
    );
    assert(/^sha256:[0-9a-f]{64}$/.test(String(pre.body.availabilityId)), 'preflight[ready]: availabilityId не содержательный');

    // Пустое пересечение — ОТКАЗ, а не успешный пустой ответ.
    const after = pre.body.availableToMs + 1;
    const out = await getJson(t, `/historical/preflight?fromMs=${after}&toMs=${after + 1000}`);
    assert(out.status === 409, `preflight[ready]: окно за границей дало ${out.status}, ожидался 409`);
    assert(out.body?.code === 'WINDOW_OUTSIDE_AVAILABLE', `preflight[ready]: код ${out.body?.code}`);
  } else {
    assert(pre.body?.ok === false, `preflight[${scenario}]: ok !== false`);
    assert(pre.body?.code === expected.code, `preflight[${scenario}]: код ${pre.body?.code}, ожидался ${expected.code}`);
    assert(pre.body?.availabilityState === scenario, `preflight[${scenario}]: availabilityState ${pre.body?.availabilityState}`);
    assert(
      JSON.stringify(keysOf(pre.body)) === JSON.stringify([...PREFLIGHT_REJECT_KEYS].sort()),
      `preflight[${scenario}]: набор полей ${keysOf(pre.body).join(',')}`,
    );
  }

  // Кривое окно — это про ЗАПРОС, и отвечает 400 в ЛЮБОМ состоянии индекса.
  // Иначе клиент с опечаткой в дате получал бы отказ про незавершённую выкатку.
  const bad = await getJson(t, '/historical/preflight?fromMs=нет&toMs=тоже');
  assert(bad.status === 400, `preflight[${scenario}]: кривое окно дало ${bad.status}, ожидался 400`);
  assert(bad.body?.code === 'WINDOW_MALFORMED', `preflight[${scenario}]: код кривого окна ${bad.body?.code}`);

  return { ok: true };
}

// ── Д3: целостность ключа дня ────────────────────────────────────────────────
//
// Контракт объявляет `(minute_ts, symbol)` тотальным порядком — на нём построен
// keyset-курсор. Дубль эту тотальность отменяет, и последствие не «минута
// приходит дважды», а хуже: курсор роняет вторую копию, если граница страницы
// легла между копиями, и возвращает, если не легла. Один запрос отдавал разное
// число строк при разном `limit`.
//
// Таблица ниже выписана РУКАМИ, как и preflight-таблица: взятая из реализации,
// она краснела бы только вместе с ней.

/** Ровно один статус и ровно один код. Не «какой-нибудь 4xx». */
export const DAY_INTEGRITY_CONTRACT = { status: 409, code: 'DUPLICATE_ROW_KEY' } as const;

/** Точный набор полей тела. Лишнее поле — тоже расхождение контракта. */
export const DAY_INTEGRITY_KEYS = [
  'code', 'date', 'error', 'generation', 'minuteTs', 'permanent', 'retryFromStart', 'symbol',
] as const;

/**
 * Сверка контракта целостности для цели, у которой В ИЗВЕСТНОМ ДНЕ есть две
 * строки с одним `(minute_ts, symbol)`.
 *
 * ОБЛАСТЬ ОТКАЗА — ДЕНЬ, А НЕ ЗАПРОС. Первая редакция этого харнесса требовала
 * обратного: она считала, что окно того же дня без стыка обязано отвечать 200.
 * Требование было ошибочным и развело две честные реализации — платформа грузит
 * закрытый день целиком и отказывала, мок фильтровал по окну и отвечал. Ни одна
 * не была неправа: расходился контракт, а не код.
 *
 * Недостоверен ДЕНЬ. Знание об этом не должно зависеть от того, какое окно и
 * какие символы спросили, иначе потребитель получает строки дня, о ложности
 * соседних строк в котором уже известно, и не узнаёт об этом.
 *
 * Вызывающий обязан САМ привести цель в это состояние и назвать адрес стыка.
 */
export async function runDayIntegrityConformance(
  t: HistoricalConformanceTarget,
  seam: {
    readonly symbol: string;
    readonly date: string;
    readonly minuteTs: number;
    /** Окно, накрывающее стык. */
    readonly fromMs: number;
    readonly toMs: number;
    /** Окно ТОГО ЖЕ дня, НЕ содержащее стыка. Обязано отказывать так же. */
    readonly sameDayCleanWindow?: { readonly fromMs: number; readonly toMs: number };
    /** Символ того же дня БЕЗ собственного дубля. Обязан отказывать: недостоверен день. */
    readonly otherSymbolSameDay?: string;
    /** Окно ДРУГОГО, заведомо исправного дня. Обязано отвечать 200. */
    readonly healthyOtherDay?: { readonly fromMs: number; readonly toMs: number };
  },
): Promise<{ ok: true }> {
  const q = (limit: number, from: number, to: number, symbol = seam.symbol): string =>
    `/historical/rows?symbols=${symbol}&fromMs=${from}&toMs=${to}&limit=${limit}`;

  const expectRejection = async (label: string, path: string): Promise<string> => {
    const r = await getJson(t, path);
    assert(
      r.status === DAY_INTEGRITY_CONTRACT.status,
      `day-integrity[${label}]: статус ${r.status}, ожидался ${DAY_INTEGRITY_CONTRACT.status}`,
    );
    assert(r.body?.code === DAY_INTEGRITY_CONTRACT.code, `day-integrity[${label}]: код ${JSON.stringify(r.body?.code)}`);
    assert(
      JSON.stringify(keysOf(r.body)) === JSON.stringify([...DAY_INTEGRITY_KEYS].sort()),
      `day-integrity[${label}]: набор полей ${keysOf(r.body).join(',')}`,
    );
    assert(r.body?.permanent === true, `day-integrity[${label}]: permanent !== true`);
    assert(r.body?.retryFromStart === false, `day-integrity[${label}]: retryFromStart !== false`);
    assert(
      r.body?.date === seam.date && r.body?.symbol === seam.symbol && r.body?.minuteTs === seam.minuteTs,
      `day-integrity[${label}]: адрес стыка ${r.body?.date}/${r.body?.symbol}/${r.body?.minuteTs}`,
    );
    return JSON.stringify(r.body);
  };

  // Позиция стыка внутри страницы харнессу неизвестна, поэтому берутся ЧЕТЫРЕ
  // разных `limit`. Именно расхождение между ними и было дефектом.
  const limits = [1, 2, 3, 1000];
  const seen: string[] = [];
  for (const lim of limits) seen.push(await expectRejection(`limit=${lim}`, q(lim, seam.fromMs, seam.toMs)));

  // ЯДРО: разные `limit` дают один и тот же ответ.
  assert(
    new Set(seen).size === 1,
    `day-integrity: ответ зависит от limit (${new Set(seen).size} различных ответов на ${limits.length} запросов)`,
  );

  // Чистое окно ТОГО ЖЕ дня — тот же отказ и то же тело. Отдать его значило бы
  // выдать строки дня, о недостоверности которого уже известно.
  if (seam.sameDayCleanWindow) {
    const body = await expectRejection(
      'same-day clean window',
      q(50, seam.sameDayCleanWindow.fromMs, seam.sameDayCleanWindow.toMs),
    );
    assert(body === seen[0], 'day-integrity: чистое окно того же дня ответило ИНАЧЕ, чем окно со стыком');
  }

  // Соседний символ того же дня — тоже отказ: недостоверен день, а не символ.
  if (seam.otherSymbolSameDay !== undefined) {
    await expectRejection(
      `other symbol ${seam.otherSymbolSameDay}`,
      q(50, seam.fromMs, seam.toMs, seam.otherSymbolSameDay),
    );
  }

  // А вот ДРУГОЙ день обязан отвечать. Без этого нельзя отличить работающий
  // инвариант от сервиса, отказывающего на всё подряд.
  if (seam.healthyOtherDay) {
    const r = await getJson(t, q(50, seam.healthyOtherDay.fromMs, seam.healthyOtherDay.toMs));
    assert(
      r.status === 200,
      `day-integrity: исправный ДРУГОЙ день дал ${r.status} — отказ обязан быть ограничен повреждённым днём`,
    );
    assert(Array.isArray(r.body?.items), 'day-integrity: исправный день не вернул items');
  }

  return { ok: true };
}

export async function runHistoricalConformance(
  t: HistoricalConformanceTarget,
  opts: {
    goldenRows?: readonly CanonicalRowV2[];
    /** Called for each check the dataset could not exercise. */
    onSkip?: (skip: HistoricalConformanceSkip) => void;
    /** Page budget per drained query; defaults to DEFAULT_MAX_PAGES. */
    maxPages?: number;
  } = {},
): Promise<{ ok: true }> {
  const skip = (check: string, reason: string): void => { opts.onSkip?.({ check, reason }); };
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  assert(Number.isInteger(maxPages) && maxPages > 0, `opts.maxPages must be a positive integer, got ${maxPages}`);
  // discover
  const d = await getJson(t, '/historical/discover');
  assert(d.status === 200, `discover status ${d.status}`);
  assert(d.body.historicalContractVersion === 'historical.2', `discover version ${d.body?.historicalContractVersion}`);
  assert(d.body.resources?.some((r: any) => r.name === 'rows' && r.availability === 'available'), 'discover missing rows resource');
  assert(d.body.capabilities?.readOnly === true && d.body.capabilities?.execution === false, 'capabilities not read-only');
  const symbol = d.body.symbols?.[0];
  assert(typeof symbol === 'string' && symbol.length > 0, 'discover has no symbols');

  // coverage
  const cov = await getJson(t, '/historical/coverage');
  assert(cov.status === 200 && Array.isArray(cov.body.entries), 'coverage shape');

  // rows: full set (explicit toMs)
  const full = await getJson(t, `/historical/rows?symbols=${symbol}&fromMs=0&toMs=9999999999999`);
  assert(full.status === 200 && Array.isArray(full.body.items), 'rows shape');
  assert(full.body.items.length > 0, 'rows empty for known symbol');
  for (const f of ROW_FIELDS) assert(f in full.body.items[0], `rows[0] missing field ${f}`);

  // rows: OPEN upper bound (NO toMs) — must NOT silently drop partitions (sentinel regression guard)
  const open = await getJson(t, `/historical/rows?symbols=${symbol}&fromMs=0`);
  assert(open.status === 200, `rows open-toMs status ${open.status}`);
  assert(open.body.items.length === full.body.items.length, `rows open-toMs dropped rows: ${open.body.items.length} != ${full.body.items.length}`);

  // rows: pagination
  const { items: acc, pages } = await drainRows(
    t,
    '/historical/rows?symbols=' + symbol + '&fromMs=0&toMs=9999999999999&limit=3',
    'pagination',
    maxPages,
  );
  assert(acc.length === full.body.items.length, `pagination total ${acc.length} != ${full.body.items.length}`);
  assert(pages > 1, 'pagination single page (limit=3 should split)');

  // rows: unknown symbol → empty, not 5xx
  const unk = await getJson(t, '/historical/rows?symbols=__NOPE__&fromMs=0&toMs=1');
  assert(unk.status === 200 && unk.body.items.length === 0, 'unknown symbol not graceful');

  // rows: range is HALF-OPEN [fromMs, toMs) — the bar at minute_ts == toMs is NOT returned.
  // Platform semantics: storage/historical/reader/query_filters (ts < from || ts >= to → skip).
  // An inclusive upper bound double-counts the boundary bar across adjacent walk-forward folds.
  if (full.body.items.length >= 2) {
    const t0 = tsOf(full.body.items[0]);
    const t1 = tsOf(full.body.items[1]);
    assert(Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0, 'rows not ascending by minute_ts');

    const halfOpen = await getJson(t, `/historical/rows?symbols=${symbol}&fromMs=${t0}&toMs=${t1}&limit=10`);
    assert(halfOpen.status === 200, `rows half-open range status ${halfOpen.status}`);
    const gotTs = halfOpen.body.items.map(tsOf);
    assert(gotTs.includes(t0), `range [${t0}, ${t1}) must include the fromMs bar`);
    assert(!gotTs.includes(t1), `range must be half-open [fromMs, toMs): boundary bar at minute_ts == toMs (${t1}) was returned`);
    assert(gotTs.length === 1, `range [${t0}, ${t1}) must contain exactly the fromMs bar, got ${gotTs.length}`);

    // Degenerate range [t, t) is empty, not a single-bar range.
    const degenerate = await getJson(t, `/historical/rows?symbols=${symbol}&fromMs=${t0}&toMs=${t0}&limit=10`);
    assert(degenerate.status === 200, `rows degenerate range status ${degenerate.status}`);
    assert(degenerate.body.items.length === 0, `empty range [${t0}, ${t0}) must return 0 rows, got ${degenerate.body.items.length}`);
  } else {
    skip('half-open-range', 'fewer than 2 rows for the probe symbol');
  }

  // rows: multi-symbol requests carry a GLOBAL total order (minute_ts ASC, symbol ASC),
  // not a per-symbol concatenation in request order.
  const discoverSymbols: string[] = Array.isArray(d.body.symbols)
    ? d.body.symbols.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const probed: Array<{ symbol: string; firstTs: number }> = [];
  for (const s of discoverSymbols.slice(0, 8)) {
    if (probed.length === 2) break;
    const probe = await getJson(t, `/historical/rows?symbols=${s}&fromMs=0&limit=1`);
    assert(probe.status === 200, `rows probe status ${probe.status} for ${s}`);
    const first = probe.body.items?.[0];
    if (first !== undefined) probed.push({ symbol: s, firstTs: tsOf(first) });
  }
  if (probed.length < 2) {
    skip('multi-symbol-ordering', `dataset exposes ${probed.length} symbol(s) with rows; need 2`);
  } else {
    // Bounded overlapping window so the assertion stays cheap on production-sized datasets.
    const windowFrom = Math.max(probed[0]!.firstTs, probed[1]!.firstTs);
    const windowTo = windowFrom + 10 * 60_000;
    // Request order is deliberately reversed relative to the sorted order: the response
    // must be sorted by the server, not echo the caller's symbol order.
    const pair = [probed[0]!.symbol, probed[1]!.symbol].sort().reverse();
    const { items } = await drainRows(
      t,
      `/historical/rows?symbols=${pair.join(',')}&fromMs=${windowFrom}&toMs=${windowTo}&limit=50`,
      'rows multi-symbol',
      maxPages,
    );
    const present = new Set(items.map((r: any) => r.symbol));
    if (present.size < 2) {
      skip('multi-symbol-ordering', `window [${windowFrom}, ${windowTo}) covers ${present.size} symbol(s)`);
    } else {
      for (let i = 1; i < items.length; i++) {
        const prev = items[i - 1];
        const cur = items[i];
        const ordered = tsOf(cur) > tsOf(prev)
          || (tsOf(cur) === tsOf(prev) && String(cur.symbol) > String(prev.symbol));
        assert(ordered, `multi-symbol rows must be globally ordered by (minute_ts ASC, symbol ASC): `
          + `(${tsOf(prev)}, ${prev.symbol}) then (${tsOf(cur)}, ${cur.symbol}) at index ${i}`);
      }
    }
  }

  // rows: limit / clamp semantics — a page never exceeds the requested limit, an
  // oversized limit clamps deterministically instead of erroring, and clamping is
  // lossless: the paginated union equals the unpaginated set either way.
  const fullQuery = `/historical/rows?symbols=${symbol}&fromMs=0&toMs=9999999999999`;
  for (const lim of [1, 2, 7]) {
    const page = await getJson(t, `${fullQuery}&limit=${lim}`);
    assert(page.status === 200, `rows limit=${lim} status ${page.status}`);
    assert(page.body.items.length <= lim, `rows limit=${lim} returned ${page.body.items.length} rows`);
    if (acc.length > lim) {
      // Over-filling breaks consumers (a page larger than they sized for); under-filling
      // is permitted — a keyset pager may legitimately return a short page — as long as
      // it hands back a cursor and makes progress.
      assert(page.body.items.length > 0, `rows limit=${lim} returned an empty non-final page`);
      assert(typeof page.body.nextCursor === 'string' && page.body.nextCursor.length > 0,
        `rows limit=${lim} must expose nextCursor while ${acc.length - lim} rows remain`);
    }
  }

  const OVERSIZED = 100_000;
  const big1 = await getJson(t, `${fullQuery}&limit=${OVERSIZED}`);
  const big2 = await getJson(t, `${fullQuery}&limit=${OVERSIZED}`);
  assert(big1.status === 200, `rows oversized limit must clamp, not fail: status ${big1.status}`);
  assert(big1.body.items.length <= OVERSIZED, 'rows oversized limit returned more rows than requested');
  assert(big1.body.items.length === big2.body.items.length,
    `rows clamp is not deterministic: ${big1.body.items.length} then ${big2.body.items.length}`);

  // An available rows resource must declare its page cap: historical.2 discover carries
  // pagination {cursor, maxPageItems}. A missing or nonsensical cap is a contract
  // violation by the target, not a limitation of its dataset — so it fails, never skips.
  const rowsResource = d.body.resources?.find((r: any) => r.name === 'rows');
  const maxPageItems = rowsResource?.pagination?.maxPageItems;
  assert(typeof maxPageItems === 'number' && Number.isFinite(maxPageItems) && maxPageItems > 0,
    `discover rows resource must declare pagination.maxPageItems, got ${JSON.stringify(maxPageItems)}`);
  // The clamp must honour that advertised cap — otherwise "clamped" is unfalsifiable:
  // any page size satisfies an oversized limit. Note that a *real* clamp cannot be
  // observed on a conformance-sized dataset (the harness also requires an unpaginated
  // request to return every row, so the dataset never exceeds the cap); what is asserted
  // here is the falsifiable half — the target never serves more than it advertises.
  assert(big1.body.items.length <= maxPageItems,
    `rows limit=${OVERSIZED} returned ${big1.body.items.length} rows, exceeding the declared maxPageItems ${maxPageItems}`);

  const drained = await drainRows(t, `${fullQuery}&limit=${OVERSIZED}`, 'rows oversized limit', maxPages);
  assert(drained.items.length === acc.length,
    `clamped pagination is lossy: ${drained.items.length} != ${acc.length}`);
  assert(drained.items.map(normalizeRow).join('\n') === acc.map(normalizeRow).join('\n'),
    'clamped pagination returned different rows than limit=3 pagination');

  // golden byte-identity
  if (opts.goldenRows && opts.goldenRows.length > 0) {
    const got = full.body.items.map((r: any) => normalizeRow(r)).join('\n');
    const want = opts.goldenRows.map((r) => normalizeRow(r as any)).join('\n');
    assert(got === want, 'golden byte-identity mismatch');
  }
  return { ok: true };
}
