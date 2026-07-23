// 042 FU2 — публичный доступ к забандленным 017 JSON-схемам (для потребителей, которым нужны
// сырые схемы: backtester decision-revalidation/overlay schema-registry). Схемы лежат рядом с
// модулем (<module>/schemas/017/, build копирует src→dist) — self-contained в node_modules.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Имена core-схем конверта контракта 017. */
export type CoreSchemaName =
  | 'module-manifest'
  | 'strategy-decision'
  | 'overlay-decision'
  | 'backtest-run-request'
  | 'validation-result'
  | 'reality-model'
  | 'actor-input-event'
  | 'actor-command';

/** Имя core-схемы → имя JSON-файла. */
export const SCHEMA_FILES: Readonly<Record<CoreSchemaName, string>> = {
  'module-manifest': 'module-manifest.schema.json',
  'strategy-decision': 'strategy-decision.schema.json',
  'overlay-decision': 'overlay-decision.schema.json',
  'backtest-run-request': 'backtest-run-request.schema.json',
  'validation-result': 'validation-result.schema.json',
  'reality-model': 'reality-model.schema.json',
  'actor-input-event': 'actor-input-event.schema.json',
  'actor-command': 'actor-command.schema.json',
};

/** `$id` каждой core-схемы (parity-anchor). */
export const SCHEMA_IDS: Readonly<Record<CoreSchemaName, string>> = {
  'module-manifest': 'https://trading-platform/017/module-manifest.schema.json',
  'strategy-decision': 'https://trading-platform/017/strategy-decision.schema.json',
  'overlay-decision': 'https://trading-platform/017/overlay-decision.schema.json',
  'backtest-run-request': 'https://trading-platform/017/backtest-run-request.schema.json',
  'validation-result': 'https://trading-platform/017/validation-result.schema.json',
  'reality-model': 'https://trading-platform/017/reality-model.schema.json',
  'actor-input-event': 'https://trading-platform/017/actor-input-event.schema.json',
  'actor-command': 'https://trading-platform/017/actor-command.schema.json',
};

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'schemas', '017');

/** Распарсенный JSON core-схемы из забандленных ассетов пакета. */
export function schemaAsset(name: CoreSchemaName): Record<string, unknown> {
  const file = join(SCHEMAS_DIR, SCHEMA_FILES[name]);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`Cannot load 017 schema '${name}' from ${file}`, { cause });
  }
}

/** Все core-схемы в порядке каталога. */
export function allSchemaAssets(): readonly Record<string, unknown>[] {
  return (Object.keys(SCHEMA_FILES) as CoreSchemaName[]).map(schemaAsset);
}
