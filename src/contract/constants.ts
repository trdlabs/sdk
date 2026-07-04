// @trdlabs/sdk — contract capability/versioning constants (standalone, SDK-owned).
//
// Initiative #2 (Stage 1): the research vendored snapshot (contract/research/**) is SHED. The root
// surface only needs the capability/versioning constants, so they are inlined here as the SDK's own
// source of truth. These values mirror the platform research contract catalogs; bumping them is
// policed downstream by the platform's contract gates.

/** Research contract version (platform 030 bumped to `017.2`). */
export const CONTRACT_VERSION = '017.2' as const;

/** Supported research contract versions (back-compat: `017.1` manifests remain valid). */
export const SUPPORTED_CONTRACT_VERSIONS = ['017.1', '017.2'] as const;

/** Supported point-in-time market data kinds (research 023/027/028). */
export const SUPPORTED_MARKET_DATA_KINDS = [
  'openInterest',
  'liquidations',
  'funding',
  'taker',
] as const;
