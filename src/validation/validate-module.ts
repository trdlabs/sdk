// 017 — ядро структурной валидации манифеста модуля (FR-020, US1).
// 017 НЕ исполняет тело модуля: проверяются manifest + author-supplied sampleDecisions (research D6).
//
// US1 (этот шаг): kind:'strategy' — конверт, версия контракта, params↔paramsSchema, decision-схема
// sample-решений, обязательность onBarClose, submit-статус research_only. Overlay-специфичные
// гейты (multi_hook/unknown_strategy_ref/separation) добавляются в US2 (T025).

import type { ContractContext } from '../research-contract/catalogs.js';
import {
  DEFAULT_STRATEGY_LIFECYCLE,
  EVENT_DRIVEN_HOOKS,
  EVENT_DRIVEN_MIN_CONTRACT_VERSION,
  SYMBOL_FROM_MIN_CONTRACT_VERSION,
  LIFECYCLE_FIELD_MIN_CONTRACT_VERSION,
  STRATEGY_LIFECYCLES,
  type StrategyLifecycle,
} from '../research-contract/event-driven.js';
import type { LifecycleHook, ModuleManifest } from '../research-contract/module.js';
import type { ValidationIssue, ValidationResult } from '../research-contract/validation.js';

import { assemble, makeIssue } from './assemble.js';
import { normalizeManifest } from './normalize.js';
import { SCHEMA_IDS, jsonPointerOf, type SchemaRegistry } from './schema-registry.js';

/** Вход валидации модуля (author-supplied; data-model §13.1). */
export interface ModuleInput {
  readonly manifest: ModuleManifest;
  readonly sampleDecisions?: readonly unknown[];
}

/** kind решения стратегии → имя ветки в strategy-decision.schema.json. */
const STRATEGY_DECISION_DEFS: Readonly<Record<string, string>> = {
  enter: 'EnterDecision',
  exit: 'ExitDecision',
  add_to_position: 'AddToPositionDecision',
  update_protection: 'UpdateProtectionDecision',
  annotate: 'AnnotateDecision',
  idle: 'IdleDecision',
};

/** kind решения overlay → имя ветки в overlay-decision.schema.json. */
const OVERLAY_DECISION_DEFS: Readonly<Record<string, string>> = {
  pass: 'OverlayPassDecision',
  veto: 'OverlayVetoDecision',
  patch: 'OverlayPatchDecision',
  annotate: 'OverlayAnnotateDecision',
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Закрытый набор полей зоны RiskProfile/ExecutionProfile (FR-015, SC-006). Их присутствие в
 * манифесте/решении/overlay-`patch` → `separation_violation`. hint-поля (`stop`/`take`/`ttl`/
 * `sizingHint`/`update_protection`) сюда НЕ входят и нарушением не являются.
 */
const SEPARATION_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'size',
  'sizing',
  'qty',
  'quantity',
  'notional',
  'leverage',
  'exposure',
  'exposureLimits',
  'fee',
  'fees',
  'feeModel',
  'slippage',
  'slippageModel',
  'fill',
  'fillModel',
  'maxConcurrentPositions',
  'portfolioConstraints',
  'hardConstraints',
  'hardPortfolioConstraints',
]);

/** Объявленные потребности в данных, означающие lookahead (data-model §13.4). */
const LOOKAHEAD_NEEDS = ['forwardBars', 'forwardWindow', 'oracle', 'labeling', 'postTradeOutcome'] as const;

/** Объявленные потребности, означающие недетерминизм (FR-019). */
const NONDETERMINISM_NEEDS = ['wallClock', 'uncontrolledRandom'] as const;

/** Структурные point-in-time потребности 017 (всегда легитимны). */
const STRUCTURAL_NEEDS = ['closedCandlesUpToCurrent', 'asOfIndicators'] as const;

