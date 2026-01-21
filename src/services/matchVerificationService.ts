/**
 * Match Verification Service (Gate 8 - VERIFY)
 *
 * Second-layer verification that checks for potential issues with matches.
 * Can demote matches and flag problems for user review.
 */

import type {
  SearchCandidate,
  ResolvedBook,
  VerificationFlag,
  VerificationResult,
} from '../types';
import {
  normalizedJaroWinkler,
  tokenize,
  findBestMatch,
  normalizeForComparison,
} from '../utils/stringSimilarity';
import { areIsbnsEquivalent } from '../utils/isbnUtils';
import { isMetadataVerboseDebug } from '../config/debug';

// ============================================================================
// Penalty Values
// ============================================================================

/**
 * Penalty values for each verification flag
 */
export const VERIFICATION_PENALTIES: Record<VerificationFlag, number> = {
  'author-mismatch': 0.25,
  'isbn-mismatch': 0.40,
  'token-coverage-low': 0.20,
  'suspicious-edition': 0.15,
  'year-implausible': 0.10,
  'publisher-mismatch': 0.20,
  'edition-conflict': 0.15,
};

// ============================================================================
// Verification Checks
// ============================================================================

/**
 * Check for author mismatch
 * Flag if query has author hint but best match similarity < 0.6
 *
 * @param candidate - Search candidate
 * @param book - Resolved book
 * @returns Flag if mismatch detected
 */
function checkAuthorMismatch(
  candidate: SearchCandidate,
  book: ResolvedBook
): VerificationFlag | null {
  if (!candidate.authorHint) {
    return null; // No author to verify
  }

  if (book.authors.length === 0) {
    return 'author-mismatch'; // Query has author but result doesn't
  }

  // Find best match among book authors
  const { score } = findBestMatch(candidate.authorHint, book.authors);

  if (score < 0.6) {
    if (isMetadataVerboseDebug()) {
      console.log(
        `[Verify] Author mismatch: query="${candidate.authorHint}" vs ` +
          `result="${book.authors.join(', ')}" (similarity=${score.toFixed(2)})`
      );
    }
    return 'author-mismatch';
  }

  return null;
}

/**
 * Check for ISBN mismatch
 * Flag if both query and result have ISBN but they don't match
 *
 * @param candidate - Search candidate
 * @param book - Resolved book
 * @returns Flag if mismatch detected
 */
function checkIsbnMismatch(
  candidate: SearchCandidate,
  book: ResolvedBook
): VerificationFlag | null {
  if (!candidate.isbn) {
    return null; // No query ISBN to verify
  }

  const bookIsbn = book.isbn13 || book.isbn10;
  if (!bookIsbn) {
    return null; // Result has no ISBN to compare
  }

  if (!areIsbnsEquivalent(candidate.isbn, bookIsbn)) {
    if (isMetadataVerboseDebug()) {
      console.log(
        `[Verify] ISBN mismatch: query="${candidate.isbn}" vs result="${bookIsbn}"`
      );
    }
    return 'isbn-mismatch';
  }

  return null;
}

/**
 * Check for low token coverage
 * Flag if overlap < 0.5 between query tokens and result title+authors
 *
 * @param candidate - Search candidate
 * @param book - Resolved book
 * @returns Flag if coverage is low
 */
function checkTokenCoverageLow(
  candidate: SearchCandidate,
  book: ResolvedBook
): VerificationFlag | null {
  if (candidate.tokens.length === 0) {
    return null; // No tokens to check
  }

  // Build result text
  const resultText = `${book.title} ${book.authors.join(' ')}`;
  const resultTokens = new Set(tokenize(resultText));

  // Count overlapping tokens
  let overlap = 0;
  for (const token of candidate.tokens) {
    if (resultTokens.has(token)) {
      overlap++;
    }
  }

  const coverage = overlap / candidate.tokens.length;

  if (coverage < 0.5) {
    if (isMetadataVerboseDebug()) {
      console.log(
        `[Verify] Low token coverage: ${overlap}/${candidate.tokens.length} = ${coverage.toFixed(2)}`
      );
    }
    return 'token-coverage-low';
  }

  return null;
}

/**
 * Check for suspicious edition
 * Flag if common title + publisher exists but publisher not found in evidence
 *
 * @param candidate - Search candidate
 * @param book - Resolved book
 * @param fullTextBlock - Full OCR text for verification
 * @returns Flag if suspicious
 */
