/**
 * Token-Set Fuzzy Scoring
 *
 * Order-invariant, noise-tolerant scoring using Levenshtein-based
 * fuzzy token matching. Designed to handle OCR errors and jumbled
 * title/author fields.
 *
 * Key features:
 * - Fuzzy matching: tokens match if Levenshtein similarity >= 0.84
 * - Order-invariant: matches tokens regardless of position
 * - F1-based scoring: precision * recall harmonic mean
 * - Minimum signal gate: overlap < 2 caps score at 0.10
 * - Generic title penalty: -0.15 for single common word titles
 * - ISBN bonus: +0.15 for exact ISBN matches
 */

import {
  ISBN_BONUS,
  GENERIC_TITLE_PENALTY,
  MIN_OVERLAP_COUNT,
  MIN_SIGNAL_SCORE_CAP,
} from '../config/metadataResolutionConfig';

// ============================================================================
// Configuration
// ============================================================================

/** Minimum Levenshtein similarity for a token to count as "overlap"
 * Lowered from 0.84 to 0.75 to tolerate common OCR errors:
 * - "denth" → "death" (0.80)
 * - "straighi" → "straight" (0.75)
 * - "eaye" → "faye" (0.75)
 */
export const FUZZY_MATCH_THRESHOLD = 0.75;

/** Minimum token length to include in scoring (shorter = noise) */
export const MIN_TOKEN_LENGTH = 3;

/** Generic single-word titles that should be penalized without author signal */
const GENERIC_SINGLE_WORD_TITLES = new Set([
  'it', 'us', 'them', 'home', 'room', 'gone', 'the', 'a', 'an',
  'love', 'life', 'time', 'day', 'night', 'girl', 'boy', 'man', 'woman',
  'house', 'place', 'road', 'way', 'story', 'book', 'novel', 'tale',
]);

/** Noise tokens to filter from evidence (genre, marketing, publishing) */
const NOISE_TOKENS = new Set([
  // Genre/category
  'fiction', 'nonfiction', 'novel', 'memoir', 'biography', 'thriller',
  'mystery', 'romance', 'fantasy', 'horror', 'suspense', 'adventure',
  'literary', 'historical', 'contemporary', 'classic', 'bestseller',
  // Publishing
  'hardcover', 'paperback', 'ebook', 'audiobook', 'edition', 'reprint',
  'anniversary', 'revised', 'updated', 'expanded', 'illustrated',
  'mass', 'market', 'trade', 'large', 'print', 'type',
  // Marketing
  'bestselling', 'award', 'winning', 'national', 'international',
  'york', 'times', 'list', 'club', 'selection', 'oprah', 'reese',
  // Shelf labels
  'fiction', 'general', 'adult', 'young', 'new', 'arrivals', 'staff', 'picks',
]);

// ============================================================================
// Types
// ============================================================================

export interface FuzzyScoreResult {
  /** Final score (0-1 range, may exceed with bonuses) */
  score: number;
  /** Evidence tokens used */
  evidenceTokens: string[];
  /** Candidate tokens used */
  candidateTokens: string[];
  /** Number of tokens that matched (fuzzy or exact) */
  overlapCount: number;
  /** Precision: overlapCount / evidenceTokens.length */
  precision: number;
  /** Recall: overlapCount / candidateTokens.length */
  recall: number;
  /** F1 score: harmonic mean of precision and recall */
  f1: number;
  /** Whether ISBN was matched */
  isbnMatched: boolean;
  /** ISBN bonus applied (+0.15 if matched) */
  isbnBonus: number;
  /** Penalties applied */
  penalties: Array<{ type: string; value: number; reason: string }>;
  /** Debug: matched token pairs with similarity */
  matchedPairs: Array<{ evidence: string; candidate: string; similarity: number }>;
  /** Whether author signal was detected in evidence */
  hasAuthorSignal: boolean;
}

export interface FuzzyScoreOptions {
  /** Whether ISBN was detected as matching upstream */
  isbnMatch?: boolean;
  /** Enable debug output */
  debug?: boolean;
  /** Author hint from hypothesis (for author signal detection) */
  authorHint?: string;
}

// ============================================================================
// Levenshtein Distance
// ============================================================================

