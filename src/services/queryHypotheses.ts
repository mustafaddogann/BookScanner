/**
 * Query Hypotheses Service
 *
 * Generates ordered search query hypotheses from OCR evidence.
 * These hypotheses are used to search Open Library and find the best match.
 *
 * The key insight is that OCR field extraction (title/author assignment) is often
 * wrong, but the raw text lines themselves are usually correct. This service
 * generates multiple query variations from the evidence to maximize the chance
 * of finding the correct book.
 */

import type { EvidenceTier } from '../types';
import {
  buildEvidenceTokens,
  stripLeadingArticle,
  normalizeForScoring,
  type EvidenceTokens,
} from './evidenceNormalization';
import {
  PASS1_MAX_HYPOTHESES,
  PASS2_MAX_HYPOTHESES,
  MIN_QUERY_LENGTH,
  MAX_QUERY_TOKENS,
  BOOST_MAX_NGRAM_SIZE,
  BOOST_TOP_TOKENS_COUNT,
} from '../config/metadataResolutionConfig';

// ============================================================================
// Types
// ============================================================================

/**
 * A search hypothesis with metadata
 */
export interface SearchHypothesis {
  /** The query string to search */
  query: string;
  /** Hypothesis type for debugging */
  type: HypothesisType;
  /** Priority (lower = try first) */
  priority: number;
  /** Explanation for debugging */
  explanation: string;
}

export type HypothesisType =
  | 'isbn'           // Direct ISBN search
  | 'title_author'   // Title + author combination
  | 'author_title'   // Author + title combination
  | 'title_only'     // Just title
  | 'author_only'    // Just author
  | 'longest_line'   // Longest non-junk line
  | 'combined_lines' // Multiple lines combined
  | 'stripped'       // Article-stripped variant
  | 'fallback'       // OCR field fallback
  // Boost pass types
  | 'boost_combo'    // Combined substantive lines
  | 'boost_tokens'   // Top N unique tokens
  | 'boost_ngram'    // N-gram sliding window
  | 'boost_partial'; // Partial line match

/**
 * Result of hypothesis generation
 */
export interface HypothesisGenerationResult {
  /** Ordered hypotheses to try */
  hypotheses: SearchHypothesis[];
  /** Debug info */
  debug: {
    inputLineCount: number;
    cleanedLineCount: number;
    tokenCount: number;
    personNames: string[];
    titleLikeLines: string[];
    isbns: string[];
  };
}

export interface HypothesisDebugContext {
  candidateId?: string;
  evidenceTier?: EvidenceTier;
}

// ============================================================================
// Configuration (imported from metadataResolutionConfig)
// ============================================================================

/** Re-export for backwards compatibility */
export const MAX_HYPOTHESES = PASS1_MAX_HYPOTHESES;

// ============================================================================
// Hypothesis Generation
// ============================================================================

/**
 * Generate search hypotheses from evidence lines
 *
 * @param evidenceLines - Raw text lines from merged OCR evidence
 * @param ocrTitle - OCR-extracted title (may be wrong, used as fallback)
 * @param ocrAuthor - OCR-extracted author (may be wrong, used as fallback)
 * @returns Ordered list of search hypotheses
 */
