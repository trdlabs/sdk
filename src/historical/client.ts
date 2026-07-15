// @trdlabs/sdk/historical — generic historical.2 HTTP client.
//
// Framework-agnostic, self-contained client over the platform's unified historical.2
// surface (/historical/discover, /historical/coverage, /historical/rows). Wire types are
// declared locally (no cross-repo imports); the client returns CanonicalRowV2 rows verbatim.
//
// Pagination / cursor / token handling mirrors the backtester's RowsReader + RowsDataPort:
//   - /historical/rows is paginated via an opaque base64url `nextCursor` echoed back as `cursor`;
//   - `token` is applied as an `Authorization: Bearer <token>` header on every request;
//   - `pageLimit` controls the `limit` query parameter (default 500).
// Consumers (e.g. the backtester) wrap this generic client in their own data-port adapter.
//
// P2-12 resilience: every request has a per-request timeout (AbortController) that spans BOTH the fetch
// and the body read/parse — a stalled body cannot wedge a consumer; a bounded retry (transient network /
// body-parse / 408 / 429 / 5xx only; 4xx-except-408/429 fail fast) with a deadline-capped backoff (a long
// Retry-After can't overshoot the operation deadline); and the /historical/rows cursor loop detects a
// repeated cursor and enforces max pages/rows fail-closed so an echoing upstream can't loop forever or
// exhaust memory. HTTP failures keep the `HTTP <status>` message so message-based classifiers still work.

import type { CanonicalRowV2 } from './canonical-row.js';

type FetchLike = typeof globalThis.fetch;

export interface HistoricalClientOptions {
  readonly baseUrl: string;
  /** Injectable fetch implementation (for tests). Defaults to globalThis.fetch. */
  readonly fetchImpl?: FetchLike;
  /** Rows per page when fetching /historical/rows. Default 500. */
  readonly pageLimit?: number;
  /** Bearer token for platform auth. */
  readonly token?: string;
  /** Per-request timeout (ms) — spans fetch + body read/parse. Default 30000. */
  readonly timeoutMs?: number;
  /** Total attempts per request including the first (1 = no retry). Default 3. */
  readonly maxAttempts?: number;
  /** Backoff base delay (ms), full jitter, doubled per attempt. Default 500. */
  readonly retryBaseMs?: number;
  /** Backoff ceiling (ms). Default 10000. */
  readonly retryMaxMs?: number;
  /** Fail-closed cap on pages fetched by a single queryRows. Default 10000. */
  readonly maxPages?: number;
  /** Fail-closed cap on rows accumulated by a single queryRows. Default 5_000_000. */
  readonly maxRows?: number;
  /** Optional operation deadline (ms) bounding a whole queryRows across pages+retries+sleeps. 0 = off. Default 0. */
  readonly operationDeadlineMs?: number;
  /** @internal test seam — replaces real backoff sleeping. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export interface HistoricalCoverageEntry {
  readonly symbol: string;
  readonly timeframe: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly barCount: number;
  readonly availability: string;
}

export interface HistoricalCoverageSnapshot {
  readonly entries: readonly HistoricalCoverageEntry[];
  readonly availability: string;
  /** Forward-compatible: server may emit additional snapshot-level fields. */
  readonly [key: string]: unknown;
}

export interface HistoricalResourceDescriptor {
  readonly name: string;
  readonly availability: string;
  /** Forward-compatible: server may emit additional descriptor fields. */
  readonly [key: string]: unknown;
}

export interface HistoricalDiscoverResponse {
  readonly historicalContractVersion: string;
  readonly resources: readonly HistoricalResourceDescriptor[];
  readonly symbols: readonly string[];
  readonly timeframes: readonly string[];
  readonly capabilities?: unknown;
  /** Forward-compatible: server may emit additional discovery fields. */
  readonly [key: string]: unknown;
}

interface PageEnvelope<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface HistoricalRowsQuery {
  readonly symbols: readonly string[];
  readonly fromMs?: number;
  readonly toMs?: number;
}

