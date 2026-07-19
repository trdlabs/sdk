// mock-contract-parity item 4 — the conformance harness's own regression suite.
// A reference server implements the platform's published historical.2 semantics; each test
// injects exactly one divergence and asserts the harness catches it. Without this, the new
// harness assertions would only ever execute in a downstream repo's CI.
// Run: npx tsx --test test/historical-conformance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  runHistoricalConformance,
  type HistoricalConformanceSkip,
} from '../conformance/historical.conformance.js';

/** Divergences the reference server can be told to exhibit — one per known parity gap. */
type Divergence =
  | 'inclusive-to-ms' // audit P0-1: [fromMs, toMs] instead of [fromMs, toMs)
  | 'per-symbol-concat' // audit P1-1: rows concatenated per symbol in request order
  | 'limit-ignored' // page larger than the requested limit (only at limit=1, so the
                    // pre-existing limit=3 pagination assertion still passes and the
                    // new limit assertion is what catches it)
  | 'clamp-lossy' // oversized limit clamps by dropping rows instead of paginating
  | 'clamp-ignored' // serves a page larger than the maxPageItems it advertises
  | 'no-max-page-items' // available rows resource without the mandatory page cap
  | 'cursor-cycle' // hands back the same cursor forever
  | 'cursor-advancing'; // hands back a fresh cursor forever — the repeat check cannot see it

const MINUTE = 60_000;
const T0 = 1_735_776_000_000;
const ROWS_PER_SYMBOL = 7;
const REFERENCE_MAX_PAGE = 500;

function row(symbol: string, i: number): Record<string, unknown> {
  return {
    schema_version: 2,
    minute_ts: T0 + i * MINUTE,
    symbol,
    open: '100', high: '101', low: '99', close: '100.5',
    volume: '10', turnover: '1000',
    oi_total_usd: '5000', funding_rate: '0.0001',
    liq_long_usd: '0', liq_short_usd: '0',
    has_oi: true, has_funding: true, has_liquidations: false,
    taker_buy_volume_usd: '600', taker_sell_volume_usd: '400', has_taker_flow: true,
  };
}

interface ReferenceOptions {
  readonly symbols: readonly string[];
  readonly divergence?: Divergence;
}

/** Reference implementation of the platform historical.2 read surface. */
function startReference(opts: ReferenceOptions): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { symbols, divergence } = opts;
  const bySymbol = new Map(
    symbols.map((s) => [s, Array.from({ length: ROWS_PER_SYMBOL }, (_, i) => row(s, i))] as const),
  );

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/historical/discover') {
      // 'clamp-ignored' advertises a cap below the dataset size and then serves past it.
      // A coherent target cannot show a real clamp on a conformance-sized dataset (the
      // harness also requires an unpaginated request to return everything), so the
      // falsifiable property is "never serve more than you advertise".
      const declaredMaxPageItems = divergence === 'clamp-ignored' ? 3 : REFERENCE_MAX_PAGE;
      const pagination = divergence === 'no-max-page-items'
        ? { cursor: true }
        : { cursor: true, maxPageItems: declaredMaxPageItems };
      return json(200, {
        historicalContractVersion: 'historical.2',
        capabilities: { readOnly: true, execution: false, mutation: false, liveIngestion: false },
        resources: [{ name: 'rows', availability: 'available', pagination }],
        symbols: [...symbols],
        timeframes: ['1m'],
      });
    }

    if (url.pathname === '/historical/coverage') {
      return json(200, {
        entries: symbols.map((s) => ({
          symbol: s, timeframe: '1m',
          fromMs: T0, toMs: T0 + (ROWS_PER_SYMBOL - 1) * MINUTE,
        })),
      });
    }

    if (url.pathname !== '/historical/rows') return json(404, { error: 'not found' });

    const requested = (url.searchParams.get('symbols') ?? '').split(',').filter((s) => s.length > 0);
    const fromParam = url.searchParams.get('fromMs');
    const toParam = url.searchParams.get('toMs');
    const fromMs = fromParam === null ? Number.NEGATIVE_INFINITY : Number(fromParam);
    const toMs = toParam === null ? Number.POSITIVE_INFINITY : Number(toParam);

    const inWindow = (r: Record<string, unknown>): boolean => {
      const ts = r.minute_ts as number;
      // Published contract: half-open [fromMs, toMs).
      return ts >= fromMs && (divergence === 'inclusive-to-ms' ? ts <= toMs : ts < toMs);
    };

    let matched: Array<Record<string, unknown>> = [];
    for (const s of requested) matched.push(...(bySymbol.get(s) ?? []).filter(inWindow));
    if (divergence !== 'per-symbol-concat') {
      // Published contract: one global total order across all requested symbols.
      matched = matched.sort((a, b) =>
        (a.minute_ts as number) - (b.minute_ts as number)
        || String(a.symbol).localeCompare(String(b.symbol)));
    }

    const rawLimit = Number(url.searchParams.get('limit') ?? REFERENCE_MAX_PAGE);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, rawLimit), REFERENCE_MAX_PAGE)
      : REFERENCE_MAX_PAGE;
    // 'c'-prefixed cursors come from the cursor-advancing mode below; plain ones are offsets.
    const offset = Number((url.searchParams.get('cursor') ?? '0').replace(/^c/, '')) || 0;

    if (divergence === 'clamp-lossy' && rawLimit > REFERENCE_MAX_PAGE) {
      // Clamps by truncating the result set instead of paginating it.
      return json(200, { items: matched.slice(0, 1), nextCursor: null });
    }
    const pageSize = divergence === 'limit-ignored' && rawLimit === 1 ? limit + 1 : limit;
    const items = matched.slice(offset, offset + pageSize);
    if (divergence === 'cursor-cycle' && matched.length > pageSize) {
      return json(200, { items, nextCursor: 'stuck' });
    }
    if (divergence === 'cursor-advancing') {
      // Never repeats and never terminates — only the page budget stops this.
      return json(200, { items: matched.slice(0, 1), nextCursor: `c${offset + 1}` });
    }
    const next = offset + pageSize < matched.length ? String(offset + pageSize) : null;
    return json(200, { items, nextCursor: next });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function runAgainst(
  opts: ReferenceOptions,
  harnessOpts: { maxPages?: number } = {},
): Promise<{ skips: HistoricalConformanceSkip[] }> {
  const ref = await startReference(opts);
  const skips: HistoricalConformanceSkip[] = [];
  try {
    const result = await runHistoricalConformance(
      { baseUrl: ref.baseUrl },
      { onSkip: (s) => skips.push(s), ...harnessOpts },
    );
    assert.deepEqual(result, { ok: true });
    return { skips };
  } finally {
    await ref.close();
  }
}

