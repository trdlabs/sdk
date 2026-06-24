// 017 — замкнутые union'ы решений (FR-006/FR-007, research D9, data-model §6/§7).
//
// Disambiguation: StrategyDecision/OverlayDecision (017) — ОТДЕЛЬНАЯ таксономия от существующих
// Decision/DecisionAction replay-гипотез (src/contracts/hypothesis.ts). Не смешивать.
//
// Дискриминатор `kind`; `additionalProperties:false` на каждой ветке обеспечивается генератором
// схем. hint-поля (`stop`/`take`/`ttl`/`sizingHint`) — валидны; их accept/clamp/reject — за
// RiskProfile (FR-015), не `separation_violation`.

/** Вход в позицию. `side` обязателен — направление в решении, не глобально (FR-006). */
export interface EnterDecision {
  readonly kind: 'enter';
  readonly side: 'long' | 'short';
  readonly entry?: object;
  readonly stop?: number;
  readonly take?: number;
  readonly ttl?: number;
  readonly sizingHint?: number;
  readonly tags?: readonly string[];
  readonly rationale?: string;
  readonly evidenceRefs?: readonly string[];
}

/** Выход из позиции. */
export interface ExitDecision {
  readonly kind: 'exit';
  readonly target: string;
  readonly percent?: number;
  readonly reason?: string;
}

/** Доливка/scale-in как intent. */
export interface AddToPositionDecision {
  readonly kind: 'add_to_position';
  readonly mode: 'dca' | 'scale_in';
  readonly sizingHint?: number;
}

/** Обновление protection-hints (stop/take). */
export interface UpdateProtectionDecision {
  readonly kind: 'update_protection';
  readonly stop?: number;
  readonly take?: number;
}

/** Только аннотация/метаданные (без действия). */
export interface AnnotateDecision {
  readonly kind: 'annotate';
  readonly tags?: readonly string[];
  readonly metrics?: object;
  readonly rationale?: string;
}

/** Отсутствие действия. */
export interface IdleDecision {
  readonly kind: 'idle';
}

/** Замкнутый union решений стратегии (FR-006). */
export type StrategyDecision =
  | EnterDecision
  | ExitDecision
  | AddToPositionDecision
  | UpdateProtectionDecision
  | AnnotateDecision
  | IdleDecision;

/** Не меняет accumulated decision. */
export interface OverlayPassDecision {
  readonly kind: 'pass';
}

/** Terminal для текущего base decision/hook. */
export interface OverlayVetoDecision {
  readonly kind: 'veto';
  readonly reasonCode: string;
  readonly rationale?: string;
}

/** Структурный patch над решением базовой стратегии; после применения решение снова schema-valid. */
export interface OverlayPatchDecision {
  readonly kind: 'patch';
  readonly patch: object;
}

/** Добавляет только metadata. */
export interface OverlayAnnotateDecision {
  readonly kind: 'annotate';
  readonly tags?: readonly string[];
  readonly notes?: string;
}

/** Замкнутый union решений overlay (FR-007); семантика применения — для будущего runner (D10). */
export type OverlayDecision =
  | OverlayPassDecision
  | OverlayVetoDecision
  | OverlayPatchDecision
  | OverlayAnnotateDecision;
