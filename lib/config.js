// lib/config.js - Unified configuration & secrets accessor
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let hatchableConfig = null;
try {
  const hatchableModule = await import('hatchable');
  if (hatchableModule && hatchableModule.config) {
    hatchableConfig = hatchableModule.config;
  }
} catch {
  // Local environment
}

// Load .env file locally if exists and not already loaded
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const k = trimmed.substring(0, eqIdx).trim();
      const v = trimmed.substring(eqIdx + 1).trim();
      if (!process.env[k]) {
        process.env[k] = v;
      }
    }
  }
}

export async function getConfig(key, defaultValue = '') {
  if (hatchableConfig && typeof hatchableConfig.get === 'function') {
    try {
      const val = await hatchableConfig.get(key);
      if (val !== undefined && val !== null && val !== '') return val;
    } catch {
      // Fallback to process.env
    }
  }
  return process.env[key] !== undefined ? process.env[key] : defaultValue;
}