export function generateHypotheses(
  evidenceLines: string[],
  ocrTitle?: string | null,
  ocrAuthor?: string | null,
  debugContext?: HypothesisDebugContext
): HypothesisGenerationResult {
  const hypotheses: SearchHypothesis[] = [];
  const usedQueries = new Set<string>();

  // Build evidence tokens
  const evidence = buildEvidenceTokens(evidenceLines);

  // Helper to add hypothesis if not duplicate
  // Also enforces token count bounds (2-7 tokens for effective Open Library search)
  const addHypothesis = (
    query: string,
    type: HypothesisType,
    priority: number,
    explanation: string
  ) => {
    let trimmed = query.trim();
    const normalized = trimmed.toLowerCase();

    // Skip if too short
    if (normalized.length < MIN_QUERY_LENGTH) return;

    // Skip duplicates
    if (usedQueries.has(normalized)) return;

    // Trim to max tokens if needed (except ISBN)
    if (type !== 'isbn') {
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      if (tokens.length > MAX_QUERY_TOKENS) {
        trimmed = tokens.slice(0, MAX_QUERY_TOKENS).join(' ');
      }
    }

    usedQueries.add(normalized);
    hypotheses.push({ query: trimmed, type, priority, explanation });
  };

  // =========================================================================
  // Priority Strategy (max 5 hypotheses):
  // 1. ISBN (if found)
  // 2. title + author (best disambiguation)
  // 3. title-only (longest substantive line)
  // 4. author-only (if detected)
  // 5. stripped variant (remove leading article / noise)
  //
  // Only fall back to OCR fields if evidence doesn't yield enough.
  // =========================================================================

  const sortedByLength = [...evidence.candidatePhrases].sort(
    (a, b) => b.length - a.length
  );

  let bestTitle: string | null = null;
  let bestAuthor: string | null = null;

  if (evidence.titleLikeLines.length > 0) {
    bestTitle = evidence.titleLikeLines[0];
  } else if (sortedByLength.length > 0) {
    bestTitle = sortedByLength[0];
  }

  if (evidence.personNameLines.length > 0) {
    bestAuthor = evidence.personNameLines[0];
  }

  // 1) ISBN
  if (evidence.isbns.length > 0) {
    const isbn = evidence.isbns[0];
    addHypothesis(isbn, 'isbn', 0, `ISBN extracted from evidence: ${isbn}`);
  }

  // 2) Title + Author
  if (bestTitle && bestAuthor) {
    addHypothesis(
      `${bestTitle} ${bestAuthor}`,
      'title_author',
      10,
      `Title "${bestTitle}" + author "${bestAuthor}"`
    );
  }

  // 3) Title-only (longest substantive line)
  if (bestTitle) {
    addHypothesis(
      bestTitle,
      'title_only',
      20,
      `Title-only: "${bestTitle}"`
    );
  }

  // 4) Author-only (if detected)
  if (bestAuthor) {
    addHypothesis(
      bestAuthor,
      'author_only',
      25,
      `Author-only: "${bestAuthor}"`
    );
  }

  // 5) Stripped variant
  const titleToStrip = bestTitle || (sortedByLength.length > 0 ? sortedByLength[0] : null);
  if (titleToStrip) {
    const stripped = stripLeadingArticle(titleToStrip);
    if (stripped !== titleToStrip && stripped.length >= MIN_QUERY_LENGTH) {
      if (bestAuthor) {
        addHypothesis(
          `${stripped} ${bestAuthor}`,
          'stripped',
          30,
          `Stripped "${stripped}" + author "${bestAuthor}"`
        );
      } else {
        addHypothesis(
          stripped,
          'stripped',
          31,
          `Stripped title: "${stripped}"`
        );
      }
    }
  }

  // If we still have fewer than 3 hypotheses, try combining lines
  if (hypotheses.length < 3 && sortedByLength.length >= 2) {
    addHypothesis(
      `${sortedByLength[0]} ${sortedByLength[1]}`,
      'combined_lines',
      40,
      `Combined lines: "${sortedByLength[0]}" + "${sortedByLength[1]}"`
    );
  }

  // If still sparse, try a normalized-token variant of the best title
  if (hypotheses.length < 3 && bestTitle) {
    const normalizedTokens = normalizeForScoring(bestTitle);
    if (normalizedTokens.length >= 2) {
      addHypothesis(
        normalizedTokens.join(' '),
        'stripped',
        45,
        `Normalized tokens: "${normalizedTokens.join(' ')}"`
      );
    }
  }

  // OCR field fallback (only if we have room and evidence was sparse)
  if (hypotheses.length < 3) {
    if (ocrTitle && ocrAuthor) {
      addHypothesis(
        `${ocrTitle} ${ocrAuthor}`,
        'fallback',
        50,
        `OCR fields fallback: title="${ocrTitle}" author="${ocrAuthor}"`
      );
    } else if (ocrTitle) {
      addHypothesis(
        ocrTitle,
        'fallback',
        51,
        `OCR title fallback: "${ocrTitle}"`
      );
    } else if (ocrAuthor) {
      addHypothesis(
        ocrAuthor,
        'fallback',
        52,
        `OCR author fallback: "${ocrAuthor}"`
      );
    }
  }

  // Sort by priority and limit
  hypotheses.sort((a, b) => a.priority - b.priority);
  const finalHypotheses = hypotheses.slice(0, MAX_HYPOTHESES);

  // Debug log: always log hypothesis count and shapes for observability
  const shapes = finalHypotheses.map((h) => h.type);
  const candidateId = debugContext?.candidateId ?? 'unknown';
  console.log(
    `[MetadataResolution] hypotheses_count=${finalHypotheses.length} shapes=[${shapes.join(',')}] candidateId=${candidateId}`
  );

  if (debugContext?.candidateId) {
    const preview = finalHypotheses.slice(0, 2).map((h) => h.query);
    console.log(
      `[Hypotheses] candidateId="${debugContext.candidateId}" tier=${debugContext.evidenceTier ?? 'unknown'} count=${finalHypotheses.length} first=${JSON.stringify(preview)}`
    );
  }

  return {
    hypotheses: finalHypotheses,
    debug: {
      inputLineCount: evidenceLines.length,
      cleanedLineCount: evidence.cleanedLines.length,
      tokenCount: evidence.tokensSet.size,
      personNames: evidence.personNameLines,
      titleLikeLines: evidence.titleLikeLines,
      isbns: evidence.isbns,
    },
  };
}