/**
 * 083 S1 задача 3 — семантика `manifest.marketData`, которую JSON-схема (шаг 1) не выражает: три
 * ЗАКРЫТЫЕ оси (`scope`, `revisionPolicy.mode`, `funding.form`) и структурная адекватность
 * (`id`/`lookback`/`interval`/`instrument`) — ТИПОВО легальные значения, схема их пропустит.
 *
 * Три оси проверяются БЕЛЫМ списком, не чёрным (раунд правок 2, К-4): каталог `kind` защищён
 * двусторонней типовой гарантией (`event-driven.ts`), но `scope`/`revisionPolicy.mode`/
 * `funding.form` — обычные string-поля без такой защиты; чёрный список (`=== 'venue'`) пропускал
 * бы ЛЮБОЕ третье значение без единого issue, хотя дока обещает «только aggregate»/«только
 * final_only»/«только rate». Тот же принцип уже применяет соседний `recognizedNeeds` выше (023).
 *
 * Все три v1-отклонения — СВОЙСТВО АРХИВА, ни одно не дорожная карта (раунд правок 2, С-1: прежняя
 * формулировка «revisionPolicy не реализован» была ошибкой брифа, поправленной владельцем прозой —
 * полное обоснование в doc `RevisionPolicy`, `event-driven.ts`).
 *
 * Вход НЕ типизирован как `MarketDataRequirement[]` намеренно: на входе валидатора — недоверенный
 * JSON, а не типизированное значение (та же дисциплина, что `asRecord`/`dataNeeds` выше). Элемент,
 * структурно не дотягивающий до объекта, здесь молча пропускается — за него уже отвечает
 * `schema_invalid` (шаг 1).
 */
