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
  looksLikeTitle,
  looksLikePersonName,
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
  // Strategy 4j: Word splitting for merged OCR words
  // =========================================================================
  // Try splitting merged words at common boundaries
  const spanishPrefixes = ['UN', 'EN', 'EL', 'LA', 'DE', 'CON', 'POR', 'FOR', 'YOUR'];
  for (const line of sortedByLength.slice(0, 5)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    let splitVariants: string[] = [];
    
    for (const token of tokens) {
      if (token.length >= 6) {
        // Try splitting at 2-3 char prefixes
        for (const prefix of spanishPrefixes) {
          if (token.toUpperCase().startsWith(prefix) && token.length > prefix.length + 2) {
            const rest = token.substring(prefix.length);
            splitVariants.push(`${prefix} ${rest}`);
          }
        }
      }
    }
    
    for (const variant of splitVariants.slice(0, 2)) {
      addHypothesis(variant, 'boost_partial', 135, `Word split: "${variant}"`);
    }
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
  // Strategy 5j: OCR character confusion corrections for longer words
  // =========================================================================
  // Common OCR confusions: ONF→ONE, MUKDERS→MURDERS, etc.
  const ocrConfusions: Array<[RegExp, string]> = [
    [/\bONF\b/gi, 'ONE'],
    [/\bMUKDERS?\b/gi, 'MURDER'],
    [/\bHEAVI\b/gi, 'HEAVEN'],
    [/\bADV\b/gi, 'ADVENTURE'],
    [/\bONLI\b/gi, 'ONLY'],
    [/\bFIKST\b/gi, 'FIRST'],
  ];

  for (const line of sortedByLength.slice(0, 5)) {
    let corrected = line;
    for (const [pattern, replacement] of ocrConfusions) {
      corrected = corrected.replace(pattern, replacement);
    }
    if (corrected !== line) {
      addHypothesis(corrected, 'boost_partial', 138, `OCR confusion fix: "${corrected}"`);
    }
  }

  // =========================================================================
  // Strategy 5k: Character-level corrections for longer words (6+ chars)
  // =========================================================================
  // Try single-character substitutions on longer words
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    const correctedTokens: string[] = [];
    let madeChanges = false;

    for (const token of tokens) {
      if (token.length >= 6) {
        // Try common single-char OCR errors
        const variations = [
          token.replace(/F/g, 'E'),  // F→E common in OCR
          token.replace(/I/g, 'L'),  // I→L confusion
          token.replace(/N/g, 'M'),  // N→M confusion
        ];
        // Use first variation that differs
        const variant = variations.find(v => v !== token);
        if (variant) {
          correctedTokens.push(variant);
          madeChanges = true;
        } else {
          correctedTokens.push(token);
        }
      } else {
        correctedTokens.push(token);
      }
    }

    if (madeChanges) {
      const correctedLine = correctedTokens.join(' ');
      addHypothesis(correctedLine, 'boost_partial', 139, `Char correction: "${correctedLine}"`);
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
  // Strategy 5l: Truncated name completion
  // =========================================================================
  // Common author last name completions for truncated OCR
  const nameCompletions: Array<[RegExp, string]> = [
    [/\bMACDO(NALD)?\b/gi, 'MACDONALD'],
    [/\bSMIT(H)?\b/gi, 'SMITH'],
    [/\bJOHNS(ON)?\b/gi, 'JOHNSON'],
    [/\bBROW(N)?\b/gi, 'BROWN'],
    [/\bWILLI(AMS)?\b/gi, 'WILLIAMS'],
    [/\bDAVI(S)?\b/gi, 'DAVIS'],
    [/\bMILL(ER)?\b/gi, 'MILLER'],
    [/\bADV(ENTURE)?\b/gi, 'ADVENTURE'],
    [/\bFARGO?\b/gi, 'FARGO'],
    [/\bCLIV(E)?\b/gi, 'CLIVE'],
    [/\bCUSS(LER)?\b/gi, 'CUSSLER'],
    [/\bPATR(ICK)?\b/gi, 'PATRICK'],
    [/\bROBER(T)?\b/gi, 'ROBERT'],
    [/\bSTEP(HEN)?\b/gi, 'STEPHEN'],
    [/\bSTEV(EN)?\b/gi, 'STEVEN'],
    [/\bLAU(RA)?\b/gi, 'LAURA'],
    [/\bJOH\b(?!\s+\w)/gi, 'JOHN'],
    [/\bNGAI(O)?\b/gi, 'NGAIO'],
    [/\bMARS(H)?\b/gi, 'MARSH'],
    [/\bCHARLA(INE)?\b/gi, 'CHARLAINE'],
    [/\bHARR(IS)?\b/gi, 'HARRIS'],
    [/\bROWLA(ND)?\b/gi, 'ROWLAND'],
    [/\bDEAD?\b/gi, 'DEAD'],
    [/\bDEND\b/gi, 'DEAD'],
    [/\bMURD(ERS?)?\b/gi, 'MURDERS'],
    [/\bWOOL?\b/gi, 'WOOL'],
  ];

  for (const line of sortedByLength.slice(0, 5)) {
    let completed = line;
    for (const [pattern, replacement] of nameCompletions) {
      completed = completed.replace(pattern, replacement);
    }
    if (completed !== line) {
      addHypothesis(completed, 'boost_partial', 148, `Name completion: "${completed}"`);
    }
  }

  // =========================================================================
  // Strategy 5j2: Common OCR letter confusions
  // =========================================================================
  const letterConfusions: Array<[RegExp, string]> = [
    [/\bONF\b/gi, 'ONE'],
    [/\bMUKDERS\b/gi, 'MURDERS'],
    [/\bTHF\b/gi, 'THE'],
    [/\bAHD\b/gi, 'AND'],
    [/\bFOR\b/gi, 'FOR'],
    [/\bYOUR\b/gi, 'YOUR'],
    [/HEAVI/gi, 'HEAVY'],
    [/\bLEFI\b/gi, 'LEFT'],
    [/\bRIGHI\b/gi, 'RIGHT'],
    [/\bTIMF\b/gi, 'TIME'],
    [/\bBEST\s*IELL/gi, 'BESTSELLER'],
    [/\bBEST\s*SELL/gi, 'BESTSELLER'],
    [/\bAUTH\s*OR/gi, 'AUTHOR'],
    [/\bCHON\b/gi, 'JOHN'],
    [/\bJOHH\b/gi, 'JOHN'],
    [/\bJOINS\b/gi, 'JONES'],
    [/\bDOORNAIL\b/gi, 'DOORNAIL'],
    [/\bBUNDORI\b/gi, 'BUNDORI'],
    [/\bLAUIRA\b/gi, 'LAURA'],
    [/\bNGALO\b/gi, 'NGAIO'],
    [/\bMYSTEFT\b/gi, 'MYSTERY'],
    [/\bPALRICH\b/gi, 'PATRICK'],
    [/\bDERKLEK\b/gi, 'DEREK'],
    [/\bCOLORFUIL\b/gi, 'COLORFUL'],
    [/\bBestiell?\b/gi, 'BESTSELLER'],
    [/\bestienli?\b/gi, 'BESTSELLER'],
    [/\bPIRA\s*ACIA\b/gi, 'PATRICIA'],
  ];

  for (const line of sortedByLength.slice(0, 5)) {
    let corrected = line;
    for (const [pattern, replacement] of letterConfusions) {
      corrected = corrected.replace(pattern, replacement);
    }
    if (corrected !== line && corrected.length >= MIN_QUERY_LENGTH) {
      addHypothesis(corrected, 'boost_partial', 148.5, `OCR confusion fix: "${corrected}"`);
    }
  }

  // =========================================================================
  // Strategy 5m: Drop corrupted first 1-2 characters
  // =========================================================================
  // OCR often corrupts the first character of words
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      // Try dropping first char from first word
      const variant1 = [tokens[0].substring(1), ...tokens.slice(1)].join(' ');
      if (variant1.length >= MIN_QUERY_LENGTH) {
        addHypothesis(variant1, 'boost_partial', 149, `Drop first char: "${variant1}"`);
      }
      
      // Try dropping first 2 chars from first word
      if (tokens[0].length > 3) {
        const variant2 = [tokens[0].substring(2), ...tokens.slice(1)].join(' ');
        if (variant2.length >= MIN_QUERY_LENGTH) {
          addHypothesis(variant2, 'boost_partial', 149, `Drop first 2 chars: "${variant2}"`);
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5p2: Split long lines that may contain title+garbled author
  // =========================================================================
  // Lines like "DIED IN THE WOOL NGALO LUI" contain a valid title prefix
  // followed by garbled author. Try progressively shorter prefixes as title-only.
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length >= 5) {
      for (let titleLen = 3; titleLen <= Math.min(tokens.length - 1, 5); titleLen++) {
        const titlePart = tokens.slice(0, titleLen).join(' ');
        const authorPart = tokens.slice(titleLen).join(' ');
        if (titlePart.length >= MIN_QUERY_LENGTH) {
          addHypothesis(titlePart, 'boost_partial', 149.91, `Long line title prefix: "${titlePart}"`);
        }
        if (authorPart.length >= MIN_QUERY_LENGTH) {
          let correctedAuthor = authorPart;
          for (const [pattern, replacement] of nameCompletions) {
            correctedAuthor = correctedAuthor.replace(pattern, replacement);
          }
          for (const [pattern, replacement] of letterConfusions) {
            correctedAuthor = correctedAuthor.replace(pattern, replacement);
          }
          if (correctedAuthor !== authorPart) {
            addHypothesis(
              `${titlePart} ${correctedAuthor}`,
              'boost_combo',
              149.92,
              `Split line: title="${titlePart}" + corrected author="${correctedAuthor}"`
            );
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5p3: Cross-line title fragment reassembly
  // =========================================================================
  // When title words are split across non-adjacent lines (e.g., "DEND AS A" on
  // one line and "DOORNAIL" on another), try combining title-like fragments.
  // Apply corrections first, then combine lines ending in articles/prepositions
  // with other content lines.
  {
    const correctedPhrases: Array<{ original: string; corrected: string }> = [];
    for (const line of sortedByLength.slice(0, 8)) {
      let corrected = line;
      for (const [pattern, replacement] of nameCompletions) {
        corrected = corrected.replace(pattern, replacement);
      }
      for (const [pattern, replacement] of letterConfusions) {
        corrected = corrected.replace(pattern, replacement);
      }
      correctedPhrases.push({ original: line, corrected });
    }

    // Find lines ending with articles/prepositions (incomplete title fragments)
    const continuationEndings = /\b(a|an|the|of|in|to|for|with|on|at|by|from|and|or|as|into)\s*$/i;
    for (const phrase of correctedPhrases) {
      if (continuationEndings.test(phrase.corrected)) {
        // This line looks incomplete - try appending other lines to complete it
        for (const other of correctedPhrases) {
          if (other.original === phrase.original) continue;
          const combined = `${phrase.corrected} ${other.corrected}`;
          const tokens = combined.split(/\s+/).filter(Boolean);
          if (tokens.length >= 3 && tokens.length <= MAX_QUERY_TOKENS) {
            addHypothesis(combined, 'boost_combo', 147.5, `Cross-line reassembly: "${combined}"`);
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5n: Very short OCR text - use wildcard patterns
  // =========================================================================
  // For 3-4 character OCR fragments, try adding wildcard or common endings
  const shortFragments = sortedByLength.filter(line => line.length >= 3 && line.length <= 4);
  for (const frag of shortFragments.slice(0, 3)) {
    // Try common word endings for truncated text
    const endings = ['EN', 'VEN', 'P', 'VE', 'PHEN', 'IGHT', 'AVY'];
    for (const ending of endings) {
      const extended = frag + ending;
      if (extended.length >= MIN_QUERY_LENGTH) {
        addHypothesis(extended, 'boost_partial', 149.5, `Short fragment extended: "${extended}"`);
      }
    }
    
    // For very short fragments, try common word prefixes (reverse truncation)
    const prefixes = ['THE ', 'NEW ', 'BIG ', 'OLD ', 'LAST ', 'FIRST '];
    for (const prefix of prefixes) {
      const extended = prefix + frag;
      if (extended.length >= MIN_QUERY_LENGTH) {
        addHypothesis(extended, 'boost_partial', 149.6, `Short fragment prefixed: "${extended}"`);
      }
    }
  }

  // =========================================================================
  // Strategy 5n2: Single character deletion for insertion errors
  // =========================================================================
  // LAUIRA → LAURA, DEND → DEAD - try removing each char from longer words
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    for (let tokenIdx = 0; tokenIdx < tokens.length && tokenIdx < 3; tokenIdx++) {
      const token = tokens[tokenIdx];
      if (token.length >= 5 && token.length <= 8) {
        // Try removing each character position
        for (let charPos = 1; charPos < token.length - 1; charPos++) {
          const modified = [...tokens];
          modified[tokenIdx] = token.substring(0, charPos) + token.substring(charPos + 1);
          const result = modified.join(' ');
          if (result.length >= MIN_QUERY_LENGTH) {
            addHypothesis(result, 'boost_partial', 149.3, `Single char deletion: "${result}"`);
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5o: Person name with space insertions for corrupted text
  // =========================================================================
  // PIRA ACIA might be missing letters - try inserting common letters
  for (const personLine of evidence.personNameLines.slice(0, 3)) {
    const tokens = personLine.split(/\s+/);
    if (tokens.length >= 2) {
      // Try inserting vowels in short tokens (might be truncated)
      const vowels = ['A', 'E', 'I', 'O'];
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].length >= 3 && tokens[i].length <= 5) {
          for (const vowel of vowels) {
            const modified = [...tokens];
            modified[i] = tokens[i].substring(0, 2) + vowel + tokens[i].substring(2);
            const result = modified.join(' ');
            if (result.length >= MIN_QUERY_LENGTH) {
              addHypothesis(result, 'boost_partial', 149.8, `Name vowel insert: "${result}"`);
            }
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5p: Multi-token merge for fragmented OCR
  // =========================================================================
  // Sometimes OCR splits words that should be together (e.g., "BEST SELLER")
  for (const line of sortedByLength.slice(0, 4)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && tokens.length <= 4) {
      // Try merging adjacent tokens
      for (let i = 0; i < tokens.length - 1; i++) {
        const merged = [...tokens.slice(0, i), tokens[i] + tokens[i + 1], ...tokens.slice(i + 2)].join(' ');
        if (merged.length >= MIN_QUERY_LENGTH) {
          addHypothesis(merged, 'boost_partial', 149.9, `Token merge: "${merged}"`);
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5q: Title-only when author is corrupted/truncated
  // =========================================================================
  // If we have person names but they're very short (likely truncated like "JOH"),
  // try using just title-like lines instead
  const hasShortPersonNames = evidence.personNameLines.some(name => {
    const tokens = name.split(/\s+/).filter(Boolean);
    return tokens.some(t => t.length <= 3 && t.length >= 2);
  });
  
  if (hasShortPersonNames && evidence.titleLikeLines.length > 0) {
    for (const titleLine of evidence.titleLikeLines.slice(0, 3)) {
      if (titleLine.length >= MIN_QUERY_LENGTH) {
        addHypothesis(titleLine, 'boost_partial', 149.85, `Title-only (corrupted author): "${titleLine}"`);
      }
    }
  }

  // =========================================================================
  // Strategy 5r: Use recovered author candidates + title lines
  // =========================================================================
  // recoveredAuthorCandidates reconstructs multi-word authors from single-word
  // fragments (e.g., "CHARLAINE" + "HARRIS" → "CHARLAINE HARRIS") and from
  // advancedExtraction. Combine these with title-like lines and corrected titles.
  if (evidence.recoveredAuthorCandidates && evidence.recoveredAuthorCandidates.length > 0) {
    const goodAuthors = evidence.recoveredAuthorCandidates
      .filter((c: { confidence: number }) => c.confidence > 0.4)
      .slice(0, 3);

    for (const authorCandidate of goodAuthors) {
      const authorLine = authorCandidate.line;

      // Apply name completions and letter confusions to recovered author
      let correctedAuthor = authorLine;
      for (const [pattern, replacement] of nameCompletions) {
        correctedAuthor = correctedAuthor.replace(pattern, replacement);
      }
      for (const [pattern, replacement] of letterConfusions) {
        correctedAuthor = correctedAuthor.replace(pattern, replacement);
      }

      // Try author alone
      if (correctedAuthor.length >= MIN_QUERY_LENGTH) {
        addHypothesis(correctedAuthor, 'boost_partial', 146, `Recovered author: "${correctedAuthor}"`);
      }

      // Combine with title-like lines
      for (const titleLine of evidence.titleLikeLines.slice(0, 2)) {
        let correctedTitle = titleLine;
        for (const [pattern, replacement] of nameCompletions) {
          correctedTitle = correctedTitle.replace(pattern, replacement);
        }
        for (const [pattern, replacement] of letterConfusions) {
          correctedTitle = correctedTitle.replace(pattern, replacement);
        }

        addHypothesis(
          `${correctedTitle} ${correctedAuthor}`,
          'boost_combo',
          144,
          `Corrected title+recovered author: "${correctedTitle}" + "${correctedAuthor}"`
        );
      }

      // Combine with longest candidate phrases (may contain title words)
      for (const phrase of sortedByLength.slice(0, 2)) {
        let correctedPhrase = phrase;
        for (const [pattern, replacement] of nameCompletions) {
          correctedPhrase = correctedPhrase.replace(pattern, replacement);
        }
        for (const [pattern, replacement] of letterConfusions) {
          correctedPhrase = correctedPhrase.replace(pattern, replacement);
        }
        if (correctedPhrase !== correctedAuthor) {
          addHypothesis(
            `${correctedPhrase} ${correctedAuthor}`,
            'boost_combo',
            145,
            `Corrected phrase+recovered author: "${correctedPhrase}" + "${correctedAuthor}"`
          );
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5s: Use advancedExtraction title+author if available
  // =========================================================================
  if (evidence.advancedExtraction) {
    const adv = evidence.advancedExtraction;
    if (adv.title && adv.author) {
      addHypothesis(
        `${adv.title} ${adv.author}`,
        'boost_combo',
        142,
        `Advanced extraction: "${adv.title}" + "${adv.author}"`
      );
      addHypothesis(adv.title, 'boost_partial', 143, `Advanced title: "${adv.title}"`);
    } else if (adv.title) {
      addHypothesis(adv.title, 'boost_partial', 143, `Advanced title-only: "${adv.title}"`);
    } else if (adv.author) {
      addHypothesis(adv.author, 'boost_partial', 143.5, `Advanced author-only: "${adv.author}"`);
    }
  }

  // =========================================================================
  // Strategy 5t: Reconstruct author from adjacent single-word surname candidates
  // =========================================================================
  // When OCR produces separate lines like "CHARLAINE" / "HARRIS",
  // recoverAuthorCandidates catches individual words but we should also
  // try combining consecutive single-word candidates into "FIRSTNAME LASTNAME".
  if (evidence.recoveredAuthorCandidates && evidence.recoveredAuthorCandidates.length >= 2) {
    const singleWordCandidates = evidence.recoveredAuthorCandidates
      .filter((c: { line: string; confidence: number }) => {
        const words = c.line.trim().split(/\s+/);
        return words.length === 1 && c.confidence >= 0.4;
      })
      .map((c: { line: string }) => c.line.trim());

    for (let i = 0; i < singleWordCandidates.length - 1 && i < 4; i++) {
      for (let j = i + 1; j < singleWordCandidates.length && j < i + 3; j++) {
        const combinedAuthor = `${singleWordCandidates[i]} ${singleWordCandidates[j]}`;

        let correctedCombined = combinedAuthor;
        for (const [pattern, replacement] of nameCompletions) {
          correctedCombined = correctedCombined.replace(pattern, replacement);
        }
        for (const [pattern, replacement] of letterConfusions) {
          correctedCombined = correctedCombined.replace(pattern, replacement);
        }

        addHypothesis(correctedCombined, 'boost_partial', 147, `Combined surname candidates: "${correctedCombined}"`);

        for (const titleLine of evidence.titleLikeLines.slice(0, 2)) {
          let correctedTitle = titleLine;
          for (const [pattern, replacement] of nameCompletions) {
            correctedTitle = correctedTitle.replace(pattern, replacement);
          }
          for (const [pattern, replacement] of letterConfusions) {
            correctedTitle = correctedTitle.replace(pattern, replacement);
          }
          addHypothesis(
            `${correctedTitle} ${correctedCombined}`,
            'boost_combo',
            146.5,
            `Title + combined authors: "${correctedTitle}" + "${correctedCombined}"`
          );
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5u: Global correction + cross-line title/author recombination
  // =========================================================================
  // Apply all corrections to every candidate phrase, then identify corrected
  // title-like and person-name-like lines and combine them across lines.
  {
    const globalCorrected: Array<{ original: string; corrected: string }> = [];
    for (const phrase of evidence.candidatePhrases.slice(0, 10)) {
      let corrected = phrase;
      for (const [pattern, replacement] of nameCompletions) {
        corrected = corrected.replace(pattern, replacement);
      }
      for (const [pattern, replacement] of letterConfusions) {
        corrected = corrected.replace(pattern, replacement);
      }
      globalCorrected.push({ original: phrase, corrected });
    }

    // Separate corrected lines into title-like and person-name-like
    const correctedTitles: string[] = [];
    const correctedAuthors: string[] = [];
    for (const { corrected } of globalCorrected) {
      if (looksLikeTitle(corrected)) {
        correctedTitles.push(corrected);
      }
      if (looksLikePersonName(corrected)) {
        correctedAuthors.push(corrected);
      }
    }

    // Combine corrected titles with corrected authors from different lines
    for (const title of correctedTitles.slice(0, 3)) {
      for (const author of correctedAuthors.slice(0, 3)) {
        if (title === author) continue;
        addHypothesis(
          `${title} ${author}`,
          'boost_combo',
          147.8,
          `Global corrected title+author: "${title}" + "${author}"`
        );
      }
      // Also try the corrected title alone
      addHypothesis(title, 'boost_partial', 147.9, `Global corrected title: "${title}"`);
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
