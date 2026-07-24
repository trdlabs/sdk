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

// AGENTS.md «Перед релизом»: build, conformance:validation, sdk:pack, sdk:verify. A gate the
// workflow does not run is not a gate — conformance:validation was missing until this test.
//
// `npm run check` is the composed test+build+conformance gate, shared verbatim with the pr-check
// workflow so both agree on what green means; its internal composition and ordering are asserted in
// test/pr-check-workflow-guard.test.ts. Packing stays release-local: it verifies the tarball this
// workflow is about to publish, and a PR has nothing to pack.
//
// Matching is anchored to `run:` so a mention in the file's header comment cannot pass for an
// executed step (the header does say "after a successful npm publish").
const GATES = [
  'npm run check',
  'npm run sdk:pack',
  'npm run sdk:verify',
] as const;

/** Position of the workflow step that actually executes `command`, or -1. */
function stepAt(command: string): number {
  return workflow.indexOf(`run: ${command}`);
}

test('release workflow runs every mandatory pre-release gate', () => {
  for (const gate of GATES) {
    assert.ok(stepAt(gate) >= 0, `release workflow does not run: ${gate}`);
  }
});

test('packing verifies output the composed gate already built', () => {
  // sdk:pack tars up dist/, which `check` produces — packing first would ship stale or absent output.
  assert.ok(
    stepAt('npm run sdk:pack') > stepAt('npm run check'),
    'sdk:pack must come after npm run check',
  );
});

test('every gate runs before publish', () => {
  const publishAt = stepAt('npm publish --access public --provenance');
  assert.ok(publishAt >= 0, 'no publish step found');
  for (const gate of GATES) {
    assert.ok(stepAt(gate) < publishAt, `${gate} must run before npm publish`);
  }
});