function checkSuspiciousEdition(
  candidate: SearchCandidate,
  book: ResolvedBook,
  fullTextBlock: string
): VerificationFlag | null {
  // Only check if result has a publisher
  if (!book.publisher) {
    return null;
  }

  // Check if title is common (generic)
  const titleTokens = tokenize(book.title);
  if (titleTokens.length > 4) {
    return null; // Long titles are less likely to be generic
  }

  // Normalize text for comparison
  const normalizedEvidence = normalizeForComparison(fullTextBlock);
  const normalizedPublisher = normalizeForComparison(book.publisher);

  // Check if publisher appears in evidence
  // Use relaxed matching (publisher name might be abbreviated)
  const publisherTokens = tokenize(book.publisher);
  let publisherFound = false;

  for (const token of publisherTokens) {
    if (token.length > 3 && normalizedEvidence.includes(token)) {
      publisherFound = true;
      break;
    }
  }

  // If we have edition info, also check for that
  if (book.edition) {
    const normalizedEdition = normalizeForComparison(book.edition);
    if (normalizedEvidence.includes(normalizedEdition)) {
      publisherFound = true; // Edition confirmation counts
    }
  }

  if (!publisherFound) {
    if (isMetadataVerboseDebug()) {
      console.log(
        `[Verify] Suspicious edition: publisher "${book.publisher}" not found in evidence`
      );
    }
    return 'suspicious-edition';
  }

  return null;
}

/**
 * Check for implausible publication year
 * Flag if year is in the future or too old (before 1800)
 *
 * @param book - Resolved book
 * @returns Flag if year is implausible
 */
function checkYearImplausible(book: ResolvedBook): VerificationFlag | null {
  if (!book.publishYear) {
    return null;
  }

  const year = parseInt(book.publishYear, 10);
  if (isNaN(year)) {
    return null;
  }

  const currentYear = new Date().getFullYear();

  if (year > currentYear + 1 || year < 1800) {
    if (isMetadataVerboseDebug()) {
      console.log(`[Verify] Implausible year: ${year}`);
    }
    return 'year-implausible';
  }

  return null;
}

/**
 * Check for publisher mismatch
 * Flag if candidate has publisher hint but it doesn't match the book's publisher
 *
 * @param candidate - Search candidate
 * @param book - Resolved book
 * @returns Flag if mismatch detected
 */
function checkPublisherMismatch(
  candidate: SearchCandidate,
  book: ResolvedBook
): VerificationFlag | null {
  if (!candidate.publisherHint) {
    return null; // No publisher hint to verify
  }

  if (!book.publisher) {
    return null; // No publisher to compare against
  }

  // Compare publisher hint against book publisher
  const similarity = normalizedJaroWinkler(candidate.publisherHint, book.publisher);

  if (similarity < 0.6) {
    if (isMetadataVerboseDebug()) {
      console.log(
        `[Verify] Publisher mismatch: hint="${candidate.publisherHint}" vs ` +
          `book="${book.publisher}" (similarity=${similarity.toFixed(2)})`
      );
    }
    return 'publisher-mismatch';
  }

  return null;
}

/**
 * Check for edition conflict
 * Flag if candidate has edition hint that conflicts with book's edition
 *
 * @param candidate - Search candidate
 * @param book - Resolved book
 * @returns Flag if conflict detected
 */
function checkEditionConflict(
  candidate: SearchCandidate,
  book: ResolvedBook
): VerificationFlag | null {
  if (!candidate.editionHint) {
    return null; // No edition hint to verify
  }

  if (!book.edition) {
    return null; // No edition to compare against
  }

  // Extract edition numbers for comparison
  const hintMatch = candidate.editionHint.match(/(\d+)/);
  const bookMatch = book.edition.match(/(\d+)/);

  if (hintMatch && bookMatch) {
    const hintNum = parseInt(hintMatch[1], 10);
    const bookNum = parseInt(bookMatch[1], 10);

    if (hintNum !== bookNum) {
      if (isMetadataVerboseDebug()) {
        console.log(
          `[Verify] Edition conflict: hint="${candidate.editionHint}" (${hintNum}) vs ` +
            `book="${book.edition}" (${bookNum})`
        );
      }
      return 'edition-conflict';
    }
  }

  return null;
}

// ============================================================================
// Main Verification Function
// ============================================================================

export interface VerifyMatchInput {
  /** Search candidate used for query */
  candidate: SearchCandidate;
  /** Resolved book to verify */
  book: ResolvedBook;
  /** Full OCR text block for verification */
  fullTextBlock: string;
  /** Base confidence before verification */
  baseConfidence: number;
}