/**
 * Compute Levenshtein distance between two strings.
 * Uses dynamic programming with O(min(m,n)) space optimization.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Use two rows instead of full matrix
  let prevRow = new Array(m + 1);
  let currRow = new Array(m + 1);

  // Initialize first row
  for (let i = 0; i <= m; i++) {
    prevRow[i] = i;
  }

  // Fill the matrix row by row
  for (let j = 1; j <= n; j++) {
    currRow[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[i] = Math.min(
        currRow[i - 1] + 1,      // insertion
        prevRow[i] + 1,          // deletion
        prevRow[i - 1] + cost    // substitution
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[m];
}

/**
 * Compute normalized Levenshtein similarity (0-1).
 * 1.0 = identical, 0.0 = completely different.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLen;
}

// ============================================================================
// Normalization & Tokenization
// ============================================================================

/**
 * Aggressively normalize text for scoring:
 * - Lowercase
 * - Strip diacritics
 * - Remove punctuation
 * - Collapse whitespace
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    // Remove diacritics (é → e, ñ → n, etc.)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Remove punctuation except apostrophes in words
    .replace(/[^\w\s']/g, ' ')
    // Remove standalone apostrophes
    .replace(/(?<!\w)'|'(?!\w)/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize normalized text:
 * - Split on whitespace
 * - Filter pure numbers (except ISBN-like)
 * - Filter noise tokens
 * - Filter short tokens (< MIN_TOKEN_LENGTH)
 */
