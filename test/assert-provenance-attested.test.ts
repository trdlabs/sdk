// Guards the fail-closed provenance-attestation classifier: only a confirmed
// `dist.attestations` (url + provenance.predicateType) is "attested"; a clean registry
// answer with no attestations, or ANY indeterminate registry/network/parse outcome, must
// NOT be treated as attested.
//
// Also guards the bounded retry added after the live 0.14.0 release (registry replication
// lag right after publish is a transient `indeterminate`, not a terminal one — see the
// header comment in scripts/assert-provenance-attested.ts): retries ONLY `indeterminate`,
// never `missing`, and stops (fail-closed) once the attempt budget is exhausted.
// Run: npx tsx --test test/assert-provenance-attested.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAttestations,
  reportUnexpectedFailure,
  resolveAttestationOutcome,
  type AttestationOutcome,
} from '../scripts/assert-provenance-attested.js';

test('confirmed attestations (url + predicateType present) is attested', () => {
  assert.equal(
    classifyAttestations({
      status: 0,
      stdout: JSON.stringify({
        integrity: 'sha512-abc',
        attestations: {
          url: 'https://registry.npmjs.org/-/npm/v1/attestations/@trdlabs%2fsdk@0.14.0',
          provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
        },
        signatures: [{ keyid: 'SHA256:abc', sig: 'abc' }],
      }),
      stderr: '',
    }),
    'attested',
  );
});

test('published version with no attestations field at all is missing (not indeterminate)', () => {
  // Live shape observed for a real npm package published without --provenance
  // (e.g. left-pad@1.3.0): `dist` exists, `dist.attestations` simply is not there.
  assert.equal(
    classifyAttestations({
      status: 0,
      stdout: JSON.stringify({
        integrity: 'sha512-abc',
        signatures: [{ keyid: 'SHA256:abc', sig: 'abc' }],
      }),
      stderr: '',
    }),
    'missing',
  );
});

test('attestations.url present but no provenance.predicateType is missing', () => {
  assert.equal(
    classifyAttestations({
      status: 0,
      stdout: JSON.stringify({ attestations: { url: 'https://example.invalid/attestations' } }),
      stderr: '',
    }),
    'missing',
  );
});

