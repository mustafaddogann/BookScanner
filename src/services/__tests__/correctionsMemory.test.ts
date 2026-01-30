/**
 * Unit tests for Corrections Memory (Gate 10)
 */

import type { BookCandidate, BookEvidence, Correction } from '../../types';
import {
  generateContentHash,
  getCorrectionKey,
  findCorrection,
  applyCorrection,
  applyCorrectionsToCandidates,
  saveCorrection,
  deleteCorrection,
  hasAppliedCorrection,
  hasStoredCorrection,
  getCorrectionStats,
  exportCorrections,
  importCorrections,
} from '../correctionsMemory';
import { useCorrectionsStore } from '../../store/useCorrectionsStore';

// ============================================================================
// Test Utilities
// ============================================================================

function createMockEvidence(lines: string[] = ['Test Book', 'Test Author']): BookEvidence {
  return {
    topCrops: [0],
    mergedLines: lines.map((text, i) => ({
      text,
      normalizedText: text.toLowerCase().replace(/[^\w\s]/g, ''),
      confidence: 0.9,
      sourceCropIndex: 0,
      rotation: 0,
    })),
    mergedTextBlock: lines.join('\n'),
    perFieldHints: {
      titleHints: lines.length > 0 ? [lines[0]] : [],
      authorHints: lines.length > 1 ? [lines[1]] : [],
    },
  };
}

function createMockCandidate(
  id: string = 'test-candidate',
  evidence?: BookEvidence,
  isbn?: string
): BookCandidate {
  const ev = evidence ?? createMockEvidence();
  return {
    id,
    detectionIndices: [0],
    cropIndices: [0],
    representativeDetectionIndex: 0,
    orderingKey: 0,
    angleRad: 0,
    confidenceScore: 0.9,
    evidence: ev,
    hypothesis: isbn
      ? {
          evidenceTier: 'strong',
          searchCandidates: [],
          isbnCandidates: [isbn],
          uiGuess: null,
        }
      : undefined,
  };
}

// ============================================================================
// Setup/Teardown
// ============================================================================

beforeEach(() => {
  // Clear corrections store before each test
  useCorrectionsStore.getState().clearAll();
});

// ============================================================================
// Content Hash Tests
// ============================================================================

