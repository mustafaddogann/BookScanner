/**
 * Line Classification Tests
 *
 * Fixture-based tests representing failure classes, not specific titles.
 * Each fixture tests a general pattern that could apply to many books.
 */

import {
  normalizeForMatch,
  tokens,
  alphaRatio,
  wordCount,
  editDistance,
  isSimilarWithinTolerance,
  isPriceLikeLine,
  isFragmentLine,
  isPersonLikeLine,
  isOrgLikeLine,
  orgLikePenalty,
  isExactImprintLine,
  containsImprintToken,
  isBadgeContext,
  getExcludedBadgeIndices,
  isTitleLikeLine,
  isTitleBridgeStopword,
  classifyLines,
} from '../lineClassification';

// ============================================================================
// Normalization Layer Tests
// ============================================================================

describe('Normalization Layer', () => {
  describe('normalizeForMatch', () => {
    it('should uppercase and trim', () => {
      expect(normalizeForMatch('  Hello World  ')).toBe('HELLO WORLD');
    });

    it('should replace punctuation with spaces', () => {
      expect(normalizeForMatch('Hello-World')).toBe('HELLO WORLD');
      expect(normalizeForMatch("John's Book")).toBe('JOHN S BOOK');
    });

    it('should collapse whitespace', () => {
      expect(normalizeForMatch('Hello   World')).toBe('HELLO WORLD');
    });

    it('should strip diacritics', () => {
      expect(normalizeForMatch('Café')).toBe('CAFE');
      expect(normalizeForMatch('naïve')).toBe('NAIVE');
    });

    it('should handle empty input', () => {
      expect(normalizeForMatch('')).toBe('');
      expect(normalizeForMatch(null as any)).toBe('');
    });
  });

  describe('tokens', () => {
    it('should split into normalized tokens', () => {
      expect(tokens('Hello World')).toEqual(['HELLO', 'WORLD']);
    });

    it('should filter empty tokens', () => {
      expect(tokens('  Hello   World  ')).toEqual(['HELLO', 'WORLD']);
    });
  });

  describe('alphaRatio', () => {
    it('should calculate ratio of letters', () => {
      expect(alphaRatio('ABC')).toBe(1);
      expect(alphaRatio('A1B')).toBeCloseTo(0.667, 2);
      expect(alphaRatio('123')).toBe(0);
    });
  });

  describe('wordCount', () => {
    it('should count words', () => {
      expect(wordCount('Hello World')).toBe(2);
      expect(wordCount('One')).toBe(1);
      expect(wordCount('')).toBe(0);
    });
  });
});

// ============================================================================
// Edit Distance (Typo Tolerance)
// ============================================================================

describe('Edit Distance', () => {
  describe('editDistance', () => {
    it('should return 0 for identical strings', () => {
      expect(editDistance('HELLO', 'HELLO')).toBe(0);
    });

    it('should detect single character changes', () => {
      expect(editDistance('BESTSELLER', 'BESTSELLAR')).toBe(1); // OCR typo
      expect(editDistance('BESTSELLER', 'BESTSELER')).toBe(1);  // Missing letter
    });

    it('should detect insertions', () => {
      expect(editDistance('HELLO', 'HELLLO')).toBe(1);
    });
  });

  describe('isSimilarWithinTolerance', () => {
    it('should match exact strings', () => {
      expect(isSimilarWithinTolerance('BESTSELLER', 'bestseller')).toBe(true);
    });

    it('should match with 1-char OCR error', () => {
      expect(isSimilarWithinTolerance('BESTSELLER', 'BESTSELLAR')).toBe(true);
      expect(isSimilarWithinTolerance('BESTSELLER', 'BESTSELER')).toBe(true);
    });

    it('should NOT match strings that differ by more than tolerance', () => {
      expect(isSimilarWithinTolerance('BESTSELLER', 'BESTSELAR')).toBe(false); // 2 changes
    });

    it('should NOT apply fuzzy match to long strings', () => {
      // This prevents matching unrelated long words
      expect(isSimilarWithinTolerance('INTERNATIONAL', 'INTERNATIONEL')).toBe(false);
    });
  });
});

