/**
 * Book Candidate Grouper (Gate 7)
 *
 * Clusters multiple detections/crops that belong to the same physical book
 * into BookCandidate objects with stable left-to-right ordering.
 *
 * CONSERVATIVE BY DEFAULT: Only merge when there is strong evidence of
 * duplicates or split-detections of the same spine.
 */

import type {
  OBBDetection,
  BookCandidate,
  BookCandidateId,
  BookEvidence,
  BookCandidatesSummary,
  OCRResult,
} from '../types';
import type { DetectionRectifyInfo } from '../store/useAppStore';
import { normalizedJaroWinkler } from '../utils/stringSimilarity';

// ============================================================================
// Configuration Constants - CONSERVATIVE THRESHOLDS
// ============================================================================

/** Minimum IoU to merge as duplicates (high overlap) */
const IOU_MERGE_THRESHOLD = 0.50;

/** Maximum angle difference (radians) for split-detection merge (~10 degrees) */
const SPLIT_ANGLE_THRESHOLD_RAD = 0.175;

/** Center proximity threshold as ratio of min dimension for split-detection */
const SPLIT_CENTER_DIST_RATIO = 0.15;

/** Minimum OCR text similarity for split-detection merge */
const SPLIT_OCR_SIMILARITY_THRESHOLD = 0.75;

/** Maximum crops per candidate before triggering safety fallback */
const MAX_CROPS_PER_CANDIDATE = 3;

// ============================================================================
// Types for Debug Artifacts
// ============================================================================

export interface GroupingMergeRecord {
  aIndex: number;
  bIndex: number;
  reason: 'iou_duplicate' | 'split_detection';
  iou: number;
  angleDiffDeg: number;
  centerDistPx: number;
  textSim: number | null;
}

