/**
 * TFLite Inference Service for YOLOv8 OBB
 *
 * STRICT MODE: No fallbacks. Model must exist.
 *
 * STOP-THE-LINE GATE: MODEL IO CONTRACT INSPECTION
 * Before running inference, we inspect and record model IO contract.
 */

import { Platform, NativeModules } from 'react-native';
import { loadTensorflowModel, TensorflowModel } from 'react-native-fast-tflite';
import RNFS from 'react-native-fs';

const WRITE_RAW_OUTPUT_ARTIFACTS = false;

// Native module for resolving iOS bundle paths
const { ModelPathResolver } = NativeModules;

/**
 * Type definitions for ModelPathResolver native module (iOS only)
 */
interface ModelPathResolverModule {
  getBundledModelPath(filename: string): Promise<string>;
  listBundleResources(): Promise<Array<{ name: string; isDirectory: boolean; size: number }>>;
  checkFileExists(path: string): Promise<{ exists: boolean; size?: number; path: string }>;
}
import type {
  ModelIOContract,
  TensorInfo,
  OBBDetection,
  OBBModelSpace,
  LetterboxParams,
  RawModelOutput,
} from '../types';
import { mapModelToOriginalOBB } from '../utils/letterbox';
import {
  isArtifactWritingEnabled,
  writeModelIO,
  writeRawModelOutput,
  type TensorStats,
  type RawSampleAnchors,
  type DecodeModeComparison,
  type PreprocessDebug,
} from './debugArtifacts';

// Model configuration
const MODEL_INPUT_SIZE = 640;

/**
 * Postprocess configuration presets
 * Verified against Python tools/decode_one.py
 */
export interface PostprocessConfig {
  /** Confidence threshold for initial filtering */
  thr: number;
  /** NMS IoU threshold */
  nmsIou: number;
  /** NMS mode: 'aabb' (fast) or 'obb' (accurate) */
  nmsMode: 'aabb' | 'obb';
  /** Minimum aspect ratio (w/h) for spine filtering */
  minAspect: number;
  /** Minimum detection area as fraction of image area (filter tiny noise) */
  minAreaRatio: number;
  /** Maximum detection area as fraction of image area */
  maxAreaRatio: number;
  /** Minimum score for final filtered output */
  minScore: number;
  /** Maximum detections to keep after NMS (0 = unlimited) */
  topK?: number;
  /** NMS method: 'hard' (standard greedy) or 'soft' (Gaussian decay) */
  nmsMethod?: 'hard' | 'soft';
  /** Sigma for Gaussian soft-NMS score decay (default 0.5) */
  softNmsSigma?: number;
  /** Score threshold for pruning after soft-NMS decay (default 0.001) */
  softNmsScoreThr?: number;
}

/**
 * Spine preset - optimized for book spine detection
 * Retrained model (491 imgs) with sweep-optimal params:
 * thr=0.45, nms_iou=0.35, min_aspect=2.5, hard NMS (F1=0.7881)
 */
export const SPINE_PRESET: PostprocessConfig = {
  thr: 0.45,           // Sweep-optimal for retrained model
  nmsIou: 0.35,        // Tighter NMS removes more duplicates
  nmsMode: 'obb',      // Use OBB NMS for rotated boxes
  minAspect: 2.5,      // Sweep-optimal for retrained model
  minAreaRatio: 0.002, // Filter tiny noise (0.2% of image)
  maxAreaRatio: 0.40,  // Max 40% of image area
  minScore: 0.45,      // Match thr for consistency
  topK: 100,           // Max 100 detections
};

/**
 * DIAGNOSTIC preset - for proving candidates exist
 * Very low threshold, NO NMS, NO geometric filters
 * Only use for debugging - not for actual detection output
 */
export const DIAG_PRESET: PostprocessConfig = {
  thr: 0.01,        // Very low threshold to see all candidates
  nmsIou: 1.0,      // Effectively disable NMS (nothing overlaps at IoU=1.0)
  nmsMode: 'aabb',
  minAspect: 0.0,   // No aspect ratio filter
  minAreaRatio: 0.0,
  maxAreaRatio: 1.0, // No area filter
  minScore: 0.0,    // No final score filter
};

/**
 * DEBUG_ALIGNMENT_PRESET - for validating coordinate mapping without filter noise
 * Use this after fixing tensor decode to ensure detections appear in correct locations
 * Disables ALL geometric filters so raw decoded boxes are visible
 */
export const DEBUG_ALIGNMENT_PRESET: PostprocessConfig = {
  thr: 0.50,          // Normal threshold for confidence
  nmsIou: 0.45,       // Keep NMS to remove duplicates
  nmsMode: 'obb',     // Use OBB NMS
  minAspect: 1.0,     // Disabled: allow any aspect ratio
  minAreaRatio: 0.0,
  maxAreaRatio: 1.0,  // Disabled: allow any area
  minScore: 0.50,     // minScore = thr (no additional filter)
  topK: 200,
};

// Current active config - use SPINE_PRESET for production
let activeConfig: PostprocessConfig = SPINE_PRESET;

// ============================================================================
// DECODE MODE DETECTION
// ============================================================================

/**
 * Decode layout modes - different channel interpretations
 */
export type DecodeMode = 'mode_a' | 'mode_b';

/**
 * Mode A: Standard YOLOv8 OBB [cx, cy, w, h, score, angle]
 * Mode B: Alternative with score at different channel
 */
export interface DecodeModeConfig {
  mode: DecodeMode;
  channelMapping: {
    cx: number;
    cy: number;
    w: number;
    h: number;
    score: number;
    angle: number;
  };
  description: string;
}

export const MODE_A: DecodeModeConfig = {
  mode: 'mode_a',
  channelMapping: { cx: 0, cy: 1, w: 2, h: 3, score: 4, angle: 5 },
  description: 'YOLOv8 OBB (matches Python decode_one.py): [cx, cy, w, h, score, angle]',
};

export const MODE_B: DecodeModeConfig = {
  mode: 'mode_b',
  channelMapping: { cx: 0, cy: 1, w: 2, h: 3, score: 5, angle: 4 },
  description: 'Alternative: [cx, cy, w, h, angleRad, rawScore(logit)]',
};

/** Currently active decode mode - MODE_A matches Python decode_one.py: [cx, cy, w, h, score, angle] */
let activeDecodeMode: DecodeModeConfig = MODE_A;

/** Whether to apply sigmoid to raw scores - DISABLED: model outputs probabilities, not logits */
let applySigmoid: boolean = false;

/**
 * Sigmoid function to convert logit to probability
 */
export function sigmoid(x: number): number {
  // Clamp to avoid overflow
  if (x > 20) return 1.0;
  if (x < -20) return 0.0;
  return 1 / (1 + Math.exp(-x));
}

/**
 * Check if sigmoid is enabled
 */
export function isSigmoidEnabled(): boolean {
  return applySigmoid;
}

/**
 * Get current decode mode
 */
export function getDecodeMode(): DecodeModeConfig {
  return activeDecodeMode;
}

/**
 * Set decode mode explicitly
 */
export function setDecodeMode(mode: DecodeModeConfig): void {
  activeDecodeMode = mode;
  console.log(`[InferenceService] Decode mode set to ${mode.mode}: ${mode.description}`);
}

/**
 * Count candidates above threshold for a given mode
 * Applies sigmoid to rawScore if applySigmoid is true
 */
export function countCandidatesForMode(
  rawOutput: number[],
  shape: number[],
  modeConfig: DecodeModeConfig,
  threshold: number,
  useSigmoid: boolean = true
): number {
  if (shape.length !== 3 || shape[1] !== 6) return 0;

  const numAnchors = shape[2];
  const scoreChannel = modeConfig.channelMapping.score;
  let count = 0;

  for (let i = 0; i < numAnchors; i++) {
    const rawScore = rawOutput[scoreChannel * numAnchors + i];
    const scoreProb = useSigmoid ? sigmoid(rawScore) : rawScore;
    if (scoreProb >= threshold) {
      count++;
    }
  }

  return count;
}

/**
 * Compute channel statistics for decode mode analysis
 * Returns min/max/mean for each of the 6 channels
 */
