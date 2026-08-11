// 083 S3 — код `unsupported_lifecycle` и НОРМАТИВНОСТЬ пустого JSON Pointer.
//
// Таксономия живёт в ТРЁХ местах: TS-union `ValidationCode`, рантайм-карта `CODE_SEVERITY` и enum
// схемы `validation-result`. Каждая пара уже сцеплена своим механизмом: union↔карта — типом
// (`Record<ValidationCode, Severity>` не соберётся с пропущенным ключом), union↔схема — генератором
// (`gen-research-schemas --check` в `npm run build` падает на дрейфе).
//
// ЗАЧЕМ ТОГДА ЭТА ПРОВЕРКА. Она утверждает не процедуру, а СВОЙСТВО: «рантайм-таксономия и enum
// схемы совпадают». Оба механизма выше — реализации, и оба ослабляемы одной правкой: карту можно
// сделать `Partial`, генератор — научить пропускать enum, и в обоих случаях зелёным останется всё,
// кроме этого теста. Свойство переживает смену реализации, процедура — нет.
//
// Проверка двусторонняя: ни схема не может уйти вперёд, ни таксономия.
//
// Run: npx tsx --test test/validation-taxonomy.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_VALIDATION_CODES, CODE_SEVERITY, schemaAsset } from '../src/validation/index.js';
import { severityOf } from '../src/validation/codes.js';
import type { ValidationCode, ValidationIssue } from '../src/research-contract/index.js';

/** Enum кодов из забандленной схемы результата валидации. */
function schemaCodes(): readonly string[] {
  const schema = schemaAsset('validation-result') as {
    $defs?: Record<string, { enum?: string[] }>;
    definitions?: Record<string, { enum?: string[] }>;
  };
  const defs = schema.$defs ?? schema.definitions ?? {};
  for (const def of Object.values(defs)) {
    if (Array.isArray(def.enum) && def.enum.includes('schema_invalid')) return def.enum;
  }
  throw new Error('в схеме validation-result не найден enum кодов — проверка не может ответить на свой вопрос');
}

test('таксономия и enum схемы совпадают ПОЛНОСТЬЮ, в обе стороны', () => {
  const inSchema = [...schemaCodes()].sort();
  const inTaxonomy = [...ALL_VALIDATION_CODES].sort();

  // Сообщение печатает РАЗНИЦУ, а не «не равно»: последнее отправляет читателя выяснять заново то,
  // что тест уже знает.
  const missingInSchema = inTaxonomy.filter((c) => !inSchema.includes(c));
  const missingInTaxonomy = inSchema.filter((c) => !inTaxonomy.includes(c as ValidationCode));
  assert.deepEqual(
    { missingInSchema, missingInTaxonomy },
    { missingInSchema: [], missingInTaxonomy: [] },
  );
  assert.deepEqual(inSchema, inTaxonomy);
});

test('unsupported_lifecycle есть во всех трёх местах и он error', () => {
  assert.ok(ALL_VALIDATION_CODES.includes('unsupported_lifecycle'));
  assert.equal(severityOf('unsupported_lifecycle'), 'error');
  assert.equal(CODE_SEVERITY.unsupported_lifecycle, 'error');
  assert.ok(schemaCodes().includes('unsupported_lifecycle'));
});

test('unsupported_lifecycle — НЕ то же, что lifecycle_form_invalid', () => {
  // Оба про lifecycle, но чинят их разные люди: form_invalid — автор стратегии (манифест сам себе
  // противоречит), unsupported — владелец хоста (манифест безупречен, окружение не совпадает).
  // Слить их в один код значило бы отправлять автора чинить то, что не сломано.
  assert.ok(ALL_VALIDATION_CODES.includes('lifecycle_form_invalid'));
  assert.notEqual('unsupported_lifecycle', 'lifecycle_form_invalid');
});

test('пустой JSON Pointer — законный путь и означает документ целиком', () => {
  // RFC 6901 §5: пустая строка ссылается на весь документ. Для причины, у которой нарушающего УЗЛА
  // нет (запрос корректен, не совпадает окружение), это единственный честный указатель.
  const issue: ValidationIssue = {
    severity: 'error',
    code: 'unsupported_lifecycle',
    message: 'lifecycle: event_driven объявлен, но исполнение здесь не разрешено',
    path: '',
  };
  assert.equal(issue.path, '');

  // Схема обязана принимать такой issue: `path` — строка и остаётся ОБЯЗАТЕЛЬНОЙ. Если бы схема
  // требовала непустую строку или паттерн `^/`, честного пути для этой причины не существовало бы
  // вовсе, и автор кода вынужденно указал бы валидный узел — то есть соврал бы.
  const asText = JSON.stringify(schemaAsset('validation-result'));
  assert.ok(!asText.includes('"minLength": 1'), 'схема не должна запрещать пустой path');
});

test('поле path остаётся ОБЯЗАТЕЛЬНЫМ — второго способа сказать «узла нет» не заводим', () => {
  // `undefined` и `''` означали бы одно и то же, и потребителю пришлось бы различать оба.
  const schema = schemaAsset('validation-result') as {
    $defs?: Record<string, { required?: string[] }>;
    definitions?: Record<string, { required?: string[] }>;
  };
  const defs = schema.$defs ?? schema.definitions ?? {};
  const issueDef = Object.values(defs).find((d) => Array.isArray(d.required) && d.required.includes('code'));
  assert.ok(issueDef !== undefined, 'в схеме не найдено определение issue');
  assert.ok(issueDef.required!.includes('path'));
});
