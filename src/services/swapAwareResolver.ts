/**
 * Swap-Aware Resolver Service
 *
 * Implements two-hypothesis resolution to detect and correct title/author swaps.
 * The resolver is the authority when evidence is strong - extraction is best-effort.
 *
 * Design principles:
 * - Build H1 (title=extractedTitle, author=extractedAuthor) and H2 (swapped)
 * - Score both hypotheses against API results
 * - Pick winner with clear margin; mark swap if H2 wins
 * - Decision tiers: ACCEPT / SUGGEST / REJECT
 */

import type { ResolvedBook, EvidenceSourceKind } from '../types';
import { OpenLibraryProvider } from './openLibraryProvider';
import {
  scoreAndRankCandidates,
  makeDecisionFromScores,
  type ScoredCandidate,
  type ScoringDecision,
  ACCEPT_HIGH_THRESHOLD,
  SUGGESTED_THRESHOLD,
} from './candidateScoring';
import { buildEvidenceTokens, type EvidenceTokens } from './evidenceNormalization';
import { prepareResolverQuery, type ResolverQueryInputs } from './resolverQueryPrep';
import {
  extractIsbnFromOcrLines,
  validateAndNormalizeIsbn,
  type IsbnExtractionResult,
} from './isbnExtraction';
import {
  computeAuthorSimilarity,
  normalizeForApiComparison,
} from './ocrConfusionMatching';
import {
  detectBadgeTypoContext,
  getEnhancedBadgeExclusions,
} from './badgeTypoDetection';
import {
  executeTitleMatchFallback,
  type TitleMatchFallbackResult,
  type TitleMatchFallbackDebug,
} from './titleMatchFallback';

// ============================================================================
// Types
// ============================================================================

/**
 * Hypothesis for resolution (H1 = original, H2 = swapped)
 */
export interface ResolutionHypothesis {
  /** Hypothesis ID (H1 or H2) */
  id: 'H1' | 'H2';
  /** Title used for this hypothesis */
  title: string | null;
  /** Author used for this hypothesis */
  author: string | null;
  /** Sanitized query inputs */
  queryInputs: ResolverQueryInputs;
  /** API search results */
  apiResults: ResolvedBook[];
  /** Scored candidates */
  scoredCandidates: ScoredCandidate[];
  /** Best candidate (top scorer) */
  bestCandidate: ScoredCandidate | null;
  /** Best combined score */
  bestScore: number;
  /** Title score for best candidate */
  titleScore: number;
  /** Author score for best candidate */
  authorScore: number;
  /** Search query used */
  searchQuery: string;
}

/**
 * Decision tier for resolver
 */
export type ResolverDecisionTier = 'ACCEPT' | 'SUGGEST' | 'REJECT';

/**
 * Full result from swap-aware resolution
 */
export interface SwapAwareResolutionResult {
  /** Final decision tier */
  decisionTier: ResolverDecisionTier;
  /** Winning hypothesis (H1 or H2) */
  winningHypothesis: ResolutionHypothesis | null;
  /** Was a swap applied (H2 won) */
  swapApplied: boolean;
  /** Corrected title (from API if accepted) */
  correctedTitle: string | null;
  /** Corrected author (from API if accepted) */
  correctedAuthor: string | null;
  /** Confidence score [0-1] */
  confidence: number;
  /** Decision reason */
  reason: string;
  /** Debug info */
  debug: SwapResolutionDebug;
}

/**
 * Debug info for swap resolution
 */
