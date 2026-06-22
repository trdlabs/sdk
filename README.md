# @trading-platform/sdk

Contract-first, standalone SDK facade over the **trading-platform** consumer surface.
Public, self-contained package — no platform runtime/build coupling.

## Surface (exports)

| Subpath | Contents |
|---------|----------|
| `.` | Capabilities + versioning (`SDK_VERSION`, `SDK_CAPABILITIES`, `CONTRACT_VERSION`, `SUPPORTED_CONTRACT_VERSIONS`, `SUPPORTED_MARKET_DATA_KINDS`), historical DTO re-export |
| `./ops-read` | Ops-read DTOs + `OPS_READ_CONTRACT_VERSION` (bot runs, trades, summaries, operational events, decision log) |
| `./intake` | Paper-candidate intake client + DTOs + errors |
| `./intake/http-transport` | HTTP transport for the intake client |
| `./historical` | `CanonicalRowV2` historical DTO (OHLCV + turnover, OI, funding, liquidations, taker) + field/version constants |
| `./conformance` | `runHistoricalConformance` — executable conformance harness for the `historical.2` contract (`/historical/rows` byte-identity) |

Excluded by design: legacy builder, agent/MCP, and research surfaces (these stay in the platform).

## Distribution

Released as a **GitHub Release tarball** (not npmjs). Consumers vendor the tarball or install
from the release URL. Releases are immutable (the release workflow refuses to overwrite an
existing tag/release).

## Versioning

Current: **0.4.0** (sheds legacy builder/agent/research; adds materialized historical DTO +
self-contained historical conformance). Contract version surfaced via `CONTRACT_VERSION`.

## License

Apache-2.0.
