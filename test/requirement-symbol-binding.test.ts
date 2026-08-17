// 083 S3 СТУПЕНЬ 1 — ПРИВЯЗКА ТРЕБОВАНИЯ К ИНСТРУМЕНТУ: две ветви одного объединения.
//
// ═══ ЧТО ЗА ФОРМА И ЗАЧЕМ ═══
//
// До неё `instrument` нёс два смысла сразу: идентичность рынка и привязку требования к прогону.
// При одном акторе они совпадают и потому неразличимы; при N расходятся, и любое одно чтение
// меняет смысл публичного поля. Форма разводит смыслы по ветвям:
//
//   фиксированная: { instrument: { venue, symbol } }                  — «этот и только этот»
//   связанная:     { instrument: { venue }, symbolFrom: 'actor' }      — символ приносит прогон
//
// ═══ ПОЧЕМУ РАЗЛИЧИТЕЛЬ — ПОЛЕ, А НЕ ОТСУТСТВИЕ СИМВОЛА ═══
//
// Форма «symbol необязателен, отсутствие означает символ актора» отвергнута до реализации:
// отсутствие ключа как разрешающее значение неотличимо от ПОТЕРИ поля. Явный `symbolFrom`
// потеряться незаметно не может — его пропажа переводит требование в фиксированную ветвь, где
// символ обязателен, и отказ наступает сразу. Это пиннится ниже отдельной пробой.
//
// Run: npx tsx --test test/requirement-symbol-binding.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  durationUs,
  platformContractContext,
  type MarketDataRequirement,
  type ModuleManifest,
} from '../src/research-contract/index.js';
import { SYMBOL_FROM_MIN_CONTRACT_VERSION } from '../src/research-contract/event-driven.js';
import { validate } from '../src/validation/index.js';

const CTX = platformContractContext();
const MINUTE_US = durationUs(60_000_000);

/** Фиксированная ветвь — сегодняшняя форма, не изменившаяся ни на бит. */
const FIXED: MarketDataRequirement = {
  kind: 'candles',
  id: 'req-fixed',
  instrument: { venue: 'binance', symbol: 'BTCUSDT' },
  interval: MINUTE_US,
  lookback: 0,
  priceType: 'trade',
};

/** Связанная ветвь: венью названо, символа НЕТ ВОВСЕ. */
const BOUND: MarketDataRequirement = {
  kind: 'candles',
  id: 'req-bound',
  instrument: { venue: 'binance' },
  symbolFrom: 'actor',
  interval: MINUTE_US,
  lookback: 0,
  priceType: 'trade',
};

const manifestOf = (
  marketData: readonly unknown[],
  contractVersion: string = SYMBOL_FROM_MIN_CONTRACT_VERSION,
): ModuleManifest =>
  ({
    id: 'm',
    version: '0.1.0',
    kind: 'strategy',
    name: 'M',
    summary: 's',
    rationale: 'r',
    author: 'agent',
    contractVersion,
    status: 'research_only',
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    capabilities: { platformSdk: true },
    dataNeeds: {},
    lifecycle: 'event_driven',
    hooks: ['init', 'onEvent', 'dispose'],
    marketData,
  }) as unknown as ModuleManifest;

const codesOf = (marketData: readonly unknown[], contractVersion?: string): string[] =>
  validate({ inputKind: 'module', manifest: manifestOf(marketData, contractVersion) }, CTX).issues.map(
    (i) => i.code,
  );

const messagesOf = (marketData: readonly unknown[], contractVersion?: string): string[] =>
  validate({ inputKind: 'module', manifest: manifestOf(marketData, contractVersion) }, CTX).issues.map(
    (i) => i.message,
  );

// ─────────────────────────────────────────────────────────────────────────────
// Обе ветви законны, и смешение тоже
// ─────────────────────────────────────────────────────────────────────────────

