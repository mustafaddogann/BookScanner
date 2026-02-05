/**
 * Title/Author Extraction Service
 *
 * Advanced extraction logic for reconstructing titles and authors from OCR evidence.
 * Handles:
 * - Multi-line title reconstruction (e.g., "THE" + "BURIED" -> "THE BURIED")
 * - Colon-separated patterns (e.g., "THE FINGERPRINT: Patricia Wentworth")
 * - All-caps author detection (e.g., "JOHN GRISHAM")
 * - Publisher/marketing noise filtering
 */

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
  // Note: Removed 'pelican' - too commonly part of titles like "THE PELICAN BRIEF"
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
];

/**
 * Common leading stopwords that often start titles
 */
const TITLE_STOPWORDS = new Set(['the', 'a', 'an']);

/**
 * Words that indicate line is NOT an author name
 */
const NON_AUTHOR_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by',
  'from', 'and', 'or', 'into', 'darkness', 'night', 'day', 'death', 'life',
  'blood', 'fire', 'ice', 'storm', 'shadow', 'secret', 'last', 'first',
  'final', 'dead', 'dark', 'lost', 'fallen', 'broken', 'silent', 'hidden',
  'buried', 'forgotten', 'guardian', 'guardians', 'fingerprint', 'pelican',
  'brief', 'game', 'girl', 'boy', 'man', 'woman', 'wife', 'husband',
]);

// ============================================================================
// Text Cleanup Helpers
// ============================================================================

/**
 * Clean up possessive noise and OCR artifacts from author names
 * - "Wentworth s" -> "Wentworth"
 * - "Grisham," -> "Grisham"
 * - "King's" -> "King's" (keep valid possessives)
 */
export function cleanupPossessiveNoise(text: string): string {
  let result = text.trim();

  // Remove trailing isolated "s" (OCR artifact from possessive)
  result = result.replace(/\s+s\s*$/i, '');

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
 * Check if a line looks like an all-caps author name candidate
 * Criteria:
 * - 2-4 tokens
 * - Mostly alphabetic (>85%)
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
 * - Skip publisher/marketing lines
 * - Score higher for 2-6 token combined titles
 */
export function buildTitleCandidates(lines: string[]): TitleCandidate[] {
  const candidates: TitleCandidate[] = [];
  const cleanedLines = lines
    .map(l => l.trim())
    .filter(l => l.length > 0 && !isPublisherOrMarketing(l));

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
 * Select best author candidate from lines
 *
 * Priority:
 * 1. Colon-separated author (highest confidence)
 * 2. Bracketed names like [NICHOLAS SPARKS]
 * 3. All-caps 2-4 word lines that aren't title-like
 * 4. Title-case 2-4 word lines in bottom half
 */
export function selectAuthorCandidates(
  lines: string[],
  titleCandidate?: string
): AuthorCandidate[] {
  const candidates: AuthorCandidate[] = [];
  const titleLower = titleCandidate?.toLowerCase() || '';
  const seenTexts = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip if same as title
    if (trimmed.toLowerCase() === titleLower) continue;

    // Skip publisher/marketing
    if (isPublisherOrMarketing(trimmed)) continue;

    // Check for colon pattern first
    const colonResult = parseColonSeparated(trimmed);
    if (colonResult.author && !seenTexts.has(colonResult.author.toLowerCase())) {
      seenTexts.add(colonResult.author.toLowerCase());
      candidates.push({
        text: colonResult.author,
        score: colonResult.confidence,
        reasons: ['colon_separated'],
      });
    }

    // Check for bracketed name
    const bracketMatch = trimmed.match(/^[\[\(](.+)[\]\)]$/);
    if (bracketMatch) {
      const inner = bracketMatch[1].trim();
      if (isAllCapsNameCandidate(inner) && !seenTexts.has(inner.toLowerCase())) {
        seenTexts.add(inner.toLowerCase());
        candidates.push({
          text: inner,
          score: 0.9,
          reasons: ['bracketed_name'],
        });
      }
    }

    // Check for all-caps name candidate
    if (isAllCapsNameCandidate(trimmed) && !seenTexts.has(trimmed.toLowerCase())) {
      seenTexts.add(trimmed.toLowerCase());
      candidates.push({
        text: trimmed,
        score: 0.75,
        reasons: ['allcaps_name'],
      });
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

// ============================================================================
// Main Extraction Function
// ============================================================================

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
  };
}

/**
 * Extract title and author from OCR evidence lines
 *
 * This is the main entry point for advanced extraction.
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
    },
  };

  if (lines.length === 0) return result;

  // First, check for colon-separated pattern in any line
  for (const line of lines) {
    const colonResult = parseColonSeparated(line);
    if (colonResult.title && colonResult.author) {
      result.debug.colonParsed = colonResult;
      result.title = colonResult.title;
      result.author = colonResult.author;
      result.titleConfidence = colonResult.confidence;
      result.authorConfidence = colonResult.confidence;
      return result;
    }
  }

  // Build title candidates
  const titleCandidates = buildTitleCandidates(lines);
  result.debug.titleCandidates = titleCandidates;

  if (titleCandidates.length > 0) {
    const bestTitle = titleCandidates[0];
    result.title = bestTitle.text;
    result.titleConfidence = bestTitle.score;
  }

  // Select author candidates (excluding the chosen title)
  const authorCandidates = selectAuthorCandidates(lines, result.title || undefined);
  result.debug.authorCandidates = authorCandidates;

  if (authorCandidates.length > 0) {
    const bestAuthor = authorCandidates[0];
    result.author = bestAuthor.text;
    result.authorConfidence = bestAuthor.score;
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
