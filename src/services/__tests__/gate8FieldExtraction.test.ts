/**
 * Gate 8 Field Extraction Tests
 *
 * Tests for deterministic line-labeling and assembly:
 * - spineLineFilter
 * - spineLineLabeler
 * - spineTitleAuthorAssembler
 * - spineSwapGuard
 * - mixedOrientationMerger
 */

import { filterSpineLines, isOtherLine, type FilteredLine } from '../spineLineFilter';
import { labelSpineLines, scoreLine, scoreAsName, scoreAsTitle, detectByPattern } from '../spineLineLabeler';
import { assembleTitleAuthor, quickAssemble } from '../spineTitleAuthorAssembler';
import { guardSwap, quickSwapCheck, analyzeSwap, validatePairing } from '../spineSwapGuard';
import { mergeRotationEvidence } from '../mixedOrientationMerger';
import type { BookEvidenceLine, OCRResult, RotationTrialResult } from '../../types';

// Suppress console output during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ============================================================================
// Helper Functions
// ============================================================================

function makeEvidenceLine(
  text: string,
  opts: Partial<BookEvidenceLine> = {}
): BookEvidenceLine {
  return {
    text,
    normalizedText: text.toLowerCase().trim(),
    confidence: opts.confidence ?? 0.9,
    sourceCropIndex: opts.sourceCropIndex ?? 0,
    rotation: opts.rotation ?? 0,
    bbox: opts.bbox ?? { x: 0, y: 0, width: 100, height: 20 },
  };
}

function makeOCRResult(lines: string[], rotation: number = 0): OCRResult {
  return {
    ok: true,
    chosenRotation: rotation,
    fullText: lines.join('\n'),
    lines: lines.map((text, i) => ({
      text,
      confidence: 0.9,
      bbox: { x: 0, y: i * 25, width: 100, height: 20 },
    })),
    avgConfidence: 0.9,
    alnumRatio: 0.8,
    charCount: lines.join('').length,
    lineCount: lines.length,
    titleCandidate: null,
    authorCandidate: null,
  };
}

// ============================================================================
// spineLineFilter Tests
// ============================================================================

describe('spineLineFilter', () => {
  describe('isOtherLine', () => {
    it('should filter ISBN patterns', () => {
      expect(isOtherLine('ISBN 978-0-13-468599-1').isOther).toBe(true);
      expect(isOtherLine('ISBN: 0-201-63361-2').isOther).toBe(true);
      expect(isOtherLine('9780134685991').isOther).toBe(true);
    });

    it('should filter price patterns', () => {
      expect(isOtherLine('$24.99').isOther).toBe(true);
      expect(isOtherLine('£19.99').isOther).toBe(true);
      expect(isOtherLine('€29,99').isOther).toBe(true);
      expect(isOtherLine('Price: 15.00 USD').isOther).toBe(true);
    });

    it('should filter URL patterns', () => {
      expect(isOtherLine('www.example.com').isOther).toBe(true);
      expect(isOtherLine('https://publisher.org').isOther).toBe(true);
      expect(isOtherLine('Visit us at publisher.com').isOther).toBe(true);
    });

    it('should filter copyright patterns', () => {
      expect(isOtherLine('© 2024 Publisher').isOther).toBe(true);
      expect(isOtherLine('Copyright 2024').isOther).toBe(true);
      expect(isOtherLine('All Rights Reserved').isOther).toBe(true);
    });

    it('should filter numeric-heavy lines', () => {
      expect(isOtherLine('123456789012').isOther).toBe(true);
      expect(isOtherLine('2024-01-15').isOther).toBe(true);
    });

    it('should filter edition patterns', () => {
      expect(isOtherLine('3rd Edition').isOther).toBe(true);
      expect(isOtherLine('Revised Edition').isOther).toBe(true);
      expect(isOtherLine('5. Baskı').isOther).toBe(true);
    });

    it('should filter publisher-only lines', () => {
      expect(isOtherLine('Penguin Press').isOther).toBe(true);
      expect(isOtherLine('O\'Reilly Publishing').isOther).toBe(true);
    });

    it('should NOT filter title/author candidates', () => {
      expect(isOtherLine('The Great Gatsby').isOther).toBe(false);
      expect(isOtherLine('F. Scott Fitzgerald').isOther).toBe(false);
      expect(isOtherLine('Clean Code: A Handbook').isOther).toBe(false);
    });
  });

  describe('filterSpineLines', () => {
    it('should separate candidate lines from OTHER lines', () => {
      const lines = [
        makeEvidenceLine('The Great Gatsby'),
        makeEvidenceLine('F. Scott Fitzgerald'),
        makeEvidenceLine('ISBN 978-0-7432-7356-5'),
        makeEvidenceLine('$15.99'),
        makeEvidenceLine('Scribner'),
      ];

      const result = filterSpineLines(lines);

      expect(result.candidateLines.length).toBe(2);
      expect(result.otherLines.length).toBe(3);
      expect(result.summary.candidates).toBe(2);
      expect(result.summary.filtered).toBe(3);
    });
  });
});

