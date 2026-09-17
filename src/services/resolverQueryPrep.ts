/**
 * Resolver Query Preparation Service
 *
 * Prepares sanitized query inputs for the resolver from extracted title/author.
 * Design principles:
 * - Remove badge/imprint/price fragments from query inputs
 * - Never include author tokens inside queryTitle
 * - Query when either title OR author exists (no early reject blocking lookup)
 * - Sanitization is search-only; does not rewrite displayed fields
 */

import {
  normalizeForMatch,
  tokens,
  isOrgLikeLine,
  isPersonLikeLine,
  isTitleBridgeStopword,
} from './lineClassification';

import {
  splitInlineTitleAuthor,
  cleanupPossessiveNoise,
  PUBLISHER_BLOCKLIST,
  MARKETING_BLOCKLIST,
} from './titleAuthorExtraction';

// ============================================================================
// Types
// ============================================================================

export interface ResolverQueryInputs {
  /** Sanitized title for search (may differ from extracted title) */
  queryTitle: string | null;
  /** Sanitized author for search (may differ from extracted author) */
  queryAuthor: string | null;
  /** Whether query should be attempted */
  shouldQuery: boolean;
  /** Debug info */
  debug: {
    /** Original extracted title */
    originalTitle: string | null;
    /** Original extracted author */
    originalAuthor: string | null;
    /** Tokens removed from title */
    removedTitleTokens: string[];
    /** Tokens removed from author */
    removedAuthorTokens: string[];
    /** Whether inline split was performed for query */
    didInlineSplitForQuery: boolean;
    /** Reason for any modifications */
    sanitizationReasons: string[];
  };
}

// ============================================================================
// Token Filtering
// ============================================================================

/**
 * Tokens that should be removed from queries (noise)
 */
const QUERY_NOISE_TOKENS = new Set([
  'BESTSELLER', 'BESTSELLING', 'NYT', 'AUTHOR',
  'NOVEL', 'FICTION', 'EDITION', 'PAPERBACK', 'HARDCOVER',
  'MASS', 'MARKET', 'TRADE', 'NEW', 'REVISED', 'UPDATED',
  'SPECIAL', 'DELUXE', 'ANNIVERSARY', 'COLLECTORS',
  'ILLUSTRATED', 'COMPLETE', 'DEFINITIVE', 'ULTIMATE',
  'STER', // OCR noise from "bestseller"
]);

/**
 * Remove noise tokens from a token list
 */
function filterNoiseTokens(toks: string[]): { filtered: string[]; removed: string[] } {
  const filtered: string[] = [];
  const removed: string[] = [];

  for (const tok of toks) {
    const normTok = normalizeForMatch(tok);
    const origUpper = tok.toUpperCase();

    // Skip noise tokens
    if (QUERY_NOISE_TOKENS.has(normTok) || QUERY_NOISE_TOKENS.has(origUpper)) {
      removed.push(tok);
      continue;
    }

    // Skip publisher tokens
    if (PUBLISHER_BLOCKLIST.has(normTok.toLowerCase()) || PUBLISHER_BLOCKLIST.has(tok.toLowerCase())) {
      removed.push(tok);
      continue;
    }

    // Skip single-char tokens
    if (normTok.length <= 1) {
      removed.push(tok);
      continue;
    }

    // Skip numeric-only tokens (prices, etc)
    if (/^\d+$/.test(normTok)) {
      removed.push(tok);
      continue;
    }

    // Skip price-like tokens (contain currency symbol or look like prices)
    if (/[\$£€¥]/.test(tok) || /^\d+\.\d{2}$/.test(tok)) {
      removed.push(tok);
      continue;
    }

    // Skip very short non-alpha tokens
    if (normTok.length <= 3 && !/^[A-Z]+$/.test(normTok)) {
      removed.push(tok);
      continue;
    }

    filtered.push(tok);
  }

  return { filtered, removed };
}

/**
 * Remove marketing phrase fragments from text
 */
function removeMarketingFragments(text: string): string {
  let result = text;

  for (const phrase of MARKETING_BLOCKLIST) {
    // Case-insensitive removal
    const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(regex, ' ');
  }

  // Collapse whitespace
  return result.replace(/\s+/g, ' ').trim();
}

// ============================================================================
// Title Sanitization
// ============================================================================