export function computeChannelRanges(
  rawOutput: number[],
  shape: number[]
): Array<{ channel: number; min: number; max: number; mean: number }> {
  if (shape.length !== 3 || shape[1] !== 6) return [];

  const numAnchors = shape[2];
  const channelStats: Array<{ channel: number; min: number; max: number; mean: number }> = [];

  for (let ch = 0; ch < 6; ch++) {
    let min = Infinity, max = -Infinity, sum = 0;
    for (let i = 0; i < numAnchors; i++) {
      const val = rawOutput[ch * numAnchors + i];
      if (val < min) min = val;
      if (val > max) max = val;
      sum += val;
    }
    channelStats.push({
      channel: ch,
      min,
      max,
      mean: sum / numAnchors,
    });
  }

  return channelStats;
}

/**
 * Per-channel statistics with percentiles (BEFORE any activation like sigmoid)
 */
export interface ChannelStatsExtended {
  channel: number;
  channelName: string;
  min: number;
  max: number;
  mean: number;
  std: number;
  p50: number;  // median
  p90: number;
  p99: number;
  nanCount: number;
  infCount: number;
}

/**
 * Saturation analysis for score channel
 */
export interface SaturationWarning {
  saturated: boolean;
  reason: string;
  scoreP50: number;
  pctAbove05: number;
  pctAbove09: number;
}

/**
 * Comprehensive per-channel stats result
 */
export interface ComprehensiveChannelStats {
  shape: number[];
  numAnchors: number;
  channels: ChannelStatsExtended[];
  saturationWarning: SaturationWarning | null;
  modeUsed: string;
  scoreChannel: number;
  angleChannel: number;
}

/**
 * Transpose [1, 6, 8400] to [8400, 6] view for easier anchor-wise access
 * Returns a new array with layout: y[i * 6 + c] = raw[c * 8400 + i]
 */
export function transposeToAnchorsFirst(
  rawOutput: number[] | Float32Array,
  shape: number[]
): { transposed: Float32Array; transposedShape: [number, number] } | null {
  if (shape.length !== 3 || shape[1] !== 6) {
    console.error(`[InferenceService] transposeToAnchorsFirst: invalid shape [${shape.join(', ')}]`);
    return null;
  }

  const numChannels = shape[1];  // 6
  const numAnchors = shape[2];   // 8400

  const transposed = new Float32Array(numAnchors * numChannels);

  // Transpose: raw[c * N + i] → y[i * 6 + c]
  for (let i = 0; i < numAnchors; i++) {
    for (let c = 0; c < numChannels; c++) {
      transposed[i * numChannels + c] = rawOutput[c * numAnchors + i];
    }
  }

  return {
    transposed,
    transposedShape: [numAnchors, numChannels],
  };
}

/**
 * Analyze decode mode - OBSERVATION ONLY, does NOT change active mode
 * Mode A is correct per Python decode_one.py:
 *   ch0-3: geometry (cx, cy, w, h)
 *   ch4: score (probability, no sigmoid needed)
 *   ch5: angle in radians
 *
 * This function computes comparison data for diagnostics but does NOT override mode.
 */
export function analyzeDecodeMode(
  rawOutput: number[],
  shape: number[]
): { comparison: DecodeModeComparisonResult; channelRanges: ReturnType<typeof computeChannelRanges> } {
  const thresholds = [0.01, 0.05, 0.50];

  // Compute channel ranges for diagnostics
  const channelRanges = computeChannelRanges(rawOutput, shape);

  // Log channel ranges - Mode A: ch4=score, ch5=angle
  console.log('========================================');
  console.log('[InferenceService] CHANNEL ANALYSIS:');
  console.log(`[InferenceService]   Active mode: ${activeDecodeMode.mode}`);
  console.log(`[InferenceService]   Score channel: ch${activeDecodeMode.channelMapping.score}`);
  console.log(`[InferenceService]   Angle channel: ch${activeDecodeMode.channelMapping.angle}`);
  console.log(`[InferenceService]   Sigmoid applied: ${applySigmoid}`);
  console.log(`[InferenceService]   ch4 range: [${channelRanges[4]?.min.toFixed(4)}, ${channelRanges[4]?.max.toFixed(4)}]`);
  console.log(`[InferenceService]   ch5 range: [${channelRanges[5]?.min.toFixed(4)}, ${channelRanges[5]?.max.toFixed(4)}]`);
  console.log('========================================');

  // Count candidates using CORRECT sigmoid setting for each mode:
  // - Mode A: ch4=score (probability), no sigmoid needed
  // - Mode B: ch5=score (logit), needs sigmoid
  const modeAcounts = thresholds.map(t => countCandidatesForMode(rawOutput, shape, MODE_A, t, false)); // Mode A: no sigmoid
  const modeBcounts = thresholds.map(t => countCandidatesForMode(rawOutput, shape, MODE_B, t, true));  // Mode B: with sigmoid

  const modeAScore = modeAcounts.reduce((a, b) => a + b, 0);
  const modeBScore = modeBcounts.reduce((a, b) => a + b, 0);

  // NOTE: We do NOT call setDecodeMode here - Mode A is correct per Python decode_one.py
  const comparison: DecodeModeComparisonResult = {
    modeA: {
      mode: 'mode_a',
      counts: Object.fromEntries(thresholds.map((t, i) => [t.toString(), modeAcounts[i]])),
      totalScore: modeAScore,
    },
    modeB: {
      mode: 'mode_b',
      counts: Object.fromEntries(thresholds.map((t, i) => [t.toString(), modeBcounts[i]])),
      totalScore: modeBScore,
    },
    chosenMode: 'mode_a', // Mode A per Python decode_one.py
    reason: 'Mode A matches Python decode_one.py: ch4=score (probability), ch5=angle (radians)',
  };

  console.log(`[InferenceService] Mode comparison (diagnostics):`);
  console.log(`[InferenceService]   Mode A (ch4=score, no sigmoid): counts at thr ${thresholds.join('/')}: ${modeAcounts.join('/')}`);
  console.log(`[InferenceService]   Mode B (ch5=score, sigmoid): counts at thr ${thresholds.join('/')}: ${modeBcounts.join('/')}`);
  console.log(`[InferenceService]   Active: ${activeDecodeMode.mode}, sigmoid=${applySigmoid}`);

  return { comparison, channelRanges };
}

/**
 * @deprecated Use analyzeDecodeMode instead
 * Kept for backward compatibility but now just calls analyzeDecodeMode
 */
export function autoDetectDecodeMode(
  rawOutput: number[],
  shape: number[]
): { chosenMode: DecodeModeConfig; comparison: DecodeModeComparisonResult } {
  console.warn('[InferenceService] autoDetectDecodeMode is deprecated - use MODE_A (matches Python)');
  const { comparison } = analyzeDecodeMode(rawOutput, shape);
  // Return Mode A as the "chosen" mode - matches Python decode_one.py
  return { chosenMode: MODE_A, comparison };
}

/**
 * Decode mode comparison result for artifacts
 */
export interface DecodeModeComparisonResult {
  modeA: { mode: string; counts: Record<string, number>; totalScore: number };
  modeB: { mode: string; counts: Record<string, number>; totalScore: number };
  chosenMode: string;
  reason: string;
}

/**
 * Geometric filter rejection statistics
 */
export interface GeomFilterStats {
  /** Number of candidates entering the filter */
  inputCount: number;
  /** Number of candidates passing all filters */
  outputCount: number;
  /** Rejection counts by reason */
  rejected: {
    byAspect: number;
    byArea: number;
    byBounds: number;
    byAngle: number;
    byScore: number;
    byNaN: number;
  };
  /** Sample rejected candidates (up to 10) */
  sampleRejected: Array<{
    detection: OBBModelSpace;
    reason: string;
    computedAspect: number;
    computedAreaRatio: number;
    angleDeg: number;
  }>;
  /** Thresholds used */
  thresholds: {
    minAspect: number;
    minAreaRatio: number;
    maxAreaRatio: number;
    minScore: number;
    imageArea: number;
  };
}

/**
 * Postprocess statistics for debugging
 */
export interface PostprocessStats {
  numRaw: number;
  numAfterThr: number;
  numAfterNms: number;
  numAfterGeom: number;
  config: PostprocessConfig;
  geomStats?: GeomFilterStats;
  timings?: {
    preprocess?: number;
    inference?: number;
    decode: number;
    nms: number;
    geomFilters: number;
    postprocessTotal?: number;
    total: number;
  };
}

/**
 * Full inference context for logging and debug manifest
 * Captures all coordinate mapping parameters
 */
