/**
 * Jest tests for OCR post-processing service
 * Tests text normalization, junk filtering, and title/author extraction
 */

import {
  normalizeWhitespace,
  normalizeOCRErrors,
  normalizeText,
  calculateAlnumRatio,
  isNoiseLine,
  filterNoiseLines,
  isPersonName,
  extractAuthorFromByPrefix,
  scoreTitleCandidate,
  scoreAuthorCandidate,
  processOCRLines,
  extractMetadataFromOCR,
  aggregateSessionMetadata,
  getFinalSessionMetadata,
} from '../ocrPostProcessingService';
import type { OCRResult, OCRLine } from '../../types';

// Helper to create mock OCR result
function createMockOCRResult(overrides: Partial<OCRResult> = {}): OCRResult {
  return {
    ok: true,
    chosenRotation: 0,
    fullText: '',
    lines: [],
    avgConfidence: 0.8,
    alnumRatio: 0.9,
    charCount: 50,
    lineCount: 3,
    titleCandidate: null,
    authorCandidate: null,
    platform: 'ios',
    ...overrides,
  };
}

// Helper to create mock OCR line
function createMockLine(text: string, confidence = 0.9): OCRLine {
  return {
    text,
    confidence,
    bbox: { x: 0, y: 0, width: 100, height: 20 },
  };
}

describe('normalizeWhitespace', () => {
  it('should collapse multiple spaces', () => {
    expect(normalizeWhitespace('Multiple   Spaces')).toBe('Multiple Spaces');
  });

  it('should trim leading and trailing whitespace', () => {
    expect(normalizeWhitespace('  Leading')).toBe('Leading');
    expect(normalizeWhitespace('Trailing  ')).toBe('Trailing');
  });

  it('should convert tabs and newlines to spaces', () => {
    expect(normalizeWhitespace('Tabs\t\tHere')).toBe('Tabs Here');
    expect(normalizeWhitespace('Line\nBreak')).toBe('Line Break');
  });

  it('should handle empty string', () => {
    expect(normalizeWhitespace('')).toBe('');
  });
});

describe('normalizeOCRErrors', () => {
  it('should normalize different apostrophe styles', () => {
    expect(normalizeOCRErrors("it's")).toBe("it's");
    expect(normalizeOCRErrors("it's")).toBe("it's");
    expect(normalizeOCRErrors("it`s")).toBe("it's");
  });

  it('should normalize different quote styles', () => {
    expect(normalizeOCRErrors('"hello"')).toBe('"hello"');
    expect(normalizeOCRErrors('„hello"')).toBe('"hello"');
  });

  it('should normalize different dash styles', () => {
    expect(normalizeOCRErrors('word–word')).toBe('word-word');
    expect(normalizeOCRErrors('word—word')).toBe('word-word');
  });

  it('should normalize ellipsis', () => {
    expect(normalizeOCRErrors('wait…')).toBe('wait...');
  });

  it('should convert pipe to I', () => {
    expect(normalizeOCRErrors('|mportant')).toBe('Important');
  });
});

describe('normalizeText', () => {
  it('should apply both whitespace and OCR normalization', () => {
    expect(normalizeText('  Multiple   Spaces  with "quotes"  ')).toBe('Multiple Spaces with "quotes"');
  });
});

describe('calculateAlnumRatio', () => {
  it('should return 1 for all alphanumeric', () => {
    expect(calculateAlnumRatio('Hello123')).toBe(1);
  });

  it('should return correct ratio for mixed text', () => {
    expect(calculateAlnumRatio('Hi!')).toBeCloseTo(0.667, 2);
  });

  it('should return 0 for empty string', () => {
    expect(calculateAlnumRatio('')).toBe(0);
  });

  it('should return 0 for all symbols', () => {
    expect(calculateAlnumRatio('!!!')).toBe(0);
  });
});

describe('isNoiseLine', () => {
  it('should identify lines that are too short', () => {
    expect(isNoiseLine('a')).toBe(true);
    expect(isNoiseLine('')).toBe(true);
  });

  it('should identify lines with low alphanumeric ratio', () => {
    expect(isNoiseLine('***###!!!')).toBe(true);
    expect(isNoiseLine('...')).toBe(true);
  });

  it('should identify noise patterns', () => {
    expect(isNoiseLine('$19.99')).toBe(true);
    expect(isNoiseLine('ISBN 978-0-123-45678-9')).toBe(true);
    expect(isNoiseLine('www.example.com')).toBe(true);
    expect(isNoiseLine('© 2024')).toBe(true);
    expect(isNoiseLine('2024')).toBe(true);
  });

  it('should identify repeated characters', () => {
    expect(isNoiseLine('aaaaaaaa')).toBe(true);
    expect(isNoiseLine('----------')).toBe(true);
  });

  it('should accept normal text', () => {
    expect(isNoiseLine('The Great Gatsby')).toBe(false);
    expect(isNoiseLine('John Smith')).toBe(false);
  });
});

