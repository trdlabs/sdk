// Fail-closed post-publish gate: proceed to the secondary git tag / release note ONLY
// when the npm registry *confirms* build-provenance attestations exist for the exact
// package@version this job just published.
//
// Why this exists (and why a green "Publish to npm with provenance" step is not enough):
// `npm publish --provenance` mints the attestation via a GitHub OIDC exchange as a SIDE
// EFFECT of publishing — a failed OIDC exchange does not make `npm publish` itself exit
// non-zero. This happened for real in the sibling package `@trdlabs/engine`: the publish
// step logged success, the attestation silently never generated, and nobody noticed until
// after the release shipped. npm is immutable per version — the only fix was forward, a
// new version. The class of defect is a step that ASSERTS a guarantee (provenance was
// requested, the command exited 0) instead of VERIFYING it (the registry actually holds
// an attestation for this version). This script asks the registry, the same question
// `npm audit signatures` / npmjs.com's own provenance badge answer from: does
// `dist.attestations` exist for this exact version on the registry — not "did the
// previous step's log look fine".
//
// `npm view <pkg>@<version> dist --json` is used over `npm audit signatures` because the
// latter verifies whatever is on disk/in the lockfile (registry *signatures*, which
// essentially every package has); it isn't scoped to "this one just-published version"
// and doesn't surface `provenance.predicateType` (the SLSA build attestation --provenance
// actually adds). It is used over a raw HTTP call to the attestations endpoint because it
// reuses the same authenticated registry client (and any configured registry URL) that
// `npm publish` itself just used, rather than hardcoding `registry.npmjs.org`.
//
// Mirrors the fail-closed shape of scripts/assert-version-publishable.ts: any outcome that
// is not a *confirmed* "attestations present" — a confirmed absence, a parse failure, or
// any registry/network/auth error — is treated as NOT attested. A naive
// `npm view … dist.attestations.url || true` would misread "field is empty because the
// command errored" as "field is empty because there is no attestation", which is exactly
// the false-negative this script exists to avoid.
//
// Follow-up after the live 0.14.0 release (2026-08-06): the gate above is fail-closed for
// a reason — but it was ALSO fail-closed on a state that isn't actually terminal. Publish
// succeeded, provenance was minted, and this script's very first `npm view` landed before
// the registry replica had propagated the new version's `dist.attestations` — a genuinely
// `indeterminate` read (see classifyAttestations below), and the gate correctly refused to
// tag. But refusing to tag treated "not yet visible" the same as "never coming" and dropped
// straight to a hard failure requiring a human to hand-verify
// (`npm audit signatures`/`dist.attestations.provenance.predicateType`) and tag manually.
// npm registry replication lag is a KNOWN, TRANSIENT condition that resolves in seconds —
// treating it as terminal on the first read fails the release on ordinary network
// propagation, and a gate that goes red on ordinary behavior trains people to ignore it,
// which stops it being a gate. The fix is a BOUNDED retry — see resolveAttestationOutcome
// below — that is still fail-closed: it retries ONLY `indeterminate` (never `missing`,
// which is a confirmed answer, not an open question), for a small fixed number of attempts,
// and still fails closed once that budget is exhausted.
//
// Usage: tsx scripts/assert-provenance-attested.ts <pkg> <version>
// Exit:  0 = attestations confirmed present · 1 = confirmed absent OR indeterminate
//        (including "still indeterminate after exhausting the retry budget").
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface NpmViewDistResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type AttestationOutcome = 'attested' | 'missing' | 'indeterminate';

interface NpmDistShape {
  readonly attestations?: {
    readonly url?: unknown;
    readonly provenance?: {
      readonly predicateType?: unknown;
    };
  };
}

