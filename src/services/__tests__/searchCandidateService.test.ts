/**
 * Tests for Search Candidate Service
 */

import {
  generateSearchCandidates,
  buildSearchQuery,
  extractTitleHint,
  extractAuthorHint,
  generateIsbnCandidate,
  generateMergedEvidenceCandidate,
  GenerateCandidatesInput,
} from '../searchCandidateService';
import type {
  EvidenceSummary,
  OCRResult,
  BookEvidence,
  BookEvidenceLine,
} from '../../types';

// Mock the debug config to control feature flags
jest.mock('../../config/debug', () => ({
  isMetadataVerboseDebug: jest.fn().mockReturnValue(false),
  isFieldExtractionEnabled: jest.fn().mockReturnValue(false),
}));

import { isFieldExtractionEnabled } from '../../config/debug';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock OCR result
 */
function createMockOCR(options: {
  lines: Array<{ text: string; confidence?: number }>;
  avgConfidence?: number;
  fullText?: string;
  titleCandidate?: string;
  authorCandidate?: string;
}): OCRResult {
  const lines = options.lines.map((l, i) => ({
    text: l.text,
    confidence: l.confidence ?? 0.9,
    bbox: {
      x: 0,
      y: i * 20,
      width: 100,
      height: 20,
    },
  }));

  const fullText = options.fullText ?? lines.map((l) => l.text).join('\n');

  return {
    ok: true,
    lines,
    fullText,
    avgConfidence: options.avgConfidence ?? 0.85,
    titleCandidate: options.titleCandidate ?? null,
    authorCandidate: options.authorCandidate ?? null,
    chosenRotation: 0,
    alnumRatio: 0.9,
    charCount: fullText.length,
    lineCount: lines.length,
  };
}

/**
 * Create mock evidence summary
 */
function createMockEvidenceSummary(options: {
  sessionTier?: 'strong' | 'usable' | 'weak' | 'unusable';
  cropIndices?: number[];
  cropTiers?: Array<'strong' | 'usable' | 'weak' | 'unusable'>;
}): EvidenceSummary {
  const cropIndices = options.cropIndices ?? [0];
  const cropTiers = options.cropTiers ?? ['usable'];

  // Count tiers
  const tierCounts = { strong: 0, usable: 0, weak: 0, unusable: 0 };
  for (const tier of cropTiers) {
    tierCounts[tier]++;
  }

  return {
    sessionTier: options.sessionTier ?? 'usable',
    cropClassifications: cropIndices.map((idx, i) => ({
      cropIndex: idx,
      tier: cropTiers[i] ?? 'usable',
      ocrConfidence: 0.85,
      charCount: 100,
      alnumRatio: 0.9,
      rectificationStatus: 'success' as const,
    })),
    tierCounts,
  };
}

/**
 * Create mock book evidence for field extraction
 */
function createMockBookEvidence(
  lines: Array<{ text: string; confidence?: number }>
): BookEvidence {
  const mergedLines: BookEvidenceLine[] = lines.map((l, i) => ({
    text: l.text,
    normalizedText: l.text.toLowerCase().replace(/[^\w\s]/g, ''),
    confidence: l.confidence ?? 0.9,
    sourceCropIndex: 0,
    rotation: 0,
  }));

  return {
    topCrops: [0],
    mergedLines,
    mergedTextBlock: lines.map((l) => l.text).join('\n'),
  };
}

// ============================================================================
// buildSearchQuery Tests
// ============================================================================

