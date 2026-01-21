/**
 * Unit tests for stringSimilarity utilities
 */

import {
  jaroSimilarity,
  jaroWinklerSimilarity,
  normalizeForComparison,
  normalizedJaroWinkler,
  tokenize,
  tokenOverlap,
  findBestMatch,
  countSpecificTokens,
  computeGenericPenalty,
  GENERIC_TOKENS,
  HIGH_COLLISION_TITLES,
} from '../stringSimilarity';

describe('jaroSimilarity', () => {
  it('should return 1.0 for identical strings', () => {
    expect(jaroSimilarity('hello', 'hello')).toBe(1.0);
    expect(jaroSimilarity('', '')).toBe(1.0);
  });

  it('should return 0.0 when one string is empty', () => {
    expect(jaroSimilarity('hello', '')).toBe(0.0);
    expect(jaroSimilarity('', 'hello')).toBe(0.0);
  });

  it('should return 0.0 for completely different strings', () => {
    expect(jaroSimilarity('abc', 'xyz')).toBe(0.0);
  });

  it('should return high similarity for similar strings', () => {
    const sim = jaroSimilarity('MARTHA', 'MARHTA');
    expect(sim).toBeGreaterThan(0.9);
  });

  it('should handle case sensitivity', () => {
    expect(jaroSimilarity('Hello', 'hello')).toBeLessThan(1.0);
  });
});

describe('jaroWinklerSimilarity', () => {
  it('should return 1.0 for identical strings', () => {
    expect(jaroWinklerSimilarity('hello', 'hello')).toBe(1.0);
  });

  it('should give bonus for common prefix', () => {
    // Jaro-Winkler should be >= Jaro for strings with common prefix
    const jaro = jaroSimilarity('MARTHA', 'MARHTA');
    const jaroWinkler = jaroWinklerSimilarity('MARTHA', 'MARHTA');
    expect(jaroWinkler).toBeGreaterThanOrEqual(jaro);
  });

  it('should respect scaling factor limit', () => {
    // Even with high scaling factor, should not exceed Jaro + prefix bonus
    const jw1 = jaroWinklerSimilarity('prefix', 'prefab', 0.1);
    const jw2 = jaroWinklerSimilarity('prefix', 'prefab', 0.5); // Should be capped at 0.25
    // Both should be reasonable values
    expect(jw1).toBeLessThanOrEqual(1.0);
    expect(jw2).toBeLessThanOrEqual(1.0);
  });

  it('should handle common book title typos', () => {
    const sim = jaroWinklerSimilarity('The Great Gatsby', 'The Grate Gatsby');
    expect(sim).toBeGreaterThan(0.9);
  });
});

describe('normalizeForComparison', () => {
  it('should lowercase text', () => {
    expect(normalizeForComparison('HELLO')).toBe('hello');
  });

  it('should remove punctuation', () => {
    expect(normalizeForComparison("it's a test!")).toBe('its a test');
  });

  it('should collapse whitespace', () => {
    expect(normalizeForComparison('hello   world')).toBe('hello world');
  });

  it('should trim', () => {
    expect(normalizeForComparison('  hello  ')).toBe('hello');
  });

  it('should handle combined transformations', () => {
    expect(normalizeForComparison("  Hello,  World!  ")).toBe('hello world');
  });
});

describe('normalizedJaroWinkler', () => {
  it('should normalize before comparing', () => {
    const sim = normalizedJaroWinkler('HELLO, WORLD!', 'hello world');
    expect(sim).toBe(1.0);
  });
});

