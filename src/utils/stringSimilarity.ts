/**
 * String Similarity Utilities
 *
 * Provides Jaro-Winkler similarity algorithm and related text comparison functions.
 * Used for matching OCR-extracted text against metadata search results.
 */

// ============================================================================
// Jaro Similarity
// ============================================================================

/**
 * Compute Jaro similarity between two strings
 * Returns value in range [0, 1] where 1 is identical
 *
 * @param s1 - First string
 * @param s2 - Second string
 * @returns Jaro similarity score [0-1]
 */
export function jaroSimilarity(s1: string, s2: string): number {
  // Handle edge cases
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  // Matching window size
  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;

  // Track matched characters
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  // Jaro formula
  const jaro =
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3;

  return jaro;
}

// ============================================================================
// Jaro-Winkler Similarity
// ============================================================================

/**
 * Compute Jaro-Winkler similarity between two strings
 * Extends Jaro by giving bonus for common prefix
 * Returns value in range [0, 1] where 1 is identical
 *
 * @param s1 - First string
 * @param s2 - Second string
 * @param scalingFactor - Prefix scaling factor (default 0.1, must be <= 0.25)
 * @returns Jaro-Winkler similarity score [0-1]
 */
export function jaroWinklerSimilarity(
  s1: string,
  s2: string,
  scalingFactor: number = 0.1
): number {
  // Ensure scaling factor is valid
  const p = Math.min(scalingFactor, 0.25);

  const jaro = jaroSimilarity(s1, s2);

  // Find common prefix length (max 4 characters)
  let prefixLength = 0;
  const maxPrefixLength = Math.min(4, Math.min(s1.length, s2.length));

  for (let i = 0; i < maxPrefixLength; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  // Jaro-Winkler formula
  return jaro + prefixLength * p * (1 - jaro);
}

// ============================================================================
// Normalized String Comparison
// ============================================================================

/**
 * Normalize a string for comparison
 * - Lowercase
 * - Remove punctuation
 * - Collapse whitespace
 * - Trim
 *
 * @param text - String to normalize
 * @returns Normalized string
 */
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();
}

/**
 * Compute Jaro-Winkler similarity with normalization
 *
 * @param s1 - First string
 * @param s2 - Second string
 * @returns Jaro-Winkler similarity score [0-1]
 */
export function normalizedJaroWinkler(s1: string, s2: string): number {
  return jaroWinklerSimilarity(
    normalizeForComparison(s1),
    normalizeForComparison(s2)
  );
}

// ============================================================================
// Tokenization
// ============================================================================

/**
 * Tokenize a string into words
 * - Normalize
 * - Split on whitespace
 * - Filter empty tokens
 *
 * @param text - String to tokenize
 * @returns Array of tokens
 */
export function tokenize(text: string): string[] {
  return normalizeForComparison(text)
    .split(' ')
    .filter((token) => token.length > 0);
}

/**
 * Compute token overlap between two strings
 *
 * @param s1 - First string
 * @param s2 - Second string
 * @returns Object with overlap count and ratio
 */
export function tokenOverlap(
  s1: string,
  s2: string
): { count: number; ratio: number } {
  const tokens1 = tokenize(s1);
  const tokens2 = new Set(tokenize(s2));

  if (tokens1.length === 0) {
    return { count: 0, ratio: 0 };
  }

  let count = 0;
  for (const token of tokens1) {
    if (tokens2.has(token)) {
      count++;
    }
  }

  return {
    count,
    ratio: count / tokens1.length,
  };
}

// ============================================================================
// Best Match Finding
// ============================================================================

/**
 * Find the best similarity match from a list of candidates
 *
 * @param query - Query string
 * @param candidates - List of candidate strings
 * @returns Best match and its similarity score
 */
export function findBestMatch(
  query: string,
  candidates: string[]
): { match: string | null; score: number; index: number } {
  if (candidates.length === 0) {
    return { match: null, score: 0, index: -1 };
  }

  let bestScore = 0;
  let bestMatch = candidates[0];
  let bestIndex = 0;

  for (let i = 0; i < candidates.length; i++) {
    const score = normalizedJaroWinkler(query, candidates[i]);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidates[i];
      bestIndex = i;
    }
  }

  return { match: bestMatch, score: bestScore, index: bestIndex };
}

// ============================================================================
// Generic Title Detection
// ============================================================================

/**
 * Common words that don't help distinguish a specific book
 */
export const GENERIC_TOKENS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'in',
  'to',
  'for',
  'on',
  'with',
  'by',
  'at',
  'from',
  'as',
  'is',
  'it',
  'that',
  'this',
  'be',
  'are',
  'was',
  'were',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'shall',
  'can',
  'need',
  'book',
  'volume',
  'vol',
  'edition',
  'ed',
  'part',
  'chapter',
  'series',
]);

/**
 * Titles that are extremely common and prone to false matches
 */
export const HIGH_COLLISION_TITLES = new Set([
  'the book',
  'introduction',
  'guide',
  'handbook',
  'manual',
  'complete guide',
  'beginners guide',
  'for dummies',
  'essentials',
  'fundamentals',
  'principles',
  'basics',
  'collection',
  'anthology',
  'selected works',
  'best of',
  'greatest hits',
]);

/**
 * Count specific (non-generic) tokens in a string
 *
 * @param text - String to analyze
 * @returns Number of specific tokens
 */
export function countSpecificTokens(text: string): number {
  const tokens = tokenize(text);
  return tokens.filter((t) => !GENERIC_TOKENS.has(t)).length;
}

/**
 * Compute generic title penalty for scoring
 * Higher penalty = more generic = worse match
 *
 * @param queryTitle - The query title
 * @param resultTitle - The result title
 * @returns Penalty value [0-1]
 */
export function computeGenericPenalty(
  queryTitle: string,
  resultTitle: string
): number {
  const queryTokens = tokenize(queryTitle);
  const resultTokens = tokenize(resultTitle);

  if (queryTokens.length === 0) {
    return 1.0; // Maximum penalty for empty query
  }

  // Count specific tokens
  const specificTokens = queryTokens.filter((t) => !GENERIC_TOKENS.has(t));
  const specificRatio =
    queryTokens.length > 0 ? specificTokens.length / queryTokens.length : 0;

  // Base penalty from generic ratio
  let penalty = (1 - specificRatio) * 0.3;

  // Additional penalty for high-collision titles
  const normalizedQuery = normalizeForComparison(queryTitle);
  for (const collisionTitle of HIGH_COLLISION_TITLES) {
    if (normalizedQuery.includes(collisionTitle)) {
      penalty += 0.4;
      break;
    }
  }

  // Additional penalty for very short result titles
  if (resultTokens.length <= 2) {
    penalty += 0.1;
  }

  // Cap at [0, 1]
  return Math.max(0, Math.min(1, penalty));
}
