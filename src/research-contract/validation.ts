// 017 — формы результата валидации и полная таксономия кодов (FR-021/FR-022/FR-023, data-model §13).

/** Уровень причины: `error` блокирует приём, `warning` — нет. */
export type Severity = 'error' | 'warning';

/**
 * Полная таксономия машиночитаемых кодов валидации (data-model §13.2).
 * Error-коды блокируют приём; warning-коды — нет.
 */
export type ValidationCode =
  // --- error ---
  | 'schema_invalid'
  | 'params_schema_invalid'
  | 'decision_schema_invalid'
  // Объявленная версия контракта вне поддерживаемого набора ЛИБО не покрывает объявленный surface
  // (083 E1: `lifecycle`/`onEvent` введены в `017.3`).
  | 'unsupported_contract_version'
  | 'unknown_strategy_ref'
  | 'multi_hook_overlay'
  | 'lookahead_violation'
  | 'forbidden_capability'
  | 'separation_violation'
  | 'missing_risk_profile'
  | 'unknown_metric'
  | 'invalid_module_ref'
  | 'incomplete_run_request'
  | 'promotion_requires_review'
  | 'duplicate_overlay_ref'
  | 'overlay_composition_invalid'
  | 'nondeterminism_violation'
  // --- error (023, аддитивно; закрытая таксономия рыночных потребностей) ---
  | 'unsupported_market_data_kind'
  | 'missing_required_market_data'
  // --- error (024, аддитивно; диспетч модели исполнения, R6) ---
  | 'unsupported_fill_model_kind'
  // --- error (Ф1 shared-execution-engine, аддитивно; замкнутые каталоги модели среды) ---
  // Владеет слотами `feeModel`/`slippageModel`/`fundingModel`/`latency`/`partialFill`;
  // слот `fillModel` сохраняет свой более специфичный код `unsupported_fill_model_kind` (024).
  | 'unsupported_reality_model_kind'
  // --- error (083 E1, аддитивно; соответствие набора хуков объявленной форме стратегии) ---
  | 'lifecycle_form_invalid'
  // --- error (083 S1 задача 3, аддитивно; закрытый каталог MarketDataRequirement, event_driven) ---
  // `event_driven` без хотя бы одного объявленного требования — гарантированная ошибка конфигурации.
  | 'missing_market_data_requirement'
  // `scope: 'venue'` в v1: архив не хранит и не будет хранить по-источниковые значения (свойство
  // данных, не временный пробел — см. doc `Scope`, event-driven.ts).
  | 'unsupported_market_data_scope'
  // `revisionPolicy.mode` вне `'final_only'` в v1: `provisional_and_revisions` не реализован
  // (единственное из трёх v1-отклонений задачи 3, которое — дорожная карта, а не свойство архива).
  | 'unsupported_revision_policy'
  // `funding` с `form: 'settlement'` в v1: датасета (колонки settlement) в архиве физически нет
  // (свойство данных, не политика — см. doc `FundingMarketDataRequirement`, event-driven.ts).
  | 'unsupported_funding_form'
  // Прогон молча пересёк границу `datasetId` без явного `DeclaredDatasetSplice` (требование 5,
  // event-driven.ts). Код зарезервирован для run plan: проверку окна исполняет НЕ sdk.
  | 'dataset_boundary_violation'
  // --- warning ---
  | 'empty_baseline_variant_diff';

/** Итоговый статус валидации (правила деривации — data-model §13.1). */
export type ValidationStatus = 'accepted' | 'accepted_with_warnings' | 'rejected';

/** Одна причина: severity + код + объяснение + JSON Pointer (RFC 6901) к узлу. */
export interface ValidationIssue {
  readonly severity: Severity;
  readonly code: ValidationCode;
  readonly message: string;
  /** JSON Pointer (RFC 6901) к нарушающему узлу; `""` — корень. */
  readonly path: string;
}

/**
 * Результат stateless-валидации (FR-021/FR-022/FR-023).
 * `normalized` присутствует при `accepted`/`accepted_with_warnings` (конкретная форма —
 * `NormalizedManifest` из слоя валидатора, `src/research/validation/normalize.ts`).
 * `issues` — полный набор причин (не только первая), стабильно отсортирован по `(path, code)`.
 */
export interface ValidationResult {
  readonly status: ValidationStatus;
  readonly normalized?: object;
  readonly issues: readonly ValidationIssue[];
}
