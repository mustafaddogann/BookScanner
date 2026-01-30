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

    it('extracts ISBNs', () => {
      const lines = [
        'THE SHINING',
        'ISBN 9780307743256',
      ];

      const result = buildEvidenceTokens(lines);
      expect(result.isbns).toContain('9780307743256');
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
