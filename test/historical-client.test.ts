// P2-12 — HistoricalClient resilience: per-request timeout (spanning body), bounded retry, deadline-capped
// backoff, cursor-cycle detection, fail-closed max pages/rows. Run: npx tsx --test test/historical-client.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoricalClient, type HistoricalClientOptions } from '../src/historical/client.js';

type Fetch = typeof globalThis.fetch;

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  } as unknown as Response;
}

const noSleep = async (): Promise<void> => {};

function client(fetchImpl: Fetch, over: Partial<HistoricalClientOptions> = {}): HistoricalClient {
  return new HistoricalClient({
    baseUrl: 'http://plat.test',
    fetchImpl,
    sleepImpl: noSleep,
    timeoutMs: 15,
    maxAttempts: 3,
    maxPages: 5,
    maxRows: 10,
    ...over,
  });
}

const rowsEnvelope = (n: number, nextCursor: string | null) => ({
  items: Array.from({ length: n }, (_, i) => ({ symbol: 'BTCUSDT', minute_ts: i })),
  nextCursor,
});

async function drainRows(c: HistoricalClient): Promise<number> {
  let rows = 0;
  for await (const page of c.queryRows({ symbols: ['BTCUSDT'], fromMs: 0, toMs: 100 })) rows += page.length;
  return rows;
}

test('discover: turns a hung fetch into a timeout error, not a hang', async () => {
  const hang: Fetch = ((_u: unknown, init?: RequestInit) =>
    new Promise((_r, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })) as Fetch;
  await assert.rejects(client(hang).discover(), /timeout/);
});

test('discover: times out a hung response BODY (not just headers)', async () => {
  const bodyHang: Fetch = ((_u: unknown, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_r, rej) => {
          init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        }),
      text: async () => '',
      headers: { get: () => null },
    } as unknown as Response)) as Fetch;
  await assert.rejects(client(bodyHang).discover(), /timeout/);
});

test('discover: recovers after a transient 503 within the attempt budget', async () => {
  let n = 0;
  const f: Fetch = (async () => (++n === 1 ? res(503, {}) : res(200, { historicalContractVersion: 'historical.2' }))) as Fetch;
  const out = await client(f).discover();
  assert.equal(out.historicalContractVersion, 'historical.2');
  assert.equal(n, 2);
});

test('discover: does not retry a 4xx and preserves the HTTP status message', async () => {
  let n = 0;
  const f: Fetch = (async () => (n++, res(401, {}))) as Fetch;
  await assert.rejects(client(f).discover(), /HTTP 401/);
  assert.equal(n, 1);
});

test('queryRows: detects a repeated cursor as a pagination cycle', async () => {
  const f: Fetch = (async () => res(200, rowsEnvelope(1, 'STUCK'))) as Fetch;
  await assert.rejects(drainRows(client(f)), /pagination cycle/);
});

test('queryRows: fails closed when total rows exceed maxRows', async () => {
  const f: Fetch = (async (u: unknown) => {
    const cur = new URL(String(u)).searchParams.get('cursor') ?? '0';
    return res(200, rowsEnvelope(4, `c${Number(cur) + 1}`));
  }) as Fetch;
  await assert.rejects(drainRows(client(f, { maxRows: 6, maxPages: 1_000 })), /maxRows/);
});

test('queryRows: caps a Retry-After sleep to the remaining operation deadline', async () => {
  const sleeps: number[] = [];
  const f: Fetch = (async () => res(429, {}, { 'retry-after': '60' })) as Fetch;
  await assert.rejects(
    drainRows(
      client(f, {
        operationDeadlineMs: 30,
        maxAttempts: 5,
        sleepImpl: async (ms: number) => {
          sleeps.push(ms);
          await new Promise((r) => setTimeout(r, ms));
        },
      }),
    ),
    /deadline|timeout/,
  );
  assert.ok(Math.max(0, ...sleeps) <= 35, `expected capped sleep <=35, got ${Math.max(0, ...sleeps)}`);
});
