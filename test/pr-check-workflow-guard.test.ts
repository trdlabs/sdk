// PR-gate guard: locks in that `pr-check` exists, gates every PR through the SAME entry the
// release runs, and cannot publish anything.
//
// Until this workflow existed, sdk was the only repo of the seven whose tests ran solely inside
// the manual release workflow — i.e. the first time a change met a gate was at publish time, on a
// human's `workflow_dispatch`. A PR's evidence has to be something a reviewer can open.
//
// The single-entry invariant is the expensive lesson from the platform migration-0026 incident: a
// gate that restates what it verifies drifts from the thing it verifies. There, a self-test
// hardcoded the migration set `0021..0026` while the real gate read the repository's registry, and
// the two disagreed the moment the registry moved. Here the equivalent failure would be pr-check
// and sdk-release each enumerating their own list of test steps, so "green on the PR" and "green
// at release" would quietly come to mean different things. Both call `npm run check`; the
// composition lives in package.json, once.
//
// Run: npx tsx --test test/pr-check-workflow-guard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const prCheck = readFileSync(
  new URL('../.github/workflows/pr-check.yml', import.meta.url),
  'utf8',
);

const release = readFileSync(
  new URL('../.github/workflows/sdk-release.yml', import.meta.url),
  'utf8',
);

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

/**
 * The workflow with full-line `#` comments removed.
 *
 * Capability assertions must read what the workflow *does*, not what it says about itself: the
 * header below explains at length why pr-check may never `npm publish`, and matching that sentence
 * as if it were a publish step would fail the file for documenting its own invariant.
 */
