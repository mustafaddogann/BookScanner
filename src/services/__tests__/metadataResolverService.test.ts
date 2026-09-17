/**
 * Unit tests for metadataResolverService
 */

import {
  computeMatchSignals,
  normalizeSignals,
  computeComposite,
  scoreMatch,
  isDominated,
  scoreAndRankMatches,
  SCORING_WEIGHTS,
} from '../metadataResolverService';
import type { SearchCandidate, ResolvedBook } from '../../types';

// Suppress console.log during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('computeMatchSignals', () => {
  const makeCandidate = (overrides: Partial<SearchCandidate> = {}): SearchCandidate => ({
    query: 'the great gatsby',
    titleHint: 'The Great Gatsby',
    authorHint: 'F. Scott Fitzgerald',
    confidence: 0.9,
    cropIndex: 0,
    tier: 'usable',
    tokens: ['the', 'great', 'gatsby'],
    ...overrides,
  });

  const makeBook = (overrides: Partial<ResolvedBook> = {}): ResolvedBook => ({
    title: 'The Great Gatsby',
    authors: ['F. Scott Fitzgerald'],
    source: 'openLibrary',
    ...overrides,
  });

  it('should extract query and result titles', () => {
    const signals = computeMatchSignals(makeCandidate(), makeBook(), 0);
    expect(signals.queryTitle).toBe('The Great Gatsby');
    expect(signals.resultTitle).toBe('The Great Gatsby');
  });

  it('should detect ISBN match', () => {
    const candidate = makeCandidate({ isbn: '9780743273565' });
    const book = makeBook({ isbn13: '9780743273565' });
    const signals = computeMatchSignals(candidate, book, 0);
    expect(signals.isbnMatched).toBe(true);
  });

  it('should detect ISBN mismatch', () => {
    const candidate = makeCandidate({ isbn: '9780743273565' });
    const book = makeBook({ isbn13: '9780061120084' });
    const signals = computeMatchSignals(candidate, book, 0);
    expect(signals.isbnMatched).toBe(false);
  });

  it('should count token overlap', () => {
    const signals = computeMatchSignals(makeCandidate(), makeBook(), 0);
    expect(signals.queryTokensInResult).toBeGreaterThan(0);
    expect(signals.queryTokenCount).toBe(3);
  });

  it('should track result position', () => {
    const signals1 = computeMatchSignals(makeCandidate(), makeBook(), 0);
    const signals2 = computeMatchSignals(makeCandidate(), makeBook(), 5);
    expect(signals1.resultPosition).toBe(0);
    expect(signals2.resultPosition).toBe(5);
  });
});

