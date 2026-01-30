/**
 * Candidate Scoring Service
 *
 * Scores Open Library candidates against OCR evidence using token overlap.
 * This is the core scoring logic for evidence-driven book resolution.
 */

import type { ResolvedBook } from '../types';
import {
  buildEvidenceTokens,
  normalizeForScoring,
  isGenericTitle,
  type EvidenceTokens,
} from './evidenceNormalization';
import {
  ACCEPT_HIGH_THRESHOLD as CONFIG_ACCEPT_HIGH,
  ACCEPT_MEDIUM_THRESHOLD as CONFIG_ACCEPT_MEDIUM,
  ACCEPT_MEDIUM_GAP as CONFIG_ACCEPT_MEDIUM_GAP,
  ACCEPT_MEDIUM_MIN_OVERLAP as CONFIG_MIN_OVERLAP,
  SUGGESTED_THRESHOLD as CONFIG_SUGGESTED,
  MIN_OVERLAP_COUNT as CONFIG_MIN_OVERLAP_COUNT,
  MIN_SIGNAL_SCORE_CAP as CONFIG_MIN_SIGNAL_CAP,
  ISBN_BONUS as CONFIG_ISBN_BONUS,
  GENERIC_TITLE_PENALTY as CONFIG_GENERIC_PENALTY,
  OVERLAP_WEIGHT as CONFIG_OVERLAP_WEIGHT,
  COVERAGE_WEIGHT as CONFIG_COVERAGE_WEIGHT,
  ORDER_WEIGHT as CONFIG_ORDER_WEIGHT,
  MAX_REVIEW_CANDIDATES as CONFIG_MAX_REVIEW,
} from '../config/metadataResolutionConfig';

// ============================================================================
// Types
// ============================================================================

/**
 * Score breakdown for a candidate
 *
 * New scoring formula:
 * - overlapRatio = |intersect(candidateTokens, evidenceTokens)| / |candidateTokens|
 * - coverageRatio = |intersect| / |evidenceTokens|
 * - orderScore = 1.0 if first token of title is in evidence, else 0.9
 * - combinedScore = 0.5 * overlapRatio + 0.3 * coverageRatio + 0.2 * orderScore
 * - If overlapCount < 2 => score capped at 0.10 (minimum signal required)
 * - Generic-title penalty: if title is single common word, deduct 0.15
 * - ISBN match bonus: +0.15
 */
export interface CandidateScore {
  /** Overall composite score [0-1] */
  score: number;
  /** Token overlap ratio: |intersect| / |candidateTokens| */
  overlapRatio: number;
  /** Coverage ratio: |intersect| / |evidenceTokens| */
  coverageRatio: number;
  /** Order score (1.0 if first title token in evidence, else 0.9) */
  orderScore: number;
  /** Number of overlapping tokens */
  overlapCount: number;
  /** ISBN match bonus */
  isbnBonus: number;
  /** Penalties applied */
  penalties: ScorePenalty[];
  /** Matched tokens (title + author combined) */
  matchedTokens: string[];
  /** Was ISBN matched */
  isbnMatched: boolean;

  // Legacy fields for backwards compatibility
  titleOverlap: number;
  authorOverlap: number;
  matchedTitleTokens: string[];
  matchedAuthorTokens: string[];
}

export interface ScorePenalty {
  /** Penalty type */
  type: 'generic_title' | 'missing_author' | 'missing_isbn' | 'short_title';
  /** Penalty amount (positive value subtracted from score) */
  amount: number;
  /** Explanation */
  reason: string;
}

/**
 * Scored candidate with full breakdown
 */
export interface ScoredCandidate {
  /** The book candidate */
  book: ResolvedBook;
  /** Score breakdown */
  scoring: CandidateScore;
}

// ============================================================================
// Configuration (from centralized config)
// ============================================================================

/** Weight for overlap ratio in combined score */
const OVERLAP_WEIGHT = CONFIG_OVERLAP_WEIGHT;

/** Weight for coverage ratio in combined score */
const COVERAGE_WEIGHT = CONFIG_COVERAGE_WEIGHT;

/** Weight for order score in combined score */
const ORDER_WEIGHT = CONFIG_ORDER_WEIGHT;

/** Bonus for ISBN match */
const ISBN_BONUS = CONFIG_ISBN_BONUS;

/** Penalty for generic single-word titles */
const GENERIC_TITLE_PENALTY = CONFIG_GENERIC_PENALTY;

/** Minimum overlapping tokens required for meaningful score */
const MIN_OVERLAP_COUNT = CONFIG_MIN_OVERLAP_COUNT;

/** Maximum score when overlap is below minimum */
const MIN_SIGNAL_SCORE_CAP = CONFIG_MIN_SIGNAL_CAP;