/**
 * Verify a match and compute adjusted confidence
 *
 * @param input - Verification input
 * @returns Verification result with flags and adjusted confidence
 */
export function verifyMatch(input: VerifyMatchInput): VerificationResult {
  const { candidate, book, fullTextBlock, baseConfidence } = input;

  const flags: VerificationFlag[] = [];

  // Run all checks
  const authorCheck = checkAuthorMismatch(candidate, book);
  if (authorCheck) flags.push(authorCheck);

  const isbnCheck = checkIsbnMismatch(candidate, book);
  if (isbnCheck) flags.push(isbnCheck);

  const coverageCheck = checkTokenCoverageLow(candidate, book);
  if (coverageCheck) flags.push(coverageCheck);

  const suspiciousEditionCheck = checkSuspiciousEdition(candidate, book, fullTextBlock);
  if (suspiciousEditionCheck) flags.push(suspiciousEditionCheck);

  const yearCheck = checkYearImplausible(book);
  if (yearCheck) flags.push(yearCheck);

  // New field extraction checks
  const publisherCheck = checkPublisherMismatch(candidate, book);
  if (publisherCheck) flags.push(publisherCheck);

  const editionConflictCheck = checkEditionConflict(candidate, book);
  if (editionConflictCheck) flags.push(editionConflictCheck);

  // Calculate total penalty
  let totalPenalty = 0;
  for (const flag of flags) {
    totalPenalty += VERIFICATION_PENALTIES[flag];
  }

  // Adjust confidence
  const adjustedConfidence = Math.max(0, baseConfidence - totalPenalty);

  if (isMetadataVerboseDebug() && flags.length > 0) {
    console.log(
      `[Verify] Flags: [${flags.join(', ')}], ` +
        `penalty=${totalPenalty.toFixed(2)}, ` +
        `confidence: ${baseConfidence.toFixed(2)} -> ${adjustedConfidence.toFixed(2)}`
    );
  }

  return {
    passed: flags.length === 0,
    flags,
    adjustedConfidence,
    penalty: totalPenalty,
  };
}

// ============================================================================
// Batch Verification
// ============================================================================

export interface VerifyAllMatchesInput {
  /** Search candidate */
  candidate: SearchCandidate;
  /** All scored matches to verify */
  books: ResolvedBook[];
  /** Full OCR text block */
  fullTextBlock: string;
  /** Base confidences (composite scores) */
  baseConfidences: number[];
}

/**
 * Verify multiple matches
 *
 * @param input - Batch verification input
 * @returns Array of verification results (same order as input books)
 */
export function verifyAllMatches(
  input: VerifyAllMatchesInput
): VerificationResult[] {
  const { candidate, books, fullTextBlock, baseConfidences } = input;

  return books.map((book, index) =>
    verifyMatch({
      candidate,
      book,
      fullTextBlock,
      baseConfidence: baseConfidences[index],
    })
  );
}

// ============================================================================
// Flag Severity
// ============================================================================

/**
 * Flag severity levels for UI display
 */
export type FlagSeverity = 'error' | 'warning' | 'info';

/**
 * Get severity level for a verification flag
 *
 * @param flag - Verification flag
 * @returns Severity level
 */
export function getFlagSeverity(flag: VerificationFlag): FlagSeverity {
  switch (flag) {
    case 'isbn-mismatch':
      return 'error';
    case 'author-mismatch':
    case 'token-coverage-low':
    case 'publisher-mismatch':
      return 'warning';
    case 'suspicious-edition':
    case 'year-implausible':
    case 'edition-conflict':
      return 'info';
    default:
      return 'info';
  }
}

/**
 * Get human-readable description for a verification flag
 *
 * @param flag - Verification flag
 * @returns Description string
 */
export function getFlagDescription(flag: VerificationFlag): string {
  switch (flag) {
    case 'isbn-mismatch':
      return 'ISBN in scan does not match this book';
    case 'author-mismatch':
      return 'Author name does not match OCR text';
    case 'token-coverage-low':
      return 'Limited overlap between OCR text and book title';
    case 'suspicious-edition':
      return 'Publisher not found in scan, may be wrong edition';
    case 'year-implausible':
      return 'Publication year seems incorrect';
    case 'publisher-mismatch':
      return 'Publisher does not match OCR evidence';
    case 'edition-conflict':
      return 'Edition information conflicts with OCR evidence';
    default:
      return 'Verification issue detected';
  }
}
