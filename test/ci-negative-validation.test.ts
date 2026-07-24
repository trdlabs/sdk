// ВРЕМЕННЫЙ ФАЙЛ — НЕ МЕРЖИТЬ.
//
// Негативная валидация PR-гейта (гейт карточки ci-workflow-hardening, CI-1): доказывает, что
// `pr-check` действительно краснеет на битом изменении, а не просто зеленеет всегда. Гейт, который
// никто не видел красным, — это не гейт, а декорация.
//
// Тест имитирует контрактную регрессию: делает вид, что имя публикуемого пакета уехало. Ровно та
// категория поломки, ради которой гейт и заводился, — и в отличие от синтаксической ошибки она
// проверяет, что падает именно фаза `npm test` внутри `npm run check`.
//
// PR с этим файлом закрывается без мержа, ветка удаляется.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string };

test('НЕГАТИВНАЯ ВАЛИДАЦИЯ: этот тест обязан упасть и покрасить pr-check', () => {
  assert.equal(pkg.name, '@trdlabs/deliberately-wrong-package-name');
});