function validateMarketDataRequirements(marketData: unknown, issues: ValidationIssue[]): void {
  if (!Array.isArray(marketData)) return;
  const seenIds = new Set<string>();

  marketData.forEach((entry, i) => {
    const req = asRecord(entry);
    if (req === null) return;
    const base = `/marketData/${i}`;

    // Белый список: scope легален ТОЛЬКО 'aggregate', когда присутствует — candles его вообще не
    // несёт (undefined там структурная норма, не отсутствующее значение).
    if (req.scope !== undefined && req.scope !== 'aggregate') {
      issues.push(
        makeIssue(
          'unsupported_market_data_scope',
          `scope "${String(req.scope)}" не резолвится в v1 — архив не хранит и не будет хранить ` +
            `по-источниковые значения (kind "${String(req.kind)}")`,
          `${base}/scope`,
        ),
      );
    }

    // Белый список: revisionPolicy.mode легален ТОЛЬКО 'final_only'. Отсутствие всего поля сюда
    // не заходит (revisionPolicy === null): по умолчанию равносильно final_only (м-8).
    const revisionPolicy = asRecord(req.revisionPolicy);
    if (revisionPolicy !== null && revisionPolicy.mode !== 'final_only') {
      issues.push(
        makeIssue(
          'unsupported_revision_policy',
          `revisionPolicy.mode "${String(revisionPolicy.mode)}" не резолвится в v1 — колонок ` +
            `finality/revision в архиве нет: строка одна на (minute_ts, symbol), второй записи с ` +
            `тем же ключом физически негде лежать (принимается только final_only)`,
          `${base}/revisionPolicy/mode`,
        ),
      );
    }

    // Белый список: form легален ТОЛЬКО 'rate' — проверяется только у funding, у остальных видов
    // поля form не существует вовсе.
    if (req.kind === 'funding' && req.form !== 'rate') {
      issues.push(
        makeIssue(
          'unsupported_funding_form',
          `funding с form "${String(req.form)}" не резолвится в v1: соответствующего датасета ` +
            `(колонки settlement) в архиве нет`,
          `${base}/form`,
        ),
      );
    }

    // К-5: id — единственная ручка связи требования с binding'ом ниже по цепочке (задача 8);
    // дубль делает связывание неоднозначным именно там, где резолвер обязан быть fail-closed.
    if (typeof req.id === 'string') {
      if (req.id.length === 0) {
        issues.push(
          makeIssue('invalid_market_data_requirement', 'id требования не может быть пустой строкой', `${base}/id`),
        );
      } else if (seenIds.has(req.id)) {
        issues.push(
          makeIssue(
            'duplicate_market_data_requirement_id',
            `id "${req.id}" уже использован другим требованием этого манифеста`,
            `${base}/id`,
          ),
        );
      }
      seenIds.add(req.id);
    }

    // м-1: числовые/строковые границы, которые тип не выражает (DurationUs допускает отрицательные
    // значения как разность моментов — здесь interval, а не разность, отрицательное/нулевое
    // значение бессмысленно; lookback — число шагов, отрицательное/дробное тоже).
    if (typeof req.lookback === 'number' && (!Number.isInteger(req.lookback) || req.lookback < 0)) {
      issues.push(
        makeIssue(
          'invalid_market_data_requirement',
          `lookback должен быть целым неотрицательным числом шагов длиной interval, получено: ${req.lookback}`,
          `${base}/lookback`,
        ),
      );
    }
    if (typeof req.interval === 'number' && (!Number.isInteger(req.interval) || req.interval <= 0)) {
      issues.push(
        makeIssue(
          'invalid_market_data_requirement',
          `interval должен быть положительным целым числом микросекунд, получено: ${req.interval}`,
          `${base}/interval`,
        ),
      );
    }
    const instrument = asRecord(req.instrument);
    if (instrument !== null) {
      if (typeof instrument.venue === 'string' && instrument.venue.length === 0) {
        issues.push(
          makeIssue(
            'invalid_market_data_requirement',
            'instrument.venue не может быть пустой строкой',
            `${base}/instrument/venue`,
          ),
        );
      }
      if (typeof instrument.symbol === 'string' && instrument.symbol.length === 0) {
        issues.push(
          makeIssue(
            'invalid_market_data_requirement',
            'instrument.symbol не может быть пустой строкой',
            `${base}/instrument/symbol`,
          ),
        );
      }
    }

    // ── ПРИВЯЗКА ТРЕБОВАНИЯ К ИНСТРУМЕНТУ: две ветви, и обе проверяются ЗДЕСЬ ──────────────
    //
    // Схема закрывает форму (`additionalProperties: false`, перечень `required`), но не может
    // выразить «ровно одна из двух ветвей»: у связанной ветви `instrument.symbol` обязан
    // ОТСУТСТВОВАТЬ, у фиксированной — присутствовать. Манифест приходит из JSON, где типов нет.
    //
    // Различитель — `symbolFrom`, а не отсутствие символа. Отсутствие ключа как разрешающее
    // значение неотличимо от потери поля; потеря же `symbolFrom` переводит требование в
    // фиксированную ветвь, где символ обязателен, и отказ наступает сразу.
    // Значение `symbolFrom` здесь НЕ проверяется, и это не упущение. Замкнутый каталог живёт в
    // схеме: обе ветви `anyOf` объявлены с `additionalProperties: false`, и требование с чужим
    // значением не подходит ни к одной — отказ приходит кодом `schema_invalid`. Дублирующая
    // проверка была написана и УДАЛЕНА после мутационного контроля: снятие её не краснило ни одной
    // пробы, потому что до неё исполнение не доходит. Гейт, до которого нельзя дойти, не защищает
    // ничего, зато создаёт впечатление защиты.
    if (req.symbolFrom !== undefined) {
      if (instrument !== null && instrument.symbol !== undefined) {
        // САМОЕ ВАЖНОЕ МЕСТО ЭТОЙ ВЕТВИ. Символ, названный рядом с `symbolFrom: 'actor'`, не
        // будет соблюдён — прогон подставит свой. Принять такое требование значило бы вернуть
        // ровно тот дефект, ради устранения которого ветвь и заведена: объявлено, не исполняется,
        // заметить нечем. Поэтому отказ, а не игнорирование.
        issues.push(
          makeIssue(
            'invalid_market_data_requirement',
            'при symbolFrom: \'actor\' символ приносит прогон, поэтому instrument.symbol обязан ' +
              'ОТСУТСТВОВАТЬ: названный здесь символ не был бы соблюдён, и заметить это было бы нечем',
            `${base}/instrument/symbol`,
          ),
        );
      }
    } else if (instrument !== null && instrument.symbol === undefined) {
      // Фиксированная ветвь без символа — не «связанная по умолчанию». Умолчания здесь нет
      // намеренно: оно сделало бы потерю поля неотличимой от осознанного выбора.
      issues.push(
        makeIssue(
          'invalid_market_data_requirement',
          'instrument.symbol обязателен: требование без symbolFrom называет КОНКРЕТНЫЙ инструмент. ' +
            'Если символ должен приносить прогон — объявите symbolFrom: \'actor\' явно',
          `${base}/instrument/symbol`,
        ),
      );
    }
  });
}

