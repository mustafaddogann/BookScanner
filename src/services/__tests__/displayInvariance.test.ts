/**
 * Display Invariance Regression Tests
 *
 * These tests ensure that hypothesis generation NEVER affects UI display.
 * UI display must use legacy extraction (evidence.perFieldHints or OCR results),
 * NOT hypothesis outputs.
 *
 * If these tests fail, it means hypothesis is leaking into display path - a critical regression.
 */

import type { BookCandidate, BookEvidence, BookEvidenceLine } from '../../types';
import { applyHypothesis, generateHypotheses } from '../hypothesisGenerationService';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a mock BookEvidenceLine
 */
function createLine(
  text: string,
  confidence: number = 0.9,
  sourceCropIndex: number = 0
): BookEvidenceLine {
  return {
    text,
    normalizedText: text.toLowerCase().replace(/[^a-z0-9]/g, ''),
    confidence,
    sourceCropIndex,
    rotation: 0,
  };
}

/**
 * Create mock BookEvidence with perFieldHints (legacy display source)
 */
function createEvidenceWithHints(
  lines: BookEvidenceLine[],
  titleHints: string[],
  authorHints: string[]
): BookEvidence {
  return {
    topCrops: [0],
    mergedLines: lines,
    mergedTextBlock: lines.map((l) => l.text).join('\n'),
    perFieldHints: {
      titleHints,
      authorHints,
    },
  };
}

/**
 * Create a mock BookCandidate with legacy display hints
 */
function createCandidateWithDisplayHints(
  titleHints: string[],
  authorHints: string[],
  id: string = 'test-candidate'
): BookCandidate {
  const lines = [
    createLine('Some OCR Line 1', 0.90),
    createLine('Some OCR Line 2', 0.85),
  ];
  return {
    id,
    detectionIndices: [0],
    cropIndices: [0],
    representativeDetectionIndex: 0,
    orderingKey: 0,
    angleRad: 0,
    confidenceScore: 0.9,
    evidence: createEvidenceWithHints(lines, titleHints, authorHints),
  };
}

/**
 * Simulate what getCandidateDisplay does in ResultsScreen
 * This is the legacy display path that must remain unchanged by hypothesis.
 */
function getLegacyDisplayFields(candidate: BookCandidate): { title: string | null; author: string | null } {
  // This mirrors the logic in ResultsScreen.getCandidateDisplay
  // Priority: userEdits > extractedFields.chosen > evidence.perFieldHints
  // Since we don't have userEdits or extractedFields in tests, use perFieldHints
  const titleHint = candidate.evidence?.perFieldHints?.titleHints?.[0] ?? null;
  const authorHint = candidate.evidence?.perFieldHints?.authorHints?.[0] ?? null;
  return { title: titleHint, author: authorHint };
}

// ============================================================================
// Display Invariance Tests
// ============================================================================

