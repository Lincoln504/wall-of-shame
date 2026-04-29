import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..'); // wall-of-shame/

function git(args: string, cwd = REPO_ROOT): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export function hasUncommittedChanges(): boolean {
  try {
    const status = git('status --porcelain agent/data/findings.json');
    return status.length > 0;
  } catch {
    return false;
  }
}

export function commitAndPush(newCount: number): void {
  const date = new Date().toISOString().slice(0, 10);
  const msg = `findings: add ${newCount} new entries [${date}]`;

  git('add agent/data/findings.json');
  // Set config inline so commit always works even without global git config
  git(`-c user.name="Lincoln504" -c user.email="Lincoln504@users.noreply.github.com" commit -m "${msg}"`);
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
