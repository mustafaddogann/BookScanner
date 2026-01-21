/**
 * Evidence Quality Service (Gate 8 - QUALITY_CLASSIFY)
 *
 * Classifies crop/OCR evidence into quality tiers for metadata resolution.
 * Evidence tiers affect scoring thresholds and confidence adjustments.
 */

import type {
  EvidenceTier,
  CropEvidenceClassification,
  EvidenceSummary,
  OCRResult,
} from '../types';
import type { DetectionRectifyInfo } from '../store/useAppStore';
import { isMetadataVerboseDebug } from '../config/debug';

// ============================================================================
// Configuration
// ============================================================================

/** OCR confidence threshold for unusable tier */
const UNUSABLE_CONFIDENCE_THRESHOLD = 0.4;

/** OCR confidence threshold for weak tier */
const WEAK_CONFIDENCE_THRESHOLD = 0.6;

/** OCR confidence threshold for strong tier */
const STRONG_CONFIDENCE_THRESHOLD = 0.8;

/** Minimum character count for unusable tier */
const UNUSABLE_CHAR_COUNT_THRESHOLD = 3;

/** Minimum character count for weak tier */
const WEAK_CHAR_COUNT_THRESHOLD = 8;

/** Minimum character count for strong tier */
const STRONG_CHAR_COUNT_THRESHOLD = 15;

/** Minimum alnum ratio for unusable tier */
const UNUSABLE_ALNUM_RATIO_THRESHOLD = 0.3;

/** Minimum blur score for strong tier (if available) */
const STRONG_BLUR_SCORE_THRESHOLD = 100;

// ============================================================================
// Tier Multipliers
// ============================================================================

/**
 * Confidence multiplier by evidence tier
 * Used to adjust match confidence based on evidence quality
 */
export const TIER_MULTIPLIERS: Record<EvidenceTier, number> = {
  strong: 1.0,
  usable: 0.85,
  weak: 0.6,
  unusable: 0,
};

/**
 * Get tier multiplier for a given tier
 *
 * @param tier - Evidence tier
 * @returns Multiplier value [0-1]
 */
export function tierMultiplier(tier: EvidenceTier): number {
  return TIER_MULTIPLIERS[tier];
}

// ============================================================================
// Single Crop Classification
// ============================================================================

export interface ClassifyEvidenceInput {
  /** Rectification result for the crop */
  rectification: DetectionRectifyInfo;
  /** OCR result for the crop */
  ocr: OCRResult | undefined;
  /** Optional blur score from quality analysis */
  blurScore?: number;
}

/**
 * Classify evidence quality for a single crop
 *
 * Rules:
 * - unusable: rectification failed OR ocr.confidence < 0.4 OR ocr.charCount < 3 OR ocr.alnumRatio < 0.3
 * - weak: rectification skipped OR ocr.confidence < 0.6 OR ocr.charCount < 8
 * - strong: ocr.confidence > 0.8 AND ocr.charCount > 15 AND (blurScore > 100 if available)
 * - else: usable
 *
 * @param input - Crop classification input
 * @returns CropEvidenceClassification
 */
export function classifyEvidence(
  input: ClassifyEvidenceInput
): CropEvidenceClassification {
  const { rectification, ocr, blurScore } = input;

  // Determine rectification status
  let rectificationStatus: 'success' | 'skipped' | 'failed';
  if (!rectification.cropUri || rectification.rectificationMethod === 'skipped') {
    rectificationStatus = rectification.skippedReason ? 'skipped' : 'failed';
  } else {
    rectificationStatus = 'success';
  }

  // Get OCR metrics with defaults for missing OCR
  const ocrConfidence = ocr?.avgConfidence ?? 0;
  const charCount = ocr?.charCount ?? 0;
  const alnumRatio = ocr?.alnumRatio ?? 0;

  // Start tier determination
  let tier: EvidenceTier = 'usable';

  // Check for unusable conditions
  if (
    rectificationStatus === 'failed' ||
    !ocr?.ok ||
    ocrConfidence < UNUSABLE_CONFIDENCE_THRESHOLD ||
    charCount < UNUSABLE_CHAR_COUNT_THRESHOLD ||
    alnumRatio < UNUSABLE_ALNUM_RATIO_THRESHOLD
  ) {
    tier = 'unusable';
  }
  // Check for weak conditions
  else if (
    rectificationStatus === 'skipped' ||
    ocrConfidence < WEAK_CONFIDENCE_THRESHOLD ||
    charCount < WEAK_CHAR_COUNT_THRESHOLD
  ) {
    tier = 'weak';
  }
  // Check for strong conditions
  else if (
    ocrConfidence > STRONG_CONFIDENCE_THRESHOLD &&
    charCount > STRONG_CHAR_COUNT_THRESHOLD
  ) {
    // Blur score check if available
    if (blurScore === undefined || blurScore > STRONG_BLUR_SCORE_THRESHOLD) {
      tier = 'strong';
    }
  }
  // Default: usable (already set)

  const classification: CropEvidenceClassification = {
    cropIndex: rectification.detectionIndex,
    tier,
    ocrConfidence,
    charCount,
    alnumRatio,
    rectificationStatus,
    blurScore,
  };

  if (isMetadataVerboseDebug()) {
    console.log(
      `[EvidenceQuality] Crop ${rectification.detectionIndex}: tier=${tier}, ` +
        `conf=${ocrConfidence.toFixed(2)}, chars=${charCount}, alnum=${alnumRatio.toFixed(2)}, ` +
        `rect=${rectificationStatus}, blur=${blurScore ?? 'N/A'}`
    );
  }

  return classification;
}

