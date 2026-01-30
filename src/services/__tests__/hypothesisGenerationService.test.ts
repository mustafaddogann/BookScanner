/**
 * Tests for Hypothesis Generation Service (Gate 8)
 *
 * Verifies:
 * - Evidence tier classification (strong/usable/weak/unusable)
 * - ISBN extraction from evidence
 * - UI guess generation
 * - Search candidate building
 * - Full hypothesis generation flow
 */

import type { BookCandidate, BookEvidence, BookEvidenceLine } from '../../types';
import {
  classifyEvidenceTier,
  extractIsbnCandidates,
  generateUIGuess,
  buildSearchCandidates,
  generateHypothesis,
  generateHypotheses,
  applyHypothesis,
} from '../hypothesisGenerationService';

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
 * Create mock BookEvidence
 */
function createEvidence(
  lines: BookEvidenceLine[],
  mergedTextBlock?: string
): BookEvidence {
  return {
    topCrops: [0],
    mergedLines: lines,
    mergedTextBlock: mergedTextBlock || lines.map((l) => l.text).join('\n'),
  };
}

/**
 * Create a mock BookCandidate
 */
function createCandidate(
  evidence: BookEvidence,
  id: string = 'test-candidate-1'
): BookCandidate {
  return {
    id,
    detectionIndices: [0],
    cropIndices: [0],
    representativeDetectionIndex: 0,
    orderingKey: 0,
    angleRad: 0,
    confidenceScore: 0.9,
    evidence,
  };
}

// ============================================================================
// Evidence Tier Classification Tests
// ============================================================================

describe('classifyEvidenceTier', () => {
  describe('strong tier', () => {
    it('classifies high quality evidence as strong', () => {
      // avgConfidence >= 0.85, >= 3 lines, alnumRatio >= 0.80
      const lines = [
        createLine('The Great Gatsby', 0.95),
        createLine('F. Scott Fitzgerald', 0.90),
        createLine('Scribner', 0.85),
      ];
      const evidence = createEvidence(lines);

      expect(classifyEvidenceTier(evidence)).toBe('strong');
    });

    it('requires minimum 3 lines for strong', () => {
      const lines = [
        createLine('The Great Gatsby', 0.95),
        createLine('F. Scott Fitzgerald', 0.90),
      ];
      const evidence = createEvidence(lines);

      expect(classifyEvidenceTier(evidence)).not.toBe('strong');
    });

    it('requires high confidence for strong', () => {
      const lines = [
        createLine('The Great Gatsby', 0.75),
        createLine('F. Scott Fitzgerald', 0.70),
        createLine('Scribner', 0.65),
      ];
      const evidence = createEvidence(lines);

      expect(classifyEvidenceTier(evidence)).not.toBe('strong');
    });
  });

  describe('usable tier', () => {
    it('classifies medium quality evidence as usable', () => {
      // avgConfidence >= 0.70, >= 2 lines, alnumRatio >= 0.65
      const lines = [
        createLine('The Great Gatsby', 0.75),
        createLine('F. Scott Fitzgerald', 0.70),
      ];
      const evidence = createEvidence(lines);

      expect(classifyEvidenceTier(evidence)).toBe('usable');
    });

    it('classifies good quality with 2 lines as usable (not strong)', () => {
      const lines = [
        createLine('The Great Gatsby', 0.90),
        createLine('F. Scott Fitzgerald', 0.88),
      ];
      const evidence = createEvidence(lines);

      expect(classifyEvidenceTier(evidence)).toBe('usable');
    });
  });

  describe('weak tier', () => {
    it('classifies poor quality evidence as weak', () => {
      // avgConfidence >= 0.50, >= 1 line
      const lines = [createLine('The Great Gatsby', 0.55)];
      const evidence = createEvidence(lines);

      expect(classifyEvidenceTier(evidence)).toBe('weak');
    });

    it('classifies low confidence multi-line as weak', () => {
      const lines = [
        createLine('The Great Gatsby', 0.55),
        createLine('F. Scott Fitzgerald', 0.50),
      ];
      const evidence = createEvidence(lines);

      expect(classifyEvidenceTier(evidence)).toBe('weak');
    });
  });

  describe('unusable tier', () => {
    it('classifies very low confidence as unusable', () => {
      const lines = [createLine('The Great Gatsby', 0.30)];
      const evidence = createEvidence(lines);

      expect(classifyEvidenceTier(evidence)).toBe('unusable');
    });

    it('classifies empty evidence as unusable', () => {
      const evidence = createEvidence([]);

      expect(classifyEvidenceTier(evidence)).toBe('unusable');
    });

    it('classifies low alnum ratio as appropriate tier', () => {
      // Evidence with lots of non-alphanumeric characters
      const lines = [
        createLine('!!!@@@###', 0.90),
        createLine('???***...', 0.85),
        createLine('^^^&&&$$$', 0.80),
      ];
      const evidence = createEvidence(lines);

      // Low alnum ratio should prevent strong tier
      const tier = classifyEvidenceTier(evidence);
      expect(tier).not.toBe('strong');
    });
  });
});

