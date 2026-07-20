// Release guard: `npm publish --provenance` makes the registry verify that
// package.json "repository.url" resolves to the same repo the Sigstore attestation
// was built from. A missing or mismatched field is rejected with E422 *after* the
// provenance statement has already been signed and written to the public
// transparency log — the build looks fine right up to the registry PUT.
//
// This is not hypothetical: run 29752024700 (2026-07-20) failed exactly here,
// with `"repository.url" is ""`, because the field was absent entirely. Every
// pre-flight step passed first, so nothing earlier in the workflow catches it.
// Run: npx tsx --test test/publish-provenance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const EXPECTED_REPO = 'https://github.com/trdlabs/sdk';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { repository?: { type?: string; url?: string } | string };

/** Mirrors how npm normalises a repository URL before comparing it to the
 *  provenance subject: strip a `git+` prefix and a trailing `.git`. */
function normalise(url: string): string {
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

test('package.json declares a repository (provenance publish fails without one)', () => {
  assert.ok(pkg.repository, 'package.json has no "repository" field');
});

test('repository.url matches the GitHub repo the release builds from', () => {
  const repo = pkg.repository;
  const url = typeof repo === 'string' ? repo : repo?.url;
  assert.ok(url, '"repository.url" is empty — this is the exact E422 the registry rejects');
  assert.equal(normalise(url), EXPECTED_REPO);
});
