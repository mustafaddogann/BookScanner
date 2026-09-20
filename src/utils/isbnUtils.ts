/**
 * ISBN Utilities - LENIENT layer, for well-formed input
 *
 * ISBN-10/13 validation, normalisation, conversion (10<->13) and display formatting.
 *
 * normalizeIsbn() here strips everything outside [0-9X], so surrounding letters and
 * punctuation silently disappear: "ISBN 0-306-40615-2" parses cleanly. That is right
 * for API responses, catalog records and user entry, and WRONG for raw spine OCR,
 * where it will happily manufacture an ISBN out of a noisy digit run.
 *
 * For spine OCR use the strict layer, src/services/isbnUtils.ts, which keeps its own
 * normalisation contract on purpose. See that file's header before merging the two.
 *
 * Consumers: searchCandidateService, matchVerificationService, metadataResolverService,
 * hypothesisGenerationService, spineFieldExtractionService.
 */

// ============================================================================
// ISBN Normalization
// ============================================================================

/**
 * Remove all non-alphanumeric characters from ISBN string
 * (hyphens, spaces, etc.)
 *
 * @param isbn - Raw ISBN string
 * @returns Normalized ISBN (digits and possibly X for ISBN-10)
 */
export function normalizeIsbn(isbn: string): string {
  return isbn.toUpperCase().replace(/[^0-9X]/g, '');
}

// ============================================================================
// ISBN Validation
// ============================================================================

/**
 * Validate ISBN-10 checksum
 *
 * ISBN-10 checksum: sum of (digit * position) mod 11 = 0
 * where position is 10, 9, 8, ..., 1 and X = 10
 *
 * @param isbn - ISBN-10 string (10 characters, digits + possibly X)
 * @returns True if valid
 */
export function isValidIsbn10(isbn: string): boolean {
  const normalized = normalizeIsbn(isbn);

  if (normalized.length !== 10) {
    return false;
  }

  // Check that all characters except last are digits
  for (let i = 0; i < 9; i++) {
    if (!/[0-9]/.test(normalized[i])) {
      return false;
    }
  }

  // Last character can be digit or X
  if (!/[0-9X]/.test(normalized[9])) {
    return false;
  }

  // Calculate checksum
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(normalized[i], 10) * (10 - i);
  }

  // Last digit
  const lastChar = normalized[9];
  const lastValue = lastChar === 'X' ? 10 : parseInt(lastChar, 10);
  sum += lastValue * 1;

  return sum % 11 === 0;
}

/**
 * Validate ISBN-13 checksum
 *
 * ISBN-13 checksum: alternating weights 1, 3, 1, 3, ...
 * sum mod 10 = 0
 *
 * @param isbn - ISBN-13 string (13 digits)
 * @returns True if valid
 */
export function isValidIsbn13(isbn: string): boolean {
  const normalized = normalizeIsbn(isbn);

  if (normalized.length !== 13) {
    return false;
  }

  // Check all characters are digits
  if (!/^[0-9]{13}$/.test(normalized)) {
    return false;
  }

  // Calculate checksum
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const digit = parseInt(normalized[i], 10);
    const weight = i % 2 === 0 ? 1 : 3;
    sum += digit * weight;
  }

  return sum % 10 === 0;
}

/**
 * Validate any ISBN (10 or 13)
 *
 * @param isbn - ISBN string
 * @returns True if valid ISBN-10 or ISBN-13
 */
export function isValidIsbn(isbn: string): boolean {
  const normalized = normalizeIsbn(isbn);
  return (
    (normalized.length === 10 && isValidIsbn10(normalized)) ||
    (normalized.length === 13 && isValidIsbn13(normalized))
  );
}

// ============================================================================
// ISBN Conversion
// ============================================================================

/**
 * Convert ISBN-10 to ISBN-13
 *
 * @param isbn10 - Valid ISBN-10
 * @returns ISBN-13 or null if invalid input
 */
export function isbn10ToIsbn13(isbn10: string): string | null {
  const normalized = normalizeIsbn(isbn10);

  if (normalized.length !== 10) {
    return null;
  }

  // ISBN-13 = 978 + first 9 digits of ISBN-10 + new check digit
  const base = '978' + normalized.substring(0, 9);

  // Calculate check digit
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(base[i], 10);
    const weight = i % 2 === 0 ? 1 : 3;
    sum += digit * weight;
  }

  const checkDigit = (10 - (sum % 10)) % 10;

  return base + checkDigit.toString();
}

/**
 * Convert ISBN-13 to ISBN-10 (only for 978-prefix ISBNs)
 *
 * @param isbn13 - Valid ISBN-13 starting with 978
 * @returns ISBN-10 or null if not convertible
 */
