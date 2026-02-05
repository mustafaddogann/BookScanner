/**
 * Evidence Normalization Service
 *
 * Provides utilities for normalizing, tokenizing, and filtering OCR evidence
 * for evidence-driven book resolution. This is the foundation for generating
 * search hypotheses and scoring candidate matches.
 */

import {
  extractAndValidateIsbns,
  isIsbnLikeToken,
  filterIsbnTokens,
  validateIsbnChecksum,
  type IsbnExtractionResult,
  type ValidatedIsbn,
  type EvidenceSourceKind,
} from './isbnUtils';
import { ENABLE_ISBN_FROM_SPINE } from '../config/metadataResolutionConfig';

// Re-export ISBN utilities for convenience
export {
  extractAndValidateIsbns,
  isIsbnLikeToken,
  filterIsbnTokens,
  validateIsbnChecksum,
  type IsbnExtractionResult,
  type ValidatedIsbn,
  type EvidenceSourceKind,
};

// ============================================================================
// Stop Words and Junk Filters
// ============================================================================

/** Genre and category words that should be filtered out */
const GENRE_WORDS = new Set([
  'fiction',
  'nonfiction',
  'non-fiction',
  'mystery',
  'romance',
  'thriller',
  'horror',
  'fantasy',
  'scifi',
  'sci-fi',
  'science',
  'biography',
  'memoir',
  'history',
  'historical',
  'contemporary',
  'literary',
  'classic',
  'classics',
  'poetry',
  'drama',
  'comedy',
  'adventure',
  'suspense',
  'crime',
  'detective',
  'western',
  'paranormal',
  'supernatural',
  'dystopian',
  'young',
  'adult',
  'ya',
  'childrens',
  'juvenile',
  'teen',
  'picture',
  'graphic',
  'manga',
  'comic',
  'novel',
  'novels',
  'stories',
  'short',
  'anthology',
]);

/**
 * Generic tokens that should be suppressed in scoring
 * These are extremely common words that appear in many titles
 * and should carry minimal weight when matching
 */
export const GENERIC_TOKENS = new Set([
  // Articles
  'the',
  'a',
  'an',
  // Prepositions
  'of',
  'in',
  'to',
  'for',
  'with',
  'on',
  'at',
  'by',
  'from',
  'and',
  'or',
  // Common title words
  'book',
  'books',
  'story',
  'stories',
  'tale',
  'tales',
  'novel',
  'novels',
  'edition',
  'volume',
  'part',
  'series',
  'collection',
  // Publishing words
  'new',
  'revised',
  'complete',
  'illustrated',
  'original',
  'classic',
  'essential',
  'definitive',
  'ultimate',
]);

/** Marketing phrases that should be filtered out */
const MARKETING_PHRASES = [
  'new york times bestseller',
  'nyt bestseller',
  '#1 bestseller',
  'number one bestseller',
  'international bestseller',
  'bestselling author',
  'national bestseller',
  'a novel',
  'the novel',
  'now a major motion picture',
  'soon to be a major motion picture',
  'the movie',
  'now a netflix series',
  'as seen on tv',
  'oprah book club',
  'reese witherspoon book club',
  'book club pick',
  'pulitzer prize',
  'winner',
  'finalist',
  'award winning',
  'award-winning',
  'million copies sold',
  'over',
  'million',
  'copies',
  'worldwide',
  'introduction by',
  'foreword by',
  'afterword by',
  'preface by',
  'with a new',
  'revised edition',
  'updated edition',
  'special edition',
  'anniversary edition',
  'collectors edition',
  'deluxe edition',
  'illustrated edition',
  'mass market',
  'paperback',
  'hardcover',
  'trade paperback',
];

/** Common shelf labels and library markers */
const SHELF_LABELS = new Set([
  'mystery',
  'fiction',
  'romance',
  'thriller',
  'biography',
  'history',
  'science',
  'self-help',
  'business',
  'cooking',
  'travel',
  'art',
  'music',
  'religion',
  'philosophy',
  'psychology',
  'politics',
  'economics',
  'sports',
  'health',
  'reference',
  'staff',
  'picks',
  'staff picks',
  'new arrivals',
  'bestsellers',
  'local authors',
]);

