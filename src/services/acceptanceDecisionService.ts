/**
 * Acceptance Decision Service (Gate 8 - DECIDE)
 *
 * Determines acceptance policy based on scored matches, verification results,
 * and evidence tier. Produces decisions: auto-accept, suggest, ambiguous, no-match.
 */

import type {
  EvidenceTier,
  SearchCandidate,
  ScoredMatch,
  ResolvedBook,
  VerificationResult,
  AcceptanceDecision,
} from '../types';
import { isDominated } from './metadataResolverService';
import { verifyMatch } from './matchVerificationService';
import { isMetadataVerboseDebug } from '../config/debug';

// ============================================================================
// Thresholds by Evidence Tier
// ============================================================================

/**
 * Acceptance thresholds for each evidence tier
 * Higher evidence quality allows lower thresholds
 */
export interface TierThresholds {
  autoAccept: number;
  suggest: number;
  ambiguous: number;
}

export const TIER_THRESHOLDS: Record<EvidenceTier, TierThresholds> = {
  strong: {
    autoAccept: 0.85,
    suggest: 0.70,
    ambiguous: 0.50,
  },
  usable: {
    autoAccept: 0.88,
    suggest: 0.75,
    ambiguous: 0.55,
  },
  weak: {
    autoAccept: 0.95,
    suggest: 0.85,
    ambiguous: 0.70,
  },
  unusable: {
    autoAccept: 1.0, // Never auto-accept
    suggest: 1.0,    // Never suggest
    ambiguous: 1.0,  // Always no-match
  },
};

/**
 * Get thresholds for a given evidence tier
 */
export function getThresholds(tier: EvidenceTier): TierThresholds {
  return TIER_THRESHOLDS[tier];
}

// ============================================================================
// Decision Making
// ============================================================================

export interface MakeDecisionInput {
  /** Sorted scored matches (best first) */
  scoredMatches: ScoredMatch[];
  /** Primary search candidate */
  candidate: SearchCandidate;
  /** Full OCR text block for verification */
  fullTextBlock: string;
  /** Evidence tier for threshold selection */
  evidenceTier: EvidenceTier;
}

/**
 * Make acceptance decision based on matches and verification
 *
 * Logic:
 * 1. No matches → no-match
 * 2. Verify top match
 * 3. If verification fails:
 *    - ISBN mismatch → ambiguous with top 4, reason='isbn-conflict'
 *    - Other failures → suggest with warnings
 * 4. If verification passes:
 *    - score >= autoAccept AND dominated → auto-accept
 *    - score >= suggest → suggest
 *    - score >= ambiguous → ambiguous
 *    - else → no-match
 *
 * @param input - Decision input
 * @returns Acceptance decision
 */
export function makeDecision(input: MakeDecisionInput): AcceptanceDecision {
  const { scoredMatches, candidate, fullTextBlock, evidenceTier } = input;
  const thresholds = getThresholds(evidenceTier);

  if (isMetadataVerboseDebug()) {
    console.log(
      `[Decision] Making decision with ${scoredMatches.length} matches, ` +
        `tier=${evidenceTier}, thresholds: auto=${thresholds.autoAccept}, ` +
        `suggest=${thresholds.suggest}, ambiguous=${thresholds.ambiguous}`
    );
  }

  // Case 1: No matches
  if (scoredMatches.length === 0) {
    if (isMetadataVerboseDebug()) {
      console.log('[Decision] No matches → no-match (ocr-only)');
    }
    return {
      action: 'no-match',
      fallback: 'ocr-only',
    };
  }

  const topMatch = scoredMatches[0];
  const topScore = topMatch.composite;

  // Verify top match
  const verification = verifyMatch({
    candidate,
    book: topMatch.book,
    fullTextBlock,
    baseConfidence: topScore,
  });

  if (isMetadataVerboseDebug()) {
    console.log(
      `[Decision] Top match: "${topMatch.book.title}" score=${topScore.toFixed(3)}, ` +
        `verified=${verification.passed}, flags=[${verification.flags.join(', ')}]`
    );
  }

  // Case 2: Verification failed
  if (!verification.passed) {
    // ISBN mismatch is severe - show multiple candidates
    if (verification.flags.includes('isbn-mismatch')) {
      const topCandidates = scoredMatches
        .slice(0, 4)
        .map((m) => m.book);

      if (isMetadataVerboseDebug()) {
        console.log('[Decision] ISBN mismatch → ambiguous (isbn-conflict)');
      }

      return {
        action: 'ambiguous',
        candidates: topCandidates,
        reason: 'isbn-conflict',
        warnings: verification.flags,
      };
    }

    // Other verification failures - suggest with warnings
    const alternatives = scoredMatches
      .slice(1, 3)
      .map((m) => m.book);

    if (isMetadataVerboseDebug()) {
      console.log(
        `[Decision] Verification failed → suggest with ${alternatives.length} alternatives`
      );
    }

    return {
      action: 'suggest',
      book: topMatch.book,
      alternatives,
      warnings: verification.flags,
      confidence: verification.adjustedConfidence,
    };
  }

  // Case 3: Verification passed - apply score thresholds
  const secondScore = scoredMatches.length > 1 ? scoredMatches[1].composite : 0;

  // Check for auto-accept
  if (
    topScore >= thresholds.autoAccept &&
    isDominated(topScore, secondScore)
  ) {
    if (isMetadataVerboseDebug()) {
      console.log(
        `[Decision] Auto-accept: score=${topScore.toFixed(3)} >= ${thresholds.autoAccept}, dominated`
      );
    }
    return {
      action: 'auto-accept',
      book: topMatch.book,
      confidence: topScore,
    };
  }

  // Check for suggest
  if (topScore >= thresholds.suggest) {
    const alternatives = scoredMatches
      .slice(1, 3)
      .map((m) => m.book);

    if (isMetadataVerboseDebug()) {
      console.log(
        `[Decision] Suggest: score=${topScore.toFixed(3)} >= ${thresholds.suggest}`
      );
    }

    return {
      action: 'suggest',
      book: topMatch.book,
      alternatives,
      confidence: topScore,
    };
  }

  // Check for ambiguous
  if (topScore >= thresholds.ambiguous) {
    const topCandidates = scoredMatches
      .slice(0, 4)
      .map((m) => m.book);

    if (isMetadataVerboseDebug()) {
      console.log(
        `[Decision] Ambiguous: score=${topScore.toFixed(3)} >= ${thresholds.ambiguous}`
      );
    }

    return {
      action: 'ambiguous',
      candidates: topCandidates,
    };
  }

  // Default: no-match
  if (isMetadataVerboseDebug()) {
    console.log(
      `[Decision] No-match: score=${topScore.toFixed(3)} < ${thresholds.ambiguous}`
    );
  }

  return {
    action: 'no-match',
    fallback: 'manual-entry',
  };
}