test('фиксированная ветвь под ПРЕЖНЕЙ версией остаётся валидной — форма не сломала совместимость', () => {
  // Самая важная проба обратной совместимости: манифест, написанный до этой формы и объявляющий
  // 017.5, обязан проходить в точности как раньше. Порог новой ветви не смеет распространяться на
  // тех, кто ею не пользуется.
  assert.deepEqual(codesOf([FIXED], '017.5'), []);
});

test('связанная ветвь валидна под своей версией', () => {
  assert.deepEqual(codesOf([BOUND]), []);
});

test('СМЕШЕНИЕ ветвей в одном манифесте допускается', () => {
  // Запрет здесь был бы правилом без причины: часть рядов законно общая (индекс), часть — своя.
  assert.deepEqual(codesOf([FIXED, BOUND]), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Порог версии — ТРЕТИЙ, а не переиспользованный
// ─────────────────────────────────────────────────────────────────────────────

test('связанная ветвь под 017.5 отвергается: формы, которой в этой версии не было', () => {
  // Принадлежность набору поддерживаемых версий НЕ заменяет порога формы. Без этой проверки бамп
  // версии был бы декларативным: манифест объявляет старый контракт и пользуется новым surface.
  assert.deepEqual(codesOf([BOUND], '017.5'), ['unsupported_contract_version']);
  assert.match(messagesOf([BOUND], '017.5')[0]!, /связанная привязка/);
});

test('ПРОВЕРКА ПРОВЕРКИ: та же версия 017.5 с фиксированной ветвью проходит', () => {
  // Иначе проба выше зеленела бы и у реализации, отвергающей 017.5 целиком, — и «порог формы»
  // оказался бы порогом манифеста.
  assert.deepEqual(codesOf([FIXED], '017.5'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Отказы: ни одно поле не игнорируется
// ─────────────────────────────────────────────────────────────────────────────

test('символ, названный рядом с symbolFrom, ОТВЕРГАЕТСЯ, а не игнорируется', () => {
  // Игнорировать значило бы вернуть тот самый дефект, ради устранения которого ветвь заведена:
  // автор объявил символ, хост его не соблюдает, заметить нечем.
  const codes = codesOf([{ ...BOUND, instrument: { venue: 'binance', symbol: 'BTCUSDT' } }]);
  assert.ok(codes.includes('invalid_market_data_requirement'), `получено: ${codes.join(', ')}`);
  assert.match(messagesOf([{ ...BOUND, instrument: { venue: 'binance', symbol: 'BTCUSDT' } }]).join('\n'), /не был бы соблюдён/);
});

test('ПОТЕРЯ symbolFrom не проходит молча — она переводит требование в фиксированную ветвь', () => {
  // ЭТО И ЕСТЬ ДОВОД В ПОЛЬЗУ ЯВНОГО РАЗЛИЧИТЕЛЯ. Будь различителем отсутствие символа, потерянное
  // при сериализации поле дало бы ЗАКОННОЕ требование с другим смыслом. Здесь потеря даёт отказ.
  const { symbolFrom: _dropped, ...lostDiscriminator } = BOUND as MarketDataRequirement & {
    symbolFrom?: 'actor';
  };
  const codes = codesOf([lostDiscriminator]);
  assert.ok(codes.includes('invalid_market_data_requirement'), `получено: ${codes.join(', ')}`);
  assert.match(messagesOf([lostDiscriminator]).join('\n'), /symbolFrom.*'actor'.*явно|объявите symbolFrom/);
});

test('symbolFrom с чужим значением отвергается — белый список, а не «что-то похожее»', () => {
  const codes = codesOf([{ ...BOUND, symbolFrom: 'run' }]);
  assert.ok(
    codes.includes('invalid_market_data_requirement') || codes.includes('schema_invalid'),
    `получено: ${codes.join(', ')}`,
  );
});

test('фиксированная ветвь с ПУСТЫМ символом по-прежнему отвергается', () => {
  // Прежняя проверка не должна была ослабнуть: пустая строка — не «символа нет».
  const codes = codesOf([{ ...FIXED, instrument: { venue: 'binance', symbol: '' } }]);
  assert.ok(codes.includes('invalid_market_data_requirement'), `получено: ${codes.join(', ')}`);
});