/** Noise patterns to remove from lines */
const NOISE_PATTERNS = [
  /^\s*[\[\](){}<>]+\s*$/,  // Only brackets
  /^[\s\-_=.]+$/,          // Only punctuation/whitespace
  /^\d+(\.\d+)?$/,         // Only numbers (but keep ISBN-like)
  /^[A-Z]{1,2}\d{1,4}$/,   // Library call numbers
  /^\$\d+/,                // Prices at start
  /^(?:isbn|issn)[\s:]?\s*$/i, // Just "ISBN" or "ISSN" label
];

/**
 * Common publisher names to strip from evidence lines
 * These add noise and should be removed for better matching
 */
const PUBLISHER_NOISE = new Set([
  'penguin',
  'random',
  'house',
  'randomhouse',
  'harpercollins',
  'harper',
  'collins',
  'simon',
  'schuster',
  'macmillan',
  'hachette',
  'scholastic',
  'vintage',
  'anchor',
  'knopf',
  'doubleday',
  'bantam',
  'dell',
  'berkley',
  'putnam',
  'ace',
  'tor',
  'forge',
  'orbit',
  'daw',
  'baen',
  'ballantine',
  'fawcett',
  'avon',
  'morrow',
  'little',
  'brown',
  'grand',
  'central',
  'atria',
  'pocket',
  'gallery',
  'st',
  'martins',
  'press',
  'books',
  'publishers',
  'publishing',
  'ster', // Common OCR noise for "bestseller" or publisher suffix
]);

/**
 * Patterns to remove embedded noise (prices, publisher fragments) from lines
 * NOTE: ISBN pattern only removes the "ISBN" label, not the number itself
 */
const EMBEDDED_NOISE_PATTERNS = [
  /\$\d+(?:\.\d{2})?/g,            // Prices like $9.99 or $193
  /\b(?:usa|us|uk|can|cdn)\s*\$?\d+/gi, // Regional prices
  /\bISBN[-:\s]*(?=\d)/gi,         // ISBN label only (preserves the number)
  /\bNYT\s*#?\d*/gi,               // NYT bestseller notation
];

// ============================================================================
// ISBN Detection
// ============================================================================

/** ISBN-10 pattern: 9 digits + 1 check digit (0-9 or X) */
const ISBN10_PATTERN = /^\d{9}[\dXx]$/;

/** ISBN-13 pattern: 978 or 979 prefix + 10 digits */
const ISBN13_PATTERN = /^97[89]\d{10}$/;

/**
 * Check if a string looks like an ISBN
 */
export function isIsbnLike(str: string): boolean {
  const cleaned = str.replace(/[-\s]/g, '');
  return ISBN10_PATTERN.test(cleaned) || ISBN13_PATTERN.test(cleaned);
}

/**
 * Extract ISBN from a line if present
 */
export function extractIsbn(line: string): string | null {
  // First try to find all sequences of digits and X that could be ISBNs
  // Remove hyphens and spaces, then validate
  const cleaned = line.replace(/[-\s]/g, '');

  // Look for ISBN-13 (13 digits starting with 978 or 979)
  const isbn13Match = cleaned.match(/97[89]\d{10}/);
  if (isbn13Match && isIsbnLike(isbn13Match[0])) {
    return isbn13Match[0].toUpperCase();
  }

  // Look for ISBN-10 (9 digits + check digit which can be X)
  const isbn10Match = cleaned.match(/\d{9}[\dXx]/);
  if (isbn10Match && isIsbnLike(isbn10Match[0])) {
    return isbn10Match[0].toUpperCase();
  }

  return null;
}

// ============================================================================
// Line Normalization
// ============================================================================

/**
 * Normalize a single line of text
 * - Trim whitespace
 * - Collapse multiple spaces
 * - Strip surrounding brackets and punctuation noise (including full wrappers like [TEXT])
 * - Convert to lowercase for tokens (but return original case version too)
 * - Keep internal apostrophes
 *
 * Returns wasWrapped: true if the line was fully wrapped in brackets (high-confidence author signal)
 */
