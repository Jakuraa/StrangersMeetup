// test/security_and_secrets.test.js - Security audit & secret leak prevention tests
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.resolve(PROJECT_ROOT, 'public');

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') {
        getAllFiles(fullPath, arrayOfFiles);
      }
    } else {
      arrayOfFiles.push(fullPath);
    }
  }
  return arrayOfFiles;
}

test('Security Audit: No Telegram bot tokens leaked in client-facing assets (public/)', () => {
  const publicFiles = getAllFiles(PUBLIC_DIR);
  // Telegram bot token regex pattern
  const botTokenRegex = /\b\d{8,11}:[A-Za-z0-9_-]{35}\b/;

  for (const filePath of publicFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(botTokenRegex);
    assert.equal(
      match,
      null,
      `Secret leak detected in ${path.relative(PROJECT_ROOT, filePath)}: ${match ? match[0] : ''}`
    );
  }
});

test('Security Audit: No server-side secrets or webhook secrets in public assets', () => {
  const publicFiles = getAllFiles(PUBLIC_DIR);
  const dangerousPatterns = [
    /TELEGRAM_BOT_TOKEN\s*=/i,
    /TELEGRAM_WEBHOOK_SECRET\s*=/i,
    /APP_SECRET\s*=/i,
    /x-telegram-bot-api-secret-token/i
  ];

  for (const filePath of publicFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const pattern of dangerousPatterns) {
      assert.equal(
        pattern.test(content),
        false,
        `Potential secret or internal header pattern found in ${path.relative(PROJECT_ROOT, filePath)}: ${pattern}`
      );
    }
  }
});

test('Security Audit: Legal & statutory placeholders are explicitly identified', () => {
  const grievancePath = path.join(PUBLIC_DIR, 'grievance.html');
  const grievanceContent = fs.readFileSync(grievancePath, 'utf8');

  assert.ok(
    grievanceContent.includes('CONFIG_GRIEVANCE_EMAIL_PLACEHOLDER'),
    'Grievance email must use an explicit configuration placeholder'
  );
  assert.ok(
    grievanceContent.includes('CONFIG_LEGAL_ENTITY_NAME_PLACEHOLDER'),
    'Legal entity name must use an explicit configuration placeholder'
  );
});

test('Security Audit: Landing page contains required security and meta headers', () => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  const content = fs.readFileSync(indexPath, 'utf8');

  assert.ok(content.includes('viewport'), 'Viewport meta must be present for responsive mobile layout');
  assert.ok(content.includes('Adults-Only') || content.includes('21+'), '21+ adult notice must be prominent');
  assert.ok(content.includes('dialog id="age-gate-dialog"'), 'Age gate dialog must be defined');
  assert.ok(content.includes('dialog id="checkout-dialog"'), 'Checkout dialog must be defined');
});
