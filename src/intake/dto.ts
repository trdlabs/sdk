// @trdlabs/sdk/intake — own-declared paper-candidate intake DTOs (feature 036, Phase 9 / T051).
//
// Structurally equivalent to the platform's intake wire types (src/admissions/dto.ts) and read view
// (src/operations/dto.ts). The SDK OWNS this surface (own-declared, NOT vendored via the snapshot) so
// consumers never import platform internals; verify_036_type_conformance proves bidirectional
// assignability against the platform types. Pure types — zero runtime, zero platform imports.

// --- shared primitives ---
/** Opaque, stable, non-parseable external id (platform-issued; e.g. candidateId / supersededBy). */
export type OpaqueId = string;
/** Client-supplied canonical dedup key (after normalization). */
export type IdempotencyKey = string;

// --- closed vocabularies (mirror canonical CHECK constraints) ---
export type CandidateSource = 'trading-lab' | 'agent' | 'manual';
export type AgentDecision = 'recommendation_for_paper';
export type AdmissionStatus = 'admitted' | 'rejected' | 'quarantined' | 'superseded';
export type AdmissionOutcome = 'admitted' | 'rejected' | 'quarantined';

// --- request: evidence anchors + strategy ref ---
export interface PaperCandidateEvidenceInput {
  readonly baselineRunId: string;
  readonly variantRunId: string;
  readonly artifactRefs?: readonly string[];
  readonly externalEvidenceRef?: string | null;
  readonly datasetRef: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly metricsSnapshot: Record<string, unknown>;
  readonly comparisonSnapshot?: Record<string, unknown> | null;
  readonly improvementSummary?: string | null;
  readonly evaluationVerdict: { readonly recommendationForPaper: boolean; readonly summary: string };
  readonly riskNotes?: string | null;
}

export interface PaperCandidateStrategyInput {
  readonly strategyProfileRef?: string | null;
  readonly moduleRef?: string | null;
  readonly moduleBundleHash?: string | null;
  /**
   * Identity/params (platform 062, additive & optional): projected into
   * bot_bundle.metadata on promotion — a bundle without strategyName+side is
   * not launchable by the bundle-host. `side` accepts only 'long'|'short'
   * (platform allowlist-projection silently drops anything else); `params`
   * is the strategy's own free-form parameter object.
   */
  readonly strategyName?: string | null;
  readonly side?: 'long' | 'short' | null;
  readonly params?: Record<string, unknown> | null;
}

/** Convenience alias for the evidence-anchor bundle a candidate carries. */
export type EvidenceAnchor = PaperCandidateEvidenceInput;

export interface PaperCandidateIntakeRequest {
  readonly source: CandidateSource;
  readonly idempotencyKey?: IdempotencyKey;
  readonly sourceRecommendationId?: string;
  readonly agentDecision: AgentDecision;
  readonly evidence: PaperCandidateEvidenceInput;
  readonly strategy: PaperCandidateStrategyInput;
  readonly governance?: Record<string, unknown>;
  readonly createdBy?: string;
  readonly workflowId?: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  /** opaque candidateId OR prior source-scoped idempotency_key. */
  readonly supersedes?: string;
}

// --- errors (5 categories; includes `conflict` for the write path) ---
export type IntakeErrorCategory =
  | 'validation_error'
  | 'not_found'
  | 'conflict'
  | 'unsupported_query'
  | 'internal_error';

export interface IntakeError {
  readonly category: IntakeErrorCategory;
  readonly code: string;
  readonly message: string;
}

// --- result (discriminated) ---
export type PaperCandidateIntakeResult =
  | {
      readonly ok: true;
      readonly candidateId: OpaqueId;
      readonly admissionStatus: AdmissionStatus;
      readonly admissionReasonCode: string | null;
      readonly idempotentReplay: boolean;
    }
  | { readonly ok: false; readonly error: IntakeError };

// --- read view (Operations API projection; safe fields only) ---
export interface PaperCandidateEvidenceRefs {
  readonly baselineRunId: string;
  readonly variantRunId: string;
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly artifactRefCount: number;
  readonly hasExternalEvidenceRef: boolean;
}

export interface PaperCandidateReadView {
  readonly candidateId: OpaqueId;
  readonly source: CandidateSource;
  readonly agentDecision: AgentDecision;
  readonly admissionStatus: AdmissionStatus;
  readonly admissionOutcome: AdmissionOutcome;
  readonly admissionReasonCode: string | null;
  readonly evidenceRefs: PaperCandidateEvidenceRefs;
  readonly supersededBy: OpaqueId | null;
  readonly createdAtMs: number;
  readonly admittedAtMs: number | null;
  readonly rejectedAtMs: number | null;
  readonly quarantinedAtMs: number | null;
  readonly supersededAtMs: number | null;
  readonly asOf: number;
}
