// @trdlabs/sdk/ops-read — live bot-results wire types (types-only, own-declared).
//
// Source of truth for these shapes is trading-platform/src/operations/dto.ts (feature "ops-read 033").
// They are declared here verbatim (primitive / closed-union only — zero platform imports) and proven
// bidirectionally assignable to the platform DTOs by conformance/ops-read-dto.conformance.ts. Do NOT
// edit a field here without the conformance gate going green against operations/dto.ts.

export type BotMode = 'live' | 'paper' | 'backtest';
export type BotRunStatus = 'running' | 'finished' | 'crashed' | 'aborted';
export type TradeSide = 'long' | 'short';
export type OpsSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface BotRunStrategyRef {
  readonly name: string;
  readonly version: string;
}

export interface BotRunRecord {
  readonly runId: string;
  readonly mode: BotMode;
  readonly status: BotRunStatus;
  readonly strategy: BotRunStrategyRef;
  /** ops.6 (platform 074): bot_bundle id for bundle-backed runs (== candidateId when promoted
   *  from paper-intake, per platform 062) — exact join key for paper monitors; null for in-repo bots. */
  readonly bundleId: string | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly lastSeenMs: number;
  readonly symbols: readonly string[];
}

// ops.5 — canonical close-reason taxonomy (read-surface classification of journal facts).
// 'take_profit_partial' vs 'take_profit_final' is the discriminator lab's winner-selection cares about.
export type CloseReason =
  | 'take_profit_final'
  | 'take_profit_partial'
  | 'stop_loss'
  | 'breakeven'
  | 'trailing_stop'
  | 'signal_exit'
  | 'time_exit'
  | 'liquidation'
  | 'manual'
  | 'other';

export interface ClosedTrade {
  readonly tradeId: string;
  readonly runId: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly entryPrice: string | null;
  readonly exitPrice: string | null;
  readonly realizedPnl: string;
  readonly pnlPct: string;
  readonly isWin: boolean | null;
  readonly closeReason: CloseReason | null;
  readonly closeReasonRaw: string | null;
}

// ops.4 — per-trade forensic evidence (Surface A): prices + lifecycle timeline.
// 'sl'/'stop_update' are part of the union for forward-compat, but the platform never synthesizes
// them (a stop-loss appears as closeReason='stop_loss' on the 'exit' event), so they don't occur.
export type OpsTradeLifecycleEventType = 'entry' | 'dca' | 'tp' | 'sl' | 'exit' | 'stop_update';

export interface TradeLifecycleEvent {
  readonly tsMs: number;
  readonly type: OpsTradeLifecycleEventType;
  readonly price: string | null;
  readonly qty: string | null;
  readonly note?: string | null;
}

export interface TradeEvidence {
  readonly tradeId: string;
  readonly runId: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly entryPrice: string | null;
  readonly exitPrice: string | null;
  readonly realizedPnl: string;
  readonly pnlPct: string;
  readonly closeReason: CloseReason | null;
  readonly closeReasonRaw: string | null;
  readonly lifecycle: readonly TradeLifecycleEvent[];
}

export interface ClosedTradesAggregate {
  readonly closedTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  readonly winratePct: number;
  readonly pnlUsd: string;
  readonly avgPnl: string;
  readonly exitReasons: Record<string, number>;
}

export interface RunSummary extends ClosedTradesAggregate {
  readonly runId: string;
  readonly excludesReconcile: boolean;
  readonly asOf: number;
}

export interface OperationalEvent {
  readonly category: string;
  readonly severity: OpsSeverity | null;
  readonly runId: string;
  readonly tradeId: string | null;
  readonly tsMs: number;
  readonly safeMessage: string;
}

export interface DecisionLogEntry {
  readonly category: string;
  readonly runId: string;
  readonly botId: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly reason: string;
  readonly tsMs: number;
  readonly safeMessage: string;
}
