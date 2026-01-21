/**
 * Unit tests for spineEvidenceMerger (Gate 7)
 */

import {
  mergeEvidenceForCandidate,
  mergeEvidenceForAllCandidates,
  normalizeText,
  MergeInput,
} from '../spineEvidenceMerger';
import type { OCRResult, BookCandidate, BookEvidence } from '../../types';

// Suppress console.log during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('normalizeText', () => {
  it('should lowercase text', () => {
    expect(normalizeText('Hello World')).toBe('hello world');
  });

  it('should remove punctuation', () => {
    expect(normalizeText("It's a test!")).toBe('its a test');
    expect(normalizeText('Hello, World.')).toBe('hello world');
  });

  it('should collapse whitespace', () => {
    expect(normalizeText('hello   world')).toBe('hello world');
    expect(normalizeText('  hello  world  ')).toBe('hello world');
  });

  it('should handle combined transformations', () => {
    expect(normalizeText("  HELLO,   World!  ")).toBe('hello world');
  });
});

describe('mergeEvidenceForCandidate', () => {
  // Helper to create a minimal BookCandidate
  const makeCandidate = (cropIndices: number[]): BookCandidate => ({
    id: 'test_book_0',
    detectionIndices: cropIndices,
    cropIndices,
    representativeDetectionIndex: cropIndices[0] || 0,
    orderingKey: 0,
    angleRad: 0,
    confidenceScore: 0.9,
    evidence: {
      topCrops: [],
      mergedLines: [],
      mergedTextBlock: '',
    },
  });

  // Helper to create OCR result
  const makeOCRResult = (
    lines: Array<{ text: string; confidence: number }>,
    opts?: { titleCandidate?: string; authorCandidate?: string; chosenRotation?: number }
  ): OCRResult => ({
    ok: true,
    chosenRotation: opts?.chosenRotation ?? 0,
    fullText: lines.map(l => l.text).join('\n'),
    lines: lines.map(l => ({
      text: l.text,
      confidence: l.confidence,
      bbox: { x: 0, y: 0, width: 100, height: 20 },
    })),
    avgConfidence: lines.length > 0
      ? lines.reduce((sum, l) => sum + l.confidence, 0) / lines.length
      : 0,
    alnumRatio: 0.8,
    charCount: lines.reduce((sum, l) => sum + l.text.length, 0),
    lineCount: lines.length,
    titleCandidate: opts?.titleCandidate ?? null,
    authorCandidate: opts?.authorCandidate ?? null,
  });

  describe('empty input', () => {
    it('should return empty evidence for candidate with no crops', () => {
      const candidate = makeCandidate([]);
      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: {},
      };

      const result = mergeEvidenceForCandidate(input);

      expect(result.topCrops).toHaveLength(0);
      expect(result.mergedLines).toHaveLength(0);
      expect(result.mergedTextBlock).toBe('');
    });

    it('should return empty evidence when no OCR results exist', () => {
      const candidate = makeCandidate([0, 1, 2]);
      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: {},
      };

      const result = mergeEvidenceForCandidate(input);

      expect(result.topCrops).toHaveLength(0);
      expect(result.mergedLines).toHaveLength(0);
      expect(result.mergedTextBlock).toBe('');
    });
  });

  describe('top K crop selection', () => {
    it('should select top 3 crops by quality score', () => {
      const candidate = makeCandidate([0, 1, 2, 3, 4]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult([{ text: 'Crop 0 low', confidence: 0.5 }]),
        1: makeOCRResult([{ text: 'Crop 1 high', confidence: 0.95 }], { titleCandidate: 'Title 1' }),
        2: makeOCRResult([{ text: 'Crop 2 medium', confidence: 0.7 }]),
        3: makeOCRResult([{ text: 'Crop 3 high', confidence: 0.9 }], { titleCandidate: 'Title 3' }),
        4: makeOCRResult([{ text: 'Crop 4 medium', confidence: 0.75 }]),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      // Should select top 3 crops (1, 3, 4 have highest quality scores)
      expect(result.topCrops).toHaveLength(3);
      // Crop 1 and 3 have title candidates which boost their scores
      expect(result.topCrops).toContain(1);
      expect(result.topCrops).toContain(3);
    });

    it('should use all crops when fewer than K available', () => {
      const candidate = makeCandidate([0, 1]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult([{ text: 'Line A', confidence: 0.8 }]),
        1: makeOCRResult([{ text: 'Line B', confidence: 0.9 }]),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      expect(result.topCrops).toHaveLength(2);
      expect(result.topCrops).toContain(0);
      expect(result.topCrops).toContain(1);
    });
  });

  describe('line deduplication', () => {
    it('should deduplicate exact duplicate lines from multiple crops', () => {
      const candidate = makeCandidate([0, 1]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult([
          { text: 'The Great Gatsby', confidence: 0.85 },
          { text: 'F. Scott Fitzgerald', confidence: 0.8 },
        ]),
        1: makeOCRResult([
          { text: 'The Great Gatsby', confidence: 0.9 },  // Same text, higher confidence
          { text: 'F. Scott Fitzgerald', confidence: 0.75 },
        ]),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      // Should have 2 unique lines, not 4
      expect(result.mergedLines).toHaveLength(2);

      // Should keep the higher confidence version
      const gatsbyLine = result.mergedLines.find(l => l.text === 'The Great Gatsby');
      expect(gatsbyLine?.confidence).toBe(0.9);
    });

    it('should deduplicate similar lines with OCR variations', () => {
      const candidate = makeCandidate([0, 1]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult([
          { text: 'HELLO WORLD', confidence: 0.8 },
        ]),
        1: makeOCRResult([
          { text: 'Hell0 W0rld', confidence: 0.9 },  // OCR confused O with 0
        ]),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      // Should deduplicate because OCR normalization treats O/0 as same
      expect(result.mergedLines).toHaveLength(1);
      // Should keep higher confidence version
      expect(result.mergedLines[0].confidence).toBe(0.9);
    });

    it('should NOT deduplicate sufficiently different lines', () => {
      const candidate = makeCandidate([0, 1]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult([
          { text: 'Chapter One', confidence: 0.9 },
        ]),
        1: makeOCRResult([
          { text: 'Chapter Two', confidence: 0.85 },
        ]),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      // Both lines should be preserved (different content)
      expect(result.mergedLines).toHaveLength(2);
    });
  });

  describe('provenance preservation', () => {
    it('should preserve sourceCropIndex for each line', () => {
      const candidate = makeCandidate([0, 1]);

      // Use very different text to avoid deduplication
      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult([{ text: 'The Great Gatsby Novel', confidence: 0.9 }]),
        1: makeOCRResult([{ text: 'Pride and Prejudice Classic', confidence: 0.85 }]),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      expect(result.mergedLines).toHaveLength(2);

      const line0 = result.mergedLines.find(l => l.text === 'The Great Gatsby Novel');
      const line1 = result.mergedLines.find(l => l.text === 'Pride and Prejudice Classic');

      expect(line0?.sourceCropIndex).toBe(0);
      expect(line1?.sourceCropIndex).toBe(1);
    });

    it('should preserve rotation from OCR result', () => {
      const candidate = makeCandidate([0]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult(
          [{ text: 'Rotated text', confidence: 0.9 }],
          { chosenRotation: 90 }
        ),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      expect(result.mergedLines[0].rotation).toBe(90);
    });

    it('should preserve normalizedText for each line', () => {
      const candidate = makeCandidate([0]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult([{ text: 'Hello, World!', confidence: 0.9 }]),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      expect(result.mergedLines[0].text).toBe('Hello, World!');
      expect(result.mergedLines[0].normalizedText).toBe('hello world');
    });
  });

  describe('merged text block', () => {
    it('should build merged text block from lines', () => {
      const candidate = makeCandidate([0]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult([
          { text: 'Line One', confidence: 0.9 },
          { text: 'Line Two', confidence: 0.85 },
          { text: 'Line Three', confidence: 0.8 },
        ]),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      // Lines should be sorted by confidence (highest first)
      expect(result.mergedTextBlock).toBe('Line One\nLine Two\nLine Three');
    });
  });

  describe('per-field hints', () => {
    it('should extract title hints from OCR results', () => {
      const candidate = makeCandidate([0, 1]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult(
          [{ text: 'Some text', confidence: 0.9 }],
          { titleCandidate: 'Book Title A' }
        ),
        1: makeOCRResult(
          [{ text: 'Other text', confidence: 0.85 }],
          { titleCandidate: 'Book Title B' }
        ),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      expect(result.perFieldHints?.titleHints).toContain('Book Title A');
      expect(result.perFieldHints?.titleHints).toContain('Book Title B');
    });

    it('should extract author hints from OCR results', () => {
      const candidate = makeCandidate([0, 1]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult(
          [{ text: 'Some text', confidence: 0.9 }],
          { authorCandidate: 'John Smith' }
        ),
        1: makeOCRResult(
          [{ text: 'Other text', confidence: 0.85 }],
          { authorCandidate: 'Jane Doe' }
        ),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      expect(result.perFieldHints?.authorHints).toContain('John Smith');
      expect(result.perFieldHints?.authorHints).toContain('Jane Doe');
    });

    it('should not duplicate title hints', () => {
      const candidate = makeCandidate([0, 1]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult(
          [{ text: 'Text', confidence: 0.9 }],
          { titleCandidate: 'Same Title' }
        ),
        1: makeOCRResult(
          [{ text: 'Text', confidence: 0.85 }],
          { titleCandidate: 'Same Title' }  // Duplicate
        ),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      expect(result.perFieldHints?.titleHints).toHaveLength(1);
    });
  });

  describe('line filtering', () => {
    it('should filter out very short lines (< 2 chars)', () => {
      const candidate = makeCandidate([0]);

      const ocrResults: Record<number, OCRResult> = {
        0: makeOCRResult([
          { text: 'A', confidence: 0.9 },      // Too short
          { text: 'OK', confidence: 0.85 },    // Just long enough
          { text: 'Good line', confidence: 0.8 },
        ]),
      };

      const input: MergeInput = {
        candidate,
        ocrResultsByCropIndex: ocrResults,
      };

      const result = mergeEvidenceForCandidate(input);

      // Should have 2 lines (excluding single char)
      expect(result.mergedLines).toHaveLength(2);
      expect(result.mergedLines.find(l => l.text === 'A')).toBeUndefined();
    });
  });
});

describe('mergeEvidenceForAllCandidates', () => {
  it('should process all candidates in list', () => {
    const candidates: BookCandidate[] = [
      {
        id: 'test_book_0',
        detectionIndices: [0],
        cropIndices: [0],
        representativeDetectionIndex: 0,
        orderingKey: 0,
        angleRad: 0,
        confidenceScore: 0.9,
        evidence: { topCrops: [], mergedLines: [], mergedTextBlock: '' },
      },
      {
        id: 'test_book_1',
        detectionIndices: [1],
        cropIndices: [1],
        representativeDetectionIndex: 1,
        orderingKey: 1,
        angleRad: 0,
        confidenceScore: 0.85,
        evidence: { topCrops: [], mergedLines: [], mergedTextBlock: '' },
      },
    ];

    const ocrResults: Record<number, OCRResult> = {
      0: {
        ok: true,
        chosenRotation: 0,
        fullText: 'Book One',
        lines: [{ text: 'Book One', confidence: 0.9, bbox: { x: 0, y: 0, width: 100, height: 20 } }],
        avgConfidence: 0.9,
        alnumRatio: 0.8,
        charCount: 8,
        lineCount: 1,
        titleCandidate: 'Book One',
        authorCandidate: null,
      },
      1: {
        ok: true,
        chosenRotation: 0,
        fullText: 'Book Two',
        lines: [{ text: 'Book Two', confidence: 0.85, bbox: { x: 0, y: 0, width: 100, height: 20 } }],
        avgConfidence: 0.85,
        alnumRatio: 0.8,
        charCount: 8,
        lineCount: 1,
        titleCandidate: 'Book Two',
        authorCandidate: null,
      },
    };

    const result = mergeEvidenceForAllCandidates(candidates, ocrResults);

    expect(result).toHaveLength(2);
    expect(result[0].evidence.mergedTextBlock).toBe('Book One');
    expect(result[1].evidence.mergedTextBlock).toBe('Book Two');
  });

  it('should mutate candidates in place', () => {
    const candidates: BookCandidate[] = [
      {
        id: 'test_book_0',
        detectionIndices: [0],
        cropIndices: [0],
        representativeDetectionIndex: 0,
        orderingKey: 0,
        angleRad: 0,
        confidenceScore: 0.9,
        evidence: { topCrops: [], mergedLines: [], mergedTextBlock: '' },
      },
    ];

    const ocrResults: Record<number, OCRResult> = {
      0: {
        ok: true,
        chosenRotation: 0,
        fullText: 'Test Line',
        lines: [{ text: 'Test Line', confidence: 0.9, bbox: { x: 0, y: 0, width: 100, height: 20 } }],
        avgConfidence: 0.9,
        alnumRatio: 0.8,
        charCount: 9,
        lineCount: 1,
        titleCandidate: null,
        authorCandidate: null,
      },
    };

    mergeEvidenceForAllCandidates(candidates, ocrResults);

    // Original array should be mutated
    expect(candidates[0].evidence.mergedTextBlock).toBe('Test Line');
  });
});
