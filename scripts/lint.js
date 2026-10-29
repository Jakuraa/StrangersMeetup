// scripts/lint.js - Syntax-check every JS file (node --check) and validate JSON config.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', '.vercel', 'research_notes', 'reports', '.claude', 'test-results', 'playwright-report']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|json)$/.test(e.name) && e.name !== 'package-lock.json') files.push(p);
  }
})(ROOT);

let errors = 0;
for (const f of files) {
  try {
    if (f.endsWith('.json')) JSON.parse(fs.readFileSync(f, 'utf8'));
    else execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    errors++;
    console.error(`✗ ${path.relative(ROOT, f)}\n${String(err.stderr || err.message).slice(0, 400)}`);
  }
}
console.log(`${files.length - errors}/${files.length} files OK`);
process.exit(errors ? 1 : 0);
