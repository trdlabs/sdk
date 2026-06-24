// 017 — реестр компиляции JSON Schema через ajv (research D2/D7).
//
// Источник истины — TS-типы контракта; схемы ГЕНЕРИРУЮТСЯ из них в
// specs/017-strategy-hypothesis-contract/contracts/*.schema.json (gen:research-schemas). Реестр
// компилирует эти core-схемы (кэш) и author-supplied paramsSchema.
//
// Замечание о диалекте: ts-json-schema-generator (мандат D3) эмитит draft-07; поэтому реестр
// использует стандартный ajv (draft-07). Набор используемых ключевых слов (anyOf,
// additionalProperties:false, enum/const) идентичен 2020-12 — функциональной разницы для контракта
// нет. `instancePath` ajv — уже JSON Pointer (RFC 6901, D7) для поля `path` причины.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';

/** Имена 5 core-схем конверта контракта (файлы в specs/.../contracts/). */
export type CoreSchemaName =
  | 'module-manifest'
  | 'strategy-decision'
  | 'overlay-decision'
  | 'backtest-run-request'
  | 'validation-result';

const SCHEMA_FILES: Readonly<Record<CoreSchemaName, string>> = {
  'module-manifest': 'module-manifest.schema.json',
  'strategy-decision': 'strategy-decision.schema.json',
  'overlay-decision': 'overlay-decision.schema.json',
  'backtest-run-request': 'backtest-run-request.schema.json',
  'validation-result': 'validation-result.schema.json',
};

/** `$id` каждой core-схемы (совпадает с генерируемым `schemaId`, gen_research_schemas.ts). */
export const SCHEMA_IDS: Readonly<Record<CoreSchemaName, string>> = {
  'module-manifest': 'https://trading-platform/017/module-manifest.schema.json',
  'strategy-decision': 'https://trading-platform/017/strategy-decision.schema.json',
  'overlay-decision': 'https://trading-platform/017/overlay-decision.schema.json',
  'backtest-run-request': 'https://trading-platform/017/backtest-run-request.schema.json',
  'validation-result': 'https://trading-platform/017/validation-result.schema.json',
};

/** Результат компиляции author-supplied paramsSchema. */
export type ParamsCompileResult =
  | { readonly ok: true; readonly validate: ValidateFunction }
  | { readonly ok: false; readonly error: string };

/** Реестр компилированных схем контракта. */
export interface SchemaRegistry {
  /** Провалидировать данные против core-схемы; `[]` — валидно, иначе список ajv-ошибок. */
  validateCore(name: CoreSchemaName, data: unknown): readonly ErrorObject[];
  /**
   * Провалидировать данные против конкретной ветки union по `$ref` (например
   * `…strategy-decision.schema.json#/definitions/EnterDecision`) — чистые ошибки одной ветки
   * вместо шумного `anyOf`. `[]` — валидно.
   */
  validateRef(refId: string, data: unknown): readonly ErrorObject[];
  /** Скомпилировать произвольную author-supplied JSON Schema параметров. */
  compileParams(paramsSchema: object): ParamsCompileResult;
}

/**
 * `instancePath` ajv-ошибки как JSON Pointer (RFC 6901); `""` — корень (D7).
 * Для `required` указывает на отсутствующее поле (`<instancePath>/<missingProperty>`).
 */
export function jsonPointerOf(err: ErrorObject): string {
  if (err.keyword === 'required') {
    const mp = (err.params as { missingProperty?: string }).missingProperty;
    if (mp !== undefined) return `${err.instancePath}/${mp}`;
  }
  return err.instancePath;
}

/**
 * Создать реестр: компилирует и кэширует core-схемы, компилирует author paramsSchema с мемоизацией.
 * Один ajv-инстанс (`allErrors:true` — полный набор причин, FR-022; `strict:false` — совместимость
 * с генерируемыми схемами).
 */
export function createSchemaRegistry(): SchemaRegistry {
  // Схемы бандлятся ВНУТРИ пакета: <module>/schemas/017/*.json (build копирует src→dist).
  // Self-contained в node_modules — без чтения repo-дерева (042 FR-003).
  const contractsDir = join(dirname(fileURLToPath(import.meta.url)), 'schemas', '017');

  const ajv = new Ajv({ allErrors: true, strict: false });

  const coreCache = new Map<CoreSchemaName, ValidateFunction>();
  for (const name of Object.keys(SCHEMA_FILES) as CoreSchemaName[]) {
    const schema = JSON.parse(readFileSync(join(contractsDir, SCHEMA_FILES[name]), 'utf8')) as object;
    coreCache.set(name, ajv.compile(schema));
  }

  const paramsCache = new Map<string, ParamsCompileResult>();

  return {
    validateCore(name, data) {
      const validate = coreCache.get(name);
      if (validate === undefined) {
        throw new Error(`schema-registry: unknown core schema "${name}"`);
      }
      validate(data);
      return validate.errors ?? [];
    },
    validateRef(refId, data) {
      const validate = ajv.getSchema(refId);
      if (validate === undefined) {
        throw new Error(`schema-registry: unknown ref "${refId}"`);
      }
      validate(data);
      return validate.errors ?? [];
    },
    compileParams(paramsSchema) {
      const key = JSON.stringify(paramsSchema);
      const cached = paramsCache.get(key);
      if (cached !== undefined) return cached;
      let result: ParamsCompileResult;
      try {
        result = { ok: true, validate: ajv.compile(paramsSchema) };
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      paramsCache.set(key, result);
      return result;
    },
  };
}
