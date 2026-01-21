/**
 * Mixed Orientation Evidence Merger (Gate 8)
 *
 * Merges evidence from multiple rotation trials per crop.
 * Instead of selecting one "best rotation", this service:
 * - Preserves per-rotation OCR outputs
 * - Selects top rotations by title/author score
 * - Merges lines from multiple orientations
 * - Handles cases where title is at 90° but publisher at 0°
 *
 * This enables more accurate field extraction when spine text
 * is printed in mixed orientations.
 */

import type {
  OCRResult,
  RotationTrialResult,
  OCRLine,
  BookEvidenceLine,
} from '../types';
import { scoreLine } from './spineLineLabeler';
import { isOtherLine } from './spineLineFilter';

// ============================================================================
// Types
// ============================================================================

export interface RotationEvidence {
  /** Rotation angle */
  rotation: number;
  /** Lines from this rotation */
  lines: BookEvidenceLine[];
  /** Best title score among lines */
  bestTitleScore: number;
  /** Best author score among lines */
  bestAuthorScore: number;
  /** Overall quality score */
  qualityScore: number;
  /** Whether this rotation has useful title/author content */
  hasUsefulContent: boolean;
}

export interface MixedOrientationResult {
  /** Evidence from each rotation trial */
  rotationEvidence: RotationEvidence[];
  /** Merged lines from selected rotations */
  mergedLines: BookEvidenceLine[];
  /** Primary rotation for title */
  titleRotation: number;
  /** Primary rotation for author */
  authorRotation: number;
  /** Primary rotation for other metadata */
  otherRotation: number;
  /** Whether mixed orientation was detected */
  isMixedOrientation: boolean;
  /** Debug info */
  debug: MixedOrientationDebug;
}

export interface MixedOrientationDebug {
  /** Number of rotations with content */
  rotationsWithContent: number;
  /** Number of rotations selected for merge */
  rotationsSelected: number;
  /** Total lines before dedup */
  totalLinesBefore: number;
  /** Total lines after dedup */
  totalLinesAfter: number;
  /** Strategy used */
  strategy: string;
}

// ============================================================================
// Configuration
// ============================================================================

/** Maximum rotations to include in merge */
const MAX_ROTATIONS_TO_MERGE = 2;

/** Minimum quality score to consider a rotation */
const MIN_QUALITY_THRESHOLD = 0.2;

/** Title/author score threshold for useful content */
const USEFUL_CONTENT_THRESHOLD = 0.4;

/** Similarity threshold for deduplication */
const DEDUP_SIMILARITY_THRESHOLD = 0.85;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize text for comparison
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute Levenshtein-based similarity
 */
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const normA = normalizeForComparison(a);
  const normB = normalizeForComparison(b);

  if (normA === normB) return 1;

  // Quick length check
  const lenDiff = Math.abs(normA.length - normB.length);
  const maxLen = Math.max(normA.length, normB.length);
  if (lenDiff / maxLen > 0.5) return 0;

  // Simplified similarity based on common prefix
  let commonPrefix = 0;
  const minLen = Math.min(normA.length, normB.length);
  for (let i = 0; i < minLen; i++) {
    if (normA[i] === normB[i]) commonPrefix++;
    else break;
  }

  return commonPrefix / maxLen;
}

/**
 * Convert OCRLine to BookEvidenceLine
 */
function toEvidenceLine(
  line: OCRLine,
  cropIndex: number,
  rotation: number
): BookEvidenceLine {
  return {
    text: line.text.trim(),
    normalizedText: normalizeForComparison(line.text),
    confidence: line.confidence,
    sourceCropIndex: cropIndex,
    rotation,
    bbox: line.bbox,
  };
}

/**
 * Analyze a single rotation trial
 */
function analyzeRotation(
  trial: RotationTrialResult,
  cropIndex: number
): RotationEvidence {
  const lines: BookEvidenceLine[] = [];
  let bestTitleScore = 0;
  let bestAuthorScore = 0;

  for (const ocrLine of trial.lines) {
    const text = ocrLine.text.trim();
    if (text.length < 2) continue;

    // Check if it's an OTHER line (noise)
    const { isOther } = isOtherLine(text);
    if (isOther) continue;

    const line = toEvidenceLine(ocrLine, cropIndex, trial.rotation);
    lines.push(line);

    // Score for title/author
    const { titleScore, authorScore } = scoreLine(text);
    bestTitleScore = Math.max(bestTitleScore, titleScore);
    bestAuthorScore = Math.max(bestAuthorScore, authorScore);
  }

  const hasUsefulContent =
    bestTitleScore > USEFUL_CONTENT_THRESHOLD ||
    bestAuthorScore > USEFUL_CONTENT_THRESHOLD;

  return {
    rotation: trial.rotation,
    lines,
    bestTitleScore,
    bestAuthorScore,
    qualityScore: trial.qualityScore,
    hasUsefulContent,
  };
}

/**
 * Deduplicate lines from multiple rotations
 */