// ============================================================================
// Session-Level Classification
// ============================================================================

export interface ClassifySessionInput {
  /** All rectification results */
  rectificationResults: DetectionRectifyInfo[];
  /** OCR results indexed by crop index */
  ocrResultsByCropIndex: Record<number, OCRResult>;
  /** Optional blur scores indexed by crop index */
  blurScoresByCropIndex?: Record<number, number>;
}

/**
 * Classify evidence quality for an entire session
 * Returns per-crop classifications and overall session tier (best available)
 *
 * @param input - Session classification input
 * @returns EvidenceSummary
 */
export function classifySessionEvidence(
  input: ClassifySessionInput
): EvidenceSummary {
  const { rectificationResults, ocrResultsByCropIndex, blurScoresByCropIndex } =
    input;

  // Classify each crop
  const cropClassifications: CropEvidenceClassification[] = [];
  const tierCounts: Record<EvidenceTier, number> = {
    strong: 0,
    usable: 0,
    weak: 0,
    unusable: 0,
  };

  for (const rectification of rectificationResults) {
    const cropIndex = rectification.detectionIndex;
    const ocr = ocrResultsByCropIndex[cropIndex];
    const blurScore = blurScoresByCropIndex?.[cropIndex];

    const classification = classifyEvidence({
      rectification,
      ocr,
      blurScore,
    });

    cropClassifications.push(classification);
    tierCounts[classification.tier]++;
  }

  // Determine session tier (best available)
  let sessionTier: EvidenceTier = 'unusable';
  if (tierCounts.strong > 0) {
    sessionTier = 'strong';
  } else if (tierCounts.usable > 0) {
    sessionTier = 'usable';
  } else if (tierCounts.weak > 0) {
    sessionTier = 'weak';
  }

  const summary: EvidenceSummary = {
    sessionTier,
    cropClassifications,
    tierCounts,
  };

  if (isMetadataVerboseDebug()) {
    console.log(
      `[EvidenceQuality] Session summary: tier=${sessionTier}, ` +
        `strong=${tierCounts.strong}, usable=${tierCounts.usable}, ` +
        `weak=${tierCounts.weak}, unusable=${tierCounts.unusable}`
    );
  }

  return summary;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get crops of a specific tier or better
 *
 * @param summary - Evidence summary
 * @param minTier - Minimum tier to include
 * @returns Array of crop indices meeting criteria
 */
export function getCropsAtTierOrBetter(
  summary: EvidenceSummary,
  minTier: EvidenceTier
): number[] {
  const tierOrder: EvidenceTier[] = ['strong', 'usable', 'weak', 'unusable'];
  const minTierIndex = tierOrder.indexOf(minTier);

  return summary.cropClassifications
    .filter((c) => tierOrder.indexOf(c.tier) <= minTierIndex)
    .map((c) => c.cropIndex);
}

/**
 * Get the best classified crop
 *
 * @param summary - Evidence summary
 * @returns Best crop classification or null if all unusable
 */
export function getBestCrop(
  summary: EvidenceSummary
): CropEvidenceClassification | null {
  const tierOrder: EvidenceTier[] = ['strong', 'usable', 'weak', 'unusable'];

  let bestCrop: CropEvidenceClassification | null = null;
  let bestTierIndex = tierOrder.length;

  for (const crop of summary.cropClassifications) {
    const tierIndex = tierOrder.indexOf(crop.tier);
    if (tierIndex < bestTierIndex) {
      bestTierIndex = tierIndex;
      bestCrop = crop;
    } else if (tierIndex === bestTierIndex && bestCrop) {
      // Tie-break by confidence
      if (crop.ocrConfidence > bestCrop.ocrConfidence) {
        bestCrop = crop;
      }
    }
  }

  return bestCrop;
}