export interface InferenceContext {
  /** Frame dimensions (photo/image pixels) */
  frameWidth: number;
  frameHeight: number;
  /** View dimensions (preview canvas, if different) */
  viewWidth?: number;
  viewHeight?: number;
  /** Rotation applied to frame (degrees) */
  rotationDegrees: number;
  /** Whether image is mirrored (front camera) */
  mirrored: boolean;
  /** Resize mode used for letterboxing */
  resizeMode: 'letterbox' | 'stretch';
  /** Scale factors from letterbox */
  scaleX: number;
  scaleY: number;
  /** Offset from letterbox padding */
  offsetX: number;
  offsetY: number;
}

/**
 * Get the current postprocess configuration
 */
export function getPostprocessConfig(): PostprocessConfig {
  return { ...activeConfig };
}

/**
 * Canonicalize OBB: ensure w >= h and angle in [-pi/2, pi/2]
 * Matches Python: tools/decode_one.py canonicalize_obb()
 */
export function canonicalizeOBB(
  w: number,
  h: number,
  angle: number
): { w: number; h: number; angle: number } {
  // Swap if w < h
  if (w < h) {
    const temp = w;
    w = h;
    h = temp;
    angle = angle + Math.PI / 2;
  }

  // Normalize angle to [-pi/2, pi/2]
  while (angle > Math.PI / 2) {
    angle -= Math.PI;
  }
  while (angle < -Math.PI / 2) {
    angle += Math.PI;
  }

  return { w, h, angle };
}

/**
 * Apply geometric filters for spine detection with instrumentation
 * Matches Python: tools/decode_one.py geometric filters
 *
 * INSTRUMENTED: Returns both filtered detections and rejection statistics
 *
 * DIRECTIONAL SPINE FILTERING:
 * - For book spines, we expect VERTICAL boxes (height > width)
 * - After canonicalization, width >= height, so we check the ORIGINAL h/w ratio
 * - Since OBB already went through canonicalizeOBB, we use angle to determine orientation
 * - Vertical spine: angle near ±π/2, so the original box had h > w before swap
 *
 * Area ratio: detection area in model space / model area (640x640)
 */
export function applyGeometricFiltersInstrumented(
  detections: OBBModelSpace[],
  imageWidth: number,
  imageHeight: number,
  config: PostprocessConfig = activeConfig
): { filtered: OBBModelSpace[]; stats: GeomFilterStats } {
  // Use model space area for consistent comparison
  const MODEL_SIZE = 640;
  const modelArea = MODEL_SIZE * MODEL_SIZE;

  const filtered: OBBModelSpace[] = [];
  const stats: GeomFilterStats = {
    inputCount: detections.length,
    outputCount: 0,
    rejected: {
      byAspect: 0,
      byArea: 0,
      byBounds: 0,
      byAngle: 0,
      byScore: 0,
      byNaN: 0,
    },
    sampleRejected: [],
    thresholds: {
      minAspect: config.minAspect,
      minAreaRatio: config.minAreaRatio ?? 0,
      maxAreaRatio: config.maxAreaRatio,
      minScore: config.minScore,
      imageArea: modelArea,
    },
  };

  const MAX_SAMPLES = 10;

  for (const det of detections) {
    // Check for NaN values first
    if (isNaN(det.cx) || isNaN(det.cy) || isNaN(det.width) || isNaN(det.height) ||
        isNaN(det.angle) || isNaN(det.score)) {
      stats.rejected.byNaN++;
      if (stats.sampleRejected.length < MAX_SAMPLES) {
        stats.sampleRejected.push({
          detection: det,
          reason: 'NaN',
          computedAspect: NaN,
          computedAreaRatio: NaN,
          angleDeg: NaN,
        });
      }
      continue;
    }

    const angleDeg = det.angle * (180 / Math.PI);

    // DIRECTIONAL SPINE FILTERING:
    // After canonicalization, width >= height. For a vertical spine:
    // - Original box had height > width
    // - Canonicalization swapped them and added π/2 to angle
    // - So vertical spines have angle near ±π/2 (±90°)
    //
    // We compute aspect ratio as width/height (post-canonicalization)
    // This represents the elongation regardless of orientation.
    const aspectRatio = det.height > 0 ? det.width / det.height : 0;

    if (aspectRatio < config.minAspect) {
      stats.rejected.byAspect++;
      if (stats.sampleRejected.length < MAX_SAMPLES) {
        stats.sampleRejected.push({
          detection: det,
          reason: `aspect ${aspectRatio.toFixed(2)} < ${config.minAspect}`,
          computedAspect: aspectRatio,
          computedAreaRatio: (det.width * det.height) / modelArea,
          angleDeg,
        });
      }
      continue;
    }

    // Area ratio filter (in model space)
    const detArea = det.width * det.height;
    const areaRatio = detArea / modelArea;

    // Min area filter (reject tiny noise)
    const minArea = config.minAreaRatio ?? 0;
    if (areaRatio < minArea) {
      stats.rejected.byArea++;
      if (stats.sampleRejected.length < MAX_SAMPLES) {
        stats.sampleRejected.push({
          detection: det,
          reason: `area ${(areaRatio * 100).toFixed(3)}% < ${(minArea * 100).toFixed(2)}% (too small)`,
          computedAspect: aspectRatio,
          computedAreaRatio: areaRatio,
          angleDeg,
        });
      }
      continue;
    }

    // Max area filter (reject oversized)
    if (areaRatio > config.maxAreaRatio) {
      stats.rejected.byArea++;
      if (stats.sampleRejected.length < MAX_SAMPLES) {
        stats.sampleRejected.push({
          detection: det,
          reason: `area ${(areaRatio * 100).toFixed(2)}% > ${(config.maxAreaRatio * 100).toFixed(1)}% (too large)`,
          computedAspect: aspectRatio,
          computedAreaRatio: areaRatio,
          angleDeg,
        });
      }
      continue;
    }

    // Bounds check: ensure detection center is within model space (with tolerance)
    // We check the center, not corners, to allow boxes that extend slightly outside
    const outOfBounds = det.cx < -50 || det.cx > MODEL_SIZE + 50 ||
                        det.cy < -50 || det.cy > MODEL_SIZE + 50;
    if (outOfBounds) {
      stats.rejected.byBounds++;
      if (stats.sampleRejected.length < MAX_SAMPLES) {
        stats.sampleRejected.push({
          detection: det,
          reason: `center out of bounds cx=${det.cx.toFixed(0)} cy=${det.cy.toFixed(0)}`,
          computedAspect: aspectRatio,
          computedAreaRatio: areaRatio,
          angleDeg,
        });
      }
      continue;
    }

    // Minimum score filter
    if (det.score < config.minScore) {
      stats.rejected.byScore++;
      if (stats.sampleRejected.length < MAX_SAMPLES) {
        stats.sampleRejected.push({
          detection: det,
          reason: `score ${det.score.toFixed(3)} < ${config.minScore}`,
          computedAspect: aspectRatio,
          computedAreaRatio: areaRatio,
          angleDeg,
        });
      }
      continue;
    }

    filtered.push(det);
  }

  stats.outputCount = filtered.length;

  // Log rejection histogram
  console.log('========================================');
  console.log('[GeomFilter] REJECTION HISTOGRAM:');
  console.log(`  Input: ${stats.inputCount}, Output: ${stats.outputCount}`);
  console.log(`  byAspect: ${stats.rejected.byAspect} (minAspect=${config.minAspect})`);
  console.log(`  byArea: ${stats.rejected.byArea} (minAreaRatio=${config.minAreaRatio ?? 0}, maxAreaRatio=${config.maxAreaRatio})`);
  console.log(`  byBounds: ${stats.rejected.byBounds}`);
  console.log(`  byScore: ${stats.rejected.byScore} (minScore=${config.minScore})`);
  console.log(`  byNaN: ${stats.rejected.byNaN}`);
  if (stats.sampleRejected.length > 0) {
    console.log(`  Sample rejected (first ${stats.sampleRejected.length}):`);
    stats.sampleRejected.slice(0, 5).forEach((s, i) => {
      console.log(`    [${i}] ${s.reason} | aspect=${s.computedAspect.toFixed(2)} area=${(s.computedAreaRatio * 100).toFixed(2)}% angle=${s.angleDeg.toFixed(1)}°`);
    });
  }
  console.log('========================================');

  return { filtered, stats };
}

// DEBUG FLAG: Set to true ONLY for development without model
// MUST be false in production
const DEBUG_ALLOW_MISSING_MODEL = false;

let model: TensorflowModel | null = null;
let modelIOContract: ModelIOContract | null = null;
let isModelInspected = false;
let isUsingMockModel = false;
let modelWarmupComplete = false;

