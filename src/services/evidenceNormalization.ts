/**
 * Evidence Normalization Service
 *
 * Provides utilities for normalizing, tokenizing, and filtering OCR evidence
 * for evidence-driven book resolution. This is the foundation for generating
 * search hypotheses and scoring candidate matches.
 */

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
  /^\$\d+/,                // Prices
  /^(?:isbn|issn)[\s:]?\s*$/i, // Just "ISBN" or "ISSN" label
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
 * - Strip surrounding brackets and punctuation noise
 * - Convert to lowercase for tokens (but return original case version too)
 * - Keep internal apostrophes
 */
export function normalizeLine(line: string): { original: string; normalized: string } {
  // Trim and collapse spaces
  let cleaned = line.trim().replace(/\s+/g, ' ');

  // Strip surrounding brackets and quotes
  cleaned = cleaned.replace(/^[\[\](){}<>""'']+/, '').replace(/[\[\](){}<>""'']+$/, '');

  // Strip leading/trailing punctuation (but not apostrophes in middle)
  cleaned = cleaned.replace(/^[^\w\s]+/, '').replace(/[^\w\s]+$/, '');

  // Collapse spaces again after stripping
  cleaned = cleaned.trim().replace(/\s+/g, ' ');

  return {
    original: cleaned,
    normalized: cleaned.toLowerCase(),
  };
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
}

/**
 * Detect if a line looks like a person name
 * - 2-4 words, all capitalized or title case
 * - Common name patterns
 */
export function looksLikePersonName(line: string): boolean {
  const words = line.trim().split(/\s+/);

  // 2-4 words is typical for author names
  if (words.length < 2 || words.length > 4) {
    return false;
  }

  // Check if all words start with capital letter
  const allCapitalized = words.every((w) =>
    /^[A-Z][a-z]*$/.test(w) || /^[A-Z]+$/.test(w)
  );

  if (!allCapitalized) {
    return false;
  }

  // Check against known non-name patterns
  const lowerLine = line.toLowerCase();
  if (GENRE_WORDS.has(lowerLine) || SHELF_LABELS.has(lowerLine)) {
    return false;
  }

  // Check for marketing/noise
  if (isMarketingLine(lowerLine)) {
    return false;
  }

  return true;
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
 * Build evidence tokens from merged OCR lines
 *
 * @param lines - Raw text lines from merged evidence
 * @returns Processed evidence tokens
 */
export function buildEvidenceTokens(lines: string[]): EvidenceTokens {
  const cleanedLines: string[] = [];
  const tokensSet = new Set<string>();
  const tokenCounts = new Map<string, number>();
  const candidatePhrases: string[] = [];
  const isbns: string[] = [];
  const personNameLines: string[] = [];
  const titleLikeLines: string[] = [];

  for (const line of lines) {
    // Normalize
    const { original, normalized } = normalizeLine(line);

    // Skip empty
    if (!normalized) {
      continue;
    }

    // Extract ISBN first (before filtering)
    const isbn = extractIsbn(original);
    if (isbn) {
      isbns.push(isbn);
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

    // Tokenize
    const tokens = tokenize(normalized);
    for (const token of tokens) {
      if (!isStopToken(token)) {
        tokensSet.add(token);
        tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
      }
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

  return {
    cleanedLines,
    tokensSet,
    tokenCounts,
    candidatePhrases,
    isbns,
    personNameLines,
    titleLikeLines,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

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

  const result: string[] = [];

  for (const line of rawLines) {
    const { original, normalized } = normalizeLine(line);

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
 * Returns tokens with aggressive noise removal and numeric filtering
 *
 * @param text - Text to normalize (title, author name, or evidence line)
 * @returns Array of cleaned tokens (lowercased, non-generic)
 */
export function normalizeForScoring(text: string): string[] {
  const { normalized } = normalizeLine(text);
  const tokens = tokenize(normalized);

  // Filter out generic tokens for scoring
  return tokens.filter((token) => {
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

    return true;
  });
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
