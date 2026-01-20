/**
 * OCR Post-Processing Service
 *
 * Provides sophisticated text normalization, junk filtering, and title/author
 * extraction from raw OCR results.
 *
 * Features:
 * - Line normalization (whitespace, diacritics)
 * - Junk/noise filtering (high symbol density, repeated characters)
 * - Title/author candidate scoring
 * - Session-level aggregation across multiple crops
 */

import type { OCRResult, OCRLine } from '../types';

// ============================================================================
// Types
// ============================================================================

export interface ProcessedLine {
  original: string;
  normalized: string;
  confidence: number;
  lineType: 'title' | 'author' | 'noise' | 'unknown';
  score: number;
}

export interface ExtractedMetadata {
  title: string | null;
  author: string | null;
  titleConfidence: number;
  authorConfidence: number;
  titleSource: 'ocr_heuristic' | 'by_prefix' | 'person_pattern' | 'position';
  authorSource: 'ocr_heuristic' | 'by_prefix' | 'person_pattern' | 'position' | null;
}

export interface SessionAggregation {
  bestTitle: string | null;
  bestAuthor: string | null;
  titleVotes: Map<string, number>;
  authorVotes: Map<string, number>;
  cropCount: number;
  processedAt: string;
}

// ============================================================================
// Constants for scoring and filtering
// ============================================================================

// Minimum alphanumeric ratio to consider a line valid
const MIN_ALNUM_RATIO = 0.5;

// Minimum line length to consider (after normalization)
const MIN_LINE_LENGTH = 2;

// Maximum line length for titles (helps filter junk paragraphs)
const MAX_TITLE_LENGTH = 100;

