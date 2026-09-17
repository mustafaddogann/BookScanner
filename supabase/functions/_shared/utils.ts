/**
 * Shared utilities for Supabase Edge Functions
 * Gate 9: Resolver + Scoring + Verification + Acceptance
 */

import {
  ResolvedBook,
  OpenLibraryDoc,
  OpenLibraryIsbnResponse,
  MatchSignals,
  NormalizedSignals,
  MatchScore,
  SCORING_WEIGHTS,
  VerificationFlag,
  VERIFICATION_PENALTIES,
  AcceptanceDecision,
  EvidenceTier,
  ACCEPTANCE_THRESHOLDS,
  ScoredMatch,
  QueryCandidate,
} from './types.ts';

// ============================================================================
// Query Normalization
// ============================================================================

/**
 * Normalize a query string for consistent hashing and matching.
 */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' '); // Collapse whitespace
}

/**
 * Compute SHA-256 hash of a string.
 */
export async function computeHash(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract tokens from text for matching.
 */
export function tokenize(text: string): string[] {
  return normalizeQuery(text)
    .split(' ')
    .filter((t) => t.length > 1);
}

// ============================================================================
// Open Library Mapping
// ============================================================================

function normalizeIsbnValue(isbn: string | null | undefined): string | null {
  if (!isbn) return null;
  const normalized = isbn.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (normalized.length === 10 || normalized.length === 13) {
    return normalized;
  }
  return null;
}

function firstNormalizedIsbnByLength(
  isbns: Array<string | null | undefined> | undefined,
  length: 10 | 13
): string | null {
  if (!isbns || isbns.length === 0) {
    return null;
  }
  for (const candidate of isbns) {
    const normalized = normalizeIsbnValue(candidate);
    if (normalized && normalized.length === length) {
      return normalized;
    }
  }
  return null;
}

/**
 * Map Open Library search doc to ResolvedBook.
 */
export function mapSearchDocToBook(doc: OpenLibraryDoc): ResolvedBook {
  const isbn13 = firstNormalizedIsbnByLength(doc.isbn, 13);
  const isbn10 = firstNormalizedIsbnByLength(doc.isbn, 10);

  return {
    title: doc.title,
    authors: doc.author_name ?? [],
    isbn13,
    isbn10,
    publisher: doc.publisher?.[0] ?? null,
    publishYear: doc.first_publish_year ?? doc.publish_year?.[0] ?? null,
    edition: doc.edition_count ? `${doc.edition_count} editions` : null,
    coverUrl: doc.cover_i
      ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
      : null,
    source: 'openLibrary',
    sourceId: doc.key,
    pageCount: doc.number_of_pages_median,
    subjects: doc.subject?.slice(0, 5),
  };
}

/**
 * Map Open Library ISBN response to ResolvedBook.
 */
export function mapIsbnResponseToBook(
  response: OpenLibraryIsbnResponse,
  isbn: string
): ResolvedBook {
  const normalizedInputIsbn = normalizeIsbnValue(isbn);
  const isbn13 =
    firstNormalizedIsbnByLength(response.isbn_13, 13) ??
    (normalizedInputIsbn?.length === 13 ? normalizedInputIsbn : null);
  const isbn10 =
    firstNormalizedIsbnByLength(response.isbn_10, 10) ??
    (normalizedInputIsbn?.length === 10 ? normalizedInputIsbn : null);

  // Parse publish year from date string
  let publishYear: number | null = null;
  if (response.publish_date) {
    const yearMatch = response.publish_date.match(/\d{4}/);
    if (yearMatch) {
      publishYear = parseInt(yearMatch[0], 10);
    }
  }

  return {
    title: response.title,
    authors: [], // Authors need separate lookup via author keys
    isbn13,
    isbn10,
    publisher: response.publishers?.[0] ?? null,
    publishYear,
    edition: null,
    coverUrl: response.covers?.[0]
      ? `https://covers.openlibrary.org/b/id/${response.covers[0]}-M.jpg`
      : null,
    source: 'openLibrary',
    sourceId: response.key ?? `/isbn/${normalizedInputIsbn ?? isbn}`,
    pageCount: response.number_of_pages,
    subjects: response.subjects?.slice(0, 5),
  };
}

// ============================================================================
// String Similarity
// ============================================================================

/**
 * Compute Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

/**
 * Compute string similarity (0-1) using Levenshtein distance.
 */
export function stringSimilarity(a: string, b: string): number {
  const aNorm = normalizeQuery(a);
  const bNorm = normalizeQuery(b);

  if (aNorm === bNorm) return 1.0;
  if (aNorm.length === 0 || bNorm.length === 0) return 0.0;

  const distance = levenshteinDistance(aNorm, bNorm);
  const maxLen = Math.max(aNorm.length, bNorm.length);

  return 1 - distance / maxLen;
}

/**
 * Check if any author in list matches target author.
 */
export function authorMatches(
  bookAuthors: string[],
  targetAuthor: string | undefined
): boolean {
  if (!targetAuthor) return false;

  const targetNorm = normalizeQuery(targetAuthor);
  const targetTokens = new Set(tokenize(targetAuthor));

  for (const author of bookAuthors) {
    const authorNorm = normalizeQuery(author);

    // Exact match
    if (authorNorm === targetNorm) return true;

    // High similarity
    if (stringSimilarity(authorNorm, targetNorm) > 0.8) return true;

    // Token overlap (for "firstname lastname" vs "lastname, firstname")
    const authorTokens = new Set(tokenize(author));
    const overlap = [...targetTokens].filter((t) => authorTokens.has(t));
    if (overlap.length >= 2 || overlap.length / targetTokens.size > 0.7) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Match Scoring
// ============================================================================

/**
 * Compute raw match signals for a book against query evidence.
 */
export function computeMatchSignals(
  book: ResolvedBook,
  query: QueryCandidate,
  queryIsbns: string[],
  resultRank: number
): MatchSignals {
  // Title similarity
  const titleSimilarity = query.titleHint
    ? stringSimilarity(book.title, query.titleHint)
    : stringSimilarity(book.title, query.query);

  // Author presence
  const authorPresence = query.authorHint
    ? authorMatches(book.authors, query.authorHint)
      ? 1.0
      : 0.0
    : 0.5; // Neutral if no author hint

  // ISBN match (binary)
  let isbnMatch = 0.0;
  if (queryIsbns.length > 0) {
    const matched = queryIsbns.some((queryIsbn) =>
      book.isbn13 === queryIsbn || book.isbn10 === queryIsbn
    );
    if (matched) isbnMatch = 1.0;
  }

  // Word coverage
  const queryTokens = tokenize(query.query);
  const bookTokens = new Set([
    ...tokenize(book.title),
    ...book.authors.flatMap(tokenize),
  ]);
  const coveredTokens = queryTokens.filter((t) => bookTokens.has(t));
  const wordCoverage =
    queryTokens.length > 0 ? coveredTokens.length / queryTokens.length : 0;

  // Result rank penalty (higher rank = lower score)
  const rankScore = Math.max(0, 1 - resultRank * 0.1);

  // Generic penalty (common/generic titles)
  const genericPenalty = isGenericTitle(book.title) ? 0.15 : 0;

  return {
    titleSimilarity,
    authorPresence,
    isbnMatch,
    wordCoverage,
    resultRank: rankScore,
    genericPenalty,
  };
}

/**
 * Check if a title is too generic.
 */
function isGenericTitle(title: string): boolean {
  const genericPatterns = [
    /^the book$/i,
    /^untitled$/i,
    /^novel$/i,
    /^stories$/i,
    /^collection$/i,
  ];
  const norm = normalizeQuery(title);
  return genericPatterns.some((p) => p.test(norm)) || norm.length < 3;
}

/**
 * Normalize signals to [0, 1] range.
 */
export function normalizeSignals(signals: MatchSignals): NormalizedSignals {
  return {
    titleSimilarity: Math.min(1, Math.max(0, signals.titleSimilarity)),
    authorPresence: Math.min(1, Math.max(0, signals.authorPresence)),
    isbnMatch: Math.min(1, Math.max(0, signals.isbnMatch)),
    wordCoverage: Math.min(1, Math.max(0, signals.wordCoverage)),
    resultRank: Math.min(1, Math.max(0, signals.resultRank)),
    genericPenalty: Math.min(1, Math.max(0, signals.genericPenalty)),
  };
}

/**
 * Compute composite score from normalized signals.
 */
export function computeComposite(normalized: NormalizedSignals): number {
  const weighted =
    normalized.titleSimilarity * SCORING_WEIGHTS.titleSimilarity +
    normalized.authorPresence * SCORING_WEIGHTS.authorPresence +
    normalized.isbnMatch * SCORING_WEIGHTS.isbnMatch +
    normalized.wordCoverage * SCORING_WEIGHTS.wordCoverage +
    normalized.resultRank * SCORING_WEIGHTS.resultRank -
    normalized.genericPenalty * SCORING_WEIGHTS.genericPenalty;

  return Math.min(1, Math.max(0, weighted));
}

/**
 * Compute full match score for a book.
 */
export function computeMatchScore(
  book: ResolvedBook,
  query: QueryCandidate,
  queryIsbns: string[],
  resultRank: number
): MatchScore {
  const signals = computeMatchSignals(book, query, queryIsbns, resultRank);
  const normalizedSignals = normalizeSignals(signals);
  const composite = computeComposite(normalizedSignals);

  return {
    composite,
    signals,
    normalizedSignals,
  };
}

// ============================================================================
// Match Verification
// ============================================================================

/**
 * Verify a match and return flags for issues found.
 */
export function verifyMatch(
  book: ResolvedBook,
  query: QueryCandidate,
  queryIsbns: string[],
  evidenceTokens: string[]
): VerificationFlag[] {
  const flags: VerificationFlag[] = [];

  // ISBN mismatch check
  const bookIsbns = [book.isbn13, book.isbn10].filter(
    (isbn): isbn is string => Boolean(isbn)
  );
  const hasQueryIsbns = queryIsbns.length > 0;
  const hasBookIsbns = bookIsbns.length > 0;
  const hasIsbnMatch =
    hasQueryIsbns &&
    hasBookIsbns &&
    queryIsbns.some((queryIsbn) => bookIsbns.includes(queryIsbn));

  if (hasQueryIsbns && hasBookIsbns && !hasIsbnMatch) {
    flags.push({
      flag: 'isbn-mismatch',
      severity: 'error',
      message: `ISBN mismatch: expected one of [${queryIsbns.join(', ')}], got [${bookIsbns.join(', ')}]`,
      penalty: VERIFICATION_PENALTIES['isbn-mismatch'],
    });
  }

  // Author mismatch check
  if (query.authorHint && !authorMatches(book.authors, query.authorHint)) {
    flags.push({
      flag: 'author-mismatch',
      severity: 'warning',
      message: `Author "${query.authorHint}" not found in [${book.authors.join(', ')}]`,
      penalty: VERIFICATION_PENALTIES['author-mismatch'],
    });
  }

  // Token coverage check
  const bookTokens = new Set([
    ...tokenize(book.title),
    ...book.authors.flatMap(tokenize),
  ]);
  const covered = evidenceTokens.filter((t) => bookTokens.has(t));
  const coverage =
    evidenceTokens.length > 0 ? covered.length / evidenceTokens.length : 0;

  if (coverage < 0.4) {
    flags.push({
      flag: 'token-coverage-low',
      severity: 'warning',
      message: `Low token coverage: ${Math.round(coverage * 100)}%`,
      penalty: VERIFICATION_PENALTIES['token-coverage-low'],
    });
  }

  // Suspicious edition check
  const suspiciousEditions = ['abridged', 'condensed', 'adapted', 'simplified'];
  if (
    book.edition &&
    suspiciousEditions.some((s) =>
      book.edition!.toLowerCase().includes(s)
    )
  ) {
    flags.push({
      flag: 'suspicious-edition',
      severity: 'info',
      message: `Suspicious edition: ${book.edition}`,
      penalty: VERIFICATION_PENALTIES['suspicious-edition'],
    });
  }

  // Year plausibility check
  const currentYear = new Date().getFullYear();
  if (book.publishYear) {
    if (book.publishYear < 1400 || book.publishYear > currentYear + 1) {
      flags.push({
        flag: 'year-implausible',
        severity: 'warning',
        message: `Implausible year: ${book.publishYear}`,
        penalty: VERIFICATION_PENALTIES['year-implausible'],
      });
    }
  }

  return flags;
}

/**
 * Apply verification penalties to a score.
 */
export function applyVerificationPenalties(
  score: number,
  flags: VerificationFlag[]
): number {
  const totalPenalty = flags.reduce((sum, f) => sum + f.penalty, 0);
  return Math.max(0, score - totalPenalty);
}

// ============================================================================
// Acceptance Decision
// ============================================================================

/**
 * Check if top match dominates second match.
 */
export function isDominated(topScore: number, secondScore: number): boolean {
  const gap = topScore - secondScore;
  return gap >= 0.15; // Dominance gap threshold
}

/**
 * Make acceptance decision based on scores and tier.
 */
export function makeAcceptanceDecision(
  scoredMatches: ScoredMatch[],
  evidenceTier: EvidenceTier,
  verificationFlags: VerificationFlag[]
): AcceptanceDecision {
  const thresholds = ACCEPTANCE_THRESHOLDS[evidenceTier];

  // No matches
  if (scoredMatches.length === 0) {
    return {
      type: 'no-match',
      reason: 'No matching books found',
      fallbackToOcr: true,
    };
  }

  const topMatch = scoredMatches[0];
  const secondMatch = scoredMatches[1];

  // Apply verification penalties
  const adjustedScore = applyVerificationPenalties(
    topMatch.score.composite,
    verificationFlags
  );

  // Check for severe verification errors
  const hasError = verificationFlags.some((f) => f.severity === 'error');
  if (hasError) {
    return {
      type: 'ambiguous',
      candidates: scoredMatches.slice(0, 4).map((m) => m.book),
      reason: 'Verification error detected',
    };
  }

  // Check dominance
  const secondScore = secondMatch?.score.composite ?? 0;
  const dominated = isDominated(adjustedScore, secondScore);

  // Auto-accept: high score AND dominated
  if (adjustedScore >= thresholds.autoAccept && dominated) {
    return {
      type: 'auto-accept',
      book: topMatch.book,
      confidence: adjustedScore,
      reason: `High confidence match (${Math.round(adjustedScore * 100)}%)`,
    };
  }

  // Suggest: good score but needs confirmation
  if (adjustedScore >= thresholds.suggest) {
    return {
      type: 'suggest',
      book: topMatch.book,
      confidence: adjustedScore,
      alternatives: scoredMatches.slice(1, 4).map((m) => m.book),
      reason: dominated
        ? 'Good match, please confirm'
        : 'Multiple viable options',
    };
  }

  // Ambiguous: moderate score with multiple options
  if (adjustedScore >= thresholds.ambiguous) {
    return {
      type: 'ambiguous',
      candidates: scoredMatches.slice(0, 4).map((m) => m.book),
      reason: 'Multiple possible matches',
    };
  }

  // No match: score too low
  return {
    type: 'no-match',
    reason: `Best match score (${Math.round(adjustedScore * 100)}%) below threshold`,
    fallbackToOcr: true,
  };
}

// ============================================================================
// Cache Utilities
// ============================================================================

/**
 * Get default cache TTL (7 days).
 */
export function getDefaultCacheTtl(): Date {
  const ttl = new Date();
  ttl.setDate(ttl.getDate() + 7);
  return ttl;
}
