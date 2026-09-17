/**
 * Metadata Resolution Configuration
 *
 * Centralized configuration for evidence-driven book resolution.
 * These constants control hypothesis generation, scoring thresholds,
 * and rate-limiting for Open Library API calls.
 */

// ============================================================================
// Hypothesis Generation Limits
// ============================================================================

/** Maximum hypotheses for pass1 (initial search) */
export const PASS1_MAX_HYPOTHESES = 5;

/** Maximum hypotheses for pass2 (boost pass) - increased for merged word splitting and initial letter fixes */
export const PASS2_MAX_HYPOTHESES = 25;

/** Minimum query length for hypotheses */
export const MIN_QUERY_LENGTH = 3;

/** Maximum tokens in a query (longer queries tend to fail on Open Library) */
export const MAX_QUERY_TOKENS = 7;

/** Minimum tokens in a query for meaningful search */
export const MIN_QUERY_TOKENS = 2;

// ============================================================================
// Scoring Thresholds
// ============================================================================

/**
 * Acceptance Gates:
 * - accepted (persist): score >= 0.88 AND overlapCount >= 3 AND (gap >= 0.12 OR ISBN match)
 * - suggested (local-only): score >= 0.60 AND overlapCount >= 3
 *   OR score >= 0.70 AND overlapCount >= 2 AND author signal present
 * - manual_review (ambiguity only): score >= 0.75 AND overlapCount >= 3 AND gap <= 0.08
 * - reject: else
 */

/** Minimum score for accept_high (with ISBN match) */
export const ACCEPT_HIGH_THRESHOLD = 0.88;

/** Minimum score for accept_medium */
export const ACCEPT_MEDIUM_THRESHOLD = 0.88;

/** Minimum gap between top and second candidate for accept_medium */
export const ACCEPT_MEDIUM_GAP = 0.12;

/**
 * Anchored accept: a lower-scoring match is still accepted when an author surname
 * and most of the title were read from the spine. Tuned on real shelf scans, where
 * suggestions at or above this score with a surname match were almost always correct.
 */
export const ANCHORED_ACCEPT_MIN_SCORE = 0.65;
export const ANCHORED_ACCEPT_MIN_GAP = 0.06;
export const ANCHORED_ACCEPT_MIN_TITLE_OVERLAP = 0.5;

/** Minimum overlapping tokens for accept_medium */
export const ACCEPT_MEDIUM_MIN_OVERLAP = 2;

/** Minimum score for suggested (replaces manual_review) */
export const SUGGESTED_THRESHOLD = 0.50;

/** Alternate suggested threshold when author signal exists */
export const SUGGESTED_AUTHOR_THRESHOLD = 0.55;

/** Minimum overlap for alternate suggested path */
export const SUGGESTED_AUTHOR_MIN_OVERLAP = 2;

/**
 * SUGGESTED_WEAK tier: Lower bar for UI-only display
 * - Never persists to database
 * - Shows user a best guess when nothing else qualifies
 * - Fills UI gaps so users see something for most crops
 *
 * Lowered from 0.45 to 0.40 to catch near-misses like "CAN" vs "CAT"
 * where most words match but one has a single-char OCR error.
 */
export const SUGGESTED_WEAK_THRESHOLD = 0.40;
export const SUGGESTED_WEAK_MIN_OVERLAP = 2;

/** Manual review threshold (ambiguity only) */
export const MANUAL_REVIEW_THRESHOLD = 0.65;

/** Manual review max gap (top two are close) */
export const MANUAL_REVIEW_MAX_GAP = 0.08;

/** Manual review minimum overlap */
export const MANUAL_REVIEW_MIN_OVERLAP = 3;

/** Minimum overlapping tokens for meaningful score */
export const MIN_OVERLAP_COUNT = 2;

/** Maximum score when overlap is below minimum */
export const MIN_SIGNAL_SCORE_CAP = 0.10;

// ============================================================================
// TITLE_ONLY Resolution Mode Thresholds
// ============================================================================

/**
 * TITLE_ONLY mode activates when:
 * - Author tokens are missing OR authorScore < TITLE_ONLY_AUTHOR_THRESHOLD
 *
 * TITLE_ONLY accept requires ALL of:
 * - titleScore >= TITLE_ONLY_ACCEPT_MIN
 * - titleTokenCount >= 2
 * - AND at least ONE of:
 *   - margin >= TITLE_ONLY_MARGIN_MIN (clear winner)
 *   - candidateCount <= TITLE_ONLY_MAX_CANDIDATES (few results)
 *   - publisherScore >= TITLE_ONLY_PUBLISHER_MIN (publisher confirms)
 */

