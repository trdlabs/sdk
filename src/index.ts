// @trdlabs/sdk — root surface (Initiative #2, standalone public repo).
//
// Contract-first facade root. Standalone: contract CONSTANTS and TYPES are SDK-owned under
// ./contract/** (Initiative #2 inlined the capability/versioning surface; the research barrel is
// shed). The SDK does NOT import the platform package at runtime or build time. No internal platform
// paths are referenced.

// --- Contract constants (value re-export → SDK-owned) ---
export {
  CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  SUPPORTED_MARKET_DATA_KINDS,
} from './contract/constants.js';

// --- Shared contract types (type re-export → zero runtime) ---
export type {
  MarketDataKind,
  MarketDataCoverageState,
} from './contract/market-data-kinds.js';

// --- Historical contract DTO (materialized; SDK-owned) ---
export {
  SCHEMA_VERSION,
  CANONICAL_ROW_FIELDS,
  SCHEMA_VERSION_V2,
  CANONICAL_ROW_V2_FIELDS,
} from './historical/index.js';

export type {
  CanonicalRow,
  CanonicalRowField,
  CanonicalRowV2,
  CanonicalRowV2Field,
} from './historical/index.js';

/** Version of this SDK package. */
export const SDK_VERSION = '0.9.4';

/**
 * Machine-checkable declaration of capabilities the SDK deliberately does NOT have.
 * Every flag is `false` — the capability-absence gate (verify_032_capability_absence) asserts this.
 */
export interface SdkCapabilityDescriptor {
  /** Live market connectivity / order placement. */
  readonly live: false;
  /** Execution authority (placing orders, executing submitted modules). */
  readonly execution: false;
  /** Access to exchange credentials. */
  readonly credentials: false;
  /** Triggering ingestion / market recording. */
  readonly ingestion: false;
  /** Direct raw storage reads (Parquet/DuckDB). */
  readonly rawStorage: false;
}

/** The SDK's capability descriptor — all capabilities absent by construction. */
export const SDK_CAPABILITIES: SdkCapabilityDescriptor = {
  live: false,
  execution: false,
  credentials: false,
  ingestion: false,
  rawStorage: false,
};
