/**
 * Search Candidate Service (Gate 8 - HYPOTHESIZE)
 *
 * Generates search candidates from OCR evidence for metadata lookup.
 * Extracts title/author hints and ISBNs, applying evidence quality tiers.
 */

import type {
  EvidenceTier,
  SearchCandidate,
  EvidenceSummary,
  OCRResult,
  BookEvidence,
  SpineFieldEvidence,
} from '../types';
import { tierMultiplier, getCropsAtTierOrBetter } from './evidenceQualityService';
import { tokenize, normalizeForComparison } from '../utils/stringSimilarity';
import { findFirstIsbn } from '../utils/isbnUtils';
import { isMetadataVerboseDebug, isFieldExtractionEnabled } from '../config/debug';
import { extractSpineFieldEvidence } from './spineFieldExtractionService';

// ============================================================================
// Configuration
// ============================================================================

/** Minimum query length to generate a candidate */
const MIN_QUERY_LENGTH = 3;

/** Maximum candidates to generate per session */
const MAX_CANDIDATES = 5;

/** Noise tokens to filter from queries */
const NOISE_TOKENS = new Set([
  'copyright',
  'all rights reserved',
  'printed in',
  'isbn',
  'www',
  'http',
  'com',
  'org',
  'net',
  'publishing',
  'publisher',
  'press',
  'books',
  'library',
  'congress',
  'edition',
  'first',
  'second',
  'third',
  'revised',
  'updated',
  'reprint',
  'paperback',
  'hardcover',
  'jacket',
  'cover',
  'design',
  'illustration',
]);

/** Line patterns to skip entirely */
const SKIP_LINE_PATTERNS = [
  /^copyright\s*\d{4}/i,
  /^isbn[\s\-:]/i,
  /^\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{2,4}/, // Dates
  /^www\./i,
  /^http/i,
  /^\d+$/, // Just numbers
  /^page\s*\d+/i,
  /^chapter\s*\d+/i,
];

// ============================================================================
// Query Building
// ============================================================================

/**
 * Check if a line should be skipped
 *
 * @param line - Line text
 * @returns True if should skip
 */
function shouldSkipLine(line: string): boolean {
  const normalized = normalizeForComparison(line);
  if (normalized.length < 2) return true;

  for (const pattern of SKIP_LINE_PATTERNS) {
    if (pattern.test(line)) return true;
  }

  return false;
}

/**
 * Filter noise from query text
 *
 * @param text - Raw text
 * @returns Cleaned text
 */
function filterNoiseFromQuery(text: string): string {
  const tokens = tokenize(text);
  const filtered = tokens.filter((t) => !NOISE_TOKENS.has(t) && t.length > 1);
  return filtered.join(' ');
}

/**
 * Build search query from OCR result
 *
 * @param ocr - OCR result
 * @returns Clean query string
 */
export function buildSearchQuery(ocr: OCRResult): string {
  // Get non-skipped lines
  const goodLines = ocr.lines
    .filter((line) => line.confidence > 0.5 && !shouldSkipLine(line.text))
    .sort((a, b) => b.confidence - a.confidence);

  // Take top lines (weighted by confidence)
  const selectedLines = goodLines.slice(0, 5);

  // Join and filter
  const rawQuery = selectedLines.map((l) => l.text.trim()).join(' ');
  return filterNoiseFromQuery(rawQuery);
}

// ============================================================================
// Hint Extraction
// ============================================================================

/**
 * Common author name patterns
 */
const AUTHOR_PATTERNS = [
  /^by\s+(.+)$/i,
  /^author[:\s]+(.+)$/i,
  /^written\s+by\s+(.+)$/i,
  /^([A-Z][a-z]+(?:\s+[A-Z]\.?\s+)?[A-Z][a-z]+)$/,  // First Last, First M. Last
];

/**
 * Extract title hint from OCR
 * Takes the highest confidence non-author line
 *
 * @param ocr - OCR result
 * @returns Title hint or undefined
 */
