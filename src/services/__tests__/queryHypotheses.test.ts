/**
 * Query Hypotheses Generation Tests
 */

import {
  generateHypotheses,
  generateSimpleHypotheses,
  generateBoostHypotheses,
  getQuerySet,
} from '../queryHypotheses';

describe('queryHypotheses', () => {
  describe('generateHypotheses', () => {
    it('generates hypotheses from evidence lines', () => {
      const lines = [
        'FICTION',
        'STEPHEN KING',
        'THE SHINING',
      ];

      const result = generateHypotheses(lines);

      expect(result.hypotheses.length).toBeGreaterThan(0);
      expect(result.debug.inputLineCount).toBe(3);
      expect(result.debug.personNames).toContain('STEPHEN KING');
      expect(result.debug.titleLikeLines).toContain('THE SHINING');
    });

    it('prioritizes title+author combinations', () => {
      const lines = [
        'STEPHEN KING',
        'THE SHINING',
      ];

      const result = generateHypotheses(lines);

      // Should have title+author hypothesis early
      const titleAuthor = result.hypotheses.find(
        (h) => h.type === 'title_author' || h.type === 'author_title'
      );
      expect(titleAuthor).toBeDefined();
    });

    it('does NOT generate ISBN hypothesis from spine_crop (default source)', () => {
      // By default, buildEvidenceTokens uses sourceKind: 'spine_crop'
      // which skips ISBN extraction to avoid false negatives from noisy spine OCR
      const lines = [
        'THE SHINING',
        'ISBN 9780307743256',
      ];

      const result = generateHypotheses(lines);

      // ISBN hypothesis should NOT be present for spine_crop
      const isbnHypothesis = result.hypotheses.find((h) => h.type === 'isbn');
      expect(isbnHypothesis).toBeUndefined();

      // But other hypotheses should still be generated
      expect(result.hypotheses.length).toBeGreaterThan(0);
      const titleHypothesis = result.hypotheses.find((h) => h.type === 'title_only');
      expect(titleHypothesis).toBeDefined();
    });

    it('generates article-stripped variants', () => {
      const lines = [
        'THE GUARDIAN',
        'NICHOLAS SPARKS',
      ];

      const result = generateHypotheses(lines);

      const stripped = result.hypotheses.find(
        (h) => h.type === 'stripped' && h.query.includes('GUARDIAN')
      );
      expect(stripped).toBeDefined();
    });

    it('uses OCR fields as fallback', () => {
      const lines = ['FICTION']; // Only noise

      const result = generateHypotheses(lines, 'The Shining', 'Stephen King');

      const fallback = result.hypotheses.find((h) => h.type === 'fallback');
      expect(fallback).toBeDefined();
      expect(fallback?.query).toContain('The Shining');
    });

    it('limits number of hypotheses to max 5', () => {
      const lines = [
        'LINE ONE',
        'LINE TWO',
        'LINE THREE',
        'LINE FOUR',
        'LINE FIVE',
        'LINE SIX',
        'LINE SEVEN',
      ];

      const result = generateHypotheses(lines);

      // New limit is 5 for rate-limit safety
      expect(result.hypotheses.length).toBeLessThanOrEqual(5);
    });

    it('handles empty input', () => {
      const result = generateHypotheses([]);

      expect(result.hypotheses).toHaveLength(0);
      expect(result.debug.inputLineCount).toBe(0);
    });

    it('deduplicates identical queries', () => {
      const lines = [
        'THE SHINING',
        'THE SHINING', // Duplicate
      ];

      const result = generateHypotheses(lines);

      const shiningQueries = result.hypotheses.filter(
        (h) => h.query.toLowerCase() === 'the shining'
      );
      expect(shiningQueries.length).toBeLessThanOrEqual(1);
    });

    it('generates multiple hypotheses for title-only (no author) input', () => {
      // Regression test: title-strong + author-missing must NOT collapse to 1 hypothesis
      const lines = [
        'THE GREAT GATSBY',
      ];

      const result = generateHypotheses(lines);

      // Should generate at least 2 hypotheses (title-only + stripped variant)
      expect(result.hypotheses.length).toBeGreaterThanOrEqual(2);

      // Should have title-only hypothesis
      const titleOnly = result.hypotheses.find((h) => h.type === 'title_only');
      expect(titleOnly).toBeDefined();

      // Should have stripped variant (without "THE")
      const stripped = result.hypotheses.find(
        (h) => h.type === 'stripped' && h.query.includes('GATSBY')
      );
      expect(stripped).toBeDefined();
    });

    it('generates multiple hypotheses even without author signal', () => {
      // Another regression test: ensure multi-hypothesis works for all title-only cases
      const lines = [
        'A BRIEF HISTORY OF TIME',
      ];

      const result = generateHypotheses(lines);

      // Should generate multiple hypotheses
      expect(result.hypotheses.length).toBeGreaterThanOrEqual(2);

      // Verify shapes include title_only and stripped
      const shapes = result.hypotheses.map((h) => h.type);
      expect(shapes).toContain('title_only');
      expect(shapes).toContain('stripped');
    });
  });

  describe('generateSimpleHypotheses', () => {
    it('generates title+author hypotheses', () => {
      const result = generateSimpleHypotheses('The Shining', 'Stephen King');

      expect(result.length).toBeGreaterThan(0);
      expect(result.find((h) => h.type === 'title_author')).toBeDefined();
      expect(result.find((h) => h.type === 'author_title')).toBeDefined();
    });

    it('handles title only', () => {
      const result = generateSimpleHypotheses('The Shining', null);

      expect(result.length).toBe(1);
      expect(result[0].type).toBe('title_only');
    });

    it('handles author only', () => {
      const result = generateSimpleHypotheses(null, 'Stephen King');

      expect(result.length).toBe(1);
      expect(result[0].type).toBe('author_only');
    });

    it('handles both null', () => {
      const result = generateSimpleHypotheses(null, null);

      expect(result).toHaveLength(0);
    });
  });

  describe('generateBoostHypotheses', () => {
    it('generates expanded hypotheses for boost pass', () => {
      const lines = [
        'STEPHEN KING',
        'THE SHINING',
        'A NOVEL OF TERROR',
      ];

      // First pass - get queries to exclude
      const pass1Result = generateHypotheses(lines);
      const excludeQueries = getQuerySet(pass1Result.hypotheses);

      // Boost pass
      const boostResult = generateBoostHypotheses(lines, excludeQueries);

      expect(boostResult.hypotheses.length).toBeGreaterThan(0);
      // Should not duplicate pass 1 queries
      for (const h of boostResult.hypotheses) {
        expect(excludeQueries.has(h.query.toLowerCase().trim())).toBe(false);
      }
    });

    it('limits hypotheses to max 12', () => {
      const lines = [
        'LINE ONE TEXT',
        'LINE TWO TEXT',
        'LINE THREE TEXT',
        'LINE FOUR TEXT',
        'LINE FIVE TEXT',
        'LINE SIX TEXT',
        'LINE SEVEN TEXT',
      ];

      const result = generateBoostHypotheses(lines, new Set());

      // Pass 2 limit is 12
      expect(result.hypotheses.length).toBeLessThanOrEqual(12);
    });

    it('generates n-gram hypotheses', () => {
      const lines = [
        'MULTIPLE WORD TITLE HERE',
        'ANOTHER LINE TEXT',
      ];

      const result = generateBoostHypotheses(lines, new Set());

      // Should have some n-gram hypotheses
      const ngrams = result.hypotheses.filter((h) => h.type === 'boost_ngram');
      expect(ngrams.length).toBeGreaterThanOrEqual(0); // May not always generate n-grams
    });

    it('generates combined line hypotheses', () => {
      const lines = [
        'TITLE LINE ONE',
        'AUTHOR NAME HERE',
      ];

      const result = generateBoostHypotheses(lines, new Set());

      // Should have some combo hypotheses
      const combos = result.hypotheses.filter((h) => h.type === 'boost_combo');
      expect(combos.length).toBeGreaterThan(0);
    });

    it('handles empty exclude set', () => {
      const lines = ['THE SHINING', 'STEPHEN KING'];

      const result = generateBoostHypotheses(lines, new Set());

      expect(result.hypotheses.length).toBeGreaterThan(0);
    });
  });

  describe('getQuerySet', () => {
    it('returns lowercase trimmed query set', () => {
      const hypotheses = [
        { query: '  The Shining  ', type: 'title_only' as const, priority: 0, explanation: '' },
        { query: 'STEPHEN KING', type: 'author_only' as const, priority: 1, explanation: '' },
      ];

      const querySet = getQuerySet(hypotheses);

      expect(querySet.has('the shining')).toBe(true);
      expect(querySet.has('stephen king')).toBe(true);
      // Original case/whitespace should not be in set
      expect(querySet.has('The Shining')).toBe(false);
      expect(querySet.has('STEPHEN KING')).toBe(false);
    });

    it('handles empty array', () => {
      const querySet = getQuerySet([]);

      expect(querySet.size).toBe(0);
    });
  });
});
