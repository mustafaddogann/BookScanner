/**
 * Title/Author Extraction Service
 *
 * Advanced extraction logic for reconstructing titles and authors from OCR evidence.
 * Handles:
 * - Multi-line title reconstruction (e.g., "THE" + "BURIED" -> "THE BURIED")
 * - Colon-separated patterns (e.g., "THE FINGERPRINT: Patricia Wentworth")
 * - All-caps author detection (e.g., "JOHN GRISHAM")
 * - Publisher/marketing noise filtering
 * - Role scoring to prevent title/author misassignment
 * - Stopword bridge joins for fragmented titles
 */

import {
  getRoleScore,
  scoreTitleLikeness,
  scorePersonLikeness,
  buildJoinedTitleCandidates,
  shouldOverridePersonAsTitle,
  checkPersonOverride,
  shouldRejectAsAuthor,
  type RoleScore,
  type PersonOverrideResult,
} from './roleScoring';

// ============================================================================
// Publisher and Marketing Blocklists
// ============================================================================

/**
 * Publisher names and imprints to filter out
 */
export const PUBLISHER_BLOCKLIST = new Set([
  'zebra',
  'bantam',
  'dell',
  'penguin',
  'random',
  'house',
  'harper',
  'collins',
  'harpercollins',
  'simon',
  'schuster',
  'macmillan',
  'hachette',
  'scholastic',
  'vintage',
  'anchor',
  'knopf',
  'doubleday',
  'berkley',
  'putnam',
  'ace',
  'tor',
  'forge',
  'orbit',
  'daw',
  'baen',
  'ballantine',
  'fawcett',
  'avon',
  'morrow',
  'little',
  'brown',
  'grand',
  'central',
  'atria',
  'pocket',
  'gallery',
  'st',
  'martins',
  'press',
  'books',
  'publishers',
  'publishing',
  'jove',      // Jove Books imprint
  'jovi',      // OCR error for Jove
  'visica',    // OCR corruption (possibly VISION)
  'signet',    // Signet Books imprint
  'onyx',      // Onyx Books imprint
  'roc',       // Roc Books imprint
  'topaz',     // Topaz Books imprint
  'warner',    // Warner Books
  'pinnacle',  // Pinnacle Books
  // Note: Removed 'pelican' - too commonly part of titles like "THE PELICAN BRIEF"
]);

/**
 * Genre labels that appear on book spines but are NOT titles
 */
const GENRE_LABELS = new Set([
  'mystery',
  'thriller',
  'romance',
  'fiction',
  'nonfiction',
  'non-fiction',
  'horror',
  'fantasy',
  'sci-fi',
  'science fiction',
  'western',
  'suspense',
  'crime',
  'adventure',
  'biography',
  'memoir',
  'history',
  'classics',
  'classic',
  'literature',
]);

/**
 * Marketing phrases to filter out (case-insensitive matching)
 */
export const MARKETING_BLOCKLIST = [
  'new york times',
  'nyt',
  'bestseller',
  'bestselling',
  'best seller',
  'best-seller',
  '#1',
  '*1',
  'no. 1',
  'number one',
  'international',
  'national',
  'million copies',
  'award winning',
  'award-winning',
  'pulitzer',
  'oprah',
  'book club',
  'reese',
  'now a',
  'soon to be',
  'major motion',
  'netflix',
  'hbo',
  'amazon',
  'prime',
  'usa today',
  'wall street journal',
  'author of',
];

/**
 * Marketing badge patterns that form complete badges when adjacent
 * Key: normalized line -> matches with adjacent patterns
 */
const MARKETING_BADGE_PAIRS: Record<string, string[]> = {
  'new york times': ['bestseller', 'bestselling', 'best seller', '#1', '*1', 'no. 1'],
  // Common OCR errors for "NEW YORK"
  'new fork times': ['bestseller', 'bestselling', 'best seller', '#1', '*1', 'no. 1'],
  'new vork times': ['bestseller', 'bestselling', 'best seller', '#1', '*1', 'no. 1'],
  'usa today': ['bestseller', 'bestselling', 'best seller', '#1', '*1', 'no. 1'],
  'wall street journal': ['bestseller', 'bestselling', 'best seller', '#1', '*1', 'no. 1'],
  '#1': ['bestseller', 'bestselling', 'best seller', 'new york times', 'usa today'],
  '*1': ['bestseller', 'bestselling', 'best seller', 'new york times', 'usa today'],
  'no. 1': ['bestseller', 'bestselling', 'best seller', 'new york times', 'usa today'],
  'national': ['bestseller', 'bestselling', 'best seller'],
  'international': ['bestseller', 'bestselling', 'best seller'],
  // "TIMES" alone when adjacent to bestseller indicators
  'times': ['bestseller', 'bestselling', 'best seller', '#1', '*1', 'no. 1'],
  // "BESTSELLER" when adjacent to newspaper names
  'bestseller': ['times', 'new york', 'new fork', 'usa today', 'wall street'],
  'bestselling': ['times', 'new york', 'new fork', 'usa today', 'wall street'],
};

/**
 * Patterns that indicate a line is part of a multi-line marketing badge
 * These are checked when a line is within 2 positions of a known badge
 */
const BADGE_CONTEXT_WORDS = new Set([
  'new', 'york', 'fork', 'vork', // NEW YORK (and OCR variants)
  'times', 'today', 'journal',   // Newspaper names
  'usa', 'wall', 'street',       // More newspaper parts
  '#1', '*1', 'no.', '1',        // Number indicators
]);

/**
 * Organization markers that disqualify a line from being an author
 */
const ORG_MARKERS = new Set([
  'press',
  'publishing',
  'publishers',
  'inc',
  'ltd',
  'llc',
  'company',
  'co.',
  'corp',
  'corporation',
  'times',
  'journal',
  'today',
  'news',
  'media',
  'group',
  'foundation',
  'institute',
  'university',
  'college',
  'entertainment',
]);

/**
 * Common leading stopwords that often start titles
 */
const TITLE_STOPWORDS = new Set(['the', 'a', 'an']);

/**
 * Words that indicate line is NOT an author name
 * (Should be synced with TITLE_CONTENT_WORDS in roleScoring.ts)
 */
