import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;

const LEGACY_MD = `# Legacy Entries

## Democracy
*sub: voter suppression*

| URL | Title | Original Cat | Severity |
|-----|-------|-------------|----------|
| https://a.example/voter | Voter ID piece | voter_suppression | high |
| https://b.example/dark | Dark money piece | dark_money | medium |

## Economics
*sub: antitrust*

| URL | Title | Original Cat | Severity |
|-----|-------|-------------|----------|
| https://c.example/anti | Antitrust overreach | antitrust | medium |
| https://c.example/anti | Antitrust overreach dup | antitrust | medium |
`;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wos-legacy-'));
  process.env['PI_AGENT_DATA_DIR'] = tempDir;
  writeFileSync(join(tempDir, 'legacy-entries.md'), LEGACY_MD, 'utf-8');
});

afterAll(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('legacy seeding (section-header based)', () => {
  it('matches by section header, NOT the non-canonical Original Cat column', async () => {
    const { getLegacyLinks } = await import('../src/legacy.js');
    // These rows have Original Cat = voter_suppression / dark_money (non-canonical)
    // but live under "## Democracy" — they must still be reachable under 'democracy'.
    const links = getLegacyLinks('democracy');
    expect(links).toEqual(['https://a.example/voter', 'https://b.example/dark']);
  });

  it('returns nothing for a category whose section is absent', async () => {
    const { getLegacyLinks } = await import('../src/legacy.js');
    expect(getLegacyLinks('war')).toEqual([]);
  });

  it('dedupes repeated URLs within a section and exposes titles via getLegacySeeds', async () => {
    const { getLegacySeeds } = await import('../src/legacy.js');
    const seeds = getLegacySeeds('economics');
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toEqual({ url: 'https://c.example/anti', title: 'Antitrust overreach' });
  });
});
