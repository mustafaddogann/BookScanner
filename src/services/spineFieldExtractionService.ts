/**
 * Spine Field Extraction Service
 *
 * Extracts structured field evidence from merged OCR text:
 * - ISBN (10/13) with validation
 * - Publisher detection
 * - Edition detection
 * - Year extraction
 * - Improved title/author classification and splitting
 *
 * This service is pure and unit-testable.
 */

import type {
  BookEvidence,
  BookEvidenceLine,
  ISBNCandidate,
  ISBNType,
  PublisherCandidate,
  EditionCandidate,
  YearCandidate,
  TitleCandidate,
  AuthorCandidate,
  SpineFieldEvidence,
} from '../types';
import {
  normalizeIsbn,
  isValidIsbn10,
  isValidIsbn13,
  isbn10ToIsbn13,
} from '../utils/isbnUtils';
import { normalizeForComparison } from '../utils/stringSimilarity';

// Gate 8 services for improved title/author extraction
import { filterSpineLines } from './spineLineFilter';
import { labelSpineLines } from './spineLineLabeler';
import { assembleTitleAuthor, quickAssemble } from './spineTitleAuthorAssembler';
import { quickSwapCheck } from './spineSwapGuard';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Known publisher keywords and names (EN/TR)
 */
const PUBLISHER_KEYWORDS = [
  // English patterns
  'press',
  'publishing',
  'publishers',
  'publications',
  'books',
  'house',
  // Turkish patterns (with ASCII equivalents for matching)
  'yayinlari',
  'yayinevi',
  'yayincilik',
  'basim',
];

/**
 * Known major publishers
 */
const KNOWN_PUBLISHERS = new Set([
  'oxford',
  'cambridge',
  'penguin',
  'random house',
  'harpercollins',
  'simon schuster',
  'macmillan',
  'wiley',
  'pearson',
  'mcgraw hill',
  'scholastic',
  'hachette',
  'bloomsbury',
  'bantam',
  'vintage',
  'anchor',
  'knopf',
  'doubleday',
  'penguin random house',
  // Turkish publishers (ASCII normalized)
  'yapi kredi',
  'can',
  'is bankasi',
  'dogan kitap',
  'alfa',
  'epsilon',
  'remzi',
  'inkilap',
  'kirmizi kedi',
]);

/**
 * Edition patterns (EN/TR) - order matters! Special editions before generic "edition"
 */
const EDITION_PATTERNS: Array<{ pattern: RegExp; type: EditionCandidate['editionType']; extractNumber?: boolean }> = [
  // English special editions first (more specific)
  { pattern: /\brevised\s+edition\b/i, type: 'revised' },
  { pattern: /\bupdated\s+edition\b/i, type: 'updated' },
  { pattern: /\breprint\b/i, type: 'reprint' },
  // English numbered editions
  { pattern: /\b(\d+)(?:st|nd|rd|th)\s+edition\b/i, type: 'numbered', extractNumber: true },
  { pattern: /\bedition\s+(\d+)\b/i, type: 'numbered', extractNumber: true },
  { pattern: /\bfirst\s+edition\b/i, type: 'numbered' },
  { pattern: /\bsecond\s+edition\b/i, type: 'numbered' },
  { pattern: /\bthird\s+edition\b/i, type: 'numbered' },
  { pattern: /\bfourth\s+edition\b/i, type: 'numbered' },
  { pattern: /\bfifth\s+edition\b/i, type: 'numbered' },
  { pattern: /\b(\d+)\s*ed\.?\b/i, type: 'numbered', extractNumber: true },
  // Generic edition last
  { pattern: /\bedition\b/i, type: 'other' },
  // Turkish editions (with and without special characters, relaxed word boundaries)
  { pattern: /(\d+)\.\s*bask[ıi]/i, type: 'numbered', extractNumber: true },
  { pattern: /(\d+)\.\s*bas[ıi]m/i, type: 'numbered', extractNumber: true },
  { pattern: /cilt\s*(\d+)/i, type: 'numbered', extractNumber: true },
  { pattern: /yeni\s+bask[ıi]/i, type: 'revised' },
  { pattern: /g[üu]ncellenmi[şs]/i, type: 'updated' },
];