// ============================================================================
// CLASS A: Marketing/Badge Detection
// ============================================================================

describe('Class A: Marketing/Badge Detection', () => {
  describe('isPriceLikeLine', () => {
    it('should detect price patterns', () => {
      expect(isPriceLikeLine('$9.99')).toBe(true);
      expect(isPriceLikeLine('US$14.95')).toBe(true);
      expect(isPriceLikeLine('CAN $19.99')).toBe(true);
      expect(isPriceLikeLine('£12.99')).toBe(true);
      expect(isPriceLikeLine('14.95')).toBe(true);
    });

    it('should NOT flag non-prices', () => {
      expect(isPriceLikeLine('THE GUARDIANS')).toBe(false);
      expect(isPriceLikeLine('JOHN GRISHAM')).toBe(false);
    });
  });

  describe('isBadgeContext - structure-based detection', () => {
    it('should detect standalone BESTSELLER', () => {
      const lines = ['JOHN GRISHAM', 'BESTSELLER', 'THE GUARDIANS'];
      const result = isBadgeContext(1, lines);
      expect(result.isBadge).toBe(true);
      expect(result.reason).toContain('standalone_badge');
    });

    it('should detect badge split across lines (entity + qualifier)', () => {
      const lines = ['NEW YORK TIMES', 'BESTSELLER', 'JOHN GRISHAM'];

      // Line 0 should be detected as badge entity with adjacent qualifier
      const result0 = isBadgeContext(0, lines);
      expect(result0.isBadge).toBe(true);
      expect(result0.relatedIndices).toContain(1);

      // Line 1 should be detected as standalone badge
      const result1 = isBadgeContext(1, lines);
      expect(result1.isBadge).toBe(true);
    });

    it('should detect USA TODAY + bestseller pattern', () => {
      const lines = ['USA TODAY', 'BESTSELLING', 'AUTHOR NAME'];
      const result = isBadgeContext(0, lines);
      expect(result.isBadge).toBe(true);
    });

    it('should detect badge with 1-char OCR error IN CONTEXT', () => {
      // "BESTSELLAR" with typo adjacent to NYT should be caught
      const lines = ['NEW YORK TIMES', 'BESTSELLAR', 'THE TITLE'];
      const result = isBadgeContext(0, lines);
      expect(result.isBadge).toBe(true);
      // The typo-tolerant match should catch the adjacent typo'd bestseller
      expect(result.relatedIndices).toContain(1);
    });

    it('should NOT apply typo tolerance to standalone lines', () => {
      // A standalone "BESTSELLAR" without badge context should NOT be auto-caught
      const lines = ['THE TITLE', 'BESTSELLAR', 'AUTHOR NAME'];
      // Line 1 is not adjacent to a badge entity, so typo tolerance doesn't apply
      const result = isBadgeContext(1, lines);
      // Without "NEW YORK TIMES" nearby, "BESTSELLAR" might not be caught
      // This tests that typo tolerance is CONTEXT-LIMITED
      expect(result.confidence).toBeLessThan(0.9);
    });

    it('should detect #1 with adjacent bestseller', () => {
      const lines = ['#1', 'BESTSELLER', 'AUTHOR'];
      const result = isBadgeContext(0, lines);
      expect(result.isBadge).toBe(true);
    });

    it('should NOT flag author names as badges', () => {
      const lines = ['JOHN GRISHAM', 'THE GUARDIANS'];
      const result = isBadgeContext(0, lines);
      expect(result.isBadge).toBe(false);
    });
  });

  describe('getExcludedBadgeIndices', () => {
    it('should return all badge-related indices', () => {
      const lines = ['DELL', '*1', 'NEW YORK TIMES', 'BESTSELLER', 'JOHN GRISHAM', 'THE GUARDIANS'];
      const indices = getExcludedBadgeIndices(lines);

      // *1, NEW YORK TIMES, BESTSELLER should be badges
      expect(indices.has(2)).toBe(true); // NEW YORK TIMES
      expect(indices.has(3)).toBe(true); // BESTSELLER
      expect(indices.has(4)).toBe(false); // JOHN GRISHAM
      expect(indices.has(5)).toBe(false); // THE GUARDIANS
    });
  });
});

