import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide } from '../scripts/assert-surface-compatible.js';

const LATEST = ['# @trdlabs/sdk 0.21.0', '# symbols: 2', '. const a :: number', '. const b :: number', ''].join('\n');
const HEAD_ADD = ['# @trdlabs/sdk 0.22.0', '# symbols: 3', '. const a :: number', '. const b :: number', '. const c :: number', ''].join('\n');
const HEAD_REMOVE = ['# @trdlabs/sdk 0.22.0', '# symbols: 1', '. const a :: number', ''].join('\n');
const CHANGELOG = '# Changelog\n\n## [0.22.0] - 2026-08-18\n\nremoved b\n';

const base = {
  latest: '0.21.0' as string | null,
  publishing: '0.22.0',
  latestSnapshot: LATEST as string | null,
  headSnapshot: HEAD_ADD,
  changelog: CHANGELOG,
  allowlist: [],
};

test('green on an additive change with any legal bump', () => {
  assert.deepEqual(decide(base), []);
});

test('FAILS CLOSED when the registry gave no determinate latest', () => {
  const errs = decide({ ...base, latest: null });
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /indeterminate/i);
});

test('FAILS CLOSED when the published tarball could not be read', () => {
  const errs = decide({ ...base, latestSnapshot: null });
  assert.match(errs.join(), /published surface/i);
});

test('rejects publishing a version that is not ahead of latest', () => {
  assert.match(decide({ ...base, publishing: '0.21.0' }).join(), /ahead of/i);
});

test('rejects a breaking diff published as a patch', () => {
  const errs = decide({ ...base, publishing: '0.21.1', headSnapshot: HEAD_REMOVE });
  assert.match(errs.join(), /minor/);
});

test('accepts a breaking diff with a minor bump and a CHANGELOG section', () => {
  assert.deepEqual(decide({ ...base, headSnapshot: HEAD_REMOVE }), []);
});

test('accepts a breaking diff exempted by the allowlist', () => {
  assert.deepEqual(
    decide({
      ...base,
      publishing: '0.21.1',
      headSnapshot: HEAD_REMOVE,
      changelog: '# Changelog\n\n## [0.21.1] - 2026-08-18\n',
      allowlist: [{ line: '. const b :: number', reason: 'no consumers', date: '2026-08-18', pr: 'trdlabs/sdk#46' }],
    }),
    [],
  );
});
