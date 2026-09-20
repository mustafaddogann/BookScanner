/**
 * ISBN Utilities - STRICT layer, for noisy spine OCR
 *
 * ISBN extraction, validation and checksum verification, plus the source-aware ISBN
 * policy used by evidence-driven resolution.
 *
 * WHY THIS EXISTS ALONGSIDE src/utils/isbnUtils.ts
 * ------------------------------------------------
 * The two modules are NOT redundant, despite both implementing the ISBN-10/13
 * checksums (the arithmetic is identical). They differ in their NORMALISATION
 * CONTRACT, and that difference is deliberate:
 *
 *   this module            normalizeIsbn() strips ONLY hyphens and whitespace, then
 *                          rejects any remaining non-digit. Strict: "ISBN0306406152"
 *                          is REJECTED.
 *   src/utils/isbnUtils.ts normalizeIsbn() strips everything outside [0-9X], so
 *                          letters silently vanish. Lenient: "ISBN0306406152" is
 *                          ACCEPTED as 0306406152.
 *
 * Use THIS module for anything derived from spine OCR, where digit runs are unreliable
 * and a lenient parse invents ISBNs that were never on the book (see
 * ENABLE_ISBN_FROM_SPINE in config/metadataResolutionConfig.ts). Use the utils module
 * for well-formed input: API responses, catalog records, user entry.
 *
 * Do NOT merge them into one without first deciding which contract each call site
 * needs; collapsing to the lenient one would loosen validation on exactly the noisy
 * input this layer was written to reject.
 *
 * Consumers: openLibraryProvider, candidateScoring, evidenceNormalization.
 */

// ============================================================================
// Types
// ============================================================================

/** Source kind for evidence - determines ISBN policy */
export type EvidenceSourceKind = 'spine_crop' | 'back_cover' | 'inside_page' | 'unknown';

/** Type of ISBN */
export type IsbnType = 'isbn10' | 'isbn13';

/** Validated ISBN candidate */
export interface ValidatedIsbn {
  /** Raw string as extracted from OCR */
  raw: string;
  /** Normalized to digits only (uppercase X for ISBN-10 check digit) */
  normalized: string;
  /** ISBN type */
  type: IsbnType;
  /** Whether checksum is valid */
  checksumValid: boolean;
}

/** ISBN extraction result with policy metadata */
export interface IsbnExtractionResult {
  /** Raw ISBN-like strings found (before validation) */
  candidatesRaw: string[];
  /** Validated ISBN candidates (checksum passed) */
  candidatesValid: ValidatedIsbn[];
  /** Best ISBN-10 if any (checksum valid) */
  isbn10?: string;
  /** Best ISBN-13 if any (checksum valid) */
  isbn13?: string;
}

/** ISBN policy applied during resolution */
export interface IsbnPolicyResult {
  /** Source kind that determined the policy */
  sourceKind: EvidenceSourceKind;
  /** Policy that was applied */
  policyApplied: 'ignore' | 'boost_only' | 'lookup_first';
  /** Whether ISBN lookup was attempted */
  lookupAttempted: boolean;
  /** Result of ISBN lookup if attempted */
  lookupResult?: 'success' | 'not_found' | 'error' | 'skipped';
  /** Valid ISBNs available for this evidence */
  validIsbns: ValidatedIsbn[];
}

// ============================================================================
// Checksum Validation
// ============================================================================

/**
 * Validate ISBN-10 checksum using modulo 11 algorithm.
 *
 * ISBN-10 checksum algorithm:
 * Sum of (digit * position) from position 10 down to 1
 * Must be divisible by 11
 * Check digit can be 0-9 or X (representing 10)
 *
 * @param isbn - Normalized ISBN-10 (10 characters, digits + optional X)
 * @returns true if checksum is valid
 */
export function validateIsbn10Checksum(isbn: string): boolean {
  if (isbn.length !== 10) {
    return false;
  }

  // Convert to uppercase for X handling
  const normalized = isbn.toUpperCase();

  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const char = normalized[i];
    let digit: number;

    if (i === 9 && char === 'X') {
      digit = 10;
    } else if (char >= '0' && char <= '9') {
      digit = parseInt(char, 10);
    } else {
      return false; // Invalid character
    }

    // Multiply by weight (10 - position)
    sum += digit * (10 - i);
  }

  return sum % 11 === 0;
}