// ============================================================================
// CLASS B: Imprint/Publisher Detection
// ============================================================================

describe('Class B: Imprint/Publisher Detection', () => {
  describe('isExactImprintLine', () => {
    it('should match exact single-line imprints', () => {
      expect(isExactImprintLine('ZEBRA')).toBe(true);
      expect(isExactImprintLine('Zebra')).toBe(true); // Case insensitive
      expect(isExactImprintLine('BANTAM')).toBe(true);
      expect(isExactImprintLine('DELL')).toBe(true);
    });

    it('should NOT match imprint as part of longer line', () => {
      expect(isExactImprintLine('ZEBRA BOOKS')).toBe(false);
      expect(isExactImprintLine('BANTAM DELL')).toBe(false);
    });

    it('should NOT match non-imprints', () => {
      expect(isExactImprintLine('THE GUARDIANS')).toBe(false);
      expect(isExactImprintLine('JOHN GRISHAM')).toBe(false);
    });
  });

  describe('containsImprintToken', () => {
    it('should detect imprint tokens in longer lines', () => {
      expect(containsImprintToken('BANTAM BOOKS SPECIAL')).toBe(true);
    });

    it('should NOT flag lines without imprint tokens', () => {
      expect(containsImprintToken('THE GUARDIANS')).toBe(false);
    });
  });
});

// ============================================================================
// CLASS C: OCR Fragmentation and Composition
// ============================================================================

describe('Class C: OCR Fragmentation and Composition', () => {
  describe('isFragmentLine', () => {
    it('should detect very short lines', () => {
      expect(isFragmentLine('XY')).toBe(true);
      expect(isFragmentLine('A')).toBe(true);
      expect(isFragmentLine('')).toBe(true);
    });

    it('should detect single short token', () => {
      expect(isFragmentLine('ST')).toBe(true);
    });

    it('should detect low alpha ratio short lines', () => {
      expect(isFragmentLine('$19')).toBe(true);
      expect(isFragmentLine('123')).toBe(true);
    });

    it('should NOT flag real content', () => {
      expect(isFragmentLine('THE')).toBe(false); // 3 chars, title stopword
      expect(isFragmentLine('GUARDIANS')).toBe(false);
    });
  });

  describe('isPersonLikeLine', () => {
    it('should detect all-caps author names', () => {
      expect(isPersonLikeLine('JOHN GRISHAM')).toBe(true);
      expect(isPersonLikeLine('LISA CHILDS')).toBe(true);
      expect(isPersonLikeLine('MARY HIGGINS CLARK')).toBe(true);
    });

    it('should detect title-case author names', () => {
      expect(isPersonLikeLine('Patricia Wentworth')).toBe(true);
      expect(isPersonLikeLine('John Smith')).toBe(true);
    });

    it('should require 2-4 words', () => {
      expect(isPersonLikeLine('GRISHAM')).toBe(false); // Single word
      expect(isPersonLikeLine('John James Mary Sue Smith')).toBe(false); // 5 words
    });

    it('should NOT flag org-like lines', () => {
      expect(isPersonLikeLine('Random House Press')).toBe(false);
      expect(isPersonLikeLine('NEW YORK TIMES')).toBe(false);
    });

    it('should NOT flag titles', () => {
      expect(isPersonLikeLine('THE GUARDIANS')).toBe(false);
      expect(isPersonLikeLine('GONE GIRL')).toBe(false);
    });
  });

  describe('isTitleBridgeStopword', () => {
    it('should detect title bridge stopwords', () => {
      expect(isTitleBridgeStopword('THE')).toBe(true);
      expect(isTitleBridgeStopword('A')).toBe(true);
      expect(isTitleBridgeStopword('OF')).toBe(true);
      expect(isTitleBridgeStopword('IN')).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(isTitleBridgeStopword('the')).toBe(true);
      expect(isTitleBridgeStopword('The')).toBe(true);
    });

    it('should NOT flag non-stopwords', () => {
      expect(isTitleBridgeStopword('GUARDIANS')).toBe(false);
      expect(isTitleBridgeStopword('JOHN')).toBe(false);
    });
  });

  describe('isTitleLikeLine', () => {
    it('should accept title-like lines', () => {
      expect(isTitleLikeLine('THE GUARDIANS')).toBe(true);
      expect(isTitleLikeLine('POISON IN THE PEN')).toBe(true);
    });

    it('should reject prices', () => {
      expect(isTitleLikeLine('$9.99')).toBe(false);
    });

    it('should reject fragments', () => {
      expect(isTitleLikeLine('XY')).toBe(false);
    });

    it('should reject exact imprints', () => {
      expect(isTitleLikeLine('ZEBRA')).toBe(false);
    });
  });
});

