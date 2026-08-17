// api-surface.ts — детерминированный снимок ПУБЛИЧНОЙ поверхности пакета.
//
// Вход — распакованный npm-тарбол, а не рабочее дерево: релизный ярус
// сравнивает с тарболом из реестра, и если PR-ярус смотрит на dist, два яруса
// сравнивают разные предметы, а расхождение `files`/`exports` («что собралось»
// против «что уехало потребителю») не видит ни один.
//
// Никаких новых зависимостей: TypeScript уже в devDeps, распаковка — системный tar.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type ExportEntry = { name: string; typesFile: string };

export function readExportEntries(pkgDir: string): ExportEntry[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, { types?: string }>;
  };
  const out: ExportEntry[] = [];
  for (const [name, value] of Object.entries(pkg.exports ?? {})) {
    const types = value?.types;
    if (!types) {
      throw new Error(`exports["${name}"] declares no "types" — its public surface is undefined`);
    }
    const typesFile = path.join(pkgDir, types);
    if (!fs.existsSync(typesFile)) {
      throw new Error(
        `exports["${name}"] declares types ${types}, missing from the package at ${typesFile} — a declared entry absent from the artifact is a loud failure, not a smaller surface`,
      );
    }
    out.push({ name, typesFile });
  }
  if (!out.length) throw new Error('package.json declares no exports — nothing to snapshot');
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Одна строка на символ. Перевод строки и повторные пробелы схлопываются
 *  нами, а не флагами компилятора: набор TypeFormatFlags между версиями
 *  меняется, а нормализация, которой мы владеем, — нет. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function symbolKind(symbol: ts.Symbol): string {
  const flags = symbol.getFlags();
  if (flags & ts.SymbolFlags.Interface) return 'interface';
  if (flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (flags & ts.SymbolFlags.Enum) return 'enum';
  if (flags & ts.SymbolFlags.Class) return 'class';
  if (flags & ts.SymbolFlags.Function) return 'function';
  if (flags & ts.SymbolFlags.Variable) return 'const';
  return 'symbol';
}

const TYPE_ONLY = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Enum;

export function renderSurface(pkgDir: string): string {
  const entries = readExportEntries(pkgDir);
  const program = ts.createProgram(
    entries.map((e) => e.typesFile),
    { noEmit: true, skipLibCheck: true, strict: true, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler },
  );
  const checker = program.getTypeChecker();
  const lines: string[] = [];
  let symbols = 0;

  for (const entry of entries) {
    const source = program.getSourceFile(entry.typesFile);
    if (!source) throw new Error(`could not load ${entry.typesFile} into the program`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`${entry.typesFile} is not a module — no exports to read`);

    const exported = checker
      .getExportsOfModule(moduleSymbol)
      .slice()
      .sort((a, b) => (a.getName() < b.getName() ? -1 : a.getName() > b.getName() ? 1 : 0));

    for (const symbol of exported) {
      symbols += 1;
      const declaration = symbol.declarations?.[0];
      const type =
        symbol.getFlags() & TYPE_ONLY
          ? checker.getDeclaredTypeOfSymbol(symbol)
          : checker.getTypeOfSymbolAtLocation(symbol, declaration ?? source);
      lines.push(
        oneLine(
          `${entry.name} ${symbolKind(symbol)} ${symbol.getName()} :: ${checker.typeToString(
            type,
            undefined,
            ts.TypeFormatFlags.NoTruncation,
          )}`,
        ),
      );
      // Члены перечисляются только у объявленных структурных типов: у const,
      // функции и type-алиаса вся сигнатура уже в typeToString, а
      // getPropertiesOfType примитива вернул бы apparent-члены прототипа
      // (`b.toFixed` у числа) — шум, найденный первым же прогоном теста.
      const STRUCTURAL = ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum;
      const members = symbol.getFlags() & STRUCTURAL ? checker.getPropertiesOfType(type) : [];
      for (const member of members
        .slice()
        .sort((a, b) => (a.getName() < b.getName() ? -1 : a.getName() > b.getName() ? 1 : 0))) {
        const memberDecl = member.declarations?.[0];
        const memberType = checker.getTypeOfSymbolAtLocation(member, memberDecl ?? declaration ?? source);
        const optional = member.getFlags() & ts.SymbolFlags.Optional ? '?' : '';
        lines.push(
          oneLine(
            `${entry.name} ${symbol.getName()}.${member.getName()}${optional} :: ${checker.typeToString(
              memberType,
              undefined,
              ts.TypeFormatFlags.NoTruncation,
            )}`,
          ),
        );
      }
    }
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  return [`# ${pkg.name} ${pkg.version}`, `# symbols: ${symbols}`, ...lines.sort(), ''].join('\n');
}

/** `npm pack` рабочего дерева + распаковка. Возвращает путь к `package/`. */
export function packAndExtract(repoDir: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const packed = execFileSync('npm', ['pack', '--pack-destination', destDir], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  const tgz = packed.trim().split('\n').filter(Boolean).pop();
  if (!tgz) throw new Error('npm pack printed no tarball name');
  execFileSync('tar', ['-xzf', path.join(destDir, tgz), '-C', destDir]);
  const pkgDir = path.join(destDir, 'package');
  if (!fs.existsSync(pkgDir)) throw new Error(`tarball ${tgz} did not extract a package/ directory`);
  return pkgDir;
}

/** Скачивает тарбол ОПУБЛИКОВАННОЙ версии и распаковывает её так же. */
export function fetchAndExtract(spec: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const packed = execFileSync('npm', ['pack', spec, '--pack-destination', destDir], {
    encoding: 'utf8',
  });
  const tgz = packed.trim().split('\n').filter(Boolean).pop();
  if (!tgz) throw new Error(`npm pack ${spec} printed no tarball name`);
  execFileSync('tar', ['-xzf', path.join(destDir, tgz), '-C', destDir]);
  return path.join(destDir, 'package');
}