// ============================================================================
// INVOKE COUNTER - Track model.runSync calls per capture
// ============================================================================

/** Invoke counter for current capture session */
let invokeCount = 0;

// ============================================================================
// DETAILED TIMING BREAKDOWN
// ============================================================================

/** Model filename constant */
const MODEL_FILENAME = 'yolov8_obb.tflite';

/** In-flight loadModel() promise, shared by concurrent callers */
let loadModelPromise: Promise<void> | null = null;

/** Resolved absolute model path (set during loading) */
let resolvedModelPath: string | null = null;

/**
 * Get model path based on platform
 */
function getModelPath(): string {
  return resolvedModelPath || MODEL_FILENAME;
}

/**
 * Resolve the absolute path to the bundled model file.
 * iOS: Uses native module to resolve Bundle.main path
 * Android: Uses assets path (react-native-fast-tflite handles this)
 */
async function resolveModelPath(): Promise<{ path: string; isAssetUri: boolean }> {
  console.log('========================================');
  console.log('[InferenceService] Resolving model path...');
  console.log(`[InferenceService] Platform: ${Platform.OS}`);
  console.log(`[InferenceService] Model filename: ${MODEL_FILENAME}`);

  if (Platform.OS === 'ios') {
    // iOS: Must use native module to get absolute bundle path
    if (!ModelPathResolver) {
      throw new Error(
        'GATE 4 FAILED: ModelPathResolver native module not found.\n' +
        'Ensure ios/BookScanner/ModelPathResolver.m is included in the Xcode project.'
      );
    }

    const resolver = ModelPathResolver as ModelPathResolverModule;

    try {
      // Get absolute path from bundle
      const absolutePath = await resolver.getBundledModelPath(MODEL_FILENAME);
      console.log(`[InferenceService] Resolved model path: ${absolutePath}`);

      // Verify file exists and get size
      const fileInfo = await resolver.checkFileExists(absolutePath);
      console.log(`[InferenceService] Model file exists: ${fileInfo.exists}`);

      if (!fileInfo.exists) {
        // List bundle contents for debugging
        console.log('[InferenceService] Listing bundle resources for debugging...');
        try {
          await resolver.listBundleResources();
        } catch {
          // Ignore listing errors
        }

        throw new Error(
          `Model file not found at resolved path: ${absolutePath}\n` +
          'Ensure yolov8_obb.tflite is added to Xcode "Copy Bundle Resources".'
        );
      }

      const sizeBytes = fileInfo.size || 0;
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
      console.log(`[InferenceService] Model file size: ${sizeBytes} bytes (${sizeMB} MB)`);

      resolvedModelPath = absolutePath;
      return { path: absolutePath, isAssetUri: false };

    } catch (error: any) {
      console.error('[InferenceService] iOS path resolution failed:', error.message);

      // List bundle contents for debugging
      console.log('[InferenceService] Listing bundle resources for debugging...');
      try {
        const resources = await resolver.listBundleResources();
        console.log('[InferenceService] Bundle has', resources.length, 'items');

        // Look for .tflite files
        const tfliteFiles = resources.filter(r => r.name.endsWith('.tflite'));
        if (tfliteFiles.length > 0) {
          console.log('[InferenceService] Found .tflite files:', tfliteFiles);
        } else {
          console.log('[InferenceService] No .tflite files found in bundle root');
        }
      } catch {
        // Ignore listing errors
      }

      throw new Error(
        `GATE 4 FAILED: iOS model path resolution failed.\n` +
        `Platform: ${Platform.OS}\n` +
        `Filename: ${MODEL_FILENAME}\n` +
        `Error: ${error.message}\n\n` +
        'To fix:\n' +
        '1. Copy src/models/yolov8_obb.tflite to ios/BookScanner/\n' +
        '2. In Xcode, add yolov8_obb.tflite to the project\n' +
        '3. In Build Phases > Copy Bundle Resources, ensure it is listed\n' +
        '4. Clean and rebuild: rm -rf ios/build && npx react-native run-ios'
      );
    }

  } else {
    // Android: Use assets path (react-native-fast-tflite handles asset:// internally)
    const assetPath = `asset://models/${MODEL_FILENAME}`;
    console.log(`[InferenceService] Using Android asset path: ${assetPath}`);

    // Verify the asset exists using RNFS
    try {
      const assetsDir = `${RNFS.MainBundlePath}`;
      console.log(`[InferenceService] Android assets dir: ${assetsDir}`);
      // Note: On Android, we can't easily verify asset existence before loading
      // The loadTensorflowModel will fail if the file doesn't exist
    } catch {
      // Ignore - Android asset verification is best-effort
    }

    resolvedModelPath = assetPath;
    return { path: assetPath, isAssetUri: true };
  }
}

/**
 * Inspect model tensors and create IO contract
 * GATE 3: This MUST succeed before any inference
 */
export async function inspectModel(sessionId?: string): Promise<ModelIOContract> {
  console.log('[InferenceService] Starting model inspection...');

  if (!model) {
    throw new Error('Model not loaded. Call loadModel() first.');
  }

  if (isUsingMockModel) {
    throw new Error('GATE 3 FAILED: Cannot inspect mock model. Load real TFLite model.');
  }

  // Get input tensor info
  const inputTensors: TensorInfo[] = model.inputs.map((input, index) => ({
    name: input.name || `input_${index}`,
    shape: Array.from(input.shape),
    dtype: input.dataType,
    quantization: undefined,
  }));

  // Get output tensor info
  const outputTensors: TensorInfo[] = model.outputs.map((output, index) => ({
    name: output.name || `output_${index}`,
    shape: Array.from(output.shape),
    dtype: output.dataType,
    quantization: undefined,
  }));

  const contract: ModelIOContract = {
    inputTensors,
    outputTensors,
    inspectedAt: new Date().toISOString(),
    modelPath: getModelPath(),
  };

  // Log inspection results
  console.log('[InferenceService] Model IO Contract:');
  console.log('  Inputs:', JSON.stringify(inputTensors, null, 2));
  console.log('  Outputs:', JSON.stringify(outputTensors, null, 2));

  // Write to session if provided
  if (sessionId) {
    await writeModelIO(sessionId, contract);
  }

  modelIOContract = contract;
  isModelInspected = true;

  // Validate output shape for OBB detection
  if (outputTensors.length === 0) {
    throw new Error('GATE 3 FAILED: Model has no output tensors');
  }

  const mainOutput = outputTensors[0];
  console.log(`[InferenceService] Main output shape: [${mainOutput.shape.join(', ')}]`);

  return contract;
}

/**
 * Load the TFLite model
 * STRICT: Fails if model file is missing (unless DEBUG flag is set)
 *
 * iOS: Loads from absolute bundle path resolved by native module
 * Android: Loads from assets using asset:// URI
 */
export async function loadModel(): Promise<void> {
  if (model) {
    console.log('[InferenceService] Model already loaded');
    return;
  }

  // Concurrent scans (up to 3 background scans are allowed) can all reach this
  // before the first load resolves. Without this guard each would allocate its own
  // ~11 MB interpreter. Share the in-flight promise instead.
  if (loadModelPromise) {
    console.log('[InferenceService] Model load already in flight, awaiting it');
    return loadModelPromise;
  }

  loadModelPromise = doLoadModel().finally(() => {
    loadModelPromise = null;
  });
  return loadModelPromise;
}

async function doLoadModel(): Promise<void> {
  console.log('[InferenceService] Loading model...');

  try {
    // Step 1: Resolve the model path
    const { path, isAssetUri } = await resolveModelPath();

    // Step 2: Load the model
    console.log(`[InferenceService] Loading from: ${path}`);
    console.log(`[InferenceService] Is asset URI: ${isAssetUri}`);

    if (isAssetUri) {
      // Android: Use asset:// URI
      model = await loadTensorflowModel({ url: path } as any);
    } else {
      // iOS: Use absolute file path with file:// scheme
      // react-native-fast-tflite accepts file:// URLs
      const fileUrl = path.startsWith('file://') ? path : `file://${path}`;
      console.log(`[InferenceService] Loading with file URL: ${fileUrl}`);
      model = await loadTensorflowModel({ url: fileUrl } as any);
    }

    isUsingMockModel = false;
    console.log('[InferenceService] Model loaded successfully!');
    console.log(`[InferenceService] Interpreter created: true`);
    console.log('========================================');

  } catch (error: any) {
    console.error('[InferenceService] FAILED to load model:', error.message);
    console.log('========================================');

    if (DEBUG_ALLOW_MISSING_MODEL) {
      console.warn('========================================');
      console.warn('DEBUG MODE: Using mock model');
      console.warn('This is ONLY for UI development.');
      console.warn('Set DEBUG_ALLOW_MISSING_MODEL=false for production.');
      console.warn('========================================');

      model = createMockModel();
      isUsingMockModel = true;
    } else {
      throw new Error(
        `MODEL LOADING FAILED.\n` +
        `Platform: ${Platform.OS}\n` +
        `Resolved path: ${resolvedModelPath || 'not resolved'}\n` +
        `Error: ${error.message}\n\n` +
        'iOS Fix:\n' +
        '1. Add yolov8_obb.tflite to Xcode project\n' +
        '2. Ensure "Copy Bundle Resources" includes it\n' +
        '3. Clean build: rm -rf ios/build\n\n' +
        'Android Fix:\n' +
        '1. Place in android/app/src/main/assets/models/\n' +
        '2. Clean build: cd android && ./gradlew clean'
      );
    }
  }
}

