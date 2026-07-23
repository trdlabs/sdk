// Ф1 `shared-execution-engine` — контракт `RealityModel`: замкнутые каталоги слотов и dual-read.
//
// Конформанс-гейт (test/conformance-validation.mjs) проверяет только «принято / отклонено».
// Здесь фиксируются КОДЫ причин (какой слот кому принадлежит) и поведение `resolveRealityModel`,
// потому что именно от них зависит миграция потребителей во время окна.
// Run: npx tsx --test test/reality-model.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FILL_MODEL_KINDS,
  REALITY_MODEL_KIND_CATALOG,
  REALITY_MODEL_SLOTS,
  resolveRealityModel,
  type ExecutionProfile,
  type RealityModel,
} from '../src/research-contract/index.js';
import { validate } from '../src/validation/index.js';
import { platformContractContext } from '../src/research-contract/catalogs.js';

const CTX = platformContractContext();

const MODEL: RealityModel = {
  id: 'default_reality',
  version: '1.0.0',
  fillModel: { kind: 'next_bar_open' },
  feeModel: { kind: 'fixed_bps', bps: 10 },
  slippageModel: { kind: 'fixed_bps', bps: 5 },
};

const codesOf = (model: unknown): readonly string[] =>
  validate({ inputKind: 'reality_model', realityModel: model as RealityModel }, CTX).issues.map(
    (i) => i.code,
  );

test('каталог слотов покрывает ровно объявленные слоты RealityModel', () => {
  assert.deepEqual(Object.keys(REALITY_MODEL_KIND_CATALOG).sort(), [...REALITY_MODEL_SLOTS].sort());
  for (const slot of REALITY_MODEL_SLOTS) {
    assert.ok(REALITY_MODEL_KIND_CATALOG[slot].length > 0, `каталог ${slot} не должен быть пуст`);
  }
});

test('полная модель среды принимается и нормализуется в каноническом порядке слотов', () => {
  const res = validate(
    {
      inputKind: 'reality_model',
      realityModel: {
        ...MODEL,
        fundingModel: { kind: 'per_minute_prorate', intervalHours: 8 },
        latency: { kind: 'zero' },
        partialFill: { kind: 'none' },
      },
    },
    CTX,
  );
  assert.equal(res.status, 'accepted');
  const normalized = res.normalized as { slots: Record<string, unknown> };
  assert.deepEqual(Object.keys(normalized.slots), [...REALITY_MODEL_SLOTS]);
});

test('неизвестный fillModel.kind → unsupported_fill_model_kind (код 024), без schema-шума', () => {
  const codes = codesOf({ ...MODEL, fillModel: { kind: 'twap' } });
  assert.deepEqual(codes, ['unsupported_fill_model_kind']);
});

test('неизвестный kind остальных слотов → unsupported_reality_model_kind', () => {
  for (const [slot, offCatalog] of [
    ['feeModel', { kind: 'maker_taker', makerBps: 1, takerBps: 5 }],
    ['slippageModel', { kind: 'book_depth', levels: 5 }],
    ['fundingModel', { kind: 'per_bar', rate: 0.1 }],
    ['latency', { kind: 'sampled', p50Ms: 20 }],
    ['partialFill', { kind: 'proportional' }],
  ] as const) {
    const codes = codesOf({ ...MODEL, [slot]: offCatalog });
    assert.deepEqual(codes, ['unsupported_reality_model_kind'], `слот ${slot}`);
  }
});

test('известный kind с нарушенной нагрузкой ветки остаётся schema_invalid', () => {
  const codes = codesOf({ ...MODEL, feeModel: { kind: 'fixed_bps' } });
  assert.ok(codes.includes('schema_invalid'));
  assert.ok(!codes.includes('unsupported_reality_model_kind'));
});

test('модель без обязательных слотов отклоняется', () => {
  const res = validate(
    { inputKind: 'reality_model', realityModel: { id: 'x', version: '1' } as RealityModel },
    CTX,
  );
  assert.equal(res.status, 'rejected');
  assert.equal(res.normalized, undefined);
});

