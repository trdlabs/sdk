// @trdlabs/sdk/intake — intake error model (feature 036, Phase 9 / T052).
// The closed set of 5 intake error categories (mirrors the platform `IntakeErrorCategory`). `conflict`
// belongs to the write path (idempotency fingerprint mismatch); the Operations read surface uses a
// separate 4-category model and is NOT mixed in here.

import type { IntakeError, IntakeErrorCategory } from './dto.js';

/** The closed set of 5 intake error categories. */
export const INTAKE_ERROR_CATEGORIES = [
  'validation_error',
  'not_found',
  'conflict',
  'unsupported_query',
  'internal_error',
] as const satisfies readonly IntakeErrorCategory[];

/** Classify an intake error into one of the 5 categories. */
export function classifyIntakeError(error: IntakeError): IntakeErrorCategory {
  return error.category;
}
