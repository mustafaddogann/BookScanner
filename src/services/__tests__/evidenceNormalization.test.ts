/**
 * Evidence Normalization Tests
 */

import {
  normalizeLine,
  tokenize,
  isNoiseLine,
  isMarketingLine,
  buildEvidenceTokens,
  looksLikePersonName,
  looksLikeTitle,
  extractIsbn,
  stripLeadingArticle,
  stripEmbeddedNoise,
  isIncompleteLine,
  mergeSplitLines,
} from '../evidenceNormalization';

describe('evidenceNormalization', () => {
  describe('normalizeLine', () => {
    it('trims whitespace and collapses spaces', () => {
      const result = normalizeLine('  THE   SHINING  ');
      expect(result.original).toBe('THE SHINING');
      expect(result.normalized).toBe('the shining');
    });

    it('strips surrounding brackets', () => {
      const result = normalizeLine('[FICTION]');
      expect(result.original).toBe('FICTION');
    });

    it('strips surrounding quotes', () => {
      const result = normalizeLine('"The Guardian"');
      expect(result.original).toBe('The Guardian');
    });

    it('preserves internal apostrophes', () => {
      const result = normalizeLine("The King's Speech");
      expect(result.original).toBe("The King's Speech");
    });
  });

  describe('tokenize', () => {
    it('splits on whitespace', () => {
      const tokens = tokenize('the shining');
      expect(tokens).toContain('the');
      expect(tokens).toContain('shining');
    });

    it('removes very short tokens', () => {
      const tokens = tokenize('a b the shining');
      expect(tokens).not.toContain('a');
      expect(tokens).not.toContain('b');
      expect(tokens).toContain('the');
    });

    it('removes numeric-only tokens', () => {
      const tokens = tokenize('2024 edition the shining');
      expect(tokens).not.toContain('2024');
      expect(tokens).toContain('edition');
    });
  });

  describe('isNoiseLine', () => {
    it('returns true for single char', () => {
      expect(isNoiseLine('a')).toBe(true);
    });

    it('returns true for single genre word', () => {
      expect(isNoiseLine('fiction')).toBe(true);
      expect(isNoiseLine('mystery')).toBe(true);
    });

    it('returns false for title', () => {
      expect(isNoiseLine('the shining')).toBe(false);
    });
  });

  describe('isMarketingLine', () => {
    it('detects bestseller phrases', () => {
      expect(isMarketingLine('new york times bestseller')).toBe(true);
      expect(isMarketingLine('#1 bestseller')).toBe(true);
    });

    it('detects movie tie-in phrases', () => {
      expect(isMarketingLine('now a major motion picture')).toBe(true);
    });

    it('returns false for normal content', () => {
      expect(isMarketingLine('the shining')).toBe(false);
    });
  });

  describe('looksLikePersonName', () => {
    it('detects 2-word capitalized names', () => {
      expect(looksLikePersonName('Stephen King')).toBe(true);
      expect(looksLikePersonName('STEPHEN KING')).toBe(true);
    });

    it('detects author names with OCR case errors like "nGAIO MARSH"', () => {
      // This was failing before the case-insensitive fix
      expect(looksLikePersonName('nGAIO MARSH')).toBe(true);
      expect(looksLikePersonName('PATRICIA WENTWORTH')).toBe(true);
    });

    it('detects initials in author names', () => {
      expect(looksLikePersonName('J K ROWLING')).toBe(true);
      expect(looksLikePersonName('C S LEWIS')).toBe(true);
    });

    it('rejects single words', () => {
      expect(looksLikePersonName('King')).toBe(false);
    });

    it('rejects genre words', () => {
      expect(looksLikePersonName('Fiction')).toBe(false);
    });

    it('rejects long phrases', () => {
      // More than 4 words is too long for a typical author name
      expect(looksLikePersonName('Stephen Edwin King Junior The Third')).toBe(false);
    });
  });

  describe('stripEmbeddedNoise - Publisher/Price Removal', () => {
    it('removes prices from lines', () => {
      expect(stripEmbeddedNoise('POISON IN THE PEN $9.99')).toBe('POISON IN THE PEN');
      expect(stripEmbeddedNoise('$193 POISON IN THE PEN')).toBe('POISON IN THE PEN');
    });

    it('removes publisher names from lines with other content', () => {
      const result = stripEmbeddedNoise('BANTAM STER $193 POISON IN THE PEN Patricia Wentworth');
      expect(result).not.toContain('BANTAM');
      expect(result).not.toContain('$193');
      expect(result).toContain('POISON');
      expect(result).toContain('Patricia');
    });

    it('preserves content when no noise present', () => {
      expect(stripEmbeddedNoise('The Shining')).toBe('The Shining');
      expect(stripEmbeddedNoise('STEPHEN KING')).toBe('STEPHEN KING');
    });

    it('handles regional prices', () => {
      const result = stripEmbeddedNoise('USA $14.99 THE BOOK');
      expect(result).not.toContain('$14.99');
    });
  });

  describe('isIncompleteLine - Split Line Detection', () => {
    it('detects lines ending with prepositions', () => {
      expect(isIncompleteLine('STRAIGHT INTO')).toBe(true);
      expect(isIncompleteLine('THE GIRL WITH')).toBe(true);
      expect(isIncompleteLine('GONE WITH THE')).toBe(true);
    });

    it('detects lines ending with hyphen', () => {
      expect(isIncompleteLine('INCOMP-')).toBe(true);
    });

    it('returns false for complete lines', () => {
      expect(isIncompleteLine('THE SHINING')).toBe(false);
      expect(isIncompleteLine('STEPHEN KING')).toBe(false);
      expect(isIncompleteLine('DARKNESS')).toBe(false);
    });

    it('returns false for empty or very short lines', () => {
      expect(isIncompleteLine('')).toBe(false);
      expect(isIncompleteLine('AB')).toBe(false);
    });
  });

  describe('mergeSplitLines - Line Merging', () => {
    it('merges split title lines', () => {
      const lines = ['STRAIGHT INTO', 'DARKNESS'];
      const result = mergeSplitLines(lines);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('STRAIGHT INTO DARKNESS');
    });

    it('handles hyphenated word breaks', () => {
      const lines = ['INCOMP-', 'LETE'];
      const result = mergeSplitLines(lines);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('INCOMPLETE');
    });

    it('preserves complete lines as-is', () => {
      const lines = ['THE SHINING', 'STEPHEN KING'];
      const result = mergeSplitLines(lines);
      expect(result).toEqual(['THE SHINING', 'STEPHEN KING']);
    });

    it('handles single line input', () => {
      expect(mergeSplitLines(['HELLO'])).toEqual(['HELLO']);
    });

    it('handles empty input', () => {
      expect(mergeSplitLines([])).toEqual([]);
    });
  });

  describe('looksLikeTitle', () => {
    it('detects phrases with articles', () => {
      expect(looksLikeTitle('The Shining')).toBe(true);
      expect(looksLikeTitle('A Tale of Two Cities')).toBe(true);
    });

    it('detects longer phrases', () => {
      expect(looksLikeTitle('Brave New World')).toBe(true);
    });

    it('rejects single words', () => {
      expect(looksLikeTitle('Shining')).toBe(false);
    });
  });

  describe('extractIsbn', () => {
    it('extracts ISBN-13', () => {
      expect(extractIsbn('ISBN: 978-0-307-74325-6')).toBe('9780307743256');
      expect(extractIsbn('9780307743256')).toBe('9780307743256');
    });

    it('extracts ISBN-10', () => {
      expect(extractIsbn('ISBN-10: 0-307-74325-X')).toBe('030774325X');
    });

    it('returns null for non-ISBN', () => {
      expect(extractIsbn('The Shining')).toBe(null);
    });
  });

  describe('stripLeadingArticle', () => {
    it('strips "the"', () => {
      expect(stripLeadingArticle('The Shining')).toBe('Shining');
    });

    it('strips "a"', () => {
      expect(stripLeadingArticle('A Novel')).toBe('Novel');
    });

    it('preserves non-article starts', () => {
      expect(stripLeadingArticle('Shining')).toBe('Shining');
    });
  });

  describe('buildEvidenceTokens', () => {
    it('processes evidence lines correctly', () => {
      const lines = [
        'FICTION',
        'STEPHEN KING',
        'THE SHINING',
      ];

      const result = buildEvidenceTokens(lines);

      expect(result.cleanedLines).toHaveLength(2); // FICTION filtered as noise
      expect(result.tokensSet.has('stephen')).toBe(true);
      expect(result.tokensSet.has('king')).toBe(true);
      expect(result.tokensSet.has('shining')).toBe(true);
      expect(result.personNameLines).toContain('STEPHEN KING');
      expect(result.titleLikeLines).toContain('THE SHINING');
    });

    it('skips ISBN extraction for spine_crop (default)', () => {
      const lines = [
        'THE SHINING',
        'ISBN 9780307743256',
      ];

      // Default sourceKind is spine_crop, which skips ISBN extraction
      const result = buildEvidenceTokens(lines);
      expect(result.isbns).toHaveLength(0);
    });

    it('extracts ISBNs for back_cover source', () => {
      const lines = [
        'THE SHINING',
        'ISBN 9780307743256',
      ];

      // Explicitly use back_cover to enable ISBN extraction
      const result = buildEvidenceTokens(lines, { sourceKind: 'back_cover' });
      expect(result.isbns).toContain('9780307743256');
    });

    // =========================================================================
    // REGRESSION TEST: ISBN-like digits from spine must NOT populate isbn
    // Spine OCR produces unreliable ISBN-like sequences that harm scoring
    // =========================================================================
    it('REGRESSION: ISBN-like digits from spine_crop do NOT populate isbns array', () => {
      const lines = [
        'POISON IN THE PEN',
        '0-515-06011-9',  // ISBN-like but from spine - should NOT be extracted
        'Patricia Wentworth',
      ];

      // spine_crop is the default source
      const result = buildEvidenceTokens(lines);

      // ISBN array must be empty for spine sources
      expect(result.isbns).toHaveLength(0);
      // The title/author tokens should still be extracted
      expect(result.tokensSet.has('poison')).toBe(true);
      expect(result.tokensSet.has('patricia')).toBe(true);
    });

    it('REGRESSION: ISBN-like tokens from spine do NOT appear in tokensSet', () => {
      const lines = [
        'THE SHINING',
        '978-0-307-74325-6',  // ISBN-like pattern
        'STEPHEN KING',
      ];

      const result = buildEvidenceTokens(lines);

      // ISBN-like tokens should be filtered from tokensSet
      // (they inflate precision denominator and cause false rejects)
      expect(result.tokensSet.has('978')).toBe(false);
      expect(result.tokensSet.has('0307743256')).toBe(false);
      // But actual title/author tokens should be present
      expect(result.tokensSet.has('shining')).toBe(true);
      expect(result.tokensSet.has('stephen')).toBe(true);
      expect(result.tokensSet.has('king')).toBe(true);
    });

    it('REGRESSION: numeric-only tokens are filtered from tokensSet', () => {
      const lines = [
        'THE SHINING',
        '1234567890',  // Pure numeric - should be filtered
        '2024',        // Year - should be filtered
        'STEPHEN KING',
      ];

      const result = buildEvidenceTokens(lines);

      // Pure numeric tokens should be filtered
      expect(result.tokensSet.has('1234567890')).toBe(false);
      expect(result.tokensSet.has('2024')).toBe(false);
      // Title/author tokens should be present
      expect(result.tokensSet.has('shining')).toBe(true);
      expect(result.tokensSet.has('king')).toBe(true);
    });

    it('filters marketing content', () => {
      const lines = [
        'NEW YORK TIMES BESTSELLER',
        'THE SHINING',
      ];

      const result = buildEvidenceTokens(lines);
      expect(result.cleanedLines).toHaveLength(1);
      expect(result.cleanedLines[0]).toBe('THE SHINING');
    });

    // === Task C: Integration tests for failing patterns ===

    it('handles "BANTAM STER $193" noise pattern', () => {
      const lines = [
        'BANTAM STER $193',
        'POISON IN THE PEN',
        'Patricia Wentworth',
      ];
      const result = buildEvidenceTokens(lines);

      // Should not have bantam/ster as major tokens
      expect(result.tokensSet.has('bantam')).toBe(false);
      // Should have the actual book content
      expect(result.tokensSet.has('poison')).toBe(true);
      expect(result.tokensSet.has('pen')).toBe(true);
    });

    it('handles split title lines like "STRAIGHT INTO" + "DARKNESS"', () => {
      const lines = [
        'STRAIGHT INTO',
        'DARKNESS',
        'PAULLINA SIMONS',
      ];
      const result = buildEvidenceTokens(lines);

      // After merging, should have combined tokens
      expect(result.tokensSet.has('straight')).toBe(true);
      expect(result.tokensSet.has('darkness')).toBe(true);
      // Title should be detected
      expect(result.titleLikeLines.some(l => l.includes('DARKNESS'))).toBe(true);
    });

    it('handles OCR case errors in author names like "nGAIO MARSH"', () => {
      const lines = [
        'THE SHINING',
        'nGAIO MARSH', // OCR error in first character
      ];
      const result = buildEvidenceTokens(lines);

      // Should still detect as person name despite case error
      expect(result.personNameLines.some(n => n.includes('MARSH'))).toBe(true);
    });
  });

  describe('extractEvidenceLines', () => {
    const { extractEvidenceLines } = require('../evidenceNormalization');

    it('extracts lines from string with newlines', () => {
      const input = 'STEPHEN KING\nTHE SHINING\n\nFICTION';
      const result = extractEvidenceLines(input);

      expect(result).toContain('STEPHEN KING');
      expect(result).toContain('THE SHINING');
      // FICTION should be filtered as noise
    });

    it('extracts lines from array', () => {
      const input = ['STEPHEN KING', 'THE SHINING', '', 'FICTION'];
      const result = extractEvidenceLines(input);

      expect(result).toContain('STEPHEN KING');
      expect(result).toContain('THE SHINING');
    });

    it('filters empty lines', () => {
      const input = ['', '   ', 'THE SHINING', ''];
      const result = extractEvidenceLines(input);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe('THE SHINING');
    });
  });

  describe('normalizeForScoring', () => {
    const { normalizeForScoring } = require('../evidenceNormalization');

    it('returns tokens without generic words', () => {
      const result = normalizeForScoring('The Shining Book');

      expect(result).toContain('shining');
      expect(result).not.toContain('the');
      expect(result).not.toContain('book');
    });

    it('filters numeric tokens', () => {
      const result = normalizeForScoring('2024 Edition The Shining');

      expect(result).toContain('shining');
      expect(result).not.toContain('2024');
    });
  });

  describe('extractIsbnFromEvidence', () => {
    const { extractIsbnFromEvidence } = require('../evidenceNormalization');

    it('extracts ISBN-13', () => {
      const result = extractIsbnFromEvidence(['ISBN: 978-0-307-74325-6']);

      expect(result.isbn13).toBe('9780307743256');
    });

    it('extracts ISBN-10', () => {
      const result = extractIsbnFromEvidence(['ISBN-10: 0-307-74325-X']);

      expect(result.isbn10).toBe('030774325X');
    });

    it('extracts both ISBNs', () => {
      const result = extractIsbnFromEvidence([
        'ISBN-13: 9780307743256',
        'ISBN-10: 030774325X',
      ]);

      expect(result.isbn13).toBe('9780307743256');
      expect(result.isbn10).toBe('030774325X');
    });

    it('returns empty for no ISBNs', () => {
      const result = extractIsbnFromEvidence(['The Shining', 'Stephen King']);

      expect(result.isbn10).toBeUndefined();
      expect(result.isbn13).toBeUndefined();
    });
  });

  describe('isGenericTitle', () => {
    const { isGenericTitle } = require('../evidenceNormalization');

    it('returns true for single common words', () => {
      expect(isGenericTitle('It')).toBe(true);
      expect(isGenericTitle('Home')).toBe(true);
      expect(isGenericTitle('Gone')).toBe(true);
    });

    it('returns false for distinctive titles', () => {
      expect(isGenericTitle('The Shining')).toBe(false);
      expect(isGenericTitle('Gone Girl')).toBe(false);
      expect(isGenericTitle('It Ends with Us')).toBe(false);
    });

    it('returns true for empty/generic tokens', () => {
      expect(isGenericTitle('The')).toBe(true);
      expect(isGenericTitle('A Novel')).toBe(true);
    });
  });
});