function deduplicateLines(lines: BookEvidenceLine[]): BookEvidenceLine[] {
  const result: BookEvidenceLine[] = [];

  for (const line of lines) {
    let isDuplicate = false;

    for (let i = 0; i < result.length; i++) {
      const similarity = computeSimilarity(line.text, result[i].text);
      if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
        // Keep the one with higher confidence
        if (line.confidence > result[i].confidence) {
          result[i] = line;
        }
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      result.push(line);
    }
  }

  return result;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Merge evidence from multiple rotation trials
 *
 * @param ocrResult - OCR result with rotation trials
 * @param cropIndex - Index of the crop
 * @returns Merged evidence from multiple orientations
 */
export function mergeRotationEvidence(
  ocrResult: OCRResult,
  cropIndex: number
): MixedOrientationResult {
  const rotationEvidence: RotationEvidence[] = [];
  let allLines: BookEvidenceLine[] = [];

  // If no rotation trials, use the main result
  if (!ocrResult.rotationTrials || ocrResult.rotationTrials.length === 0) {
    // Create single rotation evidence from main result
    const lines: BookEvidenceLine[] = [];
    for (const ocrLine of ocrResult.lines) {
      const text = ocrLine.text.trim();
      if (text.length < 2) continue;
      lines.push(toEvidenceLine(ocrLine, cropIndex, ocrResult.chosenRotation));
    }

    return {
      rotationEvidence: [{
        rotation: ocrResult.chosenRotation,
        lines,
        bestTitleScore: 0.5,
        bestAuthorScore: 0.5,
        qualityScore: ocrResult.avgConfidence,
        hasUsefulContent: lines.length > 0,
      }],
      mergedLines: lines,
      titleRotation: ocrResult.chosenRotation,
      authorRotation: ocrResult.chosenRotation,
      otherRotation: ocrResult.chosenRotation,
      isMixedOrientation: false,
      debug: {
        rotationsWithContent: 1,
        rotationsSelected: 1,
        totalLinesBefore: lines.length,
        totalLinesAfter: lines.length,
        strategy: 'single_rotation',
      },
    };
  }

  // Analyze each rotation trial
  for (const trial of ocrResult.rotationTrials) {
    const evidence = analyzeRotation(trial, cropIndex);
    rotationEvidence.push(evidence);
  }

  // Sort by quality score
  rotationEvidence.sort((a, b) => b.qualityScore - a.qualityScore);

  // Find best rotation for each purpose
  let titleRotation = ocrResult.chosenRotation;
  let authorRotation = ocrResult.chosenRotation;
  let otherRotation = ocrResult.chosenRotation;

  for (const ev of rotationEvidence) {
    if (ev.bestTitleScore > 0.5) {
      titleRotation = ev.rotation;
      break;
    }
  }

  for (const ev of rotationEvidence) {
    if (ev.bestAuthorScore > 0.5) {
      authorRotation = ev.rotation;
      break;
    }
  }

  // Select rotations to merge
  const rotationsToMerge = rotationEvidence
    .filter(ev => ev.qualityScore >= MIN_QUALITY_THRESHOLD && ev.hasUsefulContent)
    .slice(0, MAX_ROTATIONS_TO_MERGE);

  // Collect all lines from selected rotations
  for (const ev of rotationsToMerge) {
    allLines.push(...ev.lines);
  }

  const totalLinesBefore = allLines.length;

  // Deduplicate
  const mergedLines = deduplicateLines(allLines);

  // Sort by confidence
  mergedLines.sort((a, b) => b.confidence - a.confidence);

  // Determine if mixed orientation
  const uniqueRotations = new Set(rotationsToMerge.map(r => r.rotation));
  const isMixedOrientation = uniqueRotations.size > 1;

  // Determine strategy
  let strategy = 'single_rotation';
  if (isMixedOrientation) {
    strategy = 'mixed_rotation';
  } else if (rotationsToMerge.length === 0) {
    strategy = 'fallback_chosen';
    // Use chosen rotation's lines as fallback
    for (const ocrLine of ocrResult.lines) {
      const text = ocrLine.text.trim();
      if (text.length >= 2) {
        mergedLines.push(toEvidenceLine(ocrLine, cropIndex, ocrResult.chosenRotation));
      }
    }
  }

  return {
    rotationEvidence,
    mergedLines,
    titleRotation,
    authorRotation,
    otherRotation,
    isMixedOrientation,
    debug: {
      rotationsWithContent: rotationEvidence.filter(r => r.hasUsefulContent).length,
      rotationsSelected: rotationsToMerge.length,
      totalLinesBefore,
      totalLinesAfter: mergedLines.length,
      strategy,
    },
  };
}

/**
 * Merge evidence from multiple crops with mixed orientation support
 */
export function mergeMultipleCropsWithMixedOrientation(
  ocrResults: Record<number, OCRResult>,
  cropIndices: number[]
): {
  mergedLines: BookEvidenceLine[];
  mixedOrientationDetected: boolean;
  perCropResults: MixedOrientationResult[];
} {
  const perCropResults: MixedOrientationResult[] = [];
  let allLines: BookEvidenceLine[] = [];
  let mixedOrientationDetected = false;

  for (const cropIndex of cropIndices) {
    const ocrResult = ocrResults[cropIndex];
    if (!ocrResult || !ocrResult.ok) continue;

    const result = mergeRotationEvidence(ocrResult, cropIndex);
    perCropResults.push(result);

    allLines.push(...result.mergedLines);

    if (result.isMixedOrientation) {
      mixedOrientationDetected = true;
    }
  }

  // Final deduplication across crops
  const mergedLines = deduplicateLines(allLines);
  mergedLines.sort((a, b) => b.confidence - a.confidence);

  return {
    mergedLines,
    mixedOrientationDetected,
    perCropResults,
  };
}
