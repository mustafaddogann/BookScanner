/**
 * Unit tests for ISBN utilities
 */

import {
  normalizeIsbn,
  isValidIsbn10,
  isValidIsbn13,
  isValidIsbn,
  isbn10ToIsbn13,
  isbn13ToIsbn10,
  areIsbnsEquivalent,
  extractIsbnsFromText,
  findFirstIsbn,
  formatIsbn13,
  formatIsbn10,
} from '../isbnUtils';

describe('normalizeIsbn', () => {
  it('should remove hyphens', () => {
    expect(normalizeIsbn('978-0-06-112008-4')).toBe('9780061120084');
  });

  it('should remove spaces', () => {
    expect(normalizeIsbn('978 0 06 112008 4')).toBe('9780061120084');
  });

  it('should uppercase X', () => {
    expect(normalizeIsbn('0-06-112008-x')).toBe('006112008X');
  });

  it('should handle mixed separators', () => {
    expect(normalizeIsbn('978-0 06-112008 4')).toBe('9780061120084');
  });
});

describe('isValidIsbn10', () => {
  it('should validate correct ISBN-10', () => {
    expect(isValidIsbn10('0306406152')).toBe(true);
    expect(isValidIsbn10('0-306-40615-2')).toBe(true);
  });

  it('should validate ISBN-10 with X check digit', () => {
    expect(isValidIsbn10('080442957X')).toBe(true);
  });

  it('should reject invalid ISBN-10', () => {
    expect(isValidIsbn10('0306406151')).toBe(false); // Wrong check digit
    expect(isValidIsbn10('12345')).toBe(false); // Too short
    expect(isValidIsbn10('12345678901')).toBe(false); // Too long
    expect(isValidIsbn10('030640615A')).toBe(false); // Invalid character
  });
});

describe('isValidIsbn13', () => {
  it('should validate correct ISBN-13', () => {
    expect(isValidIsbn13('9780306406157')).toBe(true);
    expect(isValidIsbn13('978-0-306-40615-7')).toBe(true);
  });

  it('should reject invalid ISBN-13', () => {
    expect(isValidIsbn13('9780306406156')).toBe(false); // Wrong check digit
    expect(isValidIsbn13('978030640615')).toBe(false); // Too short
    expect(isValidIsbn13('97803064061577')).toBe(false); // Too long
    expect(isValidIsbn13('978030640615X')).toBe(false); // X not valid in ISBN-13
  });

  it('should validate 979 prefix ISBNs', () => {
    // 979 prefix ISBNs are valid but can't convert to ISBN-10
    expect(isValidIsbn13('9791234567896')).toBe(true);
  });
});

describe('isValidIsbn', () => {
  it('should validate both ISBN-10 and ISBN-13', () => {
    expect(isValidIsbn('0306406152')).toBe(true);
    expect(isValidIsbn('9780306406157')).toBe(true);
  });

  it('should reject invalid ISBNs', () => {
    expect(isValidIsbn('invalid')).toBe(false);
    expect(isValidIsbn('12345')).toBe(false);
  });
});

describe('isbn10ToIsbn13', () => {
  it('should convert ISBN-10 to ISBN-13', () => {
    expect(isbn10ToIsbn13('0306406152')).toBe('9780306406157');
  });

  it('should handle ISBN-10 with hyphens', () => {
    expect(isbn10ToIsbn13('0-306-40615-2')).toBe('9780306406157');
  });

  it('should handle ISBN-10 with X', () => {
    const result = isbn10ToIsbn13('080442957X');
    expect(result).toBeTruthy();
    expect(result?.length).toBe(13);
    expect(result?.startsWith('978')).toBe(true);
  });

  it('should return null for invalid input', () => {
    expect(isbn10ToIsbn13('12345')).toBeNull();
    expect(isbn10ToIsbn13('9780306406157')).toBeNull(); // Already ISBN-13
  });
});