// ============================================================================
// Scoring Functions
// ============================================================================

/**
 * Calculate overlap between candidate tokens and evidence tokens
 *
 * @returns Object with:
 * - overlapRatio: |intersect| / |candidateTokens|
 * - coverageRatio: |intersect| / |evidenceTokens|
 * - overlapCount: number of matching tokens
 * - matched: array of matched tokens
 */
function calculateTokenOverlap(
  candidateTokens: string[],
  evidenceTokenSet: Set<string>
): {
  overlapRatio: number;
  coverageRatio: number;
  overlapCount: number;
  matched: string[];
} {
  if (candidateTokens.length === 0) {
    return { overlapRatio: 0, coverageRatio: 0, overlapCount: 0, matched: [] };
  }

  if (evidenceTokenSet.size === 0) {
    return { overlapRatio: 0, coverageRatio: 0, overlapCount: 0, matched: [] };
  }

  const matched: string[] = [];

  // Exact matches
  for (const token of candidateTokens) {
    if (evidenceTokenSet.has(token) && !matched.includes(token)) {
      matched.push(token);
    }
  }

  // Partial matches (substring matching for compound words, min 4 chars)
  for (const evidenceToken of evidenceTokenSet) {
    for (const candidateToken of candidateTokens) {
      if (matched.includes(candidateToken)) {
        continue;
      }
      if (
        evidenceToken.length >= 4 &&
        candidateToken.length >= 4 &&
        (evidenceToken.includes(candidateToken) || candidateToken.includes(evidenceToken))
      ) {
        matched.push(candidateToken);
      }
    }
  }

  const overlapCount = matched.length;
  const overlapRatio = overlapCount / candidateTokens.length;
  const coverageRatio = overlapCount / evidenceTokenSet.size;

  return {
    overlapRatio: Math.min(1, overlapRatio),
    coverageRatio: Math.min(1, coverageRatio),
    overlapCount,
    matched,
  };
}

/**
 * Calculate order score - rewards when first token of title appears in evidence
 */
function calculateOrderScore(titleTokens: string[], evidenceTokenSet: Set<string>): number {
  if (titleTokens.length === 0) {
    return 0.9; // No title tokens, neutral score
  }

  const firstToken = titleTokens[0];
  if (evidenceTokenSet.has(firstToken)) {
    return 1.0; // First token present in evidence
  }

  return 0.9; // First token not found
}

/**
 * Score a single candidate against evidence
 *
 * New scoring formula:
 * combinedScore = 0.5 * overlapRatio + 0.3 * coverageRatio + 0.2 * orderScore
 * + ISBN bonus (0.15) - generic title penalty (0.15)
 *
 * If overlapCount < 2, score is capped at 0.10 (minimum signal required)
 */
export function scoreCandidate(
  candidate: ResolvedBook,
  evidenceTokens: EvidenceTokens
): CandidateScore {
  const penalties: ScorePenalty[] = [];

  // Get title tokens (using aggressive normalization)
  const titleTokens = candidate.title ? normalizeForScoring(candidate.title) : [];

  // Get author tokens (combine all authors)
  const authorTokens: string[] = [];
  if (candidate.authors && candidate.authors.length > 0) {
    for (const author of candidate.authors) {
      const tokens = normalizeForScoring(author);
      for (const token of tokens) {
        if (!authorTokens.includes(token)) {
          authorTokens.push(token);
        }
      }
    }
  }

  // Combine title + author tokens for overlap calculation
  const candidateTokens = [...titleTokens, ...authorTokens];

  // Calculate overlap metrics
  const overlapResult = calculateTokenOverlap(candidateTokens, evidenceTokens.tokensSet);

  // Calculate order score based on title's first token
  const orderScore = calculateOrderScore(titleTokens, evidenceTokens.tokensSet);

  // ISBN matching
  let isbnBonus = 0;
  let isbnMatched = false;

  if (evidenceTokens.isbns.length > 0) {
    const candidateIsbns = [candidate.isbn13, candidate.isbn10].filter(Boolean) as string[];
    for (const evidenceIsbn of evidenceTokens.isbns) {
      for (const candidateIsbn of candidateIsbns) {
        if (evidenceIsbn === candidateIsbn) {
          isbnBonus = ISBN_BONUS;
          isbnMatched = true;
          break;
        }
      }
      if (isbnMatched) break;
    }
  }

  // Generic title penalty
  if (candidate.title && isGenericTitle(candidate.title)) {
    penalties.push({
      type: 'generic_title',
      amount: GENERIC_TITLE_PENALTY,
      reason: `Title "${candidate.title}" is a generic single word`,
    });
  }

  // Calculate combined score using new formula
  let score =
    OVERLAP_WEIGHT * overlapResult.overlapRatio +
    COVERAGE_WEIGHT * overlapResult.coverageRatio +
    ORDER_WEIGHT * orderScore +
    isbnBonus;

  // Apply penalties
  for (const penalty of penalties) {
    score -= penalty.amount;
  }

  // Minimum signal check: if overlap < 2, cap score at 0.10
  if (overlapResult.overlapCount < MIN_OVERLAP_COUNT) {
    score = Math.min(score, MIN_SIGNAL_SCORE_CAP);
  }

  // Clamp to [0, 1]
  score = Math.max(0, Math.min(1, score));

  // Compute legacy title/author overlaps for backwards compat
  const titleOnlyResult = calculateTokenOverlap(titleTokens, evidenceTokens.tokensSet);
  const authorOnlyResult = calculateTokenOverlap(authorTokens, evidenceTokens.tokensSet);

  return {
    score,
    overlapRatio: overlapResult.overlapRatio,
    coverageRatio: overlapResult.coverageRatio,
    orderScore,
    overlapCount: overlapResult.overlapCount,
    isbnBonus,
    penalties,
    matchedTokens: overlapResult.matched,
    isbnMatched,
    // Legacy fields
    titleOverlap: titleOnlyResult.overlapRatio,
    authorOverlap: authorOnlyResult.overlapRatio,
    matchedTitleTokens: titleOnlyResult.matched,
    matchedAuthorTokens: authorOnlyResult.matched,
  };
}

