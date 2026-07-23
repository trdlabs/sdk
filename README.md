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

The **canonical** — and only — public distribution channel is the npm registry:

```bash
npm install @trdlabs/sdk
```

`npm pack` / `npm run sdk:verify` are **verification only**: they exist so the
package contents can be checked before publication. The generated `.tgz` is
never a consumer delivery channel.

## Releasing

npm is canonical. A release is an `npm publish`, not a GitHub artifact.

- Publish via the **SDK Release** workflow
  (`.github/workflows/sdk-release.yml`, `workflow_dispatch`), which runs
  `npm ci → npm test → npm run build → npm run sdk:pack → npm run sdk:verify`
  and then `npm publish --access public --provenance`. It fails closed if the
  version already exists on npm or if `package.json` version ≠ the input.
- The npm registry is immutable per version — a mistake requires a new patch
  version, never a republish.
- The GitHub tag / release the workflow creates afterwards is a **secondary
  release note only**: it attaches no tarball and is not a delivery channel.
- Consumers always install from npm (`npm install @trdlabs/sdk`), never from a
  GitHub release archive.

## Versioning

Current: **0.13.0**. See [CHANGELOG.md](CHANGELOG.md) for release history.

SDK package versions follow semver. Contract compatibility is surfaced through
the exported version constants for each contract area.

### Pre-1.0: a minor bump may be source-breaking

While the package is on `0.x`, **a minor bump may carry a breaking contract or
type change** — semver reserves no compatibility guarantee below 1.0.0, and the
contract surface here is still moving (the 017 execution-semantics split is
mid-flight, with a dual-read window open). Every such change is called out
under `### Changed` in the changelog with a migration note; the project does not
silently break consumers, it just does not spend a major on it yet.

What protects you in practice: npm's caret pins the *minor* for `0.x`, so
`^0.13.0` resolves to `>=0.13.0 <0.14.0`. A consumer never floats onto a
breaking minor — the bump is always a deliberate edit on the consumer side.
Pinning exactly (as `mock-platform` does) is stronger still.

`1.0.0` is reserved for the point where the contract surface stops moving; from
then on breaking changes take a major, per the standard rule in
[AGENTS.md](AGENTS.md).

## License

Apache-2.0.
