// Ops Read contract version — own axis, INDEPENDENT of research CONTRACT_VERSION (017.x).
// Mirrors trading-platform/src/operations/version.ts. Bumping this is policed by the platform's
// ops zero-bump gates; this SDK copy must equal the platform value (asserted indirectly via the
// downstream mock's exact-match compat gate).
// ops.6 (platform 074): BotRunRecord.bundleId + runs-фильтр ?bundleId= (candidateId↔run join).
export const OPS_READ_CONTRACT_VERSION = 'ops.6' as const;
export type OpsReadContractVersion = typeof OPS_READ_CONTRACT_VERSION;