describe('buildSearchQuery', () => {
  it('builds query from high-confidence lines', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'The Great Gatsby', confidence: 0.95 },
        { text: 'F. Scott Fitzgerald', confidence: 0.90 },
        { text: 'Page 1', confidence: 0.85 },
      ],
    });

    const query = buildSearchQuery(ocr);

    expect(query).toContain('great');
    expect(query).toContain('gatsby');
    expect(query).toContain('scott');
    expect(query).toContain('fitzgerald');
    // Should filter noise like 'page'
    expect(query).not.toContain('page');
  });

  it('filters low-confidence lines', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'Clear Title', confidence: 0.95 },
        { text: 'Garbled Text', confidence: 0.3 },
      ],
    });

    const query = buildSearchQuery(ocr);

    expect(query).toContain('clear');
    expect(query).toContain('title');
    expect(query).not.toContain('garbled');
  });

  it('filters noise tokens', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'Copyright 2023 All Rights Reserved', confidence: 0.9 },
        { text: 'Penguin Publishing Books', confidence: 0.9 },
        { text: 'Real Content Here', confidence: 0.9 },
      ],
    });

    const query = buildSearchQuery(ocr);

    // Should filter publishing-related noise
    expect(query).not.toContain('publishing');
    expect(query).not.toContain('books');
    expect(query).toContain('real');
    expect(query).toContain('content');
  });

  it('skips copyright lines', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'Copyright 2023 by Author', confidence: 0.9 },
        { text: 'The Book Title', confidence: 0.9 },
      ],
    });

    const query = buildSearchQuery(ocr);

    expect(query).toContain('book');
    expect(query).toContain('title');
  });

  it('skips ISBN lines', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'ISBN 978-0-06-112008-4', confidence: 0.9 },
        { text: 'The Book Title', confidence: 0.9 },
      ],
    });

    const query = buildSearchQuery(ocr);

    expect(query).toContain('book');
    expect(query).toContain('title');
  });
});

// ============================================================================
// extractTitleHint Tests
// ============================================================================

describe('extractTitleHint', () => {
  it('uses titleCandidate if available', () => {
    const ocr = createMockOCR({
      lines: [{ text: 'Random Text' }],
      titleCandidate: 'The Real Title',
    });

    const title = extractTitleHint(ocr);

    expect(title).toBe('The Real Title');
  });

  it('extracts longest high-confidence line as title', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'Short', confidence: 0.9 },
        { text: 'The Much Longer Book Title', confidence: 0.9 },
        { text: 'Medium Length Text', confidence: 0.9 },
      ],
    });

    const title = extractTitleHint(ocr);

    expect(title).toBe('The Much Longer Book Title');
  });

  it('skips author-like lines', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'By John Smith', confidence: 0.95 },
        { text: 'The Book Title', confidence: 0.90 },
      ],
    });

    const title = extractTitleHint(ocr);

    expect(title).toBe('The Book Title');
    expect(title).not.toContain('John Smith');
  });

  it('returns undefined if no good lines', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'By Author', confidence: 0.9 },
        { text: 'ISBN 123', confidence: 0.3 },
      ],
    });

    const title = extractTitleHint(ocr);

    expect(title).toBeUndefined();
  });
});

// ============================================================================
// extractAuthorHint Tests
// ============================================================================

describe('extractAuthorHint', () => {
  it('uses authorCandidate if available', () => {
    const ocr = createMockOCR({
      lines: [{ text: 'Random Text' }],
      authorCandidate: 'Jane Doe',
    });

    const author = extractAuthorHint(ocr);

    expect(author).toBe('Jane Doe');
  });

  it('extracts author from "by" pattern', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'The Book Title', confidence: 0.9 },
        { text: 'By John Smith', confidence: 0.9 },
      ],
    });

    const author = extractAuthorHint(ocr);

    expect(author).toBe('John Smith');
  });

  it('extracts author from "author:" pattern', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'Author: Jane Doe', confidence: 0.9 },
      ],
    });

    const author = extractAuthorHint(ocr);

    expect(author).toBe('Jane Doe');
  });

  it('extracts author from name pattern with middle initial', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'Stephen R. King', confidence: 0.9 },
      ],
    });

    const author = extractAuthorHint(ocr);

    expect(author).toBe('Stephen R. King');
  });

  it('returns undefined if no author pattern found', () => {
    const ocr = createMockOCR({
      lines: [
        { text: 'The Book Title', confidence: 0.9 },
        { text: 'More Text', confidence: 0.9 },
      ],
    });

    const author = extractAuthorHint(ocr);

    expect(author).toBeUndefined();
  });
});