const NON_AUTHOR_WORDS = new Set([
  // Articles and prepositions
  'the', 'a', 'an', 'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by',
  'from', 'and', 'or', 'into',
  // Common title content words (sync with TITLE_CONTENT_WORDS)
  'darkness', 'night', 'day', 'death', 'life', 'blood', 'fire', 'ice',
  'storm', 'shadow', 'secret', 'last', 'first', 'final', 'dead', 'dark',
  'lost', 'fallen', 'broken', 'silent', 'hidden', 'buried', 'forgotten',
  'guardian', 'guardians', 'fingerprint', 'pelican', 'brief', 'game',
  'girl', 'boy', 'man', 'woman', 'wife', 'husband', 'gone', 'poison',
  'pen', 'shining', 'rising', 'falling', 'house', 'castle', 'kingdom',
  'city', 'world', 'land', 'book', 'story', 'tale', 'legend', 'mystery',
  'thriller',
]);

// ============================================================================
// Text Cleanup Helpers
// ============================================================================

/**
 * Clean up possessive noise and OCR artifacts from author names
 * - "Wentworth s" -> "Wentworth"
 * - "Grisham," -> "Grisham"
 * - "Wentworth's" -> "Wentworth" (remove trailing possessive)
 */
export function cleanupPossessiveNoise(text: string): string {
  let result = text.trim();

  // Remove trailing isolated "s" (OCR artifact from possessive)
  result = result.replace(/\s+s\s*$/i, '');

  // Remove trailing 's or 's (possessive apostrophe)
  result = result.replace(/['']s\s*$/i, '');

  // Remove trailing punctuation (comma, period, etc.)
  result = result.replace(/[,.:;!?]+$/, '');

  // Remove leading punctuation/dashes
  result = result.replace(/^[-–—:]+\s*/, '');

  return result.trim();
}

/**
 * Check if a line is purely publisher/marketing noise
 */
export function isPublisherOrMarketing(line: string): boolean {
  const lower = line.toLowerCase().trim();

  // Check publisher blocklist (single-word match)
  const words = lower.split(/\s+/);
  if (words.length <= 2) {
    const allPublisher = words.every(w => PUBLISHER_BLOCKLIST.has(w));
    if (allPublisher) return true;
  }

  // Check marketing phrases
  for (const phrase of MARKETING_BLOCKLIST) {
    if (lower.includes(phrase)) return true;
  }

  return false;
}

/**
 * Check if a line contains organization markers (disqualifies from being author)
 * @param line - The text line to check
 * @returns true if line contains ORG markers like PRESS, PUBLISHING, INC, TIMES, etc.
 */
export function isOrgLikeLine(line: string): boolean {
  const lower = line.toLowerCase().trim();
  const words = lower.split(/\s+/);

  for (const word of words) {
    // Remove punctuation for matching
    const cleanWord = word.replace(/[.,;:!?]/g, '');
    if (ORG_MARKERS.has(cleanWord)) {
      return true;
    }
  }

  // Check for manufacturing/printing notices (not person names or titles)
  // These appear on book spines/back covers: "PRINTED IN USA", "MADE IN CHINA", etc.
  // OCR often captures partial: "TED IN USA" (from "PRINTED IN USA")
  const printingPatterns = [
    /\bin\s+usa\b/i,
    /\bin\s+china\b/i,
    /\bin\s+uk\b/i,
    /\bprinted\s+in\b/i,
    /\bmade\s+in\b/i,
    /\bmanufactured\s+in\b/i,
  ];
  if (printingPatterns.some(pattern => pattern.test(lower))) {
    return true;
  }

  return false;
}

/**
 * Result of marketing badge check with neighbor context
 */
export interface MarketingBadgeResult {
  /** Whether this line is a marketing badge */
  isBadge: boolean;
  /** Reason for classification */
  reason: string;
  /** Indices of adjacent lines that form part of the badge (for exclusion) */
  relatedLineIndices: number[];
}

/**
 * Check if a line is a marketing badge, considering adjacent lines (neighbor rule)
 *
 * Rules:
 * - Hard exclude if line matches any MARKETING_BLOCKLIST phrase
 * - If line matches a badge pair key (e.g., "NEW YORK TIMES"), check adjacent lines
 *   for complementary patterns (e.g., "BESTSELLER") - both should be excluded
 * - Extended range: check up to 2 lines away for multi-line badges
 *
 * @param lineIndex - Index of line being checked
 * @param lines - All lines for neighbor context
 * @returns MarketingBadgeResult with badge status and related line indices
 */
export function isMarketingBadgeWithNeighbors(
  lineIndex: number,
  lines: string[]
): MarketingBadgeResult {
  const line = lines[lineIndex]?.trim() ?? '';
  const lower = line.toLowerCase();

  // Check direct marketing phrase match
  for (const phrase of MARKETING_BLOCKLIST) {
    if (lower.includes(phrase)) {
      return {
        isBadge: true,
        reason: `contains_marketing_phrase:${phrase}`,
        relatedLineIndices: [],
      };
    }
  }

  // Check badge pair patterns (neighbor rule) - extended to 2 lines
  for (const [keyPattern, complementPatterns] of Object.entries(MARKETING_BADGE_PAIRS)) {
    if (lower.includes(keyPattern)) {
      // Check nearby lines (-2 to +2) for complement
      const nearbyIndices = [-2, -1, 1, 2]
        .map(offset => lineIndex + offset)
        .filter(i => i >= 0 && i < lines.length);

      const relatedIndices: number[] = [];
      for (const nearIdx of nearbyIndices) {
        const nearLower = lines[nearIdx]?.toLowerCase().trim() ?? '';
        for (const complement of complementPatterns) {
          if (nearLower.includes(complement)) {
            relatedIndices.push(nearIdx);
            break;
          }
        }
      }

      if (relatedIndices.length > 0) {
        // This line is part of a badge pair
        return {
          isBadge: true,
          reason: `badge_pair:${keyPattern}+nearby`,
          relatedLineIndices: relatedIndices,
        };
      }
    }
  }

  // Check if this line is the complement of a nearby badge key
  for (const [keyPattern, complementPatterns] of Object.entries(MARKETING_BADGE_PAIRS)) {
    for (const complement of complementPatterns) {
      if (lower.includes(complement)) {
        // Check nearby lines (-2 to +2) for the key pattern
        const nearbyIndices = [-2, -1, 1, 2]
          .map(offset => lineIndex + offset)
          .filter(i => i >= 0 && i < lines.length);

        for (const nearIdx of nearbyIndices) {
          const nearLower = lines[nearIdx]?.toLowerCase().trim() ?? '';
          if (nearLower.includes(keyPattern)) {
            return {
              isBadge: true,
              reason: `badge_pair_complement:${complement}+${keyPattern}`,
              relatedLineIndices: [nearIdx],
            };
          }
        }
      }
    }
  }

  // Additional check: if line contains badge context words and is near a confirmed badge
  const words = lower.split(/\s+/);
  const hasBadgeContextWord = words.some(w => BADGE_CONTEXT_WORDS.has(w));
  if (hasBadgeContextWord) {
    // Check if any nearby line is a direct marketing phrase
    const nearbyIndices = [-2, -1, 1, 2]
      .map(offset => lineIndex + offset)
      .filter(i => i >= 0 && i < lines.length);

    for (const nearIdx of nearbyIndices) {
      const nearLower = lines[nearIdx]?.toLowerCase().trim() ?? '';
      for (const phrase of MARKETING_BLOCKLIST) {
        if (nearLower.includes(phrase)) {
          return {
            isBadge: true,
            reason: `badge_context_near_marketing:${words.find(w => BADGE_CONTEXT_WORDS.has(w))}`,
            relatedLineIndices: [nearIdx],
          };
        }
      }
    }
  }

  return {
    isBadge: false,
    reason: 'not_badge',
    relatedLineIndices: [],
  };
}