describe('filterNoiseLines', () => {
  it('should remove noise lines from array', () => {
    const lines = ['The Great Gatsby', '***', 'F. Scott Fitzgerald', '$12.99'];
    const filtered = filterNoiseLines(lines);
    expect(filtered).toEqual(['The Great Gatsby', 'F. Scott Fitzgerald']);
  });
});

describe('isPersonName', () => {
  it('should recognize valid person names', () => {
    expect(isPersonName('John Smith')).toBe(true);
    expect(isPersonName('Mary Jane Watson')).toBe(true);
    expect(isPersonName('Arthur Conan Doyle')).toBe(true);
  });

  it('should reject single tokens', () => {
    expect(isPersonName('John')).toBe(false);
  });

  it('should reject too many tokens', () => {
    expect(isPersonName('One Two Three Four Five')).toBe(false);
  });

  it('should reject all lowercase', () => {
    expect(isPersonName('john smith')).toBe(false);
  });

  it('should reject all uppercase (likely title)', () => {
    expect(isPersonName('THE GREAT GATSBY')).toBe(false);
  });

  it('should accept initials', () => {
    expect(isPersonName('J Smith')).toBe(true);
    expect(isPersonName('J. Smith')).toBe(true);
  });
});

describe('extractAuthorFromByPrefix', () => {
  it('should extract author from "by Author" pattern', () => {
    expect(extractAuthorFromByPrefix('by John Smith')).toBe('John Smith');
    expect(extractAuthorFromByPrefix('By Jane Austen')).toBe('Jane Austen');
  });

  it('should extract from "written by" pattern', () => {
    expect(extractAuthorFromByPrefix('written by Ernest Hemingway')).toBe('Ernest Hemingway');
  });

  it('should return null if no pattern matches', () => {
    expect(extractAuthorFromByPrefix('The Great Gatsby')).toBeNull();
    expect(extractAuthorFromByPrefix('John Smith')).toBeNull();
  });

  it('should return null if extracted name is not valid', () => {
    expect(extractAuthorFromByPrefix('by 123')).toBeNull();
    expect(extractAuthorFromByPrefix('by $$$')).toBeNull();
  });
});

describe('scoreTitleCandidate', () => {
  it('should give higher score to confident, moderate-length titles', () => {
    const score1 = scoreTitleCandidate('The Great Gatsby', 0, 5, 0.95);
    const score2 = scoreTitleCandidate('OK', 0, 5, 0.5); // Short title with lower confidence
    expect(score1).toBeGreaterThan(score2);
  });

  it('should prefer earlier lines', () => {
    const score1 = scoreTitleCandidate('Book Title', 0, 10, 0.9);
    const score2 = scoreTitleCandidate('Book Title', 8, 10, 0.9);
    expect(score1).toBeGreaterThan(score2);
  });

  it('should penalize author patterns', () => {
    const scoreTitle = scoreTitleCandidate('The Great Gatsby', 0, 5, 0.9);
    const scoreAuthorLine = scoreTitleCandidate('by John Smith', 0, 5, 0.9);
    expect(scoreTitle).toBeGreaterThan(scoreAuthorLine);
  });
});

describe('scoreAuthorCandidate', () => {
  it('should give high score to "by" prefix patterns', () => {
    const score = scoreAuthorCandidate('by John Smith', 1, 5, 0.9);
    expect(score).toBeGreaterThan(0.5);
  });

  it('should give good score to person names', () => {
    const score = scoreAuthorCandidate('John Smith', 1, 5, 0.9);
    expect(score).toBeGreaterThan(0.3);
  });

  it('should prefer middle positions', () => {
    const score1 = scoreAuthorCandidate('John Smith', 2, 10, 0.9);
    const score2 = scoreAuthorCandidate('John Smith', 9, 10, 0.9);
    expect(score1).toBeGreaterThan(score2);
  });
});