/**
 * Sanitize title for search query
 *
 * - Remove badge/marketing fragments
 * - Remove publisher tokens
 * - If title contains embedded author (inline collapse), split for query
 * - Remove price-like suffixes
 */
export function sanitizeTitleForQuery(
  title: string | null,
  currentAuthor: string | null
): { sanitized: string | null; extractedAuthor: string | null; reasons: string[]; removedTokens: string[] } {
  if (!title) {
    return { sanitized: null, extractedAuthor: null, reasons: ['no_title'], removedTokens: [] };
  }

  const reasons: string[] = [];
  let sanitized = title.trim();
  let extractedAuthor: string | null = null;

  // Step 1: Remove marketing fragments
  const beforeMarketing = sanitized;
  sanitized = removeMarketingFragments(sanitized);
  if (sanitized !== beforeMarketing) {
    reasons.push('removed_marketing_fragments');
  }

  // Step 2: Check for inline title/author collapse
  // Only if we don't already have a strong author
  if (!currentAuthor || currentAuthor.trim().length < 4) {
    const splitResult = splitInlineTitleAuthor(sanitized);
    if (splitResult.didSplit && splitResult.title && splitResult.confidence >= 0.6) {
      sanitized = splitResult.title;
      extractedAuthor = splitResult.author;
      reasons.push(`inline_split:${splitResult.reason}`);
    }
  }

  // Step 3: Remove author tokens from title if we have an author
  const authorToCheck = extractedAuthor || currentAuthor;
  if (authorToCheck) {
    const authorToks = new Set(tokens(authorToCheck));
    const titleToks = tokens(sanitized);

    // Only remove if there's significant overlap at the end (embedded author)
    if (titleToks.length >= 3) {
      const lastTwo = titleToks.slice(-2);
      const overlap = lastTwo.filter(t => authorToks.has(t)).length;
      if (overlap >= 2) {
        // Remove author tokens from end of title
        sanitized = titleToks.slice(0, -2).join(' ');
        reasons.push('removed_trailing_author_tokens');
      }
    }
  }

  // Step 4: Filter noise tokens
  const titleToks = sanitized.split(/\s+/).filter(t => t.length > 0);
  const { filtered, removed } = filterNoiseTokens(titleToks);

  if (removed.length > 0) {
    reasons.push('filtered_noise_tokens');
  }

  // Reconstruct sanitized title
  sanitized = filtered.join(' ').trim();

  // Step 5: Final cleanup
  sanitized = cleanupPossessiveNoise(sanitized);

  if (!sanitized || sanitized.length < 2) {
    return { sanitized: null, extractedAuthor, reasons: [...reasons, 'too_short_after_sanitization'], removedTokens: removed };
  }

  return { sanitized, extractedAuthor, reasons, removedTokens: removed };
}

// ============================================================================
// Author Sanitization
// ============================================================================

/**
 * Sanitize author for search query
 *
 * - Remove org markers
 * - Remove marketing tokens
 * - Clean up OCR artifacts
 */
export function sanitizeAuthorForQuery(
  author: string | null
): { sanitized: string | null; reasons: string[]; removedTokens: string[] } {
  if (!author) {
    return { sanitized: null, reasons: ['no_author'], removedTokens: [] };
  }

  const reasons: string[] = [];
  let sanitized = author.trim();

  // Step 1: Remove marketing fragments
  const beforeMarketing = sanitized;
  sanitized = removeMarketingFragments(sanitized);
  if (sanitized !== beforeMarketing) {
    reasons.push('removed_marketing_fragments');
  }

  // Step 2: Check for org-like content (penalty but don't fully reject)
  if (isOrgLikeLine(sanitized)) {
    // Try to extract person-like portion
    const toks = sanitized.split(/\s+/);
    const personToks = toks.filter(t => !isOrgLikeLine(t) && t.length >= 2);
    if (personToks.length >= 2) {
      sanitized = personToks.join(' ');
      reasons.push('extracted_person_from_org');
    } else {
      // If too org-like, reduce confidence
      reasons.push('org_like_warning');
    }
  }

  // Step 3: Filter noise tokens
  const authorToks = sanitized.split(/\s+/).filter(t => t.length > 0);
  const { filtered, removed } = filterNoiseTokens(authorToks);

  if (removed.length > 0) {
    reasons.push('filtered_noise_tokens');
  }

  sanitized = filtered.join(' ').trim();

  // Step 4: Clean up OCR artifacts
  sanitized = cleanupPossessiveNoise(sanitized);

  if (!sanitized || sanitized.length < 3) {
    return { sanitized: null, reasons: [...reasons, 'too_short_after_sanitization'], removedTokens: removed };
  }

  // Step 5: Validate looks like a person name
  if (!isPersonLikeLine(sanitized)) {
    reasons.push('not_person_like_warning');
  }

  return { sanitized, reasons, removedTokens: removed };
}

