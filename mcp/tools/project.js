// mcp/tools/project.js - Read-only project source inspection, git branch status, and commit history.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT } from '../config.js';
import { resolveSafePath, redactSecrets } from '../security.js';

const execFileAsync = promisify(execFile);

/**
 * sm_read_source - Safely reads a source code file within REPO_ROOT with path traversal and secret guards.
 */
export async function readSource({ filePath, startLine = 1, endLine = 300 }) {
  const { absolutePath, relativePath } = resolveSafePath(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: '${relativePath}'`);
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: '${relativePath}'`);
  }

  // File size limit: 1MB max
  if (stat.size > 1024 * 1024) {
    throw new Error(`File exceeds 1MB inspection limit: '${relativePath}'`);
  }

  const content = fs.readFileSync(absolutePath, 'utf8');
  const lines = content.split('\n');

  const start = Math.max(1, parseInt(startLine, 10));
  const maxEnd = start + 300; // Hard max of 300 lines per call
  const end = Math.min(lines.length, Math.min(parseInt(endLine, 10) || lines.length, maxEnd));

  const selectedLines = [];
  for (let i = start; i <= end; i++) {
    const rawLine = lines[i - 1];
    const redactedLine = redactSecrets(rawLine);
    selectedLines.push(`${i}: ${redactedLine}`);
  }

  return {
    file_path: relativePath,
    total_file_lines: lines.length,
    start_line: start,
    end_line: end,
    line_count_returned: selectedLines.length,
    source_content: selectedLines.join('\n')
  };
}

/**
 * sm_get_branch_status - Returns git branch, remote tracking info, and working tree status.
 */
export async function getBranchStatus() {
  try {
    const [branchRes, statusRes] = await Promise.all([
      execFileAsync('git', ['branch', '--show-current'], { cwd: REPO_ROOT }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: REPO_ROOT })
    ]);

    const currentBranch = branchRes.stdout.trim();
    const statusLines = statusRes.stdout.split('\n').filter(Boolean);

    const modified = [];
    const untracked = [];

    for (const line of statusLines) {
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (code.includes('?')) untracked.push(file);
      else modified.push(`${code.trim()} ${file}`);
    }

    return {
      current_branch: currentBranch,
      is_clean: statusLines.length === 0,
      modified_files_count: modified.length,
      modified_files: modified.slice(0, 30),
      untracked_files_count: untracked.length,
      untracked_files: untracked.slice(0, 30)
    };
  } catch (err) {
    throw new Error(`Git branch check failed: ${err.message}`);
  }
}

/**
 * sm_get_recent_changes - Returns recent commits on the current branch.
 */
export async function getRecentChanges({ limit = 10 } = {}) {
  const boundedLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', `-n`, String(boundedLimit), '--pretty=format:%h|%an|%cr|%s'],
      { cwd: REPO_ROOT }
    );

    const commits = stdout.split('\n').filter(Boolean).map(line => {
      const [hash, author, date, subject] = line.split('|');
      return {
        commit_hash: hash,
        author,
        relative_date: date,
        message: redactSecrets(subject)
      };
    });

    return {
      commits_returned: commits.length,
      limit_requested: boundedLimit,
      commits
    };
  } catch (err) {
    throw new Error(`Git log failed: ${err.message}`);
  }
}

/**
 * sm_get_change_history - Returns git log for a specific file.
 */
export async function getChangeHistory({ filePath, limit = 10 }) {
  const { relativePath } = resolveSafePath(filePath);
  const boundedLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 30);

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', `-n`, String(boundedLimit), '--pretty=format:%h|%an|%cr|%s', '--', relativePath],
      { cwd: REPO_ROOT }
    );

    const commits = stdout.split('\n').filter(Boolean).map(line => {
      const [hash, author, date, subject] = line.split('|');
      return {
        commit_hash: hash,
        author,
        relative_date: date,
        message: redactSecrets(subject)
      };
    });

    return {
      file_path: relativePath,
      commits_returned: commits.length,
      commits
    };
  } catch (err) {
    throw new Error(`Git file history failed: ${err.message}`);
  }
}