/**
 * Quick hypothesis generation for a simple title/author input
 */
export function generateSimpleHypotheses(
  title?: string | null,
  author?: string | null
): SearchHypothesis[] {
  const hypotheses: SearchHypothesis[] = [];

  if (title && author) {
    hypotheses.push({
      query: `${title} ${author}`,
      type: 'title_author',
      priority: 10,
      explanation: `Title + author: "${title}" + "${author}"`,
    });
    hypotheses.push({
      query: `${author} ${title}`,
      type: 'author_title',
      priority: 11,
      explanation: `Author + title: "${author}" + "${title}"`,
    });

    const stripped = stripLeadingArticle(title);
    if (stripped !== title) {
      hypotheses.push({
        query: `${stripped} ${author}`,
        type: 'stripped',
        priority: 15,
        explanation: `Stripped + author: "${stripped}" + "${author}"`,
      });
    }
  } else if (title) {
    hypotheses.push({
      query: title,
      type: 'title_only',
      priority: 20,
      explanation: `Title only: "${title}"`,
    });
  } else if (author) {
    hypotheses.push({
      query: author,
      type: 'author_only',
      priority: 25,
      explanation: `Author only: "${author}"`,
    });
  }

  return hypotheses;
}

// ============================================================================
// Boost Pass Hypothesis Generation
// ============================================================================

/**
 * Generate expanded hypotheses for boost pass (pass2)
 *
 * This is called when pass1 results in suggested or reject.
 * It generates additional hypothesis variations to maximize
 * the chance of finding a match.
 *
 * Strategies:
 * 1. Combined substantive lines (top 2 longest joined)
 * 2. Author-like + title-like detection combos
 * 3. Top N unique tokens as a query
 * 4. N-gram sliding windows (2-gram, 3-gram)
 * 5. Stripped variants removing common words
 *
 * @param evidenceLines - Raw text lines from merged OCR evidence
 * @param excludeQueries - Queries already tried in pass1 (to avoid duplicates)
 * @param ocrTitle - OCR-extracted title (fallback)
 * @param ocrAuthor - OCR-extracted author (fallback)
 * @returns Expanded hypotheses for boost pass
 */
