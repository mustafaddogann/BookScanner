/**
 * OCR Confusion-Aware Matching Service
 *
 * Provides author similarity matching that tolerates OCR errors.
 * Part C of resolver-driven correction.
 *
 * Design principles:
 * - Tolerate missing leading character (insertion at start)
 * - Tolerate minor OCR confusions (O/0, I/1, S/5)
 * - ONLY apply when comparing OCR author to API author
 * - Never mutate OCR blindly - use API as source of truth
 */

import { editDistance, normalizeForMatch } from './lineClassification';

// ============================================================================
// OCR Confusable Character Groups
// ============================================================================

/**
 * Groups of visually similar characters that OCR often confuses
 * Used for comparison, NOT for mutation
 */
const OCR_CONFUSABLE_GROUPS: string[][] = [
  ['0', 'O', 'o'],  // Zero and letter O
  ['1', 'I', 'i', 'l', '|'],  // One, I, L
  ['5', 'S', 's'],  // Five and S
  ['8', 'B'],  // Eight and B
  ['2', 'Z', 'z'],  // Two and Z
  ['6', 'G'],  // Six and G
  ['9', 'g', 'q'],  // Nine, g, q
];

/**
 * Build a lookup map from character to canonical form
 */
function buildConfusableMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of OCR_CONFUSABLE_GROUPS) {
    const canonical = group[0]; // First char is canonical
    for (const char of group) {
      map.set(char, canonical);
    }
  }
  return map;
}

const CONFUSABLE_MAP = buildConfusableMap();

// ============================================================================
// Normalization Functions
// ============================================================================

/**
 * Normalize a string for OCR-tolerant comparison
 * Converts confusable characters to canonical form
 */
export function normalizeForOcrComparison(text: string): string {
  const upper = text.toUpperCase().trim();
  let result = '';
  for (const char of upper) {
    result += CONFUSABLE_MAP.get(char) ?? char;
  }
  return result;
}

/**
 * Normalize for API comparison (clean + OCR-tolerant)
 * Used when comparing OCR text to API results
 */
export function normalizeForApiComparison(text: string): string {
  // First apply standard normalization
  const normalized = normalizeForMatch(text);
  // Then apply OCR confusable normalization
  return normalizeForOcrComparison(normalized);
}

// ============================================================================
// Author Similarity with OCR Tolerance
// ============================================================================

/**
 * Result of author similarity comparison
 */
export interface AuthorSimilarityResult {
  /** Similarity score [0-1] */
  similarity: number;
  /** Whether match was found */
  isMatch: boolean;
  /** Reason for match/no-match */
  reason: string;
  /** Debug: normalized OCR author */
  normalizedOcr: string;
  /** Debug: normalized API author */
  normalizedApi: string;
  /** Debug: edit distance */
  editDistance: number;
  /** Debug: was missing leading char detected */
  missingLeadingChar: boolean;
}

/**
 * Compute author similarity with OCR tolerance
 *
 * Tolerates:
 * - One missing leading character (e.g., "TONIO MARSH" vs "ANTONIO MARSH")
 * - One edit distance for short names
 * - OCR confusable characters (O/0, I/1, etc.)
 *
 * @param ocrAuthor - Author from OCR (may have errors)
 * @param apiAuthor - Author from API (ground truth)
 * @returns Similarity result with score and debug info
 */
