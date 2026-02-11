/**
 * Title Match Fallback Service
 *
 * Implements title-only author fallback when normal resolution returns REJECT.
 * Uses Open Library to find author when exact title match exists.
 *
 * Design principles:
 * - Only triggers when normal resolution yields REJECT / no match
 * - Requires EXACT title match after normalization (strict)
 * - Results in SUGGESTED (not ACCEPT) unless uniqueness proven
 * - Never overwrites strong OCR author with conflicting API author
 */

import type { ResolvedBook } from '../types';
import type { MetadataLookupProvider } from './metadataLookupProvider';
import { OpenLibraryProvider } from './openLibraryProvider';
import { GoogleBooksProvider } from './googleBooksProvider';
import { computeAuthorSimilarity, normalizeForApiComparison } from './ocrConfusionMatching';

// ============================================================================
// Title Normalization for Full Match
// ============================================================================

/**
 * Trivial stopwords to remove FOR COMPARISON ONLY
 * These are stripped when comparing normalized titles, not when displaying
 */
const TITLE_COMPARISON_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'and',
]);

/**
 * Normalize a title for full-match comparison
 * - Uppercase
 * - Strip punctuation to spaces
 * - Collapse whitespace
 * - Returns normalized string (stopwords NOT removed yet)
 */
export function normalizeTitle(title: string): string {
  if (!title) return '';

  return title
    .toUpperCase()
    .trim()
    // Replace punctuation with spaces
    .replace(/[^\w\s]/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get token set from normalized title (with stopwords removed)
 */
export function getTitleTokens(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  if (!normalized) return new Set();

  const tokens = normalized.split(/\s+/).filter(t => t.length > 0);
  // Remove stopwords
  return new Set(tokens.filter(t => !TITLE_COMPARISON_STOPWORDS.has(t.toLowerCase())));
}

/**
 * Check if two titles are a "full match"
 *
 * Full match means:
 * 1. Normalized titles are identical, OR
 * 2. Token sets (after stopword removal) are identical (strict 1.0 match)
 */
export function isTitleFullMatch(title1: string, title2: string): boolean {
  const norm1 = normalizeTitle(title1);
  const norm2 = normalizeTitle(title2);

  // Reject empty titles
  if (!norm1 || !norm2) return false;

  // Direct normalized match
  if (norm1 === norm2) return true;

  // Token set match (with stopwords removed)
  const tokens1 = getTitleTokens(title1);
  const tokens2 = getTitleTokens(title2);

  if (tokens1.size === 0 || tokens2.size === 0) return false;
  if (tokens1.size !== tokens2.size) return false;

  // Check if all tokens match
  for (const token of tokens1) {
    if (!tokens2.has(token)) return false;
  }
  return true;
}

// ============================================================================
// Fallback Result Types
// ============================================================================

/**
 * Result of title-only author fallback
 */
export interface TitleMatchFallbackResult {
  /** Whether fallback was triggered */
  triggered: boolean;
  /** Final decision (always 'suggest' or null if not triggered) */
  decision: 'suggest' | null;
  /** Suggested title (from API) */
  suggestedTitle: string | null;
  /** Suggested author (from API) */
  suggestedAuthor: string | null;
  /** Confidence score [0-1] */
  confidence: number;
  /** Reason for the result */
  reason: string;
  /** Debug info */
  debug: TitleMatchFallbackDebug;
}

/**
 * Debug info for title-match fallback
 */
export interface TitleMatchFallbackDebug {
  /** Query title used for search */
  queryTitle: string;
  /** Number of API results */
  apiResultCount: number;
  /** Number of full-match results */
  fullMatchCount: number;
  /** Chosen candidate (if any) */
  chosenCandidate: {
    title: string;
    authors: string[];
  } | null;
  /** Whether OCR author conflicted with API author */
  ocrAuthorConflicts: boolean;
  /** Original OCR author (if any) */
  ocrAuthor: string | null;
  /** All full-match candidates */
  fullMatchCandidates: Array<{
    title: string;
    authors: string[];
    score: number;
  }>;
}

// ============================================================================
// Fallback Implementation
// ============================================================================

/**
 * Score a full-match candidate for tie-breaking
 *
 * Tie-breakers:
 * 1. Has author populated (+0.3)
 * 2. Fewer title differences (+0.1)
 * 3. Has ISBN (+0.05)
 */
function scoreFallbackCandidate(candidate: ResolvedBook, queryTitle: string): number {
  let score = 0.5; // Base score

  // Has author populated
  if (candidate.authors && candidate.authors.length > 0 && candidate.authors[0]?.length > 0) {
    score += 0.3;
  }

  // Title similarity (fewer differences)
  const normQuery = normalizeTitle(queryTitle);
  const normCandidate = normalizeTitle(candidate.title);
  if (normQuery === normCandidate) {
    score += 0.1;
  }

  // Has ISBN
  if (candidate.isbn13 || candidate.isbn10) {
    score += 0.05;
  }

  return score;
}

/**
 * Check if OCR author conflicts with API author
 *
 * Conflict means:
 * - Both are person-like
 * - They are clearly different names (low similarity)
 */
function checkAuthorConflict(ocrAuthor: string | null, apiAuthors: string[]): boolean {
  if (!ocrAuthor || apiAuthors.length === 0) return false;

  // Check similarity against each API author
  for (const apiAuthor of apiAuthors) {
    const result = computeAuthorSimilarity(ocrAuthor, apiAuthor);
    if (result.isMatch) {
      return false; // No conflict - they match
    }
  }

  // Check if OCR author is person-like (2-4 tokens, mostly alpha)
  const ocrTokens = ocrAuthor.trim().split(/\s+/);
  if (ocrTokens.length >= 2 && ocrTokens.length <= 4) {
    const letterCount = (ocrAuthor.match(/[a-zA-Z]/g) || []).length;
    const totalChars = ocrAuthor.replace(/\s/g, '').length;
    if (totalChars > 0 && letterCount / totalChars >= 0.85) {
      return true; // Person-like OCR author that doesn't match API author
    }
  }

  return false;
}

/**
 * Execute title-only author fallback
 *
 * This runs when normal resolver returns REJECT and attempts to find
 * author by searching for exact title matches in Open Library.
 *
 * @param extractedTitle - Title from extraction
 * @param extractedAuthor - Author from extraction (may be null/weak)
 * @param provider - Open Library provider instance
 */
export async function executeTitleMatchFallback(
  extractedTitle: string | null,
  extractedAuthor: string | null,
  provider: OpenLibraryProvider
): Promise<TitleMatchFallbackResult> {
  const debug: TitleMatchFallbackDebug = {
    queryTitle: '',
    apiResultCount: 0,
    fullMatchCount: 0,
    chosenCandidate: null,
    ocrAuthorConflicts: false,
    ocrAuthor: extractedAuthor,
    fullMatchCandidates: [],
  };

  const result: TitleMatchFallbackResult = {
    triggered: false,
    decision: null,
    suggestedTitle: null,
    suggestedAuthor: null,
    confidence: 0,
    reason: 'not_triggered',
    debug,
  };

  // Need a title to search
  if (!extractedTitle || extractedTitle.trim().length < 2) {
    result.reason = 'no_title_for_fallback';
    return result;
  }

  // Sanitize query title
  const queryTitle = extractedTitle.trim();
  debug.queryTitle = queryTitle;

  console.log(`[TitleMatchFallback] Searching for title: "${queryTitle}"`);

  try {
    // Search Open Library by title
    const apiResults = await provider.searchByText(queryTitle);
    debug.apiResultCount = apiResults.length;

    if (apiResults.length === 0) {
      result.reason = 'no_api_results';
      console.log(`[TitleMatchFallback] No API results for: "${queryTitle}"`);
      return result;
    }

    // Filter to full-match results
    const fullMatchResults = apiResults.filter(book =>
      isTitleFullMatch(queryTitle, book.title)
    );
    debug.fullMatchCount = fullMatchResults.length;

    console.log(`[TitleMatchFallback] API results: ${apiResults.length}, full matches: ${fullMatchResults.length}`);

    if (fullMatchResults.length === 0) {
      result.reason = 'no_full_match_results';
      return result;
    }

    // Score and sort full-match candidates
    const scoredCandidates = fullMatchResults.map(book => ({
      book,
      score: scoreFallbackCandidate(book, queryTitle),
    })).sort((a, b) => b.score - a.score);

    // Populate debug with candidates
    debug.fullMatchCandidates = scoredCandidates.map(sc => ({
      title: sc.book.title,
      authors: sc.book.authors || [],
      score: sc.score,
    }));

    // Pick best candidate
    const best = scoredCandidates[0];
    if (!best) {
      result.reason = 'no_valid_candidate';
      return result;
    }

    // Check for author conflict
    const hasConflict = checkAuthorConflict(extractedAuthor, best.book.authors || []);
    debug.ocrAuthorConflicts = hasConflict;

    // Build result
    result.triggered = true;
    result.decision = 'suggest';
    result.suggestedTitle = best.book.title;
    result.suggestedAuthor = best.book.authors?.[0] ?? null;

    debug.chosenCandidate = {
      title: best.book.title,
      authors: best.book.authors || [],
    };

    // Determine confidence based on candidates and conflict
    if (fullMatchResults.length === 1) {
      // Single full match - higher confidence
      result.confidence = hasConflict ? 0.65 : 0.75;
      result.reason = 'title_full_match_author_fallback';
    } else {
      // Multiple full matches - lower confidence
      result.confidence = hasConflict ? 0.50 : 0.60;
      result.reason = 'title_full_match_multiple_candidates';
    }

    if (hasConflict) {
      result.reason += '_ocr_author_conflicts_api_author';
    }

    console.log(`[TitleMatchFallback] Fallback result: decision=${result.decision}, ` +
      `confidence=${result.confidence.toFixed(2)}, ` +
      `title="${result.suggestedTitle}", author="${result.suggestedAuthor}", ` +
      `reason=${result.reason}`);

    return result;

  } catch (error: any) {
    console.warn(`[TitleMatchFallback] Search error: ${error.message}`);
    result.reason = `fallback_search_error: ${error.message}`;
    return result;
  }
}

/**
 * Execute title-only fallback with multiple providers
 *
 * Tries Open Library first, then falls back to Google Books if no results.
 * This provides better coverage for books not in Open Library.
 *
 * @param extractedTitle - Title from extraction
 * @param extractedAuthor - Author from extraction (may be null/weak)
 */
export async function executeTitleMatchFallbackWithGoogleBooks(
  extractedTitle: string | null,
  extractedAuthor: string | null
): Promise<TitleMatchFallbackResult> {
  // Try Open Library first
  const openLibraryProvider = new OpenLibraryProvider();
  const openLibraryResult = await executeTitleMatchFallback(
    extractedTitle,
    extractedAuthor,
    openLibraryProvider
  );

  // If Open Library found a match, use it
  if (openLibraryResult.triggered && openLibraryResult.decision === 'suggest') {
    console.log('[TitleMatchFallback] Found match in Open Library');
    return openLibraryResult;
  }

  // If Open Library returned no results or no full matches, try Google Books
  if (
    openLibraryResult.reason === 'no_api_results' ||
    openLibraryResult.reason === 'no_full_match_results'
  ) {
    console.log('[TitleMatchFallback] Open Library had no results, trying Google Books...');

    try {
      const googleBooksResult = await executeTitleMatchFallbackWithProvider(
        extractedTitle,
        extractedAuthor,
        new GoogleBooksProvider()
      );

      if (googleBooksResult.triggered && googleBooksResult.decision === 'suggest') {
        console.log('[TitleMatchFallback] Found match in Google Books');
        // Update reason to indicate Google Books source
        googleBooksResult.reason = 'google_books_' + googleBooksResult.reason;
        return googleBooksResult;
      }
    } catch (error: any) {
      console.warn(`[TitleMatchFallback] Google Books fallback error: ${error.message}`);
    }
  }

  // Return Open Library result (which is the rejection reason)
  return openLibraryResult;
}

/**
 * Execute title-only fallback with a generic provider
 *
 * This is a generalized version that works with any MetadataLookupProvider.
 */
export async function executeTitleMatchFallbackWithProvider(
  extractedTitle: string | null,
  extractedAuthor: string | null,
  provider: MetadataLookupProvider
): Promise<TitleMatchFallbackResult> {
  const debug: TitleMatchFallbackDebug = {
    queryTitle: '',
    apiResultCount: 0,
    fullMatchCount: 0,
    chosenCandidate: null,
    ocrAuthorConflicts: false,
    ocrAuthor: extractedAuthor,
    fullMatchCandidates: [],
  };

  const result: TitleMatchFallbackResult = {
    triggered: false,
    decision: null,
    suggestedTitle: null,
    suggestedAuthor: null,
    confidence: 0,
    reason: 'not_triggered',
    debug,
  };

  // Need a title to search
  if (!extractedTitle || extractedTitle.trim().length < 2) {
    result.reason = 'no_title_for_fallback';
    return result;
  }

  // Sanitize query title
  const queryTitle = extractedTitle.trim();
  debug.queryTitle = queryTitle;

  console.log(`[TitleMatchFallback:${provider.name}] Searching for title: "${queryTitle}"`);

  try {
    // Search by title
    const apiResults = await provider.searchByText(queryTitle);
    debug.apiResultCount = apiResults.length;

    if (apiResults.length === 0) {
      result.reason = 'no_api_results';
      console.log(`[TitleMatchFallback:${provider.name}] No API results for: "${queryTitle}"`);
      return result;
    }

    // Filter to full-match results
    const fullMatchResults = apiResults.filter(book =>
      isTitleFullMatch(queryTitle, book.title)
    );
    debug.fullMatchCount = fullMatchResults.length;

    console.log(`[TitleMatchFallback:${provider.name}] API results: ${apiResults.length}, full matches: ${fullMatchResults.length}`);

    if (fullMatchResults.length === 0) {
      result.reason = 'no_full_match_results';
      return result;
    }

    // Score and sort full-match candidates
    const scoredCandidates = fullMatchResults.map(book => ({
      book,
      score: scoreFallbackCandidate(book, queryTitle),
    })).sort((a, b) => b.score - a.score);

    // Populate debug with candidates
    debug.fullMatchCandidates = scoredCandidates.map(sc => ({
      title: sc.book.title,
      authors: sc.book.authors || [],
      score: sc.score,
    }));

    // Pick best candidate
    const best = scoredCandidates[0];
    if (!best) {
      result.reason = 'no_valid_candidate';
      return result;
    }

    // Check for author conflict
    const hasConflict = checkAuthorConflict(extractedAuthor, best.book.authors || []);
    debug.ocrAuthorConflicts = hasConflict;

    // Build result
    result.triggered = true;
    result.decision = 'suggest';
    result.suggestedTitle = best.book.title;
    result.suggestedAuthor = best.book.authors?.[0] ?? null;

    debug.chosenCandidate = {
      title: best.book.title,
      authors: best.book.authors || [],
    };

    // Determine confidence based on candidates and conflict
    // Google Books results get slightly lower confidence since Open Library is primary
    const confidenceBonus = provider.name === 'openLibrary' ? 0 : -0.05;

    if (fullMatchResults.length === 1) {
      result.confidence = (hasConflict ? 0.65 : 0.75) + confidenceBonus;
      result.reason = 'title_full_match_author_fallback';
    } else {
      result.confidence = (hasConflict ? 0.50 : 0.60) + confidenceBonus;
      result.reason = 'title_full_match_multiple_candidates';
    }

    if (hasConflict) {
      result.reason += '_ocr_author_conflicts_api_author';
    }

    console.log(`[TitleMatchFallback:${provider.name}] Fallback result: decision=${result.decision}, ` +
      `confidence=${result.confidence.toFixed(2)}, ` +
      `title="${result.suggestedTitle}", author="${result.suggestedAuthor}", ` +
      `reason=${result.reason}`);

    return result;

  } catch (error: any) {
    console.warn(`[TitleMatchFallback:${provider.name}] Search error: ${error.message}`);
    result.reason = `fallback_search_error: ${error.message}`;
    return result;
  }
}

/**
 * Join authors array into display string
 */
export function joinAuthorsForDisplay(authors: string[] | undefined): string {
  if (!authors || authors.length === 0) return '';
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} and ${authors[1]}`;
  return authors.slice(0, -1).join(', ') + ', and ' + authors[authors.length - 1];
}
