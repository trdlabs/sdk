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
  // `revisionPolicy.mode` вне `'final_only'` в v1 — СВОЙСТВО АРХИВА (раунд правок 2, С-1: прежняя
  // формулировка «не реализован» была ошибкой брифа, поправленной владельцем прозой): колонок
  // finality/revision в архиве нет — строка одна на (minute_ts, symbol), второй записи с тем же
  // ключом физически негде лежать (см. doc `RevisionPolicy`, event-driven.ts).
  | 'unsupported_revision_policy'
  // `funding` с `form: 'settlement'` в v1: датасета (колонки settlement) в архиве физически нет
  // (свойство данных, не политика — см. doc `FundingMarketDataRequirement`, event-driven.ts).
  | 'unsupported_funding_form'
  // Прогон молча пересёк границу `datasetId` без явного `DeclaredDatasetSplice` (требование 5,
  // event-driven.ts). Код зарезервирован для run plan: проверку окна исполняет НЕ sdk.
  | 'dataset_boundary_violation'
  // Структурная адекватность требования вне того, что выражает JSON Schema (раунд правок 2,
  // м-1): `lookback`/`interval` не целые/не положительные, `id`/`instrument.venue`/
  // `instrument.symbol` — пустая строка.
  | 'invalid_market_data_requirement'
  // Два требования одного манифеста с одинаковым `id` (раунд правок 2, К-5) — `id` единственная
  // ручка связи требования с binding'ом ниже по цепочке (задача 8); аналог `duplicate_overlay_ref`.
  | 'duplicate_market_data_requirement_id'
  // --- error (083 S1 задача 4, аддитивно; нормативные переходы `revision`, `observation-status.ts`) ---
  // Тот же номер ревизии с ДРУГИМ содержимым — два разных значения под одним номером физически
  // означают повреждённый поток, а не переиграть детерминированно (см. `checkRevisionTransition`).
  | 'observation_revision_conflict'
  // Переход запрошен ПОСЛЕ `final` (revision изменился) — `final` терминален в v1 (см. doc
  // `finality`, `observation-status.ts`); новая ревизия после final структурно не ожидается вовсе.
  | 'observation_revision_finalized'
  // Ревизия перескочила номер ПОСРЕДИ потока без явно объявленной `DeclaredRevisionSkipPolicy` —
  // fail-closed по умолчанию, «не молча» (требование 2 задачи 4). ОТДЕЛЬНЫЙ код от
  // `observation_revision_start_invalid` ниже (ревью M-7): потребитель, различающий по коду,
  // обязан отличить «не начали с 0» от «перескочили номер в середине».
  | 'observation_revision_skipped'
  // Ревизия УБЫВАЕТ (`next.revision < previous.revision`) — нарушение монотонности внутри
  // `(subscriptionId, effectiveTsUs)`.
  | 'observation_revision_regressed'
  // `revision` не целое неотрицательное число (`NaN`/дробь/отрицательное) — недоверенный источник,
  // TS-тип `number` этого не запрещает (ревью I-1, см. `isValidRevisionNumber`).
  | 'observation_revision_invalid'
  // `previous.effectiveTsUs !== next.effectiveTsUs` — сравниваются наблюдения под разными ключами
  // `(subscriptionId, effectiveTsUs)`, кеевание перепутано выше по стеку (ревью I-4).
  | 'observation_revision_key_mismatch'
  // Первое наблюдение ключа несёт `revision !== 0` без объявленной `skipPolicy` — отдельно от
  // `observation_revision_skipped` (ревью M-7, см. выше).
  | 'observation_revision_start_invalid'
  // `finality` снята с `final` на `provisional` при том же `revision` и том же содержимом —
  // терминальность нарушена в ОБРАТНУЮ сторону (снятие окончательности — новая информация, не
  // повторная доставка; уточнение владельца M-3, `checkRevisionTransition`).
  | 'observation_finality_demoted'
  // --- error (083 S1 задача 4, аддитивно; гейт валидности строки архива `parseArchiveRow`) ---
  // `(hasKind, value)` в одной из двух комбинаций, которые схема архива допускает физически
  // (колонки независимы), но которые не могут быть правдой одновременно — fail-closed, а не
  // угадывание намерения (см. doc `parseArchiveRow`, `observation-status.ts`).
  | 'observation_archive_row_corrupt'
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
