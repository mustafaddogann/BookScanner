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
  const addHypothesis = (
    query: string,
    type: HypothesisType,
    priority: number,
    explanation: string
  ) => {
    const normalized = query.toLowerCase().trim();
    if (normalized.length >= MIN_QUERY_LENGTH && !usedQueries.has(normalized)) {
      usedQueries.add(normalized);
      hypotheses.push({ query: query.trim(), type, priority, explanation });
    }
  };

  // =========================================================================
  // Priority Strategy (max 5 hypotheses):
  // 1. ISBN (if found) - instant high-confidence match
  // 2. title + author combination - best for disambiguation
  // 3. author + title combination - alternate order
  // 4. Longest line alone - likely the title
  // 5. Article-stripped variant - handles "The X" vs "X"
  //
  // Only fall back to OCR fields if evidence doesn't yield enough
  // =========================================================================

  // =========================================================================
  // 1. ISBN hypotheses (highest priority - slot 1)
  // =========================================================================
  // Only take first ISBN (usually only one anyway)
  if (evidence.isbns.length > 0) {
    const isbn = evidence.isbns[0];
    addHypothesis(isbn, 'isbn', 0, `ISBN extracted from evidence: ${isbn}`);
  }

  // =========================================================================
  // 2. Title + Author combinations (slots 2-3)
  // =========================================================================
  let bestTitle: string | null = null;
  let bestAuthor: string | null = null;

  if (evidence.personNameLines.length > 0 && evidence.titleLikeLines.length > 0) {
    bestTitle = evidence.titleLikeLines[0];
    bestAuthor = evidence.personNameLines[0];
  } else if (evidence.candidatePhrases.length >= 2) {
    // If we can't clearly identify title vs author, use line ordering/length heuristics
    // Longer line is more likely title, shorter is more likely author (name)
    const sorted = [...evidence.candidatePhrases].sort((a, b) => b.length - a.length);
    bestTitle = sorted[0];
    bestAuthor = sorted[1];
  }

  if (bestTitle && bestAuthor) {
    addHypothesis(
      `${bestTitle} ${bestAuthor}`,
      'title_author',
      10,
      `Title-like "${bestTitle}" + author "${bestAuthor}"`
    );

    addHypothesis(
      `${bestAuthor} ${bestTitle}`,
      'author_title',
      11,
      `Author "${bestAuthor}" + title-like "${bestTitle}"`
    );
  }

  // =========================================================================
  // 3. Longest line hypothesis (slot 4)
  // =========================================================================
  const sortedByLength = [...evidence.candidatePhrases].sort(
    (a, b) => b.length - a.length
  );

  if (sortedByLength.length > 0) {
    const longest = sortedByLength[0];
    addHypothesis(
      longest,
      'longest_line',
      20,
      `Longest line: "${longest}"`
    );
  }

  // =========================================================================
  // 4. Article-stripped variant (slot 5)
  // =========================================================================
  // Strip article from the best title candidate
  const titleToStrip = bestTitle || (sortedByLength.length > 0 ? sortedByLength[0] : null);
  if (titleToStrip) {
    const stripped = stripLeadingArticle(titleToStrip);
    if (stripped !== titleToStrip && stripped.length >= MIN_QUERY_LENGTH) {
      if (bestAuthor) {
        addHypothesis(
          `${stripped} ${bestAuthor}`,
          'stripped',
          15,
          `Stripped "${stripped}" + author "${bestAuthor}"`
        );
      } else {
        addHypothesis(
          stripped,
          'stripped',
          25,
          `Stripped title: "${stripped}"`
        );
      }
    }
  }

  // =========================================================================
  // 5. OCR field fallback (only if we have room and evidence was sparse)
  // =========================================================================
  // Only use OCR fields as fallback if we have < 3 hypotheses from evidence
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
  const addHypothesis = (
    query: string,
    type: HypothesisType,
    priority: number,
    explanation: string
  ) => {
    const normalized = query.toLowerCase().trim();
    if (normalized.length >= MIN_QUERY_LENGTH && !usedQueries.has(normalized)) {
      usedQueries.add(normalized);
      hypotheses.push({ query: query.trim(), type, priority, explanation });
    }
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
