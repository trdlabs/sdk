# AGENTS.md — trading-platform-sdk

Репозиторий входит в экосистему `trdlabs`. Кросс-репозиторные вопросы — архитектура и границы,
контракты API / MCP / SDK, раскатка и миграции, локальный стек, фикстуры mock-платформы — ведутся
из `../control-center`: начинать с [`../control-center/AGENTS.md`](../control-center/AGENTS.md).
Он несёт канонический порядок чтения и указывает на `repos.yaml` и на инвентарь этого
репозитория под `repos/`.

<!-- До 2026-08-21 здесь лежала своя копия этого порядка из семи пунктов — в шести
     репозиториях сразу. Копия разошлась бы с оригиналом при первой же правке; указателя
     достаточно. -->

Если `../control-center` рядом нет (отдельный клон) — пользоваться локальными документами.

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
npm run check                    # ЕДИНЫЙ гейт: test → build → conformance:validation
npm run build                    # gen schemas + tsc + copy schema assets
npm run gen:schemas              # regenerate research JSON schemas
npm run conformance:validation   # conformance test suite
npm run sdk:pack                 # npm pack → .artifacts/sdk/
npm run sdk:verify               # verify packed tarball (run after sdk:pack)
```

`check` — то же самое и в том же порядке, что гоняет CI: и PR-гейт
(`.github/workflows/pr-check.yml`, на каждый `pull_request` и push в main), и
релизный workflow. Состав живёт только в `package.json`, чтобы «зелёный локально»,
«зелёный на PR» и «зелёный на релизе» не разошлись в смысле; форма обоих workflow
зафиксирована тестами `test/pr-check-workflow-guard.test.ts` и
`test/release-workflow-guard.test.ts`.

## Правила для агента
- **SDK changes = contract changes.** Обновляй examples, version metadata, changelog
  до того, как downstream repos считают capability стабильной.
- Сначала меняй source-of-truth (`trading-platform`), потом SDK, потом consumers —
  см. `../control-center/docs/delivery/cross-repo-change-playbook.md`.
- Не тянуть platform internals; SDK остаётся standalone facade.
- Деньги — только `decimal.js`.
- Перед релизом: `check` (в нём `test` → `build` → `conformance:validation`),
  затем `sdk:pack`, `sdk:verify`.
- **Канонический канал доставки — npm (`@trdlabs/sdk`), и только он.** Релиз =
  `npm publish`, а не GitHub-артефакт. Публикация — через workflow **SDK Release**
  (`.github/workflows/sdk-release.yml`, `workflow_dispatch`), который сам гоняет
  `npm ci → check → sdk:pack → sdk:verify → npm publish --access public --provenance`
  и fail-closed, если версия уже есть в npm или `package.json` version ≠ input.
  Публиковать умеет **только** он: у `pr-check` нет ни `id-token`, ни secrets, ни
  registry-url — PR-гейт физически не является каналом публикации.
- `npm pack` / `sdk:verify` — **только verification** упаковки перед публикацией,
  не канал доставки. GitHub tag/release — вторичная release-note без tarball.
- Реестр npm иммутабелен: ошибка правится новым patch-релизом, не переизданием.
- Breaking changes — major semver + migration notes + consumer PRs.
  **Исключение на время `0.x`** (записано явно, а не подразумевается): semver не даёт
  гарантий совместимости ниже 1.0.0, а поверхность контракта ещё движется (017-разделение
  execution-семантики с открытым dual-read-окном). Поэтому до `1.0.0` breaking-изменение
  контракта/типов может выйти **minor**-бампом — обязательно с записью в `### Changed`
  CHANGELOG и migration note. Потребителей это не всплывает автоматически: caret npm пинит
  minor для `0.x` (`^0.13.0` → `>=0.13.0 <0.14.0`), так что переход всегда — осознанная правка
  на стороне потребителя. `1.0.0` резервируется под момент, когда поверхность стабилизируется;
  после него правило «breaking → major» действует без исключений. См. README §Versioning.

### Публичная поверхность

`api-surface.txt` — снимок публичной поверхности (входы из `exports` опубликованного
тарбола). Меняешь поверхность — пересобери снимок (`npm run api:surface`) и закоммить его в
том же PR: `npm run check` красный, если коммиченный снимок не равен регенерации.

Удаление или изменение строки снимка требует minor-бампа относительно опубликованного в npm
`latest` и секции этой версии в `CHANGELOG.md`; санкционированное исключение — строка в
`api-breaking-allowlist.json` с причиной, ISO-датой и PR. Добавления не требуют ничего.
Полное правило: control-center `docs/delivery/versioning-policy.md`, решение — ADR-0029.

## Downstream consumers
- `trading-lab` — agent workflows через MCP + SDK types
- `trading-office` — operator UI через SDK/API
- `trading-backtester` — bundle types, validation helpers
- `trading-mock-platform` — contract fixtures и conformance

## Навигация
Gortex prefix: `trading-platform-sdk`. Для cross-repo impact см. `../control-center/repos.yaml`
(`consumers` / `depends_on`).
