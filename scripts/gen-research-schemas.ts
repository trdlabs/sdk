// Generate JSON Schemas from the 017 research contract TS types (Feature 017, T013).
//
// Usage:
//   node dist/scripts/research/gen_research_schemas.js          # write *.schema.json
//   node dist/scripts/research/gen_research_schemas.js --check  # report drift, exit 1
//
// The TS types in src/research-contract/*.ts are the single source of truth.
// This script keeps the bundled JSON Schemas in
// src/validation/schemas/017/*.schema.json in sync; they are NOT hand-edited (042 kernel in SDK).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config, Schema } from 'ts-json-schema-generator';
// ts-json-schema-generator publishes a CommonJS bundle; import default then use createGenerator.
import tjsg from 'ts-json-schema-generator';

// 042: kernel в SDK. Скрипт в scripts/ → корень репо на уровень выше.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TS_CONFIG = join(REPO_ROOT, 'tsconfig.json');
const CONTRACTS_DIR = join(REPO_ROOT, 'src', 'research-contract');
const OUT_DIR = join(REPO_ROOT, 'src', 'validation', 'schemas', '017');

interface Target {
  readonly type: string;
  readonly sourceFile: string;
  readonly outFile: string;
  readonly schemaTitle: string;
  readonly schemaId: string;
}

function target(type: string, source: string, out: string, title: string): Target {
  return {
    type,
    sourceFile: join(CONTRACTS_DIR, source),
    outFile: join(OUT_DIR, out),
    schemaTitle: title,
    schemaId: `https://trading-platform/017/${out}`,
  };
}

// Core-схемы конверта контракта (data-model §13.1, contracts/README.md).
// Ф1 `shared-execution-engine`: +RealityModel (модель среды исполнения как отдельная сущность).
const TARGETS: ReadonlyArray<Target> = [
  target('ModuleManifest', 'module.ts', 'module-manifest.schema.json', 'ModuleManifest'),
  target('StrategyDecision', 'decision.ts', 'strategy-decision.schema.json', 'StrategyDecision'),
  target('OverlayDecision', 'decision.ts', 'overlay-decision.schema.json', 'OverlayDecision'),
  target('BacktestRunRequest', 'run.ts', 'backtest-run-request.schema.json', 'BacktestRunRequest'),
  target('ValidationResult', 'validation.ts', 'validation-result.schema.json', 'ValidationResult'),
  target('RealityModel', 'reality-model.ts', 'reality-model.schema.json', 'RealityModel'),
  // 083 E1: обе стороны конверта «событие → команды», пересекающего JSON-границу изолята.
  // Через границу ходит БАТЧ (то, что вернул один `onEvent`); схема единичной команды оставлена
  // для точечной проверки и как цель `$ref` из батча.
  target('ActorInputEvent', 'event-driven.ts', 'actor-input-event.schema.json', 'ActorInputEvent'),
  target('ActorCommand', 'event-driven.ts', 'actor-command.schema.json', 'ActorCommand'),
  target('ActorCommandBatch', 'event-driven.ts', 'actor-command-batch.schema.json', 'ActorCommandBatch'),
];

/**
 * 023 (research R5, HIGH-IMPACT) — точечный override: ослабить `additionalProperties` подсхемы
 * `DataNeedsDeclaration` с `false` до `{ "type": "boolean" }`. Только для этой подсхемы: неподдержанный
 * объявленный flag (напр. `delta`) проходит schema-слой и доходит до семантической проверки
 * `unsupported_market_data_kind` (validate-module.ts) вместо generic `schema_invalid` (FR-011/SC-010).
 * lookahead/nondeterminism-флаги перечислены явно и сохраняют свои специфические коды.
 */
function relaxDataNeedsAdditionalProps(schema: Schema): void {
  const defs = (schema as Record<string, unknown>).definitions;
  if (typeof defs !== 'object' || defs === null) return;
  const dn = (defs as Record<string, unknown>).DataNeedsDeclaration;
  if (typeof dn !== 'object' || dn === null) return;
  (dn as Record<string, unknown>).additionalProperties = { type: 'boolean' };
}

function generate(t: Target): Schema {
  const config: Config = {
    path: t.sourceFile,
    tsconfig: TS_CONFIG,
    type: t.type,
    schemaId: t.schemaId,
    skipTypeCheck: true,
    additionalProperties: false,
  };
  const schema = tjsg.createGenerator(config).createSchema(t.type);
  if (typeof schema === 'object' && schema !== null) {
    (schema as Record<string, unknown>).title = t.schemaTitle;
  }
  // 023 — относится только к module-manifest (несёт подсхему DataNeedsDeclaration).
  if (t.type === 'ModuleManifest') relaxDataNeedsAdditionalProps(schema);
  return schema;
}

function format(schema: Schema): string {
  return JSON.stringify(schema, null, 2) + '\n';
}

function processTarget(outFile: string, generated: string, checkMode: boolean): boolean {
  if (checkMode) {
    let current = '';
    try {
      current = readFileSync(outFile, 'utf8');
    } catch {
      current = '';
    }
    if (current !== generated) {
      console.error(`drift: ${outFile} differs from generator output`);
      return false;
    }
    return true;
  }
  writeFileSync(outFile, generated, 'utf8');
  console.log(`wrote: ${outFile}`);
  return true;
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  let driftCount = 0;
  for (const t of TARGETS) {
    const generated = format(generate(t));
    if (!processTarget(t.outFile, generated, checkMode)) {
      driftCount += 1;
    }
  }
  if (checkMode) {
    if (driftCount > 0) {
      console.error(`gen_research_schemas: FAIL (${driftCount} drift(s))`);
      process.exit(1);
    }
    console.log('gen_research_schemas: ok (no drift)');
  } else {
    console.log(`gen_research_schemas: wrote ${TARGETS.length} schema(s)`);
  }
}

main();