/**
 * Create a mock model for DEBUG mode only
 */
function createMockModel(): TensorflowModel {
  return {
    inputs: [{ name: 'input', shape: [1, 640, 640, 3], dataType: 'float32' }],
    outputs: [{ name: 'output', shape: [1, 6, 8400], dataType: 'float32' }],
    runSync: () => {
      // Return empty output in debug mode
      console.warn('[InferenceService] Mock model inference - no real detections');
      return [new Float32Array(6 * 8400)];
    },
  } as any;
}

/**
 * Check if model is loaded and inspected
 */
export function isModelReady(): boolean {
  return model !== null && isModelInspected && !isUsingMockModel;
}

/**
 * Warm up the model by running a dummy inference
 * Call this at app startup to avoid first-scan latency
 *
 * This performs:
 * 1. Model loading (if not already loaded)
 * 2. Model inspection (validates IO contract)
 * 3. Dummy inference run (warms up TFLite interpreter)
 *
 * @returns Warmup result with success status and duration
 */
export async function warmupModel(): Promise<{ success: boolean; durationMs: number }> {
  const startTime = Date.now();

  if (modelWarmupComplete) {
    console.log('[InferenceService] Model already warmed up');
    return { success: true, durationMs: 0 };
  }

  console.log('[InferenceService] Starting model warmup...');

  try {
    // Step 1: Ensure model is loaded
    if (!model) {
      console.log('[InferenceService] Warmup: Loading model...');
      await loadModel();
    }

    // Step 2: Ensure model is inspected
    if (!isModelInspected) {
      console.log('[InferenceService] Warmup: Inspecting model...');
      await inspectModel();
    }

    // Step 3: Run dummy inference to warm up interpreter
    // This primes the TFLite delegate and GPU (if used)
    console.log('[InferenceService] Warmup: Running dummy inference...');
    const dummyTensor = new Float32Array(640 * 640 * 3);
    // Fill with neutral gray (114/255) to mimic letterbox padding
    dummyTensor.fill(0.447);

    const outputs = model!.runSync([dummyTensor]);

    // Verify we got output
    if (!outputs || outputs.length === 0) {
      throw new Error('Warmup inference produced no output');
    }

    modelWarmupComplete = true;
    const durationMs = Date.now() - startTime;

    console.log(`[InferenceService] Model warmup complete in ${durationMs.toFixed(1)}ms`);
    console.log('[InferenceService] First real inference will be fast');

    return { success: true, durationMs };

  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    console.error('[InferenceService] Model warmup failed:', error.message);
    return { success: false, durationMs };
  }
}

/**
 * Check if using mock model (DEBUG mode)
 */
export function isMockModel(): boolean {
  return isUsingMockModel;
}

/**
 * Get the current model IO contract
 */
export function getModelIOContract(): ModelIOContract | null {
  return modelIOContract;
}

/**
 * Get 4 corners of an OBB as array of {x, y} points
 */
function getOBBCorners(obb: OBBModelSpace): Array<{ x: number; y: number }> {
  const { cx, cy, width, height, angle } = obb;
  const hw = width / 2;
  const hh = height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return [
    { x: cx + (-hw) * cos - (-hh) * sin, y: cy + (-hw) * sin + (-hh) * cos },
    { x: cx + (hw) * cos - (-hh) * sin, y: cy + (hw) * sin + (-hh) * cos },
    { x: cx + (hw) * cos - (hh) * sin, y: cy + (hw) * sin + (hh) * cos },
    { x: cx + (-hw) * cos - (hh) * sin, y: cy + (-hw) * sin + (hh) * cos },
  ];
}

/**
 * Compute polygon area using shoelace formula
 */
function polygonArea(vertices: Array<{ x: number; y: number }>): number {
  if (vertices.length < 3) return 0;
  let area = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += vertices[i].x * vertices[j].y;
    area -= vertices[j].x * vertices[i].y;
  }
  return Math.abs(area) / 2;
}

/**
 * Sutherland-Hodgman polygon clipping
 * Clips subject polygon against clip polygon
 */
function clipPolygon(
  subject: Array<{ x: number; y: number }>,
  clip: Array<{ x: number; y: number }>
): Array<{ x: number; y: number }> {
  if (subject.length === 0 || clip.length === 0) return [];

  let output = [...subject];

  for (let i = 0; i < clip.length; i++) {
    if (output.length === 0) return [];

    const input = output;
    output = [];

    const edgeStart = clip[i];
    const edgeEnd = clip[(i + 1) % clip.length];

    for (let j = 0; j < input.length; j++) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];

      const currentInside = isLeft(edgeStart, edgeEnd, current);
      const previousInside = isLeft(edgeStart, edgeEnd, previous);

      if (currentInside) {
        if (!previousInside) {
          const inter = lineIntersection(edgeStart, edgeEnd, previous, current);
          if (inter) output.push(inter);
        }
        output.push(current);
      } else if (previousInside) {
        const inter = lineIntersection(edgeStart, edgeEnd, previous, current);
        if (inter) output.push(inter);
      }
    }
  }

  return output;
}

/**
 * Check if point is on left side of edge (using cross product)
 */
function isLeft(
  a: { x: number; y: number },
  b: { x: number; y: number },
  p: { x: number; y: number }
): boolean {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
}

/**
 * Compute intersection of two line segments
 */
function lineIntersection(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number }
): { x: number; y: number } | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;

  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return null;

  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / cross;

  return {
    x: p1.x + t * d1x,
    y: p1.y + t * d1y,
  };
}

/**
 * Compute OBB IoU using polygon intersection (Sutherland-Hodgman)
 * Accurate for rotated boxes
 */
