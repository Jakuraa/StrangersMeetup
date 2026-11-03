// mcp/tools/testing.js - Safe, non-destructive test execution runner.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT } from '../config.js';
import { redactSecrets } from '../security.js';

const execAsync = promisify(exec);

const SAFE_TEST_SUITES = {
  unit: {
    command: 'TEST_DATABASE_URL=postgres://localhost/sm_rec_test node --test --test-concurrency=1 test/*.test.js',
    timeoutMs: 60_000,
    description: 'Node.js built-in test runner for all isolated unit test files'
  },
  lint: {
    command: 'node scripts/lint.js',
    timeoutMs: 15_000,
    description: 'Source code syntax, formatting and integrity linter'
  },
  tap_targets: {
    command: 'npx playwright test e2e/tap-targets.spec.js',
    timeoutMs: 45_000,
    description: 'Playwright test verifying 44px minimum tap targets across mobile viewports'
  },
  responsive_e2e: {
    command: 'npx playwright test e2e/mobile-layout.spec.js',
    timeoutMs: 90_000,
    description: 'Playwright responsive layout and axe accessibility audit suite'
  }
};

export const AVAILABLE_SUITES = Object.keys(SAFE_TEST_SUITES);

/**
 * sm_run_safe_tests - Executes an explicitly authorized, non-destructive test suite.
 */
export async function runSafeTests({ suite }) {
  const config = SAFE_TEST_SUITES[suite];
  if (!config) {
    throw new Error(`Unauthorized test suite '${suite}'. Available safe suites: ${AVAILABLE_SUITES.join(', ')}`);
  }

  // Create isolated environment preventing remote DB connections or telegram calls
  const safeEnv = {
    ...process.env,
    NODE_ENV: 'test',
    VERCEL: '',
    VERCEL_ENV: 'test',
    IS_LOCAL_TEST: 'true',
    DEV_LOGIN: 'true',
    ENABLE_LIVE_PAYMENTS: 'false',
    TEST_DATABASE_URL: 'postgres://localhost/sm_rec_test'
  };

  // Strip all production credentials from child process
  delete safeEnv.DATABASE_URL;
  delete safeEnv.DATABASE_URL_UNPOOLED;
  delete safeEnv.PREVIEW_DATABASE_URL;
  delete safeEnv.TELEGRAM_BOT_TOKEN;
  delete safeEnv.SUPERPROFILE_API_KEY;
  delete safeEnv.CRON_SECRET;

  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let passed = false;

  try {
    const res = await execAsync(config.command, {
      cwd: REPO_ROOT,
      env: safeEnv,
      timeout: config.timeoutMs
    });
    stdout = res.stdout || '';
    stderr = res.stderr || '';
    passed = true;
  } catch (err) {
    exitCode = err.code ?? 1;
    stdout = err.stdout || '';
    stderr = err.stderr || err.message || '';
    passed = false;
  }

  const durationMs = Date.now() - startTime;
  const combinedOutput = `${stdout}\n${stderr}`.trim();

  // Extract pass / fail indicators
  const passMatch = combinedOutput.match(/ℹ pass (\d+)|(\d+) passed/);
  const failMatch = combinedOutput.match(/ℹ fail (\d+)|(\d+) failed/);
  const totalMatch = combinedOutput.match(/ℹ tests (\d+)|Running (\d+) tests/);

  return {
    suite,
    passed,
    exit_code: exitCode,
    duration_ms: durationMs,
    tests_summary: {
      total: totalMatch ? parseInt(totalMatch[1] || totalMatch[2], 10) : null,
      passed_count: passMatch ? parseInt(passMatch[1] || passMatch[2], 10) : null,
      failed_count: failMatch ? parseInt(failMatch[1] || failMatch[2], 10) : 0
    },
    output_bounded: redactSecrets(combinedOutput.slice(-3000)) // Bounded last 3000 chars
  };
}
