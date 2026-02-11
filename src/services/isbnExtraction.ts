/**
 * ISBN Extraction Service
 *
 * Extracts and validates ISBNs from OCR lines with OCR-confusable handling.
 * Part B of resolver-driven correction.
 *
 * Design principles:
 * - Identify high digit/hyphen ratio lines
 * - Join consecutive ISBN-ish lines
 * - Apply OCR confusable substitutions ONLY for ISBN candidates
 * - Validate ISBN-10 and ISBN-13 checksums
 */

// ============================================================================
// OCR Confusable Substitutions (ISBN-only)
// ============================================================================

/**
 * OCR confusable character mappings for ISBN parsing ONLY
 * These are NEVER applied outside ISBN extraction
 */
const ISBN_OCR_CONFUSABLES: Record<string, string> = {
  'O': '0',  // Letter O -> digit 0
  'o': '0',
  'I': '1',  // Letter I -> digit 1
  'l': '1',  // Lowercase L -> digit 1
  'S': '5',  // Letter S -> digit 5
  's': '5',
  'B': '8',  // Letter B -> digit 8
  'Z': '2',  // Letter Z -> digit 2
  'G': '6',  // Letter G -> digit 6
  'T': '7',  // Letter T -> digit 7 (in some fonts)
};

/**
 * Apply OCR confusable substitutions to a string
 * ONLY for ISBN candidate parsing
 */
function applyIsbnOcrSubstitutions(text: string): string {
  let result = '';
  for (const char of text) {
    result += ISBN_OCR_CONFUSABLES[char] ?? char;
  }
  return result;
}

// ============================================================================
// ISBN Detection
// ============================================================================

/**
 * Check if a line looks ISBN-ish (high digit/hyphen ratio)
 */
function isIsbnishLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4) return false;

  // Count digits, hyphens, and X (for ISBN-10 check digit)
  const isbnChars = (trimmed.match(/[0-9Xx\-\s]/g) || []).length;
  const total = trimmed.length;

  // Must be >= 70% ISBN-like characters
  return isbnChars / total >= 0.7;
}

/**
 * Check if a line contains ISBN label
 */
function hasIsbnLabel(line: string): boolean {
  return /isbn/i.test(line);
}

// ============================================================================
// ISBN Validation
// ============================================================================

/**
 * Validate ISBN-10 checksum
 *
 * ISBN-10 checksum: sum of (digit * position) mod 11 = 0
 * where position is 10, 9, 8, ..., 1 and X = 10
 */
export function validateIsbn10Checksum(isbn: string): boolean {
  const normalized = isbn.replace(/[^0-9Xx]/g, '').toUpperCase();

  if (normalized.length !== 10) return false;

  // Check first 9 are digits
  for (let i = 0; i < 9; i++) {
    if (!/[0-9]/.test(normalized[i])) return false;
  }

  // Last can be digit or X
  if (!/[0-9X]/.test(normalized[9])) return false;

  // Calculate checksum
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(normalized[i], 10) * (10 - i);
  }
  const lastValue = normalized[9] === 'X' ? 10 : parseInt(normalized[9], 10);
  sum += lastValue * 1;

  return sum % 11 === 0;
}

/**
 * Validate ISBN-13 checksum
 *
 * ISBN-13 checksum: alternating weights 1, 3, 1, 3, ...
 * sum mod 10 = 0
 */
export function validateIsbn13Checksum(isbn: string): boolean {
  const normalized = isbn.replace(/[^0-9]/g, '');

  if (normalized.length !== 13) return false;

  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const digit = parseInt(normalized[i], 10);
    const weight = i % 2 === 0 ? 1 : 3;
    sum += digit * weight;
  }

  return sum % 10 === 0;
}

// ============================================================================
// ISBN Extraction
// ============================================================================

/**
 * ISBN candidate with metadata
 */
export interface IsbnCandidate {
  /** Raw text from OCR */
  raw: string;
  /** After OCR substitutions */
  substituted: string;
  /** Normalized (digits only + X) */
  normalized: string;
  /** Type detected */
  type: 'isbn10' | 'isbn13' | 'unknown';
  /** Checksum valid */
  checksumValid: boolean;
  /** Source line indices */
  sourceLines: number[];
}

/**
 * ISBN extraction result
 */
