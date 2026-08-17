import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { packAndExtract, renderSurface } from './api-surface.ts';

const repoDir = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-surface-'));
try {
  const pkgDir = packAndExtract(repoDir, tmp);
  fs.writeFileSync(path.join(repoDir, 'api-surface.txt'), renderSurface(pkgDir), 'utf8');
  console.log('wrote api-surface.txt');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