export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  const rawTokens = normalized.split(/\s+/).filter(Boolean);

  return rawTokens.filter((token) => {
    // Remove apostrophe endings (author's → author)
    const cleanToken = token.replace(/'s$/, '');

    // Skip too short
    if (cleanToken.length < MIN_TOKEN_LENGTH) return false;

    // Skip pure numbers (but keep ISBN-like: 10 or 13 digits)
    if (/^\d+$/.test(cleanToken)) {
      return cleanToken.length === 10 || cleanToken.length === 13;
    }

    // Skip noise tokens
    if (NOISE_TOKENS.has(cleanToken)) return false;

    return true;
  }).map((t) => t.replace(/'s$/, '')); // Clean apostrophes from kept tokens
}

/**
 * Build token set from title + authors.
 */
export function buildCandidateTokens(title: string, authors: string[]): string[] {
  const combinedText = [title, ...authors].join(' ');
  return [...new Set(tokenize(combinedText))]; // Dedupe
}

/**
 * Build evidence token set from merged evidence text.
 */
export function buildEvidenceTokensFromText(evidenceText: string): string[] {
  return [...new Set(tokenize(evidenceText))]; // Dedupe
}

// ============================================================================
// Fuzzy Token Matching
// ============================================================================

/**
 * Find best matching candidate token for an evidence token.
 * Returns the best similarity score and the matched token.
 */
function findBestMatch(
  evidenceToken: string,
  candidateTokens: string[]
): { token: string | null; similarity: number } {
  let bestToken: string | null = null;
  let bestSimilarity = 0;

  for (const candidateToken of candidateTokens) {
    // Quick exact match check
    if (evidenceToken === candidateToken) {
      return { token: candidateToken, similarity: 1.0 };
    }

    // Compute Levenshtein similarity
    const similarity = levenshteinSimilarity(evidenceToken, candidateToken);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestToken = candidateToken;
    }
  }

  return { token: bestToken, similarity: bestSimilarity };
}

/**
 * Detect if evidence contains author-like signal.
 * Looks for capitalized multi-word patterns typical of names.
 */
function detectAuthorSignal(evidenceText: string, authorHint?: string): boolean {
  // If we have an author hint, check if any of its tokens appear
  if (authorHint) {
    const hintTokens = tokenize(authorHint);
    const evidenceTokens = tokenize(evidenceText);
    const matchCount = hintTokens.filter((ht) =>
      evidenceTokens.some((et) => levenshteinSimilarity(ht, et) >= FUZZY_MATCH_THRESHOLD)
    ).length;
    if (matchCount >= 1 && hintTokens.length > 0) {
      return true;
    }
  }

  // Look for name-like patterns: 2-4 capitalized words
  const namePattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g;
  const names = evidenceText.match(namePattern) || [];
  return names.length > 0;
}

/**
 * Check if title is a generic single-word title.
 */
function isGenericSingleWordTitle(title: string): boolean {
  const tokens = tokenize(title);
  if (tokens.length !== 1) return false;
  return GENERIC_SINGLE_WORD_TITLES.has(tokens[0]);
}

// ============================================================================
// Main Scoring Function
// ============================================================================

/**
 * Compute token-set fuzzy score between evidence and candidate.
 *
 * Algorithm:
 * 1. Tokenize and normalize both evidence and candidate
 * 2. For each evidence token, find best match in candidate tokens
 * 3. Count as "overlap" if similarity >= 0.84
 * 4. Compute precision, recall, F1
 * 5. Apply ISBN bonus and generic title penalty
 * 6. Cap score if overlap < 2 (insufficient signal)
 */
export function tokenSetFuzzyScore(
  evidenceText: string,
  candidateTitle: string,
  candidateAuthors: string[],
  options: FuzzyScoreOptions = {}
): FuzzyScoreResult {
  const { isbnMatch = false, authorHint } = options;

  // Build token sets
  const evidenceTokens = buildEvidenceTokensFromText(evidenceText);
  const candidateTokens = buildCandidateTokens(candidateTitle, candidateAuthors);

  // Track matched pairs for debugging
  const matchedPairs: FuzzyScoreResult['matchedPairs'] = [];
  const usedCandidateTokens = new Set<string>();

  // Find best match for each evidence token
  let overlapCount = 0;
  for (const evidenceToken of evidenceTokens) {
    // Filter out already-used candidate tokens for 1:1 matching
    const availableCandidates = candidateTokens.filter((t) => !usedCandidateTokens.has(t));
    const { token: bestMatch, similarity } = findBestMatch(evidenceToken, availableCandidates);

    if (bestMatch && similarity >= FUZZY_MATCH_THRESHOLD) {
      overlapCount++;
      usedCandidateTokens.add(bestMatch);
      matchedPairs.push({
        evidence: evidenceToken,
        candidate: bestMatch,
        similarity,
      });
    }
  }

  // Compute precision, recall, F1
  const precision = evidenceTokens.length > 0
    ? overlapCount / evidenceTokens.length
    : 0;
  const recall = candidateTokens.length > 0
    ? overlapCount / candidateTokens.length
    : 0;
  const f1 = precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;

  // Start with F1 as base score
  let score = f1;
  const penalties: FuzzyScoreResult['penalties'] = [];

  // Detect author signal
  const hasAuthorSignal = detectAuthorSignal(evidenceText, authorHint);

  // Apply ISBN bonus
  const isbnBonus = isbnMatch ? ISBN_BONUS : 0;
  score += isbnBonus;

  // Apply generic title penalty (only if no author signal and low overlap)
  if (isGenericSingleWordTitle(candidateTitle) && !hasAuthorSignal && overlapCount < 3) {
    penalties.push({
      type: 'generic_title',
      value: GENERIC_TITLE_PENALTY,
      reason: `Generic single-word title "${candidateTitle}" without author signal`,
    });
    score -= GENERIC_TITLE_PENALTY;
  }

  // Minimum signal gate: cap score if insufficient overlap
  if (overlapCount < MIN_OVERLAP_COUNT) {
    const cappedScore = Math.min(score, MIN_SIGNAL_SCORE_CAP);
    if (cappedScore < score) {
      penalties.push({
        type: 'min_signal',
        value: score - cappedScore,
        reason: `Overlap ${overlapCount} < ${MIN_OVERLAP_COUNT}, capped to ${MIN_SIGNAL_SCORE_CAP}`,
      });
      score = cappedScore;
    }
  }

  // Clamp to valid range (can exceed 1.0 with bonuses, but not below 0)
  score = Math.max(0, score);

  return {
    score,
    evidenceTokens,
    candidateTokens,
    overlapCount,
    precision,
    recall,
    f1,
    isbnMatched: isbnMatch,
    isbnBonus,
    penalties,
    matchedPairs,
    hasAuthorSignal,
  };
}

// ============================================================================
// Batch Scoring & Ranking
// ============================================================================

export interface ScoredCandidate<T> {
  candidate: T;
  scoring: FuzzyScoreResult;
}

/**
 * Score and rank multiple candidates against evidence.
 * Returns sorted by score descending.
 */
export function scoreAndRankWithFuzzy<T extends { title: string; authors: string[] }>(
  candidates: T[],
  evidenceText: string,
  options: FuzzyScoreOptions = {}
): ScoredCandidate<T>[] {
  const scored = candidates.map((candidate) => ({
    candidate,
    scoring: tokenSetFuzzyScore(
      evidenceText,
      candidate.title,
      candidate.authors,
      options
    ),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.scoring.score - a.scoring.score);

  return scored;
}

/**
 * Compute score gap between top two candidates.
 */
export function computeScoreGap<T>(scoredCandidates: ScoredCandidate<T>[]): number {
  if (scoredCandidates.length < 2) {
    return scoredCandidates.length === 1 ? 1.0 : 0; // Single candidate = infinite gap
  }
  return scoredCandidates[0].scoring.score - scoredCandidates[1].scoring.score;
}
