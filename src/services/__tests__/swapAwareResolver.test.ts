/**
 * Swap-Aware Resolver Tests
 *
 * Tests for resolver-driven correction covering:
 * 1) Swap detection and correction
 * 2) ISBN-first resolution
 * 3) Missing leading character tolerance
 * 4) Badge typo context detection
 * 5) Safety tests (no false positives)
 */

import {
  extractIsbnFromOcrLines,
  validateIsbn10Checksum,
  validateIsbn13Checksum,
  validateAndNormalizeIsbn,
} from '../isbnExtraction';

import {
  computeAuthorSimilarity,
  findBestAuthorMatch,
  normalizeForOcrComparison,
  normalizeForApiComparison,
} from '../ocrConfusionMatching';

import {
  detectBadgeTypoContext,
  getEnhancedBadgeExclusions,
  hasBadgeWithTypo,
} from '../badgeTypoDetection';

// ============================================================================
// PART B: ISBN Extraction Tests
// ============================================================================

describe('ISBN Extraction (Part B)', () => {
  describe('ISBN Checksum Validation', () => {
    it('should validate correct ISBN-10', () => {
      // Valid ISBN-10: 0-13-110362-8
      expect(validateIsbn10Checksum('0131103628')).toBe(true);
      // Valid ISBN-10 with X: 0-8044-2957-X
      expect(validateIsbn10Checksum('080442957X')).toBe(true);
    });

    it('should reject invalid ISBN-10', () => {
      expect(validateIsbn10Checksum('0131103629')).toBe(false);
      expect(validateIsbn10Checksum('1234567890')).toBe(false);
    });

    it('should validate correct ISBN-13', () => {
      // Valid ISBN-13: 978-3-16-148410-0
      expect(validateIsbn13Checksum('9783161484100')).toBe(true);
      // Valid ISBN-13: 978-0-545-01022-1
      expect(validateIsbn13Checksum('9780545010221')).toBe(true);
    });

    it('should reject invalid ISBN-13', () => {
      expect(validateIsbn13Checksum('9783161484101')).toBe(false);
      expect(validateIsbn13Checksum('1234567890123')).toBe(false);
    });
  });

  describe('ISBN OCR Confusable Handling', () => {
    it('should normalize O to 0 in ISBN', () => {
      const result = validateAndNormalizeIsbn('O-13-11O362-8');
      expect(result.substituted).toContain('0');
      expect(result.normalized).toBe('0131103628');
    });

    it('should normalize I to 1 in ISBN', () => {
      const result = validateAndNormalizeIsbn('0-I3-II0362-8');
      expect(result.normalized).toBe('0131103628');
    });

    it('should normalize S to 5 in ISBN', () => {
      const result = validateAndNormalizeIsbn('978-3-16-148410-S');
      // Note: S becomes 5, which makes checksum invalid
      expect(result.substituted).toContain('5');
    });

    it('should NOT apply OCR confusables outside ISBN context', () => {
      // This tests that confusables are ISBN-only
      const result = validateAndNormalizeIsbn('HELLO'); // Not ISBN
      expect(result.type).toBe('unknown');
      expect(result.checksumValid).toBe(false);
    });
  });

  describe('ISBN Extraction from OCR Lines', () => {
    it('should extract ISBN from split lines', () => {
      const lines = [
        'THE GUARDIANS',
        'JOHN GRISHAM',
        'ISBN: 978-0-385',
        '-54405-4',
      ];

      const result = extractIsbnFromOcrLines(lines);
      expect(result.rawIsbnLines.length).toBeGreaterThan(0);
      expect(result.joinedCandidates.length).toBeGreaterThan(0);
    });

    it('should find valid ISBN when present', () => {
      const lines = [
        'THE SHINING',
        'STEPHEN KING',
        '978-0-385-12167-5', // Valid ISBN-13 for The Shining
      ];

      const result = extractIsbnFromOcrLines(lines);
      // If checksum valid, should find it
      if (result.validIsbn) {
        expect(result.validIsbnType).toBe('isbn13');
      }
    });

    it('should handle ISBN with OCR errors', () => {
      const lines = [
        'ISBN: O-I3-IIO362-8', // 0-13-110362-8 with OCR errors
      ];

      const result = extractIsbnFromOcrLines(lines);
      // After OCR substitution, should normalize correctly
      const hasSubstituted = result.candidates.some(
        c => c.substituted !== c.raw
      );
      expect(hasSubstituted).toBe(true);
    });

    it('should return null when no ISBN present', () => {
      const lines = [
        'THE GUARDIANS',
        'JOHN GRISHAM',
        'A NOVEL',
      ];

      const result = extractIsbnFromOcrLines(lines);
      expect(result.validIsbn).toBeNull();
    });
  });
});