// ============================================================================
// generateSearchCandidates Tests
// ============================================================================

describe('generateSearchCandidates', () => {
  beforeEach(() => {
    // Reset mock to default (disabled)
    (isFieldExtractionEnabled as jest.Mock).mockReturnValue(false);
  });

  it('returns empty for unusable tier', () => {
    const input: GenerateCandidatesInput = {
      evidenceSummary: createMockEvidenceSummary({ sessionTier: 'unusable' }),
      ocrResultsByCropIndex: {},
    };

    const result = generateSearchCandidates(input);

    expect(result.candidates).toHaveLength(0);
    expect(result.evidenceTier).toBe('unusable');
    expect(result.fullTextBlock).toBe('');
  });

  it('generates candidates from eligible crops', () => {
    const input: GenerateCandidatesInput = {
      evidenceSummary: createMockEvidenceSummary({
        sessionTier: 'usable',
        cropIndices: [0, 1],
        cropTiers: ['usable', 'usable'],
      }),
      ocrResultsByCropIndex: {
        0: createMockOCR({
          lines: [
            { text: 'First Book Title', confidence: 0.9 },
            { text: 'Author Name', confidence: 0.85 },
          ],
        }),
        1: createMockOCR({
          lines: [
            { text: 'Second Book', confidence: 0.8 },
          ],
        }),
      },
    };

    const result = generateSearchCandidates(input);

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.evidenceTier).toBe('usable');
  });

  it('extracts ISBN from OCR text', () => {
    const input: GenerateCandidatesInput = {
      evidenceSummary: createMockEvidenceSummary({
        sessionTier: 'strong',
        cropIndices: [0],
        cropTiers: ['strong'],
      }),
      ocrResultsByCropIndex: {
        0: createMockOCR({
          lines: [
            { text: 'The Great Book Title', confidence: 0.9 },
            { text: 'By Famous Author', confidence: 0.85 },
          ],
          fullText: 'The Great Book Title\nBy Famous Author\nISBN 978-0-06-112008-4',
        }),
      },
    };

    const result = generateSearchCandidates(input);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].isbn).toBe('9780061120084');
  });

  it('sorts candidates by confidence', () => {
    const input: GenerateCandidatesInput = {
      evidenceSummary: createMockEvidenceSummary({
        sessionTier: 'usable',
        cropIndices: [0, 1],
        cropTiers: ['usable', 'strong'],
      }),
      ocrResultsByCropIndex: {
        0: createMockOCR({
          lines: [{ text: 'Low Confidence Book', confidence: 0.6 }],
          avgConfidence: 0.6,
        }),
        1: createMockOCR({
          lines: [{ text: 'High Confidence Book', confidence: 0.95 }],
          avgConfidence: 0.95,
        }),
      },
    };

    const result = generateSearchCandidates(input);

    // Strong tier with high confidence should come first
    expect(result.candidates[0].confidence).toBeGreaterThan(
      result.candidates[1]?.confidence ?? 0
    );
  });

  it('limits candidates to MAX_CANDIDATES', () => {
    const input: GenerateCandidatesInput = {
      evidenceSummary: createMockEvidenceSummary({
        sessionTier: 'usable',
        cropIndices: [0, 1, 2, 3, 4, 5, 6, 7],
        cropTiers: Array(8).fill('usable'),
      }),
      ocrResultsByCropIndex: Object.fromEntries(
        Array(8)
          .fill(null)
          .map((_, i) => [
            i,
            createMockOCR({
              lines: [{ text: `Book ${i} Title` }],
            }),
          ])
      ),
    };

    const result = generateSearchCandidates(input);

    expect(result.candidates.length).toBeLessThanOrEqual(5);
  });

  describe('without field extraction', () => {
    it('does not include field evidence', () => {
      const input: GenerateCandidatesInput = {
        evidenceSummary: createMockEvidenceSummary({ sessionTier: 'usable' }),
        ocrResultsByCropIndex: {
          0: createMockOCR({
            lines: [{ text: 'Book Title' }],
          }),
        },
        mergedEvidence: createMockBookEvidence([
          { text: 'Book Title' },
          { text: 'Penguin Books' },
        ]),
      };

      const result = generateSearchCandidates(input);

      expect(result.fieldEvidence).toBeUndefined();
      expect(result.candidates[0].publisherHint).toBeUndefined();
    });
  });

  describe('with field extraction enabled', () => {
    beforeEach(() => {
      (isFieldExtractionEnabled as jest.Mock).mockReturnValue(true);
    });

    it('includes field evidence when enabled', () => {
      const input: GenerateCandidatesInput = {
        evidenceSummary: createMockEvidenceSummary({ sessionTier: 'usable' }),
        ocrResultsByCropIndex: {
          0: createMockOCR({
            lines: [{ text: 'Book Title' }],
          }),
        },
        mergedEvidence: createMockBookEvidence([
          { text: 'Book Title' },
          { text: 'John Smith' },
          { text: 'Penguin Books' },
          { text: '2nd Edition' },
          { text: 'Copyright 2023' },
        ]),
      };

      const result = generateSearchCandidates(input);

      expect(result.fieldEvidence).toBeDefined();
      expect(result.fieldEvidence?.publisherCandidates.length).toBeGreaterThan(0);
      expect(result.fieldEvidence?.editionCandidates.length).toBeGreaterThan(0);
      expect(result.fieldEvidence?.yearCandidates.length).toBeGreaterThan(0);
    });

    it('enhances candidates with publisher hint', () => {
      const input: GenerateCandidatesInput = {
        evidenceSummary: createMockEvidenceSummary({ sessionTier: 'usable' }),
        ocrResultsByCropIndex: {
          0: createMockOCR({
            lines: [{ text: 'Book Title' }],
          }),
        },
        mergedEvidence: createMockBookEvidence([
          { text: 'Book Title' },
          { text: 'Penguin Books' },
        ]),
      };

      const result = generateSearchCandidates(input);

      expect(result.candidates[0].publisherHint).toBe('Penguin Books');
    });

    it('enhances candidates with edition hint', () => {
      const input: GenerateCandidatesInput = {
        evidenceSummary: createMockEvidenceSummary({ sessionTier: 'usable' }),
        ocrResultsByCropIndex: {
          0: createMockOCR({
            lines: [{ text: 'Book Title' }],
          }),
        },
        mergedEvidence: createMockBookEvidence([
          { text: 'Book Title' },
          { text: '3rd Edition' },
        ]),
      };

      const result = generateSearchCandidates(input);

      expect(result.candidates[0].editionHint).toBe('3rd Edition');
    });

    it('enhances candidates with year hint', () => {
      const input: GenerateCandidatesInput = {
        evidenceSummary: createMockEvidenceSummary({ sessionTier: 'usable' }),
        ocrResultsByCropIndex: {
          0: createMockOCR({
            lines: [{ text: 'Book Title' }],
          }),
        },
        mergedEvidence: createMockBookEvidence([
          { text: 'Book Title' },
          { text: 'Copyright 2020' },
        ]),
      };

      const result = generateSearchCandidates(input);

      expect(result.candidates[0].yearHint).toBe('2020');
    });

    it('uses field extraction ISBN when validated', () => {
      const input: GenerateCandidatesInput = {
        evidenceSummary: createMockEvidenceSummary({ sessionTier: 'usable' }),
        ocrResultsByCropIndex: {
          0: createMockOCR({
            lines: [{ text: 'Book Title' }],
          }),
        },
        mergedEvidence: createMockBookEvidence([
          { text: 'Book Title' },
          { text: 'ISBN 978-0-06-112008-4' },
        ]),
      };

      const result = generateSearchCandidates(input);

      expect(result.candidates[0].isbn).toBe('9780061120084');
      expect(result.fieldEvidence?.isbnCandidates.length).toBeGreaterThan(0);
    });

    it('uses better title from field extraction', () => {
      const input: GenerateCandidatesInput = {
        evidenceSummary: createMockEvidenceSummary({ sessionTier: 'usable' }),
        ocrResultsByCropIndex: {
          0: createMockOCR({
            lines: [
              { text: 'Short', confidence: 0.9 },
              { text: 'The Real Book Title', confidence: 0.9 },
            ],
            titleCandidate: 'Short', // OCR thinks short is the title
          }),
        },
        mergedEvidence: createMockBookEvidence([
          { text: 'The Real Book Title' },
          { text: 'John Author' },
        ]),
      };

      const result = generateSearchCandidates(input);

      // Field extraction should provide better title
      expect(result.candidates[0].titleHint).toBe('The Real Book Title');
    });
  });
});

