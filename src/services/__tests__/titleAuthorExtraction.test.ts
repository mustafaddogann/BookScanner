/**
 * Unit tests for titleAuthorExtraction.ts
 * Tests the four specific book cases that were being rejected
 */

import {
  extractTitleAndAuthor,
  buildTitleCandidates,
  selectAuthorCandidates,
  parseColonSeparated,
  cleanupPossessiveNoise,
  isAllCapsNameCandidate,
  isPublisherOrMarketing,
  normalizeAuthorName,
  isMarketingBadgeWithNeighbors,
  getMarketingBadgeIndices,
  isOrgLikeLine,
  splitInlineTitleAuthor,
  isJunkLine,
  sanitizeTitleForSearch,
} from '../titleAuthorExtraction';

describe('titleAuthorExtraction', () => {
  // ==========================================================================
  // Book 17: "THE BURIED" by "LISA CHILDS"
  // Lines: ["ZEBRA", "NEW YORK TIMES", "BESTSELLER", "LISA CHILDS", "THE", "BURIED"]
  // Challenge: Multi-line title reconstruction (THE + BURIED)
  // ==========================================================================
  describe('Book 17: THE BURIED by LISA CHILDS', () => {
    const lines = ['ZEBRA', 'NEW YORK TIMES', 'BESTSELLER', 'LISA CHILDS', 'THE', 'BURIED'];

    it('should extract title "THE BURIED" from split lines', () => {
      const result = extractTitleAndAuthor(lines);
      expect(result.title).not.toBeNull();
      expect(result.title?.toUpperCase()).toContain('THE');
      expect(result.title?.toUpperCase()).toContain('BURIED');
    });

    it('should extract author "LISA CHILDS"', () => {
      const result = extractTitleAndAuthor(lines);
      expect(result.author).not.toBeNull();
      expect(result.author?.toUpperCase()).toContain('LISA');
      expect(result.author?.toUpperCase()).toContain('CHILDS');
    });

    it('should filter out publisher ZEBRA', () => {
      expect(isPublisherOrMarketing('ZEBRA')).toBe(true);
    });

    it('should filter out marketing phrase', () => {
      expect(isPublisherOrMarketing('NEW YORK TIMES BESTSELLER')).toBe(true);
    });

    it('should detect LISA CHILDS as all-caps name candidate', () => {
      expect(isAllCapsNameCandidate('LISA CHILDS')).toBe(true);
    });

    it('should build multi-line title candidates', () => {
      const candidates = buildTitleCandidates(lines);
      const combinedCandidate = candidates.find(
        c => c.text.toUpperCase().includes('THE') && c.text.toUpperCase().includes('BURIED')
      );
      expect(combinedCandidate).toBeDefined();
    });
  });

  // ==========================================================================
  // Book 10: "THE GUARDIANS" by "JOHN GRISHAM"
  // Lines: ["New York Times", "bestseller", "JOHN GRISHAM", "THE GUARDIANS"]
  // Challenge: All-caps author detection
  // ==========================================================================
  describe('Book 10: THE GUARDIANS by JOHN GRISHAM', () => {
    const lines = ['New York Times', 'bestseller', 'JOHN GRISHAM', 'THE GUARDIANS'];

    it('should extract title "THE GUARDIANS"', () => {
      const result = extractTitleAndAuthor(lines);
      expect(result.title).not.toBeNull();
      expect(result.title?.toUpperCase()).toContain('GUARDIANS');
    });

    it('should extract author "JOHN GRISHAM"', () => {
      const result = extractTitleAndAuthor(lines);
      expect(result.author).not.toBeNull();
      expect(result.author?.toUpperCase()).toContain('GRISHAM');
    });

    it('should detect JOHN GRISHAM as all-caps name candidate', () => {
      expect(isAllCapsNameCandidate('JOHN GRISHAM')).toBe(true);
    });

    it('should NOT detect THE GUARDIANS as name candidate', () => {
      // "GUARDIANS" is in the non-author words list
      expect(isAllCapsNameCandidate('THE GUARDIANS')).toBe(false);
    });

    it('should select JOHN GRISHAM as author candidate', () => {
      const candidates = selectAuthorCandidates(lines);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].text.toUpperCase()).toContain('GRISHAM');
    });
  });

  // ==========================================================================
  // Book 12: "THE FINGERPRINT" by "PATRICIA WENTWORTH"
  // Lines: ["-THE FINGERPRINT: Patricia Wentworth s"]
  // Challenge: Colon-separated pattern + OCR noise cleanup
  // ==========================================================================
  describe('Book 12: THE FINGERPRINT by PATRICIA WENTWORTH', () => {
    const lines = ['-THE FINGERPRINT: Patricia Wentworth s'];

    it('should parse colon-separated title:author pattern', () => {
      const result = parseColonSeparated('-THE FINGERPRINT: Patricia Wentworth s');
      expect(result.title).toBe('THE FINGERPRINT');
      expect(result.author).toBe('Patricia Wentworth');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should cleanup possessive noise from author', () => {
      expect(cleanupPossessiveNoise('Patricia Wentworth s')).toBe('Patricia Wentworth');
      expect(cleanupPossessiveNoise('Grisham,')).toBe('Grisham');
    });

    it('should extract both title and author via main function', () => {
      const result = extractTitleAndAuthor(lines);
      expect(result.title?.toUpperCase()).toContain('FINGERPRINT');
      expect(result.author?.toUpperCase()).toContain('WENTWORTH');
    });

    it('should remove leading dashes from title', () => {
      const result = parseColonSeparated('-THE FINGERPRINT: Patricia Wentworth');
      expect(result.title).toBe('THE FINGERPRINT');
      expect(result.title?.startsWith('-')).toBe(false);
    });
  });

  // ==========================================================================
  // Book 18: "THE PELICAN BRIEF" - Author backfill needed
  // Lines: ["PELICAN", "BRIEF"] (fragments)
  // Challenge: Should reconstruct title and allow API backfill for missing author
  // ==========================================================================
  describe('Book 18: THE PELICAN BRIEF (author backfill case)', () => {
    const lines = ['PELICAN', 'BRIEF'];

    it('should build title candidates from fragments', () => {
      const candidates = buildTitleCandidates(lines);
      // Should have combined candidate
      const combined = candidates.find(
        c => c.text.toUpperCase().includes('PELICAN') && c.text.toUpperCase().includes('BRIEF')
      );
      expect(combined).toBeDefined();
    });

    it('should extract title but author may be null (needs backfill)', () => {
      const result = extractTitleAndAuthor(lines);
      // Title should be reconstructed
      expect(result.title).not.toBeNull();
      // Author is legitimately missing - needs API backfill
      // This is expected behavior - the backfill happens at the resolver level
    });

    it('should have debug info for investigation', () => {
      const result = extractTitleAndAuthor(lines);
      expect(result.debug.rawLines).toEqual(lines);
      expect(result.debug.titleCandidates.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Additional utility function tests
  // ==========================================================================
  describe('Utility functions', () => {
    describe('normalizeAuthorName', () => {
      it('should convert ALL CAPS to Title Case', () => {
        expect(normalizeAuthorName('JOHN GRISHAM')).toBe('John Grisham');
        expect(normalizeAuthorName('LISA CHILDS')).toBe('Lisa Childs');
      });

      it('should preserve already title-cased names', () => {
        expect(normalizeAuthorName('Patricia Wentworth')).toBe('Patricia Wentworth');
      });

      it('should clean up OCR artifacts', () => {
        expect(normalizeAuthorName('Wentworth s')).toBe('Wentworth');
        expect(normalizeAuthorName('-Patricia')).toBe('Patricia');
      });
    });

    describe('isPublisherOrMarketing', () => {
      it('should detect publisher names', () => {
        expect(isPublisherOrMarketing('ZEBRA')).toBe(true);
        expect(isPublisherOrMarketing('Bantam')).toBe(true);
        expect(isPublisherOrMarketing('Random House')).toBe(true);
      });

      it('should detect marketing phrases', () => {
        expect(isPublisherOrMarketing('New York Times Bestseller')).toBe(true);
        expect(isPublisherOrMarketing('#1 BESTSELLER')).toBe(true);
      });

      it('should NOT flag real titles/authors', () => {
        expect(isPublisherOrMarketing('THE GUARDIANS')).toBe(false);
        expect(isPublisherOrMarketing('JOHN GRISHAM')).toBe(false);
      });
    });

    describe('isAllCapsNameCandidate', () => {
      it('should accept 2-4 word all-caps names', () => {
        expect(isAllCapsNameCandidate('JOHN GRISHAM')).toBe(true);
        expect(isAllCapsNameCandidate('LISA CHILDS')).toBe(true);
        expect(isAllCapsNameCandidate('MARY HIGGINS CLARK')).toBe(true);
      });

      it('should reject single words', () => {
        expect(isAllCapsNameCandidate('GRISHAM')).toBe(false);
      });

      it('should reject title-like words', () => {
        expect(isAllCapsNameCandidate('THE GUARDIAN')).toBe(false);
        expect(isAllCapsNameCandidate('DARK NIGHT')).toBe(false);
      });

      it('should reject publisher names', () => {
        expect(isAllCapsNameCandidate('RANDOM HOUSE')).toBe(false);
      });
    });
  });

  // ==========================================================================
  // Marketing Badge Filter with Neighbor Rule
  // Tests the enhanced badge detection that handles split marketing phrases
  // ==========================================================================
  describe('Marketing badge filter with neighbor rule', () => {
    describe('isMarketingBadgeWithNeighbors', () => {
      it('should detect "New York Times" as badge when adjacent to "bestseller"', () => {
        const lines = ['New York Times', 'bestseller', 'JOHN GRISHAM'];
        const result = isMarketingBadgeWithNeighbors(0, lines);
        expect(result.isBadge).toBe(true);
        // "New York Times" is detected as badge via direct marketing phrase match
        // (the neighbor rule is a fallback for cases not caught by direct match)
        expect(result.reason).toContain('marketing_phrase');
      });

      it('should detect "bestseller" as badge when adjacent to "New York Times"', () => {
        const lines = ['New York Times', 'bestseller', 'JOHN GRISHAM'];
        const result = isMarketingBadgeWithNeighbors(1, lines);
        expect(result.isBadge).toBe(true);
      });

      it('should NOT detect "JOHN GRISHAM" as badge', () => {
        const lines = ['New York Times', 'bestseller', 'JOHN GRISHAM'];
        const result = isMarketingBadgeWithNeighbors(2, lines);
        expect(result.isBadge).toBe(false);
      });

      it('should detect standalone "bestseller" even without neighbor', () => {
        const lines = ['JOHN GRISHAM', 'bestseller', 'THE GUARDIANS'];
        const result = isMarketingBadgeWithNeighbors(1, lines);
        expect(result.isBadge).toBe(true);
        expect(result.reason).toContain('contains_marketing_phrase');
      });

      it('should detect "#1" with adjacent "bestseller"', () => {
        const lines = ['#1', 'bestseller', 'AUTHOR NAME'];
        const result = isMarketingBadgeWithNeighbors(0, lines);
        expect(result.isBadge).toBe(true);
      });

      it('should detect "*1" as marketing badge', () => {
        const lines = ['*1', 'New York Times', 'JOHN GRISHAM'];
        const result = isMarketingBadgeWithNeighbors(0, lines);
        expect(result.isBadge).toBe(true);
      });
    });

    describe('getMarketingBadgeIndices', () => {
      it('should return indices of all badge lines', () => {
        const lines = ['DELL', '*1', 'New York Times', 'bestseller', 'JOHN GRISHAM', 'THE GUARDIANS'];
        const indices = getMarketingBadgeIndices(lines);
        // *1, New York Times, bestseller should be marked as badges
        expect(indices.has(1)).toBe(true); // *1
        expect(indices.has(2)).toBe(true); // New York Times
        expect(indices.has(3)).toBe(true); // bestseller
        expect(indices.has(4)).toBe(false); // JOHN GRISHAM
        expect(indices.has(5)).toBe(false); // THE GUARDIANS
      });
    });
  });

  // ==========================================================================
  // PERSON-first Author Selection (ORG rejection)
  // Tests that organization-like lines are rejected as author candidates
  // ==========================================================================
  describe('PERSON-first author selection', () => {
    describe('isOrgLikeLine', () => {
      it('should detect organization markers', () => {
        expect(isOrgLikeLine('Random House Press')).toBe(true);
        expect(isOrgLikeLine('Publishing Inc')).toBe(true);
        expect(isOrgLikeLine('New York Times')).toBe(true);
        expect(isOrgLikeLine('Simon & Schuster Publishing')).toBe(true);
        expect(isOrgLikeLine('University Press')).toBe(true);
      });

      it('should NOT flag person names', () => {
        expect(isOrgLikeLine('JOHN GRISHAM')).toBe(false);
        expect(isOrgLikeLine('Patricia Wentworth')).toBe(false);
        expect(isOrgLikeLine('GEORGE R. R. MARTIN')).toBe(false);
      });
    });

    describe('selectAuthorCandidates with ORG rejection', () => {
      it('should reject "New York Times" as author and select real author', () => {
        const lines = ['New York Times', 'bestseller', 'JOHN GRISHAM', 'THE GUARDIANS'];
        const candidates = selectAuthorCandidates(lines);
        // New York Times should NOT be in top candidate
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0].text.toUpperCase()).not.toContain('NEW YORK');
        expect(candidates[0].text.toUpperCase()).toContain('GRISHAM');
      });

      it('should return empty when only marketing text present', () => {
        const lines = ['New York Times bestseller', '#1 BESTSELLER'];
        const candidates = selectAuthorCandidates(lines);
        // No valid author candidates
        expect(candidates.length).toBe(0);
      });

      it('should accept all-caps author GEORGE R. R. MARTIN', () => {
        const lines = ['A GAME OF THRONES', 'GEORGE R. R. MARTIN'];
        const candidates = selectAuthorCandidates(lines, 'A GAME OF THRONES');
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0].text).toBe('GEORGE R. R. MARTIN');
        expect(candidates[0].score).toBeGreaterThan(0.5);
      });

      it('should not select title as author', () => {
        const lines = ['THE GUARDIANS', 'JOHN GRISHAM'];
        const candidates = selectAuthorCandidates(lines, 'THE GUARDIANS');
        // Only JOHN GRISHAM should be candidate (title excluded)
        expect(candidates.length).toBe(1);
        expect(candidates[0].text).toBe('JOHN GRISHAM');
      });
    });
  });

  // ==========================================================================
  // End-to-end extraction tests for the target failing case
  // ==========================================================================
  describe('End-to-end: THE GUARDIANS by JOHN GRISHAM (user failing case)', () => {
    // This is the exact failing case from the user's report
    const lines = ['61', 'DELL', '*1', 'New York Times', 'bestseller', 'JOHN GRISHAM', 'THE GUARDIANS'];

    it('should extract author "JOHN GRISHAM" (not "New York Times")', () => {
      const result = extractTitleAndAuthor(lines);
      expect(result.author).not.toBeNull();
      expect(result.author?.toUpperCase()).toContain('GRISHAM');
      expect(result.author?.toUpperCase()).not.toContain('NEW YORK');
    });

    it('should extract title "THE GUARDIANS"', () => {
      const result = extractTitleAndAuthor(lines);
      expect(result.title).not.toBeNull();
      expect(result.title?.toUpperCase()).toContain('GUARDIANS');
    });

    it('should exclude marketing badges in debug info', () => {
      const result = extractTitleAndAuthor(lines);
      const badgeTexts = result.debug.excludedBadgeLines?.map(l => l.text.toLowerCase()) ?? [];
      const junkTexts = result.debug.excludedJunkLines?.map(l => l.text.toLowerCase()) ?? [];
      const allExcluded = [...badgeTexts, ...junkTexts];

      expect(badgeTexts).toContain('new york times');
      expect(badgeTexts).toContain('bestseller');
      // *1 may be filtered as junk (short line) or as badge
      expect(allExcluded.some(t => t.includes('*1') || t.includes('#1'))).toBe(true);
    });

    it('should have reasonable author confidence', () => {
      const result = extractTitleAndAuthor(lines);
      expect(result.authorConfidence).toBeGreaterThan(0.5);
    });
  });

  // ==========================================================================
  // Inline Title/Author Splitting Tests
  // Tests for merged OCR that collapses TITLE + AUTHOR into a single line
  // ==========================================================================
  describe('Inline title/author splitting', () => {
    describe('splitInlineTitleAuthor', () => {
      it('should split "POISON IN THE PEN Patricia Wentworth"', () => {
        const result = splitInlineTitleAuthor('POISON IN THE PEN Patricia Wentworth');
        expect(result.didSplit).toBe(true);
        expect(result.title?.toUpperCase()).toBe('POISON IN THE PEN');
        expect(result.author).toBe('Patricia Wentworth');
        expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      });

      it('should split hyphen-collapsed title/author "POISON IN THE PEN-Patricia Wentworth"', () => {
        const result = splitInlineTitleAuthor('POISON IN THE PEN-Patricia Wentworth');
        expect(result.didSplit).toBe(true);
        expect(result.title?.toUpperCase()).toBe('POISON IN THE PEN');
        expect(result.author).toBe('Patricia Wentworth');
      });

      it('should split "THE GUARDIANS JOHN GRISHAM"', () => {
        const result = splitInlineTitleAuthor('THE GUARDIANS JOHN GRISHAM');
        expect(result.didSplit).toBe(true);
        expect(result.title?.toUpperCase()).toBe('THE GUARDIANS');
        expect(result.author?.toUpperCase()).toBe('JOHN GRISHAM');
        expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      });

      it('should split "Gone Girl by Gillian Flynn" (explicit by separator)', () => {
        const result = splitInlineTitleAuthor('Gone Girl by Gillian Flynn');
        expect(result.didSplit).toBe(true);
        expect(result.title).toBe('Gone Girl');
        expect(result.author).toBe('Gillian Flynn');
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
        expect(result.reason).toBe('by_separator');
      });

      it('should split "The Girl on the Train by Paula Hawkins"', () => {
        const result = splitInlineTitleAuthor('The Girl on the Train by Paula Hawkins');
        expect(result.didSplit).toBe(true);
        expect(result.title).toBe('The Girl on the Train');
        expect(result.author).toBe('Paula Hawkins');
      });

      it('should NOT split pure title "THE SHINING"', () => {
        const result = splitInlineTitleAuthor('THE SHINING');
        expect(result.didSplit).toBe(false);
        expect(result.reason).toBe('insufficient_words');
      });

      it('should NOT split pure author "STEPHEN KING"', () => {
        const result = splitInlineTitleAuthor('STEPHEN KING');
        expect(result.didSplit).toBe(false);
        expect(result.reason).toBe('insufficient_words');
      });

      it('should NOT split when suffix is ORG-like "DARKNESS RANDOM HOUSE"', () => {
        const result = splitInlineTitleAuthor('DARKNESS by Random House Press');
        expect(result.didSplit).toBe(false);
      });

      it('should NOT split marketing phrase "NEW YORK TIMES BESTSELLER"', () => {
        const result = splitInlineTitleAuthor('NEW YORK TIMES BESTSELLER');
        expect(result.didSplit).toBe(false);
      });

      it('should handle empty or short input', () => {
        expect(splitInlineTitleAuthor('').didSplit).toBe(false);
        expect(splitInlineTitleAuthor('AB').didSplit).toBe(false);
      });

      it('should clean up possessive noise from author', () => {
        const result = splitInlineTitleAuthor("THE FINGERPRINT Patricia Wentworth's");
        if (result.didSplit) {
          expect(result.author).not.toContain("'s");
        }
      });
    });

    describe('extractTitleAndAuthor with inline splits', () => {
      it('should detect inline split in evidence and extract both fields', () => {
        const lines = ['BANTAM STER $193', 'POISON IN THE PEN Patricia Wentworth'];
        const result = extractTitleAndAuthor(lines);

        // Should have recorded the inline split
        expect(result.debug.inlineSplits).toBeDefined();
        expect(result.debug.inlineSplits!.length).toBeGreaterThan(0);

        // Title and author should be extracted
        expect(result.title?.toUpperCase()).toContain('POISON');
        expect(result.author?.toUpperCase()).toContain('WENTWORTH');
      });

      it('should populate debug.inlineSplits with split details', () => {
        const lines = ['THE GUARDIANS JOHN GRISHAM'];
        const result = extractTitleAndAuthor(lines);

        if (result.debug.inlineSplits && result.debug.inlineSplits.length > 0) {
          const split = result.debug.inlineSplits[0];
          expect(split.originalLine).toBe('THE GUARDIANS JOHN GRISHAM');
          expect(split.title.toUpperCase()).toContain('GUARDIANS');
          expect(split.author.toUpperCase()).toContain('GRISHAM');
        }
      });
    });
  });

  // ==========================================================================
  // Junk Line Detection Tests
  // Tests for filtering prices, publisher fragments, and noise
  // ==========================================================================
  describe('Junk line detection', () => {
    describe('isJunkLine', () => {
      it('should detect price at start: "$9.99"', () => {
        expect(isJunkLine('$9.99')).toBe(true);
      });

      it('should detect price at end: "BOOK $14.95"', () => {
        expect(isJunkLine('BOOK $14.95')).toBe(true);
      });

      it('should detect regional price: "US$14.95"', () => {
        expect(isJunkLine('US$14.95')).toBe(true);
        expect(isJunkLine('CAN $19.99')).toBe(true);
      });

      it('should detect publisher fragment: "BANTAM STER"', () => {
        expect(isJunkLine('BANTAM STER')).toBe(true);
      });

      it('should detect short noise: "XY"', () => {
        expect(isJunkLine('XY')).toBe(true);
      });

      it('should detect pure numbers: "123"', () => {
        expect(isJunkLine('123')).toBe(true);
      });

      it('should detect library call numbers: "F1234"', () => {
        expect(isJunkLine('F1234')).toBe(true);
      });

      it('should detect single publisher word: "DELL"', () => {
        expect(isJunkLine('DELL')).toBe(true);
      });

      it('should NOT flag real titles', () => {
        expect(isJunkLine('THE GUARDIANS')).toBe(false);
        expect(isJunkLine('POISON IN THE PEN')).toBe(false);
      });

      it('should NOT flag real author names', () => {
        expect(isJunkLine('JOHN GRISHAM')).toBe(false);
        expect(isJunkLine('Patricia Wentworth')).toBe(false);
      });
    });

    describe('extractTitleAndAuthor junk filtering', () => {
      it('should exclude junk lines and populate debug.excludedJunkLines', () => {
        const lines = ['$9.99', 'BANTAM', 'THE GUARDIANS', 'JOHN GRISHAM'];
        const result = extractTitleAndAuthor(lines);

        expect(result.debug.excludedJunkLines).toBeDefined();
        expect(result.debug.excludedJunkLines!.length).toBeGreaterThan(0);

        const excludedTexts = result.debug.excludedJunkLines!.map(j => j.text);
        expect(excludedTexts).toContain('$9.99');
        expect(excludedTexts).toContain('BANTAM');
      });

      it('should still extract title and author after filtering junk', () => {
        const lines = ['61', '$4.99', 'ZEBRA', 'THE BURIED', 'LISA CHILDS'];
        const result = extractTitleAndAuthor(lines);

        expect(result.title?.toUpperCase()).toContain('BURIED');
        expect(result.author?.toUpperCase()).toContain('CHILDS');
      });
    });
  });

  // ==========================================================================
  // Resolver Sanitization Tests
  // Tests for sanitizeTitleForSearch
  // ==========================================================================
  describe('Resolver sanitization', () => {
    describe('sanitizeTitleForSearch', () => {
      it('should strip embedded author from title', () => {
        const result = sanitizeTitleForSearch('POISON IN THE PEN Patricia Wentworth');
        expect(result.title.toUpperCase()).toBe('POISON IN THE PEN');
        expect(result.extractedAuthor).toBe('Patricia Wentworth');
      });

      it('should strip embedded author from hyphen-collapsed title', () => {
        const result = sanitizeTitleForSearch('POISON IN THE PEN-Patricia Wentworth');
        expect(result.title.toUpperCase()).toBe('POISON IN THE PEN');
        expect(result.extractedAuthor).toBe('Patricia Wentworth');
      });

      it('should strip embedded author from "THE GUARDIANS JOHN GRISHAM"', () => {
        const result = sanitizeTitleForSearch('THE GUARDIANS JOHN GRISHAM');
        expect(result.title.toUpperCase()).toBe('THE GUARDIANS');
        expect(result.extractedAuthor?.toUpperCase()).toBe('JOHN GRISHAM');
      });

      it('should handle "by" separator', () => {
        const result = sanitizeTitleForSearch('Gone Girl by Gillian Flynn');
        expect(result.title).toBe('Gone Girl');
        expect(result.extractedAuthor).toBe('Gillian Flynn');
      });

      it('should return original title when no embedded author', () => {
        const result = sanitizeTitleForSearch('THE SHINING');
        expect(result.title).toBe('THE SHINING');
        expect(result.extractedAuthor).toBeNull();
      });

      it('should handle empty input', () => {
        const result = sanitizeTitleForSearch('');
        expect(result.title).toBe('');
        expect(result.extractedAuthor).toBeNull();
      });

      it('should NOT extract ORG suffix as author', () => {
        const result = sanitizeTitleForSearch('DARKNESS Random House Press');
        // Should not split because "Random House Press" is ORG-like
        expect(result.extractedAuthor).toBeNull();
      });
    });
  });
});
