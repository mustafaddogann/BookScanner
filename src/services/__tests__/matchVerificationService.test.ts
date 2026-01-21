/**
 * Unit tests for matchVerificationService
 */

import {
  verifyMatch,
  verifyAllMatches,
  VERIFICATION_PENALTIES,
  getFlagSeverity,
  getFlagDescription,
} from '../matchVerificationService';
import type { SearchCandidate, ResolvedBook, VerificationFlag } from '../../types';

// Suppress console.log during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('verifyMatch', () => {
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

  describe('author-mismatch flag', () => {
    it('should not flag when authors match', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ authorHint: 'Fitzgerald' }),
        book: makeBook({ authors: ['F. Scott Fitzgerald'] }),
        fullTextBlock: 'The Great Gatsby by Fitzgerald',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('author-mismatch');
    });

    it('should flag when authors do not match', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ authorHint: 'Hemingway' }),
        book: makeBook({ authors: ['F. Scott Fitzgerald'] }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).toContain('author-mismatch');
    });

    it('should flag when query has author but result does not', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ authorHint: 'Fitzgerald' }),
        book: makeBook({ authors: [] }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).toContain('author-mismatch');
    });

    it('should not flag when query has no author', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ authorHint: undefined }),
        book: makeBook({ authors: ['Anyone'] }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('author-mismatch');
    });
  });

  describe('isbn-mismatch flag', () => {
    it('should not flag when ISBNs match', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ isbn: '9780743273565' }),
        book: makeBook({ isbn13: '9780743273565' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('isbn-mismatch');
    });

    it('should flag when ISBNs do not match', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ isbn: '9780743273565' }),
        book: makeBook({ isbn13: '9780061120084' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).toContain('isbn-mismatch');
    });

    it('should not flag when query has no ISBN', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ isbn: undefined }),
        book: makeBook({ isbn13: '9780743273565' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('isbn-mismatch');
    });

    it('should not flag when result has no ISBN', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ isbn: '9780743273565' }),
        book: makeBook({ isbn13: undefined }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('isbn-mismatch');
    });
  });

  describe('token-coverage-low flag', () => {
    it('should not flag when coverage is high', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ tokens: ['great', 'gatsby'] }),
        book: makeBook({ title: 'The Great Gatsby' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('token-coverage-low');
    });

    it('should flag when coverage is low', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ tokens: ['moby', 'dick', 'whale', 'ocean'] }),
        book: makeBook({ title: 'The Great Gatsby' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).toContain('token-coverage-low');
    });

    it('should not flag when candidate has no tokens', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ tokens: [] }),
        book: makeBook(),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('token-coverage-low');
    });
  });

  describe('suspicious-edition flag', () => {
    it('should not flag when publisher found in evidence', () => {
      const result = verifyMatch({
        candidate: makeCandidate(),
        book: makeBook({ publisher: 'Scribner' }),
        fullTextBlock: 'Published by Scribner',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('suspicious-edition');
    });

    it('should flag when publisher not found in evidence', () => {
      const result = verifyMatch({
        candidate: makeCandidate(),
        book: makeBook({ publisher: 'Random House', title: 'Guide' }), // Short title
        fullTextBlock: 'The Great Gatsby by Fitzgerald',
        baseConfidence: 0.9,
      });
      expect(result.flags).toContain('suspicious-edition');
    });

    it('should not flag when book has no publisher', () => {
      const result = verifyMatch({
        candidate: makeCandidate(),
        book: makeBook({ publisher: undefined }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('suspicious-edition');
    });

    it('should not flag for long titles', () => {
      const result = verifyMatch({
        candidate: makeCandidate(),
        book: makeBook({
          title: 'The Very Long Title That Has Many Words',
          publisher: 'Unknown Press',
        }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('suspicious-edition');
    });
  });

  describe('year-implausible flag', () => {
    it('should not flag valid years', () => {
      const result = verifyMatch({
        candidate: makeCandidate(),
        book: makeBook({ publishYear: '2023' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('year-implausible');
    });

    it('should flag future years', () => {
      const futureYear = (new Date().getFullYear() + 5).toString();
      const result = verifyMatch({
        candidate: makeCandidate(),
        book: makeBook({ publishYear: futureYear }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).toContain('year-implausible');
    });

    it('should flag very old years', () => {
      const result = verifyMatch({
        candidate: makeCandidate(),
        book: makeBook({ publishYear: '1700' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).toContain('year-implausible');
    });

    it('should not flag when book has no year', () => {
      const result = verifyMatch({
        candidate: makeCandidate(),
        book: makeBook({ publishYear: undefined }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('year-implausible');
    });
  });

  describe('publisher-mismatch flag', () => {
    it('should not flag when publishers match', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ publisherHint: 'Penguin Books' }),
        book: makeBook({ publisher: 'Penguin Books' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('publisher-mismatch');
    });

    it('should not flag when publishers are similar', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ publisherHint: 'Penguin' }),
        book: makeBook({ publisher: 'Penguin Books Ltd' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('publisher-mismatch');
    });

    it('should flag when publishers do not match', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ publisherHint: 'Penguin Books' }),
        book: makeBook({ publisher: 'Random House' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).toContain('publisher-mismatch');
    });

    it('should not flag when candidate has no publisher hint', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ publisherHint: undefined }),
        book: makeBook({ publisher: 'Any Publisher' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('publisher-mismatch');
    });

    it('should not flag when book has no publisher', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ publisherHint: 'Penguin Books' }),
        book: makeBook({ publisher: undefined }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('publisher-mismatch');
    });
  });

  describe('edition-conflict flag', () => {
    it('should not flag when editions match', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ editionHint: '3rd Edition' }),
        book: makeBook({ edition: '3rd Edition' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('edition-conflict');
    });

    it('should not flag when edition numbers match', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ editionHint: '2nd Edition' }),
        book: makeBook({ edition: 'Second Edition' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      // Both have "2" as the edition number - should not conflict
      // Note: "Second Edition" doesn't have a digit, so no conflict detected
      expect(result.flags).not.toContain('edition-conflict');
    });

    it('should flag when edition numbers conflict', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ editionHint: '3rd Edition' }),
        book: makeBook({ edition: '5th Edition' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).toContain('edition-conflict');
    });

    it('should not flag when candidate has no edition hint', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ editionHint: undefined }),
        book: makeBook({ edition: '3rd Edition' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('edition-conflict');
    });

    it('should not flag when book has no edition', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ editionHint: '3rd Edition' }),
        book: makeBook({ edition: undefined }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      expect(result.flags).not.toContain('edition-conflict');
    });

    it('should not flag when editions have no numbers', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ editionHint: 'Revised Edition' }),
        book: makeBook({ edition: 'Updated Edition' }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });
      // No numbers to compare, so no conflict
      expect(result.flags).not.toContain('edition-conflict');
    });
  });

  describe('penalty calculation', () => {
    it('should return passed=true when no flags', () => {
      const result = verifyMatch({
        candidate: makeCandidate({ authorHint: undefined, isbn: undefined, tokens: ['gatsby'] }),
        book: makeBook(),
        fullTextBlock: 'gatsby',
        baseConfidence: 0.9,
      });
      expect(result.passed).toBe(true);
      expect(result.flags).toHaveLength(0);
      expect(result.penalty).toBe(0);
      expect(result.adjustedConfidence).toBe(0.9);
    });

    it('should apply penalty for each flag', () => {
      const result = verifyMatch({
        candidate: makeCandidate({
          authorHint: 'Wrong Author',
          isbn: '9780000000000',
        }),
        book: makeBook({
          isbn13: '9781111111111',
        }),
        fullTextBlock: 'Some text',
        baseConfidence: 0.9,
      });

      expect(result.passed).toBe(false);
      expect(result.flags.length).toBeGreaterThan(0);
      expect(result.penalty).toBeGreaterThan(0);
      expect(result.adjustedConfidence).toBeLessThan(0.9);
    });

    it('should not go below 0', () => {
      const result = verifyMatch({
        candidate: makeCandidate({
          authorHint: 'Wrong',
          isbn: '9780000000000',
          tokens: ['wrong', 'tokens', 'here', 'none', 'match'],
        }),
        book: makeBook({
          isbn13: '9781111111111',
          publisher: 'Unknown',
          publishYear: '3000',
          title: 'Short',
        }),
        fullTextBlock: '',
        baseConfidence: 0.5,
      });

      expect(result.adjustedConfidence).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('verifyAllMatches', () => {
  it('should verify multiple books', () => {
    const candidate: SearchCandidate = {
      query: 'gatsby',
      titleHint: 'Gatsby',
      confidence: 0.9,
      cropIndex: 0,
      tier: 'usable',
      tokens: ['gatsby'],
    };

    const books: ResolvedBook[] = [
      { title: 'The Great Gatsby', authors: ['Fitzgerald'], source: 'openLibrary' },
      { title: 'Moby Dick', authors: ['Melville'], source: 'openLibrary' },
    ];

    const results = verifyAllMatches({
      candidate,
      books,
      fullTextBlock: 'gatsby',
      baseConfidences: [0.9, 0.7],
    });

    expect(results).toHaveLength(2);
    expect(results[0].adjustedConfidence).toBeLessThanOrEqual(0.9);
    expect(results[1].adjustedConfidence).toBeLessThanOrEqual(0.7);
  });
});

describe('VERIFICATION_PENALTIES', () => {
  it('should have penalties for all flags', () => {
    const flags: VerificationFlag[] = [
      'author-mismatch',
      'isbn-mismatch',
      'token-coverage-low',
      'suspicious-edition',
      'year-implausible',
      'publisher-mismatch',
      'edition-conflict',
    ];

    for (const flag of flags) {
      expect(VERIFICATION_PENALTIES[flag]).toBeDefined();
      expect(VERIFICATION_PENALTIES[flag]).toBeGreaterThan(0);
    }
  });

  it('should have highest penalty for isbn-mismatch', () => {
    expect(VERIFICATION_PENALTIES['isbn-mismatch']).toBeGreaterThan(
      VERIFICATION_PENALTIES['author-mismatch']
    );
    expect(VERIFICATION_PENALTIES['isbn-mismatch']).toBeGreaterThan(
      VERIFICATION_PENALTIES['publisher-mismatch']
    );
    expect(VERIFICATION_PENALTIES['isbn-mismatch']).toBeGreaterThan(
      VERIFICATION_PENALTIES['edition-conflict']
    );
  });
});

describe('getFlagSeverity', () => {
  it('should return error for isbn-mismatch', () => {
    expect(getFlagSeverity('isbn-mismatch')).toBe('error');
  });

  it('should return warning for author-mismatch', () => {
    expect(getFlagSeverity('author-mismatch')).toBe('warning');
  });

  it('should return warning for publisher-mismatch', () => {
    expect(getFlagSeverity('publisher-mismatch')).toBe('warning');
  });

  it('should return info for suspicious-edition', () => {
    expect(getFlagSeverity('suspicious-edition')).toBe('info');
  });

  it('should return info for edition-conflict', () => {
    expect(getFlagSeverity('edition-conflict')).toBe('info');
  });
});

describe('getFlagDescription', () => {
  it('should return human-readable descriptions', () => {
    const flags: VerificationFlag[] = [
      'author-mismatch',
      'isbn-mismatch',
      'token-coverage-low',
      'suspicious-edition',
      'year-implausible',
      'publisher-mismatch',
      'edition-conflict',
    ];

    for (const flag of flags) {
      const description = getFlagDescription(flag);
      expect(description).toBeTruthy();
      expect(description.length).toBeGreaterThan(10);
    }
  });
});