// ============================================================================
// OCR-Only Decision
// ============================================================================

/**
 * Create OCR-only decision (used when offline or lookup unavailable)
 *
 * @param candidate - Search candidate with OCR hints
 * @returns No-match decision with OCR fallback
 */
export function makeOcrOnlyDecision(
  candidate: SearchCandidate | null
): AcceptanceDecision {
  if (!candidate) {
    return {
      action: 'no-match',
      fallback: 'manual-entry',
    };
  }

  // If we have good OCR hints, suggest OCR-only as fallback
  if (candidate.titleHint || candidate.authorHint) {
    return {
      action: 'no-match',
      fallback: 'ocr-only',
    };
  }

  return {
    action: 'no-match',
    fallback: 'manual-entry',
  };
}

// ============================================================================
// Decision Helpers
// ============================================================================

/**
 * Check if a decision has a resolved book
 */
export function hasResolvedBook(
  decision: AcceptanceDecision
): decision is AcceptanceDecision & { book: ResolvedBook } {
  return decision.action === 'auto-accept' || decision.action === 'suggest';
}

/**
 * Get the primary book from a decision (if any)
 */
export function getPrimaryBook(
  decision: AcceptanceDecision
): ResolvedBook | null {
  if (decision.action === 'auto-accept') {
    return decision.book;
  }
  if (decision.action === 'suggest') {
    return decision.book;
  }
  if (decision.action === 'ambiguous' && decision.candidates.length > 0) {
    return decision.candidates[0];
  }
  return null;
}

/**
 * Get all candidate books from a decision
 */
export function getAllCandidates(decision: AcceptanceDecision): ResolvedBook[] {
  if (decision.action === 'auto-accept') {
    return [decision.book];
  }
  if (decision.action === 'suggest') {
    return [decision.book, ...decision.alternatives];
  }
  if (decision.action === 'ambiguous') {
    return decision.candidates;
  }
  return [];
}

/**
 * Get decision display text
 */
export function getDecisionDisplayText(decision: AcceptanceDecision): string {
  switch (decision.action) {
    case 'auto-accept':
      return `Matched: ${decision.book.title}`;
    case 'suggest':
      return `Suggested: ${decision.book.title}`;
    case 'ambiguous':
      return `Multiple matches found (${decision.candidates.length})`;
    case 'no-match':
      return decision.fallback === 'ocr-only'
        ? 'No match found - using OCR text'
        : 'No match found - manual entry required';
    default:
      return 'Unknown decision';
  }
}

/**
 * Check if decision needs user confirmation
 */
export function needsUserConfirmation(decision: AcceptanceDecision): boolean {
  return (
    decision.action === 'suggest' ||
    decision.action === 'ambiguous' ||
    decision.action === 'no-match'
  );
}
