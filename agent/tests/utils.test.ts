import { describe, it, expect } from 'vitest';
import { safeParseJson } from '../src/utils.js';

describe('safeParseJson', () => {
  it('parses a valid JSON object', () => {
    const result = safeParseJson<{ a: number }>('{"a": 1}');
    expect(result.a).toBe(1);
  });

  it('strips markdown code fences', () => {
    const result = safeParseJson<{ a: number }>('```json\n{"a": 1}\n```');
    expect(result.a).toBe(1);
  });

  it('handles trailing commas', () => {
    const result = safeParseJson<{ a: number }>('{"a": 1,}');
    expect(result.a).toBe(1);
  });

  it('throws on invalid non-JSON output', () => {
    expect(() => safeParseJson('This is just text')).toThrow();
  });
});