function computeOBBIoU(a: OBBModelSpace, b: OBBModelSpace): number {
  const cornersA = getOBBCorners(a);
  const cornersB = getOBBCorners(b);

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;

  // Clip polygon A against polygon B to get intersection
  const intersection = clipPolygon(cornersA, cornersB);
  const interArea = polygonArea(intersection);

  const unionArea = areaA + areaB - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Compute AABB IoU between two OBBs
 * Computes AABB from rotated corners (not ignoring angle)
 */
function computeAABBIoU(a: OBBModelSpace, b: OBBModelSpace): number {
  // Get actual corners considering rotation
  const cornersA = getOBBCorners(a);
  const cornersB = getOBBCorners(b);

  // Compute AABB from corners
  const aMinX = Math.min(...cornersA.map(c => c.x));
  const aMaxX = Math.max(...cornersA.map(c => c.x));
  const aMinY = Math.min(...cornersA.map(c => c.y));
  const aMaxY = Math.max(...cornersA.map(c => c.y));

  const bMinX = Math.min(...cornersB.map(c => c.x));
  const bMaxX = Math.max(...cornersB.map(c => c.x));
  const bMinY = Math.min(...cornersB.map(c => c.y));
  const bMaxY = Math.max(...cornersB.map(c => c.y));

  const interMinX = Math.max(aMinX, bMinX);
  const interMaxX = Math.min(aMaxX, bMaxX);
  const interMinY = Math.max(aMinY, bMinY);
  const interMaxY = Math.min(aMaxY, bMaxY);

  if (interMaxX <= interMinX || interMaxY <= interMinY) {
    return 0;
  }

  const interArea = (interMaxX - interMinX) * (interMaxY - interMinY);
  const aArea = (aMaxX - aMinX) * (aMaxY - aMinY);
  const bArea = (bMaxX - bMinX) * (bMaxY - bMinY);
  const unionArea = aArea + bArea - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Apply Non-Maximum Suppression
 * Uses OBB or AABB IoU based on config.nmsMode
 * Dispatches to soft-NMS if config.nmsMethod === 'soft'
 */
export function applyNMS(
  detections: OBBModelSpace[],
  config: PostprocessConfig = activeConfig
): OBBModelSpace[] {
  if (detections.length === 0) return [];

  if (config.nmsMethod === 'soft') {
    return applySoftNMS(detections, config);
  }

  // Hard NMS (default)
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: OBBModelSpace[] = [];

  // Choose IoU function based on mode
  const computeIoU = config.nmsMode === 'obb' ? computeOBBIoU : computeAABBIoU;

  for (const det of sorted) {
    let shouldKeep = true;

    for (const keptDet of kept) {
      const iou = computeIoU(det, keptDet);
      if (iou > config.nmsIou) {
        shouldKeep = false;
        break;
      }
    }

    if (shouldKeep) {
      kept.push(det);
    }
  }

  console.log(`[InferenceService] NMS (hard/${config.nmsMode}, iou=${config.nmsIou}): ${detections.length} -> ${kept.length}`);
  return kept;
}

/**
 * Gaussian Soft-NMS: instead of suppressing overlapping detections entirely,
 * decay their scores by exp(-IoU²/σ). Prune below softNmsScoreThr.
 * Better for densely packed book spines where adjacent OBBs partially overlap.
 */
function applySoftNMS(
  detections: OBBModelSpace[],
  config: PostprocessConfig
): OBBModelSpace[] {
  const sigma = config.softNmsSigma ?? 0.5;
  const scoreThr = config.softNmsScoreThr ?? 0.001;
  const computeIoU = config.nmsMode === 'obb' ? computeOBBIoU : computeAABBIoU;

  // Work on copies so we can mutate scores
  const dets = detections.map(d => ({ ...d }));

  const kept: OBBModelSpace[] = [];

  for (let iter = 0; iter < dets.length; iter++) {
    // Find detection with highest current score
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < dets.length; i++) {
      if (dets[i].score > bestScore) {
        bestScore = dets[i].score;
        bestIdx = i;
      }
    }

    if (bestIdx < 0 || bestScore < scoreThr) break;

    // Save with original score before zeroing the working copy
    kept.push({ ...dets[bestIdx] });

    // Remove selected detection from pool
    dets[bestIdx].score = 0;

    // Decay overlapping scores (geometry of bestIdx still valid, only score zeroed)
    const bestDet = dets[bestIdx];
    for (let i = 0; i < dets.length; i++) {
      if (dets[i].score <= 0) continue;
      const iou = computeIoU(bestDet, dets[i]);
      dets[i].score *= Math.exp(-(iou * iou) / sigma);
      if (dets[i].score < scoreThr) {
        dets[i].score = 0;
      }
    }
  }

  console.log(`[InferenceService] NMS (soft/${config.nmsMode}, σ=${sigma}, iou=${config.nmsIou}): ${detections.length} -> ${kept.length}`);
  return kept;
}

/**
 * Decode raw model output to OBB detections
 * Uses activeDecodeMode's channel mapping
 *
 * Mode A (matches Python decode_one.py):
 * - ch0 = cx (center x in model space 0-640)
 * - ch1 = cy (center y in model space 0-640)
 * - ch2 = w (width)
 * - ch3 = h (height)
 * - ch4 = score (probability, no sigmoid needed)
 * - ch5 = angle (radians)
 *
 * Canonicalization is applied to ensure w >= h and angle in [-pi/2, pi/2].
 */
export function decodeModelOutput(
  rawOutput: Float32Array | number[],
  outputShape: number[],
  config: PostprocessConfig = activeConfig,
  modeOverride?: DecodeModeConfig
): OBBModelSpace[] {
  const detections: OBBModelSpace[] = [];

  if (outputShape.length !== 3) {
    console.error(`[InferenceService] Unexpected output shape: ${outputShape}`);
    return detections;
  }

  const [, numChannels, numAnchors] = outputShape;

  // Verified format: [1, 6, 8400]
  if (numChannels !== 6) {
    console.error(`[InferenceService] Expected 6 channels, got ${numChannels}`);
    return detections;
  }

  // Use provided mode or active mode
  const mode = modeOverride || activeDecodeMode;
  const chMap = mode.channelMapping;

  for (let i = 0; i < numAnchors; i++) {
    // Extract values using active decode mode's channel mapping
    const cx = rawOutput[chMap.cx * numAnchors + i];
    const cy = rawOutput[chMap.cy * numAnchors + i];
    let w = rawOutput[chMap.w * numAnchors + i];
    let h = rawOutput[chMap.h * numAnchors + i];
    const rawScore = rawOutput[chMap.score * numAnchors + i];
    let angle = rawOutput[chMap.angle * numAnchors + i];

    // Apply sigmoid to convert logit to probability
    const scoreProb = applySigmoid ? sigmoid(rawScore) : rawScore;

    // Apply confidence threshold to probability score
    if (scoreProb < config.thr) {
      continue;
    }

    // Canonicalize: ensure w >= h and normalize angle
    const canonical = canonicalizeOBB(w, h, angle);
    w = canonical.w;
    h = canonical.h;
    angle = canonical.angle;

    detections.push({
      cx,
      cy,
      width: w,
      height: h,
      angle,
      score: scoreProb,    // probability [0,1]
      rawScore,            // original logit for debugging
      classId: 0, // Single class model
    });
  }

  return detections;
}

/**
 * Run inference on preprocessed image tensor
 * Returns raw model outputs for debugging
 * Tracks invoke count and detailed timing
 */
export async function runInferenceRaw(
  inputTensor: Float32Array,
  sessionId?: string
): Promise<RawModelOutput & { timingMs?: { invokeMs: number; outputReadMs: number } }> {
  if (!model) {
    throw new Error('Model not loaded. Call loadModel() first.');
  }

  if (!isModelInspected) {
    throw new Error('GATE 3 VIOLATION: Model must be inspected before inference');
  }

  if (isUsingMockModel) {
    console.warn('[InferenceService] Running mock inference - no real detections');
  }

  // Track invoke count
  invokeCount++;
  const currentInvokeNum = invokeCount;
  console.log(`[InferenceService] Running inference (invoke #${currentInvokeNum})...`);

  // Time the actual model invoke
  const invokeStart = Date.now();
  const outputs = model.runSync([inputTensor]);
  const invokeMs = Date.now() - invokeStart;

  // Time output reading/copying
  const outputReadStart = Date.now();
  const rawOutput: RawModelOutput = {
    outputs: [],
    tensors: [],
    shapes: [],
    notes: isUsingMockModel ? 'MOCK MODEL OUTPUT' : 'Raw model output before postprocessing',
  };

  // Keep zero-copy references for computation, and box into plain arrays ONLY when
  // artifacts will actually consume them. Array.from() on a 6x8400 output allocates
  // ~50k heap numbers, and it used to run on every single inference.
  const boxForArtifacts = isArtifactWritingEnabled();

  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i] as Float32Array;
    rawOutput.tensors.push(output);
    if (boxForArtifacts) {
      rawOutput.outputs.push(Array.from(output));
    }
    rawOutput.shapes.push(Array.from(modelIOContract!.outputTensors[i].shape));
  }
  const outputReadMs = Date.now() - outputReadStart;

  // Log timing
  console.log(`[InferenceService] Invoke #${currentInvokeNum}: invokeMs=${invokeMs}, outputReadMs=${outputReadMs}`);

  // Write raw output for debugging
  if (sessionId && WRITE_RAW_OUTPUT_ARTIFACTS) {
  await writeRawModelOutput(sessionId, rawOutput);
}


  // Return with timing info
  return {
    ...rawOutput,
    timingMs: { invokeMs, outputReadMs },
  };
}

/**
 * Full postprocess pipeline result
 */
export interface PostprocessResult {
  /** Detections in original image pixel space */
  detections: OBBDetection[];
  /** Detections in model space (before coordinate mapping) */
  detectionsModelSpace: OBBModelSpace[];
  /** Pipeline statistics */
  stats: PostprocessStats;
  /** Detections after decode, before NMS (for overlay_modelspace_raw.jpg) */
  detectionsAfterDecode?: OBBModelSpace[];
  /** Detections after NMS, before geom filters (for overlay_modelspace_nms.jpg) */
  detectionsAfterNMS?: OBBModelSpace[];
}