/** Пометить любые поля зоны risk/execution на верхнем уровне `obj` как `separation_violation`. */
function scanSeparation(
  obj: Record<string, unknown>,
  basePath: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (SEPARATION_FORBIDDEN_KEYS.has(key)) {
      issues.push(
        makeIssue(
          'separation_violation',
          `поле "${key}" относится к зоне RiskProfile/ExecutionProfile (FR-015)`,
          `${basePath}/${key}`,
        ),
      );
    }
  }
}

/** Проверка sample-решений против ветки decision-union по дискриминатору `kind` + separation-скан. */
function validateSampleDecisions(
  manifest: ModuleManifest,
  sampleDecisions: readonly unknown[],
  registry: SchemaRegistry,
  issues: ValidationIssue[],
): void {
  const isOverlay = manifest.kind === 'overlay';
  const defs = isOverlay ? OVERLAY_DECISION_DEFS : STRATEGY_DECISION_DEFS;
  const schemaId = SCHEMA_IDS[isOverlay ? 'overlay-decision' : 'strategy-decision'];

  sampleDecisions.forEach((dec, i) => {
    const rec = asRecord(dec);
    const basePath = `/sampleDecisions/${i}`;

    // separation: верхний уровень решения + содержимое overlay-`patch` (открытый object).
    if (rec) {
      scanSeparation(rec, basePath, issues);
      if (rec.kind === 'patch') {
        const patch = asRecord(rec.patch);
        if (patch) scanSeparation(patch, `${basePath}/patch`, issues);
      }
    }

    const kind = rec?.kind;
    if (typeof kind !== 'string' || !(kind in defs)) {
      issues.push(
        makeIssue(
          'decision_schema_invalid',
          'неизвестный или отсутствующий kind решения',
          `/sampleDecisions/${i}/kind`,
        ),
      );
      return;
    }
    const errs = registry.validateRef(`${schemaId}#/definitions/${defs[kind]}`, dec);
    for (const e of errs) {
      issues.push(
        makeIssue(
          'decision_schema_invalid',
          e.message ?? 'нарушение схемы решения',
          `/sampleDecisions/${i}${jsonPointerOf(e)}`,
        ),
      );
    }
  });
}

/**
 * 083 E1/S1 — новый surface конверта ограждён объявленной версией контракта.
 *
 * `SUPPORTED_CONTRACT_VERSIONS` — возрастающий список, поэтому «не старше» проверяется позицией в
 * нём, без semver-парсера. Версия вне набора уже отклонена шагом 2 — здесь не дублируем.
 *
 * **ДВА порога, не один** (задача 6, ревью раунда 1, I-1, Important — исправлена регрессия
 * первой версии задачи 6, где явный `lifecycle: 'single_position'` под `017.3` ошибочно требовал
 * `017.4`). `lifecycle === 'event_driven'` (или `onEvent`/`marketData`/`warmup`) — ПЕРЕПИСАННЫЙ
 * задачами 1–5 surface, порог `EVENT_DRIVEN_MIN_CONTRACT_VERSION` (`017.4`). Голое присутствие
 * поля `lifecycle` (ЛЮБОЕ значение, включая `single_position`) — исходный E1-словарь `0.13.0`,
 * которого S1 не касался, порог `LIFECYCLE_FIELD_MIN_CONTRACT_VERSION` (`017.3`, ниже
 * `EVENT_DRIVEN_MIN_CONTRACT_VERSION`). Смешивание этих порогов в одном предикате — ровно тот
 * дефект, который поймало ревью: `single_position`, явно объявленный автором, не использует НИ
 * ОДНОГО бита переписанного surface, и требовать от него `017.4` значило бы наказывать форму,
 * которую S1 не трогал вовсе.
 */
