/**
 * Corrections Memory Service
 * Gate 10: Corrections Memory
 *
 * Provides automatic application of user corrections to book candidates.
 * Matches by ISBN (preferred) or by content hash of OCR evidence.
 */

import type {
  BookCandidate,
  BookEvidence,
  Correction,
  CorrectionKey,
  CorrectionApplyResult,
} from '../types';
import { useCorrectionsStore } from '../store/useCorrectionsStore';
import { computeEvidenceHash } from '../utils/evidenceHash';
import { logDiagnostic } from '../config/debug';
import { persistCorrection } from './correctionsPersistenceService';

// ============================================================================
// Content Hash Generation
// ============================================================================

/**
 * Generate a stable, deterministic hash from OCR evidence for matching.
 * This hash is used when no ISBN is available.
 *
 * Uses computeEvidenceHash which:
 * 1. Normalizes text (lowercase, remove punctuation)
 * 2. Sorts lines alphabetically for order-independence
 * 3. Uses FNV-1a hash for stability across environments
 *
 * Order-independence guarantee: Same lines in different orders produce identical hashes.
 */
export function generateContentHash(evidence: BookEvidence): string {
  // Handle empty evidence
  if (!evidence.mergedLines?.length && !evidence.mergedTextBlock) {
    return 'empty-evidence';
  }

  // Use the shared evidenceHash utility for consistency
  return computeEvidenceHash(evidence);
}

// ============================================================================
// Key Generation
// ============================================================================

/**
 * Get the correction key for a candidate.
 * Prefers ISBN if available, falls back to content hash.
 */
export function getCorrectionKey(candidate: BookCandidate): CorrectionKey {
  // Check for ISBN in various places
  const isbn = getIsbnFromCandidate(candidate);
  if (isbn) {
    return `isbn:${isbn}`;
  }

  // Fall back to content hash
  const hash = generateContentHash(candidate.evidence);
  return `hash:${hash}`;
}

/**
 * Extract ISBN from candidate if available.
 */
function getIsbnFromCandidate(candidate: BookCandidate): string | null {
  // Check hypothesis ISBN candidates
  if (candidate.hypothesis?.isbnCandidates?.length) {
    return candidate.hypothesis.isbnCandidates[0];
  }

  // Check resolved book ISBN
  if (candidate.resolvedBook?.isbn13) {
    return candidate.resolvedBook.isbn13;
  }
  if (candidate.resolvedBook?.isbn10) {
    return candidate.resolvedBook.isbn10;
  }

  return null;
}

// ============================================================================
// Correction Lookup
// ============================================================================

/**
 * Find a matching correction for a candidate.
 * Returns null if no correction exists.
 */
export function findCorrection(candidate: BookCandidate): Correction | null {
  const store = useCorrectionsStore.getState();

  // Try ISBN key first
  const isbn = getIsbnFromCandidate(candidate);
  if (isbn) {
    const byIsbn = store.getCorrection(`isbn:${isbn}`);
    if (byIsbn) {
      return byIsbn;
    }
  }

  // Try content hash
  const hash = generateContentHash(candidate.evidence);
  const byHash = store.getCorrection(`hash:${hash}`);
  if (byHash) {
    return byHash;
  }

  return null;
}

// ============================================================================
// Correction Application
// ============================================================================

/**
 * Apply corrections to a single candidate.
 * Returns the (possibly modified) candidate and metadata about what was applied.
 */
export function applyCorrection(candidate: BookCandidate): CorrectionApplyResult {
  const key = getCorrectionKey(candidate);
  const correction = findCorrection(candidate);

  if (!correction) {
    logDiagnostic('Corrections', `No correction found for key=${key}, candidate=${candidate.id}`);
    return { candidate, applied: false };
  }

  // Increment apply count
  useCorrectionsStore.getState().incrementApplyCount(key);

  // Apply correction to candidate
  const correctedCandidate: BookCandidate = {
    ...candidate,
    appliedCorrection: correction,
  };

  // Update evidence.perFieldHints if it exists
  if (correctedCandidate.evidence.perFieldHints) {
    const existingTitleHints = correctedCandidate.evidence.perFieldHints.titleHints;
    const existingAuthorHints = correctedCandidate.evidence.perFieldHints.authorHints;

    correctedCandidate.evidence = {
      ...correctedCandidate.evidence,
      perFieldHints: {
        titleHints: correction.correctedTitle
          ? [correction.correctedTitle, ...existingTitleHints]
          : existingTitleHints,
        authorHints: correction.correctedAuthor
          ? [correction.correctedAuthor, ...existingAuthorHints]
          : existingAuthorHints,
      },
    };
  }

  // Diagnostic logging
  logDiagnostic('Corrections', `Applied correction`, {
    key,
    candidateId: candidate.id,
    matched: true,
    title: correction.correctedTitle,
    author: correction.correctedAuthor,
    applyCount: correction.applyCount + 1,
  });

  return { candidate: correctedCandidate, applied: true, correction };
}