test('нераспознанное поле конверта отклоняется (additionalProperties:false)', () => {
  const codes = codesOf({ ...MODEL, bracketPolicy: {} });
  assert.deepEqual(codes, ['schema_invalid']);
});

// --- dual-read ---

const EMBEDDED: ExecutionProfile = {
  id: 'default_exec',
  version: '1.0.0',
  fillModel: MODEL.fillModel,
  feeModel: MODEL.feeModel,
  slippageModel: MODEL.slippageModel,
};

const SPLIT: ExecutionProfile = {
  id: 'default_exec',
  version: '2.0.0',
  realityModelRef: { id: MODEL.id, version: MODEL.version },
};

test('dual-read: только встроенная форма читается без идентичности модели среды', () => {
  const res = resolveRealityModel(EMBEDDED);
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.source, 'execution_profile_embedded');
  assert.equal(res.ok && res.ref, undefined);
  assert.deepEqual(res.ok && res.slots.fillModel, { kind: 'next_bar_open' });
});

test('dual-read: только разделённая форма несёт ref модели среды', () => {
  const res = resolveRealityModel(SPLIT, MODEL);
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.source, 'reality_model');
  assert.deepEqual(res.ok && res.ref, { id: 'default_reality', version: '1.0.0' });
});

test('dual-read: совпадающие формы принимаются как разделённая (миграция консистентна)', () => {
  const res = resolveRealityModel(EMBEDDED, MODEL);
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.source, 'reality_model');
});

test('dual-read: расходящиеся формы — отказ, а не молчаливый выбор одной из них', () => {
  const res = resolveRealityModel(
    { ...EMBEDDED, feeModel: { kind: 'fixed_bps', bps: 0 } },
    MODEL,
  );
  assert.deepEqual(res, { ok: false, reason: 'conflicting_reality_model' });
});

test('dual-read: отсутствие обеих форм — отказ, а не пустая модель среды', () => {
  const res = resolveRealityModel({ id: 'intent_only', version: '1.0.0' });
  assert.deepEqual(res, { ok: false, reason: 'missing_reality_model' });
});

test('dual-read: неполная встроенная форма не выдаётся за полную', () => {
  const res = resolveRealityModel({ ...EMBEDDED, slippageModel: undefined });
  assert.deepEqual(res, { ok: false, reason: 'missing_reality_model' });
});

test('dual-read: опциональные слоты не влияют на сравнение, если совпадают', () => {
  const withOptional = { ...MODEL, latency: { kind: 'zero' } } as const satisfies RealityModel;
  const res = resolveRealityModel({ ...EMBEDDED, latency: { kind: 'zero' } }, withOptional);
  assert.equal(res.ok, true);
});

test('dual-read: расхождение по опциональному слоту тоже конфликт', () => {
  const res = resolveRealityModel({ ...EMBEDDED, latency: { kind: 'zero' } }, MODEL);
  assert.deepEqual(res, { ok: false, reason: 'conflicting_reality_model' });
});

test('run-request принимает realityModelRef и echo-ит его в normalized', () => {
  const res = validate(
    {
      inputKind: 'run_request',
      request: {
        runId: 'r1',
        mode: 'research',
        moduleRef: { id: 'm', version: '1' },
        overlayRefs: [{ id: 'o', version: '1' }],
        datasetRef: 'ds',
        symbols: ['BTCUSDT'],
        timeframe: '1m',
        period: { from: '2025-01-01', to: '2025-02-01' },
        seed: 1,
        riskProfileRef: { id: 'risk', version: '1' },
        realityModelRef: { id: 'default_reality', version: '1.0.0' },
        metrics: ['pnl'],
      },
    },
    CTX,
  );
  assert.equal(res.status, 'accepted');
  const normalized = res.normalized as { realityModelRef?: { id: string } };
  assert.deepEqual(normalized.realityModelRef, { id: 'default_reality', version: '1.0.0' });
});

test('каталог fill-моделей — тот же литерал, что и в схеме контракта', () => {
  assert.deepEqual([...FILL_MODEL_KINDS], ['next_bar_open', 'same_bar_close']);
});