/** Pure classifier over an `npm view <pkg>@<version> dist --json` invocation. */
export function classifyAttestations(r: NpmViewDistResult): AttestationOutcome {
  // Any non-zero exit (registry E404 propagation lag right after publish, DNS, auth,
  // rate-limit, 5xx, timeout) is NOT evidence of absence. This runs moments after the
  // same job published the version, so it must exist; an error here means the question
  // could not be answered, not that the answer is "no attestations".
  if (r.status !== 0) return 'indeterminate';

  const out = r.stdout.trim();
  if (out.length === 0) return 'indeterminate';

  let dist: NpmDistShape;
  try {
    dist = JSON.parse(out) as NpmDistShape;
  } catch {
    // Non-JSON stdout (npm warning banners mixed into the stream, truncated output, a
    // registry proxy returning HTML on error) — the claim can't be read either way.
    return 'indeterminate';
  }

  // `JSON.parse` accepts the literal `null` as valid input — status 0, parses cleanly, but
  // `dist` is then `null`, not an object. Reading `dist.attestations` off of `null` throws a
  // TypeError (unlike a primitive such as a number or string, whose properties are simply
  // `undefined`); the `?.` below only guards `.url`/`.provenance`, not this first property
  // access. Without this check that throw was left to escape `main()` uncaught, which happened
  // to still exit 1 (Node's default handling of an uncaught exception) — the right EXIT CODE by
  // accident of runtime semantics, not by this script's design, and with an unhandled-exception
  // stack trace instead of the intended diagnostic message. `typeof dist !== 'object'` also
  // catches every other non-object top-level JSON value (number, string, boolean) the same way,
  // as unreadable rather than a confirmed shape. Treat it all like unparsable output:
  // indeterminate, not a confirmed "missing".
  if (dist === null || typeof dist !== 'object') return 'indeterminate';

  const url = dist.attestations?.url;
  const predicateType = dist.attestations?.provenance?.predicateType;
  const hasUrl = typeof url === 'string' && url.length > 0;
  const hasPredicate = typeof predicateType === 'string' && predicateType.length > 0;

  // Both fields must be present and non-empty: this is the real published-without-
  // attestations shape (see left-pad@1.3.0 for a live example — `dist` exists, `dist.
  // attestations` does not), and it is a clean, confirmed "no" — not indeterminate.
  return hasUrl && hasPredicate ? 'attested' : 'missing';
}

