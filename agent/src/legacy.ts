import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './findings.js';

/**
 * Extracts historical seed URLs from legacy-entries.md for a specific category.
 *
 * legacy-entries.md groups entries under `## <Category>` section headers whose
 * text maps 1:1 to a canonical category key (e.g. `## Democracy` -> `democracy`).
 * We key off the section header rather than the per-row "Original Cat" column,
 * because that column frequently holds non-canonical sub-category labels
 * (`voter_suppression`, `dark_money`, `antitrust`, ...) that would otherwise
 * never match a canonical key and silently drop those seeds.
 */
export function getLegacyLinks(categoryKey: string): string[] {
  return getLegacySeeds(categoryKey).map(s => s.url);
}

export interface LegacySeed {
  url: string;
  title: string;
}

/**
 * Like getLegacyLinks but also returns each entry's title column, for building
 * a seed-evaluation report.
 */
export function getLegacySeeds(categoryKey: string): LegacySeed[] {
  const legacyPath = join(DATA_DIR, 'legacy-entries.md');
  if (!existsSync(legacyPath)) return [];

  const content = readFileSync(legacyPath, 'utf-8');
  const lines = content.split('\n');
  const seeds: LegacySeed[] = [];
  const target = categoryKey.toLowerCase();
  const seen = new Set<string>();

  let currentSection: string | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headerMatch) {
      currentSection = headerMatch[1]!.trim().split(/\s+/)[0]!.toLowerCase();
      continue;
    }

    if (currentSection !== target) continue;

    // Table row: | URL | Title | Original Cat | Severity |
    if (line.includes('|') && line.includes('http')) {
      const parts = line.split('|').map(p => p.trim());
      const url = parts[1];
      const title = parts[2] || '';
      if (url && url.startsWith('http') && !seen.has(url)) {
        seen.add(url);
        seeds.push({ url, title });
      }
    }
  }

  return seeds;
}
