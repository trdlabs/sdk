// @trdlabs/sdk/intake/http-transport — reference HTTP adapter (feature 036, Phase 9 / T054).
//
// Required, isolated, opt-in subpath: part of the package, but the core (`@trdlabs/sdk/intake`)
// never imports it. Adapts the platform HTTP intake endpoint (POST /intake/paper-candidate) into an
// IntakeTransport using the GLOBAL `fetch` (or an injected FetchLike) — NO axios/ws/hono, no platform
// internals, no host paths (LANDMINE verify_034_forbidden_scan). Owns no execution/deployment authority.

import type { IntakeTransport } from './client.js';
import type { PaperCandidateIntakeRequest } from './dto.js';

/** Minimal structural shape of `fetch` — avoids depending on DOM/undici lib types. */
export type FetchLike = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

export interface HttpIntakeTransportOptions {
  /** Base URL of the intake process (e.g. http://127.0.0.1:8840). */
  readonly baseUrl: string;
  /** Optional bearer token (required when the intake surface has a hashed-token allowlist). */
  readonly token?: string;
  /** Injectable fetch (testing); defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

function resolveFetch(injected?: FetchLike): FetchLike {
  if (injected) return injected;
  const g = (globalThis as { readonly fetch?: unknown }).fetch;
  if (typeof g !== 'function') {
    throw new Error('global fetch is not available in this runtime; pass opts.fetch');
  }
  return g as FetchLike;
}

/** Build an `IntakeTransport` over the platform HTTP intake endpoint (global `fetch`). */
export function createHttpIntakeTransport(opts: HttpIntakeTransportOptions): IntakeTransport {
  const doFetch = resolveFetch(opts.fetch);
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/intake/paper-candidate`;
  return {
    async submit(request: PaperCandidateIntakeRequest): Promise<unknown> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(request) });
      // The intake surface returns the result envelope (200/201/400/401/409/500) as the JSON body.
      return res.json();
    },
  };
}
