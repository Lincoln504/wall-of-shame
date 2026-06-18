import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Safely escape a string for use in a shell command.
 * Wraps the string in single quotes and escapes any single quotes within it.
 */
function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Execute a git command from the repo root
 */
export function git(cmd: string, log?: (msg: string) => void): string {
  try {
    const output = execSync(`git ${cmd}`, { cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (log && output) log(`  [git] ${cmd}: ${output.split('\n')[0]}`);
    return output;
  } catch (err: any) {
    const stderr = err.stderr?.toString() || err.message;
    throw new Error(`Git command failed: git ${cmd}\n${stderr}`);
  }
}

/**
 * Check if there are any uncommitted changes in the agent data directory.
 */
export function hasDataChanges(): boolean {
  try {
    const status = git('status --porcelain agent/data/findings.json agent/data/run-state.json');
    return status.length > 0;
  } catch {
    return false;
  }
}

/**
 * Stage, commit, and push findings + run-state.
 */
export function commitAndPush(addedCount: number, categoryLabel?: string, log?: (msg: string) => void): void {
  if (!isGitRepo() || !remoteExists()) {
    log?.('  [git] skipping push: not a git repo or remote missing');
    return;
  }

  if (!hasDataChanges()) {
    log?.('  [git] no data changes to commit.');
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const catSuffix = categoryLabel ? ` [${categoryLabel}]` : '';

  try {
    log?.(`  [git] staging data changes...`);
    git('add agent/data/findings.json agent/data/run-state.json', log);

    log?.(`  [git] committing results...`);
    const message = addedCount > 0
      ? `research: automated run ${date}${catSuffix} (+${addedCount} new)`
      : `chore: update run-state for ${categoryLabel || 'category'} (no findings)`;

    // We check again just in case 'add' didn't actually stage anything new
    const staged = git('diff --cached --name-only agent/data/');
    if (staged.length > 0) {
      git(`commit -m ${shellEscape(message)}`, log);
    } else {
      log?.('  [git] nothing to commit after staging.');
    }

    log?.(`  [git] syncing with remote (pull --rebase --autostash)...`);
    // autostash handles local changes to source code that aren't staged
    git('pull --rebase --autostash origin main', log);

    log?.(`  [git] pushing to remote...`);
    git('push origin main', log);
    log?.(`  [git] successfully pushed findings to repository.`);
  } catch (err) {
    log?.(`  [git] CRITICAL: git operation failed: ${String(err)}`);
    // We don't throw to allow the main loop to continue, 
    // but the error is now visible in the logs.
  }
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