async function expectRejection(
  opts: ReferenceOptions,
  pattern: RegExp,
  harnessOpts: { maxPages?: number } = {},
): Promise<void> {
  await assert.rejects(() => runAgainst(opts, harnessOpts), pattern);
}

const TWO_SYMBOLS = ['AAAUSDT', 'BTCUSDT'] as const;

// A skip means "this target's dataset could not exercise the check" and nothing else, so
// a downstream gate can fail on any non-empty skip list. Structural limits that hold for
// every conformance fixture (a real clamp is unobservable while the dataset fits inside
// the advertised cap) are not skips — the falsifiable half of that check is asserted.
test('conforming target passes and skips nothing', async () => {
  const { skips } = await runAgainst({ symbols: TWO_SYMBOLS });
  assert.deepEqual(skips, []);
});

test('inclusive toMs is rejected: the range must be half-open [fromMs, toMs)', async () => {
  await expectRejection({ symbols: TWO_SYMBOLS, divergence: 'inclusive-to-ms' }, /half-open \[fromMs, toMs\)/);
});

test('per-symbol concatenation is rejected: rows must be globally (minute_ts ASC, symbol ASC)', async () => {
  await expectRejection({ symbols: TWO_SYMBOLS, divergence: 'per-symbol-concat' }, /globally ordered by \(minute_ts ASC, symbol ASC\)/);
});

test('a page larger than the requested limit is rejected', async () => {
  await expectRejection({ symbols: TWO_SYMBOLS, divergence: 'limit-ignored' }, /rows limit=1 returned/);
});

test('clamping an oversized limit by dropping rows is rejected', async () => {
  await expectRejection({ symbols: TWO_SYMBOLS, divergence: 'clamp-lossy' }, /clamped pagination is lossy/);
});

test('serving a page larger than the advertised maxPageItems is rejected', async () => {
  await expectRejection({ symbols: TWO_SYMBOLS, divergence: 'clamp-ignored' }, /exceeding the declared maxPageItems 3/);
});

test('an available rows resource without a declared maxPageItems is rejected, not skipped', async () => {
  await expectRejection({ symbols: TWO_SYMBOLS, divergence: 'no-max-page-items' }, /must declare pagination\.maxPageItems, got undefined/);
});

test('a pager that repeats its cursor is rejected instead of looping', async () => {
  await expectRejection({ symbols: TWO_SYMBOLS, divergence: 'cursor-cycle' }, /cursor repeated \(stuck\) — the pager does not advance/);
});

// Budget lowered from the 10 000-page default purely to keep the test fast — the guard
// under test is the budget itself, not its default value.
test('a pager that advances forever is bounded by the page budget', async () => {
  await expectRejection(
    { symbols: TWO_SYMBOLS, divergence: 'cursor-advancing' },
    /pagination did not terminate within 5 pages/,
    { maxPages: 5 },
  );
});

test('a nonsensical page budget is rejected outright', async () => {
  await expectRejection({ symbols: TWO_SYMBOLS }, /maxPages must be a positive integer, got 0/, { maxPages: 0 });
});

test('a single-symbol dataset reports the ordering check as skipped, not as passed', async () => {
  const { skips } = await runAgainst({ symbols: ['BTCUSDT'] });
  assert.deepEqual(skips, [
    { check: 'multi-symbol-ordering', reason: 'dataset exposes 1 symbol(s) with rows; need 2' },
  ]);
});