describe('isbn13ToIsbn10', () => {
  it('should convert ISBN-13 to ISBN-10', () => {
    expect(isbn13ToIsbn10('9780306406157')).toBe('0306406152');
  });

  it('should handle ISBN-13 with hyphens', () => {
    expect(isbn13ToIsbn10('978-0-306-40615-7')).toBe('0306406152');
  });

  it('should return null for 979 prefix', () => {
    expect(isbn13ToIsbn10('9791234567896')).toBeNull();
  });

  it('should return null for invalid input', () => {
    expect(isbn13ToIsbn10('0306406152')).toBeNull(); // Already ISBN-10
  });
});

describe('areIsbnsEquivalent', () => {
  it('should match identical ISBNs', () => {
    expect(areIsbnsEquivalent('9780306406157', '9780306406157')).toBe(true);
    expect(areIsbnsEquivalent('0306406152', '0306406152')).toBe(true);
  });

  it('should match ISBN-10 with its ISBN-13 equivalent', () => {
    expect(areIsbnsEquivalent('0306406152', '9780306406157')).toBe(true);
    expect(areIsbnsEquivalent('9780306406157', '0306406152')).toBe(true);
  });

  it('should match with different formatting', () => {
    expect(areIsbnsEquivalent('978-0-306-40615-7', '9780306406157')).toBe(true);
    expect(areIsbnsEquivalent('0-306-40615-2', '978-0-306-40615-7')).toBe(true);
  });

  it('should not match different books', () => {
    expect(areIsbnsEquivalent('0306406152', '0061120081')).toBe(false);
  });

  it('should not match invalid ISBNs', () => {
    expect(areIsbnsEquivalent('invalid', '9780306406157')).toBe(false);
  });
});

describe('extractIsbnsFromText', () => {
  it('should extract ISBN-13 from text', () => {
    const text = 'ISBN: 978-0-06-112008-4';
    const isbns = extractIsbnsFromText(text);
    expect(isbns).toContain('9780061120084');
  });

  it('should extract ISBN-10 and convert to ISBN-13', () => {
    const text = 'ISBN 0-306-40615-2';
    const isbns = extractIsbnsFromText(text);
    expect(isbns.length).toBeGreaterThan(0);
    // Should be stored as ISBN-13
    expect(isbns[0].length).toBe(13);
  });

  it('should extract multiple ISBNs', () => {
    const text = 'First: 978-0-06-112008-4, Second: 978-0-306-40615-7';
    const isbns = extractIsbnsFromText(text);
    expect(isbns.length).toBe(2);
  });

  it('should not include invalid ISBNs', () => {
    const text = 'Invalid ISBN: 1234567890';
    const isbns = extractIsbnsFromText(text);
    expect(isbns.length).toBe(0);
  });

  it('should handle text without ISBNs', () => {
    const text = 'This book has no ISBN number listed.';
    const isbns = extractIsbnsFromText(text);
    expect(isbns.length).toBe(0);
  });

  it('should handle ISBNs in OCR-like text', () => {
    const text = `
      The Great Gatsby
      F. Scott Fitzgerald
      ISBN-13: 978-0-7432-7356-5
      Copyright 2004
    `;
    const isbns = extractIsbnsFromText(text);
    expect(isbns.length).toBeGreaterThan(0);
  });
});

describe('findFirstIsbn', () => {
  it('should return first valid ISBN', () => {
    const text = 'ISBN: 978-0-06-112008-4 and 978-0-306-40615-7';
    const isbn = findFirstIsbn(text);
    expect(isbn).toBe('9780061120084');
  });

  it('should return null for text without ISBNs', () => {
    const text = 'No ISBN here';
    expect(findFirstIsbn(text)).toBeNull();
  });
});

describe('formatIsbn13', () => {
  it('should format ISBN-13 with hyphens', () => {
    const formatted = formatIsbn13('9780061120084');
    expect(formatted).toContain('-');
    expect(formatted.replace(/-/g, '')).toBe('9780061120084');
  });

  it('should return original for invalid length', () => {
    expect(formatIsbn13('12345')).toBe('12345');
  });
});

describe('formatIsbn10', () => {
  it('should format ISBN-10 with hyphens', () => {
    const formatted = formatIsbn10('0306406152');
    expect(formatted).toContain('-');
    expect(formatted.replace(/-/g, '')).toBe('0306406152');
  });

  it('should return original for invalid length', () => {
    expect(formatIsbn10('12345')).toBe('12345');
  });
});
