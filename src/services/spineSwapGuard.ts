/**
 * Spine Swap Guard (Gate 8)
 *
 * Detects when title and author might be swapped and corrects the assignment.
 *
 * Swap signals:
 * - "Title" looks like a person name (high nameScore)
 * - "Author" looks like a title (low nameScore, high titleScore)
 * - Position inconsistency (title below author on spine)
 * - Common swap patterns (e.g., short author-looking string labeled as title)
 *
 * Also handles edge cases:
 * - Same text assigned to both (de-duplicate)
 * - Very similar text (merge or pick best)
 */

import type { TitleAuthorPairing, TitleAssembly, AuthorAssembly, AssemblyResult } from './spineTitleAuthorAssembler';
import { scoreAsName, scoreAsTitle } from './spineLineLabeler';

// ============================================================================
// Types
// ============================================================================

export interface SwapAnalysis {
  /** Whether a swap was detected */
  swapDetected: boolean;
  /** Confidence in swap detection (0-1) */
  swapConfidence: number;
  /** Reason for swap detection */
  reason?: string;
  /** Title name score */
  titleNameScore: number;
  /** Title title score */
  titleTitleScore: number;
  /** Author name score */
  authorNameScore: number;
  /** Author title score */
  authorTitleScore: number;
}

export interface SwapGuardResult {
  /** Original pairing */
  original: TitleAuthorPairing;
  /** Corrected pairing (swapped if needed) */
  corrected: TitleAuthorPairing;
  /** Whether swap was applied */
  swapApplied: boolean;
  /** Analysis details */
  analysis: SwapAnalysis;
}

export interface SwapGuardBatchResult {
  /** Results for each pairing */
  results: SwapGuardResult[];
  /** Number of swaps applied */
  swapsApplied: number;
  /** Re-ranked pairings after swap correction */
  correctedPairings: TitleAuthorPairing[];
  /** Best corrected pairing */
  bestCorrected?: TitleAuthorPairing;
}

// ============================================================================
// Configuration
// ============================================================================

/** Threshold for detecting swap (score difference) */
const SWAP_THRESHOLD = 0.25;

/** Minimum name score for author */
const MIN_AUTHOR_NAME_SCORE = 0.35;

/** Maximum name score for title */
const MAX_TITLE_NAME_SCORE = 0.65;

// ============================================================================
// Swap Detection
// ============================================================================

/**
 * Analyze a pairing for potential swap
 */
export function analyzeSwap(pairing: TitleAuthorPairing): SwapAnalysis {
  const titleText = pairing.title.fullTitle;
  const authorText = pairing.author.fullAuthor;

  // Score both texts
  const titleNameScore = scoreAsName(titleText);
  const titleTitleScore = scoreAsTitle(titleText);
  const authorNameScore = scoreAsName(authorText);
  const authorTitleScore = scoreAsTitle(authorText);

  // Calculate swap indicators
  const titleLooksLikeName = titleNameScore > titleTitleScore;
  const authorLooksLikeTitle = authorTitleScore > authorNameScore;

  // Calculate score differences
  const titleSwapSignal = titleNameScore - titleTitleScore;
  const authorSwapSignal = authorTitleScore - authorNameScore;
  const combinedSwapSignal = titleSwapSignal + authorSwapSignal;

  // Determine if swap is needed
  let swapDetected = false;
  let swapConfidence = 0;
  let reason: string | undefined;

  // Strong swap signal: title looks like name AND author looks like title
  if (titleLooksLikeName && authorLooksLikeTitle && combinedSwapSignal > SWAP_THRESHOLD) {
    swapDetected = true;
    swapConfidence = Math.min(1, combinedSwapSignal);
    reason = 'title_looks_like_name_and_author_looks_like_title';
  }
  // Title has high name score (unusual for titles)
  else if (titleNameScore > MAX_TITLE_NAME_SCORE && authorTitleScore > authorNameScore) {
    swapDetected = true;
    swapConfidence = titleNameScore - MAX_TITLE_NAME_SCORE;
    reason = 'title_has_high_name_score';
  }
  // Author has low name score (unusual for authors)
  else if (authorNameScore < MIN_AUTHOR_NAME_SCORE && titleNameScore > authorNameScore + 0.2) {
    swapDetected = true;
    swapConfidence = MIN_AUTHOR_NAME_SCORE - authorNameScore;
    reason = 'author_has_low_name_score';
  }

  return {
    swapDetected,
    swapConfidence,
    reason,
    titleNameScore,
    titleTitleScore,
    authorNameScore,
    authorTitleScore,
  };
}

