#!/usr/bin/env tsx
import { loadState, saveState } from './findings.js';
import { commitAndPush } from './git.js';

/**
 * Verification script for the git automation pipeline.
 * Performs a harmless update to run-state.json and attempts a full commit & push.
 */
async function verify() {
  const ts = () => new Date().toISOString().slice(11, 19);
  const log = (msg: string) => console.log(`[${ts()}] ${msg}`);

  log('Starting git automation verification...');

  try {
    // 1. Load current state
    const state = loadState();
    log('State loaded.');

    // 2. Make a harmless change
    // We'll add or update a 'verificationTimestamp' in a custom metadata field if it doesn't exist
    // or just update the lastRun timestamp which saveState does automatically.
    // To ensure a change is detected by git, we'll add a dummy query to 'verification_test' category.
    if (!state.queryHistory['verification_test']) {
      state.queryHistory['verification_test'] = {};
    }
    state.queryHistory['verification_test']!['git_test_' + Date.now()] = new Date().toISOString();

    log('Harmless change applied to run-state.json.');

    // 3. Save state (writes to disk)
    saveState(state);
    log('State saved to disk.');

    // 4. Trigger commit and push
    log('Triggering commitAndPush...');
    commitAndPush(0, 'Git Verification', log);

    log('Verification complete. Check git logs or remote to confirm success.');
  } catch (err) {
    console.error('VERIFICATION FAILED:', err);
    process.exit(1);
  }
}

verify();