export function normalizeLine(line: string): { original: string; normalized: string; wasWrapped: boolean } {
  // Trim and collapse spaces
  let cleaned = line.trim().replace(/\s+/g, ' ');

  // Check if entire line is wrapped in brackets/parens (e.g., "[NICHOLAS SPARKS]")
  // This is a strong signal for author names on spines
  let wasWrapped = false;
  const wrapperMatch = cleaned.match(/^[\[\({\<](.+)[\]\)}\>]$/);
  if (wrapperMatch) {
    cleaned = wrapperMatch[1].trim();
    wasWrapped = true;
  } else {
    // Strip surrounding brackets and quotes (partial stripping)
    cleaned = cleaned.replace(/^[\[\](){}<>""'']+/, '').replace(/[\[\](){}<>""'']+$/, '');
  }

  // Strip leading/trailing punctuation (but not apostrophes in middle)
  cleaned = cleaned.replace(/^[^\w\s]+/, '').replace(/[^\w\s]+$/, '');

  // Collapse spaces again after stripping
  cleaned = cleaned.trim().replace(/\s+/g, ' ');

  return {
    original: cleaned,
    normalized: cleaned.toLowerCase(),
    wasWrapped,
  };
}

/**
 * Strip embedded noise (prices, publisher fragments) from a line
 * Example: "BANTAM STER $193 POISON IN THE PEN" → "POISON IN THE PEN"
 */
export function stripEmbeddedNoise(line: string): string {
  let result = line;

  // Remove embedded noise patterns (prices, ISBN labels, etc.)
  for (const pattern of EMBEDDED_NOISE_PATTERNS) {
    result = result.replace(pattern, ' ');
  }

  // Remove publisher noise words
  const words = result.split(/\s+/).filter(Boolean);
  if (words.length >= 1) {
    const filteredWords = words.filter((word) => {
      const lower = word.toLowerCase().replace(/[^a-z]/g, '');
      // Preserve numeric-only tokens (could be ISBNs)
      if (!lower && /\d/.test(word)) {
        return true;
      }
      // Skip empty tokens after cleaning (non-alphanumeric noise)
      if (!lower) return false;
      return !PUBLISHER_NOISE.has(lower);
    });
    // Use filtered words if we kept any substantive content
    // If all words were publisher noise, result will be empty (which is fine - line gets filtered later)
    result = filteredWords.join(' ');
  }

  // Collapse multiple spaces and trim
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * Words that typically end incomplete phrases (line continues on next line)
 */
const CONTINUATION_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by',
  'from', 'and', 'or', 'into', 'onto', 'through', 'over', 'under',
  'between', 'among', 'without', 'within', 'beyond', 'before', 'after',
]);

/**
 * Detect if a line appears to be an incomplete phrase that continues on next line
 * Example: "STRAIGHT INTO" ends with "INTO" - likely continues
 */
export function isIncompleteLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3) return false;

  const words = trimmed.split(/\s+/);
  if (words.length === 0) return false;

  const lastWord = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '');

  // Ends with a continuation word
  if (CONTINUATION_WORDS.has(lastWord)) {
    return true;
  }

  // Ends with a hyphen (word break)
  if (trimmed.endsWith('-')) {
    return true;
  }

  return false;
}

/**
 * Merge consecutive lines where the first appears to be incomplete
 * Example: ["STRAIGHT INTO", "DARKNESS"] → ["STRAIGHT INTO DARKNESS"]
 */
export function mergeSplitLines(lines: string[]): string[] {
  if (lines.length <= 1) return lines;

  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    let current = lines[i].trim();

    // Check if this line is incomplete and should be merged with next
    while (i < lines.length - 1 && isIncompleteLine(current)) {
      const next = lines[i + 1].trim();
      // Merge: handle hyphenated word breaks
      if (current.endsWith('-')) {
        current = current.slice(0, -1) + next;
      } else {
        current = current + ' ' + next;
      }
      i++;
    }

    if (current) {
      result.push(current);
    }
    i++;
  }

  return result;
}

/**
 * Check if a line is noise/junk that should be filtered
 */
