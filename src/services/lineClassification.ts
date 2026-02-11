/**
 * Line Classification Service
 *
 * Provides deterministic, penalty-based line classification for OCR evidence.
 * Design principles:
 * - Hard-exclude only lines that are provably not title/author (prices, fragments)
 * - Everything else is penalty-based, not blanket rejection
 * - Typo tolerance is CONTEXT-LIMITED (adjacent-structure-based only)
 */

// ============================================================================
// Normalization Layer
// ============================================================================

/**
 * Normalize text for matching purposes
 * - Uppercase, trim, collapse whitespace
 * - Replace punctuation with spaces
 * - Strip diacritics
 */
export function normalizeForMatch(s: string): string {
  if (!s) return '';

  return s
    .trim()
    .toUpperCase()
    // Strip diacritics (NFD decomposition then remove combining marks)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Replace punctuation with spaces
    .replace(/[^\w\s]/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize a string into words
 */
export function tokens(s: string): string[] {
  if (!s) return [];
  return normalizeForMatch(s).split(/\s+/).filter(t => t.length > 0);
}

/**
 * Calculate alphabetic ratio (0-1)
 */
export function alphaRatio(s: string): number {
  if (!s) return 0;
  const total = s.replace(/\s/g, '').length;
  if (total === 0) return 0;
  const letters = (s.match(/[a-zA-Z]/g) || []).length;
  return letters / total;
}

/**
 * Count words in a string
 */
export function wordCount(s: string): number {
  return tokens(s).length;
}

// ============================================================================
// Edit Distance (for typo tolerance - context-limited use only)
// ============================================================================

/**
 * Calculate Levenshtein edit distance between two strings
 * Used ONLY for typo tolerance in badge context
 */
export function editDistance(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;

  if (an === 0) return bn;
  if (bn === 0) return an;

  const matrix: number[][] = [];

  for (let i = 0; i <= an; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= bn; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= an; i++) {
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[an][bn];
}

/**
 * Check if two strings are similar within tolerance
 * @param a - First string
 * @param b - Second string
 * @param maxDist - Maximum edit distance allowed
 */
export function isSimilarWithinTolerance(a: string, b: string, maxDist: number = 1): boolean {
  const normA = normalizeForMatch(a);
  const normB = normalizeForMatch(b);

  // Exact match
  if (normA === normB) return true;

  // Only apply edit distance for short tokens (typo tolerance is context-limited)
  if (normA.length > 12 || normB.length > 12) {
    return false;
  }

  return editDistance(normA, normB) <= maxDist;
}

// ============================================================================
// Line Classification Helpers (deterministic)
// ============================================================================

/**
 * Check if a line looks like a price
 * Examples: "$9.99", "US$14.95", "CAN $19.99", "£12.99", "U.S. $7.99"
 */
export function isPriceLikeLine(line: string): boolean {
  const trimmed = line.trim();

  // Currency symbol patterns
  if (/^[\$£€¥]\s*\d/.test(trimmed)) return true;
  if (/\d[\$£€¥]/.test(trimmed)) return true;
  if (/^(?:us|uk|can|cdn|eur|gbp|usd)\s*[\$£€¥]?\s*\d/i.test(trimmed)) return true;
  // Handle "U.S. $7.99" format (with periods)
  if (/^u\.?s\.?\s*[\$£€¥]\s*\d/i.test(trimmed)) return true;

  // Price-only line (just numbers with decimal)
  if (/^\d+\.\d{2}$/.test(trimmed)) return true;

  // Price at end
  if (/[\$£€¥]\d+(?:\.\d{2})?\s*$/.test(trimmed)) return true;

  return false;
}

/**
 * Check if a line is a fragment (very short, low alpha ratio, or single very short token)
 * Note: Single-word imprints are handled by isExactImprintLine, not here
 */
export function isFragmentLine(line: string): boolean {
  const trimmed = line.trim();

  // Empty or very short
  if (!trimmed || trimmed.length <= 2) return true;

  // Single token that's <= 2 chars
  const toks = tokens(trimmed);
  if (toks.length === 1 && toks[0].length <= 2) return true;

  // Low alpha ratio for short lines
  const alpha = alphaRatio(trimmed);
  if (alpha < 0.5 && trimmed.length < 8) return true;

  // Single very short word (3-4 chars) with mostly digits or special chars
  if (toks.length === 1 && toks[0].length <= 4 && alpha < 0.8) return true;

  return false;
}

/**
 * Title-starting words that disqualify a line from being a person name
 */
const TITLE_START_WORDS = new Set([
  'THE', 'A', 'AN', 'OF', 'IN', 'ON', 'TO', 'FOR', 'INTO', 'UNDER',
  'OVER', 'THROUGH', 'BETWEEN', 'BEYOND', 'BENEATH', 'AGAINST',
]);

/**
 * Common title words that reduce person-likeness
 */
const COMMON_TITLE_WORDS = new Set([
  'DARK', 'NIGHT', 'DAY', 'DEATH', 'LIFE', 'BLOOD', 'FIRE', 'ICE',
  'STORM', 'SHADOW', 'SECRET', 'LAST', 'FIRST', 'FINAL', 'DEAD',
  'LOST', 'FALLEN', 'BROKEN', 'SILENT', 'HIDDEN', 'BURIED',
  'FORGOTTEN', 'GUARDIAN', 'GUARDIANS', 'FINGERPRINT', 'PELICAN',
  'BRIEF', 'GAME', 'GIRL', 'BOY', 'MAN', 'WOMAN', 'WIFE', 'HUSBAND',
  'GONE', 'POISON', 'PEN', 'SHINING',
]);

/**
 * Check if a line looks like a person name
 * Criteria: 2-4 tokens, mostly alpha, TitleCase OR ALLCAPS, not org-like, not title-like
 */
export function isPersonLikeLine(line: string): boolean {
  const trimmed = line.trim();
  const toks = tokens(trimmed);

  // 2-4 words typical for names
  if (toks.length < 2 || toks.length > 4) return false;

  // High alpha ratio
  if (alphaRatio(trimmed) < 0.85) return false;

  // Each word should be at least 2 chars
  if (!toks.every(t => t.length >= 2)) return false;

  // Check for TitleCase or ALLCAPS pattern
  const words = trimmed.split(/\s+/);
  const isTitleCase = words.every(w =>
    w.length <= 1 || (w[0] === w[0].toUpperCase())
  );
  const isAllCaps = words.every(w =>
    w.length <= 2 || w === w.toUpperCase()
  );

  if (!isTitleCase && !isAllCaps) return false;

  // Not org-like
  if (isOrgLikeLine(trimmed)) return false;

  // Not price-like
  if (isPriceLikeLine(trimmed)) return false;

  // CRITICAL: Lines starting with title words are NOT person names
  const firstTok = toks[0];
  if (TITLE_START_WORDS.has(firstTok)) return false;

  // Lines dominated by common title words are NOT person names
  const titleWordCount = toks.filter(t => COMMON_TITLE_WORDS.has(t)).length;
  if (titleWordCount >= toks.length / 2) return false;

  return true;
}

// ============================================================================
// Organization Detection
// ============================================================================

/**
 * Strong organization markers that indicate a line is NOT a person name
 */
const ORG_MARKERS = new Set([
  'PRESS', 'PUBLISHING', 'PUBLISHERS', 'INC', 'LTD', 'LLC', 'CO',
  'CORP', 'CORPORATION', 'COMPANY', 'TIMES', 'JOURNAL', 'TODAY',
  'NEWS', 'MEDIA', 'GROUP', 'FOUNDATION', 'INSTITUTE', 'UNIVERSITY',
  'COLLEGE', 'ENTERTAINMENT', 'PRODUCTIONS', 'STUDIOS', 'BOOKS',
]);

/**
 * Check if a line contains strong organization markers
 * Used as penalty, not blanket rejection
 */
export function isOrgLikeLine(line: string): boolean {
  const toks = tokens(line);
  return toks.some(t => ORG_MARKERS.has(t));
}

/**
 * Calculate org-like penalty score (0 = not org-like, 1 = definitely org)
 */
export function orgLikePenalty(line: string): number {
  const toks = tokens(line);
  const orgCount = toks.filter(t => ORG_MARKERS.has(t)).length;
  if (orgCount === 0) return 0;
  if (orgCount === 1 && toks.length >= 3) return 0.3; // Single marker in longer line
  if (orgCount === 1) return 0.5;
  return Math.min(1, orgCount * 0.4);
}

// ============================================================================
// Imprint/Publisher Detection (exact single-line match only)
// ============================================================================

/**
 * Known imprints/publishers for exact single-line matching
 * These are ONLY matched when the entire normalized line equals one of these
 */
const EXACT_IMPRINTS = new Set([
  'ZEBRA', 'BANTAM', 'DELL', 'PENGUIN', 'POCKET', 'AVON', 'ACE',
  'TOR', 'FORGE', 'ORBIT', 'DAW', 'BAEN', 'BALLANTINE', 'FAWCETT',
  'MORROW', 'ANCHOR', 'VINTAGE', 'KNOPF', 'DOUBLEDAY', 'BERKLEY',
  'PUTNAM', 'ATRIA', 'GALLERY', 'HARLEQUIN', 'SILHOUETTE', 'MIRA',
  'LOVE INSPIRED', 'PINNACLE', 'KENSINGTON', 'SOURCEBOOKS',
]);

/**
 * Check if a line is an exact imprint match (single-line, normalized)
 * ONLY triggers on exact match after normalization
 */
export function isExactImprintLine(line: string): boolean {
  const norm = normalizeForMatch(line);
  return EXACT_IMPRINTS.has(norm);
}

/**
 * Check if a line contains an imprint token (for title penalty, not exclusion)
 */
export function containsImprintToken(line: string): boolean {
  const toks = tokens(line);
  return toks.some(t => EXACT_IMPRINTS.has(t));
}

// ============================================================================
// Badge Detection (structure-based + typo-tolerant, context-limited)
// ============================================================================

/**
 * Badge entity patterns - these appear near BESTSELLER/ranking tokens
 */
const BADGE_ENTITIES = [
  'NEW YORK TIMES', 'YORK TIMES', 'NY TIMES', 'NYT',
  'USA TODAY', 'WALL STREET JOURNAL', 'WSJ',
  'WASHINGTON POST', 'LOS ANGELES TIMES', 'LA TIMES',
  'BOSTON GLOBE', 'CHICAGO TRIBUNE', 'PUBLISHERS WEEKLY', 'PW',
  'NATIONAL', 'INTERNATIONAL', 'WORLDWIDE',
];

/**
 * Badge qualifier patterns - typically follow entity patterns
 */
const BADGE_QUALIFIERS = [
  'BESTSELLER', 'BESTSELLING', 'BEST SELLER', 'BEST SELLING',
  '#1', '*1', 'NO 1', 'NO. 1', 'NUMBER ONE', 'NUMBER 1',
  'AUTHOR', 'WRITER',
];

/**
 * Standalone badge tokens that are always marketing
 */
const STANDALONE_BADGE_TOKENS = new Set([
  'BESTSELLER', 'BESTSELLING',
]);

export interface BadgeDetectionResult {
  /** Whether this line is a badge */
  isBadge: boolean;
  /** Confidence score [0-1] */
  confidence: number;
  /** Detection reason for debugging */
  reason: string;
  /** Related line indices that form part of the badge */
  relatedIndices: number[];
}

/**
 * Detect if a line is a marketing badge using structure-based analysis
 *
 * This is CONTEXT-LIMITED: typo tolerance only applies within recognized
 * adjacent badge structures, never to standalone lines.
 *
 * @param lineIndex - Index of line to check
 * @param lines - All lines for context
 * @returns Badge detection result with confidence and reasoning
 */
export function isBadgeContext(lineIndex: number, lines: string[]): BadgeDetectionResult {
  if (lineIndex < 0 || lineIndex >= lines.length) {
    return { isBadge: false, confidence: 0, reason: 'invalid_index', relatedIndices: [] };
  }

  const line = lines[lineIndex];
  const normLine = normalizeForMatch(line);
  const lineToks = tokens(line);

  // Check for standalone badge tokens (direct match)
  for (const tok of lineToks) {
    if (STANDALONE_BADGE_TOKENS.has(tok)) {
      return {
        isBadge: true,
        confidence: 0.95,
        reason: `standalone_badge:${tok}`,
        relatedIndices: [],
      };
    }
  }

  // Check for entity pattern match
  const isEntity = BADGE_ENTITIES.some(entity =>
    normLine.includes(normalizeForMatch(entity))
  );

  // Check for qualifier pattern match
  const isQualifier = BADGE_QUALIFIERS.some(qual =>
    normLine.includes(normalizeForMatch(qual))
  );

  // If both entity and qualifier in same line, definitely a badge
  if (isEntity && isQualifier) {
    return {
      isBadge: true,
      confidence: 0.98,
      reason: 'entity_and_qualifier_same_line',
      relatedIndices: [],
    };
  }

  // Check adjacent lines for structure-based detection
  const adjacentIndices = [lineIndex - 1, lineIndex + 1].filter(
    i => i >= 0 && i < lines.length
  );

  const relatedIndices: number[] = [];

  for (const adjIdx of adjacentIndices) {
    const adjNorm = normalizeForMatch(lines[adjIdx]);

    // Entity line adjacent to qualifier line
    if (isEntity) {
      const adjIsQualifier = BADGE_QUALIFIERS.some(qual =>
        adjNorm.includes(normalizeForMatch(qual))
      );
      if (adjIsQualifier) {
        relatedIndices.push(adjIdx);
      }
    }

    // Qualifier line adjacent to entity line
    if (isQualifier) {
      const adjIsEntity = BADGE_ENTITIES.some(entity =>
        adjNorm.includes(normalizeForMatch(entity))
      );
      if (adjIsEntity) {
        relatedIndices.push(adjIdx);
      }
    }

    // Typo-tolerant matching for badge tokens in adjacent context ONLY
    // This is the CONTEXT-LIMITED typo tolerance
    if (isEntity || isQualifier) {
      for (const qual of ['BESTSELLER', 'BESTSELLING']) {
        // Only apply typo tolerance to short tokens in badge context
        for (const tok of tokens(lines[adjIdx])) {
          if (tok.length >= 6 && tok.length <= 12 && isSimilarWithinTolerance(tok, qual, 1)) {
            if (!relatedIndices.includes(adjIdx)) {
              relatedIndices.push(adjIdx);
            }
          }
        }
      }
    }
  }

  if (relatedIndices.length > 0) {
    return {
      isBadge: true,
      confidence: 0.9,
      reason: isEntity ? 'entity_with_adjacent_qualifier' : 'qualifier_with_adjacent_entity',
      relatedIndices,
    };
  }

  // Entity alone might be badge (NYT, USA TODAY) but lower confidence
  if (isEntity) {
    // Check if it looks like a publication name that's marketing
    const isDefBadgeEntity = ['NEW YORK TIMES', 'YORK TIMES', 'USA TODAY', 'WALL STREET JOURNAL']
      .some(e => normLine.includes(normalizeForMatch(e)));
    if (isDefBadgeEntity) {
      return {
        isBadge: true,
        confidence: 0.85,
        reason: 'probable_badge_entity',
        relatedIndices: [],
      };
    }
  }

  return { isBadge: false, confidence: 0, reason: 'not_badge', relatedIndices: [] };
}

/**
 * Get all badge-excluded indices from lines
 */
export function getExcludedBadgeIndices(lines: string[]): Map<number, BadgeDetectionResult> {
  const results = new Map<number, BadgeDetectionResult>();

  for (let i = 0; i < lines.length; i++) {
    const result = isBadgeContext(i, lines);
    if (result.isBadge) {
      results.set(i, result);
      // Also mark related indices
      for (const related of result.relatedIndices) {
        if (!results.has(related)) {
          results.set(related, {
            isBadge: true,
            confidence: result.confidence * 0.9,
            reason: `related_to_badge_at_${i}`,
            relatedIndices: [i],
          });
        }
      }
    }
  }

  return results;
}

// ============================================================================
// Title Classification
// ============================================================================

/**
 * Stopwords that commonly bridge title lines
 */
const TITLE_BRIDGE_STOPWORDS = new Set([
  'THE', 'A', 'AN', 'OF', 'IN', 'ON', 'TO', 'FOR', 'AND', 'OR',
]);

/**
 * Check if a token is a title bridge stopword
 */
export function isTitleBridgeStopword(token: string): boolean {
  return TITLE_BRIDGE_STOPWORDS.has(normalizeForMatch(token));
}

/**
 * Check if a line is title-like (not person, not org, not price, not fragment)
 */
export function isTitleLikeLine(line: string): boolean {
  const trimmed = line.trim();

  // Exclude definite non-titles
  if (isPriceLikeLine(trimmed)) return false;
  if (isFragmentLine(trimmed)) return false;
  if (isExactImprintLine(trimmed)) return false;

  // Must have reasonable alpha content
  if (alphaRatio(trimmed) < 0.6) return false;

  // Must have at least 1 substantive token
  const toks = tokens(trimmed);
  if (toks.length === 0) return false;

  return true;
}

// ============================================================================
// Classification Result Types
// ============================================================================

export interface LineClassification {
  /** Original line index */
  index: number;
  /** Original line text */
  text: string;
  /** Is definitely excluded (price, fragment) */
  isExcluded: boolean;
  /** Exclusion reason if excluded */
  exclusionReason?: string;
  /** Classification scores (for non-excluded lines) */
  scores?: {
    personLikeness: number;
    titleLikeness: number;
    orgPenalty: number;
    badgeConfidence: number;
  };
  /** Badge detection result if relevant */
  badgeResult?: BadgeDetectionResult;
}

/**
 * Classify all lines with scores and exclusions
 */
export function classifyLines(lines: string[]): LineClassification[] {
  const badgeResults = getExcludedBadgeIndices(lines);
  const results: LineClassification[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const classification: LineClassification = {
      index: i,
      text: line,
      isExcluded: false,
    };

    // Hard exclusions (price, fragment)
    if (isPriceLikeLine(line)) {
      classification.isExcluded = true;
      classification.exclusionReason = 'price_like';
      results.push(classification);
      continue;
    }

    if (isFragmentLine(line)) {
      classification.isExcluded = true;
      classification.exclusionReason = 'fragment';
      results.push(classification);
      continue;
    }

    // Exact imprint exclusion
    if (isExactImprintLine(line)) {
      classification.isExcluded = true;
      classification.exclusionReason = 'exact_imprint';
      results.push(classification);
      continue;
    }

    // Badge detection
    const badgeResult = badgeResults.get(i);
    if (badgeResult) {
      classification.badgeResult = badgeResult;
      if (badgeResult.confidence >= 0.85) {
        classification.isExcluded = true;
        classification.exclusionReason = `badge:${badgeResult.reason}`;
        results.push(classification);
        continue;
      }
    }

    // Calculate scores for non-excluded lines
    classification.scores = {
      personLikeness: isPersonLikeLine(line) ? 0.8 : 0.2,
      titleLikeness: isTitleLikeLine(line) ? 0.8 : 0.3,
      orgPenalty: orgLikePenalty(line),
      badgeConfidence: badgeResult?.confidence ?? 0,
    };

    // Adjust person-likeness based on org penalty
    classification.scores.personLikeness -= classification.scores.orgPenalty;
    classification.scores.personLikeness = Math.max(0, classification.scores.personLikeness);

    results.push(classification);
  }

  return results;
}