describe('processOCRLines', () => {
  it('should categorize lines correctly', () => {
    const lines: OCRLine[] = [
      createMockLine('The Great Gatsby', 0.95),
      createMockLine('by F. Scott Fitzgerald', 0.9),
      createMockLine('***', 0.5),
    ];

    const processed = processOCRLines(lines);

    expect(processed).toHaveLength(3);
    expect(processed[0].lineType).toBe('title');
    expect(processed[1].lineType).toBe('author');
    expect(processed[2].lineType).toBe('noise');
  });

  it('should normalize text', () => {
    const lines: OCRLine[] = [
      createMockLine('  Multiple   Spaces  ', 0.9),
    ];

    const processed = processOCRLines(lines);
    expect(processed[0].normalized).toBe('Multiple Spaces');
  });
});

describe('extractMetadataFromOCR', () => {
  it('should extract title and author from OCR result', () => {
    const result = createMockOCRResult({
      ok: true,
      lines: [
        createMockLine('The Great Gatsby', 0.95),
        createMockLine('by F. Scott Fitzgerald', 0.9),
      ],
    });

    const metadata = extractMetadataFromOCR(result);

    expect(metadata.title).toBe('The Great Gatsby');
    expect(metadata.author).toBe('F. Scott Fitzgerald');
    expect(metadata.titleSource).toBe('ocr_heuristic');
    expect(metadata.authorSource).toBe('by_prefix');
  });

  it('should return null for failed OCR', () => {
    const result = createMockOCRResult({ ok: false });
    const metadata = extractMetadataFromOCR(result);

    expect(metadata.title).toBeNull();
    expect(metadata.author).toBeNull();
  });

  it('should use native titleCandidate as fallback', () => {
    const result = createMockOCRResult({
      ok: true,
      titleCandidate: 'Native Title',
      lines: [],
    });

    const metadata = extractMetadataFromOCR(result);
    expect(metadata.title).toBe('Native Title');
  });

  it('should prioritize extracted author over native', () => {
    const result = createMockOCRResult({
      ok: true,
      authorCandidate: 'Native Author',
      lines: [
        createMockLine('by John Smith', 0.9),
      ],
    });

    const metadata = extractMetadataFromOCR(result);
    expect(metadata.author).toBe('John Smith');
  });
});

describe('aggregateSessionMetadata', () => {
  it('should find consensus title from multiple crops', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({
        ok: true,
        lines: [createMockLine('The Great Gatsby', 0.9)],
      }),
      1: createMockOCRResult({
        ok: true,
        lines: [createMockLine('The Great Gatsby', 0.95)],
      }),
      2: createMockOCRResult({
        ok: true,
        lines: [createMockLine('Different Title', 0.8)],
      }),
    };

    const aggregation = aggregateSessionMetadata(results);

    expect(aggregation.bestTitle?.toLowerCase()).toBe('the great gatsby');
    expect(aggregation.cropCount).toBe(3);
  });

  it('should handle empty results', () => {
    const aggregation = aggregateSessionMetadata({});
    expect(aggregation.bestTitle).toBeNull();
    expect(aggregation.cropCount).toBe(0);
  });

  it('should skip failed OCR results', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({ ok: false }),
      1: createMockOCRResult({
        ok: true,
        lines: [createMockLine('Valid Title', 0.9)],
      }),
    };

    const aggregation = aggregateSessionMetadata(results);
    expect(aggregation.cropCount).toBe(1);
  });
});

describe('getFinalSessionMetadata', () => {
  it('should prioritize user edits over OCR', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({
        ok: true,
        lines: [createMockLine('OCR Title', 0.9)],
      }),
    };

    const userEdits = {
      0: { title: 'User Title', author: 'User Author' },
    };

    const final = getFinalSessionMetadata(results, userEdits);

    expect(final.title).toBe('User Title');
    expect(final.author).toBe('User Author');
    expect(final.source).toBe('user_edit');
  });

  it('should use aggregation when no user edits', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({
        ok: true,
        lines: [createMockLine('OCR Title', 0.9)],
      }),
      1: createMockOCRResult({
        ok: true,
        lines: [createMockLine('OCR Title', 0.9)],
      }),
    };

    const final = getFinalSessionMetadata(results);

    expect(final.source).toBe('aggregation');
  });

  it('should indicate single_crop source for single result', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({
        ok: true,
        lines: [createMockLine('Single Title', 0.9)],
      }),
    };

    const final = getFinalSessionMetadata(results);
    expect(final.source).toBe('single_crop');
  });
});