/**
 * Apply swap to a pairing
 */
function applySwap(pairing: TitleAuthorPairing): TitleAuthorPairing {
  // Create swapped title from author
  const newTitle: TitleAssembly = {
    mainTitle: pairing.author.primaryAuthor,
    subtitle: undefined, // Authors don't have subtitles
    fullTitle: pairing.author.fullAuthor,
    confidence: pairing.author.confidence,
    sourceLineIndices: pairing.author.sourceLineIndices,
    method: 'split_from_combined', // Mark as transformed
  };

  // Create swapped author from title
  const newAuthor: AuthorAssembly = {
    primaryAuthor: pairing.title.mainTitle,
    additionalAuthors: pairing.title.subtitle ? [pairing.title.subtitle] : [],
    fullAuthor: pairing.title.fullTitle,
    confidence: pairing.title.confidence,
    sourceLineIndices: pairing.title.sourceLineIndices,
    method: 'split_from_combined',
  };

  return {
    title: newTitle,
    author: newAuthor,
    confidence: pairing.confidence,
    pairingScore: pairing.pairingScore * 0.95, // Slight penalty for swap
  };
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Check a single pairing for swap and correct if needed
 */
export function guardSwap(pairing: TitleAuthorPairing): SwapGuardResult {
  const analysis = analyzeSwap(pairing);

  if (analysis.swapDetected && analysis.swapConfidence > 0.15) {
    const corrected = applySwap(pairing);
    return {
      original: pairing,
      corrected,
      swapApplied: true,
      analysis,
    };
  }

  return {
    original: pairing,
    corrected: pairing,
    swapApplied: false,
    analysis,
  };
}

/**
 * Process all pairings from assembly result
 */
export function guardSwapBatch(assemblyResult: AssemblyResult): SwapGuardBatchResult {
  const results: SwapGuardResult[] = [];
  let swapsApplied = 0;

  for (const pairing of assemblyResult.pairings) {
    const result = guardSwap(pairing);
    results.push(result);
    if (result.swapApplied) {
      swapsApplied++;
    }
  }

  // Extract corrected pairings and re-rank
  const correctedPairings = results.map(r => r.corrected);
  correctedPairings.sort((a, b) => b.pairingScore - a.pairingScore);

  const bestCorrected = correctedPairings.length > 0 ? correctedPairings[0] : undefined;

  return {
    results,
    swapsApplied,
    correctedPairings,
    bestCorrected,
  };
}

/**
 * Quick swap check for a title/author pair
 */
export function quickSwapCheck(title: string, author: string): {
  shouldSwap: boolean;
  confidence: number;
  correctedTitle: string;
  correctedAuthor: string;
} {
  const titleNameScore = scoreAsName(title);
  const titleTitleScore = scoreAsTitle(title);
  const authorNameScore = scoreAsName(author);
  const authorTitleScore = scoreAsTitle(author);

  const titleLooksLikeName = titleNameScore > titleTitleScore;
  const authorLooksLikeTitle = authorTitleScore > authorNameScore;

  const shouldSwap = titleLooksLikeName && authorLooksLikeTitle;
  const confidence = shouldSwap
    ? Math.min(1, (titleNameScore - titleTitleScore) + (authorTitleScore - authorNameScore))
    : 0;

  return {
    shouldSwap,
    confidence,
    correctedTitle: shouldSwap ? author : title,
    correctedAuthor: shouldSwap ? title : author,
  };
}

/**
 * Validate that title and author are not the same or too similar
 */
export function validatePairing(
  title: string,
  author: string
): { valid: boolean; reason?: string } {
  const normalizedTitle = title.toLowerCase().trim();
  const normalizedAuthor = author.toLowerCase().trim();

  // Exact match
  if (normalizedTitle === normalizedAuthor) {
    return { valid: false, reason: 'title_and_author_identical' };
  }

  // One contains the other
  if (normalizedTitle.includes(normalizedAuthor) && normalizedAuthor.length > 3) {
    return { valid: false, reason: 'author_contained_in_title' };
  }
  if (normalizedAuthor.includes(normalizedTitle) && normalizedTitle.length > 3) {
    return { valid: false, reason: 'title_contained_in_author' };
  }

  return { valid: true };
}
