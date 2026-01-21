/**
 * Spine Evidence Merger (Gate 7)
 *
 * Merges OCR evidence from multiple crops per book candidate.
 * Selects top K crops by quality, normalizes lines, and de-duplicates.
 */

import type {
  OCRResult,
  BookCandidate,
  BookEvidence,
  BookEvidenceLine,
} from '../types';

// ============================================================================
// Configuration Constants
// ============================================================================

/** Number of top crops to select per candidate */
const TOP_K_CROPS = 3;

/** Similarity threshold for line deduplication (0-1, higher = more strict) */
const DEDUP_SIMILARITY_THRESHOLD = 0.85;

/** Minimum line length to include in evidence */
const MIN_LINE_LENGTH = 2;

// ============================================================================
// Text Normalization
// ============================================================================

/**
 * Normalize text for comparison
 * - Lowercase
 * - Remove punctuation
 * - Collapse whitespace
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ')    // Collapse whitespace
    .trim();
}

/**
 * OCR-tolerant normalization for fuzzy matching
 * - Apply standard normalization
 * - Common OCR error substitutions (O/0, l/1/I, etc.)
 */
function ocrNormalize(text: string): string {
  let normalized = normalizeText(text);

  // Common OCR confusions
  normalized = normalized
    .replace(/[0o]/g, 'o')  // 0 and O
    .replace(/[1il|]/g, 'i') // 1, i, l, |
    .replace(/[5s]/g, 's')   // 5 and S
    .replace(/[8b]/g, 'b');  // 8 and B

  return normalized;
}

// ============================================================================
// Similarity Computation
// ============================================================================

/**
 * Compute Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Handle empty strings
  if (m === 0) return n;
  if (n === 0) return m;

  // Create distance matrix
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  // Initialize first row and column
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill in the rest
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // Deletion
        dp[i][j - 1] + 1,      // Insertion
        dp[i - 1][j - 1] + cost // Substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Compute similarity ratio between two strings (0-1)
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);
  return 1 - distance / maxLength;
}

/**
 * Check if two lines are similar enough to be considered duplicates
 */
function areSimilarLines(line1: BookEvidenceLine, line2: BookEvidenceLine): boolean {
  // Use OCR-normalized text for comparison
  const norm1 = ocrNormalize(line1.text);
  const norm2 = ocrNormalize(line2.text);

  // Short-circuit for exact matches
  if (norm1 === norm2) return true;

  // Use similarity threshold
  return stringSimilarity(norm1, norm2) >= DEDUP_SIMILARITY_THRESHOLD;
}

// ============================================================================
// Crop Scoring
// ============================================================================

/**
 * Score a crop for quality ranking
 * Higher is better
 */
function scoreCrop(ocrResult: OCRResult): number {
  if (!ocrResult.ok) return 0;

  // Scoring factors:
  // - Average confidence (0-1)
  // - Alnum ratio (0-1) - higher is better (less noise)
  // - Character count (logarithmic) - more text is usually better
  // - Has title candidate (bonus)

  const confidenceWeight = 0.4;
  const alnumWeight = 0.2;
  const charCountWeight = 0.2;
  const titleBonusWeight = 0.2;

  const charCountScore = Math.min(1, Math.log10(Math.max(1, ocrResult.charCount)) / 3);
  const titleBonus = ocrResult.titleCandidate ? 1 : 0;

  const score =
    confidenceWeight * ocrResult.avgConfidence +
    alnumWeight * ocrResult.alnumRatio +
    charCountWeight * charCountScore +
    titleBonusWeight * titleBonus;

  return score;
}

// ============================================================================
// Evidence Merging
// ============================================================================

export interface MergeInput {
  /** The candidate to merge evidence for */
  candidate: BookCandidate;
  /** OCR results indexed by crop index */
  ocrResultsByCropIndex: Record<number, OCRResult>;
}

/**
 * Merge OCR evidence for a single book candidate
 *
 * Algorithm:
 * 1. Score each crop in the candidate by OCR quality
 * 2. Select top K crops
 * 3. Collect all lines from selected crops
 * 4. De-duplicate similar lines (keep highest confidence)
 * 5. Order lines by confidence
 * 6. Build merged text block
 *
 * @param input MergeInput with candidate and OCR results
 * @returns BookEvidence with merged lines and text
 */
