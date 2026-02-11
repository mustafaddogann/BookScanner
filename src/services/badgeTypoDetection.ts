/**
 * Badge Typo Detection Service
 *
 * Handles context-limited badge detection with typo tolerance.
 * Part D of resolver-driven correction.
 *
 * Design principles:
 * - Detect "NEW <X>" + "TIMES" + "BESTSELLER" pattern
 * - Allow typo tolerance on <X> (editDistance to "YORK" <= 1)
 * - ONLY apply typo tolerance within this exact structure
 * - Never fuzzy-match outside this structure
 */

import { editDistance, normalizeForMatch, tokens } from './lineClassification';

// ============================================================================
// Badge Pattern Definitions
// ============================================================================

/**
 * The NYT badge pattern structure:
 * Line 1: "NEW <X>" where <X> is 1 edit from "YORK"
 * Line 2: "TIMES"
 * Line 3: "BESTSELLER" or similar
 *
 * All three components must be present (adjacent or near-adjacent)
 */

/**
 * Check if a token is similar to "YORK" within 1 edit distance
 */
function isYorkLike(token: string): boolean {
  const norm = normalizeForMatch(token);
  if (norm === 'YORK') return true;
  if (norm.length < 3 || norm.length > 6) return false;
  return editDistance(norm, 'YORK') <= 1;
}

/**
 * Check if a line contains "NEW <X>" pattern where <X> is York-like
 */
