/**
 * Spine Line Labeler (Gate 8)
 *
 * Scores each line for likelihood of being TITLE vs AUTHOR.
 * Uses multiple signals:
 * - Position (Y coordinate / line index) - titles often at top
 * - Name score (heuristic for person names)
 * - Title score (heuristic for book titles)
 * - Separator patterns ("by", "•", "-", etc.)
 * - Digit ratio
 * - Character case patterns
 * - Word count
 *
 * Outputs S_title and S_author scores per line (0-1).
 */

import type { FilteredLine } from './spineLineFilter';

// ============================================================================
// Types
// ============================================================================

export interface LineLabel {
  /** Original filtered line */
  filteredLine: FilteredLine;
  /** Title likelihood score (0-1) */
  titleScore: number;
  /** Author likelihood score (0-1) */
  authorScore: number;
  /** Final classification based on scores */
  finalLabel: 'title' | 'author' | 'ambiguous';
  /** Confidence in the classification (0-1) */
  confidence: number;
  /** Debug info about scoring */
  debug: LineLabelDebug;
}

export interface LineLabelDebug {
  /** Position-based score component */
  positionScore: number;
  /** Name heuristic score */
  nameScore: number;
  /** Title heuristic score */
  titleHeuristicScore: number;
  /** "by" pattern detected */
  hasByPattern: boolean;
  /** Separator pattern detected */
  hasSeparator: boolean;
  /** All caps bonus/penalty */
  capsModifier: number;
  /** Word count */
  wordCount: number;
  /** Character length */
  charLength: number;
}

export interface LineLabelingResult {
  /** All labeled lines */
  labeledLines: LineLabel[];
  /** Lines classified as title */
  titleLines: LineLabel[];
  /** Lines classified as author */
  authorLines: LineLabel[];
  /** Ambiguous lines */
  ambiguousLines: LineLabel[];
}

// ============================================================================
// Configuration
// ============================================================================

/** Score threshold for classification */
const CLASSIFICATION_THRESHOLD = 0.55;

/** Minimum score difference for confident classification */
const CONFIDENCE_MARGIN = 0.12;

/** Weights for combining signals */
const WEIGHTS = {
  position: 0.15,
  nameHeuristic: 0.30,
  titleHeuristic: 0.25,
  byPattern: 0.15,
  separator: 0.05,
  caps: 0.05,
  length: 0.05,
};

// ============================================================================
// Pattern Definitions
// ============================================================================

/** "By" patterns indicating author follows */
const BY_PATTERNS = [
  /^by\s+/i,
  /^BY\s+/,
  /^written\s+by\s+/i,
  /^author[:\s]+/i,
  // Turkish
  /^yazan[:\s]+/i,
  /^yazar[:\s]+/i,
  // French/Spanish
  /^par\s+/i,
  /^de\s+/i,
  /^por\s+/i,
];

/** "By" patterns at end (less common but possible) */
const BY_PATTERNS_SUFFIX = [
  /\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)$/,
];

/** Separators that might indicate combined title-author */
const COMBINED_SEPARATORS = [' • ', ' · ', ' | ', ' - ', ' – ', ' — ', '/', ' : '];