function directives(workflow: string): string {
  return workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const prCheckDirectives = directives(prCheck);

/** Matches a `key: value` step field in either list-item (`- run: x`) or block (`run: x`) form. */
function stepField(key: string, value: string): RegExp {
  return new RegExp(`^ +(?:- )?${key}: ${value}$`, 'm');
}

// ── The gate exists and fires where it must ──────────────────────────────────

test('pr-check runs on pull requests', () => {
  assert.match(prCheck, /^on:$/m, 'no trigger block');
  assert.match(prCheck, /^ {2}pull_request:$/m, 'pr-check does not trigger on pull_request');
});

test('pr-check runs on push to main', () => {
  // Post-merge runs give `main` a verdict of its own: a PR that was green against a stale base can
  // still break main, and without this trigger nothing would ever notice.
  assert.match(prCheck, /^ {2}push:\n {4}branches: \[main\]$/m, 'pr-check does not trigger on push to main');
});

// ── Single entry: pr-check and the release agree on what "green" means ───────

test('pr-check gates through npm run check', () => {
  assert.match(prCheck, stepField('run', 'npm run check'), 'pr-check does not run: npm run check');
});

test('release workflow gates through the same npm run check', () => {
  assert.match(release, stepField('run', 'npm run check'), 'release workflow does not run: npm run check');
});

test('neither workflow enumerates the gates check already composes', () => {
  // Re-listing `npm test` / `npm run build` / `npm run conformance:validation` as workflow steps is
  // how the two definitions of green start to drift. The composition belongs to `check`.
  for (const [name, workflow] of [['pr-check', prCheck], ['sdk-release', release]] as const) {
    for (const gate of ['npm test', 'npm run build', 'npm run conformance:validation']) {
      assert.doesNotMatch(
        workflow,
        stepField('run', gate),
        `${name} re-enumerates \`${gate}\` instead of relying on npm run check`,
      );
    }
  }
});

test('check composes the full pre-release gate in dependency order', () => {
  const check = pkg.scripts.check;
  assert.ok(check, 'package.json has no `check` script');
  for (const gate of ['npm test', 'npm run build', 'npm run conformance:validation']) {
    assert.ok(check.includes(gate), `check does not run: ${gate}`);
  }
  // The conformance harness imports dist/ — running it before the build would validate stale output.
  assert.ok(
    check.indexOf('npm run conformance:validation') > check.indexOf('npm run build'),
    'conformance:validation must come after npm run build inside `check`',
  );
  // `&&` and not `;` — a gate that runs after a failed gate is not a gate.
  assert.doesNotMatch(check, /;/, '`check` must chain with && so a failure stops the run');
});

// ── pr-check cannot publish. Not "does not" — cannot. ────────────────────────

test('pr-check requests read-only repository permissions', () => {
  assert.match(
    prCheck,
    /^permissions:\n {2}contents: read\n/m,
    'pr-check must declare exactly `permissions: contents: read`',
  );
});

test('pr-check holds no token that could publish', () => {
  // No `id-token: write` (npm provenance / OIDC), no `packages:` (GHCR), no npm auth of any kind.
  // A check that could publish is a publication path wearing a check's name.
  assert.doesNotMatch(prCheckDirectives, /id-token/, 'pr-check must not request id-token');
  assert.doesNotMatch(prCheckDirectives, /packages:/, 'pr-check must not request packages permissions');
  assert.doesNotMatch(prCheckDirectives, /NODE_AUTH_TOKEN|NPM_TOKEN/, 'pr-check must not wire npm auth');
  assert.doesNotMatch(prCheckDirectives, /secrets\./, 'pr-check must not consume repository secrets');
});

test('pr-check performs no publish or release step', () => {
  assert.doesNotMatch(prCheckDirectives, /npm publish/, 'pr-check must never publish');
  assert.doesNotMatch(prCheckDirectives, /gh release/, 'pr-check must never cut a release');
  // registry-url on setup-node is what makes an .npmrc capable of authenticated publish.
  assert.doesNotMatch(prCheckDirectives, /registry-url/, 'pr-check must not configure a publish registry');
});

// ── CI hygiene, to the ecosystem standard ────────────────────────────────────

test('pr-check cancels superseded runs', () => {
  assert.match(prCheck, /^concurrency:$/m, 'pr-check declares no concurrency group');
  assert.match(prCheck, /^ {2}cancel-in-progress: true$/m, 'pr-check must cancel superseded runs');
});

test('pr-check caches npm downloads', () => {
  assert.match(prCheck, /^ +cache: npm$/m, 'pr-check does not enable the npm cache');
});

test('pr-check installs from the lockfile', () => {
  // `npm ci` and not `npm install`: the gate must run against the pinned dependency tree.
  assert.match(prCheck, stepField('run', 'npm ci'), 'pr-check must install with npm ci');
  assert.doesNotMatch(prCheck, stepField('run', 'npm install'), 'pr-check must not install off-lockfile');
});

test('pr-check pins every action to the same version the release workflow uses', () => {
  // Floating refs (@main, @master, bare names) would let a third party change what runs on every
  // PR. Divergence from sdk-release.yml would mean the gate and the release run on different
  // toolchains — the same drift the single `check` entry exists to prevent.
  const usesOf = (workflow: string) =>
    new Map(
      [...workflow.matchAll(/^ +(?:- )?uses: ([^@\s]+)@(\S+)$/gm)].map(([, action, ref]) => [action, ref]),
    );

  const prUses = usesOf(prCheck);
  const releaseUses = usesOf(release);

  assert.ok(prUses.size > 0, 'pr-check uses no actions at all');
  for (const [action, ref] of prUses) {
    assert.match(ref, /^v\d+(\.\d+)*$|^[0-9a-f]{40}$/, `${action} is pinned to a floating ref: ${ref}`);
    const releaseRef = releaseUses.get(action);
    if (releaseRef !== undefined) {
      assert.equal(ref, releaseRef, `${action} differs between pr-check (${ref}) and sdk-release (${releaseRef})`);
    }
  }
});

test('pr-check runs the Node major the release publishes from', () => {
  const nodeOf = (workflow: string) => workflow.match(/^ +node-version: "?(\d+)"?$/m)?.[1];
  const prNode = nodeOf(prCheck);
  assert.ok(prNode, 'pr-check pins no node-version');
  assert.equal(prNode, nodeOf(release), 'pr-check and sdk-release must run the same Node major');
});

test('npm test does not use --test-force-exit — a truncated run must not read as green', () => {
  // 083 S1, финальная волна ревью ветки. `--test-force-exit` стоял в `npm test` с P2-12 (коммит
  // 952601f, вместе с historical-client.test.ts) и НЕДЕТЕРМИНИРОВАННО обрывал хвост отчёта: замер
  // здесь же — 8 прогонов под флагом дали 269/269/262/269/269 и отдельно 249 и 257 subtest'ов, и
  // КАЖДЫЙ раз итог был `fail 0`. Пропадал всегда хвост одного файла (`actor-state-ledger.test.ts`),
  // то есть отказ в этих тестах был бы невидим — `npm run check` отвечал бы «зелено», не прогнав их.
  // Без флага: 8 прогонов подряд по 269 subtest'ов, код выхода 0 каждый раз (процесс завершается
  // сам — проверено и на historical-client.test.ts отдельно, ради которого флаг заводили).
  //
  // Гейт, который молча пропускает часть проверок и всё равно говорит «зелено», — тот же класс, что
  // эта ветка чинила весь S1; здесь он стоял под самим механизмом проверки.
  assert.ok(pkg.scripts.test, 'no test script');
  assert.doesNotMatch(
    pkg.scripts.test,
    /--test-force-exit/,
    'npm test обрывает отчёт под --test-force-exit и всё равно рапортует fail 0',
  );
});