/**
 * Run full postprocess pipeline on raw model output
 * Matches Python: tools/decode_one.py main pipeline
 *
 * STAGE COUNTS ARE LOGGED AT EACH STEP:
 * 1. Decode: 8400 anchors → numAfterThr (above threshold)
 * 2. NMS: numAfterThr → numAfterNms (non-suppressed)
 * 3. Geom: numAfterNms → numAfterGeom (passes geometric filters)
 * 4. TopK: numAfterGeom → final (limited if topK set)
 */
export function runPostprocess(
  rawOutput: Float32Array | number[],
  outputShape: number[],
  letterbox: LetterboxParams,
  config: PostprocessConfig = activeConfig
): PostprocessResult {
  const startTotal = Date.now();

  // Step 1: Decode (includes canonicalization and initial threshold)
  const startDecode = Date.now();
  let decoded = decodeModelOutput(rawOutput, outputShape, config);
  const decodeTime = Date.now() - startDecode;

  // STAGE 1 COUNT: Save decoded detections (before NMS) for overlay
  const detectionsAfterDecode = [...decoded]; // Copy for artifacts
  console.log(`[Postprocess] STAGE 1 - Decode: ${decoded.length} detections (thr=${config.thr})`);

  // ================================================================
  // PRE-NMS SAFEGUARD: Cap candidates to prevent O(n²) explosion
  // NMS on 7000+ boxes = 50M+ comparisons = iOS memory kill
  // ================================================================
  const PRE_NMS_MAX_CANDIDATES = 500;
  if (decoded.length > PRE_NMS_MAX_CANDIDATES) {
    console.warn(`[Postprocess] ⚠️  PRE-NMS CAP: ${decoded.length} candidates exceeds limit ${PRE_NMS_MAX_CANDIDATES}`);
    console.warn(`[Postprocess]    This usually indicates score distribution collapse (raw logits ≈ 0)`);
    console.warn(`[Postprocess]    Taking top ${PRE_NMS_MAX_CANDIDATES} by score to prevent memory explosion`);

    // Sort by score descending and take top candidates
    decoded.sort((a, b) => b.score - a.score);
    decoded = decoded.slice(0, PRE_NMS_MAX_CANDIDATES);

    console.log(`[Postprocess]    After cap: ${decoded.length} candidates (top score: ${decoded[0]?.score.toFixed(4)})`);
  }

  // Step 2: NMS
  const startNms = Date.now();
  const afterNms = applyNMS(decoded, config);
  const nmsTime = Date.now() - startNms;

  // STAGE 2 COUNT: Save NMS detections for overlay
  const detectionsAfterNMS = [...afterNms]; // Copy for artifacts
  console.log(`[Postprocess] STAGE 2 - NMS: ${afterNms.length} detections (iou=${config.nmsIou}, mode=${config.nmsMode})`);

  // Step 3: Geometric filters (instrumented)
  const startGeom = Date.now();
  const { filtered: afterGeomRaw, stats: geomStats } = applyGeometricFiltersInstrumented(
    afterNms,
    letterbox.srcWidth,
    letterbox.srcHeight,
    config
  );
  let afterGeom = afterGeomRaw;
  const geomTime = Date.now() - startGeom;

  // STAGE 3 COUNT
  console.log(`[Postprocess] STAGE 3 - Geom: ${afterGeom.length} detections (minAspect=${config.minAspect}, minScore=${config.minScore})`);

  // Step 4: TopK limit (if configured)
  const numBeforeTopK = afterGeom.length;
  if (config.topK && config.topK > 0 && afterGeom.length > config.topK) {
    // Already sorted by score from NMS, just take top K
    afterGeom = afterGeom.slice(0, config.topK);
    console.log(`[Postprocess] STAGE 4 - TopK: ${numBeforeTopK} -> ${afterGeom.length} (limit ${config.topK})`);
  }

  const totalTime = Date.now() - startTotal;

  // Map to original image pixel space
  const detections: OBBDetection[] = afterGeom.map(det =>
    mapModelToOriginalOBB(det, letterbox)
  );

  const stats: PostprocessStats = {
    numRaw: 8400, // Total anchors
    numAfterThr: decoded.length,
    numAfterNms: afterNms.length,
    numAfterGeom: afterGeom.length,
    config,
    geomStats,
    timings: {
      decode: decodeTime,
      nms: nmsTime,
      geomFilters: geomTime,
      total: totalTime,
    },
  };

  // Log final count
  console.log(`[Postprocess] FINAL: ${detections.length} detections mapped to original space`);

  return {
    detections,
    detectionsModelSpace: afterGeom,
    stats,
    // Include intermediate stages for overlay artifacts
    detectionsAfterDecode,
    detectionsAfterNMS,
  };
}

/**
 * Get model input size
 */
export function getModelInputSize(): number {
  return MODEL_INPUT_SIZE;
}

// ============================================================================
// ARTIFACT DATA EXTRACTION UTILITIES
// ============================================================================

/**
 * Compute tensor statistics from raw model output
 */
export function computeTensorStats(
  rawOutput: number[],
  shape: number[]
): TensorStats {
  const totalElements = rawOutput.length;
  if (totalElements === 0) {
    return {
      outputShape: shape,
      min: 0,
      max: 0,
      mean: 0,
      nonZeroCount: 0,
      totalElements: 0,
      channelStats: [],
    };
  }

  let min = rawOutput[0];
  let max = rawOutput[0];
  let sum = 0;
  let nonZeroCount = 0;

  for (const val of rawOutput) {
    if (val < min) min = val;
    if (val > max) max = val;
    sum += val;
    if (val !== 0) nonZeroCount++;
  }

  const mean = sum / totalElements;

  // Compute per-channel stats for [1, 6, 8400] output
  const channelStats: TensorStats['channelStats'] = [];
  if (shape.length === 3 && shape[1] === 6) {
    const numChannels = shape[1];
    const numAnchors = shape[2];

    for (let ch = 0; ch < numChannels; ch++) {
      let chMin = rawOutput[ch * numAnchors];
      let chMax = rawOutput[ch * numAnchors];
      let chSum = 0;

      for (let i = 0; i < numAnchors; i++) {
        const val = rawOutput[ch * numAnchors + i];
        if (val < chMin) chMin = val;
        if (val > chMax) chMax = val;
        chSum += val;
      }

      channelStats.push({
        channel: ch,
        min: chMin,
        max: chMax,
        mean: chSum / numAnchors,
      });
    }
  }

  return {
    outputShape: shape,
    min,
    max,
    mean,
    nonZeroCount,
    totalElements,
    channelStats,
  };
}

/**
 * Extract sample anchors from raw model output for debugging
 * Uses activeDecodeMode channel mapping (Mode A: ch4=score, ch5=angle)
 */
export function extractRawSampleAnchors(
  rawOutput: number[],
  shape: number[],
  threshold: number = 0.5,
  maxSamples: number = 20
): RawSampleAnchors {
  if (shape.length !== 3 || shape[1] !== 6) {
    return {
      sampleIndices: [],
      samples: [],
      totalAnchors: 0,
      highScoreCount: 0,
      threshold,
    };
  }

  const numAnchors = shape[2];
  const chMap = activeDecodeMode.channelMapping;
  const highScoreIndices: number[] = [];

  // Find high-score anchors using active decode mode's score channel
  for (let i = 0; i < numAnchors; i++) {
    const rawScore = rawOutput[chMap.score * numAnchors + i];
    // Apply sigmoid if enabled to get probability
    const scoreProb = applySigmoid ? sigmoid(rawScore) : rawScore;
    if (scoreProb >= threshold) {
      highScoreIndices.push(i);
    }
  }

  // Sample indices (first N high-score, or evenly distributed if fewer)
  const sampleIndices: number[] = [];
  if (highScoreIndices.length <= maxSamples) {
    sampleIndices.push(...highScoreIndices);
  } else {
    const step = Math.floor(highScoreIndices.length / maxSamples);
    for (let i = 0; i < maxSamples; i++) {
      sampleIndices.push(highScoreIndices[i * step]);
    }
  }

  // Extract sample data using active decode mode channel mapping
  const samples = sampleIndices.map(index => {
    const rawScore = rawOutput[chMap.score * numAnchors + index];
    const scoreProb = applySigmoid ? sigmoid(rawScore) : rawScore;
    return {
      index,
      cx: rawOutput[chMap.cx * numAnchors + index],
      cy: rawOutput[chMap.cy * numAnchors + index],
      w: rawOutput[chMap.w * numAnchors + index],
      h: rawOutput[chMap.h * numAnchors + index],
      score: scoreProb, // Return probability, not raw logit
      rawScore,         // Also include raw for debugging
      angle: rawOutput[chMap.angle * numAnchors + index],
    };
  });

  return {
    sampleIndices,
    samples,
    totalAnchors: numAnchors,
    highScoreCount: highScoreIndices.length,
    threshold,
  };
}

