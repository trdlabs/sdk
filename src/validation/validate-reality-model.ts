// 017 Ф1 (`shared-execution-engine`) — структурная валидация `RealityModel`.
//
// Валидатор 017 stateless и не исполняет прогон: проверяется ФОРМА объявленной модели среды —
// конверт (id/version), присутствие обязательных слотов и членство `kind` каждого слота в его
// ЗАМКНУТОМ каталоге. Семантика модели (что именно применяется в paper/backtest/live) — вне 017.
//
// Разделение кодов зеркалит `unknown_metric`/`unsupported_market_data_kind`: неизвестный `kind` —
// не generic `schema_invalid`, а собственный код (fail-closed, без молчаливого fallback).
// `fillModel` сохраняет специфичный код 024 `unsupported_fill_model_kind`; остальные слоты —
// `unsupported_reality_model_kind`.

import {
  REALITY_MODEL_KIND_CATALOG,
  REALITY_MODEL_SLOTS,
  type RealityModel,
  type RealityModelSlotName,
} from '../research-contract/reality-model.js';
import type { ValidationCode, ValidationIssue, ValidationResult } from '../research-contract/validation.js';

import { assemble, makeIssue } from './assemble.js';
import { normalizeRealityModel } from './normalize.js';
import { jsonPointerOf, type SchemaRegistry } from './schema-registry.js';

/** Вход валидации модели среды (data-model §13.1). */
export interface RealityModelInput {
  readonly realityModel: RealityModel;
}

/** Код, владеющий неизвестным `kind` данного слота. */
function unsupportedKindCode(slot: RealityModelSlotName): ValidationCode {
  return slot === 'fillModel' ? 'unsupported_fill_model_kind' : 'unsupported_reality_model_kind';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Провалидировать объявленную модель среды. Чистая функция.
 *
 * Порядок владения ошибками слота: если `kind` вне каталога — слот принадлежит семантическому коду
 * целиком (schema-шум ветки `anyOf` подавляется). Если `kind` в каталоге, а полезная нагрузка
 * ветки нарушена (напр. `fixed_bps` без `bps`) — ошибка остаётся `schema_invalid`.
 */
export function validateRealityModel(
  input: RealityModelInput,
  registry: SchemaRegistry,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const model = asRecord(input.realityModel);
  if (model === null) {
    issues.push(makeIssue('schema_invalid', 'RealityModel должен быть объектом', ''));
    return assemble(issues);
  }

  // 1. Слоты с неизвестным `kind` — владение переходит семантическому коду.
  const slotsOwnedBySemanticCode = new Set<string>();
  for (const slot of REALITY_MODEL_SLOTS) {
    const value = model[slot];
    if (value === undefined || value === null) continue;
    const rec = asRecord(value);
    const kind = rec?.kind;
    if (typeof kind !== 'string') continue; // отсутствующий/нестроковый kind — это schema_invalid
    if (!REALITY_MODEL_KIND_CATALOG[slot].includes(kind)) {
      slotsOwnedBySemanticCode.add(slot);
      issues.push(
        makeIssue(
          unsupportedKindCode(slot),
          `${slot}.kind вне замкнутого каталога: ${kind}`,
          `/${slot}/kind`,
        ),
      );
    }
  }

  // 2. Схема конверта (обязательные поля, additionalProperties:false, ветки union'ов).
  for (const e of registry.validateCore('reality-model', input.realityModel)) {
    const path = jsonPointerOf(e);
    const slot = path.split('/')[1];
    if (slot !== undefined && slotsOwnedBySemanticCode.has(slot)) continue;
    issues.push(makeIssue('schema_invalid', e.message ?? 'нарушение схемы модели среды', path));
  }

  // Обязательность слотов `fillModel`/`feeModel`/`slippageModel` (среда без них недоопределена)
  // держит схема через `required` — отдельной проверки не нужно, иначе причина задваивается.

  const hasError = issues.some((i) => i.severity === 'error');
  return assemble(issues, hasError ? undefined : normalizeRealityModel(input.realityModel));
}
