// Переиспользуемый conformance-харнес контракта historical.2. given baseUrl → проверки.
// Юнит, который извлечёт Инициатива #2 (@trdlabs/sdk).
import type { CanonicalRowV2 } from '@trdlabs/sdk/historical';

export interface HistoricalConformanceTarget { readonly baseUrl: string; readonly token?: string }

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

export async function runHistoricalConformance(
  t: HistoricalConformanceTarget,
  opts: { goldenRows?: readonly CanonicalRowV2[] } = {},
): Promise<{ ok: true }> {
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
  const acc: any[] = []; let cursor: string | null = null; let pages = 0;
  do {
    const qp = `/historical/rows?symbols=${symbol}&fromMs=0&toMs=9999999999999&limit=3${cursor ? `&cursor=${cursor}` : ''}`;
    const p = await getJson(t, qp);
    pages++; acc.push(...p.body.items); cursor = p.body.nextCursor;
  } while (cursor);
  assert(acc.length === full.body.items.length, `pagination total ${acc.length} != ${full.body.items.length}`);
  assert(pages > 1, 'pagination single page (limit=3 should split)');

  // rows: unknown symbol → empty, not 5xx
  const unk = await getJson(t, '/historical/rows?symbols=__NOPE__&fromMs=0&toMs=1');
  assert(unk.status === 200 && unk.body.items.length === 0, 'unknown symbol not graceful');

  // golden byte-identity
  if (opts.goldenRows && opts.goldenRows.length > 0) {
    const got = full.body.items.map((r: any) => normalizeRow(r)).join('\n');
    const want = opts.goldenRows.map((r) => normalizeRow(r as any)).join('\n');
    assert(got === want, 'golden byte-identity mismatch');
  }
  return { ok: true };
}