describe('normalizeSignals', () => {
  const makeCandidate = (): SearchCandidate => ({
    query: 'the great gatsby',
    titleHint: 'The Great Gatsby',
    authorHint: 'Fitzgerald',
    confidence: 0.9,
    cropIndex: 0,
    tier: 'usable',
    tokens: ['great', 'gatsby'],
  });

  const makeBook = (): ResolvedBook => ({
    title: 'The Great Gatsby',
    authors: ['F. Scott Fitzgerald'],
    source: 'openLibrary',
  });

  it('should return values in [0, 1] range', () => {
    const candidate = makeCandidate();
    const book = makeBook();
    const signals = computeMatchSignals(candidate, book, 0);
    const normalized = normalizeSignals(signals, candidate, book);

    for (const value of Object.values(normalized)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('should give high title similarity for exact match', () => {
    const candidate = makeCandidate();
    const book = makeBook();
    const signals = computeMatchSignals(candidate, book, 0);
    const normalized = normalizeSignals(signals, candidate, book);
    expect(normalized.titleSimilarity).toBeGreaterThan(0.9);
  });

  it('should give author presence for matching author', () => {
    const candidate = makeCandidate();
    const book = makeBook();
    const signals = computeMatchSignals(candidate, book, 0);
    const normalized = normalizeSignals(signals, candidate, book);
    expect(normalized.authorPresence).toBeGreaterThan(0.5);
  });

  it('should give partial author credit when query has no author', () => {
    const candidate = { ...makeCandidate(), authorHint: undefined };
    const book = makeBook();
    const signals = computeMatchSignals(candidate, book, 0);
    const normalized = normalizeSignals(signals, candidate, book);
    expect(normalized.authorPresence).toBe(0.5);
  });

  it('should give high result rank for position 0', () => {
    const candidate = makeCandidate();
    const book = makeBook();
    const signals = computeMatchSignals(candidate, book, 0);
    const normalized = normalizeSignals(signals, candidate, book);
    expect(normalized.resultRank).toBe(1.0);
  });

  it('should decrease result rank for later positions', () => {
    const candidate = makeCandidate();
    const book = makeBook();
    const signals = computeMatchSignals(candidate, book, 5);
    const normalized = normalizeSignals(signals, candidate, book);
    expect(normalized.resultRank).toBe(0.5);
  });
});

describe('computeComposite', () => {
  it('should compute weighted sum of signals', () => {
    const normalized = {
      titleSimilarity: 1.0,
      authorPresence: 1.0,
      isbnMatch: 1.0,
      wordCoverage: 1.0,
      resultRank: 1.0,
      genericPenalty: 0.0, // No penalty
    };

    const composite = computeComposite(normalized);

    // Sum of positive weights
    const expectedMax =
      SCORING_WEIGHTS.titleSimilarity +
      SCORING_WEIGHTS.authorPresence +
      SCORING_WEIGHTS.isbnMatch +
      SCORING_WEIGHTS.wordCoverage +
      SCORING_WEIGHTS.resultRank;

    expect(composite).toBeCloseTo(expectedMax, 2);
  });

  it('should apply generic penalty', () => {
    const normalized = {
      titleSimilarity: 1.0,
      authorPresence: 1.0,
      isbnMatch: 0.0,
      wordCoverage: 1.0,
      resultRank: 1.0,
      genericPenalty: 1.0, // Maximum penalty
    };

    const compositeWithPenalty = computeComposite(normalized);

    // With penalty, score should be reduced
    const normalizedNoPenalty = { ...normalized, genericPenalty: 0.0 };
    const compositeNoPenalty = computeComposite(normalizedNoPenalty);

    expect(compositeWithPenalty).toBeLessThan(compositeNoPenalty);
  });

  it('should clamp to [0, 1]', () => {
    // All zeros
    const composite1 = computeComposite({
      titleSimilarity: 0,
      authorPresence: 0,
      isbnMatch: 0,
      wordCoverage: 0,
      resultRank: 0,
      genericPenalty: 1.0,
    });
    expect(composite1).toBeGreaterThanOrEqual(0);

    // All ones
    const composite2 = computeComposite({
      titleSimilarity: 1,
      authorPresence: 1,
      isbnMatch: 1,
      wordCoverage: 1,
      resultRank: 1,
      genericPenalty: 0,
    });
    expect(composite2).toBeLessThanOrEqual(1);
  });
});

describe('isDominated', () => {
  it('should require smaller gap for high scores', () => {
    // First > 0.85 requires gap >= 0.15
    expect(isDominated(0.90, 0.75)).toBe(true);  // Gap = 0.15
    expect(isDominated(0.90, 0.76)).toBe(false); // Gap = 0.14
  });

  it('should require medium gap for medium scores', () => {
    // First > 0.70 requires gap >= 0.20
    expect(isDominated(0.80, 0.60)).toBe(true);  // Gap = 0.20
    expect(isDominated(0.80, 0.61)).toBe(false); // Gap = 0.19
  });

  it('should require large gap for low scores', () => {
    // First <= 0.70 requires gap >= 0.30
    expect(isDominated(0.65, 0.35)).toBe(true);  // Gap = 0.30
    expect(isDominated(0.65, 0.36)).toBe(false); // Gap = 0.29
  });

  it('should handle edge cases', () => {
    expect(isDominated(1.0, 0.84)).toBe(true);   // Max score, gap > 0.15
    expect(isDominated(0.5, 0.5)).toBe(false);   // Same score
    expect(isDominated(0.4, 0.5)).toBe(false);   // First lower than second
  });
});

describe('scoreAndRankMatches', () => {
  const candidate: SearchCandidate = {
    query: 'gatsby fitzgerald',
    titleHint: 'The Great Gatsby',
    authorHint: 'Fitzgerald',
    confidence: 0.9,
    cropIndex: 0,
    tier: 'usable',
    tokens: ['gatsby', 'fitzgerald'],
  };

  it('should sort matches by composite score descending', () => {
    const matches: ResolvedBook[] = [
      { title: 'Moby Dick', authors: ['Herman Melville'], source: 'openLibrary' },
      { title: 'The Great Gatsby', authors: ['F. Scott Fitzgerald'], source: 'openLibrary' },
      { title: 'Gatsby: A Novel', authors: ['Someone'], source: 'openLibrary' },
    ];

    const scored = scoreAndRankMatches(candidate, matches);

    // Best match should be first
    expect(scored[0].book.title).toBe('The Great Gatsby');

    // Scores should be descending
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i].composite).toBeLessThanOrEqual(scored[i - 1].composite);
    }
  });

  it('should include signals in scored matches', () => {
    const matches: ResolvedBook[] = [
      { title: 'The Great Gatsby', authors: ['F. Scott Fitzgerald'], source: 'openLibrary' },
    ];

    const scored = scoreAndRankMatches(candidate, matches);

    expect(scored[0].signals).toBeDefined();
    expect(scored[0].normalizedSignals).toBeDefined();
    expect(scored[0].composite).toBeGreaterThan(0);
  });

  it('should handle empty matches', () => {
    const scored = scoreAndRankMatches(candidate, []);
    expect(scored).toHaveLength(0);
  });
});

describe('scoreMatch', () => {
  it('should return ScoredMatch with all fields', () => {
    const candidate: SearchCandidate = {
      query: 'gatsby',
      titleHint: 'Gatsby',
      confidence: 0.8,
      cropIndex: 0,
      tier: 'usable',
      tokens: ['gatsby'],
    };

    const book: ResolvedBook = {
      title: 'The Great Gatsby',
      authors: ['F. Scott Fitzgerald'],
      source: 'openLibrary',
    };

    const scored = scoreMatch(candidate, book, 0);

    expect(scored.book).toBe(book);
    expect(scored.composite).toBeGreaterThan(0);
    expect(scored.composite).toBeLessThanOrEqual(1);
    expect(scored.signals).toBeDefined();
    expect(scored.normalizedSignals).toBeDefined();
  });
});
