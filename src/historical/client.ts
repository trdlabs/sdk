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

export class HistoricalClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly pageLimit: number;

  constructor(opts: HistoricalClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    const rawFetch = opts.fetchImpl ?? globalThis.fetch;
    this.fetchImpl = opts.token
      ? (url, init) =>
          rawFetch(url, {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string> | undefined),
              Authorization: `Bearer ${opts.token}`,
            },
          })
      : rawFetch;
    this.pageLimit = opts.pageLimit ?? 500;
  }

  /** GET /historical/discover — historical.2 contract descriptor. */
  async discover(): Promise<HistoricalDiscoverResponse> {
    const res = await this.fetchImpl(`${this.base}/historical/discover`);
    if (!res.ok) throw new Error(`platform /historical/discover: HTTP ${res.status}`);
    return (await res.json()) as HistoricalDiscoverResponse;
  }

  /** GET /historical/coverage — per-(symbol,timeframe) availability snapshot. */
  async coverage(): Promise<HistoricalCoverageSnapshot> {
    const res = await this.fetchImpl(`${this.base}/historical/coverage`);
    if (!res.ok) throw new Error(`platform /historical/coverage: HTTP ${res.status}`);
    return (await res.json()) as HistoricalCoverageSnapshot;
  }

  /**
   * Paginates GET /historical/rows?symbols&fromMs&toMs&limit&cursor, yielding one page of
   * CanonicalRowV2 rows at a time. `symbols` is joined into a single CSV `symbols=` param.
   * `toMs` is omitted when undefined so the server applies its open upper bound; an empty
   * page is skipped but pagination continues until `nextCursor` is null.
   */
  async *queryRows(q: HistoricalRowsQuery): AsyncIterable<CanonicalRowV2[]> {
    let cursor: string | null = null;
    for (;;) {
      const params = new URLSearchParams({
        symbols: q.symbols.join(','),
        limit: String(this.pageLimit),
      });
      if (q.fromMs !== undefined) params.set('fromMs', String(q.fromMs));
      if (q.toMs !== undefined) params.set('toMs', String(q.toMs));
      if (cursor) params.set('cursor', cursor);

      const res = await this.fetchImpl(`${this.base}/historical/rows?${params.toString()}`);
      if (!res.ok) throw new Error(`platform /historical/rows: HTTP ${res.status}`);
      const page = (await res.json()) as PageEnvelope<CanonicalRowV2>;
      if (page.items.length > 0) yield page.items as CanonicalRowV2[];
      cursor = page.nextCursor;
      if (!cursor) return;
    }
  }
}
