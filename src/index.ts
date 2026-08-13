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
  // 083 S1 задача 3 — закрытый каталог видов MarketDataRequirement (research-contract/event-driven.ts).
  // НЕ путать с SUPPORTED_MARKET_DATA_KINDS выше — тот легаси-набор для dataNeeds-флагов 017.1-017.3.
  MARKET_DATA_KINDS,
  // 083 S1 задача 6 — единственный источник ранга вида рыночного наблюдения в merge key диспетча
  // (§3.8.2); экспортирован, чтобы engine/backtester не завели по своей копии.
  MARKET_KIND_RANK,
} from './contract/constants.js';

// --- Shared contract types (type re-export → zero runtime) ---
export type {
  // Легаси-каталог (переименован из MarketDataKind, 083 S1 задача 3 раунд правок 2, С-3/К-2) —
  // см. doc-комментарий в contract/market-data-kinds.ts.
  LegacyMarketDataKind,
  MarketDataCoverageState,
} from './contract/market-data-kinds.js';

// 083 S1 задача 3 — MarketDataKind чистое имя теперь принадлежит НОВОМУ каталогу.
export type { MarketDataKind } from './contract/constants.js';

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

/** Version of this SDK package. Kept in lockstep with package.json "version"
 *  by the version-consistency release guard (test/version-consistency.test.ts). */
export const SDK_VERSION = '0.17.1';

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
