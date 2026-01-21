/**
 * Unit tests for acceptanceDecisionService
 */

import {
  makeDecision,
  makeOcrOnlyDecision,
  hasResolvedBook,
  getPrimaryBook,
  getAllCandidates,
  getDecisionDisplayText,
  needsUserConfirmation,
  getThresholds,
  TIER_THRESHOLDS,
} from '../acceptanceDecisionService';
import type { SearchCandidate, ScoredMatch, ResolvedBook, EvidenceTier } from '../../types';

// Suppress console.log during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('TIER_THRESHOLDS', () => {
  it('should have thresholds for all tiers', () => {
    const tiers: EvidenceTier[] = ['strong', 'usable', 'weak', 'unusable'];
    for (const tier of tiers) {
      expect(TIER_THRESHOLDS[tier]).toBeDefined();
      expect(TIER_THRESHOLDS[tier].autoAccept).toBeDefined();
      expect(TIER_THRESHOLDS[tier].suggest).toBeDefined();
      expect(TIER_THRESHOLDS[tier].ambiguous).toBeDefined();
    }
  });

  it('should have progressively stricter thresholds for weaker tiers', () => {
    expect(TIER_THRESHOLDS.strong.autoAccept).toBeLessThan(TIER_THRESHOLDS.weak.autoAccept);
    expect(TIER_THRESHOLDS.usable.autoAccept).toBeLessThan(TIER_THRESHOLDS.weak.autoAccept);
  });

  it('should never auto-accept or suggest for unusable tier', () => {
    expect(TIER_THRESHOLDS.unusable.autoAccept).toBe(1.0);
    expect(TIER_THRESHOLDS.unusable.suggest).toBe(1.0);
  });
});

describe('getThresholds', () => {
  it('should return correct thresholds for each tier', () => {
    expect(getThresholds('strong')).toBe(TIER_THRESHOLDS.strong);
    expect(getThresholds('usable')).toBe(TIER_THRESHOLDS.usable);
    expect(getThresholds('weak')).toBe(TIER_THRESHOLDS.weak);
    expect(getThresholds('unusable')).toBe(TIER_THRESHOLDS.unusable);
  });
});