// ============================================================================
// generateIsbnCandidate Tests
// ============================================================================

describe('generateIsbnCandidate', () => {
  it('generates ISBN candidate when ISBN found', () => {
    const fullText = 'Some text\nISBN 978-0-06-112008-4\nMore text';

    const candidate = generateIsbnCandidate(fullText, 'usable');

    expect(candidate).not.toBeNull();
    expect(candidate?.isbn).toBe('9780061120084');
    expect(candidate?.query).toBe('9780061120084');
    expect(candidate?.confidence).toBeGreaterThan(0.8);
  });

  it('returns null when no ISBN found', () => {
    const fullText = 'Some text without ISBN';

    const candidate = generateIsbnCandidate(fullText, 'usable');

    expect(candidate).toBeNull();
  });

  it('applies tier multiplier to confidence', () => {
    const fullText = 'ISBN 978-0-06-112008-4';

    const strongCandidate = generateIsbnCandidate(fullText, 'strong');
    const weakCandidate = generateIsbnCandidate(fullText, 'weak');

    expect(strongCandidate?.confidence).toBeGreaterThan(weakCandidate?.confidence ?? 0);
  });
});

// ============================================================================
// generateMergedEvidenceCandidate Tests
// ============================================================================

describe('generateMergedEvidenceCandidate', () => {
  it('generates candidate from merged evidence', () => {
    const evidence = createMockBookEvidence([
      { text: 'The Book Title' },
      { text: 'By Author Name' },
    ]);

    const candidate = generateMergedEvidenceCandidate(evidence, 'usable');

    expect(candidate).not.toBeNull();
    expect(candidate?.query).toContain('book');
    expect(candidate?.query).toContain('title');
  });

  it('extracts hints from perFieldHints', () => {
    const evidence: BookEvidence = {
      topCrops: [0],
      mergedLines: [
        {
          text: 'The Book',
          normalizedText: 'the book',
          confidence: 0.9,
          sourceCropIndex: 0,
          rotation: 0,
        },
      ],
      mergedTextBlock: 'The Book',
      perFieldHints: {
        titleHints: ['The Book Title'],
        authorHints: ['John Smith'],
      },
    };

    const candidate = generateMergedEvidenceCandidate(evidence, 'usable');

    expect(candidate?.titleHint).toBe('The Book Title');
    expect(candidate?.authorHint).toBe('John Smith');
  });

  it('extracts ISBN from merged text', () => {
    const evidence = createMockBookEvidence([
      { text: 'The Book Title' },
      { text: 'ISBN 978-0-06-112008-4' },
    ]);

    const candidate = generateMergedEvidenceCandidate(evidence, 'usable');

    expect(candidate?.isbn).toBe('9780061120084');
  });

  it('returns null for short queries', () => {
    const evidence = createMockBookEvidence([
      { text: 'A' },
    ]);

    const candidate = generateMergedEvidenceCandidate(evidence, 'usable');

    expect(candidate).toBeNull();
  });

  it('calculates confidence from merged lines', () => {
    const evidence = createMockBookEvidence([
      { text: 'Line One', confidence: 0.9 },
      { text: 'Line Two', confidence: 0.7 },
    ]);

    const candidate = generateMergedEvidenceCandidate(evidence, 'usable');

    // Average of 0.9 and 0.7 = 0.8, then multiplied by tier multiplier
    expect(candidate?.confidence).toBeGreaterThan(0);
    expect(candidate?.confidence).toBeLessThan(1);
  });
});