/**
 * Edition number words to numeric
 */
const EDITION_WORD_TO_NUMBER: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

/**
 * "By" patterns for author detection (multilingual)
 */
const BY_PATTERNS = [
  /^by\s+(.+)$/i,
  /^BY\s+(.+)$/,
  /^By\s+(.+)$/,
  /^written\s+by\s+(.+)$/i,
  /^author[:\s]+(.+)$/i,
  // Turkish
  /^yazan[:\s]+(.+)$/i,
  /^yazar[:\s]+(.+)$/i,
  // French/Spanish
  /^de\s+(.+)$/i,
  /^por\s+(.+)$/i,
];

/**
 * Separators for combined author-title lines (check longer ones first)
 */
const COMBINED_LINE_SEPARATORS = [' - ', ' – ', ' — ', ' / ', '•', '·', ' | ', '|', ':'];

/**
 * Year range for validation
 */
const MIN_VALID_YEAR = 1800;
const MAX_VALID_YEAR = 2030;

/**
 * ISBN patterns (with optional prefix)
 */
const ISBN_PATTERNS = [
  // ISBN-13 with prefix
  /ISBN[-:\s]*(97[89][\d\-\s]{10,14}\d)/gi,
  // ISBN-10 with prefix
  /ISBN[-:\s]*(\d[\d\-\s]{8,11}[\dXx])/gi,
  // ISBN-13 without explicit prefix (978/979 start)
  /\b(97[89][\d\-\s]{10,14}\d)\b/g,
  // ISBN-10 without prefix (looser, requires validation)
  /\b(\d[\d\-\s]{8,11}[\dXx])\b/g,
];

// ============================================================================
// ISBN Extraction
// ============================================================================

/**
 * Extract ISBN candidates from text with validation
 */
function extractIsbns(
  text: string,
  lineIndex: number,
  cropIndex: number,
  lineConfidence: number
): ISBNCandidate[] {
  const candidates: ISBNCandidate[] = [];
  const seen = new Set<string>();

  for (const pattern of ISBN_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1] || match[0];
      const normalized = normalizeIsbn(raw);

      // Skip if already seen
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      // Validate and determine type
      let type: ISBNType | null = null;
      let finalNormalized = normalized;

      if (normalized.length === 13 && isValidIsbn13(normalized)) {
        type = 'isbn13';
      } else if (normalized.length === 10 && isValidIsbn10(normalized)) {
        type = 'isbn10';
        // Convert to ISBN-13 for consistency
        const asIsbn13 = isbn10ToIsbn13(normalized);
        if (asIsbn13) {
          finalNormalized = asIsbn13;
        }
      }

      if (type) {
        candidates.push({
          value: finalNormalized,
          type,
          normalized: finalNormalized,
          raw,
          confidence: lineConfidence,
          sourceLineIndex: lineIndex,
          cropIndex,
        });
      }
    }
  }

  // Sort by type preference (ISBN-13 first) and confidence
  return candidates.sort((a, b) => {
    if (a.type === 'isbn13' && b.type === 'isbn10') return -1;
    if (a.type === 'isbn10' && b.type === 'isbn13') return 1;
    return b.confidence - a.confidence;
  });
}

// ============================================================================
// Publisher Extraction
// ============================================================================

/**
 * Normalize Turkish characters to ASCII equivalents for matching
 */
function normalizeTurkish(text: string): string {
  return text
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/İ/g, 'i')
    .replace(/Ş/g, 's')
    .replace(/Ğ/g, 'g')
    .replace(/Ü/g, 'u')
    .replace(/Ö/g, 'o')
    .replace(/Ç/g, 'c');
}

/**
 * Extract publisher candidates from text
 */