/**
 * Validate ISBN-13 checksum using modulo 10 algorithm.
 *
 * ISBN-13 checksum algorithm:
 * Alternating weights of 1 and 3
 * Sum must be divisible by 10
 *
 * @param isbn - Normalized ISBN-13 (13 digits)
 * @returns true if checksum is valid
 */
export function validateIsbn13Checksum(isbn: string): boolean {
  if (isbn.length !== 13) {
    return false;
  }

  // All characters must be digits
  if (!/^\d{13}$/.test(isbn)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const digit = parseInt(isbn[i], 10);
    // Alternating weights: 1 for even positions, 3 for odd positions
    const weight = i % 2 === 0 ? 1 : 3;
    sum += digit * weight;
  }

  return sum % 10 === 0;
}

/**
 * Validate ISBN checksum (auto-detects ISBN-10 vs ISBN-13)
 *
 * @param isbn - Normalized ISBN string
 * @returns true if checksum is valid
 */
export function validateIsbnChecksum(isbn: string): boolean {
  const normalized = isbn.replace(/[-\s]/g, '').toUpperCase();

  if (normalized.length === 10) {
    return validateIsbn10Checksum(normalized);
  } else if (normalized.length === 13) {
    return validateIsbn13Checksum(normalized);
  }

  return false;
}

// ============================================================================
// ISBN Extraction
// ============================================================================

/** Pattern for ISBN-10: 9 digits + check digit (0-9 or X) */
const ISBN10_PATTERN = /\d{9}[\dXx]/g;

/** Pattern for ISBN-13: 978 or 979 prefix + 10 digits */
const ISBN13_PATTERN = /97[89]\d{10}/g;

/** Pattern for ISBN-like sequences (may include hyphens/spaces) */
const ISBN_LIKE_PATTERN = /(?:ISBN[-:\s]*)?(\d[-\s]?){9,12}\d[\dXx]?/gi;

/**
 * Normalize an ISBN string by removing hyphens and spaces.
 *
 * @param raw - Raw ISBN string with possible formatting
 * @returns Normalized ISBN (digits only, uppercase X for check digit)
 */
export function normalizeIsbn(raw: string): string {
  return raw.replace(/[-\s]/g, '').toUpperCase();
}

/**
 * Determine ISBN type from normalized string.
 *
 * @param normalized - Normalized ISBN string
 * @returns ISBN type or null if invalid format
 */
export function getIsbnType(normalized: string): IsbnType | null {
  if (normalized.length === 10 && /^\d{9}[\dX]$/.test(normalized)) {
    return 'isbn10';
  }
  if (normalized.length === 13 && /^97[89]\d{10}$/.test(normalized)) {
    return 'isbn13';
  }
  return null;
}

/**
 * Extract and validate all ISBN candidates from text.
 *
 * This function:
 * 1. Finds all ISBN-like sequences in the text
 * 2. Normalizes them
 * 3. Validates checksums
 * 4. Returns both raw candidates and validated ones
 *
 * @param text - Text to search for ISBNs (can be multiline)
 * @returns Extraction result with raw and validated candidates
 */
export function extractAndValidateIsbns(text: string): IsbnExtractionResult {
  const candidatesRaw: string[] = [];
  const candidatesValid: ValidatedIsbn[] = [];
  const seenNormalized = new Set<string>();

  // First, try to find formatted ISBN-like sequences
  const isbnLikeMatches = text.match(ISBN_LIKE_PATTERN) || [];
  for (const match of isbnLikeMatches) {
    candidatesRaw.push(match);
  }

  // Also search for bare ISBN patterns
  const cleanedText = text.replace(/[-\s]/g, '');

  // Find ISBN-13 patterns
  const isbn13Matches = cleanedText.match(ISBN13_PATTERN) || [];
  for (const match of isbn13Matches) {
    if (!candidatesRaw.includes(match)) {
      candidatesRaw.push(match);
    }
  }

  // Find ISBN-10 patterns
  const isbn10Matches = cleanedText.match(ISBN10_PATTERN) || [];
  for (const match of isbn10Matches) {
    if (!candidatesRaw.includes(match)) {
      candidatesRaw.push(match);
    }
  }

  // Validate each candidate
  for (const raw of candidatesRaw) {
    const normalized = normalizeIsbn(raw);

    // Skip duplicates
    if (seenNormalized.has(normalized)) {
      continue;
    }

    const type = getIsbnType(normalized);
    if (!type) {
      continue; // Not a valid ISBN format
    }

    const checksumValid = validateIsbnChecksum(normalized);

    // Only add to seenNormalized after we've processed it
    seenNormalized.add(normalized);

    // Only include in valid candidates if checksum passes
    if (checksumValid) {
      candidatesValid.push({
        raw,
        normalized,
        type,
        checksumValid: true,
      });
    }
  }

  // Extract best ISBN-10 and ISBN-13 from valid candidates
  const result: IsbnExtractionResult = {
    candidatesRaw,
    candidatesValid,
  };

  for (const valid of candidatesValid) {
    if (valid.type === 'isbn13' && !result.isbn13) {
      result.isbn13 = valid.normalized;
    } else if (valid.type === 'isbn10' && !result.isbn10) {
      result.isbn10 = valid.normalized;
    }
  }

  return result;
}