export interface GroupingAssignments {
  candidates: Array<{
    candidateId: string;
    cropIndices: number[];
    detectionIndices: number[];
  }>;
  merges: GroupingMergeRecord[];
  safetyFallbackTriggered: boolean;
  config: {
    iouMergeThreshold: number;
    splitAngleThresholdDeg: number;
    splitCenterDistRatio: number;
    splitOcrSimilarityThreshold: number;
    maxCropsPerCandidate: number;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize angle to range [-PI, PI]
 */
function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

/**
 * Compute absolute angle difference in radians, accounting for wrap-around
 */
function angleDifferenceRad(a1: number, a2: number): number {
  const diff = normalizeAngle(a1 - a2);
  return Math.abs(diff);
}

/**
 * Compute distance between detection centers
 */
function centerDistance(d1: OBBDetection, d2: OBBDetection): number {
  const dx = d1.cx - d2.cx;
  const dy = d1.cy - d2.cy;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute axis-aligned bounding box IoU (stopgap for OBB IoU)
 * This approximates OBB IoU by using AABBs
 */
function computeAABBIoU(d1: OBBDetection, d2: OBBDetection): number {
  // For OBB, compute AABB that contains the rotated box
  // This is an approximation; true OBB IoU would be better but more complex
  const hw1 = d1.width / 2;
  const hh1 = d1.height / 2;
  const hw2 = d2.width / 2;
  const hh2 = d2.height / 2;

  // Simple AABB from center +/- half dimensions (ignoring rotation for approximation)
  // For better accuracy with rotation, we'd compute the bounding box of rotated corners
  const cos1 = Math.abs(Math.cos(d1.angle));
  const sin1 = Math.abs(Math.sin(d1.angle));
  const aabb1HalfW = hw1 * cos1 + hh1 * sin1;
  const aabb1HalfH = hw1 * sin1 + hh1 * cos1;

  const cos2 = Math.abs(Math.cos(d2.angle));
  const sin2 = Math.abs(Math.sin(d2.angle));
  const aabb2HalfW = hw2 * cos2 + hh2 * sin2;
  const aabb2HalfH = hw2 * sin2 + hh2 * cos2;

  // AABB corners
  const left1 = d1.cx - aabb1HalfW;
  const right1 = d1.cx + aabb1HalfW;
  const top1 = d1.cy - aabb1HalfH;
  const bottom1 = d1.cy + aabb1HalfH;

  const left2 = d2.cx - aabb2HalfW;
  const right2 = d2.cx + aabb2HalfW;
  const top2 = d2.cy - aabb2HalfH;
  const bottom2 = d2.cy + aabb2HalfH;

  // Intersection
  const interLeft = Math.max(left1, left2);
  const interRight = Math.min(right1, right2);
  const interTop = Math.max(top1, top2);
  const interBottom = Math.min(bottom1, bottom2);

  if (interRight <= interLeft || interBottom <= interTop) {
    return 0; // No intersection
  }

  const interArea = (interRight - interLeft) * (interBottom - interTop);
  const area1 = (right1 - left1) * (bottom1 - top1);
  const area2 = (right2 - left2) * (bottom2 - top2);
  const unionArea = area1 + area2 - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Check if two detections should be merged (conservative approach)
 *
 * Returns merge info if they should merge, null otherwise
 */
function shouldMerge(
  d1: OBBDetection,
  d2: OBBDetection,
  idx1: number,
  idx2: number,
  ocrTexts: Map<number, string>
): GroupingMergeRecord | null {
  const iou = computeAABBIoU(d1, d2);
  const angleDiffRad = angleDifferenceRad(d1.angle, d2.angle);
  const angleDiffDeg = (angleDiffRad * 180) / Math.PI;
  const centerDistPx = centerDistance(d1, d2);

  // Path 1: High IoU merge (duplicates)
  if (iou >= IOU_MERGE_THRESHOLD) {
    const textSim = computeOcrSimilarity(idx1, idx2, ocrTexts);
    return {
      aIndex: idx1,
      bIndex: idx2,
      reason: 'iou_duplicate',
      iou,
      angleDiffDeg,
      centerDistPx,
      textSim,
    };
  }

  // Path 2: Split-detection merge (same spine detected as multiple boxes)
  // Requires: similar angle + close centers + OCR similarity (when available)
  if (angleDiffRad <= SPLIT_ANGLE_THRESHOLD_RAD) {
    const minDim = Math.min(d1.width, d1.height, d2.width, d2.height);
    const centerThreshold = minDim * SPLIT_CENTER_DIST_RATIO;

    if (centerDistPx <= centerThreshold) {
      const textSim = computeOcrSimilarity(idx1, idx2, ocrTexts);

      // If OCR is available for both, require similarity
      if (textSim !== null) {
        if (textSim >= SPLIT_OCR_SIMILARITY_THRESHOLD) {
          return {
            aIndex: idx1,
            bIndex: idx2,
            reason: 'split_detection',
            iou,
            angleDiffDeg,
            centerDistPx,
            textSim,
          };
        }
        // OCR available but not similar enough - don't merge
        return null;
      }

      // No OCR available - only merge on IoU path, not split-detection
      // This prevents merging unrelated spines when OCR is missing
      return null;
    }
  }

  return null;
}

/**
 * Compute OCR text similarity between two detections
 * Returns null if OCR is not available for either
 */
function computeOcrSimilarity(
  idx1: number,
  idx2: number,
  ocrTexts: Map<number, string>
): number | null {
  const text1 = ocrTexts.get(idx1);
  const text2 = ocrTexts.get(idx2);

  if (!text1 || !text2) {
    return null;
  }

  return normalizedJaroWinkler(text1, text2);
}

/**
 * Union-Find data structure for clustering
 */
class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // Path compression
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const px = this.find(x);
    const py = this.find(y);
    if (px === py) return;

    // Union by rank
    if (this.rank[px] < this.rank[py]) {
      this.parent[px] = py;
    } else if (this.rank[px] > this.rank[py]) {
      this.parent[py] = px;
    } else {
      this.parent[py] = px;
      this.rank[px]++;
    }
  }

  /**
   * Get all clusters as arrays of indices
   */
  getClusters(): number[][] {
    const clusters = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      if (!clusters.has(root)) {
        clusters.set(root, []);
      }
      clusters.get(root)!.push(i);
    }
    return Array.from(clusters.values());
  }
}

/**
 * Generate unique candidate ID
 */
function generateCandidateId(sessionPrefix: string, index: number): BookCandidateId {
  return `${sessionPrefix}_book_${index}`;
}

/**
 * Create empty evidence structure (to be filled by spineEvidenceMerger)
 */
function createEmptyEvidence(): BookEvidence {
  return {
    topCrops: [],
    mergedLines: [],
    mergedTextBlock: '',
  };
}

// ============================================================================
// Main Grouping Function
// ============================================================================

export interface GroupingInput {
  /** All detections from the pipeline */
  detections: OBBDetection[];
  /** Rectification results (to map detection indices to crop indices) */
  rectificationResults: DetectionRectifyInfo[];
  /** Session ID prefix for generating candidate IDs */
  sessionId: string;
  /** OCR results by crop index (optional, for better merge decisions) */
  ocrResultsByCropIndex?: Record<number, OCRResult>;
}

export interface GroupingResult {
  /** Book candidates with stable ordering */
  candidates: BookCandidate[];
  /** Summary statistics */
  summary: BookCandidatesSummary;
  /** Debug info for artifacts */
  debugAssignments: GroupingAssignments;
}

/**
 * Group detections into book candidates (CONSERVATIVE)
 *
 * Algorithm:
 * 1. Start with each detection as its own candidate
 * 2. Only merge under strict conditions:
 *    - High IoU (>= 0.50) for duplicates
 *    - OR split-detection: angle diff <= 10°, center close, OCR similar
 * 3. Safety cap: if any candidate would have > 3 crops, fall back to no merges
 * 4. Sort candidates left-to-right by centroid x
 *
 * @param input GroupingInput with detections and rectification results
 * @returns GroupingResult with candidates and summary
 */
export function groupDetectionsIntoCandidates(input: GroupingInput): GroupingResult {
  const { detections, rectificationResults, sessionId, ocrResultsByCropIndex } = input;

  // Handle empty input
  if (detections.length === 0) {
    return {
      candidates: [],
      summary: {
        rawDetections: 0,
        rawCrops: 0,
        candidates: 0,
        avgCropsPerCandidate: 0,
      },
      debugAssignments: {
        candidates: [],
        merges: [],
        safetyFallbackTriggered: false,
        config: {
          iouMergeThreshold: IOU_MERGE_THRESHOLD,
          splitAngleThresholdDeg: (SPLIT_ANGLE_THRESHOLD_RAD * 180) / Math.PI,
          splitCenterDistRatio: SPLIT_CENTER_DIST_RATIO,
          splitOcrSimilarityThreshold: SPLIT_OCR_SIMILARITY_THRESHOLD,
          maxCropsPerCandidate: MAX_CROPS_PER_CANDIDATE,
        },
      },
    };
  }

  // Build detection index -> crop index mapping
  const detectionToCropIndex = new Map<number, number>();
  for (let i = 0; i < rectificationResults.length; i++) {
    const r = rectificationResults[i];
    if (r.cropUri && r.rectificationMethod !== 'skipped') {
      detectionToCropIndex.set(r.detectionIndex, i);
    }
  }

  const rawCrops = detectionToCropIndex.size;

  // Build OCR text map for similarity comparison
  const ocrTexts = new Map<number, string>();
  if (ocrResultsByCropIndex) {
    for (let i = 0; i < detections.length; i++) {
      const cropIdx = detectionToCropIndex.get(i);
      if (cropIdx !== undefined) {
        const ocr = ocrResultsByCropIndex[cropIdx];
        if (ocr && ocr.ok && ocr.fullText) {
          ocrTexts.set(i, ocr.fullText);
        }
      }
    }
  }

  // Track merge decisions for debug
  const merges: GroupingMergeRecord[] = [];

  // Step 1: Build clustering with Union-Find (conservative merging)
  const uf = new UnionFind(detections.length);

  for (let i = 0; i < detections.length; i++) {
    for (let j = i + 1; j < detections.length; j++) {
      const mergeRecord = shouldMerge(detections[i], detections[j], i, j, ocrTexts);
      if (mergeRecord) {
        uf.union(i, j);
        merges.push(mergeRecord);
      }
    }
  }

  // Step 2: Get clusters
  let clusters = uf.getClusters();

  // Step 3: Safety check - if any cluster is too large, fall back to no merges
  let safetyFallbackTriggered = false;
  const maxClusterSize = Math.max(...clusters.map(c => c.length));
  if (maxClusterSize > MAX_CROPS_PER_CANDIDATE) {
    console.warn(
      `[BookGrouper] Safety fallback: cluster of ${maxClusterSize} exceeds max ${MAX_CROPS_PER_CANDIDATE}. ` +
      `Reverting to 1 candidate per detection.`
    );
    safetyFallbackTriggered = true;
    // Fall back to each detection as its own cluster
    clusters = detections.map((_, i) => [i]);
  }

  // Step 4: Build candidates from clusters
  const candidatesUnsorted: Array<{
    candidate: BookCandidate;
    centroidX: number;
  }> = [];

  for (let clusterIdx = 0; clusterIdx < clusters.length; clusterIdx++) {
    const detectionIndices = clusters[clusterIdx];

    // Find representative detection (highest score, largest area tiebreak)
    let repIdx = detectionIndices[0];
    let maxScore = detections[repIdx].score;
    let maxArea = detections[repIdx].width * detections[repIdx].height;

    for (const idx of detectionIndices) {
      const d = detections[idx];
      const area = d.width * d.height;
      if (d.score > maxScore || (d.score === maxScore && area > maxArea)) {
        repIdx = idx;
        maxScore = d.score;
        maxArea = area;
      }
    }

    // Compute centroid of all detections in cluster
    let sumCx = 0;
    let sumAngle = 0;
    for (const idx of detectionIndices) {
      sumCx += detections[idx].cx;
      sumAngle += detections[idx].angle;
    }
    const centroidX = sumCx / detectionIndices.length;
    const avgAngle = sumAngle / detectionIndices.length;

    // Map detection indices to crop indices
    const cropIndices: number[] = [];
    for (const detIdx of detectionIndices) {
      if (detectionToCropIndex.has(detIdx)) {
        cropIndices.push(detectionToCropIndex.get(detIdx)!);
      }
    }
    // Remove duplicates and sort
    const uniqueCropIndices = [...new Set(cropIndices)].sort((a, b) => a - b);

    const candidate: BookCandidate = {
      id: generateCandidateId(sessionId, clusterIdx),
      detectionIndices: detectionIndices.sort((a, b) => a - b),
      cropIndices: uniqueCropIndices,
      representativeDetectionIndex: repIdx,
      orderingKey: 0, // Will be set after sorting
      angleRad: avgAngle,
      confidenceScore: maxScore,
      evidence: createEmptyEvidence(),
    };

    candidatesUnsorted.push({ candidate, centroidX });
  }

  // Step 5: Sort by centroid X (left-to-right)
  candidatesUnsorted.sort((a, b) => a.centroidX - b.centroidX);

  // Assign ordering keys and extract final candidates
  const candidates: BookCandidate[] = candidatesUnsorted.map((item, idx) => ({
    ...item.candidate,
    orderingKey: idx,
    id: generateCandidateId(sessionId, idx), // Re-assign ID based on final order
  }));

  // Compute summary
  const totalCropsInCandidates = candidates.reduce((sum, c) => sum + c.cropIndices.length, 0);
  const avgCropsPerCandidate = candidates.length > 0
    ? totalCropsInCandidates / candidates.length
    : 0;

  const summary: BookCandidatesSummary = {
    rawDetections: detections.length,
    rawCrops,
    candidates: candidates.length,
    avgCropsPerCandidate: Math.round(avgCropsPerCandidate * 100) / 100,
  };

  // Build debug assignments
  const debugAssignments: GroupingAssignments = {
    candidates: candidates.map(c => ({
      candidateId: c.id,
      cropIndices: c.cropIndices,
      detectionIndices: c.detectionIndices,
    })),
    merges: safetyFallbackTriggered ? [] : merges,
    safetyFallbackTriggered,
    config: {
      iouMergeThreshold: IOU_MERGE_THRESHOLD,
      splitAngleThresholdDeg: (SPLIT_ANGLE_THRESHOLD_RAD * 180) / Math.PI,
      splitCenterDistRatio: SPLIT_CENTER_DIST_RATIO,
      splitOcrSimilarityThreshold: SPLIT_OCR_SIMILARITY_THRESHOLD,
      maxCropsPerCandidate: MAX_CROPS_PER_CANDIDATE,
    },
  };

  console.log(`[BookGrouper] Grouped ${summary.rawDetections} detections into ${summary.candidates} candidates`);
  console.log(`[BookGrouper] ${summary.rawCrops} crops, avg ${summary.avgCropsPerCandidate} per candidate`);
  if (safetyFallbackTriggered) {
    console.log(`[BookGrouper] Safety fallback was triggered`);
  }
  if (merges.length > 0 && !safetyFallbackTriggered) {
    console.log(`[BookGrouper] ${merges.length} merge(s) applied`);
  }

  return { candidates, summary, debugAssignments };
}
