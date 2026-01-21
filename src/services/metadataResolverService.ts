/**
 * Metadata Resolver Service (Gate 8 - RESOLVE)
 *
 * Scores and ranks metadata matches using composite signals.
 * Implements dominance/gap rules for acceptance decisions.
 */

import type {
  SearchCandidate,
  ResolvedBook,
  ScoredMatch,
  MatchSignals,
  MetadataMatch,
} from '../types';
import {
  normalizedJaroWinkler,
  tokenize,
  computeGenericPenalty,
  findBestMatch,
} from '../utils/stringSimilarity';
import { areIsbnsEquivalent } from '../utils/isbnUtils';
import { isMetadataVerboseDebug } from '../config/debug';

// ============================================================================
// Scoring Weights
// ============================================================================

/**
 * Composite scoring weights
 * Must sum to 1.0 (excluding penalties)
 */
export const SCORING_WEIGHTS = {
  titleSimilarity: 0.30,
  authorPresence: 0.25,
  isbnMatch: 0.20,
  wordCoverage: 0.15,
  resultRank: 0.05,
  genericPenalty: -0.05, // Negative weight (penalty)
};

// ============================================================================
// Signal Computation
// ============================================================================

/**
 * Compute match signals for scoring
 *
 * @param candidate - Search candidate
 * @param book - Resolved book
 * @param resultPosition - Position in search results (0-indexed)
 * @returns Match signals
 */
export function computeMatchSignals(
  candidate: SearchCandidate,
  book: ResolvedBook,
  resultPosition: number
): MatchSignals {
  const queryTitle = candidate.titleHint || candidate.query;
  const queryAuthor = candidate.authorHint;
  const resultTitle = book.title;
  const resultAuthor = book.authors.length > 0 ? book.authors[0] : undefined;

  // Check ISBN match
  let isbnMatched = false;
  if (candidate.isbn) {
    if (book.isbn13 && areIsbnsEquivalent(candidate.isbn, book.isbn13)) {
      isbnMatched = true;
    } else if (book.isbn10 && areIsbnsEquivalent(candidate.isbn, book.isbn10)) {
      isbnMatched = true;
    }
  }

  // Compute token coverage
  const queryTokens = candidate.tokens;
  const resultText = `${resultTitle} ${book.authors.join(' ')}`.toLowerCase();
  const resultTokens = new Set(tokenize(resultText));

  let tokensInResult = 0;
  for (const token of queryTokens) {
    if (resultTokens.has(token)) {
      tokensInResult++;
    }
  }

  return {
    queryTitle,
    resultTitle,
    queryAuthor,
    resultAuthor,
    queryHadAuthor: !!queryAuthor,
    isbnMatched,
    queryTokensInResult: tokensInResult,
    queryTokenCount: queryTokens.length,
    resultPosition,
  };
}

// ============================================================================
// Normalized Signal Values
// ============================================================================

/**
 * Normalize signals to [0, 1] range for composite scoring
 *
 * @param signals - Raw match signals
 * @param candidate - Search candidate
 * @param book - Resolved book
 * @returns Normalized signal values
 */
export function normalizeSignals(
  signals: MatchSignals,
  candidate: SearchCandidate,
  book: ResolvedBook
): Record<string, number> {
  // Title similarity: Jaro-Winkler [0-1]
  const titleSimilarity = normalizedJaroWinkler(
    signals.queryTitle,
    signals.resultTitle
  );

  // Author presence: [0-1]
  // If query had author, measure similarity; otherwise give partial credit if result has authors
  let authorPresence = 0;
  if (signals.queryHadAuthor && signals.queryAuthor) {
    if (book.authors.length > 0) {
      // Find best match among authors
      const { score } = findBestMatch(
        signals.queryAuthor,
        book.authors
      );
      authorPresence = score;
    }
  } else if (book.authors.length > 0) {
    // No query author but result has authors - partial credit
    authorPresence = 0.5;
  }

  // ISBN match: binary [0, 1]
  const isbnMatch = signals.isbnMatched ? 1 : 0;

  // Word coverage: [0-1]
  const wordCoverage =
    signals.queryTokenCount > 0
      ? signals.queryTokensInResult / signals.queryTokenCount
      : 0;

  // Result rank: [0-1], 1 for position 0, decreasing
  const resultRank = Math.max(0, Math.min(1, 1 - signals.resultPosition / 10));

  // Generic penalty: [0-1], higher = more generic = worse
  const genericPenalty = computeGenericPenalty(
    signals.queryTitle,
    signals.resultTitle
  );

  return {
    titleSimilarity,
    authorPresence,
    isbnMatch,
    wordCoverage,
    resultRank,
    genericPenalty,
  };
}

