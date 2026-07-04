// @trdlabs/sdk — market-data shared contract types (standalone, SDK-owned).
//
// Initiative #2 (Stage 1): these two types previously lived in the SHED research barrel
// (contract/research/market-tape.ts). The root surface re-exports them, so they are inlined here as
// the SDK's own source of truth. They mirror the platform research contract.

/** Closed set of point-in-time market data kinds (research 023/027/028). */
export type MarketDataKind = 'openInterest' | 'liquidations' | 'funding' | 'taker';

/** Per-kind coverage state (research market-data coverage taxonomy). */
export type MarketDataCoverageState = 'present' | 'missing' | 'stale' | 'unsupported';
