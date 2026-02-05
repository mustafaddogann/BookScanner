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
});