export interface SwapResolutionDebug {
  /** Original extracted title */
  extractedTitle: string | null;
  /** Original extracted author */
  extractedAuthor: string | null;
  /** H1 hypothesis details */
  h1: ResolutionHypothesis | null;
  /** H2 hypothesis details */
  h2: ResolutionHypothesis | null;
  /** H1 sanitized query */
  h1QueryInputs: ResolverQueryInputs | null;
  /** H2 sanitized query */
  h2QueryInputs: ResolverQueryInputs | null;
  /** Score margin between H1 and H2 */
  scoreMargin: number;
  /** ISBN extraction result */
  isbnExtraction: IsbnExtractionResult | null;
  /** Whether ISBN path was used */
  isbnUsed: boolean;
  /** ISBN value if used */
  isbnValue: string | null;
  /** Badge typo exclusions */
  badgeTypoExclusions: number[];
  /** API result counts */
  h1ApiResultCount: number;
  /** API result counts */
  h2ApiResultCount: number;
  /** Top candidates from each hypothesis */
  h1TopCandidates: Array<{ title: string; score: number }>;
  h2TopCandidates: Array<{ title: string; score: number }>;
  /** Total resolution time in ms */
  resolutionTimeMs: number;
  /** Title-match fallback debug info (if triggered) */
  titleMatchFallback?: TitleMatchFallbackDebug;
  /** Whether title-match fallback was triggered */
  titleMatchFallbackTriggered?: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

/** Minimum margin for H2 to win over H1 */
const SWAP_MARGIN_THRESHOLD = 0.10;

/** Accept threshold */
const ACCEPT_THRESHOLD = 0.88;

/** Suggest threshold */
const SUGGEST_THRESHOLD = 0.60;

// ============================================================================
// Core Resolution Logic
// ============================================================================

/**
 * Build and resolve a single hypothesis
 */
async function resolveHypothesis(
  id: 'H1' | 'H2',
  title: string | null,
  author: string | null,
  evidenceLines: string[],
  excludedIndices: Set<number>,
  provider: OpenLibraryProvider,
  sourceKind: EvidenceSourceKind
): Promise<ResolutionHypothesis> {
  // Prepare sanitized query inputs
  const queryInputs = prepareResolverQuery(title, author);

  // Build search query
  const searchQuery = [queryInputs.queryTitle, queryInputs.queryAuthor]
    .filter(Boolean)
    .join(' ')
    .trim();

  const hypothesis: ResolutionHypothesis = {
    id,
    title,
    author,
    queryInputs,
    apiResults: [],
    scoredCandidates: [],
    bestCandidate: null,
    bestScore: 0,
    titleScore: 0,
    authorScore: 0,
    searchQuery,
  };

  if (!searchQuery || !queryInputs.shouldQuery) {
    return hypothesis;
  }

  try {
    // Search API
    const results = await provider.searchByText(searchQuery);
    hypothesis.apiResults = results;

    if (results.length === 0) {
      return hypothesis;
    }

    // Build evidence tokens (excluding badge lines)
    const filteredLines = evidenceLines.filter((_, i) => !excludedIndices.has(i));
    const evidenceTokens = buildEvidenceTokens(filteredLines, { sourceKind });

    // Score candidates
    const scored = scoreAndRankCandidates(results, evidenceTokens, { sourceKind });
    hypothesis.scoredCandidates = scored;

    if (scored.length > 0) {
      hypothesis.bestCandidate = scored[0];
      hypothesis.bestScore = scored[0].scoring.score;
      hypothesis.titleScore = scored[0].scoring.titleScore;
      hypothesis.authorScore = scored[0].scoring.authorScore ?? 0;
    }

    return hypothesis;
  } catch (e: any) {
    console.warn(`[SwapAwareResolver] Hypothesis ${id} search failed:`, e.message);
    return hypothesis;
  }
}

/**
 * Main swap-aware resolution function
 *
 * This is the entry point for resolver-driven correction.
 * It builds H1 (original) and H2 (swapped) hypotheses,
 * resolves both against API, and picks the winner.
 *
 * @param evidenceLines - Raw OCR lines from merged evidence
 * @param extractedTitle - Title from extraction (may be wrong)
 * @param extractedAuthor - Author from extraction (may be wrong)
 * @param sourceKind - Evidence source kind for ISBN policy
 */
export async function resolveWithSwapDetection(
  evidenceLines: string[],
  extractedTitle: string | null,
  extractedAuthor: string | null,
  sourceKind: EvidenceSourceKind = 'spine_crop'
): Promise<SwapAwareResolutionResult> {
  const startTime = Date.now();
  const provider = new OpenLibraryProvider();

  console.log(`[SwapAwareResolver] Starting resolution: title="${extractedTitle}" author="${extractedAuthor}"`);

  const debug: SwapResolutionDebug = {
    extractedTitle,
    extractedAuthor,
    h1: null,
    h2: null,
    h1QueryInputs: null,
    h2QueryInputs: null,
    scoreMargin: 0,
    isbnExtraction: null,
    isbnUsed: false,
    isbnValue: null,
    badgeTypoExclusions: [],
    h1ApiResultCount: 0,
    h2ApiResultCount: 0,
    h1TopCandidates: [],
    h2TopCandidates: [],
    resolutionTimeMs: 0,
  };

  // Step 1: Detect badge typo exclusions (Part D)
  const badgeResult = getEnhancedBadgeExclusions(evidenceLines);
  const excludedIndices = badgeResult.excludedIndices;
  debug.badgeTypoExclusions = Array.from(excludedIndices);

  if (excludedIndices.size > 0) {
    console.log(`[SwapAwareResolver] Badge typo exclusions: ${debug.badgeTypoExclusions.join(', ')}`);
  }

  // Step 2: Try ISBN-first resolution (Part B)
  const isbnResult = extractIsbnFromOcrLines(evidenceLines);
  debug.isbnExtraction = isbnResult;

  if (isbnResult.validIsbn) {
    console.log(`[SwapAwareResolver] Valid ISBN found: ${isbnResult.validIsbn}`);

    try {
      const isbnResults = await provider.searchByIsbn(isbnResult.validIsbn);

      if (isbnResults.length === 1) {
        // Single strong ISBN match - ACCEPT and use API fields
        const book = isbnResults[0];
        debug.isbnUsed = true;
        debug.isbnValue = isbnResult.validIsbn;
        debug.resolutionTimeMs = Date.now() - startTime;

        console.log(`[SwapAwareResolver] ISBN match: "${book.title}" by ${book.authors?.join(', ')}`);

        return {
          decisionTier: 'ACCEPT',
          winningHypothesis: null,
          swapApplied: false,
          correctedTitle: book.title,
          correctedAuthor: book.authors?.[0] ?? null,
          confidence: 0.98,
          reason: 'isbn_exact_match',
          debug,
        };
      }
    } catch (e: any) {
      console.warn(`[SwapAwareResolver] ISBN lookup failed:`, e.message);
    }
  }

  // Step 3: Build H1 (original: title=extractedTitle, author=extractedAuthor)
  const h1 = await resolveHypothesis(
    'H1',
    extractedTitle,
    extractedAuthor,
    evidenceLines,
    excludedIndices,
    provider,
    sourceKind
  );
  debug.h1 = h1;
  debug.h1QueryInputs = h1.queryInputs;
  debug.h1ApiResultCount = h1.apiResults.length;
  debug.h1TopCandidates = h1.scoredCandidates.slice(0, 3).map(sc => ({
    title: sc.book.title,
    score: sc.scoring.score,
  }));

  // Step 4: Build H2 (swapped: title=extractedAuthor, author=extractedTitle)
  const h2 = await resolveHypothesis(
    'H2',
    extractedAuthor,  // Swapped: author becomes title
    extractedTitle,   // Swapped: title becomes author
    evidenceLines,
    excludedIndices,
    provider,
    sourceKind
  );
  debug.h2 = h2;
  debug.h2QueryInputs = h2.queryInputs;
  debug.h2ApiResultCount = h2.apiResults.length;
  debug.h2TopCandidates = h2.scoredCandidates.slice(0, 3).map(sc => ({
    title: sc.book.title,
    score: sc.scoring.score,
  }));

  // Step 5: Compare hypotheses and pick winner
  const h1Score = h1.bestScore;
  const h2Score = h2.bestScore;
  const scoreMargin = h2Score - h1Score;
  debug.scoreMargin = scoreMargin;

  console.log(`[SwapAwareResolver] H1 score=${h1Score.toFixed(3)}, H2 score=${h2Score.toFixed(3)}, margin=${scoreMargin.toFixed(3)}`);

  // Determine winning hypothesis
  let winner: ResolutionHypothesis | null = null;
  let swapApplied = false;

  if (h2Score > h1Score + SWAP_MARGIN_THRESHOLD) {
    // H2 wins with sufficient margin - swap detected
    winner = h2;
    swapApplied = true;
    console.log(`[SwapAwareResolver] Swap detected! H2 wins with margin=${scoreMargin.toFixed(3)}`);
  } else if (h1Score > 0) {
    // H1 wins or tie
    winner = h1;
    swapApplied = false;
  } else if (h2Score > 0) {
    // Only H2 has results
    winner = h2;
    swapApplied = true;
  }

  debug.resolutionTimeMs = Date.now() - startTime;

  // Step 6: Determine decision tier
  if (!winner || !winner.bestCandidate) {
    // No candidates found - try title-match fallback
    console.log(`[SwapAwareResolver] No candidates - attempting title-match fallback`);

    const fallbackResult = await executeTitleMatchFallback(
      extractedTitle,
      extractedAuthor,
      provider
    );

    debug.titleMatchFallbackTriggered = fallbackResult.triggered;
    if (fallbackResult.triggered) {
      debug.titleMatchFallback = fallbackResult.debug;
    }

    if (fallbackResult.triggered && fallbackResult.decision === 'suggest') {
      debug.resolutionTimeMs = Date.now() - startTime;

      console.log(`[SwapAwareResolver] Title-match fallback triggered: ` +
        `title="${fallbackResult.suggestedTitle}", author="${fallbackResult.suggestedAuthor}"`);

      return {
        decisionTier: 'SUGGEST',
        winningHypothesis: null,
        swapApplied: false,
        correctedTitle: fallbackResult.suggestedTitle,
        correctedAuthor: fallbackResult.suggestedAuthor,
        confidence: fallbackResult.confidence,
        reason: fallbackResult.reason,
        debug,
      };
    }

    return {
      decisionTier: 'REJECT',
      winningHypothesis: winner,
      swapApplied: false,
      correctedTitle: null,
      correctedAuthor: null,
      confidence: 0,
      reason: 'no_candidates_found',
      debug,
    };
  }

  const bestScore = winner.bestScore;
  const bestCandidate = winner.bestCandidate;
  let decisionTier: ResolverDecisionTier;
  let reason: string;

  if (bestScore >= ACCEPT_THRESHOLD) {
    decisionTier = 'ACCEPT';
    reason = swapApplied ? 'swap_corrected_high_confidence' : 'high_confidence_match';
  } else if (bestScore >= SUGGEST_THRESHOLD) {
    decisionTier = 'SUGGEST';
    reason = swapApplied ? 'swap_corrected_moderate_confidence' : 'moderate_confidence_match';
  } else {
    // Low confidence - try title-match fallback before rejecting
    console.log(`[SwapAwareResolver] Low confidence (${bestScore.toFixed(3)}) - attempting title-match fallback`);

    const fallbackResult = await executeTitleMatchFallback(
      extractedTitle,
      extractedAuthor,
      provider
    );

    debug.titleMatchFallbackTriggered = fallbackResult.triggered;
    if (fallbackResult.triggered) {
      debug.titleMatchFallback = fallbackResult.debug;
    }

    if (fallbackResult.triggered && fallbackResult.decision === 'suggest') {
      debug.resolutionTimeMs = Date.now() - startTime;

      console.log(`[SwapAwareResolver] Title-match fallback triggered: ` +
        `title="${fallbackResult.suggestedTitle}", author="${fallbackResult.suggestedAuthor}"`);

      return {
        decisionTier: 'SUGGEST',
        winningHypothesis: winner,
        swapApplied: false,
        correctedTitle: fallbackResult.suggestedTitle,
        correctedAuthor: fallbackResult.suggestedAuthor,
        confidence: fallbackResult.confidence,
        reason: fallbackResult.reason,
        debug,
      };
    }

    decisionTier = 'REJECT';
    reason = 'low_confidence';
  }

  // Get corrected fields from API result
  const correctedTitle = bestCandidate.book.title;
  const correctedAuthor = bestCandidate.book.authors?.[0] ?? null;

  console.log(`[SwapAwareResolver] Decision: ${decisionTier}, swap=${swapApplied}, title="${correctedTitle}", author="${correctedAuthor}"`);

  return {
    decisionTier,
    winningHypothesis: winner,
    swapApplied,
    correctedTitle,
    correctedAuthor,
    confidence: bestScore,
    reason,
    debug,
  };
}

/**
 * Apply resolver correction to extracted fields
 *
 * When resolver returns ACCEPT or SUGGEST, use API fields to correct extraction.
 * This safely fixes missing chars, swaps, and typos by using authoritative API data.
 */
export function applyResolverCorrection(
  result: SwapAwareResolutionResult,
  originalTitle: string | null,
  originalAuthor: string | null
): { title: string | null; author: string | null; wasCorrect: boolean } {
  if (result.decisionTier === 'REJECT') {
    // No correction - keep original
    return {
      title: originalTitle,
      author: originalAuthor,
      wasCorrect: false,
    };
  }

  // Use API fields (this fixes missing chars, OCR errors, etc.)
  return {
    title: result.correctedTitle ?? originalTitle,
    author: result.correctedAuthor ?? originalAuthor,
    wasCorrect: !result.swapApplied &&
      result.correctedTitle?.toLowerCase() === originalTitle?.toLowerCase() &&
      result.correctedAuthor?.toLowerCase() === originalAuthor?.toLowerCase(),
  };
}
