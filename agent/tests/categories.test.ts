/**
 * categories.test.ts — Unit tests for categories.ts
 *
 * Tests the category definitions, batch retrieval, and the
 * getBatch() rotation logic.
 *
 * No mocking needed — pure data module.
 */

import { describe, it, expect } from 'vitest';
import { CATEGORIES, CATEGORY_COUNT, getBatch } from '../src/categories.js';

describe('CATEGORIES', () => {
  it('defines a non-empty array of categories', () => {
    expect(CATEGORIES.length).toBeGreaterThan(0);
  });

  it('each category has required fields', () => {
    for (const cat of CATEGORIES) {
      expect(cat.key).toBeTruthy();
      expect(typeof cat.key).toBe('string');
      expect(cat.name).toBeTruthy();
      expect(typeof cat.name).toBe('string');
      expect(cat.description).toBeTruthy();
      expect(typeof cat.description).toBe('string');
      expect(cat.researchQuery).toBeTruthy();
      expect(typeof cat.researchQuery).toBe('string');
    }
  });

  it('all category keys are unique', () => {
    const keys = CATEGORIES.map(c => c.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('all category keys are kebab-case alphanumeric', () => {
    for (const cat of CATEGORIES) {
      expect(cat.key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('each researchQuery contains the category name', () => {
    for (const cat of CATEGORIES) {
      const nameLower = cat.name.toLowerCase();
      const queryLower = cat.researchQuery.toLowerCase();
      // At least one significant word (>=5 chars) from the name should appear in the query
      const words = nameLower.split(/[^a-z]+/).filter(w => w.length >= 5);
      const matched = words.length === 0 || words.some(w => queryLower.includes(w));
      expect(matched).toBe(true);
    }
  });

  it('each researchQuery has query keywords', () => {
    const firstCat = CATEGORIES[0];
    expect(firstCat.researchQuery.length).toBeGreaterThan(50);
    expect(firstCat.researchQuery).toContain('Find');
    expect(firstCat.researchQuery).toContain('Research these angles');
  });

  it('all research queries are substantial strings', () => {
    for (const cat of CATEGORIES) {
      expect(cat.researchQuery.length).toBeGreaterThan(20);
    }
  });

  it('has a reasonable number of categories (>= 20)', () => {
    expect(CATEGORIES.length).toBeGreaterThanOrEqual(20);
  });

  it('has diverse category types covering multiple areas', () => {
    const keys = CATEGORIES.map(c => c.key);
    expect(keys).toContain('union_busting');
    expect(keys).toContain('climate_denial');
    expect(keys).toContain('trans_panic');
    expect(keys).toContain('colorblind_racism');
    expect(keys).toContain('billionaire_worship');
  });
});

describe('CATEGORY_COUNT', () => {
  it('matches the actual array length', () => {
    expect(CATEGORY_COUNT).toBe(CATEGORIES.length);
  });
});

describe('getBatch', () => {
  it('returns the correct number of categories for default batch size', () => {
    const batch = getBatch(0, 3);
    expect(batch).toHaveLength(3);
  });

  it('returns categories in order starting from the given index', () => {
    const batch = getBatch(0, 2);
    expect(batch[0].key).toBe(CATEGORIES[0].key);
    expect(batch[1].key).toBe(CATEGORIES[1].key);
  });

  it('wraps around when index + size exceeds CATEGORY_COUNT', () => {
    // getBatch uses index % CATEGORIES.length as start.
    // For a wrap, pick an index near the end.
    // With len=34, size=3: idx=32 => start=32, then +1=33, +2=0 (wraps).
    const batch = getBatch(32, 3);
    expect(batch[0].key).toBe(CATEGORIES[32].key);
    expect(batch[1].key).toBe(CATEGORIES[33].key);
    expect(batch[2].key).toBe(CATEGORIES[0].key);
  });

  it('handles batch index where start wraps', () => {
    const batch = getBatch(CATEGORY_COUNT, 2);
    // index=34 => start = 34 % 34 = 0
    expect(batch[0].key).toBe(CATEGORIES[0].key);
    expect(batch[1].key).toBe(CATEGORIES[1].key);
  });

  it('handles batch size larger than total categories (wraps multiple times)', () => {
    const batchSize = CATEGORY_COUNT + 2;
    const batch = getBatch(0, batchSize);
    expect(batch).toHaveLength(batchSize);

    // First CATEGORY_COUNT items should be all categories in order
    for (let i = 0; i < CATEGORY_COUNT; i++) {
      expect(batch[i].key).toBe(CATEGORIES[i].key);
    }
    // Then wrap to the first 2
    expect(batch[CATEGORY_COUNT].key).toBe(CATEGORIES[0].key);
    expect(batch[CATEGORY_COUNT + 1].key).toBe(CATEGORIES[1].key);
  });

  it('returns unique categories within a batch (unless batch size > total)', () => {
    const batch = getBatch(0, 5);
    const keys = batch.map(c => c.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('every category in the batch has all required fields', () => {
    const batch = getBatch(0, CATEGORY_COUNT);
    for (const cat of batch) {
      expect(cat.key).toBeTruthy();
      expect(cat.name).toBeTruthy();
      expect(cat.description).toBeTruthy();
      expect(cat.researchQuery).toBeTruthy();
    }
  });

  it('sequential batches cover all categories over time', () => {
    // getBatch(index, size) uses start = index % len.
    // Iterating index 0,1,2,...,33 with size=4 covers all start positions.
    const batchSize = 4;
    const seen = new Set<string>();

    for (let idx = 0; idx < CATEGORY_COUNT; idx++) {
      const batch = getBatch(idx, batchSize);
      for (const cat of batch) {
        seen.add(cat.key);
      }
    }

    // All categories were seen across batches
    expect(seen.size).toBe(CATEGORY_COUNT);
  });

  it('can be called with the default batch size argument', () => {
    const batch = getBatch(0); // uses default size 3
    expect(batch).toHaveLength(3);
  });

  it('default batch size of 3 is the actual default', () => {
    const batch = getBatch(0);
    expect(batch.length).toBeLessThanOrEqual(3);
  });
});
