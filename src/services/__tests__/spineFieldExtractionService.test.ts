/**
 * Tests for Spine Field Extraction Service
 */

import {
  extractSpineFieldEvidence,
  hasValidIsbn,
  hasPublisher,
  hasEdition,
  hasYear,
  getIsbn13,
} from '../spineFieldExtractionService';
import type { BookEvidence, BookEvidenceLine } from '../../types';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create mock book evidence from text lines
 */
function createMockEvidence(
  lines: Array<{ text: string; confidence?: number; cropIndex?: number }>
): BookEvidence {
  const mergedLines: BookEvidenceLine[] = lines.map((l, i) => ({
    text: l.text,
    normalizedText: l.text.toLowerCase().replace(/[^\w\s]/g, ''),
    confidence: l.confidence ?? 0.9,
    sourceCropIndex: l.cropIndex ?? 0,
    rotation: 0,
  }));

  return {
    topCrops: [0],
    mergedLines,
    mergedTextBlock: lines.map((l) => l.text).join('\n'),
  };
}

// ============================================================================
// ISBN Extraction Tests
// ============================================================================

describe('ISBN Extraction', () => {
  describe('ISBN-13 extraction', () => {
    it('extracts ISBN-13 with prefix', () => {
      const evidence = createMockEvidence([
        { text: 'ISBN 978-0-06-112008-4' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.isbnCandidates).toHaveLength(1);
      expect(result.isbnCandidates[0].type).toBe('isbn13');
      expect(result.isbnCandidates[0].normalized).toBe('9780061120084');
      expect(result.bestIsbn).toBe('9780061120084');
    });

    it('extracts ISBN-13 without prefix', () => {
      const evidence = createMockEvidence([
        { text: '9780061120084' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.isbnCandidates).toHaveLength(1);
      expect(result.isbnCandidates[0].normalized).toBe('9780061120084');
    });

    it('extracts ISBN-13 with spaces', () => {
      const evidence = createMockEvidence([
        { text: 'ISBN-13: 978 0 06 112008 4' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.isbnCandidates).toHaveLength(1);
      expect(result.isbnCandidates[0].normalized).toBe('9780061120084');
    });
  });

  describe('ISBN-10 extraction', () => {
    it('extracts ISBN-10 with prefix and converts to ISBN-13', () => {
      const evidence = createMockEvidence([
        { text: 'ISBN 0-306-40615-2' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.isbnCandidates).toHaveLength(1);
      expect(result.isbnCandidates[0].type).toBe('isbn10');
      // Should be converted to ISBN-13
      expect(result.isbnCandidates[0].normalized).toBe('9780306406157');
    });

    it('extracts ISBN-10 with X check digit', () => {
      const evidence = createMockEvidence([
        { text: 'ISBN-10: 0-8044-2957-X' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.isbnCandidates).toHaveLength(1);
      expect(result.isbnCandidates[0].type).toBe('isbn10');
    });
  });

  describe('ISBN validation', () => {
    it('rejects invalid ISBN checksum', () => {
      const evidence = createMockEvidence([
        { text: 'ISBN 978-0-06-112008-5' }, // Wrong check digit
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.isbnCandidates).toHaveLength(0);
    });

    it('extracts multiple ISBNs from different lines', () => {
      const evidence = createMockEvidence([
        { text: 'ISBN-13: 978-0-06-112008-4' },
        { text: 'ISBN-10: 0-306-40615-2' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.isbnCandidates.length).toBeGreaterThanOrEqual(1);
      // ISBN-13 should be preferred
      expect(result.isbnCandidates[0].type).toBe('isbn13');
    });
  });
});

// ============================================================================
// Publisher Extraction Tests
// ============================================================================

describe('Publisher Extraction', () => {
  it('detects known publisher names', () => {
    const evidence = createMockEvidence([
      { text: 'Penguin Random House' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.publisherCandidates).toHaveLength(1);
    expect(result.publisherCandidates[0].method).toBe('known-publisher');
    expect(result.bestPublisher).toBeTruthy();
  });

  it('detects publisher keywords in English', () => {
    const evidence = createMockEvidence([
      { text: 'Acme Publishing Company' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.publisherCandidates).toHaveLength(1);
    expect(result.publisherCandidates[0].method).toBe('keyword');
  });

  it('detects publisher keywords in Turkish', () => {
    const evidence = createMockEvidence([
      { text: 'Can Yayınları' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.publisherCandidates).toHaveLength(1);
  });

  it('detects "Published by" pattern', () => {
    const evidence = createMockEvidence([
      { text: 'Published by Acme Corp' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.publisherCandidates).toHaveLength(1);
    expect(result.publisherCandidates[0].method).toBe('pattern');
    expect(result.publisherCandidates[0].value).toBe('Acme Corp');
  });

  it('does not detect false positives on random uppercase words', () => {
    const evidence = createMockEvidence([
      { text: 'THE GREAT GATSBY' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.publisherCandidates).toHaveLength(0);
  });
});

// ============================================================================
// Edition Extraction Tests
// ============================================================================

describe('Edition Extraction', () => {
  describe('English editions', () => {
    it('detects numbered editions (1st, 2nd, 3rd)', () => {
      const testCases = [
        { text: '1st Edition', expectedNumber: 1 },
        { text: '2nd Edition', expectedNumber: 2 },
        { text: '3rd Edition', expectedNumber: 3 },
        { text: '4th Edition', expectedNumber: 4 },
      ];

      for (const { text, expectedNumber } of testCases) {
        const evidence = createMockEvidence([{ text }]);
        const result = extractSpineFieldEvidence(evidence);

        expect(result.editionCandidates).toHaveLength(1);
        expect(result.editionCandidates[0].editionNumber).toBe(expectedNumber);
        expect(result.editionCandidates[0].editionType).toBe('numbered');
      }
    });

    it('detects word-based editions', () => {
      const evidence = createMockEvidence([
        { text: 'First Edition' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.editionCandidates).toHaveLength(1);
      expect(result.editionCandidates[0].editionNumber).toBe(1);
    });

    it('detects revised editions', () => {
      const evidence = createMockEvidence([
        { text: 'Revised Edition' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.editionCandidates).toHaveLength(1);
      expect(result.editionCandidates[0].editionType).toBe('revised');
    });

    it('detects updated editions', () => {
      const evidence = createMockEvidence([
        { text: 'Updated Edition 2023' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.editionCandidates.length).toBeGreaterThanOrEqual(1);
      expect(result.editionCandidates[0].editionType).toBe('updated');
    });
  });

  describe('Turkish editions', () => {
    it('detects Turkish numbered editions (baskı)', () => {
      const evidence = createMockEvidence([
        { text: '5. baskı' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.editionCandidates).toHaveLength(1);
      expect(result.editionCandidates[0].editionNumber).toBe(5);
    });

    it('detects Turkish numbered editions (basım)', () => {
      const evidence = createMockEvidence([
        { text: '3. basım' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.editionCandidates).toHaveLength(1);
      expect(result.editionCandidates[0].editionNumber).toBe(3);
    });

    it('detects Turkish volume (cilt)', () => {
      const evidence = createMockEvidence([
        { text: 'Cilt 2' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.editionCandidates).toHaveLength(1);
      expect(result.editionCandidates[0].editionNumber).toBe(2);
    });
  });
});

// ============================================================================
// Year Extraction Tests
// ============================================================================

describe('Year Extraction', () => {
  it('extracts copyright year', () => {
    const evidence = createMockEvidence([
      { text: 'Copyright © 2019' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.yearCandidates).toHaveLength(1);
    expect(result.yearCandidates[0].year).toBe(2019);
    expect(result.yearCandidates[0].context).toBe('copyright');
    expect(result.bestYear).toBe(2019);
  });

  it('extracts copyright year with (c)', () => {
    const evidence = createMockEvidence([
      { text: '(c) 2015 by Author Name' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.yearCandidates.length).toBeGreaterThanOrEqual(1);
    expect(result.yearCandidates[0].year).toBe(2015);
  });

  it('extracts standalone year', () => {
    const evidence = createMockEvidence([
      { text: 'Published 2020' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.yearCandidates.length).toBeGreaterThanOrEqual(1);
    expect(result.yearCandidates.some((y) => y.year === 2020)).toBe(true);
  });

  it('rejects invalid years (too old)', () => {
    const evidence = createMockEvidence([
      { text: 'Year 1750' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.yearCandidates.filter((y) => y.year === 1750)).toHaveLength(0);
  });

  it('rejects invalid years (too new)', () => {
    const evidence = createMockEvidence([
      { text: 'Year 2099' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.yearCandidates.filter((y) => y.year === 2099)).toHaveLength(0);
  });

  it('prefers copyright year over standalone year', () => {
    const evidence = createMockEvidence([
      { text: '2018' },
      { text: 'Copyright 2019' },
    ]);
    const result = extractSpineFieldEvidence(evidence);

    expect(result.yearCandidates[0].context).toBe('copyright');
    expect(result.bestYear).toBe(2019);
  });
});

// ============================================================================
// Title/Author Extraction Tests
// ============================================================================

describe('Title/Author Extraction', () => {
  describe('Combined line splitting', () => {
    it('splits "Author • Title" pattern', () => {
      const evidence = createMockEvidence([
        { text: 'Harper Lee • To Kill a Mockingbird' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.authorCandidates.some((a) => a.value === 'Harper Lee')).toBe(true);
      expect(result.titleCandidates.some((t) => t.value === 'To Kill a Mockingbird')).toBe(true);

      // Check fromSplit flag
      const author = result.authorCandidates.find((a) => a.value === 'Harper Lee');
      expect(author?.fromSplit).toBe(true);
    });

    it('splits "Author | Title" pattern', () => {
      const evidence = createMockEvidence([
        { text: 'George Orwell | 1984' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.authorCandidates.some((a) => a.value === 'George Orwell')).toBe(true);
    });

    it('splits "Title - Author" pattern', () => {
      const evidence = createMockEvidence([
        { text: 'The Great Gatsby - F. Scott Fitzgerald' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.titleCandidates.some((t) => t.value === 'The Great Gatsby')).toBe(true);
      expect(result.authorCandidates.some((a) => a.value === 'F. Scott Fitzgerald')).toBe(true);
    });

    it('handles Turkish combined pattern', () => {
      // Use a clear author name pattern
      const evidence = createMockEvidence([
        { text: 'Elif Shafak • The Bastard of Istanbul' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.authorCandidates.some((a) => a.value === 'Elif Shafak')).toBe(true);
      expect(result.titleCandidates.some((t) => t.value === 'The Bastard of Istanbul')).toBe(true);
    });
  });

  describe('By pattern extraction', () => {
    it('extracts author from "by Author" pattern', () => {
      const evidence = createMockEvidence([
        { text: 'by Stephen King' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.authorCandidates).toHaveLength(1);
      expect(result.authorCandidates[0].value).toBe('Stephen King');
      expect(result.authorCandidates[0].fromByPattern).toBe(true);
    });

    it('extracts author from Turkish "yazan" pattern', () => {
      const evidence = createMockEvidence([
        { text: 'Yazan: Elif Şafak' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.authorCandidates).toHaveLength(1);
      expect(result.authorCandidates[0].fromByPattern).toBe(true);
    });

    it('extracts author from "written by" pattern', () => {
      const evidence = createMockEvidence([
        { text: 'Written by J.K. Rowling' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.authorCandidates).toHaveLength(1);
      expect(result.authorCandidates[0].value).toBe('J.K. Rowling');
    });
  });

  describe('Author name detection', () => {
    it('recognizes person names with initials', () => {
      const evidence = createMockEvidence([
        { text: 'J.R.R. Tolkien' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.authorCandidates.some((a) => a.value === 'J.R.R. Tolkien')).toBe(true);
    });

    it('recognizes two-word person names', () => {
      const evidence = createMockEvidence([
        { text: 'Jane Austen' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.authorCandidates.some((a) => a.value === 'Jane Austen')).toBe(true);
    });

    it('does not classify long text as author', () => {
      const evidence = createMockEvidence([
        { text: 'The Complete Guide to Modern Web Development with React and Node.js' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      // Should be classified as title, not author
      expect(result.titleCandidates.length).toBeGreaterThanOrEqual(1);
      expect(result.authorCandidates.filter((a) =>
        a.value.includes('Complete Guide')
      )).toHaveLength(0);
    });
  });

  describe('Title detection', () => {
    it('classifies longer text as title', () => {
      const evidence = createMockEvidence([
        { text: 'Pride and Prejudice' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.titleCandidates.some((t) => t.value === 'Pride and Prejudice')).toBe(true);
    });

    it('prefers text starting with article as title', () => {
      const evidence = createMockEvidence([
        { text: 'The Catcher in the Rye' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(result.titleCandidates.some((t) => t.value === 'The Catcher in the Rye')).toBe(true);
    });
  });
});

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('Utility Functions', () => {
  describe('hasValidIsbn', () => {
    it('returns true when ISBN exists', () => {
      const evidence = createMockEvidence([
        { text: 'ISBN 978-0-06-112008-4' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(hasValidIsbn(result)).toBe(true);
    });

    it('returns false when no ISBN', () => {
      const evidence = createMockEvidence([
        { text: 'No ISBN here' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(hasValidIsbn(result)).toBe(false);
    });
  });

  describe('hasPublisher', () => {
    it('returns true when publisher exists', () => {
      const evidence = createMockEvidence([
        { text: 'Penguin Books' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(hasPublisher(result)).toBe(true);
    });
  });

  describe('hasEdition', () => {
    it('returns true when edition exists', () => {
      const evidence = createMockEvidence([
        { text: '2nd Edition' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(hasEdition(result)).toBe(true);
    });
  });

  describe('hasYear', () => {
    it('returns true when year exists', () => {
      const evidence = createMockEvidence([
        { text: 'Copyright 2020' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(hasYear(result)).toBe(true);
    });
  });

  describe('getIsbn13', () => {
    it('returns ISBN-13 from evidence', () => {
      const evidence = createMockEvidence([
        { text: 'ISBN 978-0-06-112008-4' },
      ]);
      const result = extractSpineFieldEvidence(evidence);

      expect(getIsbn13(result)).toBe('9780061120084');
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Full Extraction Integration', () => {
  it('extracts all fields from complete book spine', () => {
    const evidence = createMockEvidence([
      { text: 'To Kill a Mockingbird' },
      { text: 'Harper Lee' },
      { text: 'ISBN 978-0-06-112008-4' },
      { text: 'HarperCollins Publishers' },
      { text: '50th Anniversary Edition' },
      { text: 'Copyright © 2010' },
    ]);

    const result = extractSpineFieldEvidence(evidence);

    expect(result.bestTitle).toBeTruthy();
    expect(result.bestAuthor).toBeTruthy();
    expect(result.bestIsbn).toBe('9780061120084');
    expect(result.bestPublisher).toBeTruthy();
    expect(result.editionCandidates.length).toBeGreaterThanOrEqual(1);
    expect(result.bestYear).toBe(2010);
  });

  it('handles minimal spine with only title', () => {
    const evidence = createMockEvidence([
      { text: 'The Great Gatsby' },
    ]);

    const result = extractSpineFieldEvidence(evidence);

    expect(result.titleCandidates.length).toBeGreaterThanOrEqual(1);
    expect(result.isbnCandidates).toHaveLength(0);
    expect(result.publisherCandidates).toHaveLength(0);
  });

  it('handles mixed language spine', () => {
    const evidence = createMockEvidence([
      { text: 'Masumiyet Müzesi' },
      { text: 'Orhan Pamuk' },
      { text: 'Yapi Kredi Yayinlari' }, // ASCII normalized for matching
      { text: '15. baski' }, // ASCII normalized
    ]);

    const result = extractSpineFieldEvidence(evidence);

    expect(result.titleCandidates.length).toBeGreaterThanOrEqual(1);
    expect(result.authorCandidates.length).toBeGreaterThanOrEqual(1);
    expect(result.publisherCandidates.length).toBeGreaterThanOrEqual(1);
    expect(result.editionCandidates[0]?.editionNumber).toBe(15);
  });

  it('respects confidence filtering', () => {
    const evidence = createMockEvidence([
      { text: 'The Great Book Title', confidence: 0.9 },
      { text: 'John Smith', confidence: 0.2 },
    ]);

    const result = extractSpineFieldEvidence(evidence, { minConfidence: 0.4 });

    // High confidence items should be kept
    expect(result.titleCandidates.length).toBeGreaterThanOrEqual(1);
    // Low confidence author line (0.2 * nameScore) should be filtered
    const lowConfAuthors = result.authorCandidates.filter(
      (a) => a.value === 'John Smith'
    );
    expect(lowConfAuthors).toHaveLength(0);
  });
});