export interface IsbnExtractionResult {
  /** All ISBN candidates found */
  candidates: IsbnCandidate[];
  /** Best valid ISBN (checksum passed) */
  validIsbn: string | null;
  /** Type of valid ISBN */
  validIsbnType: 'isbn10' | 'isbn13' | null;
  /** Debug: raw ISBN-ish lines */
  rawIsbnLines: Array<{ index: number; text: string }>;
  /** Debug: joined candidate strings */
  joinedCandidates: string[];
}

/**
 * Validate and normalize an ISBN candidate
 */
export function validateAndNormalizeIsbn(text: string): IsbnCandidate {
  // Apply OCR substitutions
  const substituted = applyIsbnOcrSubstitutions(text);

  // Normalize: remove non-ISBN chars, keep X for ISBN-10
  const normalized = substituted.replace(/[^0-9Xx]/g, '').toUpperCase();

  const candidate: IsbnCandidate = {
    raw: text,
    substituted,
    normalized,
    type: 'unknown',
    checksumValid: false,
    sourceLines: [],
  };

  // Determine type and validate
  if (normalized.length === 10) {
    candidate.type = 'isbn10';
    candidate.checksumValid = validateIsbn10Checksum(normalized);
  } else if (normalized.length === 13) {
    candidate.type = 'isbn13';
    candidate.checksumValid = validateIsbn13Checksum(normalized);
  }

  return candidate;
}

/**
 * Extract ISBNs from OCR lines
 *
 * Strategy:
 * 1. Find lines with high digit/hyphen ratio
 * 2. Join consecutive ISBN-ish lines (handles line breaks in ISBN)
 * 3. Apply OCR confusable substitutions
 * 4. Validate checksum
 * 5. Return best valid ISBN
 */
export function extractIsbnFromOcrLines(lines: string[]): IsbnExtractionResult {
  const result: IsbnExtractionResult = {
    candidates: [],
    validIsbn: null,
    validIsbnType: null,
    rawIsbnLines: [],
    joinedCandidates: [],
  };

  // Step 1: Find ISBN-ish lines
  const isbnishLines: Array<{ index: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check for ISBN label or high digit ratio
    if (hasIsbnLabel(line) || isIsbnishLine(line)) {
      isbnishLines.push({ index: i, text: line });
      result.rawIsbnLines.push({ index: i, text: line });
    }
  }

  if (isbnishLines.length === 0) {
    return result;
  }

  // Step 2: Build candidate strings
  // Try individual lines first
  for (const { index, text } of isbnishLines) {
    // Remove ISBN label if present
    const cleaned = text.replace(/isbn[-:\s]*/i, '').trim();
    if (cleaned.length >= 10) {
      result.joinedCandidates.push(cleaned);

      const candidate = validateAndNormalizeIsbn(cleaned);
      candidate.sourceLines = [index];
      result.candidates.push(candidate);
    }
  }

  // Step 3: Try joining consecutive lines
  for (let i = 0; i < isbnishLines.length - 1; i++) {
    const current = isbnishLines[i];
    const next = isbnishLines[i + 1];

    // Check if consecutive (within 2 line indices)
    if (next.index - current.index <= 2) {
      const joined = current.text.replace(/isbn[-:\s]*/i, '').trim() + next.text.trim();
      result.joinedCandidates.push(joined);

      const candidate = validateAndNormalizeIsbn(joined);
      candidate.sourceLines = [current.index, next.index];
      result.candidates.push(candidate);
    }
  }

  // Step 4: Also try with no-hyphen variant
  for (const joinedText of [...result.joinedCandidates]) {
    const noHyphen = joinedText.replace(/[-\s]/g, '');
    if (noHyphen !== joinedText) {
      const candidate = validateAndNormalizeIsbn(noHyphen);
      result.candidates.push(candidate);
    }
  }

  // Step 5: Find best valid ISBN (prefer ISBN-13)
  const validCandidates = result.candidates.filter(c => c.checksumValid);

  if (validCandidates.length > 0) {
    // Prefer ISBN-13
    const isbn13 = validCandidates.find(c => c.type === 'isbn13');
    const isbn10 = validCandidates.find(c => c.type === 'isbn10');

    if (isbn13) {
      result.validIsbn = isbn13.normalized;
      result.validIsbnType = 'isbn13';
    } else if (isbn10) {
      result.validIsbn = isbn10.normalized;
      result.validIsbnType = 'isbn10';
    }
  }

  return result;
}

/**
 * Check if OCR lines contain a valid ISBN
 * Quick check without full extraction
 */
export function hasValidIsbn(lines: string[]): boolean {
  const result = extractIsbnFromOcrLines(lines);
  return result.validIsbn !== null;
}