export function isbn13ToIsbn10(isbn13: string): string | null {
  const normalized = normalizeIsbn(isbn13);

  if (normalized.length !== 13 || !normalized.startsWith('978')) {
    return null; // Only 978-prefix ISBNs can be converted
  }

  // ISBN-10 = digits 4-12 of ISBN-13 + new check digit
  const base = normalized.substring(3, 12);

  // Calculate check digit
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(base[i], 10) * (10 - i);
  }

  const remainder = sum % 11;
  const checkDigit = (11 - remainder) % 11;
  const checkChar = checkDigit === 10 ? 'X' : checkDigit.toString();

  return base + checkChar;
}

// ============================================================================
// ISBN Equivalence
// ============================================================================

/**
 * Check if two ISBNs are equivalent
 * Handles ISBN-10/ISBN-13 conversion
 *
 * @param isbn1 - First ISBN
 * @param isbn2 - Second ISBN
 * @returns True if equivalent
 */
export function areIsbnsEquivalent(isbn1: string, isbn2: string): boolean {
  const n1 = normalizeIsbn(isbn1);
  const n2 = normalizeIsbn(isbn2);

  // Direct match
  if (n1 === n2) {
    return true;
  }

  // Convert to same format for comparison
  let isbn13_1: string | null = null;
  let isbn13_2: string | null = null;

  if (n1.length === 10) {
    isbn13_1 = isbn10ToIsbn13(n1);
  } else if (n1.length === 13) {
    isbn13_1 = n1;
  }

  if (n2.length === 10) {
    isbn13_2 = isbn10ToIsbn13(n2);
  } else if (n2.length === 13) {
    isbn13_2 = n2;
  }

  return isbn13_1 !== null && isbn13_2 !== null && isbn13_1 === isbn13_2;
}

// ============================================================================
// ISBN Parsing from Text
// ============================================================================

/**
 * ISBN regex patterns
 * Matches both ISBN-10 and ISBN-13 with optional hyphens/spaces
 */
const ISBN_10_PATTERN = /\b(\d[\d\-\s]{8,11}[\dXx])\b/g;
const ISBN_13_PATTERN = /\b(97[89][\d\-\s]{10,14}\d)\b/g;

/**
 * Extract all potential ISBNs from text
 *
 * @param text - Text to search
 * @returns Array of normalized ISBNs that pass validation
 */
export function extractIsbnsFromText(text: string): string[] {
  const candidates: string[] = [];

  // Find ISBN-13 candidates (prioritize these)
  const matches13 = text.match(ISBN_13_PATTERN) || [];
  for (const match of matches13) {
    const normalized = normalizeIsbn(match);
    if (isValidIsbn13(normalized) && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  }

  // Find ISBN-10 candidates
  const matches10 = text.match(ISBN_10_PATTERN) || [];
  for (const match of matches10) {
    const normalized = normalizeIsbn(match);
    // Skip if it's actually part of an ISBN-13 we already found
    if (normalized.length === 10 && isValidIsbn10(normalized)) {
      // Convert to ISBN-13 to check for duplicates
      const asIsbn13 = isbn10ToIsbn13(normalized);
      if (asIsbn13 && !candidates.includes(asIsbn13)) {
        // Store as ISBN-13 for consistency
        candidates.push(asIsbn13);
      }
    }
  }

  return candidates;
}

/**
 * Find the first valid ISBN in text
 *
 * @param text - Text to search
 * @returns First valid ISBN (as ISBN-13) or null
 */
export function findFirstIsbn(text: string): string | null {
  const isbns = extractIsbnsFromText(text);
  return isbns.length > 0 ? isbns[0] : null;
}

// ============================================================================
// ISBN Formatting
// ============================================================================

/**
 * Format ISBN-13 with hyphens
 * Standard format: 978-X-XXXX-XXXX-X
 *
 * Note: Proper hyphenation depends on the registration group,
 * this uses a simplified format for display only.
 *
 * @param isbn13 - ISBN-13 (13 digits)
 * @returns Formatted ISBN or original if invalid
 */
export function formatIsbn13(isbn13: string): string {
  const normalized = normalizeIsbn(isbn13);

  if (normalized.length !== 13) {
    return isbn13;
  }

  // Simplified format: XXX-X-XXXX-XXXX-X
  return `${normalized.slice(0, 3)}-${normalized.slice(3, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12)}`;
}

/**
 * Format ISBN-10 with hyphens
 * Standard format: X-XXXX-XXXX-X
 *
 * @param isbn10 - ISBN-10 (10 characters)
 * @returns Formatted ISBN or original if invalid
 */
export function formatIsbn10(isbn10: string): string {
  const normalized = normalizeIsbn(isbn10);

  if (normalized.length !== 10) {
    return isbn10;
  }

  // Simplified format: X-XXXX-XXXX-X
  return `${normalized.slice(0, 1)}-${normalized.slice(1, 5)}-${normalized.slice(5, 9)}-${normalized.slice(9)}`;
}
