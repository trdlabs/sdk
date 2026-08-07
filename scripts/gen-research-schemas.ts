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

/**
 * 083 S1, финальная волна ревью ветки (Б-4) — числовые ограничения, которых TS-тип не выражает, а
 * дока обещает.
 *
 * Проблема была ровно в разрыве между двумя: `TimestampUs`/`DurationUs` — бранд-типы над `number`,
 * их JSDoc говорит «целое, неотрицательное, safe-integer», рантайм-конструкторы (`timestampUs`,
 * `durationUs`, `time-us.ts`) это проверяют, а генератор выдавал `{"type":"number"}` — то есть
 * схема, единственный гейт НА ГРАНИЦЕ ИЗОЛЯТА, где рантайм-конструкторов нет вовсе, обещанного не
 * требовала. Проверено ajv по схемам из `dist`: `timer.set` с `atTs: 1.5` и с `atTs: -1000`,
 * `fill` с `ts: 1.5` и с `qty: -5`, `revision: -1.5` — ВСЕ валидны. Правило №7 задачи («гейт,
 * полагающийся на типы вызывающего, гейтом не является») здесь нарушалось буквально: команда,
 * пришедшая из недоверенного изолята, проходила схему с дробным моментом времени.
 *
 * Чинится В ГЕНЕРАТОРЕ, а не правкой JSON (схемы не редактируются руками — `--check` гейтит дрейф).
 *
 * ЧТО НЕ трогаем и почему (решение, а не пробел):
 * - `price`/`stopPrice`/`fee`/`fundingRate` — контракт НЕ обещает про них ничего, кроме конечности
 *   (`fee` законно отрицателен на maker-rebate, `fundingRate` — на инвертированном фандинге,
 *   отрицательная цена наблюдалась на реальных фьючерсах). Схема, требующая больше доки, — тот же
 *   разрыв, только в другую сторону.
 * - `lookback`/`interval` в манифесте — их семантические границы уже проверяет `validate-module.ts`
 *   СВОИМ кодом (`invalid_market_data_requirement`), и подмена его на generic `schema_invalid`
 *   ухудшила бы диагностику (тот же довод, по которому существует `relaxDataNeedsAdditionalProps`
 *   выше). Целочисленность `interval` при этом закрывается сама — через общий `DurationUs`.
 */
const NUMERIC_DEFINITION_CONSTRAINTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // Момент — целый неотрицательный (`isTimestampUs`).
  TimestampUs: { type: 'integer', minimum: 0 },
  // Длительность — целая; знак законен (разность моментов), поэтому только `integer`.
  DurationUs: { type: 'integer' },
};

/**
 * Числовые ограничения по ИМЕНИ свойства. Применяются к каждой подсхеме `properties`, но ТОЛЬКО
 * если текущий узел — ровно `{"type":"number"}` (плюс `description`): так правка не может молча
 * переписать поле, форма которого изменилась в типах, — новая форма просто не совпадёт с образцом
 * и останется как есть, а расхождение поймает ревьюер, а не рантайм.
 */
const NUMERIC_PROPERTY_CONSTRAINTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // `ObservedValue.revision` — `isValidRevisionNumber` (observation-status.ts) требует целое ≥ 0.
  revision: { type: 'integer', minimum: 0 },
  // Количества: `ActorFillEvent.qty` («всегда положительный размер исполнения»),
  // `ActorPlaceCommand.qtyUsd` («запрашиваемый нотионал») — ноль и отрицательное неисполнимы.
  qty: { exclusiveMinimum: 0 },
  qtyUsd: { exclusiveMinimum: 0 },
  // Величины, про которые doc значений рыночных событий говорит `≥ 0`.
  volume: { minimum: 0 },
  oiTotalUsd: { minimum: 0 },
  longUsd: { minimum: 0 },
  shortUsd: { minimum: 0 },
  buyUsd: { minimum: 0 },
  sellUsd: { minimum: 0 },
};

/** Узел — ровно `{"type":"number"}` (с необязательным `description`)? */
function isPlainNumberNode(node: unknown): node is Record<string, unknown> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
  const keys = Object.keys(node).filter((k) => k !== 'description');
  return keys.length === 1 && keys[0] === 'type' && (node as Record<string, unknown>).type === 'number';
}

function tightenNumericConstraints(schema: Schema): void {
  const root = schema as Record<string, unknown>;
  const defs = root.definitions;
  if (typeof defs === 'object' && defs !== null) {
    for (const [name, constraint] of Object.entries(NUMERIC_DEFINITION_CONSTRAINTS)) {
      const node = (defs as Record<string, unknown>)[name];
      if (isPlainNumberNode(node)) Object.assign(node, constraint);
    }
  }
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    const props = record.properties;
    if (typeof props === 'object' && props !== null && !Array.isArray(props)) {
      for (const [name, child] of Object.entries(props as Record<string, unknown>)) {
        const constraint = NUMERIC_PROPERTY_CONSTRAINTS[name];
        if (constraint !== undefined && isPlainNumberNode(child)) Object.assign(child, constraint);
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(root);
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
  // 083 S1, финальная волна — числовые ограничения контракта во ВСЕХ схемах (см. doc выше).
  tightenNumericConstraints(schema);
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