/**
 * Apply corrections to multiple candidates.
 * Returns array of results.
 */
export function applyCorrections(candidates: BookCandidate[]): CorrectionApplyResult[] {
  return candidates.map(applyCorrection);
}

/**
 * Apply corrections and return just the candidates.
 * Convenience function for pipeline integration.
 */
export function applyCorrectionsToCandidates(candidates: BookCandidate[]): BookCandidate[] {
  return applyCorrections(candidates).map((result) => result.candidate);
}

// ============================================================================
// Correction Storage
// ============================================================================

/**
 * Save a correction for a candidate.
 * The candidate's current values become the "original" values.
 *
 * Saves to:
 * 1. Local Zustand/MMKV store (immediate, for offline use)
 * 2. Supabase user_corrections table (async, for cloud backup)
 */
export function saveCorrection(
  candidate: BookCandidate,
  correctedTitle: string | null,
  correctedAuthor: string | null,
  sessionId?: string
): void {
  const key = getCorrectionKey(candidate);

  // Get original values from evidence (first hint if available)
  const originalTitle = candidate.evidence.perFieldHints?.titleHints?.[0] ?? null;
  const originalAuthor = candidate.evidence.perFieldHints?.authorHints?.[0] ?? null;

  // Don't save if nothing actually changed
  if (
    (correctedTitle === null || correctedTitle === originalTitle) &&
    (correctedAuthor === null || correctedAuthor === originalAuthor)
  ) {
    console.log('[CorrectionsMemory] No actual changes to save');
    return;
  }

  const correction: Correction = {
    contentHash: generateContentHash(candidate.evidence),
    isbn: getIsbnFromCandidate(candidate),
    correctedTitle,
    correctedAuthor,
    originalTitle,
    originalAuthor,
    createdAt: new Date().toISOString(),
    applyCount: 0,
  };

  // 1. Save locally (immediate, for offline use)
  useCorrectionsStore.getState().setCorrection(key, correction);

  console.log(
    `[CorrectionsMemory] Saved correction for key ${key}: ` +
      `title="${correctedTitle}", author="${correctedAuthor}"`
  );

  // 2. Sync to Supabase (async, with full error logging)
  persistCorrection(correction, key, sessionId, candidate.id)
    .then((result) => {
      if (result.success) {
        console.log(`[CorrectionsMemory] Synced to Supabase: ${result.correctionId}`);
      } else {
        console.warn('[CorrectionsMemory] Supabase sync failed:', result.error, result.details);
      }
    })
    .catch((e) => {
      console.error('[CorrectionsMemory] Supabase sync exception:', e);
    });
}

/**
 * Delete/revert a correction for a candidate.
 */
export function deleteCorrection(candidate: BookCandidate): void {
  const key = getCorrectionKey(candidate);
  useCorrectionsStore.getState().deleteCorrection(key);
  console.log(`[CorrectionsMemory] Deleted correction for key ${key}`);
}

/**
 * Check if a candidate has an applied correction.
 */
export function hasAppliedCorrection(candidate: BookCandidate): boolean {
  return candidate.appliedCorrection !== undefined;
}

/**
 * Check if a candidate has a stored correction (may not be applied yet).
 */
export function hasStoredCorrection(candidate: BookCandidate): boolean {
  return findCorrection(candidate) !== null;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get statistics about corrections.
 */
export function getCorrectionStats(): {
  totalCorrections: number;
  totalApplyCount: number;
  mostApplied: Correction | null;
} {
  const corrections = useCorrectionsStore.getState().getAllCorrections();

  if (corrections.length === 0) {
    return { totalCorrections: 0, totalApplyCount: 0, mostApplied: null };
  }

  const totalApplyCount = corrections.reduce((sum, c) => sum + c.applyCount, 0);

  const mostApplied = corrections.reduce(
    (max, c) => (c.applyCount > (max?.applyCount ?? 0) ? c : max),
    null as Correction | null
  );

  return {
    totalCorrections: corrections.length,
    totalApplyCount,
    mostApplied,
  };
}

/**
 * Export all corrections as JSON (for backup/debug).
 */
export function exportCorrections(): string {
  const corrections = useCorrectionsStore.getState().corrections;
  return JSON.stringify(corrections, null, 2);
}

/**
 * Import corrections from JSON.
 * Merges with existing corrections (existing keys are overwritten).
 */
export function importCorrections(json: string): number {
  try {
    const imported = JSON.parse(json) as Record<CorrectionKey, Correction>;
    const store = useCorrectionsStore.getState();

    let count = 0;
    for (const [key, correction] of Object.entries(imported)) {
      store.setCorrection(key, correction);
      count++;
    }

    console.log(`[CorrectionsMemory] Imported ${count} corrections`);
    return count;
  } catch (error) {
    console.error('[CorrectionsMemory] Failed to import corrections:', error);
    return 0;
  }
}
