// @trdlabs/sdk/intake — intake facade surface (feature 036, Phase 9 / T055).
//
// Transport-agnostic core: own-declared intake DTOs + a pluggable IntakeTransport + the submit helper +
// the 5-category error model. Zero platform runtime imports; opens no network, owns no credentials, holds
// no execution/deployment authority. The optional reference adapter
// (`@trdlabs/sdk/intake/http-transport`) is a SEPARATE subpath and is intentionally NOT
// re-exported here (FR-035; verify_034_forbidden_scan).

// own-declared intake DTOs (types only)
export type * from './dto.js';

// transport-agnostic submit helper + transport interface
export { submitPaperCandidate } from './client.js';
export type { IntakeTransport } from './client.js';

// error model
export { INTAKE_ERROR_CATEGORIES, classifyIntakeError } from './errors.js';
