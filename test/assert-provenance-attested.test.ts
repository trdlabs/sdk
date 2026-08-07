// Guards the fail-closed provenance-attestation classifier: only a confirmed
// `dist.attestations` (url + provenance.predicateType) is "attested"; a clean registry
// answer with no attestations, or ANY indeterminate registry/network/parse outcome, must
// NOT be treated as attested.
// Run: npx tsx --test test/assert-provenance-attested.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttestations } from '../scripts/assert-provenance-attested.js';

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