export function generateBoostHypotheses(
  evidenceLines: string[],
  excludeQueries: Set<string>,
  ocrTitle?: string | null,
  ocrAuthor?: string | null,
  debugContext?: HypothesisDebugContext
): HypothesisGenerationResult {
  const hypotheses: SearchHypothesis[] = [];
  const usedQueries = new Set<string>(excludeQueries);

  // Build evidence tokens
  const evidence = buildEvidenceTokens(evidenceLines);

  // Helper to add hypothesis if not duplicate
  // Also enforces token count bounds (2-7 tokens for effective Open Library search)
  const addHypothesis = (
    query: string,
    type: HypothesisType,
    priority: number,
    explanation: string
  ) => {
    let trimmed = query.trim();
    const normalized = trimmed.toLowerCase();

    // Skip if too short
    if (normalized.length < MIN_QUERY_LENGTH) return;

    // Skip duplicates
    if (usedQueries.has(normalized)) return;

    // Trim to max tokens if needed
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length > MAX_QUERY_TOKENS) {
      trimmed = tokens.slice(0, MAX_QUERY_TOKENS).join(' ');
    }

    usedQueries.add(normalized);
    hypotheses.push({ query: trimmed, type, priority, explanation });
  };

  // Sort candidate phrases by length (descending)
  const sortedByLength = [...evidence.candidatePhrases].sort(
    (a, b) => b.length - a.length
  );

  // =========================================================================
  // Strategy 1: Combined substantive lines (top 2-3 joined)
  // =========================================================================
  if (sortedByLength.length >= 2) {
    const top2 = `${sortedByLength[0]} ${sortedByLength[1]}`;
    addHypothesis(top2, 'boost_combo', 100, `Top 2 lines: "${sortedByLength[0]}" + "${sortedByLength[1]}"`);

    // Reverse order
    const top2Rev = `${sortedByLength[1]} ${sortedByLength[0]}`;
    addHypothesis(top2Rev, 'boost_combo', 101, `Top 2 reversed: "${sortedByLength[1]}" + "${sortedByLength[0]}"`);
  }

  if (sortedByLength.length >= 3) {
    const top3 = `${sortedByLength[0]} ${sortedByLength[1]} ${sortedByLength[2]}`;
    addHypothesis(top3, 'boost_combo', 102, `Top 3 lines combined`);
  }

  // =========================================================================
  // Strategy 2: Author-like + title-like detection combos
  // =========================================================================
  // Try all combinations of title-like and person-name lines
  for (const titleLine of evidence.titleLikeLines.slice(0, 2)) {
    for (const authorLine of evidence.personNameLines.slice(0, 2)) {
      addHypothesis(
        `${titleLine} ${authorLine}`,
        'boost_combo',
        110,
        `Title "${titleLine}" + author "${authorLine}"`
      );
    }
  }

  // =========================================================================
  // Strategy 3: Top N unique tokens as a query
  // =========================================================================
  const allTokens = Array.from(evidence.tokensSet);
  if (allTokens.length >= 3) {
    // Sort by frequency (most common first) then take top N
    const sortedTokens = allTokens
      .map((t) => ({ token: t, count: evidence.tokenCounts.get(t) || 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, BOOST_TOP_TOKENS_COUNT)
      .map((t) => t.token);

    const tokenQuery = sortedTokens.join(' ');
    addHypothesis(tokenQuery, 'boost_tokens', 120, `Top ${sortedTokens.length} tokens: ${tokenQuery}`);
  }

  // =========================================================================
  // Strategy 4: N-gram sliding windows
  // =========================================================================
  // Generate 2-grams and 3-grams from token list
  if (allTokens.length >= 4) {
    const ngrams: string[] = [];

    // 2-grams
    for (let i = 0; i < Math.min(allTokens.length - 1, 6); i++) {
      ngrams.push(`${allTokens[i]} ${allTokens[i + 1]}`);
    }

    // 3-grams
    for (let i = 0; i < Math.min(allTokens.length - 2, 4); i++) {
      ngrams.push(`${allTokens[i]} ${allTokens[i + 1]} ${allTokens[i + 2]}`);
    }

    // Add unique n-grams as hypotheses (limit to 3)
    for (let i = 0; i < Math.min(ngrams.length, 3); i++) {
      addHypothesis(ngrams[i], 'boost_ngram', 130 + i, `N-gram: "${ngrams[i]}"`);
    }
  }

  // =========================================================================
  // Strategy 5: Stripped variants
  // =========================================================================
  // Strip common words from lines and try
  for (const line of sortedByLength.slice(0, 3)) {
    const stripped = stripLeadingArticle(line);
    if (stripped !== line && stripped.length >= MIN_QUERY_LENGTH) {
      addHypothesis(stripped, 'stripped', 140, `Stripped: "${stripped}"`);
    }

    // Also try with normalized scoring tokens (removes generic words)
    const tokens = normalizeForScoring(line);
    if (tokens.length >= 2) {
      const cleanQuery = tokens.join(' ');
      addHypothesis(cleanQuery, 'boost_partial', 145, `Normalized tokens: "${cleanQuery}"`);
    }
  }

  // =========================================================================
  // Strategy 6: Individual lines not yet tried
  // =========================================================================
  for (let i = 0; i < Math.min(evidence.candidatePhrases.length, 5); i++) {
    const phrase = evidence.candidatePhrases[i];
    addHypothesis(phrase, 'boost_partial', 150 + i, `Line ${i + 1}: "${phrase}"`);
  }

  // =========================================================================
  // Strategy 7: OCR field combinations (last resort)
  // =========================================================================
  if (ocrTitle) {
    addHypothesis(ocrTitle, 'fallback', 160, `OCR title: "${ocrTitle}"`);
    if (ocrAuthor) {
      addHypothesis(`${ocrTitle} ${ocrAuthor}`, 'fallback', 161, `OCR title+author`);
    }
  }
  if (ocrAuthor) {
    addHypothesis(ocrAuthor, 'fallback', 162, `OCR author: "${ocrAuthor}"`);
  }

  // Sort by priority and limit to PASS2_MAX_HYPOTHESES
  hypotheses.sort((a, b) => a.priority - b.priority);
  const finalHypotheses = hypotheses.slice(0, PASS2_MAX_HYPOTHESES);

  if (debugContext?.candidateId) {
    const preview = finalHypotheses.slice(0, 2).map((h) => h.query);
    console.log(
      `[HypothesesBoost] candidateId="${debugContext.candidateId}" tier=${debugContext.evidenceTier ?? 'unknown'} count=${finalHypotheses.length} first=${JSON.stringify(preview)}`
    );
  }

  return {
    hypotheses: finalHypotheses,
    debug: {
      inputLineCount: evidenceLines.length,
      cleanedLineCount: evidence.cleanedLines.length,
      tokenCount: evidence.tokensSet.size,
      personNames: evidence.personNameLines,
      titleLikeLines: evidence.titleLikeLines,
      isbns: evidence.isbns,
    },
  };
}

/**
 * Get the set of query strings from hypotheses (for deduplication)
 */
export function getQuerySet(hypotheses: SearchHypothesis[]): Set<string> {
  return new Set(hypotheses.map((h) => h.query.toLowerCase().trim()));
}