export function runNpmViewDist(spec: string): NpmViewDistResult {
  const r = spawnSync('npm', ['view', spec, 'dist', '--json'], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ── Bounded retry on `indeterminate` only ──────────────────────────────────────────────
//
// Named, justified constants — not magic numbers inline — per the fail-closed discipline
// this file already follows for everything else.

/**
 * Total attempts at reading the registry (including the first), before giving up and
 * failing closed on a persistent `indeterminate`. Registry replication lag after a fresh
 * `npm publish` is a propagation delay measured in seconds, not minutes (this is what was
 * observed on the live 0.14.0 release); MAX_ATTEMPTS × RETRY_DELAY_MS below gives a wait
 * budget comfortably above that without blocking the release job indefinitely on a
 * genuinely stuck registry.
 */
export const PROVENANCE_ATTESTATION_MAX_ATTEMPTS = 5;

/** Pause between retry attempts, in milliseconds. Total worst-case added wait is bounded
 *  at (PROVENANCE_ATTESTATION_MAX_ATTEMPTS - 1) × this value = 12s. */
export const PROVENANCE_ATTESTATION_RETRY_DELAY_MS = 3_000;

export interface RetryOptions {
  /** Total attempts including the first; must be >= 1. */
  readonly maxAttempts: number;
  /** Pause between attempts, in milliseconds. */
  readonly delayMs: number;
  /** Injected so tests can resolve instantly instead of waiting on a real timer. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Injected so tests can assert on retry reasoning without printing to the real console. */
  readonly log: (message: string) => void;
}

export interface RetryResult {
  readonly outcome: AttestationOutcome;
  readonly attempts: number;
}

/**
 * Retries `check()` ONLY while it reports `indeterminate`. `missing` and `attested` are
 * both confirmed answers — read once, returned immediately, never retried: retrying
 * `missing` would blur "the registry answered no" into "we couldn't get an answer yet",
 * which is exactly the false-negative/false-positive confusion this whole gate exists to
 * prevent. Every retried attempt logs why (so a failed build shows whether the retry
 * budget was exhausted or a `missing` short-circuited it — see the "without extra calls"
 * test in test/assert-provenance-attested.test.ts). Fully unit-testable without a network
 * or real timers: `check` and `sleep` are both injected.
 */
export async function resolveAttestationOutcome(
  check: () => AttestationOutcome | Promise<AttestationOutcome>,
  opts: RetryOptions,
): Promise<RetryResult> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    const outcome = await check();
    if (outcome !== 'indeterminate') {
      return { outcome, attempts: attempt };
    }
    if (attempt === opts.maxAttempts) {
      opts.log(
        `::warning::provenance check attempt ${attempt}/${opts.maxAttempts} was ` +
          `indeterminate; retry budget exhausted — failing closed.`,
      );
      return { outcome, attempts: attempt };
    }
    opts.log(
      `::warning::provenance check attempt ${attempt}/${opts.maxAttempts} was indeterminate ` +
        `(registry likely hasn't finished replicating yet) — retrying in ${opts.delayMs}ms.`,
    );
    await opts.sleep(opts.delayMs);
  }
  // Unreachable: the loop always returns by the maxAttempts-th iteration above (maxAttempts
  // >= 1 for both call sites in this file).
  throw new Error('resolveAttestationOutcome: exhausted attempts without returning');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(argv: readonly string[]): Promise<number> {
  const [pkg, version] = argv;
  if (!pkg || !version) {
    console.error('Usage: tsx scripts/assert-provenance-attested.ts <pkg> <version>');
    return 1;
  }
  const spec = `${pkg}@${version}`;
  const { outcome, attempts } = await resolveAttestationOutcome(
    () => classifyAttestations(runNpmViewDist(spec)),
    {
      maxAttempts: PROVENANCE_ATTESTATION_MAX_ATTEMPTS,
      delayMs: PROVENANCE_ATTESTATION_RETRY_DELAY_MS,
      sleep: delay,
      log: (message) => console.error(message),
    },
  );
  switch (outcome) {
    case 'attested':
      console.log(
        `OK   ${spec} carries confirmed provenance attestations on the npm registry ` +
          `(confirmed on attempt ${attempts}/${PROVENANCE_ATTESTATION_MAX_ATTEMPTS}).`,
      );
      return 0;
    case 'missing':
      console.error(
        `::error::${spec} was published but the npm registry reports NO provenance ` +
          `attestations (dist.attestations absent or incomplete). The publish step exiting ` +
          `0 did not guarantee the OIDC attestation exchange actually succeeded — this is the ` +
          `exact failure mode observed in @trdlabs/engine. Refusing to create the git tag / ` +
          `release note for a version the registry cannot attest to. npm is immutable: this ` +
          `version cannot be fixed in place, only superseded by the next one. (Confirmed absent ` +
          `on the first read — a confirmed "no" is never retried.)`,
      );
      return 1;
    case 'indeterminate':
      console.error(
        `::error::Could not confirm attestation status for ${spec} after ${attempts}/` +
          `${PROVENANCE_ATTESTATION_MAX_ATTEMPTS} attempts (persistent registry/network/parse ` +
          `error). Failing closed instead of tagging/releasing on an unverified state.`,
      );
      return 1;
  }
}

/**
 * Renders the diagnostic for an UNEXPECTED throw (anything that escapes `main` rather than being
 * classified by it) and returns the exit code.
 *
 * Same discipline as the `dist === null` guard above, applied one level out: an unexpected throw
 * must fail closed BY DESIGN, not by accident of runtime semantics. Node's default handling of an
 * unhandled rejection does exit non-zero today — but that is the runtime's policy, not this
 * script's decision, and it prints a bare stack trace where the release log needs the same
 * `::error::` annotation the other two failure paths emit. This is precisely the shape this file
 * already refused to accept for `dist.attestations` off of `null`; leaving it at the entrypoint
 * would keep exactly one path whose exit code is incidental.
 *
 * Split out of the entrypoint below (rather than inlined in a `.catch`) so the contract is
 * ASSERTED rather than trusted: the entrypoint is guarded by `import.meta.url` and can never be
 * exercised from the test suite, so an inline handler would be an untestable claim.
 */
export function reportUnexpectedFailure(err: unknown, log: (message: string) => void): number {
  log(
    `::error::provenance gate threw before it could classify attestation status: ` +
      `${err instanceof Error ? err.message : String(err)}. Failing closed instead of ` +
      `tagging/releasing on an unverified state.`,
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) =>
      process.exit(reportUnexpectedFailure(err, (message) => console.error(message))),
    );
}
