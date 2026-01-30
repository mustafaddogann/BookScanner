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

/** Maximum hypotheses for pass2 (boost pass) */
export const PASS2_MAX_HYPOTHESES = 12;

/** Minimum query length for hypotheses */
export const MIN_QUERY_LENGTH = 3;

// ============================================================================
// Scoring Thresholds
// ============================================================================

/**
 * Acceptance Gates:
 * - accept_high: ISBN matched AND score >= 0.70 (persisted)
 * - accept_medium: score >= 0.82 AND gap >= 0.18 AND overlapCount >= 3 (persisted)
 * - suggested: score >= 0.55 (shown to user, NOT persisted - optional review)
 * - reject: else
 */

/** Minimum score for accept_high (with ISBN match) */
export const ACCEPT_HIGH_THRESHOLD = 0.70;

/** Minimum score for accept_medium */
export const ACCEPT_MEDIUM_THRESHOLD = 0.82;

/** Minimum gap between top and second candidate for accept_medium */
export const ACCEPT_MEDIUM_GAP = 0.18;

/** Minimum overlapping tokens for accept_medium */
export const ACCEPT_MEDIUM_MIN_OVERLAP = 3;

/** Minimum score for suggested (replaces manual_review) */
export const SUGGESTED_THRESHOLD = 0.55;

/** Minimum overlapping tokens for meaningful score */
export const MIN_OVERLAP_COUNT = 2;

/** Maximum score when overlap is below minimum */
export const MIN_SIGNAL_SCORE_CAP = 0.10;

// ============================================================================
// Penalties and Bonuses
// ============================================================================

/** Bonus for ISBN match */
export const ISBN_BONUS = 0.15;

/** Penalty for generic single-word titles */
export const GENERIC_TITLE_PENALTY = 0.15;

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