describe('makeDecision', () => {
  const makeCandidate = (overrides: Partial<SearchCandidate> = {}): SearchCandidate => ({
    query: 'the great gatsby fitzgerald',
    titleHint: 'The Great Gatsby',
    authorHint: 'F. Scott Fitzgerald',
    confidence: 0.9,
    cropIndex: 0,
    tier: 'usable',
    tokens: ['great', 'gatsby', 'fitzgerald'],
    ...overrides,
  });

  const makeBook = (overrides: Partial<ResolvedBook> = {}): ResolvedBook => ({
    title: 'The Great Gatsby',
    authors: ['F. Scott Fitzgerald'],
    source: 'openLibrary',
    ...overrides,
  });

  const makeScoredMatch = (
    book: ResolvedBook,
    composite: number
  ): ScoredMatch => ({
    book,
    composite,
    signals: {
      queryTitle: 'The Great Gatsby',
      resultTitle: book.title,
      queryAuthor: 'F. Scott Fitzgerald',
      resultAuthor: book.authors[0],
      queryHadAuthor: true,
      isbnMatched: false,
      queryTokensInResult: 2,
      queryTokenCount: 3,
      resultPosition: 0,
    },
    normalizedSignals: {
      titleSimilarity: 0.9,
      authorPresence: 0.9,
      isbnMatch: 0,
      wordCoverage: 0.8,
      resultRank: 1.0,
      genericPenalty: 0,
    },
  });

  describe('no matches', () => {
    it('should return no-match with ocr-only fallback', () => {
      const decision = makeDecision({
        scoredMatches: [],
        candidate: makeCandidate(),
        fullTextBlock: 'Some text',
        evidenceTier: 'usable',
      });

      expect(decision.action).toBe('no-match');
      if (decision.action === 'no-match') {
        expect(decision.fallback).toBe('ocr-only');
      }
    });
  });

  describe('auto-accept', () => {
    it('should auto-accept high score with dominance', () => {
      const topBook = makeBook();
      const secondBook = makeBook({ title: 'Moby Dick' });

      const decision = makeDecision({
        scoredMatches: [
          makeScoredMatch(topBook, 0.92), // Above strong auto-accept
          makeScoredMatch(secondBook, 0.50), // Gap > 0.15
        ],
        candidate: makeCandidate(),
        fullTextBlock: 'The Great Gatsby by F. Scott Fitzgerald',
        evidenceTier: 'strong',
      });

      expect(decision.action).toBe('auto-accept');
      if (decision.action === 'auto-accept') {
        expect(decision.book).toBe(topBook);
        expect(decision.confidence).toBe(0.92);
      }
    });

    it('should not auto-accept when not dominated', () => {
      const topBook = makeBook();
      const secondBook = makeBook({ title: 'Gatsby: A Novel' });

      const decision = makeDecision({
        scoredMatches: [
          makeScoredMatch(topBook, 0.90),
          makeScoredMatch(secondBook, 0.85), // Gap < 0.15
        ],
        candidate: makeCandidate(),
        fullTextBlock: 'The Great Gatsby by F. Scott Fitzgerald',
        evidenceTier: 'strong',
      });

      // Should suggest instead of auto-accept
      expect(decision.action).toBe('suggest');
    });
  });

  describe('suggest', () => {
    it('should suggest when score is above suggest threshold', () => {
      const topBook = makeBook();
      const secondBook = makeBook({ title: 'Another Book' });

      const decision = makeDecision({
        scoredMatches: [
          makeScoredMatch(topBook, 0.78), // Above strong suggest (0.70)
          makeScoredMatch(secondBook, 0.65),
        ],
        candidate: makeCandidate(),
        fullTextBlock: 'The Great Gatsby',
        evidenceTier: 'strong',
      });

      expect(decision.action).toBe('suggest');
      if (decision.action === 'suggest') {
        expect(decision.book).toBe(topBook);
        expect(decision.alternatives).toHaveLength(1);
        expect(decision.confidence).toBe(0.78);
      }
    });

    it('should include up to 2 alternatives', () => {
      const books = [
        makeBook({ title: 'Book 1' }),
        makeBook({ title: 'Book 2' }),
        makeBook({ title: 'Book 3' }),
        makeBook({ title: 'Book 4' }),
      ];

      const decision = makeDecision({
        scoredMatches: books.map((b, i) => makeScoredMatch(b, 0.80 - i * 0.05)),
        candidate: makeCandidate(),
        fullTextBlock: 'Some text',
        evidenceTier: 'strong',
      });

      expect(decision.action).toBe('suggest');
      if (decision.action === 'suggest') {
        expect(decision.alternatives).toHaveLength(2);
      }
    });
  });

  describe('ambiguous', () => {
    it('should return ambiguous when score is in ambiguous range', () => {
      const books = [
        makeBook({ title: 'The Great Gatsby', authors: ['F. Scott Fitzgerald'] }),
        makeBook({ title: 'The Great Gatsby Revised', authors: ['F. Scott Fitzgerald'] }),
        makeBook({ title: 'Gatsby', authors: ['Fitzgerald'] }),
      ];

      // Candidate tokens must match book titles for verification to pass
      const decision = makeDecision({
        scoredMatches: books.map((b, i) => makeScoredMatch(b, 0.55 - i * 0.02)),
        candidate: makeCandidate(),
        fullTextBlock: 'The Great Gatsby',
        evidenceTier: 'strong',
      });

      expect(decision.action).toBe('ambiguous');
      if (decision.action === 'ambiguous') {
        expect(decision.candidates.length).toBeGreaterThan(0);
      }
    });

    it('should return ambiguous with isbn-conflict on ISBN mismatch', () => {
      const topBook = makeBook({ isbn13: '9781111111111' });

      const decision = makeDecision({
        scoredMatches: [makeScoredMatch(topBook, 0.95)],
        candidate: makeCandidate({ isbn: '9780000000000' }), // Different ISBN
        fullTextBlock: 'Some text',
        evidenceTier: 'strong',
      });

      expect(decision.action).toBe('ambiguous');
      if (decision.action === 'ambiguous') {
        expect(decision.reason).toBe('isbn-conflict');
        expect(decision.warnings).toContain('isbn-mismatch');
      }
    });
  });

  describe('no-match', () => {
    it('should return no-match for low scores', () => {
      const book = makeBook();

      const decision = makeDecision({
        scoredMatches: [makeScoredMatch(book, 0.30)], // Below ambiguous threshold
        candidate: makeCandidate(),
        fullTextBlock: 'Some text',
        evidenceTier: 'strong',
      });

      expect(decision.action).toBe('no-match');
      if (decision.action === 'no-match') {
        expect(decision.fallback).toBe('manual-entry');
      }
    });
  });

  describe('tier-dependent thresholds', () => {
    it('should require higher scores for weak tier', () => {
      const book = makeBook();

      // Score that would auto-accept for strong tier
      const strongDecision = makeDecision({
        scoredMatches: [makeScoredMatch(book, 0.90)],
        candidate: makeCandidate(),
        fullTextBlock: 'The Great Gatsby',
        evidenceTier: 'strong',
      });

      // Same score should only suggest for weak tier
      const weakDecision = makeDecision({
        scoredMatches: [makeScoredMatch(book, 0.90)],
        candidate: makeCandidate({ tier: 'weak' }),
        fullTextBlock: 'The Great Gatsby',
        evidenceTier: 'weak',
      });

      expect(strongDecision.action).toBe('auto-accept');
      expect(weakDecision.action).toBe('suggest');
    });

    it('should never match for unusable tier', () => {
      const book = makeBook();

      const decision = makeDecision({
        scoredMatches: [makeScoredMatch(book, 0.99)],
        candidate: makeCandidate({ tier: 'unusable' }),
        fullTextBlock: 'The Great Gatsby',
        evidenceTier: 'unusable',
      });

      expect(decision.action).toBe('no-match');
    });
  });
});