function validateSurfaceContractVersion(
  manifest: ModuleManifest,
  hooks: readonly LifecycleHook[],
  ctx: ContractContext,
  issues: ValidationIssue[],
): void {
  // К-1 (раунд правок 2, Critical, задача 3): `marketData` — ТОЖЕ часть ПЕРЕПИСАННОГО surface
  // актора и обязана ограждаться версией на равных с `lifecycle: 'event_driven'`/`onEvent`; без
  // этого пункта манифест 017.1 с `hooks:['onBarClose']` и блоком `marketData` проходил бы с нулём
  // issues — ровно тот случай, который делает bump версии чисто декларативным (комментарий у
  // `EVENT_DRIVEN_MIN_CONTRACT_VERSION`, event-driven.ts).
  //
  // `warmup` (задача 6, долг задачи 3 — тот же класс дыры, что К-1 закрывала для `marketData`):
  // поле заведено задачей 3 (`ModuleManifest.warmup?: ActorWarmupSource`), но НЕ было включено в
  // этот гейт до задачи 6 — манифест 017.1/017.2 с `warmup` без `lifecycle`/`marketData` проходил
  // бы версионный гейт молча. `warmup` осмыслен ТОЛЬКО для формы `event_driven` (прогрев готовит
  // актора к первому торгующему событию), значит принадлежит тому же surface и тому же гейту.
  //
  // `manifest.lifecycle === 'event_driven'`, НЕ `!== undefined` (I-1): явный `single_position` —
  // дефолтная форма, не тронутая S1, и живёт под НИЖНИМ порогом `declaresLifecycleField` ниже.
  const usesRewrittenActorSurface =
    manifest.lifecycle === 'event_driven' ||
    hooks.includes('onEvent') ||
    manifest.marketData !== undefined ||
    manifest.warmup !== undefined;

  // Голое присутствие поля `lifecycle` — ЛЮБОЕ значение, включая мусорное (схема ловит это
  // отдельно, `schema_invalid`) — уже surface исходного E1-словаря (`017.3`), даже когда значение
  // не `event_driven`.
  const declaresLifecycleField = manifest.lifecycle !== undefined;

  if (!usesRewrittenActorSurface && !declaresLifecycleField) return;

  const declared: unknown = manifest.contractVersion;
  if (typeof declared !== 'string') return;
  const supported = ctx.supportedContractVersions;
  const declaredIdx = supported.indexOf(declared);
  if (declaredIdx < 0) return; // версия вне набора — причина уже выставлена

  // ТРЕТИЙ порог, а не переиспользованный второй. Связанная ветвь привязки (`symbolFrom: 'actor'`)
  // появилась в `017.6`; манифест, объявивший `017.5`, обязан быть отвергнут при попытке ею
  // воспользоваться — иначе бамп версии декларативен. Проверяется ПРИСУТСТВИЕ поля, а не его
  // значение: мусорное значение ловится отдельно (`invalid_market_data_requirement`), и молчать о
  // версии на нём значило бы выдать один отказ вместо двух настоящих.
  const usesBoundSymbolBranch =
    Array.isArray(manifest.marketData) &&
    manifest.marketData.some(
      (req) => (req as { readonly symbolFrom?: unknown }).symbolFrom !== undefined,
    );

  const requiredVersion = usesBoundSymbolBranch
    ? SYMBOL_FROM_MIN_CONTRACT_VERSION
    : usesRewrittenActorSurface
      ? EVENT_DRIVEN_MIN_CONTRACT_VERSION
      : LIFECYCLE_FIELD_MIN_CONTRACT_VERSION;
  const introducedIdx = supported.indexOf(requiredVersion);
  if (introducedIdx >= 0 && declaredIdx >= introducedIdx) return;

  const surfaceLabel = usesBoundSymbolBranch
    ? "связанная привязка требования (symbolFrom: 'actor')"
    : usesRewrittenActorSurface
      ? 'event_driven (lifecycle: event_driven/onEvent/marketData/warmup)'
      : 'lifecycle (конверт манифеста 083 E1)';
  issues.push(
    makeIssue(
      'unsupported_contract_version',
      `surface ${surfaceLabel} требует contractVersion ≥"${requiredVersion}"; манифест объявляет ` +
        `"${declared}"`,
      '/contractVersion',
    ),
  );
}

