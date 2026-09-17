/**
 * Spine Title/Author Assembler (Gate 8)
 *
 * Assembles final title and author candidates from labeled lines:
 * - Main title + subtitle join rules
 * - Combined line splitting (Author • Title, Title - Author)
 * - Multiple author detection (Author1 and Author2)
 * - Ranked candidate pairs
 *
 * Produces ExtractedFields with debug info.
 */

import type { LineLabel, LineLabelingResult } from './spineLineLabeler';
import { detectByPattern, scoreAsName } from './spineLineLabeler';

// ============================================================================
// Types
// ============================================================================

export interface TitleAssembly {
  /** Main title text */
  mainTitle: string;
  /** Subtitle (if detected) */
  subtitle?: string;
  /** Full combined title */
  fullTitle: string;
  /** Confidence score */
  confidence: number;
  /** Source line indices */
  sourceLineIndices: number[];
  /** Assembly method */
  method: 'single_line' | 'joined_lines' | 'split_from_combined';
}

export interface AuthorAssembly {
  /** Primary author name */
  primaryAuthor: string;
  /** Additional authors */
  additionalAuthors: string[];
  /** Full author string */
  fullAuthor: string;
  /** Confidence score */
  confidence: number;
  /** Source line indices */
  sourceLineIndices: number[];
  /** Assembly method */
  method: 'single_line' | 'by_pattern' | 'split_from_combined' | 'multiple_lines';
}

export interface TitleAuthorPairing {
  /** Assembled title */
  title: TitleAssembly;
  /** Assembled author */
  author: AuthorAssembly;
  /** Combined confidence */
  confidence: number;
  /** Pairing score (used for ranking) */
  pairingScore: number;
}

export interface AssemblyResult {
  /** Ranked title-author pairings */
  pairings: TitleAuthorPairing[];
  /** Best title (if any) */
  bestTitle?: TitleAssembly;
  /** Best author (if any) */
  bestAuthor?: AuthorAssembly;
  /** Best pairing (if any) */
  bestPairing?: TitleAuthorPairing;
  /** Debug info */
  debug: AssemblyDebug;
}

export interface AssemblyDebug {
  /** Number of title candidates considered */
  titleCandidates: number;
  /** Number of author candidates considered */
  authorCandidates: number;
  /** Number of ambiguous lines */
  ambiguousLines: number;
  /** Combined lines detected */
  combinedLinesDetected: number;
  /** Assembly strategy used */
  strategy: string;
}

// ============================================================================
// Configuration
// ============================================================================

/** Separators for combined title-author lines */
const COMBINED_SEPARATORS = [
  { sep: ' • ', priority: 1 },
  { sep: ' · ', priority: 1 },
  { sep: ' | ', priority: 2 },
  { sep: ' - ', priority: 3 },
  { sep: ' – ', priority: 3 },
  { sep: ' — ', priority: 3 },
  { sep: ' / ', priority: 4 },
  { sep: ': ', priority: 5 }, // Usually subtitle, not author
];

/** Subtitle indicators */
const SUBTITLE_INDICATORS = [': ', ' - ', ' – ', ' — '];

/** Multiple author separators */
const AUTHOR_SEPARATORS = [' and ', ' & ', ', ', ' with ', ' ve '];

/** Maximum characters for a name part (first name, last name, etc.) */
const MAX_NAME_PART_LENGTH = 20;

/** Minimum characters for a potential name part */
const MIN_NAME_PART_LENGTH = 2;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Try to split a combined line into title and author
 */
