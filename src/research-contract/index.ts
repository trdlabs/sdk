// 017 — barrel research-поверхности контракта (типы стратегий/гипотез как кодовых модулей).

// 083 S1 задача 3 (раунд правок 2, С-3/К-2): каталог MarketDataRequirement живёт в
// contract/constants.ts (единственный источник истины, требование 1) — реэкспортирован явно,
// чтобы быть достижимым из опубликованного подпути `@trdlabs/sdk/research-contract`.
// 083 S1 задача 6: `MARKET_KIND_RANK` — та же дисциплина (§3.8.2, единственный источник порядка
// для engine/backtester), реэкспортирован рядом со своим каталогом.
export { MARKET_DATA_KINDS, MARKET_KIND_RANK, type MarketDataKind } from '../contract/constants.js';

export * from './catalogs.js';
export * from './validation.js';
export * from './brief.js';
export * from './decision.js';
export * from './context.js';
export * from './indicators.js';
export * from './event-driven.js';
export * from './observation-status.js';
export * from './actor-state.js';
export * from './reality-model.js';
export * from './risk-execution.js';
export * from './run.js';
export * from './module.js';
export * from './market-tape.js';
export * from './time-us.js';
