// Ярус 1 (офлайн, каждый PR): (1) коммиченный снимок равен регенерации;
// (2) удаления и изменения строк требуют minor-бампа + секции CHANGELOG либо
// строки allow-list. Добавления свободны.
//
// Классификация консервативно-текстовая. Снимок отсортирован, поэтому
// изменение строки — это пара удаление+добавление; семантическое «сужение»
// внутри неизменившейся строки НЕ ловится и не обещается (ADR-0029).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { packAndExtract, renderSurface } from './api-surface.js';

export type Allow = { line: string; reason: string; date: string; pr: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PR_RE = /^[\w.-]+\/[\w.-]+#\d+$/;

const body = (snapshot: string): string[] =>
  snapshot.split('\n').filter((l) => l && !l.startsWith('#'));

export function classify(baseSnapshot: string, headSnapshot: string): { removed: string[]; added: string[] } {
  const before = new Set(body(baseSnapshot));
  const after = new Set(body(headSnapshot));
  return {
    removed: [...before].filter((l) => !after.has(l)).sort(),
    added: [...after].filter((l) => !before.has(l)).sort(),
  };
}

export function assertAllowlistShape(raw: unknown): Allow[] {
  if (!Array.isArray(raw)) throw new Error('api-breaking-allowlist.json must be an array');
  return raw.map((item, i) => {
    const at = `api-breaking-allowlist.json[${i}]`;
    const e = item as Record<string, unknown>;
    if (typeof e.line !== 'string' || !e.line) throw new Error(`${at}: line is required`);
    if (typeof e.reason !== 'string' || !e.reason) throw new Error(`${at}: reason is required`);
    if (typeof e.date !== 'string' || !ISO_DATE_RE.test(e.date)) throw new Error(`${at}: date must be YYYY-MM-DD`);
    if (typeof e.pr !== 'string' || !PR_RE.test(e.pr)) throw new Error(`${at}: pr must be owner/repo#N`);
    return { line: e.line, reason: e.reason, date: e.date, pr: e.pr };
  });
}

export function isMinorBump(base: string, head: string): boolean {
  const [bMaj, bMin] = base.split('.').map(Number) as [number, number, number];
  const [hMaj, hMin] = head.split('.').map(Number) as [number, number, number];
  if (hMaj > bMaj) return true;
  if (hMaj < bMaj) return false;
  return hMin > bMin;
}

export function changelogHasVersion(changelog: string, version: string): boolean {
  return new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog);
}

export function evaluate(args: {
  baseSnapshot: string | null;
  headSnapshot: string;
  regenerated: string;
  baseVersion: string | null;
  headVersion: string;
  changelog: string;
  allowlist: Allow[];
}): string[] {
  const errors: string[] = [];

  if (args.headSnapshot !== args.regenerated) {
    errors.push(
      'api-surface.txt is not regenerated: the committed snapshot differs from what the packed tarball produces — run `npm run api:surface` and commit the result',
    );
    return errors;
  }

  if (args.baseSnapshot === null || args.baseVersion === null) {
    console.log('SKIP classification: no base snapshot to compare against (first introduction, or no base ref)');
    return errors;
  }

  const { removed, added } = classify(args.baseSnapshot, args.headSnapshot);
  for (const line of added) console.log(`ADDED    ${line}`);
  if (!removed.length) return errors;

  const exempt = new Set<string>();
  for (const allow of args.allowlist) {
    if (removed.includes(allow.line)) {
      exempt.add(allow.line);
      console.log(`EXEMPT   ${allow.line}  (${allow.reason}, ${allow.date}, ${allow.pr})`);
    } else {
      errors.push(
        `api-breaking-allowlist.json exempts ${JSON.stringify(allow.line)} but it matches no removed line — a stale exemption hides the next real break`,
      );
    }
  }

  const unexempt = removed.filter((l) => !exempt.has(l));
  if (!unexempt.length) return errors;

  for (const line of unexempt) console.log(`BREAKING ${line}`);
  if (!isMinorBump(args.baseVersion, args.headVersion)) {
    errors.push(
      `${unexempt.length} public-surface line(s) removed or changed, so the version must be at least a minor bump over ${args.baseVersion} — package.json says ${args.headVersion}`,
    );
  }
  if (!changelogHasVersion(args.changelog, args.headVersion)) {
    errors.push(`CHANGELOG.md has no "## [${args.headVersion}]" section for a breaking change`);
  }
  return errors;
}

// ── CLI ────────────────────────────────────────────────────────────────────

/** Содержимое файла на git-ref, либо null. Отсутствие файла на base — законный
 *  случай (первое появление снимка), поэтому null, а не бросок. */
function tryGitShow(ref: string, file: string): string | null {
  try {
    // stderr гасится: «exists on disk, but not in origin/main» — ЗАКОННЫЙ случай
    // первого появления файла, и его fatal-строка в логе CI читалась бы как отказ.
    return execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function resolveBaseRef(): string | null {
  const prBase = process.env.GITHUB_BASE_REF;
  const candidate = prBase ? `origin/${prBase}` : 'origin/main';
  try {
    execFileSync('git', ['rev-parse', '--verify', candidate], { stdio: 'ignore' });
    return candidate;
  } catch {
    // Shallow checkout on a PR: fetch just what the comparison needs.
    try {
      execFileSync('git', ['fetch', '--depth=1', 'origin', prBase ?? 'main'], { stdio: 'ignore' });
      execFileSync('git', ['rev-parse', '--verify', candidate], { stdio: 'ignore' });
      return candidate;
    } catch {
      return null;
    }
  }
}

function main(): number {
  const repoDir = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-surface-check-'));
  try {
    const pkgDir = packAndExtract(repoDir, tmp);
    const regenerated = renderSurface(pkgDir);
    const headSnapshot = fs.readFileSync(path.join(repoDir, 'api-surface.txt'), 'utf8');
    const baseRef = resolveBaseRef();
    if (baseRef) console.log(`base: ${baseRef}`);
    const baseSnapshot = baseRef ? tryGitShow(baseRef, 'api-surface.txt') : null;
    const basePkg = baseRef ? tryGitShow(baseRef, 'package.json') : null;
    const errors = evaluate({
      baseSnapshot,
      headSnapshot,
      regenerated,
      baseVersion: basePkg ? (JSON.parse(basePkg) as { version: string }).version : null,
      headVersion: (JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')) as { version: string }).version,
      changelog: fs.readFileSync(path.join(repoDir, 'CHANGELOG.md'), 'utf8'),
      allowlist: assertAllowlistShape(
        JSON.parse(fs.readFileSync(path.join(repoDir, 'api-breaking-allowlist.json'), 'utf8')),
      ),
    });
    for (const error of errors) console.error(`FAIL ${error}`);
    if (errors.length) return 1;
    console.log('OK   api surface');
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('api-surface-check.ts')) {
  process.exit(main());
}
