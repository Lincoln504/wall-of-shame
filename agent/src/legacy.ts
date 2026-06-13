import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './findings.js';

/**
 * Extracts historical URLs from legacy-entries.md for a specific category.
 */
export function getLegacyLinks(categoryKey: string): string[] {
  const legacyPath = join(DATA_DIR, 'legacy-entries.md');
  if (!existsSync(legacyPath)) return [];

  const content = readFileSync(legacyPath, 'utf-8');
  const lines = content.split('\n');
  const urls: string[] = [];

  // Very simple markdown table parser
  for (const line of lines) {
    if (line.includes('|') && line.includes('http')) {
      const parts = line.split('|').map(p => p.trim());
      // Table format: | URL | Title | Original Cat | Severity |
      // URL is part 1 (index 1), Original Cat is part 3 (index 3)
      if (parts.length >= 4) {
        const url = parts[1];
        const cat = parts[3];
        if (url && cat && cat.toLowerCase() === categoryKey.toLowerCase()) {
          if (url.startsWith('http')) {
            urls.push(url);
          }
        }
      }
    }
  }

  return [...new Set(urls)];
}