/**
 * Score and rank multiple candidates
 */
export function scoreAndRankCandidates(
  candidates: ResolvedBook[],
  evidenceTokens: EvidenceTokens
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = candidates.map((book) => ({
    book,
    scoring: scoreCandidate(book, evidenceTokens),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.scoring.score - a.scoring.score);

  return scored;
}

/**
 * Build evidence tokens from raw lines (convenience wrapper)
 */
export function buildEvidenceFromLines(lines: string[]): EvidenceTokens {
  return buildEvidenceTokens(lines);
}

// ============================================================================
// Decision Thresholds
// ============================================================================

/**
 * Decision Gates:
 * - accept_high: ISBN matched AND topScore >= 0.70 (persisted to Supabase)
 * - accept_medium: topScore >= 0.82 AND gap >= 0.18 AND overlapCount >= 3 (persisted)
 * - suggested: topScore >= 0.55 (NOT persisted, shown to user, optional review)
 * - reject: else (no viable match)
 */

/** Minimum score for accept-high (with ISBN match) */
export const ACCEPT_HIGH_THRESHOLD = CONFIG_ACCEPT_HIGH;

/** Minimum score for accept-medium (no ISBN but high confidence) */
export const ACCEPT_MEDIUM_THRESHOLD = CONFIG_ACCEPT_MEDIUM;

/** Minimum gap between top and second candidate for accept-medium */
export const ACCEPT_MEDIUM_GAP = CONFIG_ACCEPT_MEDIUM_GAP;

/** Minimum overlap count for accept-medium */
export const ACCEPT_MEDIUM_MIN_OVERLAP = CONFIG_MIN_OVERLAP;

/** Minimum score for suggested (replaces manual_review) */
export const SUGGESTED_THRESHOLD = CONFIG_SUGGESTED;

/** @deprecated Use SUGGESTED_THRESHOLD */
export const MANUAL_REVIEW_THRESHOLD = SUGGESTED_THRESHOLD;

/** Maximum candidates to return for manual review */
export const MAX_REVIEW_CANDIDATES = CONFIG_MAX_REVIEW;

// Legacy export for backwards compatibility
export const AUTO_ACCEPT_THRESHOLD = ACCEPT_HIGH_THRESHOLD;

/**
 * Decision type from scoring
 * - accept_high: ISBN match + high score (persisted)
 * - accept_medium: high score + dominance (persisted)
 * - suggested: moderate score, shown but NOT persisted
 * - reject: no viable match
 */
export type ScoringDecision = 'accept_high' | 'accept_medium' | 'suggested' | 'reject';

/**
 * Decision result with full context
 */
export interface DecisionResult {
  decision: ScoringDecision;
  topCandidate: ScoredCandidate | null;
  reviewCandidates: ScoredCandidate[];
  /** Gap between top and second candidate */
  scoreGap: number;
  /** Explanation for the decision */
  reason: string;
}

/**
 * Make a decision based on scored candidates
 *
 * Decision Gates:
 * - accept_high: ISBN matched AND topScore >= 0.70 (persisted)
 * - accept_medium: topScore >= 0.82 AND gap >= 0.18 AND overlapCount >= 3 (persisted)
 *   (demoted to suggested if generic title and no author signal)
 * - suggested: topScore >= 0.55 (NOT persisted, shown to user)
 * - reject: else
 *
 * @param scoredCandidates - Candidates sorted by score descending
 * @param isAfterBoostPass - If true, we've already tried boost pass
 */
export function makeDecisionFromScores(
  scoredCandidates: ScoredCandidate[],
  isAfterBoostPass: boolean = false
): DecisionResult {
  if (scoredCandidates.length === 0) {
    return {
      decision: 'reject',
      topCandidate: null,
      reviewCandidates: [],
      scoreGap: 0,
      reason: 'No candidates found',
    };
  }

  const top = scoredCandidates[0];
  const second = scoredCandidates.length > 1 ? scoredCandidates[1] : null;
  const scoreGap = second ? top.scoring.score - second.scoring.score : 1.0;

  // Get alternatives for suggested decisions (top 3)
  const alternatives = scoredCandidates
    .slice(1, 4)
    .filter((c) => c.scoring.score >= SUGGESTED_THRESHOLD * 0.8);

  // accept_high: ISBN matched AND topScore >= 0.70
  if (top.scoring.isbnMatched && top.scoring.score >= ACCEPT_HIGH_THRESHOLD) {
    return {
      decision: 'accept_high',
      topCandidate: top,
      reviewCandidates: [],
      scoreGap,
      reason: `ISBN match with score ${formatScore(top.scoring.score)} >= ${formatScore(ACCEPT_HIGH_THRESHOLD)}`,
    };
  }

  // accept_medium: topScore >= 0.82 AND gap >= 0.18 AND overlapCount >= 3
  if (
    top.scoring.score >= ACCEPT_MEDIUM_THRESHOLD &&
    scoreGap >= ACCEPT_MEDIUM_GAP &&
    top.scoring.overlapCount >= ACCEPT_MEDIUM_MIN_OVERLAP
  ) {
    // Generic-title demotion: if title is generic and no strong author signal, demote to suggested
    const hasGenericTitlePenalty = top.scoring.penalties.some((p) => p.type === 'generic_title');
    const hasAuthorSignal = top.scoring.matchedAuthorTokens.length >= 1;

    if (hasGenericTitlePenalty && !hasAuthorSignal) {
      // Demote to suggested (not persisted)
      return {
        decision: 'suggested',
        topCandidate: top,
        reviewCandidates: alternatives,
        scoreGap,
        reason: `Generic title without author signal - demoted from accept_medium`,
      };
    }

    return {
      decision: 'accept_medium',
      topCandidate: top,
      reviewCandidates: [],
      scoreGap,
      reason: `High score ${formatScore(top.scoring.score)} with gap ${formatScore(scoreGap)} and ${top.scoring.overlapCount} overlaps`,
    };
  }

  // suggested: topScore >= 0.55 (always shown, never blocks)
  if (top.scoring.score >= SUGGESTED_THRESHOLD) {
    return {
      decision: 'suggested',
      topCandidate: top,
      reviewCandidates: alternatives,
      scoreGap,
      reason: `Score ${formatScore(top.scoring.score)} - suggested match (optional review)`,
    };
  }

  // reject: score too low
  return {
    decision: 'reject',
    topCandidate: top,
    reviewCandidates: [],
    scoreGap,
    reason: `Score ${formatScore(top.scoring.score)} below suggested threshold ${formatScore(SUGGESTED_THRESHOLD)}`,
  };
}

/**
 * Format score for display
 */
export function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/**
 * Explain a score for debugging
 */
export function explainScore(scoring: CandidateScore): string {
  const parts: string[] = [
    `Score: ${formatScore(scoring.score)}`,
    `Overlap: ${scoring.overlapCount} tokens (ratio: ${formatScore(scoring.overlapRatio)})`,
    `Coverage: ${formatScore(scoring.coverageRatio)}`,
    `Order: ${formatScore(scoring.orderScore)}`,
    `Matched: ${scoring.matchedTokens.join(', ') || 'none'}`,
  ];

  if (scoring.isbnMatched) {
    parts.push(`ISBN bonus: +${formatScore(scoring.isbnBonus)}`);
  }

  for (const penalty of scoring.penalties) {
    parts.push(`Penalty (${penalty.type}): -${formatScore(penalty.amount)} - ${penalty.reason}`);
  }

  if (scoring.overlapCount < MIN_OVERLAP_COUNT) {
    parts.push(`⚠️ Low signal: overlap < ${MIN_OVERLAP_COUNT}, score capped at ${formatScore(MIN_SIGNAL_SCORE_CAP)}`);
  }

  return parts.join('\n');
}

/**
 * Check if a decision should auto-persist (accept_high or accept_medium)
 */
export function shouldAutoPersist(decision: ScoringDecision): boolean {
  return decision === 'accept_high' || decision === 'accept_medium';
}
