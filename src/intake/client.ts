// @trdlabs/sdk/intake — transport-agnostic submit helper (feature 036, Phase 9 / T053).
// The consumer supplies an IntakeTransport; this core opens no network, owns no credentials, and holds
// no execution/deployment authority (FR-035). The optional reference HTTP adapter lives in the separate
// `@trdlabs/sdk/intake/http-transport` subpath and is never imported by this core.

import type { PaperCandidateIntakeRequest, PaperCandidateIntakeResult } from './dto.js';

/** Pluggable transport: submit one intake request, return the raw result envelope. Consumer-supplied. */
export interface IntakeTransport {
  submit(request: PaperCandidateIntakeRequest): Promise<unknown>;
}

/**
 * Submit a paper-candidate recommendation over a consumer-supplied transport. Idempotent by the
 * normalized `(source, idempotency_key)`; the response carries `idempotentReplay`. Returns the
 * discriminated `PaperCandidateIntakeResult` (rejected/quarantined are accepted verdicts with `ok:true`,
 * NOT errors). Pure passthrough — no network, no retries, no platform internals.
 */
export async function submitPaperCandidate(
  transport: IntakeTransport,
  request: PaperCandidateIntakeRequest,
): Promise<PaperCandidateIntakeResult> {
  return (await transport.submit(request)) as PaperCandidateIntakeResult;
}