// ============================================================================
// Composite Scoring
// ============================================================================

/**
 * Compute composite score from normalized signals
 *
 * @param normalizedSignals - Normalized signal values
 * @returns Composite score [0-1]
 */
export function computeComposite(
  normalizedSignals: Record<string, number>
): number {
  let score = 0;

  score += normalizedSignals.titleSimilarity * SCORING_WEIGHTS.titleSimilarity;
  score += normalizedSignals.authorPresence * SCORING_WEIGHTS.authorPresence;
  score += normalizedSignals.isbnMatch * SCORING_WEIGHTS.isbnMatch;
  score += normalizedSignals.wordCoverage * SCORING_WEIGHTS.wordCoverage;
  score += normalizedSignals.resultRank * SCORING_WEIGHTS.resultRank;

  // Apply generic penalty (negative weight means subtract)
  score +=
    normalizedSignals.genericPenalty * SCORING_WEIGHTS.genericPenalty;

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, score));
}

/**
 * Score a single match
 *
 * @param candidate - Search candidate
 * @param book - Resolved book
 * @param resultPosition - Position in search results
 * @returns Scored match
 */
export function scoreMatch(
  candidate: SearchCandidate,
  book: ResolvedBook,
  resultPosition: number
): ScoredMatch {
  const signals = computeMatchSignals(candidate, book, resultPosition);
  const normalizedSignals = normalizeSignals(signals, candidate, book);
  const composite = computeComposite(normalizedSignals);

  if (isMetadataVerboseDebug()) {
    console.log(
      `[Resolver] Scoring "${book.title}" at position ${resultPosition}: ` +
        `composite=${composite.toFixed(3)}, ` +
        `title=${normalizedSignals.titleSimilarity.toFixed(2)}, ` +
        `author=${normalizedSignals.authorPresence.toFixed(2)}, ` +
        `isbn=${normalizedSignals.isbnMatch}, ` +
        `coverage=${normalizedSignals.wordCoverage.toFixed(2)}, ` +
        `rank=${normalizedSignals.resultRank.toFixed(2)}, ` +
        `penalty=${normalizedSignals.genericPenalty.toFixed(2)}`
    );
  }

  return {
    book,
    composite,
    normalizedSignals,
    signals,
  };
}

// ============================================================================
// Dominance Rules
// ============================================================================

/**
 * Check if first match dominates second match
 * Required gap depends on first match's score
 *
 * @param first - First match composite score
 * @param second - Second match composite score
 * @returns True if first dominates second
 */
export function isDominated(first: number, second: number): boolean {
  // Higher scores require smaller gap to dominate
  let requiredGap: number;

  if (first > 0.85) {
    requiredGap = 0.15;
  } else if (first > 0.70) {
    requiredGap = 0.20;
  } else {
    requiredGap = 0.30;
  }

  return first - second >= requiredGap;
}

// ============================================================================
// Match Aggregation
// ============================================================================

/**
 * Score and rank multiple matches
 *
 * @param candidate - Search candidate
 * @param matches - Raw matches from lookup
 * @returns Sorted scored matches (best first)
 */
export function scoreAndRankMatches(
  candidate: SearchCandidate,
  matches: ResolvedBook[]
): ScoredMatch[] {
  const scored: ScoredMatch[] = [];

  for (let i = 0; i < matches.length; i++) {
    scored.push(scoreMatch(candidate, matches[i], i));
  }

  // Sort by composite score descending
  scored.sort((a, b) => b.composite - a.composite);

  return scored;
}

// ============================================================================
// Resolver Interface (Stub for actual lookup integration)
// ============================================================================

/**
 * Metadata lookup adapter interface
 * Implementations can use Open Library, Google Books, etc.
 */
export interface MetadataLookupAdapter {
  /** Lookup by ISBN */
  lookupByIsbn(isbn: string): Promise<ResolvedBook[]>;
  /** Lookup by text query */
  lookupByText(query: string): Promise<ResolvedBook[]>;
  /** Check if adapter is available (online, configured, etc.) */
  isAvailable(): Promise<boolean>;
}

/**
 * Convert MetadataMatch to ResolvedBook
 */
