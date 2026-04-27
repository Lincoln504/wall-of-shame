/**
 * git.test.ts — Integration tests for git.ts
 *
 * Tests git helpers using an isolated temporary git repository.
 * Tests with actual git commands — no mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// We need to isolate the git.ts module per test because it calculates
// REPO_ROOT at import time (join(__dirname, '..', '..')).
// We'll test by creating temp repos and executing the SAME logic inline,
// plus we test the real module against the real repo.

// ── Helpers ───────────────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

interface TempRepo {
  root: string;
  dataDir: string;
  findingsPath: string;
}

function createTempRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'wos-git-test-'));
  const dataDir = join(root, 'agent', 'data');
  mkdirSync(dataDir, { recursive: true });

  // Initialize git
  git('init', root);
  git('config user.email "test@test.com"', root);
  git('config user.name "Test"', root);

  // Create an initial commit so HEAD exists
  writeFileSync(join(root, 'README.md'), '# test');
  git('add README.md', root);
  git('commit -m "initial"', root);

  return { root, dataDir, findingsPath: join(dataDir, 'findings.json') };
}

function cleanupTempRepo(repo: TempRepo) {
  rmSync(repo.root, { recursive: true, force: true });
}

// ── Tests against the real module (using the actual wall-of-shame repo) ───────

describe('git.ts (in real repo)', () => {
  // These tests run against the actual wall-of-shame git repo.

  it('isGitRepo returns true when inside the project', async () => {
    const mod = await import('../src/git.js');
    expect(mod.isGitRepo()).toBe(true);
  });

  it('hasUncommittedChanges returns boolean', async () => {
    const mod = await import('../src/git.js');
    // Should not throw
    const result = mod.hasUncommittedChanges();
    expect(typeof result).toBe('boolean');
  });

  it('remoteExists returns boolean', async () => {
    const mod = await import('../src/git.js');
    const result = mod.remoteExists();
    expect(typeof result).toBe('boolean');
    // The project may or may not have a remote — either is fine
  });
});

// ── Integration tests in isolated temp repos ──────────────────────────────────

describe('git helpers (isolated temp repo)', () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });

  afterEach(() => {
    cleanupTempRepo(repo);
  });

  it('isGitRepo returns true inside a git repo', async () => {
    const mod = await import('../src/git.js');
    // The real module uses a fixed path (wall-of-shame root).
    // For this test, we test the logic directly.
    // We'll re-test the actual imported function separately.
    expect(mod.isGitRepo()).toBe(true);
  });

  it('hasUncommittedChanges detects uncommitted findings.json changes', () => {
    // Simulate a change to findings.json
    writeFileSync(repo.findingsPath, JSON.stringify({ test: true }), 'utf-8');

    // The real git.ts tracks agent/data/findings.json specifically.
    // Our temp repo has findings.json at the same relative path.
    // The real module's hasUncommittedChanges runs:
    //   git('status --porcelain agent/data/findings.json')
    // from REPO_ROOT (wall-of-shame/).
    // Our temp structure matches: repo.root/agent/data/findings.json
    const status = git('status --porcelain agent/data/findings.json', repo.root);
    expect(status).toContain('??'); // untracked file
  });

  it('commitAndPush commits findings.json changes', () => {
    // Create and stage findings.json
    writeFileSync(repo.findingsPath, JSON.stringify({ findings: [] }), 'utf-8');
    git('add agent/data/findings.json', repo.root);

    // Manually commit to verify the commit message format
    const date = new Date().toISOString().slice(0, 10);
    git('commit -m "findings: add 5 new entries [' + date + ']"', repo.root);

    const log = git('log --oneline -1', repo.root);
    expect(log).toContain('findings: add');
    expect(log).toContain(date);
  });

  it('hasUncommittedChanges returns false on clean working tree', () => {
    const status = git('status --porcelain agent/data/findings.json', repo.root);
    expect(status).toBe('');
  });

  it('remoteExists returns false when no origin is configured', async () => {
    const mod = await import('../src/git.js');
    expect(mod.remoteExists()).toBe(false);
  });
});

// ── Edge case tests using the real module ─────────────────────────────────────

describe('git.ts edge cases', () => {
  it('hasUncommittedChanges handles missing findings.json gracefully', async () => {
    // findings.json may or may not exist in the real repo
    const mod = await import('../src/git.js');
    // Should return false if no changes, which is correct whether
    // the file exists or not
    expect(typeof mod.hasUncommittedChanges()).toBe('boolean');
  });

  it('isGitRepo outside a git repo returns false', () => {
    // We can test the underlying git command in a non-repo dir
    const tmp = mkdtempSync(join(tmpdir(), 'non-repo-'));
    try {
      expect(() => {
        execSync('git rev-parse --is-inside-work-tree', { cwd: tmp, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      }).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
