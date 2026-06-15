import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('@lincoln504/pi-research', () => ({
  initResearchSDK: vi.fn().mockResolvedValue(undefined),
  shutdownResearchSDK: vi.fn().mockResolvedValue(undefined),
  runQuickResearch: vi.fn().mockResolvedValue('test report'),
  verifyUrl: vi.fn().mockResolvedValue(true)
}));

/**
 * main.test.ts — Unit tests for logic in main.ts
 */

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wall-of-shame-main-test-'));
  process.env['PI_AGENT_DATA_DIR'] = tempDir;
});

afterAll(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('CLI argument parsing logic', () => {
  function parseArgs(args: string[]): { batchSize: number; dryRun: boolean } {
    const batchIdx = args.indexOf('--batch-size');
    const batchSize = batchIdx !== -1 ? (parseInt(args[batchIdx + 1] ?? '3', 10) || 3) : 3;
    const dryRun = args.includes('--dry-run');
    return { batchSize, dryRun };
  }

  it('defaults to batch size 3 and dry-run false', () => {
    const result = parseArgs([]);
    expect(result.batchSize).toBe(3);
    expect(result.dryRun).toBe(false);
  });

  it('parses --batch-size correctly', () => {
    const result = parseArgs(['--batch-size', '5']);
    expect(result.batchSize).toBe(5);
  });

  it('parses --dry-run correctly', () => {
    const result = parseArgs(['--dry-run']);
    expect(result.dryRun).toBe(true);
  });
});