export function isNoiseLine(normalized: string): boolean {
  // Check noise patterns
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  // Too short (single char)
  if (normalized.length <= 1) {
    return true;
  }

  // Single word that's a genre
  if (!normalized.includes(' ') && GENRE_WORDS.has(normalized)) {
    return true;
  }

  // Shelf label
  if (SHELF_LABELS.has(normalized)) {
    return true;
  }

  return false;
}

/**
 * Check if a line contains marketing content
 */
export function isMarketingLine(normalized: string): boolean {
  for (const phrase of MARKETING_PHRASES) {
    if (normalized.includes(phrase)) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Tokenization
// ============================================================================

/**
 * Tokenize a normalized line into words
 * - Split on whitespace and punctuation
 * - Remove very short tokens (<=1 char)
 * - Remove numeric-only tokens unless ISBN-like
 */
export function tokenize(normalized: string): string[] {
  // Split on non-word characters (keeping apostrophes in words)
  const rawTokens = normalized.split(/[^\w']+/).filter(Boolean);

  const tokens: string[] = [];

  for (const token of rawTokens) {
    // Skip very short tokens
    if (token.length <= 1) {
      continue;
    }

    // Skip numeric-only unless ISBN-like
    if (/^\d+$/.test(token) && !isIsbnLike(token)) {
      continue;
    }

    // Skip if just apostrophes
    if (/^'+$/.test(token)) {
      continue;
    }

    // Remove leading/trailing apostrophes
    const cleaned = token.replace(/^'+/, '').replace(/'+$/, '');
    if (cleaned.length > 1) {
      tokens.push(cleaned);
    }
  }

  return tokens;
}

/**
 * Check if a token is a stop word (genre, etc.)
 */
export function isStopToken(token: string): boolean {
  return GENRE_WORDS.has(token);
}

// ============================================================================
// Evidence Building
// ============================================================================

/**
 * Result of building evidence tokens from lines
 */
export interface EvidenceTokens {
  /** Cleaned lines (noise filtered) */
  cleanedLines: string[];
  /** All unique tokens across all lines */
  tokensSet: Set<string>;
  /** Token frequency counts */
  tokenCounts: Map<string, number>;
  /** Candidate phrases (lines with enough substance) */
  candidatePhrases: string[];
  /** Extracted ISBNs if any */
  isbns: string[];
  /** Lines that look like person names */
  personNameLines: string[];
  /** Lines that look like titles */
  titleLikeLines: string[];
  /** Recovered author candidates from evidence (for TITLE_ONLY mode) */
  recoveredAuthorCandidates: RecoveredAuthorCandidate[];
  /** Best author candidate confidence [0-1] - used for weak title gating */
  bestAuthorConfidence: number;
  /** Number of tokens in best author candidate */
  bestAuthorTokenCount: number;
  /** Advanced extraction result (title/author from multi-line reconstruction, colon patterns, etc.) */
  advancedExtraction?: import('./titleAuthorExtraction').ExtractionResult;
}

/**
 * Detect if a line looks like a person name
 * - 2-4 words (case-insensitive detection)
 * - Common name patterns
 *
 * Note: Now handles OCR case errors like "nGAIO MARSH" by being case-insensitive
 * for initial detection, then relying on token matching for actual scoring.
 */
export function looksLikePersonName(line: string): boolean {
  const words = line.trim().split(/\s+/);

  // 2-4 words is typical for author names
  if (words.length < 2 || words.length > 4) {
    return false;
  }

  // Check against known non-name patterns (case-insensitive)
  const lowerLine = line.toLowerCase();
  if (GENRE_WORDS.has(lowerLine) || SHELF_LABELS.has(lowerLine)) {
    return false;
  }

  // Check for marketing/noise
  if (isMarketingLine(lowerLine)) {
    return false;
  }

  // Check if words look like name parts:
  // - Each word should be mostly alphabetic (allow OCR case errors)
  // - Each word should be 2+ characters (allow initials like "J" only with period)
  const validNameParts = words.every((w) => {
    const cleaned = w.replace(/[^a-zA-Z]/g, '');
    // Allow single letter initials (J., K., etc.)
    if (w.match(/^[A-Za-z]\.?$/) && words.length >= 2) {
      return true;
    }
    // Word must be mostly letters (at least 70% alphabetic)
    const alphaRatio = cleaned.length / w.length;
    return cleaned.length >= 2 && alphaRatio >= 0.7;
  });

  if (!validNameParts) {
    return false;
  }

  // Heuristic: at least one word should start with uppercase
  // (catches "nGAIO MARSH" where MARSH is properly capitalized)
  const hasUpperStart = words.some((w) => /^[A-Z]/.test(w));

  // Alternative: ALL CAPS lines are common for author names in OCR
  const isAllCaps = words.every((w) => w === w.toUpperCase() || w.length <= 2);

  return hasUpperStart || isAllCaps;
}

/**
 * Detect if a line looks more like a title than an author
 * - Longer phrases
 * - Contains "the", "a", "of", etc.
 * - Mixed case or all caps with more words
 */
export function looksLikeTitle(line: string): boolean {
  const words = line.trim().split(/\s+/);
  const lowerLine = line.toLowerCase();

  // Single word is unlikely to be title (could be author surname)
  if (words.length === 1) {
    return false;
  }

  // Contains common title articles/prepositions
  const titleWords = ['the', 'a', 'an', 'of', 'and', 'in', 'to', 'for', 'with', 'on', 'at'];
  const hasArticle = titleWords.some((w) => lowerLine.split(/\s+/).includes(w));

  // Longer lines are more likely titles
  if (words.length >= 3 || hasArticle) {
    // But not if it's marketing
    if (!isMarketingLine(lowerLine)) {
      return true;
    }
  }

  return false;
}

/**
 * Options for building evidence tokens
 */
export interface BuildEvidenceTokensOptions {
  /**
   * Source kind for evidence (default: 'spine_crop')
   * - spine_crop: Skip ISBN extraction (ISBN from spine OCR is unreliable noise)
   * - back_cover/inside_page: Extract ISBNs for potential use
   * - unknown: Conservative, skip ISBN extraction
   */
  sourceKind?: EvidenceSourceKind;
}

/**
 * Build evidence tokens from merged OCR lines
 *
 * @param lines - Raw text lines from merged evidence
 * @param options - Optional configuration including sourceKind for ISBN policy
 * @returns Processed evidence tokens
 */
export function buildEvidenceTokens(
  lines: string[],
  options?: BuildEvidenceTokensOptions
): EvidenceTokens {
  const sourceKind = options?.sourceKind ?? 'spine_crop';

  // Determine if ISBN extraction is allowed:
  // 1. ENABLE_ISBN_FROM_SPINE config must be true for spine sources
  // 2. For non-spine sources (back_cover, inside_page), extraction is always allowed
  const isSpineSource = sourceKind === 'spine_crop' || sourceKind === 'unknown';
  const shouldExtractIsbns = isSpineSource ? ENABLE_ISBN_FROM_SPINE : true;

  const cleanedLines: string[] = [];
  const tokensSet = new Set<string>();
  const tokenCounts = new Map<string, number>();
  const candidatePhrases: string[] = [];
  const isbns: string[] = [];
  const personNameLines: string[] = [];
  const titleLikeLines: string[] = [];
  const wrappedLines: string[] = []; // Lines that were in brackets (high-confidence author signal)

  // Step 1: Merge split lines (e.g., "STRAIGHT INTO" + "DARKNESS")
  const mergedLines = mergeSplitLines(lines);

  for (const line of mergedLines) {
    // Step 2: Strip embedded noise (prices, publisher names)
    const strippedLine = stripEmbeddedNoise(line);

    // Normalize (now also detects bracket-wrapped lines)
    const { original, normalized, wasWrapped } = normalizeLine(strippedLine);

    // Skip empty
    if (!normalized) {
      continue;
    }

    // Track wrapped lines for high-confidence author detection
    if (wasWrapped && original) {
      wrappedLines.push(original);
    }

    // Extract ISBN only for non-spine sources (back_cover, inside_page)
    // Spine OCR produces unreliable ISBNs that cause false negatives
    if (shouldExtractIsbns) {
      const isbn = extractIsbn(line);
      if (isbn) {
        isbns.push(isbn);
      }
    }

    // Skip noise
    if (isNoiseLine(normalized)) {
      continue;
    }

    // Skip pure marketing
    if (isMarketingLine(normalized)) {
      continue;
    }

    cleanedLines.push(original);

    // Tokenize - filter out stop tokens, numeric tokens, and ISBN-like tokens
    // This ensures ISBN-like strings from spine OCR don't affect scoring
    const tokens = tokenize(normalized);
    for (const token of tokens) {
      // Skip stop tokens (genre words, common words)
      if (isStopToken(token)) {
        continue;
      }
      // Skip pure numeric tokens (years, prices, etc.)
      if (/^\d+$/.test(token)) {
        continue;
      }
      // Skip ISBN-like tokens (hyphenated numbers, ISBN patterns)
      if (isIsbnLikeToken(token)) {
        continue;
      }
      tokensSet.add(token);
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }

    // Check if this is a candidate phrase (has enough content)
    const letterCount = (original.match(/[a-zA-Z]/g) || []).length;
    if (letterCount >= 3 && tokens.length >= 1) {
      candidatePhrases.push(original);

      // Classify as person name or title
      if (looksLikePersonName(original)) {
        personNameLines.push(original);
      }
      if (looksLikeTitle(original)) {
        titleLikeLines.push(original);
      }
    }
  }

  // Recover author candidates from evidence (pass wrapped lines for higher confidence)
  const recoveredAuthorCandidates = recoverAuthorCandidates(lines, personNameLines, wrappedLines);

  // Run advanced extraction (multi-line reconstruction, colon patterns, all-caps detection)
  const { extractTitleAndAuthor: extract } = require('./titleAuthorExtraction');
  const advancedExtraction = extract(lines);

  // Merge advanced extraction author into recovered candidates if not already present
  if (advancedExtraction.author && advancedExtraction.authorConfidence > 0) {
    const authorLower = advancedExtraction.author.toLowerCase();
    const alreadyRecovered = recoveredAuthorCandidates.some(
      (c: RecoveredAuthorCandidate) => c.line.toLowerCase() === authorLower
    );
    if (!alreadyRecovered) {
      recoveredAuthorCandidates.push({
        line: advancedExtraction.author,
        confidence: advancedExtraction.authorConfidence,
        reason: 'advanced_extraction',
      });
      // Re-sort by confidence
      recoveredAuthorCandidates.sort((a: RecoveredAuthorCandidate, b: RecoveredAuthorCandidate) => b.confidence - a.confidence);
    }
  }

  // Compute best author confidence and token count for gating logic
  const bestAuthor = recoveredAuthorCandidates[0];
  const bestAuthorConfidence = bestAuthor?.confidence ?? 0;
  const bestAuthorTokenCount = bestAuthor
    ? bestAuthor.line.trim().split(/\s+/).length
    : 0;

  return {
    cleanedLines,
    tokensSet,
    tokenCounts,
    candidatePhrases,
    isbns,
    personNameLines,
    titleLikeLines,
    recoveredAuthorCandidates,
    bestAuthorConfidence,
    bestAuthorTokenCount,
    advancedExtraction,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Author candidate recovered from evidence lines
 */
export interface RecoveredAuthorCandidate {
  /** Original line from evidence */
  line: string;
  /** Confidence score [0-1] */
  confidence: number;
  /** Reason for classification */
  reason: string;
}

/**
 * Attempt to recover author candidates from evidence lines.
 *
 * This is used before declaring "author missing" to check if there are
 * potential author names in the evidence that could be used for matching.
 *
 * Criteria:
 * - 2-4 words with high alphabetic ratio
 * - Not all-caps single-word series labels
 * - Prefer lines near bottom of evidence (author often at bottom of spine)
 * - Prefer lines that look like names (capitalization patterns)
 * - HIGHEST PRIORITY: Bracketed lines like [NICHOLAS SPARKS] (confidence 0.9)
 *
 * @param evidenceLines - Raw evidence lines
 * @param personNameLines - Pre-detected person name lines from buildEvidenceTokens
 * @param wrappedLines - Lines that were in brackets (high-confidence author signal)
 * @returns Recovered author candidates sorted by confidence
 */
export function recoverAuthorCandidates(
  evidenceLines: string[],
  personNameLines: string[],
  wrappedLines: string[] = []
): RecoveredAuthorCandidate[] {
  const candidates: RecoveredAuthorCandidate[] = [];
  const seenLines = new Set<string>();

  // HIGHEST PRIORITY: Bracketed lines like [NICHOLAS SPARKS]
  // These are almost always author names on book spines
  for (const line of wrappedLines) {
    const words = line.trim().split(/\s+/);
    // Must be 2-4 words to be a name
    if (words.length >= 2 && words.length <= 4 && !seenLines.has(line)) {
      seenLines.add(line);
      candidates.push({
        line,
        confidence: 0.9, // Very high confidence for bracketed names
        reason: 'bracketed_author_name',
      });
    }
  }

  // Second priority: already-detected person name lines
  for (const line of personNameLines) {
    if (!seenLines.has(line)) {
      seenLines.add(line);
      candidates.push({
        line,
        confidence: 0.7,
        reason: 'detected_person_name',
      });
    }
  }

  // Also scan evidence lines for potential authors not caught by looksLikePersonName
  const bottomHalf = evidenceLines.slice(Math.floor(evidenceLines.length / 2));
  for (const line of bottomHalf) {
    const trimmed = line.trim();
    if (!trimmed || personNameLines.includes(trimmed)) continue;

    const words = trimmed.split(/\s+/);

    // Skip if not 2-4 words
    if (words.length < 2 || words.length > 4) continue;

    // Skip all-caps single-word lines (series labels)
    if (words.length === 1 && trimmed === trimmed.toUpperCase()) continue;

    // Check alphabetic ratio (should be mostly letters)
    const letterCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
    const totalChars = trimmed.replace(/\s/g, '').length;
    const alphabeticRatio = totalChars > 0 ? letterCount / totalChars : 0;

    if (alphabeticRatio < 0.85) continue;

    // Check for digit contamination (ISBN fragments, prices, etc.)
    if (/\d{3,}/.test(trimmed)) continue;

    // Check for title-case pattern (common for names)
    const hasTitleCase = words.some(
      (w) => w.length > 1 && w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase()
    );

    if (hasTitleCase) {
      candidates.push({
        line: trimmed,
        confidence: 0.5,
        reason: 'title_case_pattern_bottom_half',
      });
    }
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  return candidates;
}

/**
 * Strip common articles from beginning of line
 */
export function stripLeadingArticle(line: string): string {
  return line.replace(/^(the|a|an)\s+/i, '');
}

/**
 * Get unique tokens from a text string
 */
export function getTokensFromText(text: string): Set<string> {
  const { normalized } = normalizeLine(text);
  const tokens = tokenize(normalized);
  return new Set(tokens.filter((t) => !isStopToken(t)));
}

// ============================================================================
// Evidence Extraction (New API)
// ============================================================================

/**
 * Extract evidence lines from merged text or line array
 * Drops empty lines and noise, returns cleaned lines ready for hypothesis generation
 *
 * @param input - Merged text string (newline-separated) or array of lines
 * @returns Array of cleaned, non-empty evidence lines
 */
export function extractEvidenceLines(input: string | string[]): string[] {
  // Handle both string and array input
  const rawLines = typeof input === 'string'
    ? input.split(/\r?\n/)
    : input;

  // Step 1: Merge split lines (e.g., "STRAIGHT INTO" + "DARKNESS")
  const mergedLines = mergeSplitLines(rawLines);

  const result: string[] = [];

  for (const line of mergedLines) {
    // Step 2: Strip embedded noise (prices, publisher names)
    const strippedLine = stripEmbeddedNoise(line);

    const { original, normalized } = normalizeLine(strippedLine);

    // Skip empty
    if (!normalized || normalized.length === 0) {
      continue;
    }

    // Skip noise lines
    if (isNoiseLine(normalized)) {
      continue;
    }

    // Skip pure marketing
    if (isMarketingLine(normalized)) {
      continue;
    }

    // Keep the cleaned original
    result.push(original);
  }

  return result;
}

/**
 * Normalize text for scoring purposes
 * Returns tokens with aggressive noise removal and numeric filtering.
 *
 * IMPORTANT: ISBN-like tokens are ALWAYS filtered out for scoring.
 * Title/author scoring must use only non-numeric text tokens.
 *
 * @param text - Text to normalize (title, author name, or evidence line)
 * @returns Array of cleaned tokens (lowercased, non-generic, no ISBN-like tokens)
 */
export function normalizeForScoring(text: string): string[] {
  const { normalized } = normalizeLine(text);
  const tokens = tokenize(normalized);

  // Filter out generic tokens and ISBN-like tokens for scoring
  const filtered = tokens.filter((token) => {
    // Skip stop tokens (genre words)
    if (isStopToken(token)) {
      return false;
    }

    // Skip generic tokens (common title words)
    if (GENERIC_TOKENS.has(token)) {
      return false;
    }

    // Skip pure numeric tokens
    if (/^\d+$/.test(token)) {
      return false;
    }

    // Skip ISBN-like tokens (numeric fragments, hyphenated numbers, etc.)
    if (isIsbnLikeToken(token)) {
      return false;
    }

    return true;
  });

  return filtered;
}

/**
 * ISBN extraction result
 */
export interface ExtractedIsbns {
  isbn10?: string;
  isbn13?: string;
}

/**
 * Extract ISBNs from evidence lines or tokens
 * Returns structured result with separate ISBN-10 and ISBN-13
 *
 * @param input - Array of evidence lines or merged text
 * @returns Object with optional isbn10 and isbn13 fields
 */
export function extractIsbnFromEvidence(input: string | string[]): ExtractedIsbns {
  const lines = typeof input === 'string'
    ? input.split(/\r?\n/)
    : input;

  const result: ExtractedIsbns = {};

  for (const line of lines) {
    const isbn = extractIsbn(line);

    if (isbn) {
      if (isbn.length === 13 && /^97[89]/.test(isbn)) {
        // ISBN-13
        if (!result.isbn13) {
          result.isbn13 = isbn;
        }
      } else if (isbn.length === 10) {
        // ISBN-10
        if (!result.isbn10) {
          result.isbn10 = isbn;
        }
      }

      // If we have both, we can stop early
      if (result.isbn10 && result.isbn13) {
        break;
      }
    }
  }

  return result;
}

/**
 * Check if a token is generic (common word with low discriminative value)
 */
export function isGenericToken(token: string): boolean {
  return GENERIC_TOKENS.has(token.toLowerCase());
}

/**
 * Check if a title is "generic" (single common word that matches many books)
 * Used to apply penalty in candidate scoring
 */
export function isGenericTitle(title: string): boolean {
  const tokens = normalizeForScoring(title);

  // Single-token titles that are generic words
  if (tokens.length === 0) {
    return true;
  }

  if (tokens.length === 1) {
    const token = tokens[0].toLowerCase();

    // Single common word titles
    const singleWordGeneric = new Set([
      'it',
      'us',
      'them',
      'gone',
      'home',
      'room',
      'girl',
      'boy',
      'man',
      'woman',
      'night',
      'day',
      'life',
      'death',
      'love',
      'hate',
      'fire',
      'water',
      'earth',
      'air',
      'dark',
      'light',
      'blood',
      'bone',
      'heart',
      'soul',
      'mind',
      'body',
      'time',
      'space',
      'world',
      'dream',
      'fall',
      'rise',
      'run',
      'hide',
      'seek',
      'lost',
      'found',
      'wild',
      'free',
      'broken',
      'silent',
      'hidden',
    ]);

    return singleWordGeneric.has(token);
  }

  return false;
}

// ============================================================================
// Advanced Title/Author Extraction (Re-exports)
// ============================================================================

export {
  extractTitleAndAuthor,
  buildTitleCandidates,
  selectAuthorCandidates,
  parseColonSeparated,
  cleanupPossessiveNoise,
  isAllCapsNameCandidate,
  isPublisherOrMarketing,
  normalizeAuthorName,
  type TitleCandidate,
  type AuthorCandidate,
  type ExtractionResult,
  type ColonSeparatedResult,
} from './titleAuthorExtraction';
