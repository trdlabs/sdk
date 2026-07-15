// Guards the fail-closed publishability classifier: only a confirmed E404 is
// "publishable"; an existing version or ANY indeterminate registry/network/auth
// outcome must NOT be treated as publishable.
// Run: npx tsx --test test/assert-version-publishable.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNpmView } from '../scripts/assert-version-publishable.js';

test('confirmed E404 (missing version) is publishable', () => {
  assert.equal(
    classifyNpmView({
      status: 1,
      stdout: '',
      stderr: 'npm error code E404\nnpm error 404 No match found for version 0.10.0',
    }),
    'publishable',
  );
});

test('existing version (clean success with output) is already-published', () => {
  assert.equal(classifyNpmView({ status: 0, stdout: '0.10.0\n', stderr: '' }), 'already-published');
});

test('network error (ENOTFOUND) is indeterminate, not publishable', () => {
  assert.equal(
    classifyNpmView({
      status: 1,
      stdout: '',
      stderr: 'npm error code ENOTFOUND\nnpm error request to https://registry.npmjs.org failed',
    }),
    'indeterminate',
  );
});

test('auth error (E401) is indeterminate, not publishable', () => {
  assert.equal(
    classifyNpmView({ status: 1, stdout: '', stderr: 'npm error code E401\nnpm error Unable to authenticate' }),
    'indeterminate',
  );
});

test('registry 5xx is indeterminate, not publishable', () => {
  assert.equal(
    classifyNpmView({ status: 1, stdout: '', stderr: 'npm error code E500\nnpm error 500 Internal Server Error' }),
    'indeterminate',
  );
});

test('status 0 but empty output is indeterminate (not a false publishable)', () => {
  assert.equal(classifyNpmView({ status: 0, stdout: '\n', stderr: '' }), 'indeterminate');
});