function extractPublishers(
  text: string,
  lineIndex: number,
  cropIndex: number,
  lineConfidence: number
): PublisherCandidate[] {
  const candidates: PublisherCandidate[] = [];
  const normalizedText = normalizeTurkish(normalizeForComparison(text));

  // Check for known publishers
  for (const publisher of KNOWN_PUBLISHERS) {
    if (normalizedText.includes(publisher)) {
      // Extract the full context around the publisher name
      const regex = new RegExp(`([^,;.]*${publisher}[^,;.]*)`, 'i');
      const match = text.match(regex);
      const value = match ? match[1].trim() : publisher;

      candidates.push({
        value,
        confidence: lineConfidence * 0.9, // High confidence for known publishers
        sourceLineIndex: lineIndex,
        cropIndex,
        method: 'known-publisher',
      });
      return candidates; // Only return first known publisher match
    }
  }

  // Check for publisher keywords
  for (const keyword of PUBLISHER_KEYWORDS) {
    if (normalizedText.includes(keyword)) {
      candidates.push({
        value: text.trim(),
        confidence: lineConfidence * 0.7,
        sourceLineIndex: lineIndex,
        cropIndex,
        method: 'keyword',
      });
      break; // Only add one candidate per line
    }
  }

  // Check for pattern: "Published by X" or "X Publishing"
  const publishedByMatch = text.match(/published\s+by\s+([^,;.]+)/i);
  if (publishedByMatch) {
    candidates.push({
      value: publishedByMatch[1].trim(),
      confidence: lineConfidence * 0.8,
      sourceLineIndex: lineIndex,
      cropIndex,
      method: 'pattern',
    });
  }

  return candidates;
}

// ============================================================================
// Edition Extraction
// ============================================================================

/**
 * Extract edition candidates from text
 */
function extractEditions(
  text: string,
  lineIndex: number,
  cropIndex: number,
  lineConfidence: number
): EditionCandidate[] {
  const candidates: EditionCandidate[] = [];

  for (const { pattern, type, extractNumber } of EDITION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      let editionNumber: number | undefined;

      if (extractNumber && match[1]) {
        editionNumber = parseInt(match[1], 10);
      } else {
        // Check for word-based edition numbers
        const lowerText = text.toLowerCase();
        for (const [word, num] of Object.entries(EDITION_WORD_TO_NUMBER)) {
          if (lowerText.includes(word)) {
            editionNumber = num;
            break;
          }
        }
      }

      candidates.push({
        value: match[0].trim(),
        confidence: lineConfidence * 0.8,
        sourceLineIndex: lineIndex,
        cropIndex,
        editionNumber,
        editionType: type,
      });
      break; // Only one edition per line
    }
  }

  return candidates;
}

// ============================================================================
// Year Extraction
// ============================================================================

/**
 * Extract year candidates from text
 */
function extractYears(
  text: string,
  lineIndex: number,
  cropIndex: number,
  lineConfidence: number
): YearCandidate[] {
  const candidates: YearCandidate[] = [];
  const seen = new Set<number>();

  // Check for copyright year pattern
  const copyrightMatch = text.match(/(?:copyright|©|\(c\))\s*(\d{4})/i);
  if (copyrightMatch) {
    const year = parseInt(copyrightMatch[1], 10);
    if (year >= MIN_VALID_YEAR && year <= MAX_VALID_YEAR) {
      candidates.push({
        value: copyrightMatch[1],
        year,
        confidence: lineConfidence * 0.9,
        sourceLineIndex: lineIndex,
        cropIndex,
        context: 'copyright',
      });
      seen.add(year);
    }
  }

  // Look for standalone 4-digit years
  const yearMatches = text.matchAll(/\b(1[89]\d{2}|20[0-2]\d)\b/g);
  for (const match of yearMatches) {
    const year = parseInt(match[1], 10);
    if (year >= MIN_VALID_YEAR && year <= MAX_VALID_YEAR && !seen.has(year)) {
      seen.add(year);

      // Determine context
      let context: YearCandidate['context'] = 'standalone';
      const surroundingText = text.toLowerCase();
      if (surroundingText.includes('edition') || surroundingText.includes('baskı')) {
        context = 'edition';
      } else if (surroundingText.includes('publish') || surroundingText.includes('yayın')) {
        context = 'publisher';
      }

      candidates.push({
        value: match[1],
        year,
        confidence: lineConfidence * 0.7,
        sourceLineIndex: lineIndex,
        cropIndex,
        context,
      });
    }
  }

  // Sort by context importance and confidence
  return candidates.sort((a, b) => {
    const contextOrder = { copyright: 0, edition: 1, publisher: 2, standalone: 3 };
    const aOrder = contextOrder[a.context || 'standalone'];
    const bOrder = contextOrder[b.context || 'standalone'];
    if (aOrder !== bOrder) return aOrder - bOrder;
    return b.confidence - a.confidence;
  });
}

