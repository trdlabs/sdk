#!/usr/bin/env node
// 042 T006 — conformance валидатора kernel: прогон 017-фикстур через published-surface
// @trdlabs/sdk/validation. valid → НЕ rejected; invalid → rejected.
// Полный авторитетный оракул — verify_017_* гейты платформы против SDK (Фаза B / check:038);
// этот harness — pre-release проверка идентичности из самого SDK.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, 'fixtures', '017');

const { validate } = await import('../dist/validation/index.js');
const { platformContractContext } = await import('../dist/research-contract/index.js');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const inputKindOf = (fx) =>
  'request' in fx ? 'run_request' : 'promotion' in fx ? 'promotion' : 'module';

// Known-стратегии — собрать ТОЛЬКО из valid-фикстур (чтобы invalid с bogus-ref честно отклонялись).
const knownStrategies = new Set();
const collect = (fx) => {
  if (fx.manifest?.targetStrategyRef) knownStrategies.add(fx.manifest.targetStrategyRef);
  if (fx.manifest?.kind === 'strategy' && fx.manifest?.id) knownStrategies.add(fx.manifest.id);
  if (fx.request?.moduleRef?.id) knownStrategies.add(fx.request.moduleRef.id);
  for (const o of fx.request?.overlayRefs ?? []) if (o?.id) knownStrategies.add(o.id);
};
const validDir = join(FX, 'valid');
const invalidDir = join(FX, 'invalid');
for (const f of readdirSync(validDir)) collect(readJson(join(validDir, f)));

const ctx = platformContractContext([...knownStrategies]);

let failures = 0;
const run = (dir, expectRejected) => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const fx = readJson(join(dir, f));
    const res = validate({ inputKind: inputKindOf(fx), ...fx }, ctx);
    const rejected = res.status === 'rejected';
    if (rejected !== expectRejected) {
      failures += 1;
      console.error(
        `  ✗ ${expectRejected ? 'invalid' : 'valid'}/${f}: status=${res.status} ` +
          `codes=[${res.issues.map((i) => i.code).join(',')}]`,
      );
    }
  }
};

run(validDir, false);
run(invalidDir, true);

if (failures > 0) {
  console.error(`conformance-validation: FAIL (${failures} mismatch)`);
  process.exit(1);
}
console.log(
  `conformance-validation: OK — 017 fixtures conform via @trdlabs/sdk/validation ` +
    `(known strategies: ${[...knownStrategies].join(', ')})`,
);