interface Resilience {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly maxPages: number;
  readonly maxRows: number;
  readonly operationDeadlineMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

const MAX_RETRY_AFTER_MS = 60_000;

function retryAfterMs(res: Response): number | undefined {
  const ra = res.headers?.get?.('retry-after');
  if (ra !== undefined && ra !== null && /^\d+$/.test(ra.trim())) {
    return Math.min(Number(ra.trim()) * 1000, MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

function backoffMs(attempt: number, r: Resilience): number {
  const exp = Math.min(r.retryMaxMs, r.retryBaseMs * 2 ** (attempt - 1));
  return Math.max(1, Math.floor(Math.random() * exp)); // full jitter
}

/** Sleep `ms`, but never past the operation deadline — a long Retry-After can't overshoot it. */
async function sleepBounded(ms: number, deadlineAt: number | undefined, r: Resilience): Promise<void> {
  const capped = deadlineAt !== undefined ? Math.min(ms, Math.max(0, deadlineAt - Date.now())) : ms;
  if (capped > 0) await r.sleep(capped);
}

/**
 * Fetch `url` with a per-request timeout spanning fetch + body read/parse, plus a bounded retry. All
 * historical.2 reads are GET (idempotent), so a network / timeout / body-parse error is retryable.
 * `readBody` false skips the body. HTTP failures throw `${label}: HTTP <status>`; timeouts throw
 * `${label}: timeout after <ms>ms`; deadline overrun throws `${label}: operation deadline exceeded`.
 */
async function resilientJson<T>(
  r: Resilience,
  url: string,
  label: string,
  deadlineAt: number | undefined,
  readBody: boolean,
): Promise<T | undefined> {
  let lastErr: Error = new Error(`${label}: request failed`);
  for (let attempt = 1; attempt <= r.maxAttempts; attempt += 1) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new Error(`${label}: operation deadline exceeded`);
    }
    const ctrl = new AbortController();
    let timedOut = false;
    const budget =
      deadlineAt !== undefined ? Math.min(r.timeoutMs, Math.max(1, deadlineAt - Date.now())) : r.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, budget);

    let outcome: { ok: true; body: T | undefined } | { ok: false; status: number; retryAfter?: number };
    try {
      const res = await r.fetchImpl(url, { signal: ctrl.signal });
      // The body read stays INSIDE the timer window: a stalled body aborts on the same signal.
      if (res.ok) outcome = { ok: true, body: readBody ? ((await res.json()) as T) : undefined };
      else outcome = { ok: false, status: res.status, retryAfter: res.status === 429 ? retryAfterMs(res) : undefined };
    } catch (err) {
      clearTimeout(timer);
      lastErr = timedOut
        ? new Error(`${label}: timeout after ${budget}ms`)
        : err instanceof Error
          ? err
          : new Error(`${label}: ${String(err)}`);
      if (attempt === r.maxAttempts) throw lastErr;
      await sleepBounded(backoffMs(attempt, r), deadlineAt, r);
      continue;
    }
    clearTimeout(timer);

    if (outcome.ok) return outcome.body;

    const status = outcome.status;
    const transient = status === 408 || status === 429 || (status >= 500 && status <= 599);
    if (!transient || attempt === r.maxAttempts) throw new Error(`${label}: HTTP ${status}`);
    lastErr = new Error(`${label}: HTTP ${status}`);
    await sleepBounded(outcome.retryAfter ?? backoffMs(attempt, r), deadlineAt, r);
  }
  throw lastErr;
}

export class HistoricalClient {
  private readonly base: string;
  private readonly pageLimit: number;
  private readonly r: Resilience;

  constructor(opts: HistoricalClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.pageLimit = opts.pageLimit ?? 500;
    const rawFetch = opts.fetchImpl ?? globalThis.fetch;
    const fetchImpl: FetchLike = opts.token
      ? (url, init) =>
          rawFetch(url, {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string> | undefined),
              Authorization: `Bearer ${opts.token}`,
            },
          })
      : rawFetch;
    this.r = {
      fetchImpl,
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxAttempts: opts.maxAttempts ?? 3,
      retryBaseMs: opts.retryBaseMs ?? 500,
      retryMaxMs: opts.retryMaxMs ?? 10_000,
      maxPages: opts.maxPages ?? 10_000,
      maxRows: opts.maxRows ?? 5_000_000,
      operationDeadlineMs: opts.operationDeadlineMs ?? 0,
      sleep: opts.sleepImpl ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms))),
    };
  }

  /** GET /historical/discover — historical.2 contract descriptor. */
  async discover(): Promise<HistoricalDiscoverResponse> {
    return (await resilientJson<HistoricalDiscoverResponse>(
      this.r,
      `${this.base}/historical/discover`,
      'platform /historical/discover',
      undefined,
      true,
    ))!;
  }

  /** GET /historical/coverage — per-(symbol,timeframe) availability snapshot. */
  async coverage(): Promise<HistoricalCoverageSnapshot> {
    return (await resilientJson<HistoricalCoverageSnapshot>(
      this.r,
      `${this.base}/historical/coverage`,
      'platform /historical/coverage',
      undefined,
      true,
    ))!;
  }

  /**
   * Paginates GET /historical/rows?symbols&fromMs&toMs&limit&cursor, yielding one page of
   * CanonicalRowV2 rows at a time. `symbols` is joined into a single CSV `symbols=` param.
   * `toMs` is omitted when undefined so the server applies its open upper bound; an empty
   * page is skipped but pagination continues until `nextCursor` is null. A repeated cursor,
   * or exceeding maxPages/maxRows/the operation deadline, fails closed rather than looping.
   */
  async *queryRows(q: HistoricalRowsQuery): AsyncIterable<CanonicalRowV2[]> {
    const deadlineAt = this.r.operationDeadlineMs > 0 ? Date.now() + this.r.operationDeadlineMs : undefined;
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let rows = 0;
    for (;;) {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        throw new Error('platform /historical/rows: operation deadline exceeded');
      }
      const params = new URLSearchParams({
        symbols: q.symbols.join(','),
        limit: String(this.pageLimit),
      });
      if (q.fromMs !== undefined) params.set('fromMs', String(q.fromMs));
      if (q.toMs !== undefined) params.set('toMs', String(q.toMs));
      if (cursor) params.set('cursor', cursor);

      const page = (await resilientJson<PageEnvelope<CanonicalRowV2>>(
        this.r,
        `${this.base}/historical/rows?${params.toString()}`,
        'platform /historical/rows',
        deadlineAt,
        true,
      ))!;

      pages += 1;
      if (pages > this.r.maxPages) throw new Error(`platform /historical/rows: exceeded maxPages ${this.r.maxPages}`);
      rows += page.items.length;
      if (rows > this.r.maxRows) throw new Error(`platform /historical/rows: exceeded maxRows ${this.r.maxRows}`);

      if (page.items.length > 0) yield page.items as CanonicalRowV2[];
      const next = page.nextCursor;
      if (!next) return;
      if (next === cursor || seen.has(next)) throw new Error('platform /historical/rows: pagination cycle');
      seen.add(next);
      cursor = next;
    }
  }
}