// Common noise patterns to filter
const NOISE_PATTERNS = [
  /^[.\-_=*#@!]+$/,          // All punctuation
  /^(\d+\.?\s*)+$/,          // Only numbers/prices
  /^\$[\d.,]+$/,             // Price patterns
  /^ISBN[\s\-]?\d/i,         // ISBN prefixes (not titles)
  /^www\./i,                 // URLs
  /^http/i,
  /©|®|™/,                   // Copyright symbols
  /^\d{4}$/,                 // Just a year
  /^vol\.?\s*\d/i,           // Volume numbers
  /^edition/i,               // Edition markers
  /^printed in/i,
  /^published by/i,
  /^copyright/i,
];

// Author indicator patterns
const AUTHOR_PREFIXES = [
  /^by\s+/i,
  /^written by\s+/i,
  /^author[:\s]+/i,
];

// ============================================================================
// Text Normalization
// ============================================================================

/**
 * Normalize whitespace in text
 * Collapses multiple spaces, trims, handles various whitespace characters
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/[\t\r\n]+/g, ' ')    // Convert tabs/newlines to spaces
    .replace(/\s+/g, ' ')          // Collapse multiple spaces
    .trim();
}

/**
 * Normalize common OCR substitution errors
 * Helps with consistent matching across different OCR results
 */
export function normalizeOCRErrors(text: string): string {
  return text
    .replace(/[''`´]/g, "'")       // Normalize apostrophes
    .replace(/[""„]/g, '"')        // Normalize quotes
    .replace(/[–—]/g, '-')         // Normalize dashes
    .replace(/[…]/g, '...')        // Normalize ellipsis
    .replace(/\|/g, 'I')           // Common pipe/I confusion
    .replace(/[０-９]/g, (c) =>    // Full-width digits
      String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)
    );
}

/**
 * Full text normalization pipeline
 */
export function normalizeText(text: string): string {
  let normalized = normalizeWhitespace(text);
  normalized = normalizeOCRErrors(normalized);
  return normalized;
}

/**
 * Calculate alphanumeric ratio for a string
 */
export function calculateAlnumRatio(text: string): number {
  if (text.length === 0) return 0;
  const alnumCount = text.replace(/[^a-zA-Z0-9]/g, '').length;
  return alnumCount / text.length;
}

// ============================================================================
// Junk/Noise Filtering
// ============================================================================

/**
 * Check if a line is noise/junk that should be filtered
 */
export function isNoiseLine(text: string): boolean {
  const normalized = normalizeText(text);

  // Too short
  if (normalized.length < MIN_LINE_LENGTH) {
    return true;
  }

  // Low alphanumeric ratio
  if (calculateAlnumRatio(normalized) < MIN_ALNUM_RATIO) {
    return true;
  }

  // Match noise patterns
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  // Check for repeated characters (e.g., "aaaaa", "-----")
  if (/(.)\1{4,}/.test(normalized)) {
    return true;
  }

  // Check for excessive punctuation density
  const punctCount = normalized.replace(/[a-zA-Z0-9\s]/g, '').length;
  if (normalized.length > 5 && punctCount / normalized.length > 0.4) {
    return true;
  }

  return false;
}

/**
 * Filter noise lines from an array
 */
export function filterNoiseLines(lines: string[]): string[] {
  return lines.filter((line) => !isNoiseLine(line));
}

// ============================================================================
// Title/Author Detection
// ============================================================================

/**
 * Check if a line looks like a person's name (potential author)
 *
 * Heuristics:
 * - 2-4 capitalized tokens
 * - Tokens are mostly letters
 * - Not all uppercase (ALL CAPS often means title)
 */
export function isPersonName(text: string): boolean {
  const normalized = normalizeText(text);
  const tokens = normalized.split(/\s+/);

  // Must have 2-4 tokens
  if (tokens.length < 2 || tokens.length > 4) {
    return false;
  }

  // Check if it's all uppercase (likely a title, not name)
  if (normalized === normalized.toUpperCase() && normalized.length > 10) {
    return false;
  }

  // Each token should start with capital and be mostly letters
  for (const token of tokens) {
    if (!/^[A-Z]/.test(token)) return false;

    // Allow initials like "J", "J.", or "J.K."
    if (/^[A-Z]\.?$/.test(token) || /^[A-Z]\.[A-Z]\.?$/.test(token)) {
      continue;
    }

    // Non-initial tokens need at least 2 characters
    if (token.length < 2) return false;

    // Otherwise require high letter ratio
    const letterCount = token.replace(/[^a-zA-Z]/g, '').length;
    if (letterCount / token.length < 0.7) {
      return false;
    }
  }

  return true;
}

/**
 * Extract author from "by Author Name" pattern
 */
export function extractAuthorFromByPrefix(text: string): string | null {
  const normalized = normalizeText(text);

  for (const pattern of AUTHOR_PREFIXES) {
    const match = normalized.match(pattern);
    if (match) {
      const author = normalized.slice(match[0].length).trim();
      if (author.length >= 3 && isPersonName(author)) {
        return author;
      }
    }
  }

  return null;
}

/**
 * Score a line as a potential title
 * Higher score = more likely to be a title
 *
 * Scoring factors:
 * - Length (prefer moderate length, 10-50 chars)
 * - Capitalization patterns
 * - Position in text (first lines often titles)
 * - Absence of author patterns
 */
export function scoreTitleCandidate(
  text: string,
  lineIndex: number,
  totalLines: number,
  confidence: number
): number {
  const normalized = normalizeText(text);
  let score = 0;

  // Base confidence contribution
  score += confidence * 0.3;

  // Length scoring (prefer 10-50 chars)
  const length = normalized.length;
  if (length >= 10 && length <= 50) {
    score += 0.3;
  } else if (length >= 5 && length <= 80) {
    score += 0.15;
  } else if (length > MAX_TITLE_LENGTH) {
    score -= 0.2; // Too long, likely not a title
  }

  // Position scoring (first 1/3 of lines more likely titles)
  const positionRatio = lineIndex / Math.max(totalLines, 1);
  if (positionRatio < 0.33) {
    score += 0.2;
  } else if (positionRatio < 0.5) {
    score += 0.1;
  }

  // Capitalization scoring
  const words = normalized.split(/\s+/);
  const capitalizedWords = words.filter(w => /^[A-Z]/.test(w)).length;
  const capitalizationRatio = capitalizedWords / Math.max(words.length, 1);

  // Title case or all caps both suggest title
  if (capitalizationRatio > 0.7) {
    score += 0.15;
  }

  // Penalty for author patterns
  if (extractAuthorFromByPrefix(normalized) !== null) {
    score -= 0.5; // This is likely an author line
  }
  if (isPersonName(normalized)) {
    score -= 0.3; // Might be author, not title
  }

  // Alphanumeric ratio
  const alnumRatio = calculateAlnumRatio(normalized);
  score += alnumRatio * 0.1;

  return Math.max(0, Math.min(1, score));
}

/**
 * Score a line as a potential author
 * Higher score = more likely to be an author
 */
export function scoreAuthorCandidate(
  text: string,
  lineIndex: number,
  totalLines: number,
  confidence: number
): number {
  const normalized = normalizeText(text);
  let score = 0;

  // Base confidence contribution
  score += confidence * 0.2;

  // Check for "by" prefix (strong indicator)
  if (extractAuthorFromByPrefix(normalized) !== null) {
    score += 0.5;
  }

  // Check if it looks like a person name
  if (isPersonName(normalized)) {
    score += 0.4;
  }

  // Position scoring (authors often after title, in middle or lower third)
  const positionRatio = lineIndex / Math.max(totalLines, 1);
  if (positionRatio >= 0.2 && positionRatio <= 0.6) {
    score += 0.1;
  }

  // Length check (names are usually moderate length)
  if (normalized.length >= 8 && normalized.length <= 40) {
    score += 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

// ============================================================================
// Main Processing Functions
// ============================================================================

/**
 * Process lines from an OCR result and extract metadata
 */
export function processOCRLines(lines: OCRLine[]): ProcessedLine[] {
  const processed: ProcessedLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const normalized = normalizeText(line.text);

    // Skip noise
    if (isNoiseLine(line.text)) {
      processed.push({
        original: line.text,
        normalized,
        confidence: line.confidence,
        lineType: 'noise',
        score: 0,
      });
      continue;
    }

    // Score as title and author
    const titleScore = scoreTitleCandidate(line.text, i, lines.length, line.confidence);
    const authorScore = scoreAuthorCandidate(line.text, i, lines.length, line.confidence);

    // Determine line type
    let lineType: 'title' | 'author' | 'unknown' = 'unknown';
    let score = 0;

    if (titleScore > authorScore && titleScore > 0.3) {
      lineType = 'title';
      score = titleScore;
    } else if (authorScore > titleScore && authorScore > 0.3) {
      lineType = 'author';
      score = authorScore;
    } else {
      score = Math.max(titleScore, authorScore);
    }

    processed.push({
      original: line.text,
      normalized,
      confidence: line.confidence,
      lineType,
      score,
    });
  }

  return processed;
}

/**
 * Extract title and author from an OCR result
 */
export function extractMetadataFromOCR(result: OCRResult): ExtractedMetadata {
  if (!result.ok) {
    return {
      title: null,
      author: null,
      titleConfidence: 0,
      authorConfidence: 0,
      titleSource: 'ocr_heuristic',
      authorSource: null,
    };
  }

  // If no lines but we have native candidates, use those
  if (result.lines.length === 0) {
    return {
      title: result.titleCandidate ? normalizeText(result.titleCandidate) : null,
      author: result.authorCandidate ? normalizeText(result.authorCandidate) : null,
      titleConfidence: result.titleCandidate ? 0.5 : 0,
      authorConfidence: result.authorCandidate ? 0.5 : 0,
      titleSource: 'ocr_heuristic',
      authorSource: result.authorCandidate ? 'ocr_heuristic' : null,
    };
  }

  const processed = processOCRLines(result.lines);

  // Find best title candidate
  let bestTitle: ProcessedLine | null = null;
  let titleSource: ExtractedMetadata['titleSource'] = 'ocr_heuristic';

  for (const line of processed) {
    if (line.lineType === 'title' || (line.lineType === 'unknown' && line.score > 0.3)) {
      if (!bestTitle || line.score > bestTitle.score) {
        bestTitle = line;
      }
    }
  }

  // If no title found by score, use the native titleCandidate
  if (!bestTitle && result.titleCandidate) {
    bestTitle = {
      original: result.titleCandidate,
      normalized: normalizeText(result.titleCandidate),
      confidence: result.avgConfidence,
      lineType: 'title',
      score: 0.5,
    };
    titleSource = 'ocr_heuristic';
  }

  // If still no title, use first non-noise line
  if (!bestTitle) {
    const firstValid = processed.find(p => p.lineType !== 'noise');
    if (firstValid) {
      bestTitle = firstValid;
      titleSource = 'position';
    }
  }

  // Find best author candidate
  let bestAuthor: ProcessedLine | null = null;
  let authorSource: ExtractedMetadata['authorSource'] = null;

  // First check for "by" prefix
  for (const line of processed) {
    const authorFromBy = extractAuthorFromByPrefix(line.original);
    if (authorFromBy) {
      bestAuthor = {
        original: authorFromBy,
        normalized: normalizeText(authorFromBy),
        confidence: line.confidence,
        lineType: 'author',
        score: 0.8,
      };
      authorSource = 'by_prefix';
      break;
    }
  }

  // If no "by" prefix, look for person names
  if (!bestAuthor) {
    for (const line of processed) {
      if (line.lineType === 'author' && line.score > 0.4) {
        if (!bestAuthor || line.score > bestAuthor.score) {
          bestAuthor = line;
          authorSource = 'person_pattern';
        }
      }
    }
  }

  // If still no author, use native authorCandidate
  if (!bestAuthor && result.authorCandidate) {
    bestAuthor = {
      original: result.authorCandidate,
      normalized: normalizeText(result.authorCandidate),
      confidence: result.avgConfidence,
      lineType: 'author',
      score: 0.5,
    };
    authorSource = 'ocr_heuristic';
  }

  return {
    title: bestTitle?.normalized || null,
    author: bestAuthor?.normalized || null,
    titleConfidence: bestTitle?.score || 0,
    authorConfidence: bestAuthor?.score || 0,
    titleSource,
    authorSource,
  };
}

// ============================================================================
// Session-Level Aggregation
// ============================================================================

/**
 * Aggregate metadata across all crops in a session
 * Uses voting to find consensus on title and author
 */
export function aggregateSessionMetadata(
  results: Record<number, OCRResult>
): SessionAggregation {
  const titleVotes = new Map<string, number>();
  const authorVotes = new Map<string, number>();
  let cropCount = 0;

  for (const [, result] of Object.entries(results)) {
    if (!result.ok) continue;
    cropCount++;

    const metadata = extractMetadataFromOCR(result);

    // Vote for title (normalized, lowercase for matching)
    if (metadata.title) {
      const titleKey = metadata.title.toLowerCase().trim();
      const currentVotes = titleVotes.get(titleKey) || 0;
      titleVotes.set(titleKey, currentVotes + metadata.titleConfidence);
    }

    // Vote for author (normalized, lowercase for matching)
    if (metadata.author) {
      const authorKey = metadata.author.toLowerCase().trim();
      const currentVotes = authorVotes.get(authorKey) || 0;
      authorVotes.set(authorKey, currentVotes + metadata.authorConfidence);
    }
  }

  // Find best title by votes
  let bestTitle: string | null = null;
  let bestTitleVotes = 0;
  for (const [title, votes] of titleVotes) {
    if (votes > bestTitleVotes) {
      bestTitleVotes = votes;
      bestTitle = title;
    }
  }

  // Find best author by votes
  let bestAuthor: string | null = null;
  let bestAuthorVotes = 0;
  for (const [author, votes] of authorVotes) {
    if (votes > bestAuthorVotes) {
      bestAuthorVotes = votes;
      bestAuthor = author;
    }
  }

  // Convert back to title case for display
  const titleCase = (s: string | null): string | null => {
    if (!s) return null;
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  };

  return {
    bestTitle: titleCase(bestTitle),
    bestAuthor: titleCase(bestAuthor),
    titleVotes,
    authorVotes,
    cropCount,
    processedAt: new Date().toISOString(),
  };
}

/**
 * Get the final book metadata for a session
 * Combines OCR results with any user edits
 */
export function getFinalSessionMetadata(
  results: Record<number, OCRResult>,
  userEdits?: Record<number, { title?: string; author?: string }>
): {
  title: string | null;
  author: string | null;
  source: 'user_edit' | 'aggregation' | 'single_crop';
} {
  // Check for user edits first (highest priority)
  if (userEdits) {
    for (const edit of Object.values(userEdits)) {
      if (edit.title || edit.author) {
        return {
          title: edit.title || null,
          author: edit.author || null,
          source: 'user_edit',
        };
      }
    }
  }

  // Aggregate from OCR results
  const aggregation = aggregateSessionMetadata(results);

  if (aggregation.cropCount === 0) {
    return {
      title: null,
      author: null,
      source: 'aggregation',
    };
  }

  if (aggregation.cropCount === 1) {
    return {
      title: aggregation.bestTitle,
      author: aggregation.bestAuthor,
      source: 'single_crop',
    };
  }

  return {
    title: aggregation.bestTitle,
    author: aggregation.bestAuthor,
    source: 'aggregation',
  };
}