export function metadataMatchToResolvedBook(match: MetadataMatch): ResolvedBook {
  // Try to separate ISBN-10 and ISBN-13
  let isbn10: string | undefined;
  let isbn13: string | undefined;

  if (match.isbn) {
    const normalized = match.isbn.replace(/[^0-9X]/gi, '');
    if (normalized.length === 10) {
      isbn10 = normalized;
    } else if (normalized.length === 13) {
      isbn13 = normalized;
    }
  }

  return {
    title: match.title,
    authors: match.authors,
    isbn10,
    isbn13,
    publisher: match.publisher,
    publishYear: match.publishYear,
    coverUrl: match.coverUrl,
    source: match.source,
    sourceId: match.sourceId,
  };
}

/**
 * Stub adapter that returns empty results
 * Used when no real adapter is configured
 */
export class StubMetadataLookupAdapter implements MetadataLookupAdapter {
  async lookupByIsbn(_isbn: string): Promise<ResolvedBook[]> {
    // TODO: Implement real lookup (Open Library, Google Books)
    console.log('[Resolver] Stub adapter: ISBN lookup not implemented');
    return [];
  }

  async lookupByText(_query: string): Promise<ResolvedBook[]> {
    // TODO: Implement real lookup
    console.log('[Resolver] Stub adapter: Text lookup not implemented');
    return [];
  }

  async isAvailable(): Promise<boolean> {
    // Stub is always "available" but returns no results
    return true;
  }
}

// ============================================================================
// Main Resolver Function
// ============================================================================

export interface ResolveMetadataInput {
  /** Search candidates to resolve */
  candidates: SearchCandidate[];
  /** Full text block for verification */
  fullTextBlock: string;
  /** Lookup adapter (defaults to stub) */
  adapter?: MetadataLookupAdapter;
  /** Maximum results per candidate */
  maxResultsPerCandidate?: number;
}

export interface ResolveMetadataResult {
  /** All scored matches, sorted by composite score */
  scoredMatches: ScoredMatch[];
  /** Whether lookup was performed (false if offline/unavailable) */
  lookupPerformed: boolean;
  /** Best candidate used for query (highest confidence) */
  primaryCandidate: SearchCandidate | null;
}

/**
 * Resolve metadata for search candidates
 *
 * @param input - Resolution input
 * @returns Resolution result with scored matches
 */
export async function resolveMetadata(
  input: ResolveMetadataInput
): Promise<ResolveMetadataResult> {
  const {
    candidates,
    adapter = new StubMetadataLookupAdapter(),
    maxResultsPerCandidate = 5,
  } = input;

  if (candidates.length === 0) {
    return {
      scoredMatches: [],
      lookupPerformed: false,
      primaryCandidate: null,
    };
  }

  // Check adapter availability
  const available = await adapter.isAvailable();
  if (!available) {
    console.log('[Resolver] Adapter not available, skipping lookup');
    return {
      scoredMatches: [],
      lookupPerformed: false,
      primaryCandidate: candidates[0],
    };
  }

  // Find primary candidate (highest confidence)
  const primaryCandidate = candidates.reduce((best, c) =>
    c.confidence > best.confidence ? c : best
  );

  const allMatches: ResolvedBook[] = [];
  const seenIds = new Set<string>();

  // If we have an ISBN, prioritize ISBN lookup
  if (primaryCandidate.isbn) {
    if (isMetadataVerboseDebug()) {
      console.log(`[Resolver] Looking up by ISBN: ${primaryCandidate.isbn}`);
    }

    const isbnMatches = await adapter.lookupByIsbn(primaryCandidate.isbn);
    for (const match of isbnMatches.slice(0, maxResultsPerCandidate)) {
      const id = `${match.title}:${match.authors.join(',')}`;
      if (!seenIds.has(id)) {
        seenIds.add(id);
        allMatches.push(match);
      }
    }
  }

  // Text-based lookup for each candidate
  for (const candidate of candidates) {
    if (isMetadataVerboseDebug()) {
      console.log(
        `[Resolver] Looking up by text: "${candidate.query.substring(0, 50)}..."`
      );
    }

    const textMatches = await adapter.lookupByText(candidate.query);
    for (const match of textMatches.slice(0, maxResultsPerCandidate)) {
      const id = `${match.title}:${match.authors.join(',')}`;
      if (!seenIds.has(id)) {
        seenIds.add(id);
        allMatches.push(match);
      }
    }
  }

  if (isMetadataVerboseDebug()) {
    console.log(`[Resolver] Found ${allMatches.length} unique matches`);
  }

  // Score all matches using primary candidate
  const scoredMatches = scoreAndRankMatches(primaryCandidate, allMatches);

  return {
    scoredMatches,
    lookupPerformed: true,
    primaryCandidate,
  };
}