// ============================================================================
// Title/Author Extraction
// ============================================================================

/**
 * Check if text looks like a person name
 */
function isLikelyPersonName(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length < 2) return 0;

  let score = 0.5; // Base score

  // Check for common name patterns
  // Two or three capitalized words
  const words = trimmed.split(/\s+/);
  if (words.length >= 2 && words.length <= 4) {
    const capitalizedWords = words.filter((w) => /^[A-Z]/.test(w));
    if (capitalizedWords.length === words.length) {
      score += 0.2;
    }
  }

  // Contains initials (J.K., M.L.)
  if (/\b[A-Z]\.\s*[A-Z]?\.?\s*/i.test(trimmed)) {
    score += 0.15;
  }

  // Starts with "Dr." or "Prof." etc.
  if (/^(?:dr|prof|mr|mrs|ms|sir)\.?\s+/i.test(trimmed)) {
    score += 0.1;
  }

  // Penalize if looks like title (too long, has articles)
  if (words.length > 5) {
    score -= 0.2;
  }
  if (/^(?:the|a|an)\s+/i.test(trimmed)) {
    score -= 0.3;
  }

  // Penalize if has numbers (likely not a name)
  if (/\d/.test(trimmed)) {
    score -= 0.2;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Check if text looks like a book title
 */
function isLikelyTitle(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length < 2) return 0;

  let score = 0.5; // Base score

  const words = trimmed.split(/\s+/);

  // Longer text more likely to be title
  if (trimmed.length > 20) score += 0.1;
  if (trimmed.length > 40) score += 0.1;

  // Has subtitle indicator
  if (/[:\-–—]/.test(trimmed)) {
    score += 0.1;
  }

  // Starts with article (common for titles)
  if (/^(?:the|a|an)\s+/i.test(trimmed)) {
    score += 0.15;
  }

  // Penalize if looks like person name
  const personScore = isLikelyPersonName(text);
  if (personScore > 0.7) {
    score -= 0.3;
  }

  // Single word can be a title if it doesn't look like a name
  if (words.length === 1) {
    if (personScore < 0.5) {
      // Short single word that doesn't look like a name - could be title
      score += 0.1;
    } else {
      score -= 0.2;
    }
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Try to split a combined author-title line
 */
function trySplitCombinedLine(
  text: string,
  lineIndex: number,
  cropIndex: number,
  lineConfidence: number
): { title?: TitleCandidate; author?: AuthorCandidate } | null {
  for (const separator of COMBINED_LINE_SEPARATORS) {
    if (text.includes(separator)) {
      const parts = text.split(separator).map((p) => p.trim()).filter((p) => p.length > 0);

      if (parts.length === 2) {
        const [left, right] = parts;
        const leftPersonScore = isLikelyPersonName(left);
        const rightPersonScore = isLikelyPersonName(right);
        const leftTitleScore = isLikelyTitle(left);
        const rightTitleScore = isLikelyTitle(right);

        // Calculate relative scores
        const leftAuthorness = leftPersonScore - leftTitleScore;
        const rightAuthorness = rightPersonScore - rightTitleScore;

        // Pattern: "Author • Title" (left more author-like than right)
        if (leftAuthorness > rightAuthorness && leftPersonScore > 0.4) {
          return {
            author: {
              value: left,
              confidence: lineConfidence * Math.max(leftPersonScore, 0.6),
              sourceLineIndex: lineIndex,
              cropIndex,
              fromSplit: true,
              nameConfidence: leftPersonScore,
            },
            title: {
              value: right,
              confidence: lineConfidence * Math.max(rightTitleScore, 0.6),
              sourceLineIndex: lineIndex,
              cropIndex,
              fromSplit: true,
              charCount: right.length,
              wordCount: right.split(/\s+/).length,
            },
          };
        }

        // Pattern: "Title - Author" (right more author-like than left)
        if (rightAuthorness > leftAuthorness && rightPersonScore > 0.4) {
          return {
            title: {
              value: left,
              confidence: lineConfidence * Math.max(leftTitleScore, 0.6),
              sourceLineIndex: lineIndex,
              cropIndex,
              fromSplit: true,
              charCount: left.length,
              wordCount: left.split(/\s+/).length,
            },
            author: {
              value: right,
              confidence: lineConfidence * Math.max(rightPersonScore, 0.6),
              sourceLineIndex: lineIndex,
              cropIndex,
              fromSplit: true,
              nameConfidence: rightPersonScore,
            },
          };
        }
      }
    }
  }

  return null;
}

/**
 * Extract author from "by" patterns
 */
function extractAuthorFromByPattern(
  text: string,
  lineIndex: number,
  cropIndex: number,
  lineConfidence: number
): AuthorCandidate | null {
  for (const pattern of BY_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const authorText = match[1].trim();
      const nameScore = isLikelyPersonName(authorText);

      return {
        value: authorText,
        confidence: lineConfidence * 0.85,
        sourceLineIndex: lineIndex,
        cropIndex,
        fromByPattern: true,
        nameConfidence: nameScore,
      };
    }
  }

  return null;
}

/**
 * Extract title and author candidates from lines using Gate 8 pipeline
 *
 * Gate 8 Pipeline:
 * 1. Filter lines (ISBN, publisher, price, etc. → OTHER)
 * 2. Label remaining lines (title score, author score)
 * 3. Assemble title/author from labeled lines
 * 4. Validate with swap guard
 */
function extractTitlesAndAuthors(
  lines: BookEvidenceLine[]
): { titles: TitleCandidate[]; authors: AuthorCandidate[] } {
  const titles: TitleCandidate[] = [];
  const authors: AuthorCandidate[] = [];

  if (lines.length === 0) {
    return { titles, authors };
  }

  try {
    // Gate 8 Pipeline: Filter → Label → Assemble → Validate

    // Step 1: Filter lines (removes ISBN, publisher, price, etc.)
    const filterResult = filterSpineLines(lines);

    // Step 2: Label candidate lines with title/author scores
    const labelResult = labelSpineLines(filterResult.candidateLines);

    // Step 3: Assemble title and author from labeled lines
    const assemblyResult = assembleTitleAuthor(labelResult);

    // Extract title and author strings from assemblies
    let finalTitleStr = assemblyResult.bestTitle?.fullTitle;
    let finalAuthorStr = assemblyResult.bestAuthor?.fullAuthor;

    // Step 4: Validate with swap guard
    if (finalTitleStr && finalAuthorStr) {
      const swapResult = quickSwapCheck(finalTitleStr, finalAuthorStr);
      if (swapResult.shouldSwap && swapResult.confidence > 0.6) {
        // Swap detected with high confidence
        finalTitleStr = swapResult.correctedTitle ?? finalTitleStr;
        finalAuthorStr = swapResult.correctedAuthor ?? finalAuthorStr;
      }
    }

    // Convert assembly result to TitleCandidate/AuthorCandidate format
    if (finalTitleStr) {
      // Find source line for title - use original OCR confidence
      const sourceLine = labelResult.titleLines[0];
      const originalLineConfidence = sourceLine?.filteredLine.line.confidence ?? 0.8;
      const titleScore = sourceLine?.titleScore ?? 0.5;
      // Confidence combines OCR quality with title classification quality
      // Use weighted average to avoid penalizing too heavily for ambiguous scoring
      const confidence = originalLineConfidence * 0.7 + titleScore * 0.3;
      titles.push({
        value: finalTitleStr,
        confidence,
        sourceLineIndex: sourceLine?.filteredLine.lineIndex ?? 0,
        cropIndex: sourceLine?.filteredLine.line.sourceCropIndex ?? 0,
        charCount: finalTitleStr.length,
        wordCount: finalTitleStr.split(/\s+/).length,
      });
    }

    if (finalAuthorStr) {
      // Find source line for author - use original OCR confidence
      const sourceLine = labelResult.authorLines[0];
      const originalLineConfidence = sourceLine?.filteredLine.line.confidence ?? 0.8;
      const authorScore = sourceLine?.authorScore ?? 0.5;
      const authorAssembly = assemblyResult.bestAuthor;
      // Confidence combines OCR quality with author classification quality
      const confidence = originalLineConfidence * 0.7 + authorScore * 0.3;
      authors.push({
        value: finalAuthorStr,
        confidence,
        sourceLineIndex: sourceLine?.filteredLine.lineIndex ?? 0,
        cropIndex: sourceLine?.filteredLine.line.sourceCropIndex ?? 0,
        nameConfidence: authorScore,
        fromByPattern: authorAssembly?.method === 'by_pattern',
        fromSplit: authorAssembly?.method === 'split_from_combined',
      });
    }

    // Add alternative candidates from assembly pairings
    for (const pairing of assemblyResult.pairings.slice(1, 4)) {
      const pairingTitleStr = pairing.title?.fullTitle;
      const pairingAuthorStr = pairing.author?.fullAuthor;

      if (pairingTitleStr && pairingTitleStr !== finalTitleStr) {
        titles.push({
          value: pairingTitleStr,
          confidence: pairing.confidence * 0.8,
          sourceLineIndex: pairing.title.sourceLineIndices[0] ?? 0,
          cropIndex: 0,
          charCount: pairingTitleStr.length,
          wordCount: pairingTitleStr.split(/\s+/).length,
        });
      }
      if (pairingAuthorStr && pairingAuthorStr !== finalAuthorStr) {
        authors.push({
          value: pairingAuthorStr,
          confidence: pairing.confidence * 0.8,
          sourceLineIndex: pairing.author.sourceLineIndices[0] ?? 0,
          cropIndex: 0,
          nameConfidence: pairing.confidence * 0.8,
          fromByPattern: pairing.author.method === 'by_pattern',
          fromSplit: pairing.author.method === 'split_from_combined',
        });
      }
    }

    // Fallback: If Gate 8 produced no title/author but we have candidate lines,
    // use them directly (for edge cases like single-line inputs)
    if (titles.length === 0 && authors.length === 0 && filterResult.candidateLines.length > 0) {
      // Add candidate lines based on their labels
      for (const fl of filterResult.candidateLines) {
        const text = fl.line.text.trim();
        if (text.length < 2) continue;

        const personScore = isLikelyPersonName(text);
        const titleScore = isLikelyTitle(text);

        if (personScore > titleScore && personScore > 0.5) {
          authors.push({
            value: text,
            confidence: fl.line.confidence * personScore,
            sourceLineIndex: fl.lineIndex,
            cropIndex: fl.line.sourceCropIndex,
            nameConfidence: personScore,
          });
        } else {
          titles.push({
            value: text,
            confidence: fl.line.confidence * Math.max(titleScore, 0.5),
            sourceLineIndex: fl.lineIndex,
            cropIndex: fl.line.sourceCropIndex,
            charCount: text.length,
            wordCount: text.split(/\s+/).length,
          });
        }
      }
    }
  } catch {
    // Fallback to quick assembly if Gate 8 pipeline fails
    const lineTexts = lines.map(l => l.text.trim());
    const quickResult = quickAssemble(lineTexts);
    if (quickResult.title) {
      titles.push({
        value: quickResult.title,
        confidence: 0.5, // Lower confidence for fallback
        sourceLineIndex: 0,
        cropIndex: lines[0]?.sourceCropIndex ?? 0,
        charCount: quickResult.title.length,
        wordCount: quickResult.title.split(/\s+/).length,
      });
    }
    if (quickResult.author) {
      authors.push({
        value: quickResult.author,
        confidence: 0.5, // Lower confidence for fallback
        sourceLineIndex: 0,
        cropIndex: lines[0]?.sourceCropIndex ?? 0,
        nameConfidence: 0.5,
      });
    }
  }

  // Sort by confidence
  titles.sort((a, b) => b.confidence - a.confidence);
  authors.sort((a, b) => b.confidence - a.confidence);

  return { titles, authors };
}

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Options for field extraction
 */
export interface FieldExtractionOptions {
  /** Include low-confidence candidates */
  includeLowConfidence?: boolean;
  /** Minimum confidence threshold */
  minConfidence?: number;
}

/**
 * Extract structured field evidence from merged OCR text
 *
 * @param evidence - Merged book evidence
 * @param options - Extraction options
 * @returns Structured field evidence
 */
export function extractSpineFieldEvidence(
  evidence: BookEvidence,
  options: FieldExtractionOptions = {}
): SpineFieldEvidence {
  const { minConfidence = 0.3 } = options;

  const isbnCandidates: ISBNCandidate[] = [];
  const publisherCandidates: PublisherCandidate[] = [];
  const editionCandidates: EditionCandidate[] = [];
  const yearCandidates: YearCandidate[] = [];

  // Extract from each merged line
  for (let i = 0; i < evidence.mergedLines.length; i++) {
    const line = evidence.mergedLines[i];
    const text = line.text;

    // Extract ISBNs
    isbnCandidates.push(
      ...extractIsbns(text, i, line.sourceCropIndex, line.confidence)
    );

    // Extract publishers
    publisherCandidates.push(
      ...extractPublishers(text, i, line.sourceCropIndex, line.confidence)
    );

    // Extract editions
    editionCandidates.push(
      ...extractEditions(text, i, line.sourceCropIndex, line.confidence)
    );

    // Extract years
    yearCandidates.push(
      ...extractYears(text, i, line.sourceCropIndex, line.confidence)
    );
  }

  // Extract titles and authors
  const { titles: titleCandidates, authors: authorCandidates } =
    extractTitlesAndAuthors(evidence.mergedLines);

  // Build full normalized text
  const fullTextNormalized = evidence.mergedLines
    .map((l) => normalizeForComparison(l.text))
    .join(' ');

  // Filter by confidence if needed
  const filterByConfidence = <T extends { confidence: number }>(items: T[]): T[] =>
    items.filter((item) => item.confidence >= minConfidence);

  const filteredIsbns = filterByConfidence(isbnCandidates);
  const filteredPublishers = filterByConfidence(publisherCandidates);
  const filteredEditions = filterByConfidence(editionCandidates);
  const filteredTitles = filterByConfidence(titleCandidates);
  const filteredAuthors = filterByConfidence(authorCandidates);

  // Sort years globally by context importance and confidence
  const sortedYears = [...yearCandidates].sort((a, b) => {
    const contextOrder: Record<string, number> = { copyright: 0, edition: 1, publisher: 2, standalone: 3 };
    const aOrder = contextOrder[a.context || 'standalone'];
    const bOrder = contextOrder[b.context || 'standalone'];
    if (aOrder !== bOrder) return aOrder - bOrder;
    return b.confidence - a.confidence;
  });
  const filteredYears = filterByConfidence(sortedYears);

  // Determine best candidates
  const bestIsbn = filteredIsbns[0]?.normalized;
  const bestTitle = filteredTitles[0]?.value;
  const bestAuthor = filteredAuthors[0]?.value;
  const bestPublisher = filteredPublishers[0]?.value;
  const bestEdition = filteredEditions[0]?.value;
  const bestYear = filteredYears[0]?.year;

  return {
    isbnCandidates: filteredIsbns,
    publisherCandidates: filteredPublishers,
    editionCandidates: filteredEditions,
    yearCandidates: filteredYears,
    titleCandidates: filteredTitles,
    authorCandidates: filteredAuthors,
    fullTextNormalized,
    bestIsbn,
    bestTitle,
    bestAuthor,
    bestPublisher,
    bestEdition,
    bestYear,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if field evidence has a valid ISBN
 */
export function hasValidIsbn(evidence: SpineFieldEvidence): boolean {
  return evidence.isbnCandidates.length > 0;
}

/**
 * Check if field evidence has publisher info
 */
export function hasPublisher(evidence: SpineFieldEvidence): boolean {
  return evidence.publisherCandidates.length > 0;
}

/**
 * Check if field evidence has edition info
 */
export function hasEdition(evidence: SpineFieldEvidence): boolean {
  return evidence.editionCandidates.length > 0;
}

/**
 * Check if field evidence has year info
 */
export function hasYear(evidence: SpineFieldEvidence): boolean {
  return evidence.yearCandidates.length > 0;
}

/**
 * Get ISBN-13 from evidence (preferred format)
 */
export function getIsbn13(evidence: SpineFieldEvidence): string | undefined {
  return evidence.isbnCandidates.find((c) => c.type === 'isbn13')?.normalized;
}
