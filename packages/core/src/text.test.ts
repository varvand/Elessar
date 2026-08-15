import { describe, expect, it } from 'vitest';
import {
  cleanText,
  contentHash,
  embeddingText,
  normalizeKey,
  sentences,
  tokens,
  truncate,
} from './text';

describe('cleanText', () => {
  it('strips markup and collapses whitespace', () => {
    expect(cleanText('<p>Hello   <b>world</b></p>')).toBe('Hello world');
    expect(cleanText('line\n\nbreak\ttab')).toBe('line break tab');
  });

  it('unwraps CDATA, which most RSS feeds use for titles', () => {
    expect(cleanText('<![CDATA[Breaking: quake hits]]>')).toBe('Breaking: quake hits');
  });

  it('decodes named and numeric entities, including hex', () => {
    expect(cleanText('Fire &amp; smoke')).toBe('Fire & smoke');
    expect(cleanText('caf&#233;')).toBe('café');
    expect(cleanText('caf&#xe9;')).toBe('café');
    expect(cleanText('a&nbsp;b')).toBe('a b');
  });

  it('survives malformed numeric entities instead of throwing', () => {
    // A feed emitting a bogus code point must not kill the whole batch.
    expect(() => cleanText('bad &#999999999999; entity')).not.toThrow();
    expect(() => cleanText('bad &#xZZZZ; entity')).not.toThrow();
  });

  it('returns empty string for null and undefined', () => {
    expect(cleanText(null)).toBe('');
    expect(cleanText(undefined)).toBe('');
    expect(cleanText('')).toBe('');
  });
});

describe('normalizeKey', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeKey('Zürich')).toBe('zurich');
    expect(normalizeKey('São Paulo')).toBe('sao paulo');
    expect(normalizeKey('Hīt')).toBe('hit');
  });

  it('reduces punctuation to spaces so surface forms unify', () => {
    expect(normalizeKey("Côte d'Ivoire")).toBe('cote d ivoire');
    expect(normalizeKey('U.S.A.')).toBe('u s a');
  });

  it('is idempotent', () => {
    // Applied twice in places (entity keys, hashing); must be a fixed point.
    const once = normalizeKey('Kyïv,  Ukraine!');
    expect(normalizeKey(once)).toBe(once);
  });
});

describe('contentHash', () => {
  it('is stable across formatting differences that carry no meaning', () => {
    // Dedup depends on this. The same story republished with different markup or
    // spacing must hash identically, or the globe fills with duplicate pins.
    const a = contentHash('Quake hits Flores', 'Rescue teams  deployed.');
    const b = contentHash('<b>Quake hits Flores</b>', 'Rescue teams deployed.');
    const c = contentHash('quake hits flores', 'rescue teams deployed.');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('differs when the content genuinely differs', () => {
    expect(contentHash('Quake hits Flores', null)).not.toBe(contentHash('Quake hits Bali', null));
  });

  it('distinguishes field boundaries', () => {
    // "ab" + "" must not collide with "a" + "b", or titles and bodies could
    // silently merge into the same key.
    expect(contentHash('ab', '')).not.toBe(contentHash('a', 'b'));
  });

  it('tolerates null and undefined parts', () => {
    expect(() => contentHash(null, undefined, 'x')).not.toThrow();
    expect(contentHash(null)).toBe(contentHash(undefined));
  });

  it('returns a 64-char hex digest', () => {
    expect(contentHash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('embeddingText', () => {
  it('front-loads the title, which carries the most clustering signal', () => {
    const text = embeddingText('Quake hits Flores', 'A long body follows here.');
    expect(text.startsWith('Quake hits Flores')).toBe(true);
  });

  it('includes the place name when supplied', () => {
    expect(embeddingText('Quake', 'body', 'Ende, Indonesia')).toContain('Ende, Indonesia');
  });

  it('bounds its output so a huge body cannot dominate the model input', () => {
    const text = embeddingText('Title', 'x'.repeat(50_000));
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('handles a null body', () => {
    expect(embeddingText('Just a title', null)).toBe('Just a title');
  });
});

describe('sentences', () => {
  it('splits on terminators followed by a capital', () => {
    expect(sentences('One thing happened. Then another. And a third!')).toHaveLength(3);
  });

  it('returns an empty array for empty input', () => {
    expect(sentences('')).toEqual([]);
  });
});

describe('truncate', () => {
  it('leaves short strings untouched', () => {
    expect(truncate('short', 50)).toBe('short');
  });

  it('cuts on a word boundary and marks the elision', () => {
    const result = truncate('the quick brown fox jumps over the lazy dog', 20);
    expect(result.length).toBeLessThanOrEqual(21);
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toContain('jum…'); // not mid-word
  });
});

describe('tokens', () => {
  it('drops stopwords and very short tokens', () => {
    const result = tokens('The earthquake in the region was severe');
    expect(result).toContain('earthquake');
    expect(result).toContain('region');
    expect(result).not.toContain('the');
    expect(result).not.toContain('in');
  });
});