/**
 * 083 E1 — соответствие набора хуков объявленной ФОРМЕ стратегии (kind:'strategy').
 *
 * Две формы разведены нацело, а не сложены: `single_position` — фазовая модель с хуками
 * `onBarClose`/`onPositionBar`/`onPendingIntentBar`, `event_driven` — актор с единственной точкой
 * входа `onEvent`. Смешанный набор означает, что автор не понял, какую форму пишет, — отклоняем на
 * submit'е, а не в рантайме (083 D5: формы строятся строго рядом, не поверх друг друга).
 */
function validateLifecycleForm(
  lifecycle: StrategyLifecycle,
  hooks: readonly LifecycleHook[],
  issues: ValidationIssue[],
): void {
  if (lifecycle === 'event_driven') {
    if (!hooks.includes('onEvent')) {
      issues.push(
        makeIssue(
          'lifecycle_form_invalid',
          'форма event_driven обязана объявлять единственную точку входа onEvent (083 D1)',
          '/hooks',
        ),
      );
    }
    hooks.forEach((hook, i) => {
      if (!(EVENT_DRIVEN_HOOKS as readonly string[]).includes(hook)) {
        issues.push(
          makeIssue(
            'lifecycle_form_invalid',
            `хук "${hook}" принадлежит фазовой модели single_position и недопустим в форме event_driven`,
            `/hooks/${i}`,
          ),
        );
      }
    });
    return;
  }

  // single_position: минимальный alpha-хук обязателен (FR-004); точка входа актора недопустима.
  if (!hooks.includes('onBarClose')) {
    issues.push(
      makeIssue('schema_invalid', 'strategy-модуль обязан объявлять хук onBarClose (FR-004)', '/hooks'),
    );
  }
  hooks.forEach((hook, i) => {
    if (hook === 'onEvent') {
      issues.push(
        makeIssue(
          'lifecycle_form_invalid',
          'хук onEvent принадлежит форме event_driven и недопустим в single_position',
          `/hooks/${i}`,
        ),
      );
    }
  });
}

/**
 * Провалидировать submit модуля. Чистая функция: `(input + contractContext + registry) → ValidationResult`.
 * Аккумулирует ПОЛНЫЙ набор причин (FR-022); `normalized` прикрепляется только при отсутствии error.
 */