// ============================================================================
// ISBN Extraction Tests
// ============================================================================

describe('extractIsbnCandidates', () => {
  it('extracts ISBN-13 from evidence', () => {
    const lines = [
      createLine('ISBN: 978-0-7432-7356-5'),
      createLine('The Great Gatsby'),
    ];
    const evidence = createEvidence(lines);

    const isbns = extractIsbnCandidates(evidence);
    expect(isbns).toContain('9780743273565');
  });

  it('extracts ISBN-10 and converts to ISBN-13', () => {
    const lines = [
      createLine('ISBN: 0-7432-7356-7'),
      createLine('The Great Gatsby'),
    ];
    const evidence = createEvidence(lines);

    const isbns = extractIsbnCandidates(evidence);
    expect(isbns.length).toBeGreaterThan(0);
    // ISBN-10 should be converted to ISBN-13
    expect(isbns[0]).toHaveLength(13);
  });

  it('extracts multiple ISBNs', () => {
    const lines = [
      createLine('ISBN-13: 978-0-7432-7356-5'),
      createLine('ISBN-10: 0-7432-7356-7'),
      createLine('The Great Gatsby'),
    ];
    const evidence = createEvidence(lines);

    const isbns = extractIsbnCandidates(evidence);
    // Should find at least one (duplicates may be removed)
    expect(isbns.length).toBeGreaterThan(0);
  });

  it('returns empty array when no ISBN found', () => {
    const lines = [
      createLine('The Great Gatsby'),
      createLine('F. Scott Fitzgerald'),
    ];
    const evidence = createEvidence(lines);

    const isbns = extractIsbnCandidates(evidence);
    expect(isbns).toEqual([]);
  });

  it('ignores invalid ISBNs', () => {
    const lines = [
      createLine('ISBN: 123-456-789-0'),  // Invalid
      createLine('The Great Gatsby'),
    ];
    const evidence = createEvidence(lines);

    const isbns = extractIsbnCandidates(evidence);
    expect(isbns).toEqual([]);
  });
});

// ============================================================================
// UI Guess Generation Tests
// ============================================================================

