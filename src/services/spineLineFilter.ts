/**
 * Spine Line Filter (Gate 8)
 *
 * Filters lines into TITLE/AUTHOR candidates vs OTHER (noise) lines.
 * Uses hard filters to identify lines that should NOT be considered for title/author.
 *
 * OTHER classification (hard filters):
 * - ISBN patterns
 * - Edition patterns
 * - Publisher patterns
 * - Price patterns ($, £, €)
 * - URL patterns
 * - Copyright patterns
 * - Numeric-heavy lines (>50% digits)
 * - Barcode patterns
 */

import type { BookEvidenceLine, OCRBoundingBox } from '../types';

// ============================================================================
// Types
// ============================================================================

export type LineClassification = 'title_candidate' | 'author_candidate' | 'other';

export interface FilteredLine {
  /** Original line */
  line: BookEvidenceLine;
  /** Line index in the evidence array */
  lineIndex: number;
  /** Classification result */
  classification: LineClassification;
  /** If OTHER, reason for filtering */
  filterReason?: string;
  /** Normalized text (lowercase, trimmed) */
  normalizedText: string;
  /** Digit ratio (0-1) */
  digitRatio: number;
  /** Position score (0-1, higher = more likely title based on position) */
  positionScore: number;
}

export interface LineFilterResult {
  /** All lines with classifications */
  allLines: FilteredLine[];
  /** Lines that passed filter (title/author candidates) */
  candidateLines: FilteredLine[];
  /** Lines filtered as OTHER */
  otherLines: FilteredLine[];
  /** Summary statistics */
  summary: {
    total: number;
    candidates: number;
    filtered: number;
    byReason: Record<string, number>;
  };
}

// ============================================================================
// Filter Patterns
// ============================================================================

/** ISBN patterns */
const ISBN_PATTERN = /\b(?:isbn[-:\s]*)?(?:97[89][\d\-\s]{10,14}\d|\d[\d\-\s]{8,11}[\dXx])\b/i;

/** Edition patterns (EN/TR) */
const EDITION_PATTERNS = [
  /\b\d+(?:st|nd|rd|th)\s+edition\b/i,
  /\bedition\b/i,
  /\breprint\b/i,
  /\brevised\b/i,
  /\bupdated\b/i,
  /\b\d+\.\s*bask[ıi]/i,
  /\b\d+\.\s*bas[ıi]m/i,
  /\bcilt\s*\d+/i,
];

/** Publisher keywords */
const PUBLISHER_PATTERNS = [
  /\bpress\b/i,
  /\bpublishing\b/i,
  /\bpublishers?\b/i,
  /\bpublications?\b/i,
  /\byayinlari?\b/i,
  /\byayinevi\b/i,
  /\byayincilik\b/i,
  /\bbasim\b/i,
];

/** Known publisher names (exact match) */
const KNOWN_PUBLISHERS = new Set([
  'scribner',
  'penguin',
  'random house',
  'harpercollins',
  'simon & schuster',
  'macmillan',
  'hachette',
  'prentice hall',
  'o\'reilly',
  'wiley',
  'pearson',
  'mcgraw hill',
  'scholastic',
  'bloomsbury',
  'vintage',
  'anchor',
  'knopf',
  'doubleday',
]);

/** Price patterns */
const PRICE_PATTERNS = [
  /\$\s*\d+(?:\.\d{2})?/,           // $9.99
  /£\s*\d+(?:\.\d{2})?/,            // £9.99
  /€\s*\d+(?:[,\.]\d{2})?/,         // €9,99 or €9.99
  /\d+(?:\.\d{2})?\s*(?:USD|EUR|GBP|TL|TRY)/i,
  /(?:price|fiyat)[:\s]+/i,
  /\bRRP\b/i,
];

/** URL patterns */
const URL_PATTERNS = [
  /https?:\/\//i,
  /www\./i,
  /\.com\b/i,
  /\.org\b/i,
  /\.net\b/i,
  /\.edu\b/i,
  /\.co\.uk\b/i,
];