function trySplitCombined(
  text: string
): { title: string; author: string; separator: string } | null {
  for (const { sep } of COMBINED_SEPARATORS.sort((a, b) => a.priority - b.priority)) {
    // Skip colon - it's typically Title: Subtitle, not Title: Author
    if (sep === ': ') continue;

    if (text.includes(sep)) {
      const parts = text.split(sep).map(p => p.trim()).filter(p => p.length > 0);

      if (parts.length === 2) {
        const [left, right] = parts;

        // Check if one looks like an author
        const { hasBy: leftHasBy } = detectByPattern(left);
        const { hasBy: rightHasBy } = detectByPattern(right);

        // "by Author • Title" pattern
        if (leftHasBy) {
          const authorPart = left.replace(/^(?:by|BY|By)\s+/i, '');
          return { author: authorPart, title: right, separator: sep };
        }

        // "Title • by Author" pattern
        if (rightHasBy) {
          const authorPart = right.replace(/^(?:by|BY|By)\s+/i, '');
          return { title: left, author: authorPart, separator: sep };
        }

        // Use name detection heuristics
        const leftNameScore = scoreAsName(left);
        const rightNameScore = scoreAsName(right);

        // IMPORTANT: If neither side looks like a name, this is probably
        // Title - Subtitle, not Title - Author. Don't split.
        // Use a higher threshold to be conservative - we need at least one
        // side to CLEARLY look like a person's name.
        const minNameScore = 0.55;
        const hasConfidentAuthor = leftNameScore >= minNameScore || rightNameScore >= minNameScore;
        if (!hasConfidentAuthor) {
          // Neither side confidently looks like an author name - skip this separator
          continue;
        }

        // If name scores are significantly different, use that
        if (Math.abs(leftNameScore - rightNameScore) > 0.1) {
          if (leftNameScore > rightNameScore) {
            return { author: left, title: right, separator: sep };
          } else {
            return { title: left, author: right, separator: sep };
          }
        }

        // Fall back to word count heuristic
        const leftWords = left.split(/\s+/).length;
        const rightWords = right.split(/\s+/).length;

        // "Title - Author" (right is shorter, likely name)
        if (rightWords <= 3 && leftWords > rightWords && rightNameScore >= minNameScore) {
          return { title: left, author: right, separator: sep };
        }

        // "Author - Title" (left is shorter, likely name)
        if (leftWords <= 3 && rightWords > leftWords && leftNameScore >= minNameScore) {
          return { author: left, title: right, separator: sep };
        }

        // Last resort: if one has significantly higher name score, use that
        if (leftNameScore > 0.5 || rightNameScore > 0.5) {
          if (leftNameScore > rightNameScore) {
            return { author: left, title: right, separator: sep };
          } else {
            return { title: left, author: right, separator: sep };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extract subtitle from title if present
 */
function extractSubtitle(title: string): { main: string; subtitle?: string } {
  for (const indicator of SUBTITLE_INDICATORS) {
    const idx = title.indexOf(indicator);
    if (idx > 0 && idx < title.length - indicator.length) {
      return {
        main: title.substring(0, idx).trim(),
        subtitle: title.substring(idx + indicator.length).trim(),
      };
    }
  }
  return { main: title };
}

/**
 * Parse multiple authors from a string
 */
function parseMultipleAuthors(authorStr: string): string[] {

  // Check for separators
  for (const sep of AUTHOR_SEPARATORS) {
    if (authorStr.toLowerCase().includes(sep.toLowerCase())) {
      const parts = authorStr.split(new RegExp(sep, 'i')).map(p => p.trim()).filter(p => p.length > 0);
      if (parts.length > 1) {
        return parts;
      }
    }
  }

  // Single author
  return [authorStr];
}

/**
 * Assemble title from labeled lines
 */
function assembleTitle(titleLines: LineLabel[]): TitleAssembly | null {
  if (titleLines.length === 0) return null;

  // Take top candidate
  const top = titleLines[0];
  const text = top.filteredLine.line.text.trim();
  const { main, subtitle } = extractSubtitle(text);

  return {
    mainTitle: main,
    subtitle,
    fullTitle: text,
    confidence: top.confidence * top.titleScore,
    sourceLineIndices: [top.filteredLine.lineIndex],
    method: 'single_line',
  };
}

/**
 * Check if a text looks like a single name part (first name, last name, etc.)
 */
function isNamePart(text: string): boolean {
  const trimmed = text.trim();
  // Name parts are typically 2-20 chars, start with capital, no digits
  if (trimmed.length < MIN_NAME_PART_LENGTH || trimmed.length > MAX_NAME_PART_LENGTH) {
    return false;
  }
  // Should start with capital letter
  if (!/^[A-Z]/.test(trimmed)) {
    return false;
  }
  // Should not contain digits
  if (/\d/.test(trimmed)) {
    return false;
  }
  // Should be a single word (possibly with punctuation like "O'Brien" or "Jr.")
  const words = trimmed.split(/\s+/);
  return words.length <= 2;
}

/**
 * Try to join consecutive author lines into a single name
 * e.g., "Laura" + "Bates" -> "Laura Bates"
 */
function tryJoinAuthorLines(authorLines: LineLabel[]): {
  joinedName: string;
  sourceIndices: number[];
  confidence: number;
} | null {
  if (authorLines.length < 2) return null;

  // Sort by position (line index)
  const sorted = [...authorLines].sort(
    (a, b) => a.filteredLine.lineIndex - b.filteredLine.lineIndex
  );

  // Look for consecutive short name parts
  const nameParts: Array<{ text: string; index: number; confidence: number }> = [];

  for (const line of sorted) {
    const text = line.filteredLine.line.text.trim();

    // Check if this looks like a name part
    if (isNamePart(text)) {
      // Check if consecutive with previous
      if (nameParts.length > 0) {
        const lastIndex = nameParts[nameParts.length - 1].index;
        const currentIndex = line.filteredLine.lineIndex;

        // Allow gap of up to 2 lines (for possible noise in between)
        if (currentIndex - lastIndex <= 2) {
          nameParts.push({
            text,
            index: currentIndex,
            confidence: line.confidence * line.authorScore,
          });
        }
      } else {
        nameParts.push({
          text,
          index: line.filteredLine.lineIndex,
          confidence: line.confidence * line.authorScore,
        });
      }
    }
  }

  // We need at least 2 parts to join
  if (nameParts.length >= 2) {
    const joinedName = nameParts.map(p => p.text).join(' ');
    const avgConfidence = nameParts.reduce((sum, p) => sum + p.confidence, 0) / nameParts.length;

    // Verify the joined name looks like a real name
    if (scoreAsName(joinedName) > 0.5) {
      return {
        joinedName,
        sourceIndices: nameParts.map(p => p.index),
        confidence: avgConfidence,
      };
    }
  }

  return null;
}

/**
 * Assemble author from labeled lines
 */
function assembleAuthor(authorLines: LineLabel[]): AuthorAssembly | null {
  if (authorLines.length === 0) return null;

  // Strategy 1: Try to join multiple short name parts
  const joinResult = tryJoinAuthorLines(authorLines);
  if (joinResult) {
    const authorList = parseMultipleAuthors(joinResult.joinedName);
    return {
      primaryAuthor: authorList[0],
      additionalAuthors: authorList.slice(1),
      fullAuthor: joinResult.joinedName,
      confidence: joinResult.confidence,
      sourceLineIndices: joinResult.sourceIndices,
      method: 'multiple_lines',
    };
  }

  // Strategy 2: Take top candidate as single author
  const top = authorLines[0];
  let text = top.filteredLine.line.text.trim();

  // Check for "by" pattern and strip
  const { hasBy, extractedAuthor } = detectByPattern(text);
  if (hasBy && extractedAuthor) {
    text = extractedAuthor;
  }

  const authorList = parseMultipleAuthors(text);

  return {
    primaryAuthor: authorList[0],
    additionalAuthors: authorList.slice(1),
    fullAuthor: text,
    confidence: top.confidence * top.authorScore,
    sourceLineIndices: [top.filteredLine.lineIndex],
    method: hasBy ? 'by_pattern' : 'single_line',
  };
}

/**
 * Try to create pairing from combined line
 */
function tryPairingFromCombined(
  line: LineLabel
): TitleAuthorPairing | null {
  const text = line.filteredLine.line.text.trim();
  const split = trySplitCombined(text);

  if (split) {
    const { main, subtitle } = extractSubtitle(split.title);
    const authorList = parseMultipleAuthors(split.author);

    const title: TitleAssembly = {
      mainTitle: main,
      subtitle,
      fullTitle: split.title,
      confidence: line.confidence * 0.8, // Slightly lower for splits
      sourceLineIndices: [line.filteredLine.lineIndex],
      method: 'split_from_combined',
    };

    const author: AuthorAssembly = {
      primaryAuthor: authorList[0],
      additionalAuthors: authorList.slice(1),
      fullAuthor: split.author,
      confidence: line.confidence * 0.8,
      sourceLineIndices: [line.filteredLine.lineIndex],
      method: 'split_from_combined',
    };

    return {
      title,
      author,
      confidence: (title.confidence + author.confidence) / 2,
      pairingScore: line.confidence * 0.9,
    };
  }

  return null;
}

// ============================================================================
// Main Assembly Function
// ============================================================================

/**
 * Assemble title and author from labeled lines
 *
 * @param labelingResult - Result from spineLineLabeler
 * @returns Assembly result with ranked pairings
 */
export function assembleTitleAuthor(labelingResult: LineLabelingResult): AssemblyResult {
  const pairings: TitleAuthorPairing[] = [];
  let combinedLinesDetected = 0;

  const { titleLines, authorLines, ambiguousLines, labeledLines } = labelingResult;

  // Strategy 1: Check for combined lines in ambiguous/all lines
  for (const line of labeledLines) {
    const pairing = tryPairingFromCombined(line);
    if (pairing) {
      pairings.push(pairing);
      combinedLinesDetected++;
    }
  }

  // Strategy 2: Pair best title with best author
  const bestTitleAssembly = assembleTitle(titleLines);
  const bestAuthorAssembly = assembleAuthor(authorLines);

  if (bestTitleAssembly && bestAuthorAssembly) {
    // Check they're from different lines
    const titleLineIdx = bestTitleAssembly.sourceLineIndices[0];
    const authorLineIdx = bestAuthorAssembly.sourceLineIndices[0];

    if (titleLineIdx !== authorLineIdx) {
      pairings.push({
        title: bestTitleAssembly,
        author: bestAuthorAssembly,
        confidence: (bestTitleAssembly.confidence + bestAuthorAssembly.confidence) / 2,
        pairingScore: bestTitleAssembly.confidence * bestAuthorAssembly.confidence,
      });
    }
  }

  // Strategy 3: Use ambiguous lines as fallback
  if (pairings.length === 0 && ambiguousLines.length > 0) {
    // Try first ambiguous as title, second as author
    if (ambiguousLines.length >= 2) {
      const firstText = ambiguousLines[0].filteredLine.line.text.trim();
      const secondText = ambiguousLines[1].filteredLine.line.text.trim();
      const { main, subtitle } = extractSubtitle(firstText);

      const title: TitleAssembly = {
        mainTitle: main,
        subtitle,
        fullTitle: firstText,
        confidence: 0.4,
        sourceLineIndices: [ambiguousLines[0].filteredLine.lineIndex],
        method: 'single_line',
      };

      const authorList = parseMultipleAuthors(secondText);
      const author: AuthorAssembly = {
        primaryAuthor: authorList[0],
        additionalAuthors: authorList.slice(1),
        fullAuthor: secondText,
        confidence: 0.4,
        sourceLineIndices: [ambiguousLines[1].filteredLine.lineIndex],
        method: 'single_line',
      };

      pairings.push({
        title,
        author,
        confidence: 0.4,
        pairingScore: 0.3,
      });
    }
  }

  // Sort pairings by score
  pairings.sort((a, b) => b.pairingScore - a.pairingScore);

  // Determine best outputs
  const bestPairing = pairings.length > 0 ? pairings[0] : undefined;
  const bestTitle = bestPairing?.title || bestTitleAssembly || undefined;
  const bestAuthor = bestPairing?.author || bestAuthorAssembly || undefined;

  // Determine strategy used
  let strategy = 'none';
  if (combinedLinesDetected > 0) {
    strategy = 'combined_split';
  } else if (bestTitleAssembly && bestAuthorAssembly) {
    strategy = 'separate_lines';
  } else if (ambiguousLines.length > 0) {
    strategy = 'ambiguous_fallback';
  }

  return {
    pairings,
    bestTitle,
    bestAuthor,
    bestPairing,
    debug: {
      titleCandidates: titleLines.length,
      authorCandidates: authorLines.length,
      ambiguousLines: ambiguousLines.length,
      combinedLinesDetected,
      strategy,
    },
  };
}

/**
 * Quick assembly from text lines (convenience function)
 */
export function quickAssemble(lines: string[]): {
  title: string | null;
  author: string | null;
} {
  // Simple heuristic: first line is title, look for "by" pattern for author
  let title: string | null = null;
  let author: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for combined line with separator (but skip colon - it's usually subtitle, not author)
    for (const { sep } of COMBINED_SEPARATORS.sort((a, b) => a.priority - b.priority)) {
      // Skip colon - it's typically Title: Subtitle, not Author: Title
      if (sep === ': ') continue;

      if (trimmed.includes(sep)) {
        const parts = trimmed.split(sep).map(p => p.trim()).filter(p => p.length > 0);
        if (parts.length === 2) {
          const [left, right] = parts;

          // Use simple heuristics: shorter part is more likely author
          const leftWords = left.split(/\s+/).length;
          const rightWords = right.split(/\s+/).length;

          // Use name detection to determine which is author
          const leftNameScore = scoreAsName(left);
          const rightNameScore = scoreAsName(right);

          // If name scores are significantly different, use that
          if (Math.abs(leftNameScore - rightNameScore) > 0.1) {
            if (leftNameScore > rightNameScore) {
              return { author: left, title: right };
            } else {
              return { title: left, author: right };
            }
          }

          // Fall back to word count heuristic
          // If left is shorter (2-3 words), likely "Author • Title"
          if (leftWords <= 3 && rightWords > leftWords) {
            return { author: left, title: right };
          }
          // If right is shorter (2-3 words), likely "Title - Author"
          if (rightWords <= 3 && leftWords > rightWords) {
            return { title: left, author: right };
          }
          // Default: left is author, right is title (common pattern)
          return { author: left, title: right };
        }
      }
    }

    // Check for "by" pattern
    const { hasBy, extractedAuthor } = detectByPattern(trimmed);
    if (hasBy && extractedAuthor) {
      author = extractedAuthor;
      continue;
    }

    // First non-author line is likely title
    if (!title) {
      title = trimmed;
    }
  }

  return { title, author };
}