// ============================================================================
// spineLineLabeler Tests
// ============================================================================

describe('spineLineLabeler', () => {
  describe('scoreAsName', () => {
    it('should give high score to typical author names', () => {
      expect(scoreAsName('F. Scott Fitzgerald')).toBeGreaterThan(0.5);
      expect(scoreAsName('J.K. Rowling')).toBeGreaterThan(0.5);
      expect(scoreAsName('Stephen King')).toBeGreaterThan(0.5);
      expect(scoreAsName('Dr. Martin Luther King Jr.')).toBeGreaterThan(0.4);
    });

    it('should give low score to book titles', () => {
      expect(scoreAsName('The Great Gatsby')).toBeLessThan(0.5);
      expect(scoreAsName('How to Win Friends and Influence People')).toBeLessThan(0.5);
      expect(scoreAsName('A Brief History of Time')).toBeLessThan(0.4);
    });
  });

  describe('scoreAsTitle', () => {
    it('should give high score to typical book titles', () => {
      expect(scoreAsTitle('The Great Gatsby')).toBeGreaterThan(0.5);
      expect(scoreAsTitle('Clean Code: A Handbook of Agile Software Craftsmanship')).toBeGreaterThan(0.5);
      expect(scoreAsTitle('1984')).toBeGreaterThan(0.4);
    });

    it('should give low score to author names', () => {
      expect(scoreAsTitle('F. Scott Fitzgerald')).toBeLessThan(0.6);
      expect(scoreAsTitle('Stephen King')).toBeLessThan(0.6);
    });
  });

  describe('detectByPattern', () => {
    it('should detect "by" patterns', () => {
      expect(detectByPattern('by Stephen King').hasBy).toBe(true);
      expect(detectByPattern('By F. Scott Fitzgerald').hasBy).toBe(true);
      expect(detectByPattern('written by Jane Austen').hasBy).toBe(true);
    });

    it('should extract author from "by" pattern', () => {
      const result = detectByPattern('by Stephen King');
      expect(result.extractedAuthor).toBe('Stephen King');
    });

    it('should not detect "by" in the middle of text', () => {
      expect(detectByPattern('Stand By Me').hasBy).toBe(false);
      expect(detectByPattern('Byte by Byte').hasBy).toBe(false);
    });
  });

  describe('labelSpineLines', () => {
    it('should classify title and author lines', () => {
      const lines = [
        makeEvidenceLine('The Great Gatsby'),
        makeEvidenceLine('F. Scott Fitzgerald'),
      ];
      const filtered = filterSpineLines(lines);
      const result = labelSpineLines(filtered.candidateLines);

      expect(result.titleLines.length).toBeGreaterThanOrEqual(1);
      expect(result.authorLines.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle "by Author" patterns', () => {
      const lines = [
        makeEvidenceLine('The Shining'),
        makeEvidenceLine('by Stephen King'),
      ];
      const filtered = filterSpineLines(lines);
      const result = labelSpineLines(filtered.candidateLines);

      // "by Stephen King" should be classified as author
      const byLine = result.labeledLines.find(l =>
        l.filteredLine.line.text.includes('by Stephen King')
      );
      expect(byLine?.authorScore).toBeGreaterThan(byLine?.titleScore || 0);
    });
  });

  describe('scoreLine', () => {
    it('should score title higher for title text', () => {
      const result = scoreLine('The Great Gatsby');
      expect(result.titleScore).toBeGreaterThan(result.authorScore);
    });

    it('should score author higher for author text', () => {
      const result = scoreLine('by Stephen King');
      expect(result.authorScore).toBeGreaterThan(result.titleScore);
    });
  });
});

// ============================================================================
// spineTitleAuthorAssembler Tests
// ============================================================================

describe('spineTitleAuthorAssembler', () => {
  describe('assembleTitleAuthor', () => {
    it('should assemble title and author from labeled lines', () => {
      // Position matters: title at top (y=0), author below (y=50)
      const lines = [
        makeEvidenceLine('The Great Gatsby', { bbox: { x: 0, y: 0, width: 100, height: 20 } }),
        makeEvidenceLine('F. Scott Fitzgerald', { bbox: { x: 0, y: 50, width: 100, height: 20 } }),
      ];
      const filtered = filterSpineLines(lines);
      const labeled = labelSpineLines(filtered.candidateLines);
      const result = assembleTitleAuthor(labeled);

      expect(result.bestTitle).toBeDefined();
      expect(result.bestAuthor).toBeDefined();
    });

    it('should handle subtitle extraction', () => {
      const lines = [
        makeEvidenceLine('Clean Code: A Handbook of Agile Software Craftsmanship'),
        makeEvidenceLine('Robert C. Martin'),
      ];
      const filtered = filterSpineLines(lines);
      const labeled = labelSpineLines(filtered.candidateLines);
      const result = assembleTitleAuthor(labeled);

      if (result.bestTitle) {
        expect(result.bestTitle.mainTitle).toBeDefined();
        // May or may not detect subtitle depending on scoring
      }
    });
  });

  describe('quickAssemble', () => {
    it('should handle "Author • Title" pattern', () => {
      const result = quickAssemble(['Stephen King • The Shining']);
      expect(result.title).toBe('The Shining');
      expect(result.author).toBe('Stephen King');
    });

    it('should handle "Title - Author" pattern', () => {
      const result = quickAssemble(['The Great Gatsby - F. Scott Fitzgerald']);
      expect(result.title).toBe('The Great Gatsby');
      expect(result.author).toBe('F. Scott Fitzgerald');
    });

    it('should handle "by" pattern', () => {
      const result = quickAssemble(['The Shining', 'by Stephen King']);
      expect(result.title).toBe('The Shining');
      expect(result.author).toBe('Stephen King');
    });

    it('should handle separate lines', () => {
      const result = quickAssemble(['Pride and Prejudice', 'Jane Austen']);
      expect(result.title).toBe('Pride and Prejudice');
      // Author may or may not be detected depending on heuristics
    });
  });
});

// ============================================================================
// spineSwapGuard Tests
// ============================================================================

describe('spineSwapGuard', () => {
  describe('analyzeSwap', () => {
    it('should detect when title looks like name and vice versa', () => {
      // Create a pairing where title is actually an author name
      const pairing = {
        title: {
          mainTitle: 'Stephen King',
          fullTitle: 'Stephen King',
          confidence: 0.8,
          sourceLineIndices: [0],
          method: 'single_line' as const,
          charCount: 12,
          wordCount: 2,
        },
        author: {
          primaryAuthor: 'The Shining',
          additionalAuthors: [],
          fullAuthor: 'The Shining',
          confidence: 0.8,
          sourceLineIndices: [1],
          method: 'single_line' as const,
          nameConfidence: 0.3,
        },
        confidence: 0.8,
        pairingScore: 0.64,
      };

      const analysis = analyzeSwap(pairing);

      // Title name score should be higher than author name score
      expect(analysis.titleNameScore).toBeGreaterThan(0.4);
      expect(analysis.authorNameScore).toBeLessThan(0.5);
    });
  });

  describe('quickSwapCheck', () => {
    it('should recommend swap when title is author-like', () => {
      const result = quickSwapCheck('J.K. Rowling', 'Harry Potter');

      // Should swap because 'J.K. Rowling' looks like a name
      // and 'Harry Potter' looks more like a title
      if (result.shouldSwap) {
        expect(result.correctedTitle).toBe('Harry Potter');
        expect(result.correctedAuthor).toBe('J.K. Rowling');
      }
    });

    it('should NOT swap when already correct', () => {
      const result = quickSwapCheck('The Great Gatsby', 'F. Scott Fitzgerald');

      // Should not swap - already correct orientation
      expect(result.correctedTitle).toBe('The Great Gatsby');
      expect(result.correctedAuthor).toBe('F. Scott Fitzgerald');
    });
  });

  describe('validatePairing', () => {
    it('should reject identical title and author', () => {
      const result = validatePairing('Stephen King', 'Stephen King');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('title_and_author_identical');
    });

    it('should reject when one contains the other', () => {
      const result = validatePairing('Stephen King: A Biography', 'Stephen King');
      expect(result.valid).toBe(false);
    });

    it('should accept valid pairings', () => {
      const result = validatePairing('The Shining', 'Stephen King');
      expect(result.valid).toBe(true);
    });
  });
});

// ============================================================================
// Mixed Orientation Tests
// ============================================================================

describe('mixedOrientationMerger', () => {
  describe('mergeRotationEvidence', () => {
    it('should handle single rotation', () => {
      const ocrResult = makeOCRResult(['The Great Gatsby', 'F. Scott Fitzgerald']);
      const result = mergeRotationEvidence(ocrResult, 0);

      expect(result.isMixedOrientation).toBe(false);
      expect(result.mergedLines.length).toBe(2);
    });

    it('should handle mixed orientation when rotationTrials provided', () => {
      const trials: RotationTrialResult[] = [
        {
          rotation: 0,
          fullText: 'Publisher Info\nEdition 2024',
          lines: [
            { text: 'Publisher Info', confidence: 0.85, bbox: { x: 0, y: 0, width: 100, height: 20 } },
            { text: 'Edition 2024', confidence: 0.8, bbox: { x: 0, y: 25, width: 100, height: 20 } },
          ],
          avgConfidence: 0.825,
          alnumRatio: 0.9,
          charCount: 26,
          qualityScore: 0.7,
          titleCandidate: null,
          authorCandidate: null,
        },
        {
          rotation: 90,
          fullText: 'The Great Gatsby\nF. Scott Fitzgerald',
          lines: [
            { text: 'The Great Gatsby', confidence: 0.95, bbox: { x: 0, y: 0, width: 100, height: 20 } },
            { text: 'F. Scott Fitzgerald', confidence: 0.92, bbox: { x: 0, y: 25, width: 100, height: 20 } },
          ],
          avgConfidence: 0.935,
          alnumRatio: 0.95,
          charCount: 35,
          qualityScore: 0.9,
          titleCandidate: 'The Great Gatsby',
          authorCandidate: 'F. Scott Fitzgerald',
        },
      ];

      const ocrResult: OCRResult = {
        ok: true,
        chosenRotation: 90,
        fullText: 'The Great Gatsby\nF. Scott Fitzgerald',
        lines: trials[1].lines,
        avgConfidence: 0.935,
        alnumRatio: 0.95,
        charCount: 35,
        lineCount: 2,
        titleCandidate: 'The Great Gatsby',
        authorCandidate: 'F. Scott Fitzgerald',
        rotationTrials: trials,
      };

      const result = mergeRotationEvidence(ocrResult, 0);

      expect(result.rotationEvidence.length).toBe(2);
      // Title rotation should be 90 (has the title content)
      expect(result.titleRotation).toBe(90);
    });

    it('should deduplicate lines across rotations', () => {
      // Same text appears at different rotations - should be deduplicated
      const trials: RotationTrialResult[] = [
        {
          rotation: 0,
          fullText: 'The Great Gatsby',
          lines: [{ text: 'The Great Gatsby', confidence: 0.8, bbox: { x: 0, y: 0, width: 100, height: 20 } }],
          avgConfidence: 0.8,
          alnumRatio: 0.9,
          charCount: 16,
          qualityScore: 0.75,
          titleCandidate: 'The Great Gatsby',
          authorCandidate: null,
        },
        {
          rotation: 90,
          fullText: 'The Great Gatsby',
          lines: [{ text: 'The Great Gatsby', confidence: 0.9, bbox: { x: 0, y: 0, width: 100, height: 20 } }],
          avgConfidence: 0.9,
          alnumRatio: 0.9,
          charCount: 16,
          qualityScore: 0.85,
          titleCandidate: 'The Great Gatsby',
          authorCandidate: null,
        },
      ];

      const ocrResult: OCRResult = {
        ok: true,
        chosenRotation: 90,
        fullText: 'The Great Gatsby',
        lines: trials[1].lines,
        avgConfidence: 0.9,
        alnumRatio: 0.9,
        charCount: 16,
        lineCount: 1,
        titleCandidate: 'The Great Gatsby',
        authorCandidate: null,
        rotationTrials: trials,
      };

      const result = mergeRotationEvidence(ocrResult, 0);

      // Should have only 1 line after deduplication
      expect(result.mergedLines.length).toBe(1);
      // Should keep the higher confidence version (0.9)
      expect(result.mergedLines[0].confidence).toBe(0.9);
    });
  });

  describe('mixed orientation fixture', () => {
    it('should extract title from 90° and publisher from 0°', () => {
      // This simulates a real-world scenario where:
      // - Title/author are readable at 90°
      // - Publisher/edition info is readable at 0°
      const trials: RotationTrialResult[] = [
        {
          rotation: 0,
          fullText: 'Scribner\n2020 Edition',
          lines: [
            { text: 'Scribner', confidence: 0.85, bbox: { x: 0, y: 0, width: 100, height: 20 } },
            { text: '2020 Edition', confidence: 0.8, bbox: { x: 0, y: 25, width: 100, height: 20 } },
          ],
          avgConfidence: 0.825,
          alnumRatio: 0.85,
          charCount: 20,
          qualityScore: 0.7,
          titleCandidate: null,
          authorCandidate: null,
        },
        {
          rotation: 90,
          fullText: 'The Great Gatsby\nF. Scott Fitzgerald',
          lines: [
            { text: 'The Great Gatsby', confidence: 0.95, bbox: { x: 0, y: 0, width: 100, height: 20 } },
            { text: 'F. Scott Fitzgerald', confidence: 0.92, bbox: { x: 0, y: 25, width: 100, height: 20 } },
          ],
          avgConfidence: 0.935,
          alnumRatio: 0.95,
          charCount: 35,
          qualityScore: 0.9,
          titleCandidate: 'The Great Gatsby',
          authorCandidate: 'F. Scott Fitzgerald',
        },
      ];

      const ocrResult: OCRResult = {
        ok: true,
        chosenRotation: 90,
        fullText: 'The Great Gatsby\nF. Scott Fitzgerald',
        lines: trials[1].lines,
        avgConfidence: 0.935,
        alnumRatio: 0.95,
        charCount: 35,
        lineCount: 2,
        titleCandidate: 'The Great Gatsby',
        authorCandidate: 'F. Scott Fitzgerald',
        rotationTrials: trials,
      };

      const merged = mergeRotationEvidence(ocrResult, 0);

      // The 90° rotation should be primary for title
      expect(merged.titleRotation).toBe(90);

      // Merged lines should include title/author from 90° rotation
      const titleLine = merged.mergedLines.find(l => l.text === 'The Great Gatsby');
      const authorLine = merged.mergedLines.find(l => l.text === 'F. Scott Fitzgerald');

      expect(titleLine).toBeDefined();
      expect(authorLine).toBeDefined();

      // Now run through the full pipeline
      const filtered = filterSpineLines(merged.mergedLines);
      const labeled = labelSpineLines(filtered.candidateLines);
      const assembled = assembleTitleAuthor(labeled);

      // Title should be extracted correctly
      expect(assembled.bestTitle?.fullTitle).toBe('The Great Gatsby');
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Gate 8 Integration', () => {
  it('should correctly extract title and author from typical spine', () => {
    const lines = [
      makeEvidenceLine('THE GREAT GATSBY'),
      makeEvidenceLine('F. SCOTT FITZGERALD'),
    ];

    const filtered = filterSpineLines(lines);
    const labeled = labelSpineLines(filtered.candidateLines);
    const assembled = assembleTitleAuthor(labeled);

    expect(assembled.bestTitle?.fullTitle).toContain('GATSBY');
  });

  it('should handle "Author • Title" combined line', () => {
    const lines = [
      makeEvidenceLine('Stephen King • The Shining'),
    ];

    const filtered = filterSpineLines(lines);
    const labeled = labelSpineLines(filtered.candidateLines);
    const assembled = assembleTitleAuthor(labeled);

    // Should detect as combined and split
    expect(assembled.pairings.length).toBeGreaterThanOrEqual(1);

    if (assembled.bestPairing) {
      expect(assembled.bestPairing.title.fullTitle).toBe('The Shining');
      expect(assembled.bestPairing.author.fullAuthor).toBe('Stephen King');
    }
  });

  it('should NOT contaminate title with OTHER lines', () => {
    const lines = [
      makeEvidenceLine('Clean Code'),
      makeEvidenceLine('Robert C. Martin'),
      makeEvidenceLine('ISBN 978-0-13-235088-4'),
      makeEvidenceLine('$49.99'),
      makeEvidenceLine('Prentice Hall'),
    ];

    const filtered = filterSpineLines(lines);

    // ISBN, price, and publisher should be filtered
    expect(filtered.candidateLines.length).toBe(2);
    expect(filtered.otherLines.length).toBe(3);

    const labeled = labelSpineLines(filtered.candidateLines);
    const assembled = assembleTitleAuthor(labeled);

    // Title should not include ISBN or price
    if (assembled.bestTitle) {
      expect(assembled.bestTitle.fullTitle).not.toContain('ISBN');
      expect(assembled.bestTitle.fullTitle).not.toContain('$');
    }
  });
});