// ============================================================================
// CLASS D: Avoiding Cascading Errors
// ============================================================================

describe('Class D: Avoiding Cascading Errors', () => {
  describe('isOrgLikeLine', () => {
    it('should detect org markers', () => {
      expect(isOrgLikeLine('Random House Press')).toBe(true);
      expect(isOrgLikeLine('Publishing Inc')).toBe(true);
      expect(isOrgLikeLine('NEW YORK TIMES')).toBe(true);
    });

    it('should NOT flag person names', () => {
      expect(isOrgLikeLine('JOHN GRISHAM')).toBe(false);
      expect(isOrgLikeLine('Patricia Wentworth')).toBe(false);
    });
  });

  describe('orgLikePenalty', () => {
    it('should return 0 for non-org lines', () => {
      expect(orgLikePenalty('JOHN GRISHAM')).toBe(0);
    });

    it('should return penalty for org markers', () => {
      expect(orgLikePenalty('Random House Press')).toBeGreaterThan(0);
      expect(orgLikePenalty('TIMES')).toBeGreaterThan(0);
    });

    it('should return lower penalty for single marker in longer line', () => {
      const singlePenalty = orgLikePenalty('TIMES');
      const longerPenalty = orgLikePenalty('THE TIMES NEWSPAPER STORY');
      expect(longerPenalty).toBeLessThan(singlePenalty);
    });
  });

  describe('classifyLines', () => {
    it('should provide complete classification for all lines', () => {
      const lines = ['$9.99', 'ZEBRA', 'NEW YORK TIMES', 'BESTSELLER', 'JOHN GRISHAM', 'THE GUARDIANS'];
      const results = classifyLines(lines);

      expect(results.length).toBe(6);

      // Price should be excluded
      expect(results[0].isExcluded).toBe(true);
      expect(results[0].exclusionReason).toContain('price');

      // ZEBRA (exact imprint) - fragment detection
      expect(results[1].isExcluded).toBe(true);

      // Badges should be excluded
      expect(results[2].isExcluded).toBe(true);
      expect(results[2].exclusionReason).toContain('badge');
      expect(results[3].isExcluded).toBe(true);

      // Author should NOT be excluded and have high person score
      expect(results[4].isExcluded).toBe(false);
      expect(results[4].scores?.personLikeness).toBeGreaterThan(0.5);

      // Title should NOT be excluded and have high title score
      expect(results[5].isExcluded).toBe(false);
      expect(results[5].scores?.titleLikeness).toBeGreaterThan(0.5);
    });

    it('should correctly classify split title lines', () => {
      const lines = ['THE', 'BURIED', 'LISA CHILDS'];
      const results = classifyLines(lines);

      // "THE" is a stopword but not excluded (bridge for titles)
      expect(results[0].isExcluded).toBe(false);

      // "BURIED" should be title-like
      expect(results[1].isExcluded).toBe(false);
      expect(results[1].scores?.titleLikeness).toBeGreaterThan(0);

      // "LISA CHILDS" should be person-like
      expect(results[2].isExcluded).toBe(false);
      expect(results[2].scores?.personLikeness).toBeGreaterThan(0.5);
    });
  });
});