// ============================================================================
// ISBN Token Filtering
// ============================================================================

/** Pattern to match ISBN-like tokens that should be removed from scoring */
const ISBN_TOKEN_PATTERNS = [
  /^isbn$/i,                      // "ISBN" label
  /^issn$/i,                      // "ISSN" label
  /^\d{10}$/,                     // 10 digits (ISBN-10 without X)
  /^\d{9}[xX]$/,                  // ISBN-10 with X check digit
  /^97[89]\d{10}$/,               // ISBN-13
  /^\d{1,4}[-]\d{1,6}[-]\d{1,6}/, // Hyphenated number sequences
  /^\d+[-]\d+$/,                  // Any hyphenated digit pair
  /^0[-]\d+/,                     // Starts with 0- (common ISBN fragment)
];

/**
 * Check if a token looks like an ISBN or ISBN fragment.
 * These tokens should be excluded from title/author scoring.
 *
 * @param token - Token to check (already lowercased)
 * @returns true if token looks like ISBN/numeric noise
 */
export function isIsbnLikeToken(token: string): boolean {
  // Check against known patterns
  for (const pattern of ISBN_TOKEN_PATTERNS) {
    if (pattern.test(token)) {
      return true;
    }
  }

  // Check if it's mostly digits (>70% numeric)
  const digitCount = (token.match(/\d/g) || []).length;
  if (token.length >= 4 && digitCount / token.length > 0.7) {
    return true;
  }

  return false;
}

/**
 * Filter out ISBN-like tokens from a token array.
 * Used to ensure title/author scoring only uses text tokens.
 *
 * @param tokens - Array of tokens to filter
 * @returns Filtered array with ISBN-like tokens removed
 */
export function filterIsbnTokens(tokens: string[]): string[] {
  return tokens.filter((token) => !isIsbnLikeToken(token));
}

// ============================================================================
// Source-Aware Policy
// ============================================================================

/**
 * Determine ISBN policy based on evidence source kind.
 *
 * Policy rules:
 * - spine_crop: ISBN is non-fatal, non-scoring noise. Never use for lookup.
 * - back_cover: Valid ISBN triggers lookup first, then fallback to title/author.
 * - inside_page: Same as back_cover.
 * - unknown: Conservative approach, treat as spine_crop.
 *
 * @param sourceKind - The source kind of the evidence
 * @param validIsbns - Valid ISBNs extracted from evidence
 * @returns Policy to apply
 */
export function determineIsbnPolicy(
  sourceKind: EvidenceSourceKind,
  validIsbns: ValidatedIsbn[]
): 'ignore' | 'boost_only' | 'lookup_first' {
  const hasValidIsbn = validIsbns.length > 0;

  switch (sourceKind) {
    case 'spine_crop':
      // Never use ISBN for spine crops - only display/debug
      return 'ignore';

    case 'back_cover':
    case 'inside_page':
      // Use ISBN for lookup if we have valid ones
      return hasValidIsbn ? 'lookup_first' : 'boost_only';

    case 'unknown':
    default:
      // Conservative: treat as boost only (can increase confidence, never decrease)
      return 'boost_only';
  }
}

/**
 * Check if ISBN should be used for initial lookup based on policy.
 *
 * @param policy - The ISBN policy to apply
 * @returns true if ISBN lookup should be attempted first
 */
export function shouldAttemptIsbnLookup(policy: 'ignore' | 'boost_only' | 'lookup_first'): boolean {
  return policy === 'lookup_first';
}

/**
 * Check if ISBN match should boost confidence.
 * ISBN can only increase confidence, never decrease it.
 *
 * @param policy - The ISBN policy to apply
 * @returns true if ISBN match should boost confidence
 */
export function shouldApplyIsbnBoost(policy: 'ignore' | 'boost_only' | 'lookup_first'): boolean {
  return policy === 'boost_only' || policy === 'lookup_first';
}
