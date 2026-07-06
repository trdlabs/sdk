# AGENTS.md — trading-platform-sdk

This repository is part of the `trdlabs` trading ecosystem.

**Before planning or coding, read `../control-center/` when the task involves:**
- other repositories, system architecture, or integration boundaries
- API, MCP, SDK, or contract changes
- rollout, migration, or cross-repo validation
- local development, Docker, running the full ecosystem stack, or mock-platform data intervals
- fetching a new VPS snapshot and making it the ecosystem default fixture

**Read order when triggered:**
1. `../control-center/repos.yaml`
2. `../control-center/AGENTS.md`
3. `../control-center/repos/trading-platform-sdk.md`
4. `../control-center/docs/operations/local-development.md` when starting or debugging the local stack
5. `../control-center/docs/operations/mock-platform-data.md` when historical intervals (1m/1h/1d) or mock fixtures matter
6. `../control-center/docs/operations/mock-platform-snapshot-rollout.md` when ingesting a VPS slice or changing the default fixture across repos
7. `../control-center/ecosystem-defaults.yaml` and skill `mock-snapshot-default-rollout` when making a VPS slice the ecosystem default

If `../control-center` is absent (standalone clone), use local repo docs only.

> Гид для AI-агентов (Codex, Claude Code и др.). Поведенческие правила см. в `CLAUDE.md`.
> Здесь — быстрый контекст и команды, чтобы агент не тратил токены на разбор репо.

## Что это
**Публичный contract-first SDK** (`@trdlabs/sdk`) — каноническая typed-обёртка
над consumer surface платформы. Отдельный репозиторий без runtime/build coupling
с приватной `trading-platform`.

⚠️ **Любое изменение здесь — изменение контракта.** Затрагивает `trading-lab`,
`trading-office`, `trading-backtester`, `trading-mock-platform` и внешних npm-потребителей.

## Стек
- **TypeScript** (ESM), сборка `tsc` → `dist/`
- **ajv** — JSON Schema validation
- **decimal.js** — денежные типы (не float)
- Публикация: npm `@trdlabs/sdk` (Apache-2.0)

## Surface (subpath exports)
| Subpath | Назначение |
| --- | --- |
| `.` | Capabilities, versioning, re-export historical DTO |
| `./ops-read` | Ops-read DTO и `OPS_READ_CONTRACT_VERSION` |
| `./intake` | Paper-candidate intake client, DTO, errors |
| `./intake/http-transport` | HTTP transport для intake |
| `./historical` | `CanonicalRowV2`, field/version constants |
| `./conformance` | `runHistoricalConformance` для `historical.2` |
| `./research-contract` | Research contract types и helpers |
| `./validation` | Strategy/module validation, schema assets |

**Не входит:** platform runtime, live execution, exchange credentials, agent/MCP
orchestration, raw platform storage.

## Команды
```bash
npm install
npm run build                    # gen schemas + tsc + copy schema assets
npm run gen:schemas              # regenerate research JSON schemas
npm run conformance:validation   # conformance test suite
npm run sdk:pack                 # npm pack → .artifacts/sdk/
npm run sdk:verify               # verify packed tarball (run after sdk:pack)
```

## Правила для агента
- **SDK changes = contract changes.** Обновляй examples, version metadata, changelog
  до того, как downstream repos считают capability стабильной.
- Сначала меняй source-of-truth (`trading-platform`), потом SDK, потом consumers —
  см. `../control-center/docs/delivery/cross-repo-change-playbook.md`.
- Не тянуть platform internals; SDK остаётся standalone facade.
- Деньги — только `decimal.js`.
- Перед релизом: `build`, `conformance:validation`, `sdk:pack`, `sdk:verify`.
- Breaking changes — major semver + migration notes + consumer PRs.

## Downstream consumers
- `trading-lab` — agent workflows через MCP + SDK types
- `trading-office` — operator UI через SDK/API
- `trading-backtester` — bundle types, validation helpers
- `trading-mock-platform` — contract fixtures и conformance

## Навигация
Gortex prefix: `trading-platform-sdk`. Для cross-repo impact см. `../control-center/repos.yaml`
(`consumers` / `depends_on`).