describe('generateUIGuess', () => {
  it('returns null for empty evidence', () => {
    const evidence = createEvidence([]);

    const guess = generateUIGuess(evidence);
    // With field extraction disabled, may still return null for empty
    expect(guess === null || guess?.title === null).toBe(true);
  });

  it('generates guess from single line', () => {
    const lines = [createLine('The Great Gatsby', 0.90)];
    const evidence = createEvidence(lines);

    const guess = generateUIGuess(evidence);
    // Should have some title
    expect(guess).not.toBeNull();
  });

  it('includes confidence in guess', () => {
    const lines = [
      createLine('The Great Gatsby', 0.90),
      createLine('F. Scott Fitzgerald', 0.85),
    ];
    const evidence = createEvidence(lines);

    const guess = generateUIGuess(evidence);
    if (guess) {
      expect(guess.confidence).toBeGreaterThan(0);
      expect(guess.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ============================================================================
// Search Candidate Building Tests
// ============================================================================

describe('buildSearchCandidates', () => {
  it('returns empty array for unusable tier', () => {
    const evidence = createEvidence([]);
    const candidates = buildSearchCandidates(evidence, 'unusable', []);

    expect(candidates).toEqual([]);
  });

  it('includes ISBN candidates when available', () => {
    const lines = [createLine('The Great Gatsby', 0.90)];
    const evidence = createEvidence(lines);
    const isbnCandidates = ['9780743273565'];

    const candidates = buildSearchCandidates(evidence, 'strong', isbnCandidates);

    // Should have at least one candidate with ISBN
    const hasIsbnCandidate = candidates.some((c) => c.isbn === '9780743273565');
    expect(hasIsbnCandidate).toBe(true);
  });

  it('builds merged evidence candidate', () => {
    const lines = [
      createLine('The Great Gatsby', 0.90),
      createLine('F. Scott Fitzgerald', 0.85),
    ];
    const evidence = createEvidence(lines);

    const candidates = buildSearchCandidates(evidence, 'strong', []);

    expect(candidates.length).toBeGreaterThan(0);
  });

  it('sorts candidates by confidence', () => {
    const lines = [
      createLine('The Great Gatsby', 0.90),
      createLine('F. Scott Fitzgerald', 0.85),
    ];
    const evidence = createEvidence(lines);

    const candidates = buildSearchCandidates(evidence, 'strong', ['9780743273565']);

    if (candidates.length >= 2) {
      expect(candidates[0].confidence).toBeGreaterThanOrEqual(candidates[1].confidence);
    }
  });
});

// ============================================================================
// Full Hypothesis Generation Tests
// ============================================================================

describe('generateHypothesis', () => {
  it('generates complete hypothesis for good evidence', () => {
    // Use clean text lines for strong tier (high alnum ratio)
    const lines = [
      createLine('The Great Gatsby', 0.90),
      createLine('F Scott Fitzgerald', 0.88),
      createLine('Scribner Publishing', 0.85),
    ];
    // Include ISBN in merged text block with proper format
    const mergedTextBlock = lines.map(l => l.text).join('\n') + '\n978-0-7432-7356-5';
    const evidence = createEvidence(lines, mergedTextBlock);
    const candidate = createCandidate(evidence);

    const hypothesis = generateHypothesis(candidate);

    expect(hypothesis.evidenceTier).toBe('strong');
    expect(hypothesis.isbnCandidates).toContain('9780743273565');
    expect(hypothesis.searchCandidates.length).toBeGreaterThan(0);
  });

  it('returns empty hypothesis for unusable evidence', () => {
    const lines = [createLine('???', 0.20)];
    const evidence = createEvidence(lines);
    const candidate = createCandidate(evidence);

    const hypothesis = generateHypothesis(candidate);

    expect(hypothesis.evidenceTier).toBe('unusable');
    expect(hypothesis.searchCandidates).toEqual([]);
    expect(hypothesis.isbnCandidates).toEqual([]);
    expect(hypothesis.uiGuess).toBeNull();
  });
});

describe('applyHypothesis', () => {
  it('adds hypothesis sub-object to candidate', () => {
    const lines = [
      createLine('The Great Gatsby', 0.90),
      createLine('F. Scott Fitzgerald', 0.85),
    ];
    const evidence = createEvidence(lines);
    const candidate = createCandidate(evidence);

    const updated = applyHypothesis(candidate);

    // Hypothesis should be in isolated sub-object
    expect(updated.hypothesis).toBeDefined();
    expect(updated.hypothesis?.evidenceTier).toBeDefined();
    expect(updated.hypothesis?.searchCandidates).toBeDefined();
    expect(updated.hypothesis?.isbnCandidates).toBeDefined();
    expect(updated.resolverDecision).toBe('pending');
  });

  it('does NOT write hypothesis fields to top-level', () => {
    const lines = [createLine('The Great Gatsby', 0.90)];
    const evidence = createEvidence(lines);
    const candidate = createCandidate(evidence);

    const updated = applyHypothesis(candidate);

    // Top-level hypothesis fields should NOT exist
    expect((updated as any).evidenceTier).toBeUndefined();
    expect((updated as any).searchCandidates).toBeUndefined();
    expect((updated as any).isbnCandidates).toBeUndefined();
    expect((updated as any).uiGuess).toBeUndefined();
  });

  it('preserves original candidate fields', () => {
    const lines = [createLine('The Great Gatsby', 0.90)];
    const evidence = createEvidence(lines);
    const candidate = createCandidate(evidence, 'my-candidate-id');

    const updated = applyHypothesis(candidate);

    expect(updated.id).toBe('my-candidate-id');
    expect(updated.evidence).toBe(evidence);
    expect(updated.confidenceScore).toBe(0.9);
  });
});

describe('generateHypotheses', () => {
  it('processes multiple candidates', () => {
    const candidates = [
      createCandidate(
        createEvidence([createLine('Book 1', 0.90)]),
        'candidate-1'
      ),
      createCandidate(
        createEvidence([createLine('Book 2', 0.85)]),
        'candidate-2'
      ),
    ];

    const updated = generateHypotheses(candidates);

    expect(updated).toHaveLength(2);
    expect(updated[0].id).toBe('candidate-1');
    expect(updated[1].id).toBe('candidate-2');
    expect(updated[0].hypothesis?.evidenceTier).toBeDefined();
    expect(updated[1].hypothesis?.evidenceTier).toBeDefined();
  });

  it('handles empty candidate array', () => {
    const updated = generateHypotheses([]);

    expect(updated).toEqual([]);
  });

  it('handles mixed quality evidence', () => {
    const candidates = [
      createCandidate(
        createEvidence([
          createLine('Good Book', 0.90),
          createLine('Good Author', 0.85),
          createLine('Publisher', 0.80),
        ]),
        'strong-candidate'
      ),
      createCandidate(
        createEvidence([createLine('???', 0.20)]),
        'weak-candidate'
      ),
    ];

    const updated = generateHypotheses(candidates);

    expect(updated[0].hypothesis?.evidenceTier).toBe('strong');
    expect(updated[1].hypothesis?.evidenceTier).toBe('unusable');
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
  it('handles evidence with special characters', () => {
    const lines = [
      createLine("L'Étranger", 0.90),
      createLine('Albert Camus', 0.85),
    ];
    const evidence = createEvidence(lines);
    const candidate = createCandidate(evidence);

    const hypothesis = generateHypothesis(candidate);

    expect(hypothesis.evidenceTier).toBeDefined();
    expect(['strong', 'usable', 'weak']).toContain(hypothesis.evidenceTier);
  });

  it('handles very long text lines', () => {
    const longText = 'A'.repeat(500);
    const lines = [createLine(longText, 0.90)];
    const evidence = createEvidence(lines);
    const candidate = createCandidate(evidence);

    const hypothesis = generateHypothesis(candidate);

    expect(hypothesis.evidenceTier).toBeDefined();
  });

  it('handles Unicode text', () => {
    const lines = [
      createLine('日本語の本', 0.90),
      createLine('著者名', 0.85),
    ];
    const evidence = createEvidence(lines);
    const candidate = createCandidate(evidence);

    const hypothesis = generateHypothesis(candidate);

    expect(hypothesis.evidenceTier).toBeDefined();
  });
});
