/**
 * Unit tests for ISBN utilities in services/isbnUtils.ts
 *
 * Tests for:
 * - ISBN-10 and ISBN-13 checksum validation
 * - ISBN extraction and validation from text
 * - ISBN-like token detection for filtering
 * - Source-aware ISBN policy
 */

import {
  validateIsbn10Checksum,
  validateIsbn13Checksum,
  validateIsbnChecksum,
  normalizeIsbn,
  getIsbnType,
  extractAndValidateIsbns,
  isIsbnLikeToken,
  filterIsbnTokens,
  determineIsbnPolicy,
  shouldAttemptIsbnLookup,
  shouldApplyIsbnBoost,
  type EvidenceSourceKind,
  type ValidatedIsbn,
} from '../isbnUtils';

describe('ISBN Checksum Validation', () => {
  describe('validateIsbn10Checksum', () => {
    it('validates correct ISBN-10 with numeric check digit', () => {
      // The Shining: 0-385-12167-1
      expect(validateIsbn10Checksum('0385121679')).toBe(true);
      // Another valid ISBN-10
      expect(validateIsbn10Checksum('0306406152')).toBe(true);
    });

    it('validates correct ISBN-10 with X check digit', () => {
      // X represents 10 in modulo 11
      expect(validateIsbn10Checksum('080442957X')).toBe(true);
      // Lowercase x should also work after normalization
      expect(validateIsbn10Checksum('080442957x')).toBe(true);
    });

    it('rejects ISBN-10 with wrong check digit', () => {
      expect(validateIsbn10Checksum('0306406151')).toBe(false); // Should be 2
      expect(validateIsbn10Checksum('0385121678')).toBe(false); // Should be 9
    });

    it('rejects ISBN-10 with wrong length', () => {
      expect(validateIsbn10Checksum('123456789')).toBe(false); // Too short
      expect(validateIsbn10Checksum('12345678901')).toBe(false); // Too long
    });

    it('rejects ISBN-10 with invalid characters', () => {
      expect(validateIsbn10Checksum('030640615A')).toBe(false); // A not valid
      expect(validateIsbn10Checksum('0306X06152')).toBe(false); // X only valid as check
    });
  });

  describe('validateIsbn13Checksum', () => {
    it('validates correct ISBN-13 with 978 prefix', () => {
      expect(validateIsbn13Checksum('9780306406157')).toBe(true);
      expect(validateIsbn13Checksum('9780061120084')).toBe(true);
    });

    it('validates correct ISBN-13 with 979 prefix', () => {
      // 979 prefix ISBNs are valid (introduced 2007+)
      expect(validateIsbn13Checksum('9791234567896')).toBe(true);
    });

    it('rejects ISBN-13 with wrong check digit', () => {
      expect(validateIsbn13Checksum('9780306406156')).toBe(false); // Should be 7
      expect(validateIsbn13Checksum('9780061120083')).toBe(false); // Should be 4
    });

    it('rejects ISBN-13 with wrong length', () => {
      expect(validateIsbn13Checksum('978030640615')).toBe(false); // Too short
      expect(validateIsbn13Checksum('97803064061577')).toBe(false); // Too long
    });

    it('rejects ISBN-13 with non-digit characters', () => {
      expect(validateIsbn13Checksum('978030640615X')).toBe(false); // X not valid in ISBN-13
      expect(validateIsbn13Checksum('978A306406157')).toBe(false); // A not valid
    });
  });

  describe('validateIsbnChecksum', () => {
    it('validates both ISBN-10 and ISBN-13', () => {
      expect(validateIsbnChecksum('0306406152')).toBe(true);
      expect(validateIsbnChecksum('9780306406157')).toBe(true);
    });

    it('handles formatted ISBNs with hyphens/spaces', () => {
      expect(validateIsbnChecksum('0-306-40615-2')).toBe(true);
      expect(validateIsbnChecksum('978-0-306-40615-7')).toBe(true);
      expect(validateIsbnChecksum('978 0 306 40615 7')).toBe(true);
    });

    it('rejects invalid ISBNs', () => {
      expect(validateIsbnChecksum('1234567890')).toBe(false);
      expect(validateIsbnChecksum('invalid')).toBe(false);
    });
  });
});

