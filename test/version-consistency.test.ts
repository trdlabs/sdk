// Release guard: the exported SDK_VERSION constant must equal package.json "version".
// A published package whose `import { SDK_VERSION }` disagrees with its npm version is
// self-contradicting — this regression test fails the release if the two ever drift.
// Run: npx tsx --test test/version-consistency.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SDK_VERSION } from '../src/index.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

test('SDK_VERSION matches package.json version', () => {
  assert.equal(SDK_VERSION, pkg.version);
});