export function mergeEvidenceForCandidate(input: MergeInput): BookEvidence {
  const { candidate, ocrResultsByCropIndex } = input;

  // Handle empty crop list
  if (candidate.cropIndices.length === 0) {
    return {
      topCrops: [],
      mergedLines: [],
      mergedTextBlock: '',
    };
  }

  // Step 1: Score each crop
  const cropScores: Array<{ cropIndex: number; score: number; ocrResult: OCRResult }> = [];

  for (const cropIndex of candidate.cropIndices) {
    const ocrResult = ocrResultsByCropIndex[cropIndex];
    if (ocrResult && ocrResult.ok) {
      cropScores.push({
        cropIndex,
        score: scoreCrop(ocrResult),
        ocrResult,
      });
    }
  }

  // Sort by score descending
  cropScores.sort((a, b) => b.score - a.score);

  // Step 2: Select top K
  const topCrops = cropScores.slice(0, TOP_K_CROPS);
  const topCropIndices = topCrops.map(c => c.cropIndex);

  // Step 3: Collect all lines with provenance
  const allLines: BookEvidenceLine[] = [];

  for (const { cropIndex, ocrResult } of topCrops) {
    for (const line of ocrResult.lines) {
      if (line.text.trim().length < MIN_LINE_LENGTH) continue;

      allLines.push({
        text: line.text.trim(),
        normalizedText: normalizeText(line.text),
        confidence: line.confidence,
        sourceCropIndex: cropIndex,
        rotation: ocrResult.chosenRotation,
        bbox: line.bbox,
      });
    }
  }

  // Step 4: De-duplicate similar lines
  const mergedLines: BookEvidenceLine[] = [];

  for (const line of allLines) {
    // Check if similar line already exists
    let foundSimilar = false;
    for (let i = 0; i < mergedLines.length; i++) {
      if (areSimilarLines(line, mergedLines[i])) {
        // Keep the one with higher confidence
        if (line.confidence > mergedLines[i].confidence) {
          mergedLines[i] = line;
        }
        foundSimilar = true;
        break;
      }
    }

    if (!foundSimilar) {
      mergedLines.push(line);
    }
  }

  // Step 5: Sort by confidence descending
  mergedLines.sort((a, b) => b.confidence - a.confidence);

  // Step 6: Build merged text block
  const mergedTextBlock = mergedLines.map(l => l.text).join('\n');

  // Extract per-field hints (basic heuristic for now)
  const perFieldHints = extractFieldHints(mergedLines, topCrops);

  return {
    topCrops: topCropIndices,
    mergedLines,
    mergedTextBlock,
    perFieldHints,
  };
}

/**
 * Extract basic field hints from merged lines
 * This provides hints for Gate 8 field extraction
 */
function extractFieldHints(
  lines: BookEvidenceLine[],
  topCrops: Array<{ cropIndex: number; ocrResult: OCRResult }>
): { titleHints: string[]; authorHints: string[] } {
  const titleHints: string[] = [];
  const authorHints: string[] = [];

  // Collect title/author candidates from OCR results
  for (const { ocrResult } of topCrops) {
    if (ocrResult.titleCandidate && !titleHints.includes(ocrResult.titleCandidate)) {
      titleHints.push(ocrResult.titleCandidate);
    }
    if (ocrResult.authorCandidate && !authorHints.includes(ocrResult.authorCandidate)) {
      authorHints.push(ocrResult.authorCandidate);
    }
  }

  return { titleHints, authorHints };
}

/**
 * Merge evidence for all candidates in a list
 *
 * @param candidates List of book candidates (will be mutated)
 * @param ocrResultsByCropIndex OCR results indexed by crop index
 * @returns The same candidates with evidence filled in
 */
export function mergeEvidenceForAllCandidates(
  candidates: BookCandidate[],
  ocrResultsByCropIndex: Record<number, OCRResult>
): BookCandidate[] {
  for (const candidate of candidates) {
    candidate.evidence = mergeEvidenceForCandidate({
      candidate,
      ocrResultsByCropIndex,
    });
  }

  // Log summary
  const totalLines = candidates.reduce((sum, c) => sum + c.evidence.mergedLines.length, 0);
  const candidatesWithEvidence = candidates.filter(c => c.evidence.mergedLines.length > 0).length;

  console.log(`[EvidenceMerger] Merged evidence for ${candidates.length} candidates`);
  console.log(`[EvidenceMerger] ${candidatesWithEvidence} candidates have OCR evidence`);
  console.log(`[EvidenceMerger] ${totalLines} total merged lines`);

  return candidates;
}