/** Copyright patterns */
const COPYRIGHT_PATTERNS = [
  /^©/,
  /\bcopyright\b/i,
  /\ball\s+rights\s+reserved\b/i,
  /\btüm\s+hakları\s+saklıdır\b/i,
];

/** Barcode patterns (numeric sequences typical of barcodes) */
const BARCODE_PATTERNS = [
  /^\d{8,}$/,           // 8+ consecutive digits only
  /^[0-9\s\-]{10,}$/,   // Digits with spaces/dashes
];

/** Year-only line pattern */
const YEAR_ONLY_PATTERN = /^(?:©\s*)?\d{4}$/;

/** All-caps warning (might be publisher/edition) - used for additional scoring */
const ALL_CAPS_SHORT = /^[A-Z\s]{2,20}$/;

// ============================================================================
// Configuration
// ============================================================================

/** Minimum digit ratio to classify as numeric-heavy */
const NUMERIC_HEAVY_THRESHOLD = 0.5;

/** Minimum line length to consider */
const MIN_LINE_LENGTH = 2;

/** Maximum line length for title candidate (very long = likely description) */
const MAX_TITLE_LENGTH = 150;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate digit ratio in text
 */
function calculateDigitRatio(text: string): number {
  if (text.length === 0) return 0;
  const digitCount = (text.match(/\d/g) || []).length;
  return digitCount / text.length;
}

/**
 * Calculate position score based on bbox.y
 * Higher score = more likely to be title (titles often at top of spine)
 */
function calculatePositionScore(bbox: OCRBoundingBox | undefined, totalLines: number, lineIndex: number): number {
  // If we have bbox, use vertical position
  if (bbox && bbox.height > 0) {
    // Normalize Y position (0 = top, 1 = bottom)
    // Titles tend to be in the top 40% of the spine
    const normalizedY = bbox.y / (bbox.y + bbox.height * 2); // Rough normalization
    if (normalizedY < 0.3) return 0.8;
    if (normalizedY < 0.5) return 0.6;
    if (normalizedY < 0.7) return 0.4;
    return 0.2;
  }

  // Fall back to line index-based scoring
  const normalizedIndex = lineIndex / Math.max(1, totalLines - 1);
  if (normalizedIndex < 0.3) return 0.7;
  if (normalizedIndex < 0.5) return 0.5;
  return 0.3;
}

/**
 * Check if line matches any pattern in array
 */
function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

// ============================================================================
// Main Filter Function
// ============================================================================

/**
 * Filter lines into title/author candidates vs OTHER
 *
 * @param lines - Book evidence lines to filter
 * @returns FilteredLine array with classifications
 */