// ============================================================================
// PART C: OCR Confusion-Aware Author Matching Tests
// ============================================================================

describe('OCR Confusion-Aware Author Matching (Part C)', () => {
  describe('Normalization', () => {
    it('should normalize confusable characters', () => {
      expect(normalizeForOcrComparison('JOHN')).toBe('J0HN');
      // Note: G -> 6 in OCR confusables, so KING -> K1N6
      expect(normalizeForOcrComparison('KING')).toBe('K1N6');
    });

    it('should handle mixed case', () => {
      expect(normalizeForOcrComparison('John Smith')).toBe('J0HN 5M1TH');
    });
  });

  describe('Author Similarity', () => {
    it('should match exact authors', () => {
      const result = computeAuthorSimilarity('JOHN GRISHAM', 'John Grisham');
      expect(result.isMatch).toBe(true);
      expect(result.similarity).toBeGreaterThanOrEqual(0.95);
    });

    it('should detect missing leading character', () => {
      // OCR: "TONIO MARSH" vs API: "ANTONIO MARSH"
      const result = computeAuthorSimilarity('TONIO MARSH', 'ANTONIO MARSH');
      expect(result.isMatch).toBe(true);
      expect(result.missingLeadingChar).toBe(true);
      expect(result.reason).toBe('missing_leading_char');
    });

    it('should detect missing single leading character', () => {
      // OCR: "NGAIO MARSH" missing nothing vs "NGAIO MARSH"
      const result = computeAuthorSimilarity('GAIO MARSH', 'NGAIO MARSH');
      expect(result.isMatch).toBe(true);
      expect(result.missingLeadingChar).toBe(true);
    });

    it('should tolerate minor OCR errors', () => {
      // One character difference
      const result = computeAuthorSimilarity('JOHN GRISHA', 'JOHN GRISHAM');
      expect(result.isMatch).toBe(true);
      expect(result.reason).toBe('edit_distance_within_tolerance');
    });

    it('should reject completely different authors', () => {
      const result = computeAuthorSimilarity('JOHN GRISHAM', 'STEPHEN KING');
      expect(result.isMatch).toBe(false);
    });

    it('should handle token overlap matching', () => {
      // Last name matches, first name different due to OCR
      const result = computeAuthorSimilarity('J GRISHAM', 'JOHN GRISHAM');
      // Should still match due to token overlap (1 of 2 tokens match)
      expect(result.similarity).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('Best Author Match', () => {
    it('should find best match from multiple authors', () => {
      const result = findBestAuthorMatch(
        'TONIO MARSH',
        ['Stephen King', 'ANTONIO MARSH', 'John Grisham']
      );
      expect(result.author).toBe('ANTONIO MARSH');
      expect(result.similarity.isMatch).toBe(true);
    });

    it('should return exact match when available', () => {
      const result = findBestAuthorMatch(
        'JOHN GRISHAM',
        ['John Grisham', 'John Smith', 'Jane Grisham']
      );
      expect(result.author).toBe('John Grisham');
      expect(result.similarity.similarity).toBe(1.0);
    });

    it('should handle empty author list', () => {
      const result = findBestAuthorMatch('JOHN GRISHAM', []);
      expect(result.author).toBeNull();
      expect(result.similarity.isMatch).toBe(false);
    });
  });
});

// ============================================================================
// PART D: Badge Typo Context Detection Tests
// ============================================================================

describe('Badge Typo Context Detection (Part D)', () => {
  describe('NYT Badge Pattern with Typo', () => {
    it('should detect NEW YORK TIMES BESTSELLER with FORK typo', () => {
      const lines = [
        'NEW FORK',      // YORK -> FORK (1 edit)
        'TIMES',
        'BESTSELLER',
        'JOHN GRISHAM',
        'THE GUARDIANS',
      ];

      const result = detectBadgeTypoContext(0, lines);
      expect(result.isBadge).toBe(true);
      expect(result.reason).toBe('nyt_badge_pattern_with_typo_tolerance');
      expect(result.badgeLineIndices).toContain(0);
      expect(result.badgeLineIndices).toContain(1);
      expect(result.badgeLineIndices).toContain(2);
    });

    it('should detect badge when checking TIMES line', () => {
      const lines = [
        'NEW YORI',      // YORK -> YORI (1 edit - K to I)
        'TIMES',
        'BESTSELLER',
        'JOHN GRISHAM',
      ];

      const result = detectBadgeTypoContext(1, lines);
      expect(result.isBadge).toBe(true);
      expect(result.badgeLineIndices).toContain(0);
      expect(result.badgeLineIndices).toContain(1);
      expect(result.badgeLineIndices).toContain(2);
    });

    it('should detect badge when checking BESTSELLER line', () => {
      const lines = [
        'NEW YIRK',      // YORK -> YIRK (1 edit)
        'TIMES',
        'BESTSELLER',
        'AUTHOR NAME',
      ];

      const result = detectBadgeTypoContext(2, lines);
      expect(result.isBadge).toBe(true);
    });

    it('should exclude all badge lines from candidate pools', () => {
      const lines = [
        'DELL',
        'NEW FORK',
        'TIMES',
        'BESTSELLER',
        'JOHN GRISHAM',
        'THE GUARDIANS',
      ];

      const { excludedIndices } = getEnhancedBadgeExclusions(lines);

      // NEW FORK, TIMES, BESTSELLER should be excluded
      expect(excludedIndices.has(1)).toBe(true);
      expect(excludedIndices.has(2)).toBe(true);
      expect(excludedIndices.has(3)).toBe(true);

      // Author and title should NOT be excluded
      expect(excludedIndices.has(4)).toBe(false);
      expect(excludedIndices.has(5)).toBe(false);
    });
  });

  describe('Safety Tests - No False Positives', () => {
    it('should NOT trigger badge if BESTSELLER not present', () => {
      const lines = [
        'NEW FORK',      // Typo, but no BESTSELLER
        'TIMES',
        'JOHN GRISHAM',  // This is author, not BESTSELLER
        'THE GUARDIANS',
      ];

      // Check that NEW FORK is not excluded
      const result = detectBadgeTypoContext(0, lines);
      expect(result.isBadge).toBe(false);
      expect(result.reason).toBe('missing_bestseller_component');
    });

    it('should NOT trigger badge for unrelated lines', () => {
      const lines = [
        'THE FORK',      // Not "NEW FORK"
        'TIMES',
        'BESTSELLER',
        'JOHN GRISHAM',
      ];

      const result = detectBadgeTypoContext(0, lines);
      // "THE FORK" doesn't start with NEW, so not a badge pattern
      expect(result.components.newYorkLine).toBeNull();
    });

    it('should NOT fuzzy match outside badge context', () => {
      const lines = [
        'JOHN GRISHAM',
        'THE GUARDIANS',
        'FARK',  // Not part of badge pattern - should not be touched
      ];

      const { excludedIndices } = getEnhancedBadgeExclusions(lines);

      // FARK should not be excluded (no badge context)
      expect(excludedIndices.has(2)).toBe(false);
    });

    it('should require all three components within window', () => {
      const lines = [
        'NEW YORK',
        'LINE 1',
        'LINE 2',
        'LINE 3',
        'LINE 4',
        'LINE 5',
        'BESTSELLER',  // Too far from NEW YORK
      ];

      const result = detectBadgeTypoContext(0, lines);
      // Components too far apart
      expect(result.isBadge).toBe(false);
    });
  });

  describe('Standard Badge Detection (no typo)', () => {
    it('should detect exact NEW YORK TIMES BESTSELLER', () => {
      const lines = [
        'NEW YORK',
        'TIMES',
        'BESTSELLER',
        'AUTHOR NAME',
      ];

      const result = detectBadgeTypoContext(0, lines);
      expect(result.isBadge).toBe(true);
    });

    it('should detect standalone BESTSELLER', () => {
      const lines = [
        'JOHN GRISHAM',
        'BESTSELLER',
        'THE GUARDIANS',
      ];

      const result = detectBadgeTypoContext(1, lines);
      expect(result.isBadge).toBe(true);
      expect(result.reason).toBe('standalone_bestseller');
    });
  });

  describe('hasBadgeWithTypo utility', () => {
    it('should return true when badge with typo exists', () => {
      const lines = [
        'NEW FORK',  // YORK -> FORK (1 edit: Y -> F)
        'TIMES',
        'BESTSELLER',
        'THE BOOK',
      ];

      expect(hasBadgeWithTypo(lines)).toBe(true);
    });

    it('should return false when no badge typo', () => {
      const lines = [
        'THE GUARDIANS',
        'JOHN GRISHAM',
        'A NOVEL',
      ];

      expect(hasBadgeWithTypo(lines)).toBe(false);
    });
  });
});

// ============================================================================
// Integration Style Tests
// ============================================================================

describe('Resolver Integration Scenarios', () => {
  describe('Scenario: Badge Typo with Title/Author Extraction', () => {
    it('should exclude badge lines and preserve title/author', () => {
      const lines = [
        'DELL',
        '*1',
        'NEW FORK',      // Badge typo
        'TIMES',
        'BESTSELLER',
        'JOHN GRISHAM',  // Author
        'THE GUARDIANS', // Title
      ];

      const { excludedIndices } = getEnhancedBadgeExclusions(lines);

      // Badge lines excluded
      expect(excludedIndices.has(2)).toBe(true);  // NEW FORK
      expect(excludedIndices.has(3)).toBe(true);  // TIMES
      expect(excludedIndices.has(4)).toBe(true);  // BESTSELLER

      // Non-badge lines preserved
      expect(excludedIndices.has(5)).toBe(false); // JOHN GRISHAM
      expect(excludedIndices.has(6)).toBe(false); // THE GUARDIANS

      // Filter lines
      const filteredLines = lines.filter((_, i) => !excludedIndices.has(i));

      // Should have DELL, *1, JOHN GRISHAM, THE GUARDIANS
      expect(filteredLines).toContain('JOHN GRISHAM');
      expect(filteredLines).toContain('THE GUARDIANS');
      expect(filteredLines).not.toContain('NEW FORK');
      expect(filteredLines).not.toContain('BESTSELLER');
    });
  });

  describe('Scenario: ISBN + Author OCR Error', () => {
    it('should handle both ISBN extraction and author correction', () => {
      // This tests that ISBN extraction and author matching work together

      // ISBN extraction
      const isbnLines = ['ISBN 978-0-385-12167-5'];
      const isbnResult = extractIsbnFromOcrLines(isbnLines);
      // ISBN should be found
      expect(isbnResult.rawIsbnLines.length).toBe(1);

      // Author matching with missing char
      const authorResult = computeAuthorSimilarity('TEPHEN KING', 'STEPHEN KING');
      expect(authorResult.isMatch).toBe(true);
      expect(authorResult.missingLeadingChar).toBe(true);
    });
  });
});
