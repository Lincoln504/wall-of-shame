import { describe, it, expect } from 'vitest';
import { safeParseJson, canonicalizeUrl, normalizeTitle, normalizeWhyBad } from '../src/utils.js';

describe('normalizeWhyBad', () => {
  it('strips a leading "Analysis:" label', () => {
    expect(normalizeWhyBad('Analysis: 1. The piece claims X.')).toBe('1. The piece claims X.');
  });

  it('strips the "Analysis: [ ... ]" golden-token wrapper', () => {
    expect(normalizeWhyBad('Analysis: [1. Quote. 2. Fallacy.]')).toBe('1. Quote. 2. Fallacy.');
  });

  it('strips a bare outer bracket wrapper', () => {
    expect(normalizeWhyBad('[1. Quote. 2. Harm.]')).toBe('1. Quote. 2. Harm.');
  });

  it('collapses repeated "Analysis:" labels', () => {
    expect(normalizeWhyBad('Analysis: Analysis: 1. X.')).toBe('1. X.');
  });

  it('unwraps a fenced JSON object that leaked in as the value', () => {
    const raw = '```json\n{"whyBad": "Analysis: [1. Quote. 2. Harm.]"}\n```';
    expect(normalizeWhyBad(raw)).toBe('1. Quote. 2. Harm.');
  });

  it('recovers a leaked JSON object containing invalid JSON escapes', () => {
    // Real failure mode: prose-style \' escapes make JSON.parse throw.
    const raw = `{"whyBad": "Analysis: [1. It is a \\'public-health\\' framing. 2. Harm.]"}`;
    expect(normalizeWhyBad(raw)).toBe("1. It is a 'public-health' framing. 2. Harm.");
  });

  it('strips markdown emphasis the model emits (site renders plain text)', () => {
    expect(normalizeWhyBad('1. It uses **loaded language** and *cherry-picking*.')).toBe('1. It uses loaded language and cherry-picking.');
    expect(normalizeWhyBad('1. The `term` is __bold__ here.')).toBe('1. The term is bold here.');
  });

  it('is idempotent on already-clean text', () => {
    const clean = '1. The author asserts X. 2. This is loaded language. 3. It hides harm.';
    expect(normalizeWhyBad(clean)).toBe(clean);
    expect(normalizeWhyBad(normalizeWhyBad(clean))).toBe(clean);
  });

  it('never destroys content (returns trimmed original if stripping empties it)', () => {
    expect(normalizeWhyBad('   ')).toBe('');
    expect(normalizeWhyBad('Analysis:')).toBe('Analysis:');
  });

  it('does not strip brackets that are not a full wrapper', () => {
    const s = '1. The bill (see [Section 4]) does X.';
    expect(normalizeWhyBad(s)).toBe(s);
  });
});

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