export function filterSpineLines(lines: BookEvidenceLine[]): LineFilterResult {
  const allLines: FilteredLine[] = [];
  const candidateLines: FilteredLine[] = [];
  const otherLines: FilteredLine[] = [];
  const byReason: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.text.trim();
    const normalizedText = text.toLowerCase();
    const digitRatio = calculateDigitRatio(text);
    const positionScore = calculatePositionScore(line.bbox, lines.length, i);

    // Build base filtered line
    const filteredLine: FilteredLine = {
      line,
      lineIndex: i,
      classification: 'title_candidate', // Default, will be updated
      normalizedText,
      digitRatio,
      positionScore,
    };

    // Apply hard filters
    let filterReason: string | undefined;

    // Filter 1: Too short
    if (text.length < MIN_LINE_LENGTH) {
      filterReason = 'too_short';
    }
    // Filter 2: ISBN
    else if (ISBN_PATTERN.test(text)) {
      filterReason = 'isbn';
    }
    // Filter 3: Price
    else if (matchesAnyPattern(text, PRICE_PATTERNS)) {
      filterReason = 'price';
    }
    // Filter 4: URL
    else if (matchesAnyPattern(text, URL_PATTERNS)) {
      filterReason = 'url';
    }
    // Filter 5: Copyright
    else if (matchesAnyPattern(text, COPYRIGHT_PATTERNS)) {
      filterReason = 'copyright';
    }
    // Filter 6: Barcode
    else if (matchesAnyPattern(text, BARCODE_PATTERNS)) {
      filterReason = 'barcode';
    }
    // Filter 7: Year-only
    else if (YEAR_ONLY_PATTERN.test(text)) {
      filterReason = 'year_only';
    }
    // Filter 8: Numeric-heavy
    else if (digitRatio > NUMERIC_HEAVY_THRESHOLD) {
      filterReason = 'numeric_heavy';
    }
    // Filter 9: Edition (but allow if combined with title-like text)
    else if (matchesAnyPattern(text, EDITION_PATTERNS) && text.length < 30) {
      filterReason = 'edition';
    }
    // Filter 10: Publisher-only (but allow if combined with other text)
    else if (matchesAnyPattern(text, PUBLISHER_PATTERNS) && text.split(/\s+/).length <= 3) {
      filterReason = 'publisher';
    }
    // Filter 10b: Known publisher names
    else if (KNOWN_PUBLISHERS.has(normalizedText)) {
      filterReason = 'publisher';
    }
    // Filter 11: Too long (likely description or back cover text)
    else if (text.length > MAX_TITLE_LENGTH) {
      filterReason = 'too_long';
    }

    // Apply classification
    if (filterReason) {
      filteredLine.classification = 'other';
      filteredLine.filterReason = filterReason;
      otherLines.push(filteredLine);
      byReason[filterReason] = (byReason[filterReason] || 0) + 1;
    } else {
      // Initial classification as title_candidate
      // Will be refined by spineLineLabeler
      filteredLine.classification = 'title_candidate';
      candidateLines.push(filteredLine);
    }

    allLines.push(filteredLine);
  }

  return {
    allLines,
    candidateLines,
    otherLines,
    summary: {
      total: lines.length,
      candidates: candidateLines.length,
      filtered: otherLines.length,
      byReason,
    },
  };
}

/**
 * Check if a single line should be filtered as OTHER
 */
export function isOtherLine(text: string): { isOther: boolean; reason?: string } {
  const trimmed = text.trim();

  if (trimmed.length < MIN_LINE_LENGTH) {
    return { isOther: true, reason: 'too_short' };
  }
  if (ISBN_PATTERN.test(trimmed)) {
    return { isOther: true, reason: 'isbn' };
  }
  if (matchesAnyPattern(trimmed, PRICE_PATTERNS)) {
    return { isOther: true, reason: 'price' };
  }
  if (matchesAnyPattern(trimmed, URL_PATTERNS)) {
    return { isOther: true, reason: 'url' };
  }
  if (matchesAnyPattern(trimmed, COPYRIGHT_PATTERNS)) {
    return { isOther: true, reason: 'copyright' };
  }
  if (matchesAnyPattern(trimmed, BARCODE_PATTERNS)) {
    return { isOther: true, reason: 'barcode' };
  }
  if (YEAR_ONLY_PATTERN.test(trimmed)) {
    return { isOther: true, reason: 'year_only' };
  }
  if (calculateDigitRatio(trimmed) > NUMERIC_HEAVY_THRESHOLD) {
    return { isOther: true, reason: 'numeric_heavy' };
  }
  if (matchesAnyPattern(trimmed, EDITION_PATTERNS) && trimmed.length < 30) {
    return { isOther: true, reason: 'edition' };
  }
  if (matchesAnyPattern(trimmed, PUBLISHER_PATTERNS) && trimmed.split(/\s+/).length <= 3) {
    return { isOther: true, reason: 'publisher' };
  }
  if (KNOWN_PUBLISHERS.has(trimmed.toLowerCase())) {
    return { isOther: true, reason: 'publisher' };
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    return { isOther: true, reason: 'too_long' };
  }

  return { isOther: false };
}