/** Title score threshold to trigger TITLE_ONLY mode (author too weak) */
export const TITLE_ONLY_AUTHOR_THRESHOLD = 0.30;

/** Minimum title score for TITLE_ONLY accept */
export const TITLE_ONLY_ACCEPT_MIN = 0.92;

/** Minimum title score for TITLE_ONLY suggested (below accept) */
export const TITLE_ONLY_SUGGESTED_MIN = 0.72;

/** Minimum margin (gap) for TITLE_ONLY accept without other signals */
export const TITLE_ONLY_MARGIN_MIN = 0.12;

/** Maximum candidates for TITLE_ONLY accept (unique titles indicator) */
export const TITLE_ONLY_MAX_CANDIDATES = 3;

/** Publisher score threshold for TITLE_ONLY accept */
export const TITLE_ONLY_PUBLISHER_MIN = 0.60;

/** Minimum title tokens required for TITLE_ONLY (avoid 1-word false positives) */
export const TITLE_ONLY_MIN_TOKENS = 2;

/** Title score below which we reject in TITLE_ONLY mode */
export const TITLE_ONLY_REJECT_BELOW = 0.70;

// ============================================================================
// FULL_MATCH Resolution Mode Thresholds
// ============================================================================

/** Minimum title score for FULL_MATCH accept */
export const FULL_MATCH_TITLE_MIN = 0.78;

/** Minimum author score for FULL_MATCH accept */
export const FULL_MATCH_AUTHOR_MIN = 0.55;

/** Minimum combined score for FULL_MATCH accept */
export const FULL_MATCH_OVERALL_MIN = 0.72;

// ============================================================================
// Penalties and Bonuses
// ============================================================================

/** Bonus for ISBN match */
export const ISBN_BONUS = 0.15;

/** Penalty for generic single-word titles */
export const GENERIC_TITLE_PENALTY = 0.15;

/** Penalty for candidates missing author information - prefers editions with known authors */
export const MISSING_AUTHOR_PENALTY = 0.40;

// ============================================================================
// Scoring Weights
// ============================================================================

/** Weight for overlap ratio in combined score */
export const OVERLAP_WEIGHT = 0.5;

/** Weight for coverage ratio in combined score */
export const COVERAGE_WEIGHT = 0.3;

/** Weight for order score in combined score */
export const ORDER_WEIGHT = 0.2;

// ============================================================================
// Rate Limiting / Session Caps
// ============================================================================

/** Maximum results per hypothesis query */
export const MAX_RESULTS_PER_HYPOTHESIS = 10;

/** Maximum total queries per session (across all candidates) */
export const MAX_TOTAL_QUERIES_PER_SESSION = 50;

/** Maximum enrichment calls per session */
export const MAX_ENRICH_CALLS_PER_SESSION = 15;

/** Maximum candidates to return for suggested alternatives */
export const MAX_REVIEW_CANDIDATES = 5;

// ============================================================================
// Cache Configuration
// ============================================================================

/** Session cache TTL in milliseconds (30 minutes) */
export const SESSION_CACHE_TTL_MS = 30 * 60 * 1000;

// ============================================================================
// Boost Pass Configuration
// ============================================================================

/** Enable auto-boost for suggested/reject candidates */
export const AUTO_BOOST_ENABLED = true;

/** Maximum n-gram window size for boost hypotheses */
export const BOOST_MAX_NGRAM_SIZE = 3;

/** Number of top tokens to use for token-set query */
export const BOOST_TOP_TOKENS_COUNT = 7;

// ============================================================================
// ISBN Extraction Configuration
// ============================================================================

/**
 * Enable ISBN extraction from spine OCR text.
 *
 * HARD OFF by default: Spine OCR produces unreliable ISBN-like digit sequences
 * (e.g., "0-515-06011-9") that harm scoring and cause false rejects.
 *
 * When false:
 * - ISBN-like strings are NOT extracted from spine OCR
 * - Raw digit lines remain in evidence text (for debugging)
 * - ISBN is never used for scoring or query generation from spine sources
 *
 * When true (not recommended):
 * - ISBN extraction is attempted from spine OCR
 * - May cause false positives/negatives due to noisy OCR
 */
export const ENABLE_ISBN_FROM_SPINE = false;
