// Ярус 2 (сеть, на релизе, ДО npm publish). base здесь — реестровый `latest`,
// и только он: PR-время base к этому моменту не существует (мы на main, между
// релизами могло влиться несколько PR), а восстанавливать его неоткуда.
// Поэтому диф считается целиком «опубликованное → публикуемое».
//
// Fail-closed: неопределённый ответ реестра — отказ, ровно как в
// assert-version-publishable.ts.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchAndExtract, renderSurface } from './api-surface.js';
import { assertAllowlistShape, changelogHasVersion, classify, isMinorBump, type Allow } from './api-surface-check.js';

/** Строгое «впереди» по (major, minor, patch). Публикация версии, не идущей
 *  вперёд, — отказ независимо от breaking: реестр неизменяем по версии. */
function isAhead(base: string, head: string): boolean {
  const b = base.split('.').map(Number);
  const h = head.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((h[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((h[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

export function decide(args: {
  latest: string | null;
  publishing: string;
  latestSnapshot: string | null;
  headSnapshot: string;
  changelog: string;
  allowlist: Allow[];
}): string[] {
  if (!args.latest) {
    return ['registry answer for the latest published version is indeterminate — refusing to publish on an unverified state'];
  }
  if (args.latestSnapshot === null) {
    return [`published surface of ${args.latest} could not be read — refusing to publish on an unverified state`];
  }
  const errors: string[] = [];
  if (!isAhead(args.latest, args.publishing)) {
    errors.push(`publishing version ${args.publishing} is not ahead of the registry latest ${args.latest}`);
  }

  const { removed, added } = classify(args.latestSnapshot, args.headSnapshot);
  for (const line of added) console.log(`ADDED    ${line}`);

  const exempt = new Set(args.allowlist.filter((a) => removed.includes(a.line)).map((a) => a.line));
  for (const line of exempt) console.log(`EXEMPT   ${line}`);
  const unexempt = removed.filter((l) => !exempt.has(l));
  if (!unexempt.length) return errors;

  for (const line of unexempt) console.log(`BREAKING ${line}`);
  if (!isMinorBump(args.latest, args.publishing)) {
    errors.push(
      `${unexempt.length} public-surface line(s) removed or changed against published ${args.latest}, so ${args.publishing} must be at least a minor bump`,
    );
  }
  if (!changelogHasVersion(args.changelog, args.publishing)) {
    errors.push(`CHANGELOG.md has no "## [${args.publishing}]" section for a breaking change`);
  }
  return errors;
}

function registryLatest(pkg: string): string | null {
  try {
    const out = execFileSync('npm', ['view', pkg, 'version', '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out) as string;
    return typeof parsed === 'string' && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function main(): number {
  const [pkgName, publishing] = process.argv.slice(2);
  if (!pkgName || !publishing) {
    console.error('usage: tsx scripts/assert-surface-compatible.ts <package> <version>');
    return 1;
  }
  const repoDir = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-latest-'));
  try {
    const latest = registryLatest(pkgName);
    let latestSnapshot: string | null = null;
    if (latest) {
      try {
        latestSnapshot = renderSurface(fetchAndExtract(`${pkgName}@${latest}`, tmp));
      } catch (error) {
        console.error(`could not read the published surface: ${error instanceof Error ? error.message : error}`);
        latestSnapshot = null;
      }
    }
    const errors = decide({
      latest,
      publishing,
      latestSnapshot,
      headSnapshot: fs.readFileSync(path.join(repoDir, 'api-surface.txt'), 'utf8'),
      changelog: fs.readFileSync(path.join(repoDir, 'CHANGELOG.md'), 'utf8'),
      allowlist: assertAllowlistShape(
        JSON.parse(fs.readFileSync(path.join(repoDir, 'api-breaking-allowlist.json'), 'utf8')),
      ),
    });
    for (const error of errors) console.error(`FAIL ${error}`);
    if (errors.length) return 1;
    console.log(`OK   public surface compatible with published ${latest}`);
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('assert-surface-compatible.ts')) {
  process.exit(main());
}
