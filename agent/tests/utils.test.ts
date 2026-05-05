import { describe, it, expect } from 'vitest';
import { safeParseJson, canonicalizeUrl, normalizeTitle } from '../src/utils.js';

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

describe('canonicalizeUrl', () => {

  it('removes protocol and www', () => {
    expect(canonicalizeUrl('https://www.example.com/page')).toBe('example.com/page');
    expect(canonicalizeUrl('http://example.com/page')).toBe('example.com/page');
  });

  it('removes trailing slashes', () => {
    expect(canonicalizeUrl('https://example.com/path/')).toBe('example.com/path');
  });

  it('strips tracking and common query parameters', () => {
    const input = 'https://example.com/article?utm_source=twitter&ref=social&id=123&fbclid=xyz';
    // utm_source, ref, and fbclid should be removed. id should stay.
    expect(canonicalizeUrl(input)).toBe('example.com/article?id=123');
  });

  it('preserves fragment identifiers', () => {
    expect(canonicalizeUrl('https://example.com/page#section1')).toBe('example.com/page#section1');
  });

  it('handles malformed URLs gracefully', () => {
    expect(canonicalizeUrl('not-a-url')).toBe('not-a-url');
    expect(canonicalizeUrl('ftp://server/file')).toBe('server/file');
  });
});

describe('normalizeTitle', () => {

  it('removes special characters and whitespace', () => {
    expect(normalizeTitle('Harmful Article: Why it is bad!')).toBe('harmfularticlewhyitisbad');
  });

  it('handles multiple spaces and casing', () => {
    expect(normalizeTitle('  The   Title  ')).toBe('thetitle');
  });

  it('is idempotent', () => {
    const t = 'Some Title 123';
    expect(normalizeTitle(normalizeTitle(t))).toBe(normalizeTitle(t));
  });
});
