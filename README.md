# @trdlabs/sdk

Contract-first, standalone SDK facade over the `trdlabs` trading platform
consumer surface. The package is self-contained and has no platform runtime or
build coupling.

## Install

```bash
npm install @trdlabs/sdk
```

## Surface

| Subpath | Contents |
| --- | --- |
| `.` | Capabilities, versioning constants, and historical DTO re-export. |
| `./ops-read` | Ops-read DTOs and `OPS_READ_CONTRACT_VERSION`. |
| `./intake` | Paper-candidate intake client, DTOs, and errors. |
| `./intake/http-transport` | HTTP transport for the intake client. |
| `./historical` | `CanonicalRowV2` historical DTO and field/version constants. |
| `./conformance` | `runHistoricalConformance` for the `historical.2` contract. |
| `./research-contract` | Research contract types and helpers. |
| `./validation` | Strategy/module validation helpers and schema assets. |

Excluded by design: platform runtime, live execution authority, exchange
credentials, agent/MCP orchestration, and raw platform storage access.

## Usage

```ts
import { SDK_VERSION, SDK_CAPABILITIES } from '@trdlabs/sdk';
import type { CanonicalRowV2 } from '@trdlabs/sdk/historical';

console.log(SDK_VERSION);
console.log(SDK_CAPABILITIES.execution); // false
```

## Distribution

The primary public distribution channel is npm:

```bash
npm install @trdlabs/sdk
```

Release validation still uses `npm pack` internally so the published package can
be checked before publication.

## Versioning

Current: **0.10.0**. See [CHANGELOG.md](CHANGELOG.md) for release history.

SDK package versions follow semver. Contract compatibility is surfaced through
the exported version constants for each contract area.

## License

Apache-2.0.
