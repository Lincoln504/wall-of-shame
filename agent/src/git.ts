import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Execute a git command from the repo root
 */
export function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch (err) {
    throw new Error(`Git command failed: git ${cmd}\n${String(err)}`);
  }
}

/**
 * Check if there are any uncommitted changes in the data directory
 */
export function hasDataChanges(): boolean {
  try {
    const status = git('status --porcelain agent/data/');
    return status.length > 0;
  } catch {
    return false;
  }
}

/**
 * Stage, commit, and push findings and state
 */
export function commitAndPush(addedCount: number): void {
  const date = new Date().toISOString().slice(0, 10);
  git('add agent/data/');
  git(`commit -m "research: automated run ${date} (+${addedCount} new)"`);
  git('push');
}

export function isGitRepo(): boolean {
  try {
    git('rev-parse --is-inside-work-tree');
    return true;
  } catch {
    return false;
  }
}

export function remoteExists(): boolean {
  try {
    const remotes = git('remote');
    return remotes.includes('origin');
  } catch {
    return false;
  }
}