function isNewYorkLikeLine(line: string): boolean {
  const norm = normalizeForMatch(line);
  const toks = tokens(line);

  // Must start with NEW
  if (!norm.startsWith('NEW ')) return false;

  // Check for "NEW YORK" or "NEW <typo>"
  if (toks.length >= 2 && toks[0] === 'NEW') {
    // Check if second token is YORK-like
    if (isYorkLike(toks[1])) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a line is "TIMES" or contains just TIMES
 */
function isTimesLine(line: string): boolean {
  const norm = normalizeForMatch(line);
  return norm === 'TIMES' || norm.includes('TIMES');
}

/**
 * Check if a line is a BESTSELLER variant
 */
function isBestsellerLine(line: string): boolean {
  const norm = normalizeForMatch(line);

  // Direct matches
  if (norm === 'BESTSELLER' || norm === 'BESTSELLING' || norm === 'BEST SELLER') {
    return true;
  }

  // Typo tolerance only within badge context (editDistance <= 1)
  for (const variant of ['BESTSELLER', 'BESTSELLING']) {
    if (norm.length >= variant.length - 1 && norm.length <= variant.length + 1) {
      if (editDistance(norm, variant) <= 1) {
        return true;
      }
    }
  }

  return false;
}

// ============================================================================
// Badge Typo Context Detection
// ============================================================================

/**
 * Result of badge typo context detection
 */
export interface BadgeTypoResult {
  /** Whether a badge pattern was detected */
  isBadge: boolean;
  /** Confidence score [0-1] */
  confidence: number;
  /** Detection reason */
  reason: string;
  /** Indices of all lines that form the badge */
  badgeLineIndices: number[];
  /** Debug: which pattern components were found */
  components: {
    newYorkLine: { index: number; text: string } | null;
    timesLine: { index: number; text: string } | null;
    bestsellerLine: { index: number; text: string } | null;
  };
}

/**
 * Detect NYT badge pattern with typo tolerance
 *
 * Pattern: "NEW <X>" + "TIMES" + "BESTSELLER" within 3-line window
 * <X> must be within 1 edit distance of "YORK"
 *
 * CRITICAL: Typo tolerance for <X> ONLY applies when all three
 * components are present. This prevents false positives.
 */
export function detectBadgeTypoContext(
  lineIndex: number,
  lines: string[]
): BadgeTypoResult {
  const result: BadgeTypoResult = {
    isBadge: false,
    confidence: 0,
    reason: 'not_badge',
    badgeLineIndices: [],
    components: {
      newYorkLine: null,
      timesLine: null,
      bestsellerLine: null,
    },
  };

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return result;
  }

  const currentLine = lines[lineIndex];

  // Define search window (3 lines before and after)
  const windowStart = Math.max(0, lineIndex - 3);
  const windowEnd = Math.min(lines.length - 1, lineIndex + 3);

  // Find components within window
  let newYorkLine: { index: number; text: string } | null = null;
  let timesLine: { index: number; text: string } | null = null;
  let bestsellerLine: { index: number; text: string } | null = null;

  for (let i = windowStart; i <= windowEnd; i++) {
    const line = lines[i];

    if (isNewYorkLikeLine(line) && !newYorkLine) {
      newYorkLine = { index: i, text: line };
    }

    if (isTimesLine(line) && !timesLine) {
      timesLine = { index: i, text: line };
    }

    if (isBestsellerLine(line) && !bestsellerLine) {
      bestsellerLine = { index: i, text: line };
    }
  }

  result.components = { newYorkLine, timesLine, bestsellerLine };

  // CRITICAL: All three components must be present for badge detection
  // This is what makes the typo tolerance context-limited
  if (!newYorkLine || !timesLine || !bestsellerLine) {
    // Not enough components - don't trigger badge
    // SAFETY: If BESTSELLER is not present, do NOT trigger
    if (!bestsellerLine) {
      result.reason = 'missing_bestseller_component';
      return result;
    }

    // If only bestseller, check standard badge detection
    if (bestsellerLine && !newYorkLine && !timesLine) {
      // Single "BESTSELLER" line - use standard detection (no typo tolerance)
      if (lineIndex === bestsellerLine.index) {
        const norm = normalizeForMatch(currentLine);
        if (norm === 'BESTSELLER' || norm === 'BESTSELLING') {
          result.isBadge = true;
          result.confidence = 0.9;
          result.reason = 'standalone_bestseller';
          result.badgeLineIndices = [bestsellerLine.index];
          return result;
        }
      }
    }

    return result;
  }

  // All three components present - this is a full NYT badge pattern
  // Now we can apply typo tolerance for the NEW <X> pattern

  // Check that components are in reasonable order (NEW before TIMES before BESTSELLER)
  // Allow some flexibility in ordering
  const indices = [newYorkLine.index, timesLine.index, bestsellerLine.index].sort((a, b) => a - b);
  const span = indices[2] - indices[0];

  // Badge must span at most 4 lines
  if (span > 4) {
    result.reason = 'components_too_far_apart';
    return result;
  }

  // Check if current line is part of the badge
  const badgeIndices = new Set([newYorkLine.index, timesLine.index, bestsellerLine.index]);

  // Also include lines between components (might be partial badge text)
  for (let i = indices[0]; i <= indices[2]; i++) {
    badgeIndices.add(i);
  }

  result.badgeLineIndices = Array.from(badgeIndices).sort((a, b) => a - b);

  if (badgeIndices.has(lineIndex)) {
    result.isBadge = true;
    result.confidence = 0.95;
    result.reason = 'nyt_badge_pattern_with_typo_tolerance';
  } else {
    // Current line not part of badge, but badge exists nearby
    result.reason = 'badge_detected_nearby';
  }

  return result;
}

/**
 * Get all badge-excluded indices with typo tolerance
 *
 * Combines standard badge detection with typo-tolerant NYT detection
 */
export function getEnhancedBadgeExclusions(lines: string[]): {
  excludedIndices: Set<number>;
  results: Map<number, BadgeTypoResult>;
} {
  const excludedIndices = new Set<number>();
  const results = new Map<number, BadgeTypoResult>();

  // First pass: detect badge patterns for each line
  for (let i = 0; i < lines.length; i++) {
    const result = detectBadgeTypoContext(i, lines);
    results.set(i, result);

    if (result.isBadge) {
      // Add all lines that form the badge
      for (const idx of result.badgeLineIndices) {
        excludedIndices.add(idx);
      }
    }
  }

  return { excludedIndices, results };
}

/**
 * Check if lines contain a badge with potential typo
 * Useful for quick checks without full exclusion computation
 */
export function hasBadgeWithTypo(lines: string[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    const result = detectBadgeTypoContext(i, lines);
    if (result.isBadge && result.reason === 'nyt_badge_pattern_with_typo_tolerance') {
      return true;
    }
  }
  return false;
}