describe('makeOcrOnlyDecision', () => {
  it('should return ocr-only fallback when candidate has hints', () => {
    const decision = makeOcrOnlyDecision({
      query: 'gatsby',
      titleHint: 'Gatsby',
      confidence: 0.8,
      cropIndex: 0,
      tier: 'usable',
      tokens: ['gatsby'],
    });

    expect(decision.action).toBe('no-match');
    if (decision.action === 'no-match') {
      expect(decision.fallback).toBe('ocr-only');
    }
  });

  it('should return manual-entry fallback when no hints', () => {
    const decision = makeOcrOnlyDecision({
      query: '',
      confidence: 0.3,
      cropIndex: 0,
      tier: 'weak',
      tokens: [],
    });

    expect(decision.action).toBe('no-match');
    if (decision.action === 'no-match') {
      expect(decision.fallback).toBe('manual-entry');
    }
  });

  it('should return manual-entry for null candidate', () => {
    const decision = makeOcrOnlyDecision(null);

    expect(decision.action).toBe('no-match');
    if (decision.action === 'no-match') {
      expect(decision.fallback).toBe('manual-entry');
    }
  });
});

describe('hasResolvedBook', () => {
  it('should return true for auto-accept', () => {
    const decision = {
      action: 'auto-accept' as const,
      book: { title: 'Test', authors: [], source: 'openLibrary' as const },
      confidence: 0.9,
    };
    expect(hasResolvedBook(decision)).toBe(true);
  });

  it('should return true for suggest', () => {
    const decision = {
      action: 'suggest' as const,
      book: { title: 'Test', authors: [], source: 'openLibrary' as const },
      alternatives: [],
      confidence: 0.8,
    };
    expect(hasResolvedBook(decision)).toBe(true);
  });

  it('should return false for ambiguous', () => {
    const decision = {
      action: 'ambiguous' as const,
      candidates: [{ title: 'Test', authors: [], source: 'openLibrary' as const }],
    };
    expect(hasResolvedBook(decision)).toBe(false);
  });

  it('should return false for no-match', () => {
    const decision = {
      action: 'no-match' as const,
      fallback: 'ocr-only' as const,
    };
    expect(hasResolvedBook(decision)).toBe(false);
  });
});

