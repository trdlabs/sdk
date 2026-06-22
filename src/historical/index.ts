// @trading-platform/sdk/historical — materialized historical contract DTO surface.
//
// Standalone copy of the platform CanonicalRow v1/v2 on-disk shape. The SDK owns this
// DTO outright; it does NOT import platform internals. The conformance harness consumes
// CanonicalRowV2 from here.

export {
  SCHEMA_VERSION,
  CANONICAL_ROW_FIELDS,
  SCHEMA_VERSION_V2,
  CANONICAL_ROW_V2_FIELDS,
} from './canonical-row.js';

export type {
  CanonicalRow,
  CanonicalRowField,
  CanonicalRowV2,
  CanonicalRowV2Field,
} from './canonical-row.js';