// ============================================================================
// Main Query Preparation
// ============================================================================

/**
 * Prepare resolver query inputs from extracted title/author
 *
 * This is the main entry point for query preparation.
 * Implements search-only sanitization that does not modify displayed fields.
 */
export function prepareResolverQuery(
  extractedTitle: string | null,
  extractedAuthor: string | null
): ResolverQueryInputs {
  const result: ResolverQueryInputs = {
    queryTitle: null,
    queryAuthor: null,
    shouldQuery: false,
    debug: {
      originalTitle: extractedTitle,
      originalAuthor: extractedAuthor,
      removedTitleTokens: [],
      removedAuthorTokens: [],
      didInlineSplitForQuery: false,
      sanitizationReasons: [],
    },
  };

  // Sanitize title
  const titleResult = sanitizeTitleForQuery(extractedTitle, extractedAuthor);
  result.queryTitle = titleResult.sanitized;
  result.debug.removedTitleTokens = titleResult.removedTokens;
  result.debug.sanitizationReasons.push(...titleResult.reasons.map(r => `title:${r}`));

  // Handle extracted author from title split
  if (titleResult.extractedAuthor) {
    result.debug.didInlineSplitForQuery = true;
    // Use extracted author if we don't have one or it's weak
    if (!extractedAuthor || extractedAuthor.length < titleResult.extractedAuthor.length) {
      extractedAuthor = titleResult.extractedAuthor;
    }
  }

  // Sanitize author
  const authorResult = sanitizeAuthorForQuery(extractedAuthor);
  result.queryAuthor = authorResult.sanitized;
  result.debug.removedAuthorTokens = authorResult.removedTokens;
  result.debug.sanitizationReasons.push(...authorResult.reasons.map(r => `author:${r}`));

  // Determine if we should query
  // Query when EITHER title OR author exists
  result.shouldQuery = !!(result.queryTitle || result.queryAuthor);

  return result;
}

// ============================================================================
// Query String Building
// ============================================================================

/**
 * Build a search query string from title and author
 */
export function buildQueryString(
  queryTitle: string | null,
  queryAuthor: string | null
): string {
  const parts: string[] = [];

  if (queryTitle) {
    parts.push(queryTitle);
  }

  if (queryAuthor) {
    parts.push(queryAuthor);
  }

  return parts.join(' ').trim();
}

/**
 * Build multiple query variations for fallback searching
 *
 * Includes "drop one token" variations to handle OCR errors.
 * If a single token is corrupted (e.g., "STRAIGHI" instead of "STRAIGHT"),
 * dropping it from the query may still find the correct book.
 */
export function buildQueryVariations(
  queryTitle: string | null,
  queryAuthor: string | null
): string[] {
  const variations: string[] = [];

  // Primary: title + author
  if (queryTitle && queryAuthor) {
    variations.push(`${queryTitle} ${queryAuthor}`);
  }

  // Title only
  if (queryTitle) {
    variations.push(queryTitle);

    // Title without leading article
    const titleToks = queryTitle.split(/\s+/);
    if (titleToks.length > 1 && isTitleBridgeStopword(titleToks[0])) {
      variations.push(titleToks.slice(1).join(' '));
    }

    // OCR error tolerance: drop each title token one at a time
    // This helps when one word has severe OCR corruption
    if (titleToks.length >= 3) {
      for (let i = 0; i < titleToks.length; i++) {
        const withoutToken = [...titleToks.slice(0, i), ...titleToks.slice(i + 1)].join(' ');
        if (withoutToken.length >= 5) {
          if (queryAuthor) {
            variations.push(`${withoutToken} ${queryAuthor}`);
          } else {
            variations.push(withoutToken);
          }
        }
      }
    }
  }

  // Author only
  if (queryAuthor) {
    variations.push(queryAuthor);
  }

  // Author + title (reverse order)
  if (queryTitle && queryAuthor) {
    variations.push(`${queryAuthor} ${queryTitle}`);
  }

  // Deduplicate
  return [...new Set(variations)];
}
