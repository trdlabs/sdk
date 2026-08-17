import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { packAndExtract, readExportEntries, renderSurface } from '../scripts/api-surface.ts';

function pkg(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, 'utf8');
  }
  return dir;
}

const PKG = (exportsMap: unknown) =>
  JSON.stringify({ name: '@trdlabs/sdk', version: '0.21.0', exports: exportsMap });

test('lists declared export entries sorted by subpath', () => {
  const dir = pkg({
    'package.json': PKG({
      './b': { types: './dist/b.d.ts' },
      '.': { types: './dist/index.d.ts' },
    }),
    'dist/index.d.ts': 'export declare const a: number;\n',
    'dist/b.d.ts': 'export declare const b: string;\n',
  });
  assert.deepEqual(
    readExportEntries(dir).map((e) => e.name),
    ['.', './b'],
  );
});

test('throws loudly when a declared entry has no types field', () => {
  const dir = pkg({ 'package.json': PKG({ '.': { import: './dist/index.js' } }) });
  assert.throws(() => readExportEntries(dir), /types/);
});

test('throws loudly when a declared types file is missing from the package', () => {
  const dir = pkg({ 'package.json': PKG({ '.': { types: './dist/gone.d.ts' } }) });
  assert.throws(() => readExportEntries(dir), /missing/);
});

test('throws when the package declares no exports at all', () => {
  const dir = pkg({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }) });
  assert.throws(() => readExportEntries(dir), /no exports/);
});

test('renders a deterministic, single-line-per-symbol snapshot with a header', () => {
  const dir = pkg({
    'package.json': PKG({ '.': { types: './dist/index.d.ts' } }),
    'dist/index.d.ts': [
      'export interface Row {',
      '  b: string;',
      '  a: number;',
      '}',
      'export declare function read(spec: Row): string[];',
      'export type Id = string;',
      '',
    ].join('\n'),
  });
  const first = renderSurface(dir);
  assert.equal(first, renderSurface(dir), 'must be byte-identical across runs');
  assert.match(first, /^# @trdlabs\/sdk 0\.21\.0\n/);
  assert.match(first, /symbols: 3/);
  // members sorted regardless of declaration order
  assert.ok(first.indexOf('Row.a') < first.indexOf('Row.b'));
  // normalization collapsed the compiler's multi-line type text: no run of two
  // spaces survives anywhere in the snapshot
  assert.ok(!/ {2}/.test(first));
});

test('the snapshot describes the DELIVERED artifact, not the working tree', () => {
  // Пиннит §5.2 спеки: `files` может исключить то, что лежит в дереве. Если
  // снимок строить из дерева, ярус 1 и ярус 2 сравнивают разные предметы.
  const dir = pkg({
    'package.json': JSON.stringify({
      name: '@trdlabs/probe',
      version: '0.1.0',
      files: ['dist'],
      exports: { '.': { types: './dist/index.d.ts' } },
    }),
    'dist/index.d.ts': 'export declare const a: number;\n',
    'src/leak.d.ts': 'export declare const leaked: number;\n',
  });
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'packed-'));
  const pkgDir = packAndExtract(dir, dest);
  assert.equal(fs.existsSync(path.join(pkgDir, 'dist', 'index.d.ts')), true);
  assert.equal(fs.existsSync(path.join(pkgDir, 'src')), false, 'files: ["dist"] must keep src out of the artifact');
  assert.ok(!renderSurface(pkgDir).includes('leaked'));
});

test('a removed export removes exactly its lines', () => {
  const withFn = pkg({
    'package.json': PKG({ '.': { types: './dist/index.d.ts' } }),
    'dist/index.d.ts': 'export declare const a: number;\nexport declare const b: number;\n',
  });
  const withoutFn = pkg({
    'package.json': PKG({ '.': { types: './dist/index.d.ts' } }),
    'dist/index.d.ts': 'export declare const a: number;\n',
  });
  const before = renderSurface(withFn).split('\n');
  const after = renderSurface(withoutFn).split('\n');
  const gone = before.filter((l) => !after.includes(l) && !l.startsWith('#'));
  assert.deepEqual(gone.map((l) => l.replace(/ ::.*/, '')), ['. const b']);
});
