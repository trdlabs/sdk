// @trdlabs/sdk/historical — materialized historical contract DTO surface.
//
// Standalone copy of the platform CanonicalRow v1/v2 on-disk shape. The SDK owns this
// DTO outright; it does NOT import platform internals. The conformance harness consumes
// CanonicalRowV2 from here.

export {
  SCHEMA_VERSION,
  CANONICAL_ROW_FIELDS,
  SCHEMA_VERSION_V2,
  CANONICAL_ROW_V2_FIELDS,
} from './canonical-row.js';

export type {
  CanonicalRow,
  CanonicalRowField,
  CanonicalRowV2,
  CanonicalRowV2Field,
} from './canonical-row.js';

// Generic historical.2 HTTP client (discover/coverage/preflight/queryRows).
export * from './client.js';

// Д3 (3.3б) — доступный интервал бэктеста и допуск окна: четыре состояния
// индекса и пять различимых кодов отказа.
export {
  AVAILABILITY_STATES,
  PREFLIGHT_REJECT_CODES,
  PREFLIGHT_STATUS_BY_CODE,
  classifyPreflightResponse,
  isPreflightRejectCode,
  parseAvailabilityDescriptor,
} from './availability.js';

export type {
  HistoricalAvailability,
  PreflightRejectCode,
  PreflightResult,
  PreflightSuccess,
  PreflightReject,
} from './availability.js';

// Д3 — целостность ключа дня: типизированный отказ вместо голого `HTTP 409`.
// Под 409 у `/historical/rows` живут два разных факта, и действия по ним
// противоположны — перечитать с начала против «перечитывать бессмысленно».
export {
  DAY_INTEGRITY_CODE,
  DAY_INTEGRITY_STATUS,
  HistoricalDayIntegrityError,
  classifyDayIntegrityResponse,
} from './day-integrity.js';

export type { DayIntegrityViolation } from './day-integrity.js';

// Д5 — общий оракул паритета транспортов. Живёт здесь, а не в platform, потому что стороны
// замера лежат в разных репозиториях: platform отдаёт данные, бэктестер при форме
// «файлы + Range» декодирует parquet сам. Оракул, оставленный в непубликуемом пакете,
// породил бы вторую копию, а две копии канонизатора расходятся на первом краевом случае —
// и расхождение выглядело бы как дефект транспорта, то есть как то, что замер ищет.
export {
  ResultDigestError,
  computeResultDigest,
  canonicalRowLine,
  digestsAgree,
  checkAgainstExpectation,
  checkParity,
} from './result-digest.js';

export type {
  DigestRow,
  ResultDigest,
  ResultDigestFailure,
  ResultExpectation,
} from './result-digest.js';

// cc#365 — происхождение свечей покрытия. Сумма-тип, а не пара полей: имя венью выразимо только
// внутри однородного случая, поэтому «имя есть, про однородность неизвестно» непредставимо, а не
// запрещено проверкой. `mixed` не сворачивается в `unknown` — перечень венью это знание.
export {
  PRICE_SOURCE_VENUES,
  CANDLE_ORIGIN_ARCHIVE_REASONS,
  CANDLE_ORIGIN_CHANNEL_REASONS,
  isPriceSourceVenue,
  parseCandleOrigin,
  coverageEntryCandleOrigin,
} from './candle-origin.js';

export type {
  PriceSourceVenue,
  CandleOrigin,
  CandleOriginUnknownReason,
} from './candle-origin.js';