export function extractTitleHint(ocr: OCRResult): string | undefined {
  // If OCR already has a title candidate, use it
  if (ocr.titleCandidate) {
    return ocr.titleCandidate;
  }

  // Find best non-author line
  const goodLines = ocr.lines
    .filter((line) => {
      if (line.confidence < 0.6) return false;
      if (shouldSkipLine(line.text)) return false;
      // Skip if looks like author
      for (const pattern of AUTHOR_PATTERNS) {
        if (pattern.test(line.text)) return false;
      }
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence);

  if (goodLines.length > 0) {
    // Prefer longer lines (more likely to be title)
    const byLength = [...goodLines].sort((a, b) => b.text.length - a.text.length);
    // Return the longer of the most confident lines
    if (byLength[0].text.length > goodLines[0].text.length * 0.8) {
      return byLength[0].text.trim();
    }
    return goodLines[0].text.trim();
  }

  return undefined;
}

/**
 * Extract author hint from OCR
 *
 * @param ocr - OCR result
 * @returns Author hint or undefined
 */
export function extractAuthorHint(ocr: OCRResult): string | undefined {
  // If OCR already has an author candidate, use it
  if (ocr.authorCandidate) {
    return ocr.authorCandidate;
  }

  // Look for author patterns
  for (const line of ocr.lines) {
    if (line.confidence < 0.5) continue;

    for (const pattern of AUTHOR_PATTERNS) {
      const match = line.text.match(pattern);
      if (match) {
        return match[1]?.trim() || line.text.trim();
      }
    }
  }

  return undefined;
}

// ============================================================================
// Candidate Generation
// ============================================================================

export interface GenerateCandidatesInput {
  /** Evidence summary from quality classification */
  evidenceSummary: EvidenceSummary;
  /** OCR results indexed by crop index */
  ocrResultsByCropIndex: Record<number, OCRResult>;
  /** Optional merged evidence from book candidate */
  mergedEvidence?: BookEvidence;
}

export interface GenerateCandidatesResult {
  /** Generated search candidates */
  candidates: SearchCandidate[];
  /** Best evidence tier used */
  evidenceTier: EvidenceTier;
  /** Full text block for verification */
  fullTextBlock: string;
  /** Extracted spine field evidence (when field extraction enabled) */
  fieldEvidence?: SpineFieldEvidence;
}

/**
 * Generate search candidates from classified evidence
 *
 * Strategy:
 * 1. Find best available tier (strong > usable > weak)
 * 2. Generate candidates from crops at that tier
 * 3. Apply confidence multipliers
 * 4. Extract ISBN, title, author hints
 * 5. When field extraction enabled, enhance with publisher/edition/year
 *
 * @param input - Candidate generation input
 * @returns Generated candidates and metadata
 */
export function generateSearchCandidates(
  input: GenerateCandidatesInput
): GenerateCandidatesResult {
  const { evidenceSummary, ocrResultsByCropIndex, mergedEvidence } = input;

  // Determine best tier to use
  const sessionTier = evidenceSummary.sessionTier;

  if (sessionTier === 'unusable') {
    return {
      candidates: [],
      evidenceTier: 'unusable',
      fullTextBlock: '',
    };
  }

  // Get crops at session tier or better
  const eligibleCropIndices = getCropsAtTierOrBetter(
    evidenceSummary,
    sessionTier
  );

  // Build full text block from eligible crops
  const fullTextParts: string[] = [];
  for (const cropIndex of eligibleCropIndices) {
    const ocr = ocrResultsByCropIndex[cropIndex];
    if (ocr?.fullText) {
      fullTextParts.push(ocr.fullText);
    }
  }
  const fullTextBlock = fullTextParts.join('\n');

  // If we have merged evidence, also check for ISBN there
  const mergedText = mergedEvidence?.mergedTextBlock || '';
  const combinedText = fullTextBlock + '\n' + mergedText;

  // Try to find ISBN in combined text
  const globalIsbn = findFirstIsbn(combinedText);

  // Extract spine field evidence when feature flag enabled
  let fieldEvidence: SpineFieldEvidence | undefined;
  if (isFieldExtractionEnabled() && mergedEvidence) {
    fieldEvidence = extractSpineFieldEvidence(mergedEvidence);

    if (isMetadataVerboseDebug()) {
      console.log(
        `[SearchCandidate] Field extraction enabled: ` +
          `isbns=${fieldEvidence.isbnCandidates.length}, ` +
          `publishers=${fieldEvidence.publisherCandidates.length}, ` +
          `titles=${fieldEvidence.titleCandidates.length}, ` +
          `authors=${fieldEvidence.authorCandidates.length}`
      );
    }
  }

  // Generate candidates from each eligible crop
  const candidates: SearchCandidate[] = [];

  for (const cropIndex of eligibleCropIndices) {
    const ocr = ocrResultsByCropIndex[cropIndex];
    if (!ocr || !ocr.ok) continue;

    const cropClassification = evidenceSummary.cropClassifications.find(
      (c) => c.cropIndex === cropIndex
    );
    const cropTier = cropClassification?.tier || 'usable';

    // Build query
    const query = buildSearchQuery(ocr);
    if (query.length < MIN_QUERY_LENGTH) continue;

    // Extract hints (may be enhanced by field extraction)
    let titleHint = extractTitleHint(ocr);
    let authorHint = extractAuthorHint(ocr);
    let publisherHint: string | undefined;
    let editionHint: string | undefined;
    let yearHint: string | undefined;

    // When field extraction enabled, use enhanced hints
    if (fieldEvidence) {
      // Use field extraction title/author if better quality
      const bestTitle = fieldEvidence.titleCandidates[0];
      const bestAuthor = fieldEvidence.authorCandidates[0];

      if (bestTitle && bestTitle.confidence > 0.5) {
        titleHint = bestTitle.value;
      }
      if (bestAuthor && bestAuthor.confidence > 0.5) {
        authorHint = bestAuthor.value;
      }

      // Add new field hints
      const bestPublisher = fieldEvidence.publisherCandidates[0];
      const bestEdition = fieldEvidence.editionCandidates[0];
      const bestYear = fieldEvidence.yearCandidates[0];

      if (bestPublisher && bestPublisher.confidence > 0.4) {
        publisherHint = bestPublisher.value;
      }
      if (bestEdition && bestEdition.confidence > 0.4) {
        editionHint = bestEdition.value;
      }
      if (bestYear && bestYear.confidence > 0.4) {
        yearHint = String(bestYear.year);
      }
    }

    // Look for ISBN in this crop's text
    const cropIsbn = findFirstIsbn(ocr.fullText);
    let isbn = cropIsbn ?? globalIsbn ?? undefined;

    // If field extraction found a validated ISBN, prefer that
    if (fieldEvidence && fieldEvidence.isbnCandidates.length > 0) {
      const bestIsbn = fieldEvidence.isbnCandidates[0];
      if (bestIsbn.confidence > 0.8) {
        isbn = bestIsbn.normalized;
      }
    }

    // Calculate confidence
    const baseConfidence = ocr.avgConfidence;
    const multiplier = tierMultiplier(cropTier);
    const confidence = baseConfidence * multiplier;

    // Tokenize for coverage scoring
    const tokens = tokenize(query);

    const candidate: SearchCandidate = {
      query,
      titleHint,
      authorHint,
      isbn,
      publisherHint,
      editionHint,
      yearHint,
      confidence,
      cropIndex,
      tier: cropTier,
      tokens,
    };

    candidates.push(candidate);

    if (isMetadataVerboseDebug()) {
      console.log(
        `[SearchCandidate] Crop ${cropIndex}: tier=${cropTier}, ` +
          `conf=${confidence.toFixed(2)}, isbn=${isbn || 'none'}, ` +
          `title="${titleHint?.substring(0, 30) || 'none'}", ` +
          `author="${authorHint || 'none'}"` +
          (publisherHint ? `, publisher="${publisherHint}"` : '') +
          (editionHint ? `, edition="${editionHint}"` : '') +
          (yearHint ? `, year="${yearHint}"` : '')
      );
    }
  }

  // Sort by confidence and limit
  candidates.sort((a, b) => b.confidence - a.confidence);
  const limitedCandidates = candidates.slice(0, MAX_CANDIDATES);

  if (isMetadataVerboseDebug()) {
    console.log(
      `[SearchCandidate] Generated ${limitedCandidates.length} candidates ` +
        `at tier=${sessionTier}`
    );
  }

  return {
    candidates: limitedCandidates,
    evidenceTier: sessionTier,
    fullTextBlock,
    fieldEvidence,
  };
}

// ============================================================================
// ISBN-Based Candidate
// ============================================================================

/**
 * Generate ISBN-only candidate if ISBN found in evidence
 *
 * @param fullTextBlock - Combined OCR text
 * @param evidenceTier - Evidence tier
 * @returns ISBN candidate or null
 */
export function generateIsbnCandidate(
  fullTextBlock: string,
  evidenceTier: EvidenceTier
): SearchCandidate | null {
  const isbn = findFirstIsbn(fullTextBlock);

  if (!isbn) {
    return null;
  }

  return {
    query: isbn,
    isbn,
    confidence: 0.95 * tierMultiplier(evidenceTier), // ISBN is high confidence
    cropIndex: -1, // Not from specific crop
    tier: evidenceTier,
    tokens: [isbn],
  };
}

// ============================================================================
// Merged Evidence Candidate
// ============================================================================

/**
 * Generate candidate from merged book evidence
 *
 * @param evidence - Merged book evidence
 * @param evidenceTier - Evidence tier
 * @returns Candidate or null
 */
export function generateMergedEvidenceCandidate(
  evidence: BookEvidence,
  evidenceTier: EvidenceTier
): SearchCandidate | null {
  const query = filterNoiseFromQuery(evidence.mergedTextBlock);

  if (query.length < MIN_QUERY_LENGTH) {
    return null;
  }

  // Use hints from evidence if available
  const titleHint = evidence.perFieldHints?.titleHints[0];
  const authorHint = evidence.perFieldHints?.authorHints[0];

  // Look for ISBN
  const isbn = findFirstIsbn(evidence.mergedTextBlock) ?? undefined;

  // Average confidence from merged lines
  const avgConfidence =
    evidence.mergedLines.length > 0
      ? evidence.mergedLines.reduce((sum, l) => sum + l.confidence, 0) /
        evidence.mergedLines.length
      : 0.5;

  const confidence = avgConfidence * tierMultiplier(evidenceTier);

  return {
    query,
    titleHint,
    authorHint,
    isbn,
    confidence,
    cropIndex: -1, // From merged evidence
    tier: evidenceTier,
    tokens: tokenize(query),
  };
}