test('attestations object present but url is empty string is missing', () => {
  assert.equal(
    classifyAttestations({
      status: 0,
      stdout: JSON.stringify({
        attestations: { url: '', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
      }),
      stderr: '',
    }),
    'missing',
  );
});

test('npm view failure (non-zero exit, e.g. E404 propagation lag or network) is indeterminate', () => {
  assert.equal(
    classifyAttestations({
      status: 1,
      stdout: '',
      stderr: 'npm error code E404\nnpm error 404 No match found for version 0.14.0',
    }),
    'indeterminate',
  );
});

test('network error (ENOTFOUND) is indeterminate, not a confirmed absence', () => {
  assert.equal(
    classifyAttestations({
      status: 1,
      stdout: '',
      stderr: 'npm error code ENOTFOUND\nnpm error request to https://registry.npmjs.org failed',
    }),
    'indeterminate',
  );
});

test('registry 5xx is indeterminate, not a confirmed absence', () => {
  assert.equal(
    classifyAttestations({
      status: 1,
      stdout: '',
      stderr: 'npm error code E500\nnpm error 500 Internal Server Error',
    }),
    'indeterminate',
  );
});

test('status 0 but empty stdout is indeterminate (not a false "missing")', () => {
  assert.equal(classifyAttestations({ status: 0, stdout: '\n', stderr: '' }), 'indeterminate');
});

test('status 0 but non-JSON stdout is indeterminate (cannot read the claim)', () => {
  assert.equal(
    classifyAttestations({ status: 0, stdout: 'npm WARN using --force\nnot json', stderr: '' }),
    'indeterminate',
  );
});

test('status 0 but stdout is the literal JSON `null` is indeterminate, not a thrown exception', () => {
  // `JSON.parse('null')` succeeds and yields `null` — a non-object. Reading `.attestations`
  // off of it must not throw a TypeError out of the classifier; it must resolve to
  // `indeterminate` deliberately, the same as any other unreadable claim.
  assert.equal(classifyAttestations({ status: 0, stdout: 'null', stderr: '' }), 'indeterminate');
});

// ── resolveAttestationOutcome: bounded retry on `indeterminate` only ──────────────────────

/** Builds a `check` stub that returns each outcome in `sequence` in order, then throws if
 *  called more times than the sequence provides (catches "retried when it shouldn't have"). */
function scriptedCheck(sequence: readonly AttestationOutcome[]): {
  readonly check: () => AttestationOutcome;
  readonly callCount: () => number;
} {
  let calls = 0;
  return {
    check: () => {
      if (calls >= sequence.length) {
        throw new Error(`check() called more times (${calls + 1}) than scripted (${sequence.length})`);
      }
      const outcome = sequence[calls];
      calls += 1;
      return outcome as AttestationOutcome;
    },
    callCount: () => calls,
  };
}

/** No-op sleep that resolves immediately — the retry logic is tested for call count and
 *  sequencing, never for real elapsed time. */
function instantSleep(calls: number[]): (ms: number) => Promise<void> {
  return (ms: number) => {
    calls.push(ms);
    return Promise.resolve();
  };
}

test('indeterminate, indeterminate, attested succeeds on the third attempt', async () => {
  const { check, callCount } = scriptedCheck(['indeterminate', 'indeterminate', 'attested']);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const result = await resolveAttestationOutcome(check, {
    maxAttempts: 5,
    delayMs: 3000,
    sleep: instantSleep(sleeps),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(result, { outcome: 'attested', attempts: 3 });
  assert.equal(callCount(), 3, 'check() must be called exactly once per attempt, no more');
  assert.deepEqual(sleeps, [3000, 3000], 'must sleep between attempts only, never after the last');
  assert.equal(logs.length, 2, 'each retried attempt logs why it is retrying');
});

test('indeterminate on every attempt exhausts the budget and fails closed', async () => {
  const { check, callCount } = scriptedCheck([
    'indeterminate',
    'indeterminate',
    'indeterminate',
    'indeterminate',
    'indeterminate',
  ]);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const result = await resolveAttestationOutcome(check, {
    maxAttempts: 5,
    delayMs: 3000,
    sleep: instantSleep(sleeps),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(result, { outcome: 'indeterminate', attempts: 5 });
  assert.equal(callCount(), 5, 'must stop at exactly maxAttempts, not loop forever');
  assert.equal(sleeps.length, 4, 'sleeps between attempts only: 5 attempts → 4 gaps');
  assert.match(
    logs.at(-1) ?? '',
    /exhausted/,
    'the final log line must say the budget was exhausted, distinguishing it from a missing-short-circuit failure',
  );
});

test('missing on the first attempt fails closed WITHOUT any retry (no extra calls, no sleep)', async () => {
  const { check, callCount } = scriptedCheck(['missing']);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const result = await resolveAttestationOutcome(check, {
    maxAttempts: 5,
    delayMs: 3000,
    sleep: instantSleep(sleeps),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(result, { outcome: 'missing', attempts: 1 });
  assert.equal(callCount(), 1, 'a confirmed "missing" must not trigger a second check() call');
  assert.deepEqual(sleeps, [], 'a confirmed "missing" must never sleep/retry');
  assert.deepEqual(logs, [], 'a confirmed "missing" is not a retry — nothing to log about retrying');
});

test('attested on the first attempt succeeds WITHOUT any retry', async () => {
  const { check, callCount } = scriptedCheck(['attested']);
  const sleeps: number[] = [];
  const result = await resolveAttestationOutcome(check, {
    maxAttempts: 5,
    delayMs: 3000,
    sleep: instantSleep(sleeps),
    log: () => {},
  });
  assert.deepEqual(result, { outcome: 'attested', attempts: 1 });
  assert.equal(callCount(), 1);
  assert.deepEqual(sleeps, []);
});

// ── Unexpected throw at the entrypoint ────────────────────────────────────────────────
// Nothing in `main` is EXPECTED to throw — every registry answer it can read is classified.
// These pin the behaviour when something does anyway (a spawn that cannot even start, a
// future edit that adds a throwing path): the gate must fail closed with the same
// `::error::` annotation as its other two failure paths, by decision rather than by Node's
// default unhandled-rejection policy.

test('an unexpected Error fails closed with an ::error:: diagnostic naming the cause', () => {
  const logs: string[] = [];
  const code = reportUnexpectedFailure(new Error('spawnSync ENOENT'), (m) => logs.push(m));
  assert.equal(code, 1, 'an unexpected throw must never yield a passing exit code');
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? '', /^::error::/, 'the release log needs the annotation, not a stack trace');
  assert.match(logs[0] ?? '', /spawnSync ENOENT/, 'the cause must survive into the diagnostic');
});

test('a non-Error throw still fails closed and still names what was thrown', () => {
  // `throw 'string'` / `throw {code: …}` are legal JS; `err.message` would be `undefined` and
  // silently erase the cause, so the String() fallback is the load-bearing half of the branch.
  const logs: string[] = [];
  const code = reportUnexpectedFailure('registry exploded', (m) => logs.push(m));
  assert.equal(code, 1);
  assert.match(logs[0] ?? '', /registry exploded/);
});