/**
 * Get decode mode comparison data - uses current active mode
 */
export function getDecodeModeComparison(): DecodeModeComparison {
  const mode = activeDecodeMode;
  return {
    chosenMode: mode.mode,
    selectedScoreChannel: mode.channelMapping.score,
    angleChannel: mode.channelMapping.angle,
    sigmoidApplied: applySigmoid,
    channelMapping: mode.channelMapping,
    alternativeModes: [
      {
        mode: MODE_A.mode,
        description: MODE_A.description,
        applicable: mode.mode === 'mode_a',
      },
      {
        mode: MODE_B.mode,
        description: MODE_B.description,
        applicable: mode.mode === 'mode_b',
      },
    ],
  };
}

// ============================================================================
// DIAGNOSTIC DECODE
// ============================================================================

/**
 * Diagnostic decode result - for proving candidates exist
 * Mode A layout (matches Python): ch4=score (probability), ch5=angle (radians)
 */
export interface DiagDecodeResult {
  diagDecodedCount: number;
  top20: Array<{
    index: number;
    rawScore: number;
    scoreProb: number;
    angle: number;
    raw6: [number, number, number, number, number, number];
  }>;
  modeUsed: string;
  scoreChannel: number;
  angleChannel: number;
  thresholdUsed: number;
  sigmoidApplied: boolean;
  totalAnchors: number;
  rawScoreRange: { min: number; max: number };   // Score channel raw values
  scoreProbRange: { min: number; max: number };  // Score channel (with sigmoid if enabled)
  angleRange: { min: number; max: number };      // Angle channel in radians
}

/**
 * Run diagnostic decode with DIAG_PRESET
 * Returns count and top 20 scores with raw 6-float data
 * Does NOT affect normal pipeline - only for debugging
 *
 * Mode A layout (matches Python decode_one.py):
 *   ch0-3: geometry (cx, cy, w, h)
 *   ch4: score (probability, no sigmoid)
 *   ch5: angle in radians
 */
export function runDiagnosticDecode(
  rawOutput: number[],
  shape: number[]
): DiagDecodeResult {
  const chMap = activeDecodeMode.channelMapping;

  if (shape.length !== 3 || shape[1] !== 6) {
    return {
      diagDecodedCount: 0,
      top20: [],
      modeUsed: activeDecodeMode.mode,
      scoreChannel: chMap.score,
      angleChannel: chMap.angle,
      thresholdUsed: DIAG_PRESET.thr,
      sigmoidApplied: applySigmoid,
      totalAnchors: 0,
      rawScoreRange: { min: 0, max: 0 },
      scoreProbRange: { min: 0, max: 0 },
      angleRange: { min: 0, max: 0 },
    };
  }

  const numAnchors = shape[2];

  // Compute raw score range from score channel
  let rawMin = Infinity, rawMax = -Infinity;
  for (let i = 0; i < numAnchors; i++) {
    const rawScore = rawOutput[chMap.score * numAnchors + i];
    if (rawScore < rawMin) rawMin = rawScore;
    if (rawScore > rawMax) rawMax = rawScore;
  }

  // Compute angle range from angle channel
  let angleMin = Infinity, angleMax = -Infinity;
  for (let i = 0; i < numAnchors; i++) {
    const angle = rawOutput[chMap.angle * numAnchors + i];
    if (angle < angleMin) angleMin = angle;
    if (angle > angleMax) angleMax = angle;
  }

  // Collect all anchors above DIAG threshold (0.01) using score probability
  const candidates: Array<{
    index: number;
    rawScore: number;
    scoreProb: number;
    angle: number;
    raw6: [number, number, number, number, number, number];
  }> = [];

  for (let i = 0; i < numAnchors; i++) {
    const rawScore = rawOutput[chMap.score * numAnchors + i];
    const scoreProb = applySigmoid ? sigmoid(rawScore) : rawScore;
    const angle = rawOutput[chMap.angle * numAnchors + i];

    // Use probability threshold for diagnostic
    if (scoreProb >= DIAG_PRESET.thr) {
      candidates.push({
        index: i,
        rawScore,
        scoreProb,
        angle,
        raw6: [
          rawOutput[0 * numAnchors + i], // ch0 = cx
          rawOutput[1 * numAnchors + i], // ch1 = cy
          rawOutput[2 * numAnchors + i], // ch2 = w
          rawOutput[3 * numAnchors + i], // ch3 = h
          rawOutput[4 * numAnchors + i], // ch4 = score (probability)
          rawOutput[5 * numAnchors + i], // ch5 = angle (radians)
        ],
      });
    }
  }

  // Sort by scoreProb descending
  candidates.sort((a, b) => b.scoreProb - a.scoreProb);

  // Compute prob range from all candidates
  const probMin = candidates.length > 0 ? candidates[candidates.length - 1].scoreProb : 0;
  const probMax = candidates.length > 0 ? candidates[0].scoreProb : 0;

  // Take top 20
  const top20 = candidates.slice(0, 20);

  console.log('========================================');
  console.log('[InferenceService] DIAGNOSTIC DECODE (Mode A: ch4=score, ch5=angle)');
  console.log(`[InferenceService]   Active mode: ${activeDecodeMode.mode}`);
  console.log(`[InferenceService]   Score channel: ${chMap.score}, Angle channel: ${chMap.angle}`);
  console.log(`[InferenceService]   Sigmoid applied: ${applySigmoid}`);
  console.log(`[InferenceService]   Threshold (score): ${DIAG_PRESET.thr}`);
  console.log(`[InferenceService]   Score (ch${chMap.score}) range: [${rawMin.toFixed(4)}, ${rawMax.toFixed(4)}]`);
  console.log(`[InferenceService]   Angle (ch${chMap.angle}) range: [${angleMin.toFixed(4)}, ${angleMax.toFixed(4)}] radians`);
  console.log(`[InferenceService]   Candidates above ${DIAG_PRESET.thr}: ${candidates.length} / ${numAnchors}`);
  if (top20.length > 0) {
    console.log(`[InferenceService]   Top 5 scoreProb: ${top20.slice(0, 5).map(c => c.scoreProb.toFixed(4)).join(', ')}`);
    console.log(`[InferenceService]   Top 5 rawScore: ${top20.slice(0, 5).map(c => c.rawScore.toFixed(4)).join(', ')}`);
  }
  console.log('========================================');

  return {
    diagDecodedCount: candidates.length,
    top20,
    modeUsed: activeDecodeMode.mode,
    scoreChannel: chMap.score,
    angleChannel: chMap.angle,
    thresholdUsed: DIAG_PRESET.thr,
    sigmoidApplied: applySigmoid,
    totalAnchors: numAnchors,
    rawScoreRange: { min: rawMin, max: rawMax },
    scoreProbRange: { min: probMin, max: probMax },
    angleRange: { min: angleMin, max: angleMax },
  };
}

/**
 * Orientation info for preprocess debug
 */
export interface OrientationInfo {
  exifOrientation: number;
  rotationApplied: number;
  mirrored: boolean;
  normalizedWidth: number;
  normalizedHeight: number;
  inputNormalizedPath?: string;
}

/**
 * Build preprocess debug info from letterbox params
 */
export function buildPreprocessDebug(
  letterbox: LetterboxParams,
  inputShape?: number[],
  orientation?: OrientationInfo
): PreprocessDebug {
  const shape = inputShape || modelIOContract?.inputTensors[0]?.shape || [1, 640, 640, 3];
  const isNHWC = shape[3] === 3;

  return {
    inputSize: { width: letterbox.srcWidth, height: letterbox.srcHeight },
    outputSize: { width: letterbox.dstWidth, height: letterbox.dstHeight },
    letterbox: {
      scale: letterbox.scale,
      padX: letterbox.padX,
      padY: letterbox.padY,
    },
    normalization: {
      method: 'divide_255',
      range: [0, 1],
    },
    tensorFormat: isNHWC ? 'NHWC' : 'NCHW',
    tensorShape: shape,
    orientation,
  };
}