/**
 * Get indices of all lines that should be excluded as marketing badges
 * @param lines - All OCR lines
 * @returns Set of line indices to exclude
 */
export function getMarketingBadgeIndices(lines: string[]): Set<number> {
  const excludedIndices = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const result = isMarketingBadgeWithNeighbors(i, lines);
    if (result.isBadge) {
      excludedIndices.add(i);
      for (const related of result.relatedLineIndices) {
        excludedIndices.add(related);
      }
    }
  }

  return excludedIndices;
}

/**
 * Check if a line looks like an all-caps author name candidate
 * Criteria:
 * - 2-4 tokens
 * - Mostly alphabetic (>85%)
 * - NOT starting with articles (THE, A, AN) - strong title indicator
 * - NOT dominated by title/publisher words
 * - Token length >= 2 each
 */
export function isAllCapsNameCandidate(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Must be mostly uppercase
  const upperCount = (trimmed.match(/[A-Z]/g) || []).length;
  const lowerCount = (trimmed.match(/[a-z]/g) || []).length;
  if (lowerCount > upperCount * 0.3) return false; // Allow some OCR errors

  const words = trimmed.split(/\s+/);

  // 2-4 words typical for author names
  if (words.length < 2 || words.length > 4) return false;

  // Lines starting with articles are NOT name candidates (strong title indicator)
  const firstWord = words[0].toLowerCase();
  if (TITLE_STOPWORDS.has(firstWord)) return false;

  // Check alphabetic ratio
  const letterCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const totalChars = trimmed.replace(/\s/g, '').length;
  if (totalChars === 0 || letterCount / totalChars < 0.85) return false;

  // Each word should be at least 2 chars
  if (!words.every(w => w.replace(/[^a-zA-Z]/g, '').length >= 2)) return false;

  // Not dominated by non-author words (title words)
  const lowerWords = words.map(w => w.toLowerCase());
  const nonAuthorCount = lowerWords.filter(w => NON_AUTHOR_WORDS.has(w)).length;
  if (nonAuthorCount > words.length / 2) return false;

  // Not a publisher
  if (isPublisherOrMarketing(trimmed)) return false;

  return true;
}

// ============================================================================
// Title Reconstruction
// ============================================================================

/**
 * Candidate title with metadata
 */
export interface TitleCandidate {
  text: string;
  tokens: string[];
  score: number;
  reasons: string[];
  sourceLines: string[];
}

/**
 * Build multi-line title candidates from adjacent lines
 *
 * Rules:
 * - Combine consecutive short lines (1-3 tokens) that look title-like
 * - Special handling for leading stopwords: "THE", "A", "AN"
 * - Skip publisher/marketing lines (with neighbor-aware badge detection)
 * - Score higher for 2-6 token combined titles
 */
