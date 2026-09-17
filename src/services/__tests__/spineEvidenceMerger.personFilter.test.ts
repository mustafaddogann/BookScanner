/**
 * Test that person-like lines are filtered from title candidates
 */

import { mergeEvidenceForCandidate } from '../spineEvidenceMerger';
import type { BookCandidate, OCRResult } from '../../types';

describe('SpineEvidenceMerger: Person-like title filtering', () => {
  it('should filter person-like native title candidate and use advanced extraction', () => {
    // Simulate the screenshot case: native OCR gives LISA CHILDS as both title and author
    const candidate = {
      id: 'test-1',
      cropIndices: [0],
      evidence: {
        mergedLines: [],
        titleHints: [],
        authorHints: [],
        debug: {},
      },
    } as unknown as BookCandidate;

    const ocrResult = {
      ok: true,
      rawText: 'ZEBRA\nNEW FORK\nTIMES\nBESTSELLER\nLISA CHILDS\nTHE\nBURIED',
      lines: [
        { text: 'ZEBRA', confidence: 0.9 },
        { text: 'NEW FORK', confidence: 0.9 },
        { text: 'TIMES', confidence: 0.9 },
        { text: 'BESTSELLER', confidence: 0.9 },
        { text: 'LISA CHILDS', confidence: 0.95 },
        { text: 'THE', confidence: 0.9 },
        { text: 'BURIED', confidence: 0.9 },
      ],
      // Native OCR incorrectly picks LISA CHILDS for both
      titleCandidate: 'LISA CHILDS',
      authorCandidate: 'LISA CHILDS',
      confidence: 0.9,
    } as unknown as OCRResult;

    const ocrResultsByCropIndex: Record<number, OCRResult> = {
      0: ocrResult,
    };

    const result = mergeEvidenceForCandidate({
      candidate,
      ocrResultsByCropIndex,
    });

    console.log('Title hints:', result.perFieldHints?.titleHints);
    console.log('Author hints:', result.perFieldHints?.authorHints);

    // LISA CHILDS should be filtered from title hints (person-like)
    // THE BURIED should come from advanced extraction fallback
    expect(result.perFieldHints?.titleHints).not.toContain('LISA CHILDS');

    // LISA CHILDS should be in author hints
    expect(result.perFieldHints?.authorHints).toContain('LISA CHILDS');

    // Title should be THE BURIED from advanced extraction
    expect(result.perFieldHints?.titleHints?.some(t => t.includes('BURIED'))).toBe(true);
  });

  it('should filter title-like native author candidate', () => {
    // Native OCR gives "OVERTURE TO DEATH" as both title and author
    const candidate = {
      id: 'test-3',
      cropIndices: [0],
      evidence: {
        mergedLines: [],
        titleHints: [],
        authorHints: [],
        debug: {},
      },
    } as unknown as BookCandidate;

    const ocrResult = {
      ok: true,
      rawText: 'JOVE\nMYSTERY\nOVERTURE TO DEATH\nTONIO MARSH',
      lines: [
        { text: 'JOVE', confidence: 0.9 },
        { text: 'MYSTERY', confidence: 0.9 },
        { text: 'OVERTURE TO DEATH', confidence: 0.95 },
        { text: 'TONIO MARSH', confidence: 0.95 },
      ],
      // Native OCR incorrectly picks OVERTURE TO DEATH for both
      titleCandidate: 'OVERTURE TO DEATH',
      authorCandidate: 'OVERTURE TO DEATH',
      confidence: 0.95,
    } as unknown as OCRResult;

    const ocrResultsByCropIndex: Record<number, OCRResult> = {
      0: ocrResult,
    };

    const result = mergeEvidenceForCandidate({
      candidate,
      ocrResultsByCropIndex,
    });

    console.log('Title hints:', result.perFieldHints?.titleHints);
    console.log('Author hints:', result.perFieldHints?.authorHints);

    // OVERTURE TO DEATH should be in title hints (it's title-like)
    expect(result.perFieldHints?.titleHints).toContain('OVERTURE TO DEATH');

    // OVERTURE TO DEATH should NOT be in author hints (it's title-like, not person-like)
    expect(result.perFieldHints?.authorHints).not.toContain('OVERTURE TO DEATH');

    // TONIO MARSH should be in author hints (from advanced extraction fallback)
    expect(result.perFieldHints?.authorHints).toContain('TONIO MARSH');
  });

  it('should keep non-person-like title candidates', () => {
    const candidate = {
      id: 'test-2',
      cropIndices: [0],
      evidence: {
        mergedLines: [],
        titleHints: [],
        authorHints: [],
        debug: {},
      },
    } as unknown as BookCandidate;

    const ocrResult = {
      ok: true,
      rawText: 'THE SHINING\nSTEPHEN KING',
      lines: [
        { text: 'THE SHINING', confidence: 0.95 },
        { text: 'STEPHEN KING', confidence: 0.95 },
      ],
      titleCandidate: 'THE SHINING',
      authorCandidate: 'STEPHEN KING',
      confidence: 0.95,
    } as unknown as OCRResult;

    const ocrResultsByCropIndex: Record<number, OCRResult> = {
      0: ocrResult,
    };

    const result = mergeEvidenceForCandidate({
      candidate,
      ocrResultsByCropIndex,
    });

    // THE SHINING should NOT be filtered (starts with article, not person-like)
    expect(result.perFieldHints?.titleHints).toContain('THE SHINING');
    expect(result.perFieldHints?.authorHints).toContain('STEPHEN KING');
  });
});