export function computeAuthorSimilarity(
  ocrAuthor: string,
  apiAuthor: string
): AuthorSimilarityResult {
  const result: AuthorSimilarityResult = {
    similarity: 0,
    isMatch: false,
    reason: 'no_match',
    normalizedOcr: '',
    normalizedApi: '',
    editDistance: Infinity,
    missingLeadingChar: false,
  };

  if (!ocrAuthor || !apiAuthor) {
    result.reason = 'missing_input';
    return result;
  }

  // Normalize both for comparison
  const normOcr = normalizeForApiComparison(ocrAuthor);
  const normApi = normalizeForApiComparison(apiAuthor);

  result.normalizedOcr = normOcr;
  result.normalizedApi = normApi;

  // Exact match after normalization
  if (normOcr === normApi) {
    result.similarity = 1.0;
    result.isMatch = true;
    result.reason = 'exact_match';
    result.editDistance = 0;
    return result;
  }

  // Check for missing leading character
  // API author should be longer and OCR should be a suffix
  if (normApi.length > normOcr.length) {
    const suffixStart = normApi.length - normOcr.length;
    if (suffixStart <= 2) { // Allow 1-2 missing chars at start
      const apiSuffix = normApi.substring(suffixStart);
      if (apiSuffix === normOcr) {
        result.similarity = 0.95;
        result.isMatch = true;
        result.reason = 'missing_leading_char';
        result.editDistance = suffixStart;
        result.missingLeadingChar = true;
        return result;
      }
    }
  }

  // Calculate edit distance
  const dist = editDistance(normOcr, normApi);
  result.editDistance = dist;

  // Tolerance based on name length
  const maxLen = Math.max(normOcr.length, normApi.length);
  const minLen = Math.min(normOcr.length, normApi.length);

  // For short names (< 8 chars), allow 1 edit
  // For medium names (8-15 chars), allow 2 edits
  // For long names (> 15 chars), allow 3 edits
  let maxDist: number;
  if (maxLen < 8) {
    maxDist = 1;
  } else if (maxLen < 15) {
    maxDist = 2;
  } else {
    maxDist = 3;
  }

  if (dist <= maxDist) {
    // Calculate similarity based on edit distance
    result.similarity = 1 - (dist / maxLen);
    result.isMatch = result.similarity >= 0.7;
    result.reason = result.isMatch ? 'edit_distance_within_tolerance' : 'edit_distance_marginal';
    return result;
  }

  // Check for partial match (one token matches exactly)
  const ocrTokens = normOcr.split(/\s+/);
  const apiTokens = normApi.split(/\s+/);

  const matchingTokens = ocrTokens.filter(t => apiTokens.includes(t));
  if (matchingTokens.length >= 1 && matchingTokens.length >= ocrTokens.length - 1) {
    // Most tokens match
    result.similarity = matchingTokens.length / Math.max(ocrTokens.length, apiTokens.length);
    result.isMatch = result.similarity >= 0.6;
    result.reason = result.isMatch ? 'token_overlap_match' : 'token_overlap_low';
    return result;
  }

  // No match
  result.similarity = 1 - Math.min(1, dist / maxLen);
  result.reason = 'edit_distance_too_high';
  return result;
}

/**
 * Find best matching author from API authors list
 *
 * @param ocrAuthor - Author from OCR
 * @param apiAuthors - List of authors from API
 * @returns Best match with similarity score
 */
export function findBestAuthorMatch(
  ocrAuthor: string,
  apiAuthors: string[]
): { author: string | null; similarity: AuthorSimilarityResult } {
  if (!ocrAuthor || !apiAuthors || apiAuthors.length === 0) {
    return {
      author: null,
      similarity: {
        similarity: 0,
        isMatch: false,
        reason: 'no_candidates',
        normalizedOcr: ocrAuthor ?? '',
        normalizedApi: '',
        editDistance: Infinity,
        missingLeadingChar: false,
      },
    };
  }

  let bestAuthor: string | null = null;
  let bestSimilarity: AuthorSimilarityResult | null = null;

  for (const apiAuthor of apiAuthors) {
    const result = computeAuthorSimilarity(ocrAuthor, apiAuthor);

    if (!bestSimilarity || result.similarity > bestSimilarity.similarity) {
      bestAuthor = apiAuthor;
      bestSimilarity = result;
    }

    // Early exit on exact match
    if (result.similarity === 1.0) {
      break;
    }
  }

  return {
    author: bestAuthor,
    similarity: bestSimilarity!,
  };
}

/**
 * Check if OCR author matches any API author with tolerance
 */
export function authorMatchesWithTolerance(
  ocrAuthor: string,
  apiAuthors: string[]
): boolean {
  const result = findBestAuthorMatch(ocrAuthor, apiAuthors);
  return result.similarity.isMatch;
}