describe('generateContentHash', () => {
  it('generates consistent hash for same evidence', () => {
    const evidence = createMockEvidence(['The Great Gatsby', 'F. Scott Fitzgerald']);
    const hash1 = generateContentHash(evidence);
    const hash2 = generateContentHash(evidence);
    expect(hash1).toBe(hash2);
  });

  it('generates different hash for different evidence', () => {
    const evidence1 = createMockEvidence(['The Great Gatsby', 'F. Scott Fitzgerald']);
    const evidence2 = createMockEvidence(['To Kill a Mockingbird', 'Harper Lee']);
    const hash1 = generateContentHash(evidence1);
    const hash2 = generateContentHash(evidence2);
    expect(hash1).not.toBe(hash2);
  });

  it('ignores punctuation and case', () => {
    const evidence1 = createMockEvidence(['The Great Gatsby!', 'F. Scott Fitzgerald']);
    const evidence2 = createMockEvidence(['the great gatsby', 'f scott fitzgerald']);
    const hash1 = generateContentHash(evidence1);
    const hash2 = generateContentHash(evidence2);
    expect(hash1).toBe(hash2);
  });

  it('filters short lines (< 4 chars)', () => {
    // Create evidence with consistent perFieldHints to isolate line filtering behavior
    const sharedHints = {
      titleHints: ['The Great Gatsby'],
      authorHints: ['F. Scott Fitzgerald'],
    };

    // Evidence with a short line ('a') that should be filtered out
    const evidence1: BookEvidence = {
      topCrops: [0],
      mergedLines: ['The Great Gatsby', 'a', 'F. Scott Fitzgerald'].map((text) => ({
        text,
        normalizedText: text.toLowerCase().replace(/[^\w\s]/g, ''),
        confidence: 0.9,
        sourceCropIndex: 0,
        rotation: 0,
      })),
      mergedTextBlock: 'The Great Gatsby\na\nF. Scott Fitzgerald',
      perFieldHints: sharedHints,
    };

    // Evidence without the short line
    const evidence2: BookEvidence = {
      topCrops: [0],
      mergedLines: ['The Great Gatsby', 'F. Scott Fitzgerald'].map((text) => ({
        text,
        normalizedText: text.toLowerCase().replace(/[^\w\s]/g, ''),
        confidence: 0.9,
        sourceCropIndex: 0,
        rotation: 0,
      })),
      mergedTextBlock: 'The Great Gatsby\nF. Scott Fitzgerald',
      perFieldHints: sharedHints,
    };

    const hash1 = generateContentHash(evidence1);
    const hash2 = generateContentHash(evidence2);
    expect(hash1).toBe(hash2);
  });

  it('returns "empty-evidence" for empty lines', () => {
    const evidence: BookEvidence = {
      topCrops: [],
      mergedLines: [],
      mergedTextBlock: '',
    };
    const hash = generateContentHash(evidence);
    expect(hash).toBe('empty-evidence');
  });

  it('uses mergedTextBlock fallback when lines are empty', () => {
    const evidence: BookEvidence = {
      topCrops: [],
      mergedLines: [],
      mergedTextBlock: 'The Great Gatsby F Scott Fitzgerald',
    };
    const hash = generateContentHash(evidence);
    expect(hash).not.toBe('empty-evidence');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('produces identical hash for same lines in different orders (order-independence)', () => {
    // Create evidence with same lines but different orders
    // Use consistent perFieldHints to isolate line-order behavior
    const lines1 = ['The Great Gatsby', 'F. Scott Fitzgerald', 'Scribner'];
    const lines2 = ['Scribner', 'F. Scott Fitzgerald', 'The Great Gatsby'];
    const lines3 = ['F. Scott Fitzgerald', 'Scribner', 'The Great Gatsby'];

    // All evidence shares the same consistent perFieldHints
    const sharedHints = {
      titleHints: ['The Great Gatsby'],
      authorHints: ['F. Scott Fitzgerald'],
    };

    const evidence1: BookEvidence = {
      topCrops: [0],
      mergedLines: lines1.map((text, i) => ({
        text,
        normalizedText: text.toLowerCase().replace(/[^\w\s]/g, ''),
        confidence: 0.9,
        sourceCropIndex: 0,
        rotation: 0,
      })),
      mergedTextBlock: lines1.join('\n'),
      perFieldHints: sharedHints,
    };

    const evidence2: BookEvidence = {
      topCrops: [0],
      mergedLines: lines2.map((text, i) => ({
        text,
        normalizedText: text.toLowerCase().replace(/[^\w\s]/g, ''),
        confidence: 0.9,
        sourceCropIndex: 0,
        rotation: 0,
      })),
      mergedTextBlock: lines2.join('\n'),
      perFieldHints: sharedHints,
    };

    const evidence3: BookEvidence = {
      topCrops: [0],
      mergedLines: lines3.map((text, i) => ({
        text,
        normalizedText: text.toLowerCase().replace(/[^\w\s]/g, ''),
        confidence: 0.9,
        sourceCropIndex: 0,
        rotation: 0,
      })),
      mergedTextBlock: lines3.join('\n'),
      perFieldHints: sharedHints,
    };

    const hash1 = generateContentHash(evidence1);
    const hash2 = generateContentHash(evidence2);
    const hash3 = generateContentHash(evidence3);

    // All should be identical due to line sorting
    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it('handles perFieldHints in hash computation', () => {
    const evidence1 = createMockEvidence(['Test Book', 'Test Author']);
    const evidence2 = createMockEvidence(['Test Book', 'Test Author']);
    // Both have same perFieldHints from createMockEvidence
    const hash1 = generateContentHash(evidence1);
    const hash2 = generateContentHash(evidence2);
    expect(hash1).toBe(hash2);
  });
});

// ============================================================================
// Correction Key Tests
// ============================================================================

describe('getCorrectionKey', () => {
  it('uses ISBN when available', () => {
    const candidate = createMockCandidate('test', undefined, '9780743273565');
    const key = getCorrectionKey(candidate);
    expect(key).toBe('isbn:9780743273565');
  });

  it('uses content hash when no ISBN', () => {
    const candidate = createMockCandidate('test');
    const key = getCorrectionKey(candidate);
    expect(key.startsWith('hash:')).toBe(true);
  });

  it('uses resolved book ISBN if hypothesis ISBN not available', () => {
    const candidate = createMockCandidate('test');
    candidate.resolvedBook = {
      title: 'Test',
      authors: ['Author'],
      isbn13: '9780743273565',
      source: 'openLibrary',
    };
    const key = getCorrectionKey(candidate);
    expect(key).toBe('isbn:9780743273565');
  });
});

// ============================================================================
// Store Operations Tests
// ============================================================================

describe('useCorrectionsStore', () => {
  it('sets and gets corrections', () => {
    const store = useCorrectionsStore.getState();
    const correction: Correction = {
      contentHash: 'abc123',
      isbn: null,
      correctedTitle: 'Fixed Title',
      correctedAuthor: 'Fixed Author',
      originalTitle: 'Original Title',
      originalAuthor: 'Original Author',
      createdAt: new Date().toISOString(),
      applyCount: 0,
    };

    store.setCorrection('hash:abc123', correction);
    const retrieved = store.getCorrection('hash:abc123');

    expect(retrieved).toBeDefined();
    expect(retrieved?.correctedTitle).toBe('Fixed Title');
  });

  it('deletes corrections', () => {
    const store = useCorrectionsStore.getState();
    const correction: Correction = {
      contentHash: 'abc123',
      isbn: null,
      correctedTitle: 'Fixed Title',
      correctedAuthor: null,
      originalTitle: 'Original Title',
      originalAuthor: null,
      createdAt: new Date().toISOString(),
      applyCount: 0,
    };

    store.setCorrection('hash:abc123', correction);
    expect(store.getCorrection('hash:abc123')).toBeDefined();

    store.deleteCorrection('hash:abc123');
    expect(store.getCorrection('hash:abc123')).toBeUndefined();
  });

  it('increments apply count', () => {
    const store = useCorrectionsStore.getState();
    const correction: Correction = {
      contentHash: 'abc123',
      isbn: null,
      correctedTitle: 'Fixed Title',
      correctedAuthor: null,
      originalTitle: 'Original Title',
      originalAuthor: null,
      createdAt: new Date().toISOString(),
      applyCount: 0,
    };

    store.setCorrection('hash:abc123', correction);
    store.incrementApplyCount('hash:abc123');
    store.incrementApplyCount('hash:abc123');

    const updated = store.getCorrection('hash:abc123');
    expect(updated?.applyCount).toBe(2);
  });

  it('clears all corrections', () => {
    const store = useCorrectionsStore.getState();
    store.setCorrection('key1', { contentHash: '1' } as Correction);
    store.setCorrection('key2', { contentHash: '2' } as Correction);

    expect(store.getCount()).toBe(2);

    store.clearAll();
    expect(store.getCount()).toBe(0);
  });
});

// ============================================================================
// Find and Apply Correction Tests
// ============================================================================

describe('findCorrection', () => {
  it('returns null when no correction exists', () => {
    const candidate = createMockCandidate('test');
    const result = findCorrection(candidate);
    expect(result).toBeNull();
  });

  it('finds correction by ISBN', () => {
    const store = useCorrectionsStore.getState();
    const correction: Correction = {
      contentHash: 'xyz',
      isbn: '9780743273565',
      correctedTitle: 'The Great Gatsby',
      correctedAuthor: 'F. Scott Fitzgerald',
      originalTitle: 'The Gr3at Gatsby',
      originalAuthor: null,
      createdAt: new Date().toISOString(),
      applyCount: 0,
    };

    store.setCorrection('isbn:9780743273565', correction);

    const candidate = createMockCandidate('test', undefined, '9780743273565');
    const result = findCorrection(candidate);

    expect(result).toBeDefined();
    expect(result?.correctedTitle).toBe('The Great Gatsby');
  });

  it('finds correction by content hash', () => {
    const evidence = createMockEvidence(['Test Book', 'Test Author']);
    const candidate = createMockCandidate('test', evidence);
    const hash = generateContentHash(evidence);

    const correction: Correction = {
      contentHash: hash,
      isbn: null,
      correctedTitle: 'Corrected Title',
      correctedAuthor: null,
      originalTitle: 'Test Book',
      originalAuthor: null,
      createdAt: new Date().toISOString(),
      applyCount: 0,
    };

    useCorrectionsStore.getState().setCorrection(`hash:${hash}`, correction);

    const result = findCorrection(candidate);
    expect(result).toBeDefined();
    expect(result?.correctedTitle).toBe('Corrected Title');
  });
});

describe('applyCorrection', () => {
  it('returns unchanged candidate when no correction exists', () => {
    const candidate = createMockCandidate('test');
    const result = applyCorrection(candidate);

    expect(result.applied).toBe(false);
    expect(result.correction).toBeUndefined();
    expect(result.candidate.appliedCorrection).toBeUndefined();
  });

  it('applies correction and marks candidate', () => {
    const evidence = createMockEvidence(['Test Book', 'Test Author']);
    const candidate = createMockCandidate('test', evidence);
    const hash = generateContentHash(evidence);

    const correction: Correction = {
      contentHash: hash,
      isbn: null,
      correctedTitle: 'Corrected Title',
      correctedAuthor: 'Corrected Author',
      originalTitle: 'Test Book',
      originalAuthor: 'Test Author',
      createdAt: new Date().toISOString(),
      applyCount: 0,
    };

    useCorrectionsStore.getState().setCorrection(`hash:${hash}`, correction);

    const result = applyCorrection(candidate);

    expect(result.applied).toBe(true);
    expect(result.correction).toBeDefined();
    expect(result.candidate.appliedCorrection).toBeDefined();
    expect(result.candidate.appliedCorrection?.correctedTitle).toBe('Corrected Title');
  });

  it('increments apply count when correction is applied', () => {
    const evidence = createMockEvidence(['Test Book', 'Test Author']);
    const candidate = createMockCandidate('test', evidence);
    const hash = generateContentHash(evidence);

    const correction: Correction = {
      contentHash: hash,
      isbn: null,
      correctedTitle: 'Corrected Title',
      correctedAuthor: null,
      originalTitle: 'Test Book',
      originalAuthor: null,
      createdAt: new Date().toISOString(),
      applyCount: 0,
    };

    const key = `hash:${hash}`;
    useCorrectionsStore.getState().setCorrection(key, correction);

    // Apply correction twice
    applyCorrection(candidate);
    applyCorrection(candidate);

    const updated = useCorrectionsStore.getState().getCorrection(key);
    expect(updated?.applyCount).toBe(2);
  });
});

describe('applyCorrectionsToCandidates', () => {
  it('applies corrections to multiple candidates', () => {
    const evidence1 = createMockEvidence(['Book One', 'Author One']);
    const evidence2 = createMockEvidence(['Book Two', 'Author Two']);

    const candidate1 = createMockCandidate('c1', evidence1);
    const candidate2 = createMockCandidate('c2', evidence2);

    // Add correction only for candidate1
    const hash1 = generateContentHash(evidence1);
    const correction: Correction = {
      contentHash: hash1,
      isbn: null,
      correctedTitle: 'Corrected Book One',
      correctedAuthor: null,
      originalTitle: 'Book One',
      originalAuthor: null,
      createdAt: new Date().toISOString(),
      applyCount: 0,
    };
    useCorrectionsStore.getState().setCorrection(`hash:${hash1}`, correction);

    const results = applyCorrectionsToCandidates([candidate1, candidate2]);

    expect(results[0].appliedCorrection).toBeDefined();
    expect(results[1].appliedCorrection).toBeUndefined();
  });
});

// ============================================================================
// Save and Delete Correction Tests
// ============================================================================

describe('saveCorrection', () => {
  it('saves correction for candidate', () => {
    const candidate = createMockCandidate('test');
    saveCorrection(candidate, 'New Title', 'New Author');

    const key = getCorrectionKey(candidate);
    const stored = useCorrectionsStore.getState().getCorrection(key);

    expect(stored).toBeDefined();
    expect(stored?.correctedTitle).toBe('New Title');
    expect(stored?.correctedAuthor).toBe('New Author');
  });

  it('does not save if nothing changed', () => {
    const evidence = createMockEvidence(['Same Title', 'Same Author']);
    const candidate = createMockCandidate('test', evidence);

    saveCorrection(candidate, 'Same Title', 'Same Author');

    const key = getCorrectionKey(candidate);
    const stored = useCorrectionsStore.getState().getCorrection(key);

    expect(stored).toBeUndefined();
  });
});

describe('deleteCorrection', () => {
  it('removes stored correction', () => {
    const candidate = createMockCandidate('test');
    saveCorrection(candidate, 'New Title', null);

    const key = getCorrectionKey(candidate);
    expect(useCorrectionsStore.getState().getCorrection(key)).toBeDefined();

    deleteCorrection(candidate);
    expect(useCorrectionsStore.getState().getCorrection(key)).toBeUndefined();
  });
});

// ============================================================================
// Helper Function Tests
// ============================================================================

describe('hasAppliedCorrection', () => {
  it('returns false for candidate without applied correction', () => {
    const candidate = createMockCandidate('test');
    expect(hasAppliedCorrection(candidate)).toBe(false);
  });

  it('returns true for candidate with applied correction', () => {
    const candidate = createMockCandidate('test');
    candidate.appliedCorrection = {
      contentHash: 'abc',
      isbn: null,
      correctedTitle: 'Title',
      correctedAuthor: null,
      originalTitle: 'Old',
      originalAuthor: null,
      createdAt: new Date().toISOString(),
      applyCount: 1,
    };
    expect(hasAppliedCorrection(candidate)).toBe(true);
  });
});

describe('hasStoredCorrection', () => {
  it('returns false when no stored correction', () => {
    const candidate = createMockCandidate('test');
    expect(hasStoredCorrection(candidate)).toBe(false);
  });

  it('returns true when stored correction exists', () => {
    const candidate = createMockCandidate('test');
    saveCorrection(candidate, 'New Title', null);
    expect(hasStoredCorrection(candidate)).toBe(true);
  });
});

// ============================================================================
// Statistics and Export/Import Tests
// ============================================================================

describe('getCorrectionStats', () => {
  it('returns zeros when no corrections', () => {
    const stats = getCorrectionStats();
    expect(stats.totalCorrections).toBe(0);
    expect(stats.totalApplyCount).toBe(0);
    expect(stats.mostApplied).toBeNull();
  });

  it('returns correct stats', () => {
    const store = useCorrectionsStore.getState();

    store.setCorrection('key1', {
      contentHash: '1',
      isbn: null,
      correctedTitle: 'T1',
      correctedAuthor: null,
      originalTitle: 'O1',
      originalAuthor: null,
      createdAt: new Date().toISOString(),
      applyCount: 5,
    });

    store.setCorrection('key2', {
      contentHash: '2',
      isbn: null,
      correctedTitle: 'T2',
      correctedAuthor: null,
      originalTitle: 'O2',
      originalAuthor: null,
      createdAt: new Date().toISOString(),
      applyCount: 3,
    });

    const stats = getCorrectionStats();
    expect(stats.totalCorrections).toBe(2);
    expect(stats.totalApplyCount).toBe(8);
    expect(stats.mostApplied?.correctedTitle).toBe('T1');
  });
});

describe('exportCorrections', () => {
  it('exports all corrections as JSON', () => {
    const store = useCorrectionsStore.getState();
    store.setCorrection('key1', {
      contentHash: 'abc',
      isbn: null,
      correctedTitle: 'Title',
      correctedAuthor: null,
      originalTitle: 'Old',
      originalAuthor: null,
      createdAt: '2025-01-01T00:00:00Z',
      applyCount: 0,
    });

    const json = exportCorrections();
    const parsed = JSON.parse(json);

    expect(parsed.key1).toBeDefined();
    expect(parsed.key1.correctedTitle).toBe('Title');
  });
});

describe('importCorrections', () => {
  it('imports corrections from JSON', () => {
    const json = JSON.stringify({
      'isbn:123': {
        contentHash: 'xyz',
        isbn: '123',
        correctedTitle: 'Imported Title',
        correctedAuthor: null,
        originalTitle: 'Original',
        originalAuthor: null,
        createdAt: '2025-01-01T00:00:00Z',
        applyCount: 0,
      },
    });

    const count = importCorrections(json);
    expect(count).toBe(1);

    const stored = useCorrectionsStore.getState().getCorrection('isbn:123');
    expect(stored?.correctedTitle).toBe('Imported Title');
  });

  it('returns 0 for invalid JSON', () => {
    const count = importCorrections('invalid json');
    expect(count).toBe(0);
  });
});

// ============================================================================
// Full Save -> Load -> Apply Flow Test
// ============================================================================

describe('save -> load -> apply flow', () => {
  it('saves correction, then finds and applies it to a new candidate with same evidence', () => {
    // Step 1: Create original candidate and save a correction
    const originalEvidence = createMockEvidence(['The Great Gatsby', 'F. Scott Fitzgerald', 'Scribner']);
    const originalCandidate = createMockCandidate('original', originalEvidence);

    // Save user correction
    saveCorrection(originalCandidate, 'The Great Gatsby (Corrected)', 'F. Scott Fitzgerald');

    // Verify correction was saved
    const key = getCorrectionKey(originalCandidate);
    const storedCorrection = useCorrectionsStore.getState().getCorrection(key);
    expect(storedCorrection).toBeDefined();
    expect(storedCorrection?.correctedTitle).toBe('The Great Gatsby (Corrected)');

    // Step 2: Create NEW candidate with same evidence (simulating re-scan)
    // Lines in DIFFERENT order to test order-independence
    const rescanEvidence = createMockEvidence(['Scribner', 'The Great Gatsby', 'F. Scott Fitzgerald']);
    const rescanCandidate = createMockCandidate('rescan', rescanEvidence);

    // Step 3: Find correction for new candidate
    const foundCorrection = findCorrection(rescanCandidate);
    expect(foundCorrection).toBeDefined();
    expect(foundCorrection?.correctedTitle).toBe('The Great Gatsby (Corrected)');

    // Step 4: Apply correction to new candidate
    const result = applyCorrection(rescanCandidate);

    expect(result.applied).toBe(true);
    expect(result.candidate.appliedCorrection).toBeDefined();
    expect(result.candidate.appliedCorrection?.correctedTitle).toBe('The Great Gatsby (Corrected)');
    expect(result.candidate.appliedCorrection?.correctedAuthor).toBe('F. Scott Fitzgerald');

    // Verify apply count incremented
    const updatedCorrection = useCorrectionsStore.getState().getCorrection(key);
    expect(updatedCorrection?.applyCount).toBe(1);
  });

  it('applies ISBN-based correction regardless of text content', () => {
    // Step 1: Create candidate with ISBN and save correction
    const evidence1 = createMockEvidence(['Gatsby', 'Fitzgerald']);
    const candidate1 = createMockCandidate('c1', evidence1, '9780743273565');

    saveCorrection(candidate1, 'The Great Gatsby', 'F. Scott Fitzgerald');

    // Step 2: Create new candidate with SAME ISBN but DIFFERENT text
    const evidence2 = createMockEvidence(['Completely Different Text', 'Unknown Author']);
    const candidate2 = createMockCandidate('c2', evidence2, '9780743273565');

    // Step 3: Should still find and apply correction via ISBN
    const result = applyCorrection(candidate2);

    expect(result.applied).toBe(true);
    expect(result.candidate.appliedCorrection?.correctedTitle).toBe('The Great Gatsby');
  });
});