/** Common author name prefixes */
const NAME_PREFIXES = ['dr', 'dr.', 'prof', 'prof.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'sir'];

/** Common title starting words */
const TITLE_STARTERS = ['the', 'a', 'an', 'how', 'why', 'what', 'when', 'where', 'who'];

// ============================================================================
// Scoring Functions
// ============================================================================

/**
 * Score likelihood of text being a person name
 */
export function scoreAsName(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length < 2) return 0;

  let score = 0.35; // Base score

  const words = trimmed.split(/\s+/);
  const wordCount = words.length;

  // Ideal name length: 2-4 words
  if (wordCount >= 2 && wordCount <= 4) {
    score += 0.15;
  } else if (wordCount === 1) {
    score -= 0.1; // Single word less likely to be name
  } else if (wordCount > 5) {
    score -= 0.2; // Too many words
  }

  // Check for capitalization pattern (First Last)
  const capitalizedWords = words.filter(w => /^[A-Z]/.test(w));
  if (capitalizedWords.length === wordCount && wordCount >= 2) {
    score += 0.15;
  }

  // Check for initials (J.K., M.L.)
  if (/\b[A-Z]\.\s*[A-Z]?\.?\s*/i.test(trimmed)) {
    score += 0.15;
  }

  // Check for name prefixes
  const lowerFirst = words[0]?.toLowerCase();
  if (NAME_PREFIXES.includes(lowerFirst)) {
    score += 0.1;
  }

  // Check for "and" or "&" (multiple authors)
  if (/\s+(?:and|&)\s+/i.test(trimmed)) {
    score += 0.1;
  }

  // Penalize if starts with article (titles do this)
  if (TITLE_STARTERS.includes(lowerFirst)) {
    score -= 0.2;
  }

  // Penalize if has numbers
  if (/\d/.test(trimmed)) {
    score -= 0.15;
  }

  // Penalize if has punctuation typical of titles
  if (/[?!:]/.test(trimmed)) {
    score -= 0.1;
  }

  // Bonus for common name patterns (First M. Last, First Last Jr.)
  if (/^[A-Z][a-z]+\s+[A-Z]\.\s+[A-Z][a-z]+$/.test(trimmed)) {
    score += 0.2; // "John M. Smith"
  }
  if (/\b(?:Jr|Sr|III|II|IV)\.?$/i.test(trimmed)) {
    score += 0.1; // "John Smith Jr."
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Score likelihood of text being a book title
 */
export function scoreAsTitle(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length < 2) return 0;

  let score = 0.35; // Base score

  const words = trimmed.split(/\s+/);
  const wordCount = words.length;
  const charLength = trimmed.length;

  // Longer text more likely to be title
  if (charLength > 15) score += 0.1;
  if (charLength > 30) score += 0.1;
  if (charLength > 50) score += 0.05;

  // Word count: titles often 2-8 words
  if (wordCount >= 2 && wordCount <= 8) {
    score += 0.1;
  } else if (wordCount > 10) {
    score -= 0.1; // Might be description
  }

  // Single-word titles: give bonus if it's clearly NOT a name
  // Short alphanumeric titles like "1984", "IT", "Room", "Beloved"
  if (wordCount === 1) {
    const nameScore = scoreAsName(text);
    // If it doesn't look like a name at all, it's probably a title
    if (nameScore < 0.4) {
      score += 0.15;
    }
    // Numeric/alphanumeric single words are often titles (1984, 2001, etc)
    if (/^\d+$/.test(trimmed)) {
      score += 0.1;
    }
  }

  // Starts with article
  const lowerFirst = words[0]?.toLowerCase();
  if (TITLE_STARTERS.includes(lowerFirst)) {
    score += 0.15;
  }

  // Has subtitle indicator (colon, dash)
  if (/[:\-–—]/.test(trimmed) && charLength > 10) {
    score += 0.1;
  }

  // Has question/exclamation (common in titles)
  if (/[?!]/.test(trimmed)) {
    score += 0.05;
  }

  // All caps short text (often title on spine)
  if (/^[A-Z\s]{5,40}$/.test(trimmed) && !/\d/.test(trimmed)) {
    score += 0.1;
  }

  // Penalize if looks like person name
  const nameScore = scoreAsName(text);
  if (nameScore > 0.6) {
    score -= 0.2;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Check for "by" pattern and extract author if present
 */
function detectByPattern(text: string): { hasBy: boolean; extractedAuthor?: string } {
  for (const pattern of BY_PATTERNS) {
    if (pattern.test(text)) {
      const match = text.match(pattern);
      if (match) {
        const authorPart = text.replace(pattern, '').trim();
        return { hasBy: true, extractedAuthor: authorPart };
      }
    }
  }

  // Check suffix patterns
  for (const pattern of BY_PATTERNS_SUFFIX) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return { hasBy: true, extractedAuthor: match[1].trim() };
    }
  }

  return { hasBy: false };
}

/**
 * Check for combined separator
 */
function hasCombinedSeparator(text: string): boolean {
  return COMBINED_SEPARATORS.some(sep => text.includes(sep));
}

/**
 * Calculate caps modifier
 * All caps short = often title
 * Mixed case = neutral
 */
function calculateCapsModifier(text: string): number {
  const trimmed = text.trim();
  const upperCount = (trimmed.match(/[A-Z]/g) || []).length;
  const lowerCount = (trimmed.match(/[a-z]/g) || []).length;
  const total = upperCount + lowerCount;

  if (total === 0) return 0;

  const upperRatio = upperCount / total;

  // All caps short = boost title
  if (upperRatio > 0.9 && trimmed.length < 50) {
    return 0.1; // Favor title
  }
  // Mostly lowercase = neutral
  if (upperRatio < 0.3) {
    return 0;
  }

  return 0;
}

// ============================================================================
// Main Labeling Function
// ============================================================================

/**
 * Label lines with title/author scores
 *
 * @param filteredLines - Lines that passed the filter
 * @returns Labeled lines with scores
 */
export function labelSpineLines(filteredLines: FilteredLine[]): LineLabelingResult {
  const labeledLines: LineLabel[] = [];
  const titleLines: LineLabel[] = [];
  const authorLines: LineLabel[] = [];
  const ambiguousLines: LineLabel[] = [];

  for (const fl of filteredLines) {
    // Skip OTHER lines
    if (fl.classification === 'other') {
      continue;
    }

    const text = fl.line.text.trim();

    // Calculate individual scores
    const nameScore = scoreAsName(text);
    const titleHeuristicScore = scoreAsTitle(text);
    const { hasBy } = detectByPattern(text);
    const hasSeparator = hasCombinedSeparator(text);
    const capsModifier = calculateCapsModifier(text);
    const wordCount = text.split(/\s+/).length;
    const charLength = text.length;

    // Build debug info
    const debug: LineLabelDebug = {
      positionScore: fl.positionScore,
      nameScore,
      titleHeuristicScore,
      hasByPattern: hasBy,
      hasSeparator,
      capsModifier,
      wordCount,
      charLength,
    };

    // Calculate combined title score
    let titleScore =
      WEIGHTS.position * fl.positionScore + // Higher position = more title
      WEIGHTS.titleHeuristic * titleHeuristicScore +
      WEIGHTS.caps * (capsModifier > 0 ? 1 : 0.5) +
      WEIGHTS.length * Math.min(1, charLength / 50);

    // Calculate combined author score
    let authorScore =
      WEIGHTS.position * (1 - fl.positionScore) + // Lower position = more author
      WEIGHTS.nameHeuristic * nameScore +
      WEIGHTS.byPattern * (hasBy ? 1 : 0);

    // "by" pattern is strong signal for author
    if (hasBy) {
      authorScore += 0.3;
      titleScore -= 0.2;
    }

    // Separator suggests combined line (both title and author)
    if (hasSeparator) {
      titleScore += 0.05;
      authorScore += 0.05;
    }

    // Normalize scores
    titleScore = Math.max(0, Math.min(1, titleScore));
    authorScore = Math.max(0, Math.min(1, authorScore));

    // Determine final classification
    const scoreDiff = titleScore - authorScore;
    let finalLabel: 'title' | 'author' | 'ambiguous';
    let confidence: number;

    if (Math.abs(scoreDiff) < CONFIDENCE_MARGIN) {
      finalLabel = 'ambiguous';
      confidence = 0.5;
    } else if (titleScore > authorScore) {
      finalLabel = 'title';
      confidence = Math.min(1, 0.5 + scoreDiff);
    } else {
      finalLabel = 'author';
      confidence = Math.min(1, 0.5 - scoreDiff);
    }

    const label: LineLabel = {
      filteredLine: fl,
      titleScore,
      authorScore,
      finalLabel,
      confidence,
      debug,
    };

    labeledLines.push(label);

    // Categorize
    switch (finalLabel) {
      case 'title':
        titleLines.push(label);
        break;
      case 'author':
        authorLines.push(label);
        break;
      case 'ambiguous':
        ambiguousLines.push(label);
        break;
    }
  }

  // Sort by scores
  titleLines.sort((a, b) => b.titleScore - a.titleScore);
  authorLines.sort((a, b) => b.authorScore - a.authorScore);

  return {
    labeledLines,
    titleLines,
    authorLines,
    ambiguousLines,
  };
}

/**
 * Quick scoring function for a single line
 */
export function scoreLine(text: string): { titleScore: number; authorScore: number } {
  const nameScore = scoreAsName(text);
  const titleHeuristicScore = scoreAsTitle(text);
  const { hasBy } = detectByPattern(text);

  let titleScore = titleHeuristicScore * 0.6 + (1 - nameScore) * 0.4;
  let authorScore = nameScore * 0.6 + (hasBy ? 0.4 : 0);

  if (hasBy) {
    authorScore += 0.3;
    titleScore -= 0.2;
  }

  return {
    titleScore: Math.max(0, Math.min(1, titleScore)),
    authorScore: Math.max(0, Math.min(1, authorScore)),
  };
}

// Export helper function for testing (scoreAsName and scoreAsTitle are exported directly)
export { detectByPattern };