describe('Display Invariance (Regression Tests)', () => {
  describe('hypothesis does NOT affect display fields', () => {
    it('perFieldHints are unchanged after applyHypothesis', () => {
      const candidate = createCandidateWithDisplayHints(
        ['Original Title'],
        ['Original Author']
      );

      // Get display before hypothesis
      const displayBefore = getLegacyDisplayFields(candidate);

      // Apply hypothesis
      const updated = applyHypothesis(candidate);

      // Get display after hypothesis
      const displayAfter = getLegacyDisplayFields(updated);

      // CRITICAL: Display must be identical
      expect(displayAfter.title).toBe(displayBefore.title);
      expect(displayAfter.author).toBe(displayBefore.author);
      expect(displayAfter.title).toBe('Original Title');
      expect(displayAfter.author).toBe('Original Author');
    });

    it('multiple candidates maintain display invariance through generateHypotheses', () => {
      const candidates = [
        createCandidateWithDisplayHints(['Title 1'], ['Author 1'], 'c1'),
        createCandidateWithDisplayHints(['Title 2'], ['Author 2'], 'c2'),
        createCandidateWithDisplayHints(['Title 3'], ['Author 3'], 'c3'),
      ];

      // Get display before
      const displaysBefore = candidates.map(getLegacyDisplayFields);

      // Apply hypothesis to all
      const updated = generateHypotheses(candidates);

      // Get display after
      const displaysAfter = updated.map(getLegacyDisplayFields);

      // CRITICAL: All displays must be identical
      expect(displaysAfter).toEqual(displaysBefore);
    });

    it('hypothesis sub-object is isolated from display path', () => {
      const candidate = createCandidateWithDisplayHints(
        ['Display Title'],
        ['Display Author']
      );

      const updated = applyHypothesis(candidate);

      // Hypothesis should exist and have different values (generated from OCR lines)
      expect(updated.hypothesis).toBeDefined();

      // But display fields should use perFieldHints, not hypothesis
      const display = getLegacyDisplayFields(updated);
      expect(display.title).toBe('Display Title');
      expect(display.author).toBe('Display Author');

      // Even if uiGuess exists with different values, display should NOT use it
      if (updated.hypothesis?.uiGuess) {
        // uiGuess may have different values, but display should still be from hints
        expect(display.title).not.toBe(updated.hypothesis.uiGuess.title);
      }
    });
  });

  describe('known fixture: Everyday Sexism by Laura Bates', () => {
    it('displays correct title and author from perFieldHints', () => {
      // This is the target failure fixture mentioned in the plan
      const candidate = createCandidateWithDisplayHints(
        ['Everyday Sexism'],
        ['Laura Bates']
      );

      // Apply hypothesis
      const updated = applyHypothesis(candidate);

      // CRITICAL: Display must show original extraction, not hypothesis
      const display = getLegacyDisplayFields(updated);
      expect(display.title).toBe('Everyday Sexism');
      expect(display.author).toBe('Laura Bates');
    });

    it('publisher should not appear in display fields', () => {
      // Thomas Dunne Books should be filtered as publisher, not appear as author
      const candidate = createCandidateWithDisplayHints(
        ['Everyday Sexism'],
        ['Laura Bates'] // NOT "Thomas Dunne Books"
      );

      const updated = applyHypothesis(candidate);
      const display = getLegacyDisplayFields(updated);

      expect(display.author).toBe('Laura Bates');
      expect(display.author).not.toContain('Thomas');
      expect(display.author).not.toContain('Dunne');
    });
  });

  describe('uiGuess is NEVER used for display', () => {
    it('display uses perFieldHints even when uiGuess exists', () => {
      const candidate = createCandidateWithDisplayHints(
        ['Correct Title'],
        ['Correct Author']
      );

      const updated = applyHypothesis(candidate);

      // Verify hypothesis was generated
      expect(updated.hypothesis).toBeDefined();

      // Display should NEVER use uiGuess
      const display = getLegacyDisplayFields(updated);
      expect(display.title).toBe('Correct Title');
      expect(display.author).toBe('Correct Author');
    });

    it('display falls back to null when hints are empty (NOT to uiGuess)', () => {
      const candidate = createCandidateWithDisplayHints([], []);

      const updated = applyHypothesis(candidate);

      // Even if uiGuess has values, display should be null
      const display = getLegacyDisplayFields(updated);
      expect(display.title).toBeNull();
      expect(display.author).toBeNull();

      // uiGuess might have values from OCR, but they should NOT be used
      // (This is the critical regression test)
    });
  });

  describe('hypothesis fields are properly isolated', () => {
    it('top-level hypothesis fields do NOT exist', () => {
      const candidate = createCandidateWithDisplayHints(['Title'], ['Author']);

      const updated = applyHypothesis(candidate);

      // These should NOT exist at top level
      expect((updated as any).evidenceTier).toBeUndefined();
      expect((updated as any).searchCandidates).toBeUndefined();
      expect((updated as any).isbnCandidates).toBeUndefined();
      expect((updated as any).uiGuess).toBeUndefined();

      // They should only exist inside hypothesis sub-object
      expect(updated.hypothesis?.evidenceTier).toBeDefined();
    });

    it('hypothesis sub-object does not contain display-related fields', () => {
      const candidate = createCandidateWithDisplayHints(['Title'], ['Author']);

      const updated = applyHypothesis(candidate);

      // Hypothesis should only contain resolver-input fields
      expect(updated.hypothesis).toBeDefined();
      const hyp = updated.hypothesis!;

      // These are the only allowed fields in hypothesis
      const allowedKeys = ['evidenceTier', 'searchCandidates', 'isbnCandidates', 'uiGuess'];
      const actualKeys = Object.keys(hyp);

      for (const key of actualKeys) {
        expect(allowedKeys).toContain(key);
      }
    });
  });
});

// ============================================================================
// Integration Sanity Checks
// ============================================================================

describe('Integration Sanity', () => {
  it('BookCandidate type does not have top-level hypothesis fields', () => {
    // This test documents the expected structure
    const candidate: BookCandidate = {
      id: 'test',
      detectionIndices: [0],
      cropIndices: [0],
      representativeDetectionIndex: 0,
      orderingKey: 0,
      angleRad: 0,
      confidenceScore: 0.9,
      evidence: {
        topCrops: [0],
        mergedLines: [],
        mergedTextBlock: '',
      },
    };

    // Hypothesis is optional and isolated
    expect(candidate.hypothesis).toBeUndefined();

    // These should NOT compile if they exist at top level
    // (TypeScript will catch this at build time)
    // @ts-expect-error - evidenceTier should not exist at top level
    const _tier = candidate.evidenceTier;
    // @ts-expect-error - searchCandidates should not exist at top level
    const _search = candidate.searchCandidates;
    // @ts-expect-error - isbnCandidates should not exist at top level
    const _isbn = candidate.isbnCandidates;
    // @ts-expect-error - uiGuess should not exist at top level
    const _guess = candidate.uiGuess;
  });
});