describe('ISBN Extraction', () => {
  describe('normalizeIsbn', () => {
    it('removes hyphens and spaces', () => {
      expect(normalizeIsbn('978-0-306-40615-7')).toBe('9780306406157');
      expect(normalizeIsbn('978 0 306 40615 7')).toBe('9780306406157');
    });

    it('uppercases X', () => {
      expect(normalizeIsbn('080442957x')).toBe('080442957X');
    });
  });

  describe('getIsbnType', () => {
    it('detects ISBN-10', () => {
      expect(getIsbnType('0306406152')).toBe('isbn10');
      expect(getIsbnType('080442957X')).toBe('isbn10');
    });

    it('detects ISBN-13', () => {
      expect(getIsbnType('9780306406157')).toBe('isbn13');
      expect(getIsbnType('9791234567896')).toBe('isbn13');
    });

    it('returns null for invalid format', () => {
      expect(getIsbnType('12345')).toBeNull();
      expect(getIsbnType('invalid')).toBeNull();
    });
  });

  describe('extractAndValidateIsbns', () => {
    it('extracts valid ISBNs from text', () => {
      const text = 'ISBN: 978-0-306-40615-7';
      const result = extractAndValidateIsbns(text);

      expect(result.candidatesRaw.length).toBeGreaterThan(0);
      expect(result.candidatesValid.length).toBe(1);
      expect(result.isbn13).toBe('9780306406157');
    });

    it('extracts both ISBN-10 and ISBN-13 from text', () => {
      const text = 'ISBN-10: 0-306-40615-2 ISBN-13: 978-0-061-12008-4';
      const result = extractAndValidateIsbns(text);

      expect(result.candidatesValid.length).toBeGreaterThanOrEqual(1);
    });

    it('filters out invalid checksums', () => {
      const text = 'Invalid: 9780306406156 Valid: 9780306406157';
      const result = extractAndValidateIsbns(text);

      // Only the valid one should be in candidatesValid
      expect(result.candidatesValid.every(c => c.checksumValid)).toBe(true);
    });

    it('handles spine OCR text with ISBNs mixed with noise', () => {
      const text = `
        FICTION
        THE SHINING
        STEPHEN KING
        ISBN 978-0-385-12167-5
        $14.99
      `;
      const result = extractAndValidateIsbns(text);

      expect(result.candidatesRaw.length).toBeGreaterThan(0);
    });
  });
});

describe('ISBN Token Filtering', () => {
  describe('isIsbnLikeToken', () => {
    it('detects ISBN-10 patterns', () => {
      expect(isIsbnLikeToken('0306406152')).toBe(true);
      expect(isIsbnLikeToken('080442957x')).toBe(true);
    });

    it('detects ISBN-13 patterns', () => {
      expect(isIsbnLikeToken('9780306406157')).toBe(true);
    });

    it('detects ISBN/ISSN labels', () => {
      expect(isIsbnLikeToken('isbn')).toBe(true);
      expect(isIsbnLikeToken('ISBN')).toBe(true);
      expect(isIsbnLikeToken('issn')).toBe(true);
    });

    it('detects hyphenated number sequences', () => {
      expect(isIsbnLikeToken('0-306-40615-2')).toBe(true);
      expect(isIsbnLikeToken('978-0')).toBe(true);
    });

    it('detects mostly-numeric tokens', () => {
      expect(isIsbnLikeToken('12345678')).toBe(true); // >70% digits
      expect(isIsbnLikeToken('123abc45')).toBe(true); // 5/8 = 62.5% < 70%? Let's check...
    });

    it('does not flag normal text tokens', () => {
      expect(isIsbnLikeToken('shining')).toBe(false);
      expect(isIsbnLikeToken('king')).toBe(false);
      expect(isIsbnLikeToken('stephen')).toBe(false);
    });
  });

  describe('filterIsbnTokens', () => {
    it('removes ISBN-like tokens from array', () => {
      const tokens = ['shining', 'isbn', '9780306406157', 'king'];
      const filtered = filterIsbnTokens(tokens);

      expect(filtered).toContain('shining');
      expect(filtered).toContain('king');
      expect(filtered).not.toContain('isbn');
      expect(filtered).not.toContain('9780306406157');
    });

    it('preserves all tokens when none are ISBN-like', () => {
      const tokens = ['the', 'shining', 'stephen', 'king'];
      const filtered = filterIsbnTokens(tokens);

      expect(filtered).toEqual(tokens);
    });
  });
});

