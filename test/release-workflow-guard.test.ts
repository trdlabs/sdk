// Release-model guard: locks in that npm is the canonical delivery channel for @trdlabs/sdk
// and prevents a regression back to the retired GitHub-tarball release model.
//
// Asserts:
//   1. package name is exactly "@trdlabs/sdk";
//   2. the release workflow publishes to npm (`npm publish`);
//   3. the release workflow carries no legacy "trading-platform-sdk" package name/title/notes;
//   4. the release workflow ships no GitHub tarball asset (`.tgz`) as a consumer delivery channel.
//
// Run: npx tsx --test test/release-workflow-guard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string };

const workflow = readFileSync(
  new URL('../.github/workflows/sdk-release.yml', import.meta.url),
  'utf8',
);

test('package name is @trdlabs/sdk', () => {
  assert.equal(pkg.name, '@trdlabs/sdk');
});

test('release workflow publishes to npm', () => {
  assert.match(workflow, /npm publish/);
});

test('release workflow carries no legacy trading-platform-sdk name', () => {
  assert.doesNotMatch(workflow, /trading-platform-sdk/);
});

test('release workflow ships no GitHub tarball (.tgz) delivery channel', () => {
  assert.doesNotMatch(workflow, /\.tgz/);
});