// ============================================================================
// General Fixture Tests
// ============================================================================

describe('General Fixtures', () => {
  describe('Fixture: Badge split across lines + bestseller token', () => {
    const lines = ['DELL', 'NEW YORK TIMES', 'BESTSELLING', 'JOHN SMITH', 'THE LOST CITY'];
    const classifications = classifyLines(lines);

    it('should exclude badge lines', () => {
      // NEW YORK TIMES
      expect(classifications[1].isExcluded).toBe(true);
      // BESTSELLING
      expect(classifications[2].isExcluded).toBe(true);
    });

    it('should NOT exclude author or title', () => {
      expect(classifications[3].isExcluded).toBe(false); // JOHN SMITH (author)
      expect(classifications[4].isExcluded).toBe(false); // THE LOST CITY (title)
    });
  });

  describe('Fixture: Badge with 1-char OCR error in context', () => {
    // "BESTSELLAR" has 1-char typo but is adjacent to NYT
    const lines = ['NEW YORK TIMES', 'BESTSELLAR', 'JOHN SMITH'];
    const badgeIndices = getExcludedBadgeIndices(lines);

    it('should detect typo in badge context', () => {
      expect(badgeIndices.has(0)).toBe(true); // NYT
      // The typo-tolerant matching should catch BESTSELLAR when adjacent to NYT
      expect(badgeIndices.has(1)).toBe(true);
    });
  });

  describe('Fixture: Standalone imprint line', () => {
    const lines = ['ZEBRA', 'THE BURIED', 'LISA CHILDS'];
    const classifications = classifyLines(lines);

    it('should exclude exact imprint', () => {
      expect(classifications[0].isExcluded).toBe(true);
    });

    it('should keep title and author', () => {
      expect(classifications[1].isExcluded).toBe(false);
      expect(classifications[2].isExcluded).toBe(false);
    });
  });

  describe('Fixture: Price line', () => {
    const lines = ['$9.99', 'THE GUARDIANS', 'JOHN GRISHAM'];
    const classifications = classifyLines(lines);

    it('should exclude price', () => {
      expect(classifications[0].isExcluded).toBe(true);
      expect(classifications[0].exclusionReason).toContain('price');
    });
  });

  describe('Fixture: Title split across stopword bridge', () => {
    const lines = ['THE', 'BURIED', 'LISA CHILDS'];

    it('should identify THE as bridge stopword', () => {
      expect(isTitleBridgeStopword('THE')).toBe(true);
    });

    it('should NOT exclude stopword line', () => {
      const classifications = classifyLines(lines);
      expect(classifications[0].isExcluded).toBe(false);
    });
  });

  describe('Fixture: All-caps author', () => {
    const lines = ['THE GUARDIANS', 'JOHN GRISHAM'];
    const classifications = classifyLines(lines);

    it('should score JOHN GRISHAM as person-like', () => {
      expect(classifications[1].scores?.personLikeness).toBeGreaterThan(0.6);
    });

    it('should score THE GUARDIANS as title-like, not person-like', () => {
      expect(classifications[0].scores?.titleLikeness).toBeGreaterThan(0.5);
      expect(classifications[0].scores?.personLikeness).toBeLessThan(0.5);
    });
  });
});