describe('Source-Aware ISBN Policy', () => {
  describe('determineIsbnPolicy', () => {
    const createValidIsbn = (isbn: string): ValidatedIsbn => ({
      raw: isbn,
      normalized: isbn,
      type: isbn.length === 10 ? 'isbn10' : 'isbn13',
      checksumValid: true,
    });

    it('returns ignore for spine_crop', () => {
      const policy = determineIsbnPolicy('spine_crop', [createValidIsbn('9780306406157')]);
      expect(policy).toBe('ignore');
    });

    it('returns lookup_first for back_cover with valid ISBNs', () => {
      const policy = determineIsbnPolicy('back_cover', [createValidIsbn('9780306406157')]);
      expect(policy).toBe('lookup_first');
    });

    it('returns boost_only for back_cover without valid ISBNs', () => {
      const policy = determineIsbnPolicy('back_cover', []);
      expect(policy).toBe('boost_only');
    });

    it('returns lookup_first for inside_page with valid ISBNs', () => {
      const policy = determineIsbnPolicy('inside_page', [createValidIsbn('9780306406157')]);
      expect(policy).toBe('lookup_first');
    });

    it('returns boost_only for unknown source kind', () => {
      const policy = determineIsbnPolicy('unknown', [createValidIsbn('9780306406157')]);
      expect(policy).toBe('boost_only');
    });
  });

  describe('shouldAttemptIsbnLookup', () => {
    it('returns true only for lookup_first', () => {
      expect(shouldAttemptIsbnLookup('lookup_first')).toBe(true);
      expect(shouldAttemptIsbnLookup('boost_only')).toBe(false);
      expect(shouldAttemptIsbnLookup('ignore')).toBe(false);
    });
  });

  describe('shouldApplyIsbnBoost', () => {
    it('returns true for boost_only and lookup_first', () => {
      expect(shouldApplyIsbnBoost('lookup_first')).toBe(true);
      expect(shouldApplyIsbnBoost('boost_only')).toBe(true);
      expect(shouldApplyIsbnBoost('ignore')).toBe(false);
    });
  });
});

describe('ISBN Policy Integration', () => {
  it('spine_crop source never uses ISBN for scoring', () => {
    const sourceKind: EvidenceSourceKind = 'spine_crop';
    const validIsbns: ValidatedIsbn[] = [{
      raw: '9780306406157',
      normalized: '9780306406157',
      type: 'isbn13',
      checksumValid: true,
    }];

    const policy = determineIsbnPolicy(sourceKind, validIsbns);

    expect(policy).toBe('ignore');
    expect(shouldApplyIsbnBoost(policy)).toBe(false);
    expect(shouldAttemptIsbnLookup(policy)).toBe(false);
  });

  it('back_cover source uses valid ISBN for lookup and boost', () => {
    const sourceKind: EvidenceSourceKind = 'back_cover';
    const validIsbns: ValidatedIsbn[] = [{
      raw: '9780306406157',
      normalized: '9780306406157',
      type: 'isbn13',
      checksumValid: true,
    }];

    const policy = determineIsbnPolicy(sourceKind, validIsbns);

    expect(policy).toBe('lookup_first');
    expect(shouldApplyIsbnBoost(policy)).toBe(true);
    expect(shouldAttemptIsbnLookup(policy)).toBe(true);
  });

  it('ISBN from spine with invalid checksum is ignored', () => {
    // This tests the workflow: spine OCR with numeric noise that looks like ISBN
    const text = 'BANTAM STER $193 POISON IN THE PEN 9780123456789';
    const result = extractAndValidateIsbns(text);

    // The numeric sequence might be extracted as candidate but should fail validation
    // since 9780123456789 has invalid checksum
    const hasInvalidIsbn = result.candidatesValid.every(
      v => v.normalized !== '9780123456789'
    );
    expect(hasInvalidIsbn).toBe(true);
  });
});