export function buildTitleCandidates(lines: string[]): TitleCandidate[] {
  const candidates: TitleCandidate[] = [];

  // Pre-compute badge indices with neighbor awareness
  const badgeIndices = getMarketingBadgeIndices(lines);

  const cleanedLines = lines
    .map((l, i) => ({ text: l.trim(), originalIndex: i }))
    .filter(({ text, originalIndex }) =>
      text.length > 0 && !badgeIndices.has(originalIndex) && !isPublisherOrMarketing(text)
    )
    .map(({ text }) => text);

  if (cleanedLines.length === 0) return candidates;

  // Single-line candidates
  for (const line of cleanedLines) {
    const tokens = tokenizeLine(line);
    if (tokens.length >= 1 && tokens.length <= 6) {
      if (!isAllCapsNameCandidate(line)) {
        candidates.push({
          text: line,
          tokens,
          score: scoreTitleCandidate(tokens),
          reasons: ['single_line'],
          sourceLines: [line],
        });
      }
    }
  }

  // Multi-line combinations (adjacent lines)
  for (let i = 0; i < cleanedLines.length - 1; i++) {
    const line1 = cleanedLines[i];
    const line2 = cleanedLines[i + 1];

    // Skip if either looks like author name
    if (isAllCapsNameCandidate(line1) || isAllCapsNameCandidate(line2)) continue;

    const tokens1 = tokenizeLine(line1);
    const tokens2 = tokenizeLine(line2);

    // Combine if first line is short (1-2 tokens) or is a stopword
    const isStopwordLine = tokens1.length === 1 && TITLE_STOPWORDS.has(tokens1[0].toLowerCase());
    const isShortLine = tokens1.length <= 2;

    if ((isStopwordLine || isShortLine) && tokens2.length >= 1 && tokens2.length <= 4) {
      const combined = `${line1} ${line2}`;
      const combinedTokens = [...tokens1, ...tokens2];

      if (combinedTokens.length >= 2 && combinedTokens.length <= 6) {
        candidates.push({
          text: combined,
          tokens: combinedTokens,
          score: scoreTitleCandidate(combinedTokens) + 0.1, // Bonus for combination
          reasons: isStopwordLine ? ['stopword_combined'] : ['adjacent_combined'],
          sourceLines: [line1, line2],
        });
      }
    }
  }

  // Also combine ALL single-word lines into one candidate (for fragmented titles like PELICAN + BRIEF)
  const singleWordLines = cleanedLines.filter(l => {
    const tokens = tokenizeLine(l);
    return tokens.length === 1 && !isAllCapsNameCandidate(l);
  });
  if (singleWordLines.length >= 2 && singleWordLines.length <= 5) {
    const combined = singleWordLines.join(' ');
    const combinedTokens = singleWordLines.map(l => tokenizeLine(l)[0]);
    candidates.push({
      text: combined,
      tokens: combinedTokens,
      score: scoreTitleCandidate(combinedTokens) + 0.15, // Bonus for fragment reconstruction
      reasons: ['fragment_combined'],
      sourceLines: singleWordLines,
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

/**
 * Score a title candidate based on token count and quality
 */
function scoreTitleCandidate(tokens: string[]): number {
  if (tokens.length === 0) return 0;

  let score = 0;

  // Prefer 2-4 token titles (most common)
  if (tokens.length >= 2 && tokens.length <= 4) {
    score += 0.5;
  } else if (tokens.length === 1) {
    score += 0.2; // Single-word titles less confident
  } else if (tokens.length >= 5) {
    score += 0.3; // Longer titles OK but less common
  }

  // Bonus if starts with article (common title pattern)
  if (TITLE_STOPWORDS.has(tokens[0].toLowerCase())) {
    score += 0.2;
  }

  // Penalty for all-generic tokens
  const nonGenericCount = tokens.filter(t => !TITLE_STOPWORDS.has(t.toLowerCase())).length;
  score += nonGenericCount * 0.1;

  return Math.min(1, score);
}

/**
 * Simple tokenizer for title scoring
 */
function tokenizeLine(line: string): string[] {
  return line
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => t.replace(/[^\w'-]/g, ''))
    .filter(t => t.length > 0);
}

// ============================================================================
// Inline Title/Author Splitting
// ============================================================================

/**
 * Result of splitting an inline title+author line
 */
export interface InlineSplitResult {
  /** Whether a split was performed */
  didSplit: boolean;
  /** Extracted title (null if no split) */
  title: string | null;
  /** Extracted author (null if no split) */
  author: string | null;
  /** Confidence score [0-1] */
  confidence: number;
  /** Reason for split (or reason for not splitting) */
  reason: string;
}

/**
 * Split a line that contains both title and author inline
 *
 * Handles patterns like:
 * - "POISON IN THE PEN Patricia Wentworth" (title-like prefix + person-like suffix)
 * - "THE GUARDIANS JOHN GRISHAM" (title words + all-caps author)
 * - "Gone Girl by Gillian Flynn" (explicit " by " separator)
 *
 * Rules to prevent false splits:
 * - Don't split if suffix contains ORG markers (PRESS, TIMES, INC)
 * - Don't split if suffix matches marketing phrases
 * - Don't split if prefix is too short (< 2 words) or suffix too short (< 2 words)
 * - Require high confidence that suffix is a person name
 *
 * @param line - The line to potentially split
 * @returns InlineSplitResult with split title/author or reason for not splitting
 */
export function splitInlineTitleAuthor(line: string): InlineSplitResult {
  const trimmed = line.trim();

  if (!trimmed || trimmed.length < 5) {
    return { didSplit: false, title: null, author: null, confidence: 0, reason: 'too_short' };
  }

  // Pattern 1: Explicit " by " separator (case-insensitive)
  const byMatch = trimmed.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    const titlePart = byMatch[1].trim();
    const authorPart = cleanupPossessiveNoise(byMatch[2].trim());

    const titleWords = titlePart.split(/\s+/);
    const authorWords = authorPart.split(/\s+/);

    // Validate: title needs 1+ words, author needs 2-4 words
    if (titleWords.length >= 1 && authorWords.length >= 2 && authorWords.length <= 4) {
      // Check author part isn't ORG-like
      if (!isOrgLikeLine(authorPart) && !isPublisherOrMarketing(authorPart)) {
        return {
          didSplit: true,
          title: titlePart,
          author: authorPart,
          confidence: 0.9,
          reason: 'by_separator',
        };
      }
    }
  }

  // Pattern 2: Title-like prefix + person-like suffix
  // Look for transition from title words to name words
  const words = trimmed.split(/\s+/);

  if (words.length < 3) {
    return { didSplit: false, title: null, author: null, confidence: 0, reason: 'insufficient_words' };
  }

  // Try splitting at different points to find best title/author boundary
  // Start from position 1 (need at least 1 word for title) to len-2 (need at least 2 for author)
  let bestSplit: InlineSplitResult | null = null;
  let bestScore = 0;

  for (let splitIdx = 1; splitIdx <= words.length - 2; splitIdx++) {
    const titlePart = words.slice(0, splitIdx).join(' ');
    const authorPart = words.slice(splitIdx).join(' ');
    const authorWords = words.slice(splitIdx);
    const titleWords = words.slice(0, splitIdx);

    // Author must be 2-4 words
    if (authorWords.length < 2 || authorWords.length > 4) continue;

    // Check if author part looks like a person name
    const authorScore = scoreAsPersonName(authorPart);
    if (authorScore < 0.5) continue;

    // Check if title part looks title-like (not a name)
    const titleScore = scoreAsTitlePart(titlePart);
    if (titleScore < 0.3) continue;

    // Combined score with length bonus for title
    // Prefer longer titles when author scores are similar (more natural split point)
    const lengthBonus = Math.min(0.15, titleWords.length * 0.05);
    const combinedScore = (authorScore * 0.6) + (titleScore * 0.25) + lengthBonus;

    // Must pass minimum threshold
    if (combinedScore > bestScore && combinedScore >= 0.5) {
      bestScore = combinedScore;
      bestSplit = {
        didSplit: true,
        title: titlePart,
        author: cleanupPossessiveNoise(authorPart),
        confidence: Math.min(0.85, combinedScore),
        reason: 'title_author_boundary',
      };
    }
  }

  if (bestSplit) {
    return bestSplit;
  }

  return { didSplit: false, title: null, author: null, confidence: 0, reason: 'no_valid_split_point' };
}

/**
 * Score how likely a string is a person name
 * @returns score [0-1]
 */
function scoreAsPersonName(text: string): number {
  const words = text.trim().split(/\s+/);
  let score = 0;

  // Must be 2-4 words
  if (words.length < 2 || words.length > 4) return 0;

  // High alphabetic ratio required
  const letterCount = (text.match(/[a-zA-Z]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  const alphaRatio = totalChars > 0 ? letterCount / totalChars : 0;
  if (alphaRatio < 0.85) return 0;

  // Base score for valid word count
  score = 0.4;

  // Check for all-caps (common for author names on spines)
  const upperCount = (text.match(/[A-Z]/g) || []).length;
  const lowerCount = (text.match(/[a-z]/g) || []).length;
  if (upperCount > lowerCount * 2) {
    score += 0.3;
  }

  // Check for title-case pattern (First Last)
  const hasTitleCase = words.every((w) =>
    w.length <= 1 || (w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase())
  );
  if (hasTitleCase) {
    score += 0.2;
  }

  // Penalty for ORG markers
  if (isOrgLikeLine(text)) {
    score -= 0.5;
  }

  // Penalty for marketing phrases
  if (isPublisherOrMarketing(text)) {
    score -= 0.4;
  }

  // Penalty for words that are typically title words
  const titleLikeCount = words.filter((w) => NON_AUTHOR_WORDS.has(w.toLowerCase())).length;
  if (titleLikeCount > words.length / 2) {
    score -= 0.3;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Score how likely a string is a title (not an author name)
 * @returns score [0-1]
 */
function scoreAsTitlePart(text: string): number {
  const words = text.trim().split(/\s+/);
  let score = 0.3; // Base score

  // Starts with article = strong title signal
  if (TITLE_STOPWORDS.has(words[0].toLowerCase())) {
    score += 0.4;
  }

  // Contains prepositions/articles = title-like
  const hasArticleOrPrep = words.some((w) =>
    ['the', 'a', 'an', 'of', 'in', 'to', 'for', 'with', 'on', 'at'].includes(w.toLowerCase())
  );
  if (hasArticleOrPrep) {
    score += 0.2;
  }

  // More than 2 words = more likely title
  if (words.length > 2) {
    score += 0.1;
  }

  return Math.min(1, score);
}

// ============================================================================
// Junk Line Detection
// ============================================================================

/**
 * Patterns that indicate a line is junk (prices, fragments, noise)
 */
const JUNK_PATTERNS = [
  /^\$\d/,                           // Starts with price
  /\$\d+\.\d{2}$/,                   // Ends with price
  /^(?:us|uk|can|cdn)?\s*\$?\d+/i,   // Regional price at start
  /^isbn[-:\s]*$/i,                  // Just "ISBN" label
  /^\d{1,3}$/,                       // Just 1-3 digits
  /^[A-Z]{1,2}\d{1,4}$/,             // Library call number
  /^(?:bantam|dell|zebra|pocket)\s+\w{2,5}$/i, // Publisher + short fragment
  // ISBN patterns (10 or 13 digit, with or without dashes)
  /^\d[\d-]{8,16}\d$/,               // Full ISBN: 0-515-06011-9 or 9780515060119
  /^\d{1,5}-\d{1,7}-?$/,             // ISBN prefix fragment: 0-515- or 978-0-
  /^-?\d{4,7}-?\d?$/,                // ISBN suffix fragment: 06011-9 or -06011-9
];

/**
 * Check if a line is a genre label (not a title)
 */
export function isGenreLabel(line: string): boolean {
  const lower = line.toLowerCase().trim();
  return GENRE_LABELS.has(lower);
}

/**
 * Check if a line is junk that should be filtered
 *
 * Junk patterns:
 * - Price patterns: "$9.99", "US$14.95", "$193"
 * - Publisher fragments: "BANTAM STER", "DELL PUB"
 * - Short gibberish: "XYZ", "123"
 * - ISBN labels without numbers
 * - Single-word genre labels: "MYSTERY", "THRILLER", etc.
 * - Single-word publisher imprints: "JOVE", "ZEBRA", etc.
 *
 * @param line - The line to check
 * @returns true if line is junk, false if potentially useful
 */
export function isJunkLine(line: string): boolean {
  const trimmed = line.trim();

  // Empty or very short
  if (!trimmed || trimmed.length <= 2) {
    return true;
  }

  // Check junk patterns
  for (const pattern of JUNK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // Single-word genre labels should be filtered
  if (isGenreLabel(trimmed)) {
    return true;
  }

  // Check if mostly non-alphabetic (prices, codes)
  const letterCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const totalChars = trimmed.replace(/\s/g, '').length;
  const alphaRatio = totalChars > 0 ? letterCount / totalChars : 0;

  // Less than 50% letters and short = junk
  if (alphaRatio < 0.5 && trimmed.length < 10) {
    return true;
  }

  // Single word that's all publisher noise
  const words = trimmed.split(/\s+/);
  if (words.length === 1 && PUBLISHER_BLOCKLIST.has(trimmed.toLowerCase())) {
    return true;
  }

  // Two words that are both publisher noise
  if (words.length === 2) {
    const allPublisher = words.every((w) => PUBLISHER_BLOCKLIST.has(w.toLowerCase()));
    if (allPublisher) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Colon-Separated Pattern Extraction
// ============================================================================

/**
 * Result of parsing a colon-separated line
 */
export interface ColonSeparatedResult {
  title: string | null;
  author: string | null;
  confidence: number;
}

/**
 * Parse lines with "TITLE: Author Name" pattern
 *
 * Examples:
 * - "-THE FINGERPRINT: Patricia Wentworth s" -> title="THE FINGERPRINT", author="Patricia Wentworth"
 * - "The Great Gatsby: F. Scott Fitzgerald" -> title="The Great Gatsby", author="F. Scott Fitzgerald"
 */
export function parseColonSeparated(line: string): ColonSeparatedResult {
  // Must contain a colon
  if (!line.includes(':')) {
    return { title: null, author: null, confidence: 0 };
  }

  // Split on first colon
  const colonIndex = line.indexOf(':');
  let titlePart = line.slice(0, colonIndex).trim();
  let authorPart = line.slice(colonIndex + 1).trim();

  // Clean up title part (remove leading dashes, bullets)
  titlePart = titlePart.replace(/^[-–—•*]+\s*/, '').trim();

  // Clean up author part
  authorPart = cleanupPossessiveNoise(authorPart);

  // Validate: title should have 1-6 words, author should have 2-4 words
  const titleWords = titlePart.split(/\s+/).filter(w => w.length > 0);
  const authorWords = authorPart.split(/\s+/).filter(w => w.length > 0);

  if (titleWords.length < 1 || titleWords.length > 6) {
    return { title: null, author: null, confidence: 0 };
  }

  if (authorWords.length < 2 || authorWords.length > 4) {
    // Author part doesn't look like a name
    return { title: titlePart, author: null, confidence: 0.5 };
  }

  // Check if author part looks like a name (high alphabetic ratio)
  const letterCount = (authorPart.match(/[a-zA-Z]/g) || []).length;
  const totalChars = authorPart.replace(/\s/g, '').length;
  const alphabeticRatio = totalChars > 0 ? letterCount / totalChars : 0;

  if (alphabeticRatio < 0.85) {
    return { title: titlePart, author: null, confidence: 0.5 };
  }

  return {
    title: titlePart,
    author: authorPart,
    confidence: 0.85,
  };
}

// ============================================================================
// Author Candidate Selection
// ============================================================================

/**
 * Author candidate with scoring metadata
 */
export interface AuthorCandidate {
  text: string;
  score: number;
  reasons: string[];
}

/**
 * Score an author candidate based on PERSON-first rules
 *
 * Scoring:
 * - Base score 0.5 for 2-4 word candidates
 * - +0.3 for all-caps (typical author formatting on book spines)
 * - +0.2 for title case
 * - -0.5 if contains ORG markers (TIMES, PRESS, INC, etc.)
 * - -0.3 if contains title-like words (THE, OF, etc. dominating)
 *
 * @param text - The candidate text
 * @returns score [0-1] and reasons
 */
function scoreAuthorCandidate(text: string): { score: number; reasons: string[] } {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  const reasons: string[] = [];
  let score = 0;

  // Reject if empty or single word (names typically have 2+ words)
  if (words.length < 2) {
    return { score: 0, reasons: ['single_word_rejected'] };
  }

  // Reject if too many words (more than 4 is unusual for author names)
  if (words.length > 4) {
    return { score: 0.1, reasons: ['too_many_words'] };
  }

  // Base score for 2-4 word candidates
  score = 0.5;
  reasons.push('word_count_2_4');

  // Check alphabetic ratio (names are mostly letters)
  const letterCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const totalChars = trimmed.replace(/\s/g, '').length;
  const alphaRatio = totalChars > 0 ? letterCount / totalChars : 0;

  if (alphaRatio < 0.85) {
    score -= 0.3;
    reasons.push('low_alpha_ratio');
  } else {
    score += 0.1;
    reasons.push('high_alpha_ratio');
  }

  // Strong boost for all-caps (common author format on spines)
  const upperCount = (trimmed.match(/[A-Z]/g) || []).length;
  const lowerCount = (trimmed.match(/[a-z]/g) || []).length;
  if (upperCount > lowerCount * 3) {
    score += 0.3;
    reasons.push('allcaps_boost');
  } else if (words.every(w => w.length > 0 && w[0] === w[0].toUpperCase())) {
    // Title case
    score += 0.2;
    reasons.push('titlecase_boost');
  }

  // CRITICAL: Heavy penalty for ORG markers (PERSON-first rule)
  if (isOrgLikeLine(trimmed)) {
    score -= 0.6;
    reasons.push('org_marker_penalty');
  }

  // Penalty if dominated by non-author words (title-like)
  const lowerWords = words.map(w => w.toLowerCase());
  const nonAuthorCount = lowerWords.filter(w => NON_AUTHOR_WORDS.has(w)).length;
  if (nonAuthorCount > words.length / 2) {
    score -= 0.4;
    reasons.push('title_like_penalty');
  }

  // Clamp score
  score = Math.max(0, Math.min(1, score));

  return { score, reasons };
}

/**
 * Select best author candidate from lines using PERSON-first rules
 *
 * Priority:
 * 1. Colon-separated author (highest confidence)
 * 2. Bracketed names like [NICHOLAS SPARKS]
 * 3. PERSON-like candidates (2-4 words, high alpha, no ORG markers)
 * 4. All-caps 2-4 word lines that aren't title-like
 *
 * Uses neighbor-aware marketing badge filter to exclude split badges.
 */
export function selectAuthorCandidates(
  lines: string[],
  titleCandidate?: string
): AuthorCandidate[] {
  const candidates: AuthorCandidate[] = [];
  const titleLower = titleCandidate?.toLowerCase() || '';
  const seenTexts = new Set<string>();

  // Pre-compute marketing badge exclusions with neighbor context
  const badgeIndices = getMarketingBadgeIndices(lines);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // Skip if index is marked as badge (with neighbor context)
    if (badgeIndices.has(i)) continue;

    // Skip if same as title (case-insensitive)
    if (trimmed.toLowerCase() === titleLower) continue;

    // Skip if title tokens significantly overlap
    if (titleCandidate) {
      const titleTokens = new Set(titleCandidate.toLowerCase().split(/\s+/));
      const lineTokens = trimmed.toLowerCase().split(/\s+/);
      const overlapCount = lineTokens.filter(t => titleTokens.has(t)).length;
      if (overlapCount >= lineTokens.length * 0.75) continue;
    }

    // Skip publisher/marketing (single-line check as fallback)
    if (isPublisherOrMarketing(trimmed)) continue;

    // Check for colon pattern first (highest priority)
    const colonResult = parseColonSeparated(trimmed);
    if (colonResult.author && !seenTexts.has(colonResult.author.toLowerCase())) {
      // Validate colon-extracted author isn't ORG-like
      if (!isOrgLikeLine(colonResult.author)) {
        seenTexts.add(colonResult.author.toLowerCase());
        candidates.push({
          text: colonResult.author,
          score: colonResult.confidence,
          reasons: ['colon_separated'],
        });
      }
    }

    // Check for bracketed name
    const bracketMatch = trimmed.match(/^[\[\(](.+)[\]\)]$/);
    if (bracketMatch) {
      const inner = bracketMatch[1].trim();
      const { score, reasons } = scoreAuthorCandidate(inner);
      if (score >= 0.5 && !seenTexts.has(inner.toLowerCase())) {
        seenTexts.add(inner.toLowerCase());
        candidates.push({
          text: inner,
          score: Math.min(0.9, score + 0.15), // Bracket boost
          reasons: ['bracketed_name', ...reasons],
        });
      }
    }

    // Score this line as author candidate using PERSON-first rules
    const { score, reasons } = scoreAuthorCandidate(trimmed);
    if (score >= 0.4 && !seenTexts.has(trimmed.toLowerCase())) {
      seenTexts.add(trimmed.toLowerCase());
      candidates.push({
        text: trimmed,
        score,
        reasons,
      });
    }
  }

  // Sort by score descending (highest PERSON-like candidates first)
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Inline split debug info
 */
export interface InlineSplitDebug {
  /** Original line that was split */
  originalLine: string;
  /** Extracted title */
  title: string;
  /** Extracted author */
  author: string;
  /** Split confidence */
  confidence: number;
  /** Reason for split */
  reason: string;
}

/**
 * Excluded line entry with categorization
 */
export interface ExcludedLineEntry {
  index: number;
  text: string;
  reason: string;
  category: 'junk' | 'badge' | 'publisher';
}

/**
 * Extracted title and author with debug info
 */
export interface ExtractionResult {
  title: string | null;
  author: string | null;
  titleConfidence: number;
  authorConfidence: number;
  debug: {
    titleCandidates: TitleCandidate[];
    authorCandidates: AuthorCandidate[];
    colonParsed: ColonSeparatedResult | null;
    rawLines: string[];
    /** Lines excluded as marketing badges (with reasons) */
    excludedBadgeLines?: Array<{ index: number; text: string; reason: string }>;
    /** Lines that were split into title+author inline */
    inlineSplits?: InlineSplitDebug[];
    /** Lines excluded as junk (prices, fragments, noise) */
    excludedJunkLines?: Array<{ index: number; text: string; reason: string }>;
    /** Role scoring for each line */
    lineRoleScores?: Array<{
      index: number;
      text: string;
      personLikeness: number;
      titleLikeness: number;
      recommendedRole: 'author' | 'title' | 'ambiguous';
    }>;
    /** Joined title candidates from stopword bridges */
    joinedTitleCandidates?: Array<{
      text: string;
      indices: number[];
      score: number;
      reason: string;
    }>;
    /** Whether person-like title was overridden */
    titleDecision?: {
      originalCandidate: string | null;
      wasPersonLike: boolean;
      wasOverridden: boolean;
      overrideReason: string | null;
      finalCandidate: string | null;
    };
    // === Enhanced instrumentation ===
    /** Consolidated list of all excluded lines with categories */
    excludedLines?: ExcludedLineEntry[];
    /** Top title candidates (up to 5) for quick inspection */
    titleCandidatesTop?: Array<{ text: string; score: number; reason: string }>;
    /** Top author candidates (up to 5) for quick inspection */
    authorCandidatesTop?: Array<{ text: string; score: number; reason: string }>;
    /** Boolean flag: was a person-like title overridden? */
    personTitleOverridden?: boolean;
    /** Detailed person override check result */
    personOverrideCheck?: PersonOverrideResult;
  };
}

/**
 * Extract title and author from OCR evidence lines
 *
 * This is the main entry point for advanced extraction.
 * Implements:
 * - Inline title/author splitting (e.g., "POISON IN THE PEN Patricia Wentworth")
 * - Junk line filtering (prices, publisher fragments)
 * - Marketing badge filtering with neighbor rule
 * - PERSON-first author selection
 * - Multi-line title reconstruction
 * - Role scoring to prevent title/author misassignment
 * - Stopword bridge joins for fragmented titles
 */
export function extractTitleAndAuthor(lines: string[]): ExtractionResult {
  const result: ExtractionResult = {
    title: null,
    author: null,
    titleConfidence: 0,
    authorConfidence: 0,
    debug: {
      titleCandidates: [],
      authorCandidates: [],
      colonParsed: null,
      rawLines: lines,
      excludedBadgeLines: [],
      inlineSplits: [],
      excludedJunkLines: [],
      lineRoleScores: [],
      joinedTitleCandidates: [],
      titleDecision: undefined,
      // Enhanced instrumentation
      excludedLines: [],
      titleCandidatesTop: [],
      authorCandidatesTop: [],
      personTitleOverridden: false,
      personOverrideCheck: undefined,
    },
  };

  if (lines.length === 0) return result;

  // Step 1: Filter junk lines and track exclusions
  const junkIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (isJunkLine(lines[i])) {
      junkIndices.add(i);
      const entry = {
        index: i,
        text: lines[i],
        reason: 'junk_line',
      };
      result.debug.excludedJunkLines!.push(entry);
      result.debug.excludedLines!.push({ ...entry, category: 'junk' });
    }
  }

  // Step 2: Pre-compute badge exclusions with debug info
  for (let i = 0; i < lines.length; i++) {
    if (junkIndices.has(i)) continue;
    const badgeResult = isMarketingBadgeWithNeighbors(i, lines);
    if (badgeResult.isBadge) {
      const entry = {
        index: i,
        text: lines[i],
        reason: badgeResult.reason,
      };
      result.debug.excludedBadgeLines!.push(entry);
      result.debug.excludedLines!.push({ ...entry, category: 'badge' });
    }
  }

  const badgeIndices = getMarketingBadgeIndices(lines);

  // Combine all excluded indices
  const excludedIndices = new Set([...junkIndices, ...badgeIndices]);

  // Step 2.5: Compute role scores for all non-excluded lines
  for (let i = 0; i < lines.length; i++) {
    if (excludedIndices.has(i)) continue;
    const roleScore = getRoleScore(lines[i]);
    result.debug.lineRoleScores!.push({
      index: i,
      text: lines[i],
      personLikeness: roleScore.personLikeness,
      titleLikeness: roleScore.titleLikeness,
      recommendedRole: roleScore.recommendedRole,
    });
  }

  // Step 3: Try inline splitting on non-excluded lines
  // This catches "POISON IN THE PEN Patricia Wentworth" patterns
  for (let i = 0; i < lines.length; i++) {
    if (excludedIndices.has(i)) continue;

    const splitResult = splitInlineTitleAuthor(lines[i]);
    if (splitResult.didSplit && splitResult.title && splitResult.author) {
      // Record the split for debugging
      result.debug.inlineSplits!.push({
        originalLine: lines[i],
        title: splitResult.title,
        author: splitResult.author,
        confidence: splitResult.confidence,
        reason: splitResult.reason,
      });

      // If confidence is high, use this as the result
      if (splitResult.confidence >= 0.8) {
        result.title = splitResult.title;
        result.author = splitResult.author;
        result.titleConfidence = splitResult.confidence;
        result.authorConfidence = splitResult.confidence;
        return result;
      }
    }
  }

  // Step 4: Check for colon-separated pattern in any line
  for (let i = 0; i < lines.length; i++) {
    if (excludedIndices.has(i)) continue;

    const colonResult = parseColonSeparated(lines[i]);
    if (colonResult.title && colonResult.author) {
      // Validate author isn't ORG-like before accepting
      if (!isOrgLikeLine(colonResult.author)) {
        result.debug.colonParsed = colonResult;
        result.title = colonResult.title;
        result.author = colonResult.author;
        result.titleConfidence = colonResult.confidence;
        result.authorConfidence = colonResult.confidence;
        return result;
      }
    }
  }

  // Step 4.5: Build joined title candidates from stopword bridges and consecutive lines
  const filteredLines = lines.filter((_, i) => !excludedIndices.has(i));
  const joinedTitleCandidates = buildJoinedTitleCandidates(filteredLines);
  result.debug.joinedTitleCandidates = joinedTitleCandidates;

  // Step 5: Build title candidates from filtered lines (excludes junk and badges)
  const titleCandidates = buildTitleCandidates(filteredLines);
  result.debug.titleCandidates = titleCandidates;

  // Step 5.5: Check if best title candidate is person-like and should be overridden
  let originalTitleCandidate: string | null = null;
  let wasPersonLike = false;
  let wasOverridden = false;
  let overrideReason: string | null = null;
  let personOverrideCheckResult: PersonOverrideResult | undefined;

  if (titleCandidates.length > 0) {
    const bestTitle = titleCandidates[0];
    originalTitleCandidate = bestTitle.text;

    // Check if this looks like a person name
    const roleScore = getRoleScore(bestTitle.text);
    wasPersonLike = roleScore.recommendedRole === 'author' && roleScore.personLikeness >= 0.5;

    if (wasPersonLike && joinedTitleCandidates.length > 0) {
      // Use enhanced person override check with full details
      personOverrideCheckResult = checkPersonOverride(
        bestTitle.text,
        joinedTitleCandidates.map(j => ({ text: j.text, score: j.score }))
      );

      if (personOverrideCheckResult.shouldOverride && personOverrideCheckResult.betterCandidate) {
        // Use the better candidate
        result.title = personOverrideCheckResult.betterCandidate.text;
        result.titleConfidence = personOverrideCheckResult.betterCandidate.score;
        wasOverridden = true;
        overrideReason = `person-like "${bestTitle.text}" overridden by "${personOverrideCheckResult.betterCandidate.text}" (${personOverrideCheckResult.reason})`;
      } else {
        result.title = bestTitle.text;
        result.titleConfidence = bestTitle.score;
      }
    } else if (joinedTitleCandidates.length > 0 && joinedTitleCandidates[0].score > bestTitle.score + 0.1) {
      // Prefer joined candidate if it scores significantly better
      const bestJoined = joinedTitleCandidates[0];
      result.title = bestJoined.text;
      result.titleConfidence = bestJoined.score;
      wasOverridden = true;
      overrideReason = `joined "${bestJoined.text}" scored higher than "${bestTitle.text}"`;
    } else {
      result.title = bestTitle.text;
      result.titleConfidence = bestTitle.score;
    }
  } else if (joinedTitleCandidates.length > 0) {
    // No single-line candidates, use joined
    const bestJoined = joinedTitleCandidates[0];
    result.title = bestJoined.text;
    result.titleConfidence = bestJoined.score;
  }

  result.debug.titleDecision = {
    originalCandidate: originalTitleCandidate,
    wasPersonLike,
    wasOverridden,
    overrideReason,
    finalCandidate: result.title,
  };
  result.debug.personTitleOverridden = wasOverridden && wasPersonLike;
  result.debug.personOverrideCheck = personOverrideCheckResult;

  // Populate top candidates for quick inspection
  result.debug.titleCandidatesTop = titleCandidates.slice(0, 5).map(c => ({
    text: c.text,
    score: c.score,
    reason: c.reasons.join(', '),
  }));

  // Step 6: Select author candidates using PERSON-first rules (excluding the chosen title)
  // Also filter out candidates that look too title-like
  const authorCandidates = selectAuthorCandidates(filteredLines, result.title || undefined);

  // Filter out candidates that should be rejected as authors
  const filteredAuthorCandidates = authorCandidates.filter(candidate => {
    if (shouldRejectAsAuthor(candidate.text)) {
      return false;
    }
    return true;
  });

  result.debug.authorCandidates = filteredAuthorCandidates;

  // Populate top author candidates for quick inspection
  result.debug.authorCandidatesTop = filteredAuthorCandidates.slice(0, 5).map(c => ({
    text: c.text,
    score: c.score,
    reason: c.reasons.join(', '),
  }));

  if (filteredAuthorCandidates.length > 0) {
    const bestAuthor = filteredAuthorCandidates[0];
    result.author = bestAuthor.text;
    result.authorConfidence = bestAuthor.score;
  }

  // Step 7: If we have a high-confidence inline split but lower confidence than current,
  // consider using the inline split author if current author confidence is low
  if (result.debug.inlineSplits!.length > 0 && result.authorConfidence < 0.6) {
    const bestSplit = result.debug.inlineSplits![0];
    if (bestSplit.confidence > result.authorConfidence) {
      // Use inline split if it has higher confidence
      result.title = bestSplit.title;
      result.author = bestSplit.author;
      result.titleConfidence = bestSplit.confidence;
      result.authorConfidence = bestSplit.confidence;
    }
  }

  return result;
}

/**
 * Normalize author name to consistent format
 * - Uppercase first letter of each word
 * - Clean up OCR artifacts
 */
export function normalizeAuthorName(name: string): string {
  const cleaned = cleanupPossessiveNoise(name);

  // Title case each word
  return cleaned
    .split(/\s+/)
    .map(word => {
      if (word.length === 0) return '';
      // Handle all-caps: JOHN -> John
      if (word === word.toUpperCase()) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word;
    })
    .join(' ');
}

/**
 * Sanitize a title for search queries by stripping trailing person-like suffixes
 *
 * This is used when OCR has collapsed title+author into one field (e.g., "POISON IN THE PEN Patricia Wentworth")
 * and we need to extract just the title for searching.
 *
 * @param title - The raw title that may contain an embedded author
 * @returns Object with sanitized title and extracted author (if any)
 */
export function sanitizeTitleForSearch(title: string): { title: string; extractedAuthor: string | null } {
  const trimmed = title.trim();

  if (!trimmed) {
    return { title: '', extractedAuthor: null };
  }

  // Try inline split to detect embedded author
  const splitResult = splitInlineTitleAuthor(trimmed);

  if (splitResult.didSplit && splitResult.title && splitResult.confidence >= 0.6) {
    return {
      title: splitResult.title,
      extractedAuthor: splitResult.author,
    };
  }

  // No embedded author detected, return as-is
  return { title: trimmed, extractedAuthor: null };
}