describe('getPrimaryBook', () => {
  const book: ResolvedBook = { title: 'Test', authors: [], source: 'openLibrary' };

  it('should return book for auto-accept', () => {
    expect(getPrimaryBook({ action: 'auto-accept', book, confidence: 0.9 })).toBe(book);
  });

  it('should return book for suggest', () => {
    expect(getPrimaryBook({ action: 'suggest', book, alternatives: [], confidence: 0.8 })).toBe(book);
  });

  it('should return first candidate for ambiguous', () => {
    expect(getPrimaryBook({ action: 'ambiguous', candidates: [book] })).toBe(book);
  });

  it('should return null for ambiguous with no candidates', () => {
    expect(getPrimaryBook({ action: 'ambiguous', candidates: [] })).toBeNull();
  });

  it('should return null for no-match', () => {
    expect(getPrimaryBook({ action: 'no-match', fallback: 'ocr-only' })).toBeNull();
  });
});

describe('getAllCandidates', () => {
  const book1: ResolvedBook = { title: 'Book 1', authors: [], source: 'openLibrary' };
  const book2: ResolvedBook = { title: 'Book 2', authors: [], source: 'openLibrary' };

  it('should return single book for auto-accept', () => {
    const result = getAllCandidates({ action: 'auto-accept', book: book1, confidence: 0.9 });
    expect(result).toEqual([book1]);
  });

  it('should return book and alternatives for suggest', () => {
    const result = getAllCandidates({
      action: 'suggest',
      book: book1,
      alternatives: [book2],
      confidence: 0.8,
    });
    expect(result).toEqual([book1, book2]);
  });

  it('should return all candidates for ambiguous', () => {
    const result = getAllCandidates({ action: 'ambiguous', candidates: [book1, book2] });
    expect(result).toEqual([book1, book2]);
  });

  it('should return empty array for no-match', () => {
    const result = getAllCandidates({ action: 'no-match', fallback: 'ocr-only' });
    expect(result).toEqual([]);
  });
});

describe('getDecisionDisplayText', () => {
  it('should return matched text for auto-accept', () => {
    const text = getDecisionDisplayText({
      action: 'auto-accept',
      book: { title: 'Test Book', authors: [], source: 'openLibrary' },
      confidence: 0.9,
    });
    expect(text).toContain('Matched');
    expect(text).toContain('Test Book');
  });

  it('should return suggested text for suggest', () => {
    const text = getDecisionDisplayText({
      action: 'suggest',
      book: { title: 'Test Book', authors: [], source: 'openLibrary' },
      alternatives: [],
      confidence: 0.8,
    });
    expect(text).toContain('Suggested');
  });

  it('should return multiple matches text for ambiguous', () => {
    const text = getDecisionDisplayText({
      action: 'ambiguous',
      candidates: [
        { title: 'Book 1', authors: [], source: 'openLibrary' },
        { title: 'Book 2', authors: [], source: 'openLibrary' },
      ],
    });
    expect(text).toContain('Multiple matches');
    expect(text).toContain('2');
  });

  it('should return OCR text for no-match with ocr-only', () => {
    const text = getDecisionDisplayText({
      action: 'no-match',
      fallback: 'ocr-only',
    });
    expect(text).toContain('OCR');
  });

  it('should return manual entry text for no-match with manual-entry', () => {
    const text = getDecisionDisplayText({
      action: 'no-match',
      fallback: 'manual-entry',
    });
    expect(text).toContain('manual');
  });
});

describe('needsUserConfirmation', () => {
  it('should return false for auto-accept', () => {
    expect(
      needsUserConfirmation({
        action: 'auto-accept',
        book: { title: 'Test', authors: [], source: 'openLibrary' },
        confidence: 0.9,
      })
    ).toBe(false);
  });

  it('should return true for suggest', () => {
    expect(
      needsUserConfirmation({
        action: 'suggest',
        book: { title: 'Test', authors: [], source: 'openLibrary' },
        alternatives: [],
        confidence: 0.8,
      })
    ).toBe(true);
  });

  it('should return true for ambiguous', () => {
    expect(needsUserConfirmation({ action: 'ambiguous', candidates: [] })).toBe(true);
  });

  it('should return true for no-match', () => {
    expect(needsUserConfirmation({ action: 'no-match', fallback: 'ocr-only' })).toBe(true);
  });
});
