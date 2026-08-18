import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertAllowlistShape,
  changelogHasVersion,
  classify,
  evaluate,
  isMinorBump,
} from '../scripts/api-surface-check.js';

const BASE = ['# @trdlabs/sdk 0.21.0', '# symbols: 2', '. const a :: number', '. const b :: number', ''].join('\n');
const REMOVED = ['# @trdlabs/sdk 0.21.0', '# symbols: 1', '. const a :: number', ''].join('\n');
const ADDED = ['# @trdlabs/sdk 0.21.0', '# symbols: 3', '. const a :: number', '. const b :: number', '. const c :: number', ''].join('\n');
const CHANGELOG = '# Changelog\n\n## [0.22.0] - 2026-08-18\n\nremoved b\n';

const OK = (over: Partial<Parameters<typeof evaluate>[0]> = {}) =>
  evaluate({
    baseSnapshot: BASE,
    headSnapshot: BASE,
    regenerated: BASE,
    baseVersion: '0.21.0',
    headVersion: '0.21.0',
    changelog: CHANGELOG,
    allowlist: [],
    ...over,
  });

test('classify ignores header lines and reports removals and additions', () => {
  assert.deepEqual(classify(BASE, REMOVED).removed, ['. const b :: number']);
  assert.deepEqual(classify(BASE, ADDED).added, ['. const c :: number']);
  assert.deepEqual(classify(BASE, ADDED).removed, []);
});

test('green when nothing changed', () => {
  assert.deepEqual(OK(), []);
});

test('RED when the committed snapshot is not what regeneration produces', () => {
  const errs = OK({ regenerated: ADDED });
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /not regenerated/i);
});

test('additions require nothing', () => {
  assert.deepEqual(OK({ headSnapshot: ADDED, regenerated: ADDED }), []);
});

test('RED on a removal with no version bump', () => {
  const errs = OK({ headSnapshot: REMOVED, regenerated: REMOVED });
  assert.ok(errs.some((e) => /minor/.test(e)));
});

test('RED on a removal with a bump but no CHANGELOG section', () => {
  const errs = OK({
    headSnapshot: REMOVED,
    regenerated: REMOVED,
    headVersion: '0.22.0',
    changelog: '# Changelog\n\n## [Unreleased]\n',
  });
  assert.ok(errs.some((e) => /CHANGELOG/i.test(e)));
});

test('GREEN on a removal with a minor bump and a CHANGELOG section', () => {
  assert.deepEqual(
    OK({ headSnapshot: REMOVED, regenerated: REMOVED, headVersion: '0.22.0' }),
    [],
  );
});

test('GREEN on a removal covered by an allowlist line', () => {
  assert.deepEqual(
    OK({
      headSnapshot: REMOVED,
      regenerated: REMOVED,
      allowlist: [{ line: '. const b :: number', reason: 'no consumers', date: '2026-08-18', pr: 'trdlabs/sdk#46' }],
    }),
    [],
  );
});

test('RED when an allowlist line matches no removal — a stale exemption is a defect', () => {
  const errs = OK({
    headSnapshot: REMOVED,
    regenerated: REMOVED,
    headVersion: '0.22.0',
    allowlist: [{ line: '. const zzz :: number', reason: 'r', date: '2026-08-18', pr: 'trdlabs/sdk#46' }],
  });
  assert.ok(errs.some((e) => /matches no removed line/i.test(e)));
});

test('allowlist shape: reason, ISO date and owner/repo#N are all required', () => {
  assert.throws(() => assertAllowlistShape([{ line: 'x', reason: '', date: '2026-08-18', pr: 'trdlabs/sdk#46' }]), /reason/);
  assert.throws(() => assertAllowlistShape([{ line: 'x', reason: 'r', date: '18.08.2026', pr: 'trdlabs/sdk#46' }]), /date/);
  assert.throws(() => assertAllowlistShape([{ line: 'x', reason: 'r', date: '2026-08-18', pr: 'sdk 46' }]), /pr/);
  assert.deepEqual(assertAllowlistShape([]), []);
});

test('classification is skipped, not guessed, when there is no base snapshot', () => {
  assert.deepEqual(OK({ baseSnapshot: null, baseVersion: null, headSnapshot: REMOVED, regenerated: REMOVED }), []);
});

test('isMinorBump understands 0.x', () => {
  assert.equal(isMinorBump('0.21.0', '0.22.0'), true);
  assert.equal(isMinorBump('0.21.0', '0.21.1'), false);
  assert.equal(isMinorBump('0.21.0', '1.0.0'), true);
  assert.equal(isMinorBump('0.21.0', '0.21.0'), false);
  assert.equal(isMinorBump('0.21.0', '0.20.0'), false);
});

test('changelogHasVersion matches the Keep-a-Changelog heading only', () => {
  assert.equal(changelogHasVersion(CHANGELOG, '0.22.0'), true);
  assert.equal(changelogHasVersion(CHANGELOG, '0.23.0'), false);
  assert.equal(changelogHasVersion('mentions 0.22.0 in prose\n', '0.22.0'), false);
});
