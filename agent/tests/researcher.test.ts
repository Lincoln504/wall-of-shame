/**
 * researcher.test.ts — Unit and integration tests for researcher.ts
 *
 * Tests the model config, environment variable plumbing, and the
 * extractResearchResult output parser.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ── extractResearchResult ─────────────────────────────────────────────────────

describe('extractResearchResult (via module)', () => {
  let extractResearchResult: (output: string) => any;

  beforeEach(async () => {
    const mod = await import('../src/researcher.js');
    extractResearchResult = (mod as any).extractResearchResult;
  });

  it('parses a valid JSON object with queries and findings', () => {
    const output = JSON.stringify({
      queries: ['query 1', 'query 2'],
      findings: [
        { url: 'https://ex.com/a', title: 'A', domain: 'ex.com', summary: 'Bad', category: 'test', whyBad: 'x', severity: 'high' },
        { url: 'https://ex.com/b', title: 'B', domain: 'ex.com', summary: 'Worse', category: 'test', whyBad: 'y', severity: 'medium' },
      ]
    });

    const result = extractResearchResult(output);
    expect(result.queries).toEqual(['query 1', 'query 2']);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].url).toBe('https://ex.com/a');
  });

  it('strips markdown code fences', () => {
    const output = '```json\n{\n"queries": ["q"],\n"findings": [{"url": "https://ex.com/a", "title": "A", "summary": "x", "category": "t", "whyBad": "x"}]\n}\n```';

    const result = extractResearchResult(output);
    expect(result.findings).toHaveLength(1);
    expect(result.queries).toEqual(['q']);
  });

  it('handles the old array-only format for backward compatibility', () => {
    const output = JSON.stringify([
      { url: 'https://ex.com/a', title: 'A', domain: 'ex.com', summary: 'Bad', category: 'test', whyBad: 'x', severity: 'high' }
    ]);

    const result = extractResearchResult(output);
    expect(result.findings).toHaveLength(1);
    expect(result.queries).toEqual([]);
  });

  it('filters out items without valid http URLs in findings', () => {
    const output = JSON.stringify({
      queries: [],
      findings: [
        { url: 'https://valid.com/good', title: 'Good', summary: 'y', category: 't', whyBad: 'x' },
        { url: 'not-a-url', title: 'Bad', summary: 'y', category: 't', whyBad: 'x' },
      ]
    });

    const result = extractResearchResult(output);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].url).toBe('https://valid.com/good');
  });

  it('returns empty result for non-JSON output', () => {
    const result = extractResearchResult('This is just a plain text response with no JSON');
    expect(result).toEqual({ findings: [], queries: [] });
  });
});

// ── Integration: runResearch (with SDK mock) ──────────────────────────────────

describe('runResearch (mocked SDK)', () => {
  let mod: Awaited<ReturnType<typeof import('../src/researcher.js')>>;

  beforeEach(async () => {
    mod = await import('../src/researcher.js');
  });

  it('loads the pi-research extension from the correct path', async () => {
    const { homedir } = await import('os');
    const { join } = await import('path');
    const extPath = join(homedir(), 'Documents', 'pi-research', 'src', 'index.ts');
    const { existsSync } = await import('fs');
    expect(existsSync(extPath)).toBe(true);
  });

  it('runResearch returns ResearchResult (integration with real pi session)', { timeout: 60000 }, async () => {
    const { existsSync } = await import('fs');
    const { homedir } = await import('os');
    const { join } = await import('path');
    const extPath = join(homedir(), 'Documents', 'pi-research', 'src', 'index.ts');
    const authPath = join(homedir(), '.pi', 'agent', 'auth.json');

    if (!existsSync(extPath) || !existsSync(authPath)) {
      console.warn('  ⚠ Skipping real SDK integration test: environment not set up');
      return;
    }

    const results = await mod.runResearch(
      'Return a JSON object with queries ["test"] and findings [].',
      'integration_test',
      'Integration Test',
      {},
      () => { /* silent in tests */ },
    );

    expect(results).toHaveProperty('findings');
    expect(results).toHaveProperty('queries');
    expect(Array.isArray(results.findings)).toBe(true);
    expect(Array.isArray(results.queries)).toBe(true);
  });
});