describe('tokenize', () => {
  it('should split on whitespace', () => {
    expect(tokenize('hello world')).toEqual(['hello', 'world']);
  });

  it('should normalize before tokenizing', () => {
    expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
  });

  it('should filter empty tokens', () => {
    expect(tokenize('  hello   world  ')).toEqual(['hello', 'world']);
  });

  it('should return empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('tokenOverlap', () => {
  it('should count matching tokens', () => {
    const result = tokenOverlap('hello world', 'hello there');
    expect(result.count).toBe(1);
    expect(result.ratio).toBe(0.5);
  });

  it('should return 1.0 ratio for identical strings', () => {
    const result = tokenOverlap('hello world', 'hello world');
    expect(result.count).toBe(2);
    expect(result.ratio).toBe(1.0);
  });

  it('should return 0 for no overlap', () => {
    const result = tokenOverlap('hello world', 'foo bar');
    expect(result.count).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it('should handle empty first string', () => {
    const result = tokenOverlap('', 'hello');
    expect(result.count).toBe(0);
    expect(result.ratio).toBe(0);
  });
});

describe('findBestMatch', () => {
  it('should find best matching candidate', () => {
    const result = findBestMatch('hello', ['helo', 'hello', 'world']);
    expect(result.match).toBe('hello');
    expect(result.score).toBe(1.0);
    expect(result.index).toBe(1);
  });

  it('should return null for empty candidates', () => {
    const result = findBestMatch('hello', []);
    expect(result.match).toBeNull();
    expect(result.score).toBe(0);
    expect(result.index).toBe(-1);
  });

  it('should handle partial matches', () => {
    const result = findBestMatch('gatsby', ['gatsby novel', 'the great gatsby', 'moby dick']);
    expect(result.index).toBe(0); // 'gatsby novel' has 'gatsby' as prefix
  });
});

describe('countSpecificTokens', () => {
  it('should count non-generic tokens', () => {
    expect(countSpecificTokens('the great gatsby')).toBe(2); // 'great', 'gatsby'
    expect(countSpecificTokens('the book')).toBe(0); // both generic
  });

  it('should handle empty string', () => {
    expect(countSpecificTokens('')).toBe(0);
  });
});

describe('computeGenericPenalty', () => {
  it('should return low penalty for specific titles', () => {
    const penalty = computeGenericPenalty(
      'The Great Gatsby',
      'The Great Gatsby'
    );
    expect(penalty).toBeLessThan(0.3);
  });

  it('should return high penalty for generic titles', () => {
    const penalty = computeGenericPenalty('The Book', 'The Book');
    // 'the' and 'book' are both generic
    expect(penalty).toBeGreaterThan(0.2);
  });

  it('should add penalty for high collision titles', () => {
    const penalty = computeGenericPenalty('Introduction', 'Introduction');
    expect(penalty).toBeGreaterThanOrEqual(0.4);
  });

  it('should add penalty for short result titles', () => {
    const penalty = computeGenericPenalty('Gatsby', 'It');
    expect(penalty).toBeGreaterThanOrEqual(0.1);
  });

  it('should clamp to [0, 1]', () => {
    // Even with multiple penalties, should not exceed 1
    const penalty = computeGenericPenalty('Guide', 'A');
    expect(penalty).toBeLessThanOrEqual(1);
    expect(penalty).toBeGreaterThanOrEqual(0);
  });

  it('should return max penalty for empty query', () => {
    const penalty = computeGenericPenalty('', 'Some Title');
    expect(penalty).toBe(1.0);
  });
});

describe('GENERIC_TOKENS', () => {
  it('should contain common stop words', () => {
    expect(GENERIC_TOKENS.has('the')).toBe(true);
    expect(GENERIC_TOKENS.has('and')).toBe(true);
    expect(GENERIC_TOKENS.has('book')).toBe(true);
  });

  it('should not contain content words', () => {
    expect(GENERIC_TOKENS.has('gatsby')).toBe(false);
    expect(GENERIC_TOKENS.has('novel')).toBe(false);
  });
});

describe('HIGH_COLLISION_TITLES', () => {
  it('should contain common generic titles', () => {
    expect(HIGH_COLLISION_TITLES.has('introduction')).toBe(true);
    expect(HIGH_COLLISION_TITLES.has('guide')).toBe(true);
  });
});
