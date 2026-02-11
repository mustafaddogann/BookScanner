/**
 * Title Match Fallback Tests
 *
 * Tests for title-only author fallback when normal resolution returns REJECT.
 */

import {
  normalizeTitle,
  getTitleTokens,
  isTitleFullMatch,
  executeTitleMatchFallback,
  joinAuthorsForDisplay,
} from '../titleMatchFallback';
import { OpenLibraryProvider } from '../openLibraryProvider';

// Mock the OpenLibraryProvider
jest.mock('../openLibraryProvider');

describe('Title Match Fallback', () => {
  // ============================================================================
  // Title Normalization Tests
  // ============================================================================
  describe('normalizeTitle', () => {
    it('should uppercase and strip punctuation', () => {
      expect(normalizeTitle('The Shining')).toBe('THE SHINING');
      expect(normalizeTitle("The Girl's Guide")).toBe('THE GIRL S GUIDE');
      expect(normalizeTitle('Gone, Girl')).toBe('GONE GIRL');
    });

    it('should collapse whitespace', () => {
      expect(normalizeTitle('The    Shining')).toBe('THE SHINING');
      expect(normalizeTitle('  The  Shining  ')).toBe('THE SHINING');
    });

    it('should handle empty input', () => {
      expect(normalizeTitle('')).toBe('');
      expect(normalizeTitle('   ')).toBe('');
    });
  });

  describe('getTitleTokens', () => {
    it('should return tokens without stopwords', () => {
      const tokens = getTitleTokens('The Shining');
      expect(tokens.has('SHINING')).toBe(true);
      expect(tokens.has('THE')).toBe(false); // Stopword removed
    });

    it('should handle titles with multiple stopwords', () => {
      const tokens = getTitleTokens('A Tale of Two Cities');
      expect(tokens.has('TALE')).toBe(true);
      expect(tokens.has('TWO')).toBe(true);
      expect(tokens.has('CITIES')).toBe(true);
      expect(tokens.has('A')).toBe(false);
      expect(tokens.has('OF')).toBe(false);
    });

    it('should handle empty input', () => {
      const tokens = getTitleTokens('');
      expect(tokens.size).toBe(0);
    });
  });

  // ============================================================================
  // Title Full Match Tests
  // ============================================================================
  describe('isTitleFullMatch', () => {
    it('should match identical titles', () => {
      expect(isTitleFullMatch('The Shining', 'The Shining')).toBe(true);
      expect(isTitleFullMatch('THE SHINING', 'the shining')).toBe(true);
    });

    it('should match titles with different punctuation', () => {
      expect(isTitleFullMatch('The Shining', 'The Shining!')).toBe(true);
      expect(isTitleFullMatch('Gone, Girl', 'Gone Girl')).toBe(true);
      // Note: Possessive forms create different tokens (GIRL S vs GIRLS)
      // This is intentional - they could be different books
    });

    it('should match titles differing only by stopwords', () => {
      expect(isTitleFullMatch('The Shining', 'Shining')).toBe(true);
      expect(isTitleFullMatch('A Tale of Two Cities', 'Tale Two Cities')).toBe(true);
    });

    it('should NOT match completely different titles', () => {
      expect(isTitleFullMatch('The Shining', 'The Stand')).toBe(false);
      expect(isTitleFullMatch('Gone Girl', 'Girl on the Train')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isTitleFullMatch('', '')).toBe(false);
      expect(isTitleFullMatch('The', 'A')).toBe(false); // All stopwords
    });
  });

  // ============================================================================
  // Fallback Execution Tests (with mocked API)
  // ============================================================================
  describe('executeTitleMatchFallback', () => {
    let mockProvider: jest.Mocked<OpenLibraryProvider>;

    beforeEach(() => {
      mockProvider = new OpenLibraryProvider() as jest.Mocked<OpenLibraryProvider>;
      jest.clearAllMocks();
    });

    it('should return suggest when full title match exists', async () => {
      mockProvider.searchByText = jest.fn().mockResolvedValue([
        {
          title: 'The Shining',
          authors: ['Stephen King'],
          source: 'openLibrary' as const,
          sourceId: 'OL123',
        },
      ]);

      const result = await executeTitleMatchFallback('The Shining', null, mockProvider);

      expect(result.triggered).toBe(true);
      expect(result.decision).toBe('suggest');
      expect(result.suggestedTitle).toBe('The Shining');
      expect(result.suggestedAuthor).toBe('Stephen King');
      expect(result.confidence).toBeGreaterThanOrEqual(0.65);
      expect(result.reason).toContain('title_full_match_author_fallback');
    });

    it('should return lower confidence for multiple full matches', async () => {
      mockProvider.searchByText = jest.fn().mockResolvedValue([
        {
          title: 'The Girl',
          authors: ['Author One'],
          source: 'openLibrary' as const,
          sourceId: 'OL123',
        },
        {
          title: 'The Girl',
          authors: ['Author Two'],
          source: 'openLibrary' as const,
          sourceId: 'OL456',
        },
      ]);

      const result = await executeTitleMatchFallback('The Girl', null, mockProvider);

      expect(result.triggered).toBe(true);
      expect(result.decision).toBe('suggest');
      expect(result.confidence).toBeLessThanOrEqual(0.60);
      expect(result.reason).toContain('title_full_match_multiple_candidates');
    });

    it('should remain not triggered when no full match results', async () => {
      mockProvider.searchByText = jest.fn().mockResolvedValue([
        {
          title: 'The Shining Light', // Different from query
          authors: ['Someone Else'],
          source: 'openLibrary' as const,
          sourceId: 'OL123',
        },
      ]);

      const result = await executeTitleMatchFallback('The Shining', null, mockProvider);

      expect(result.triggered).toBe(false);
      expect(result.decision).toBeNull();
      expect(result.reason).toBe('no_full_match_results');
    });

    it('should remain not triggered when no API results', async () => {
      mockProvider.searchByText = jest.fn().mockResolvedValue([]);

      const result = await executeTitleMatchFallback('Nonexistent Book', null, mockProvider);

      expect(result.triggered).toBe(false);
      expect(result.decision).toBeNull();
      expect(result.reason).toBe('no_api_results');
    });

    it('should detect OCR author conflict', async () => {
      mockProvider.searchByText = jest.fn().mockResolvedValue([
        {
          title: 'The Shining',
          authors: ['Stephen King'],
          source: 'openLibrary' as const,
          sourceId: 'OL123',
        },
      ]);

      // OCR has different author
      const result = await executeTitleMatchFallback('The Shining', 'JOHN GRISHAM', mockProvider);

      expect(result.triggered).toBe(true);
      expect(result.debug.ocrAuthorConflicts).toBe(true);
      expect(result.confidence).toBeLessThan(0.75); // Lower due to conflict
      expect(result.reason).toContain('ocr_author_conflicts_api_author');
    });

    it('should NOT detect conflict when OCR author matches API', async () => {
      mockProvider.searchByText = jest.fn().mockResolvedValue([
        {
          title: 'The Shining',
          authors: ['Stephen King'],
          source: 'openLibrary' as const,
          sourceId: 'OL123',
        },
      ]);

      const result = await executeTitleMatchFallback('The Shining', 'STEPHEN KING', mockProvider);

      expect(result.triggered).toBe(true);
      expect(result.debug.ocrAuthorConflicts).toBe(false);
    });

    it('should handle missing title', async () => {
      const result = await executeTitleMatchFallback(null, null, mockProvider);

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('no_title_for_fallback');
    });

    it('should handle API error gracefully', async () => {
      mockProvider.searchByText = jest.fn().mockRejectedValue(new Error('Network error'));

      const result = await executeTitleMatchFallback('The Shining', null, mockProvider);

      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('fallback_search_error');
    });
  });

  // ============================================================================
  // Helper Function Tests
  // ============================================================================
  describe('joinAuthorsForDisplay', () => {
    it('should handle empty array', () => {
      expect(joinAuthorsForDisplay([])).toBe('');
      expect(joinAuthorsForDisplay(undefined)).toBe('');
    });

    it('should handle single author', () => {
      expect(joinAuthorsForDisplay(['Stephen King'])).toBe('Stephen King');
    });

    it('should handle two authors', () => {
      expect(joinAuthorsForDisplay(['Author One', 'Author Two'])).toBe('Author One and Author Two');
    });

    it('should handle three+ authors with Oxford comma', () => {
      expect(joinAuthorsForDisplay(['A', 'B', 'C'])).toBe('A, B, and C');
    });
  });
});
