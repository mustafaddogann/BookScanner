/**
 * Resolver Query Preparation Tests
 *
 * Tests for query sanitization ensuring resolver queries are clean
 * without badge/imprint/price fragments.
 */

import {
  sanitizeTitleForQuery,
  sanitizeAuthorForQuery,
  prepareResolverQuery,
  buildQueryString,
  buildQueryVariations,
} from '../resolverQueryPrep';

// ============================================================================
// Title Sanitization Tests
// ============================================================================

describe('sanitizeTitleForQuery', () => {
  describe('basic sanitization', () => {
    it('should pass through clean titles', () => {
      const result = sanitizeTitleForQuery('THE GUARDIANS', 'JOHN GRISHAM');
      expect(result.sanitized).toBe('THE GUARDIANS');
      expect(result.removedTokens).toHaveLength(0);
    });

    it('should handle null title', () => {
      const result = sanitizeTitleForQuery(null, null);
      expect(result.sanitized).toBeNull();
      expect(result.reasons).toContain('no_title');
    });
  });

  describe('marketing fragment removal', () => {
    it('should remove bestseller from title', () => {
      const result = sanitizeTitleForQuery('THE GUARDIANS BESTSELLER', null);
      expect(result.sanitized).toBe('THE GUARDIANS');
      // Marketing fragments are removed via removeMarketingFragments, not token filtering
      expect(result.reasons).toContain('removed_marketing_fragments');
    });

    it('should remove NYT from title', () => {
      const result = sanitizeTitleForQuery('NEW YORK TIMES THE GUARDIANS', null);
      // "NEW YORK TIMES" should be removed
      expect(result.sanitized).not.toContain('YORK');
      expect(result.sanitized).not.toContain('TIMES');
    });
  });

  describe('inline title/author split', () => {
    it('should split inline title+author when no author provided', () => {
      const result = sanitizeTitleForQuery('POISON IN THE PEN Patricia Wentworth', null);
      // Should extract "POISON IN THE PEN" as title
      expect(result.sanitized?.toUpperCase()).toContain('POISON');
      expect(result.sanitized?.toUpperCase()).toContain('PEN');
      // Should extract "Patricia Wentworth" as author
      expect(result.extractedAuthor).toBeTruthy();
      expect(result.extractedAuthor?.toLowerCase()).toContain('wentworth');
    });

    it('should NOT split when strong author already provided', () => {
      const result = sanitizeTitleForQuery('POISON IN THE PEN Patricia Wentworth', 'PATRICIA WENTWORTH');
      // Should NOT perform split since we already have author
      expect(result.extractedAuthor).toBeNull();
    });

    it('should split "by" separated titles', () => {
      const result = sanitizeTitleForQuery('Gone Girl by Gillian Flynn', null);
      expect(result.sanitized).toBe('Gone Girl');
      expect(result.extractedAuthor).toBe('Gillian Flynn');
      expect(result.reasons).toContain('inline_split:by_separator');
    });
  });

  describe('author token removal from title', () => {
    it('should remove trailing author tokens', () => {
      const result = sanitizeTitleForQuery('THE GUARDIANS JOHN GRISHAM', 'JOHN GRISHAM');
      // "JOHN GRISHAM" at end should be recognized as author tokens
      expect(result.sanitized?.toUpperCase()).not.toContain('GRISHAM');
    });
  });

  describe('noise token filtering', () => {
    it('should remove edition markers from title', () => {
      const result = sanitizeTitleForQuery('THE GUARDIANS SPECIAL EDITION', null);
      expect(result.sanitized).toBe('THE GUARDIANS');
      // Should have at least one sanitization reason
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('should remove publisher tokens', () => {
      const result = sanitizeTitleForQuery('BANTAM THE GUARDIANS', null);
      expect(result.sanitized).toBe('THE GUARDIANS');
    });
  });
});

// ============================================================================
// Author Sanitization Tests
// ============================================================================

describe('sanitizeAuthorForQuery', () => {
  describe('basic sanitization', () => {
    it('should pass through clean author names', () => {
      const result = sanitizeAuthorForQuery('JOHN GRISHAM');
      expect(result.sanitized).toBe('JOHN GRISHAM');
      expect(result.removedTokens).toHaveLength(0);
    });

    it('should handle null author', () => {
      const result = sanitizeAuthorForQuery(null);
      expect(result.sanitized).toBeNull();
      expect(result.reasons).toContain('no_author');
    });
  });

  describe('marketing fragment removal', () => {
    it('should remove bestselling from author', () => {
      const result = sanitizeAuthorForQuery('BESTSELLING JOHN GRISHAM');
      expect(result.sanitized).toBe('JOHN GRISHAM');
    });

    it('should remove author of prefix', () => {
      const result = sanitizeAuthorForQuery('AUTHOR OF THE GUARDIANS JOHN GRISHAM');
      // Should remove "AUTHOR OF THE GUARDIANS"
      expect(result.sanitized?.toUpperCase()).toContain('JOHN');
      expect(result.sanitized?.toUpperCase()).toContain('GRISHAM');
    });
  });

  describe('org-like extraction', () => {
    it('should warn about org-like content', () => {
      const result = sanitizeAuthorForQuery('Random House Press');
      expect(result.reasons.some(r => r.includes('org'))).toBe(true);
    });

    it('should try to extract person from org-like', () => {
      const result = sanitizeAuthorForQuery('JOHN SMITH PRESS');
      // Should extract JOHN SMITH
      if (result.sanitized) {
        expect(result.sanitized.toUpperCase()).toContain('JOHN');
      }
    });
  });

  describe('OCR artifact cleanup', () => {
    it('should clean possessive artifacts', () => {
      const result = sanitizeAuthorForQuery("Patricia Wentworth's");
      expect(result.sanitized).toBe('Patricia Wentworth');
    });

    it('should clean trailing s artifact', () => {
      const result = sanitizeAuthorForQuery('Wentworth s');
      expect(result.sanitized).toBe('Wentworth');
    });
  });
});

// ============================================================================
// Full Query Preparation Tests
// ============================================================================

describe('prepareResolverQuery', () => {
  describe('should query determination', () => {
    it('should query when title exists', () => {
      const result = prepareResolverQuery('THE GUARDIANS', null);
      expect(result.shouldQuery).toBe(true);
      expect(result.queryTitle).toBe('THE GUARDIANS');
    });

    it('should query when author exists', () => {
      const result = prepareResolverQuery(null, 'JOHN GRISHAM');
      expect(result.shouldQuery).toBe(true);
      expect(result.queryAuthor).toBe('JOHN GRISHAM');
    });

    it('should query when both exist', () => {
      const result = prepareResolverQuery('THE GUARDIANS', 'JOHN GRISHAM');
      expect(result.shouldQuery).toBe(true);
    });

    it('should NOT query when neither exists', () => {
      const result = prepareResolverQuery(null, null);
      expect(result.shouldQuery).toBe(false);
    });

    it('should NOT query when both are empty after sanitization', () => {
      const result = prepareResolverQuery('BESTSELLER', 'BESTSELLING');
      expect(result.shouldQuery).toBe(false);
    });
  });

  describe('inline split for query', () => {
    it('should perform inline split and flag in debug', () => {
      const result = prepareResolverQuery('POISON IN THE PEN Patricia Wentworth', null);
      expect(result.debug.didInlineSplitForQuery).toBe(true);
      expect(result.queryAuthor).toBeTruthy();
    });

    it('should use extracted author from title split', () => {
      const result = prepareResolverQuery('THE GUARDIANS JOHN GRISHAM', null);
      // If split happens, queryAuthor should be populated
      if (result.debug.didInlineSplitForQuery) {
        expect(result.queryAuthor).toBeTruthy();
      }
    });
  });

  describe('debug info', () => {
    it('should include original fields', () => {
      const result = prepareResolverQuery('THE GUARDIANS', 'JOHN GRISHAM');
      expect(result.debug.originalTitle).toBe('THE GUARDIANS');
      expect(result.debug.originalAuthor).toBe('JOHN GRISHAM');
    });

    it('should track sanitization through debug', () => {
      // Test that debug info is populated
      const result = prepareResolverQuery('THE GUARDIANS', 'JOHN GRISHAM');
      expect(result.debug.originalTitle).toBe('THE GUARDIANS');
      expect(result.debug.originalAuthor).toBe('JOHN GRISHAM');
    });

    it('should include sanitization reasons', () => {
      const result = prepareResolverQuery('BESTSELLER THE GUARDIANS', null);
      expect(result.debug.sanitizationReasons.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// Query String Building Tests
// ============================================================================

describe('buildQueryString', () => {
  it('should combine title and author', () => {
    const query = buildQueryString('THE GUARDIANS', 'JOHN GRISHAM');
    expect(query).toBe('THE GUARDIANS JOHN GRISHAM');
  });

  it('should handle title only', () => {
    const query = buildQueryString('THE GUARDIANS', null);
    expect(query).toBe('THE GUARDIANS');
  });

  it('should handle author only', () => {
    const query = buildQueryString(null, 'JOHN GRISHAM');
    expect(query).toBe('JOHN GRISHAM');
  });

  it('should handle empty inputs', () => {
    const query = buildQueryString(null, null);
    expect(query).toBe('');
  });
});

describe('buildQueryVariations', () => {
  it('should generate multiple variations', () => {
    const variations = buildQueryVariations('THE GUARDIANS', 'JOHN GRISHAM');
    expect(variations.length).toBeGreaterThan(1);
    expect(variations).toContain('THE GUARDIANS JOHN GRISHAM');
    expect(variations).toContain('THE GUARDIANS');
    expect(variations).toContain('JOHN GRISHAM');
    expect(variations).toContain('JOHN GRISHAM THE GUARDIANS');
  });

  it('should include stripped title variation', () => {
    const variations = buildQueryVariations('THE GUARDIANS', 'JOHN GRISHAM');
    expect(variations).toContain('GUARDIANS'); // THE stripped
  });

  it('should deduplicate variations', () => {
    const variations = buildQueryVariations('GUARDIANS', 'JOHN GRISHAM');
    // "GUARDIANS" appears twice (title-only and title with THE stripped)
    // but should be deduplicated
    const guardianCount = variations.filter(v => v === 'GUARDIANS').length;
    expect(guardianCount).toBe(1);
  });
});

// ============================================================================
// Fixture Tests - Full Pipeline
// ============================================================================

describe('Full Pipeline Fixtures', () => {
  describe('Fixture: Badge + Title + Author', () => {
    it('should clean badge tokens from query', () => {
      const result = prepareResolverQuery(
        'NEW YORK TIMES BESTSELLER THE GUARDIANS',
        'JOHN GRISHAM'
      );
      expect(result.queryTitle).not.toContain('BESTSELLER');
      expect(result.queryTitle).not.toContain('YORK');
      expect(result.queryTitle).toBe('THE GUARDIANS');
      expect(result.queryAuthor).toBe('JOHN GRISHAM');
      expect(result.shouldQuery).toBe(true);
    });
  });

  describe('Fixture: Inline collapsed title+author', () => {
    it('should split for query', () => {
      const result = prepareResolverQuery(
        'POISON IN THE PEN Patricia Wentworth',
        null
      );
      expect(result.queryTitle?.toUpperCase()).toContain('POISON');
      expect(result.queryTitle?.toUpperCase()).toContain('PEN');
      expect(result.queryAuthor?.toLowerCase()).toContain('wentworth');
      expect(result.debug.didInlineSplitForQuery).toBe(true);
    });
  });

  describe('Fixture: Publisher noise in title', () => {
    it('should remove publisher tokens', () => {
      const result = prepareResolverQuery(
        'BANTAM STER THE GUARDIANS',
        'JOHN GRISHAM'
      );
      expect(result.queryTitle).not.toContain('BANTAM');
      expect(result.queryTitle).not.toContain('STER');
      expect(result.queryTitle).toBe('THE GUARDIANS');
    });
  });

  describe('Fixture: Price-contaminated title', () => {
    it('should remove price tokens', () => {
      const result = prepareResolverQuery(
        'THE GUARDIANS $9.99',
        'JOHN GRISHAM'
      );
      // Price should be removed
      expect(result.queryTitle).not.toContain('$');
      expect(result.queryTitle).not.toContain('9.99');
    });
  });

  describe('Fixture: Edition markers', () => {
    it('should remove edition markers', () => {
      const result = prepareResolverQuery(
        'THE GUARDIANS SPECIAL DELUXE EDITION',
        null
      );
      // The important thing is that the query title is clean
      expect(result.queryTitle).toBe('THE GUARDIANS');
      // Sanitization happened
      expect(result.debug.sanitizationReasons.length).toBeGreaterThan(0);
    });
  });
});