export function validateModule(
  input: ModuleInput,
  ctx: ContractContext,
  registry: SchemaRegistry,
): ValidationResult {
  const { manifest } = input;
  const issues: ValidationIssue[] = [];

  // 1. Базовая schema конверта (тип/обяз. поля/enum/additionalProperties) → schema_invalid.
  for (const e of registry.validateCore('module-manifest', manifest)) {
    issues.push(makeIssue('schema_invalid', e.message ?? 'нарушение схемы манифеста', jsonPointerOf(e)));
  }

  // 2. Версия контракта в поддерживаемом наборе (D12).
  const cv: unknown = manifest.contractVersion;
  if (typeof cv === 'string' && !ctx.supportedContractVersions.includes(cv)) {
    issues.push(
      makeIssue(
        'unsupported_contract_version',
        `contractVersion "${cv}" вне поддерживаемого набора`,
        '/contractVersion',
      ),
    );
  }

  // 3. Submit-инвариант: статус всегда research_only (FR-030).
  if (manifest.status !== undefined && manifest.status !== 'research_only') {
    issues.push(
      makeIssue('schema_invalid', 'submit-статус модуля должен быть research_only (FR-030)', '/status'),
    );
  }

  // 4. Хуки и kind-специфичные правила; для strategy — с учётом объявленной формы (083 E1).
  const hooks = Array.isArray(manifest.hooks) ? manifest.hooks : [];
  const declaredLifecycle: unknown = manifest.lifecycle;
  // Значение вне каталога ловит схема (enum) — форму по нему не проверяем, она бессмысленна.
  const lifecycleKnown =
    declaredLifecycle === undefined ||
    STRATEGY_LIFECYCLES.includes(declaredLifecycle as StrategyLifecycle);
  const lifecycle: StrategyLifecycle = lifecycleKnown
    ? ((declaredLifecycle as StrategyLifecycle | undefined) ?? DEFAULT_STRATEGY_LIFECYCLE)
    : DEFAULT_STRATEGY_LIFECYCLE;

  validateSurfaceContractVersion(manifest, hooks, ctx, issues);

  if (manifest.kind === 'strategy' && lifecycleKnown) {
    validateLifecycleForm(lifecycle, hooks, issues);
  } else if (manifest.kind === 'overlay') {
    // Overlay перехватывает решение фазовой модели; event-driven overlay в v1 не существует (083 §5).
    if (lifecycleKnown && lifecycle !== 'single_position') {
      issues.push(
        makeIssue(
          'lifecycle_form_invalid',
          `overlay не может объявлять форму "${lifecycle}" (перехват определён только для single_position)`,
          '/lifecycle',
        ),
      );
    }
  }

  if (manifest.kind === 'overlay') {
    // Overlay вмешивается в РОВНО ОДНОЙ точке перехвата (FR-002, US2-AC2).
    if (hooks.length > 1) {
      issues.push(
        makeIssue('multi_hook_overlay', 'overlay объявляет более одной точки перехвата (FR-002)', '/hooks'),
      );
    }
    if (!hooks.includes('apply')) {
      issues.push(
        makeIssue('schema_invalid', 'overlay обязан объявлять единственный хук apply (FR-004)', '/hooks'),
      );
    }
    // Целевая стратегия должна быть известна каталогу (FR-002, US2-AC4).
    const tsr: unknown = manifest.targetStrategyRef;
    if (typeof tsr !== 'string' || tsr.length === 0) {
      issues.push(makeIssue('schema_invalid', 'overlay обязан указывать targetStrategyRef', '/targetStrategyRef'));
    } else if (!ctx.knownStrategyRefs.includes(tsr)) {
      issues.push(makeIssue('unknown_strategy_ref', `целевая стратегия "${tsr}" неизвестна`, '/targetStrategyRef'));
    }
    if (typeof manifest.interceptionPoint !== 'string' || manifest.interceptionPoint.length === 0) {
      issues.push(makeIssue('schema_invalid', 'overlay обязан указывать interceptionPoint', '/interceptionPoint'));
    }
    // м-7 (раунд правок 2): marketData принадлежит форме event_driven — overlay перехватывает
    // решение фазовой модели single_position и собственных требований к рыночным данным не имеет.
    // Прецедент отклонения бессмысленных для формы полей — lifecycle_form_invalid (083 E1).
    if (manifest.marketData !== undefined) {
      issues.push(
        makeIssue(
          'lifecycle_form_invalid',
          'overlay не может объявлять marketData — поле принадлежит форме event_driven, overlay перехватывает решение single_position',
          '/marketData',
        ),
      );
    }
  }

  // 5. params против author-supplied paramsSchema (FR-034). Отсутствие paramsSchema ловит шаг 1.
  const paramsSchema: unknown = manifest.paramsSchema;
  if (paramsSchema !== undefined && paramsSchema !== null) {
    const compiled = registry.compileParams(paramsSchema as object);
    if (!compiled.ok) {
      issues.push(
        makeIssue(
          'params_schema_invalid',
          `paramsSchema не является валидной JSON Schema: ${compiled.error}`,
          '/paramsSchema',
        ),
      );
    } else if (manifest.params !== undefined) {
      compiled.validate(manifest.params);
      for (const e of compiled.validate.errors ?? []) {
        issues.push(
          makeIssue('params_schema_invalid', e.message ?? 'нарушение схемы параметров', `/params${jsonPointerOf(e)}`),
        );
      }
    }
  }

  // 5b. Разделение ответственности: params не несут sizing/exposure/exec (FR-015, SC-006).
  const paramsRec = asRecord(manifest.params);
  if (paramsRec) scanSeparation(paramsRec, '/params', issues);

  // 5c. No-lookahead и детерминизм: ОБЪЯВЛЕННАЯ потребность отклоняется до прогона (FR-012/FR-019,
  // data-model §13.4). Структурная гарантия (нет forward-API в контексте) — отдельно, в типах.
  const dataNeeds = asRecord(manifest.dataNeeds);
  if (dataNeeds) {
    for (const need of LOOKAHEAD_NEEDS) {
      if (dataNeeds[need] === true) {
        issues.push(
          makeIssue(
            'lookahead_violation',
            `объявлена потребность в будущих/oracle/post-trade данных: ${need}`,
            `/dataNeeds/${need}`,
          ),
        );
      }
    }
    for (const need of NONDETERMINISM_NEEDS) {
      if (dataNeeds[need] === true) {
        issues.push(
          makeIssue(
            'nondeterminism_violation',
            `объявлена потребность в wall-clock/неуправляемой случайности: ${need}`,
            `/dataNeeds/${need}`,
          ),
        );
      }
    }
    // 023: любой объявленный-`true` ключ вне замкнутого объединения каталогов → unsupported_market_data_kind
    // (fail-closed; зеркало unknown_metric, research R4/R5). openInterest/liquidations входят в каталог →
    // принимаются как легитимные point-in-time потребности. Структурные/lookahead/nondeterminism — свои коды.
    const recognizedNeeds = new Set<string>([
      ...STRUCTURAL_NEEDS,
      ...ctx.supportedMarketDataKinds,
      ...LOOKAHEAD_NEEDS,
      ...NONDETERMINISM_NEEDS,
    ]);
    for (const key of Object.keys(dataNeeds)) {
      if (dataNeeds[key] === true && !recognizedNeeds.has(key)) {
        issues.push(
          makeIssue(
            'unsupported_market_data_kind',
            `объявлена неподдержанная потребность в рыночных данных: ${key}`,
            `/dataNeeds/${key}`,
          ),
        );
      }
    }
  }

  // 5d. Capability-граница: объявленная запрещённая возможность → forbidden_capability
  // (FR-017/018, data-model §13.3). Закрытый набор задаётся contractContext. Разрешён только
  // platformSdk + read-only контекст.
  const capabilities = asRecord(manifest.capabilities);
  if (capabilities) {
    for (const cap of ctx.forbiddenCapabilities) {
      if (capabilities[cap] === true) {
        issues.push(
          makeIssue('forbidden_capability', `объявлена запрещённая возможность: ${cap}`, `/capabilities/${cap}`),
        );
      }
    }
  }

  // 6. Author-supplied sample-решения против decision-схемы (017 не исполняет тело модуля).
  if (Array.isArray(input.sampleDecisions)) {
    validateSampleDecisions(manifest, input.sampleDecisions, registry, issues);
  }

  // 7. marketData (083 S1 задача 3): обязательность для event_driven + семантика scope/
  // revisionPolicy/funding-form, которую схема не выражает (см. validateMarketDataRequirements).
  const marketDataRaw: unknown = manifest.marketData;
  const hasMarketData = Array.isArray(marketDataRaw) && marketDataRaw.length > 0;
  if (manifest.kind === 'strategy' && lifecycleKnown && lifecycle === 'event_driven' && !hasMarketData) {
    issues.push(
      makeIssue(
        'missing_market_data_requirement',
        'форма event_driven обязана объявлять хотя бы одно требование marketData',
        '/marketData',
      ),
    );
  }
  validateMarketDataRequirements(marketDataRaw, issues);

  const hasError = issues.some((i) => i.severity === 'error');
  return assemble(issues, hasError ? undefined : normalizeManifest(manifest));
}
