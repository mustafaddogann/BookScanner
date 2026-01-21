/**
 * Debug artifacts service - handles writing all debug outputs
 *
 * GUARANTEED ARTIFACT WRITING:
 * - All JSON artifacts use atomic writes (temp + move + verify)
 * - Errors are logged to write_errors.log in session dir
 * - debug_manifest.json tracks all artifacts with exists/bytes verification
 *
 * PERFORMANCE NOTE:
 * - Debug artifacts are DISABLED by default (DEBUG_ARTIFACTS_ENABLED = false)
 * - Enable in src/config/debug.ts when debugging is needed
 */

import RNFS from 'react-native-fs';
import type {
  DebugManifest,
  ImageMeta,
  LetterboxParams,
  ModelIOContract,
  OBBDetection,
  OBBModelSpace,
  RectifyResult,
  PipelineTimings,
  RawModelOutput,
  InferenceContextManifest,
  PostprocessStatsManifest,
  InputTensorMeta,
} from '../types';
import { DEBUG_ARTIFACTS_ENABLED } from '../config/debug';
import type { GroupingAssignments } from './bookCandidateGrouper';

const SESSIONS_DIR = 'sessions';

// ============================================================================
// ARTIFACT WRITING CONTROL
// ============================================================================

/**
 * Global flag to enable/disable artifact writing
 * Default: DEBUG_ARTIFACTS_ENABLED from config (false for production)
 * Use setArtifactWritingEnabled() to override at runtime
 */
let artifactWritingEnabled = DEBUG_ARTIFACTS_ENABLED;

/**
 * Check if artifact writing is currently enabled
 */
export function isArtifactWritingEnabled(): boolean {
  return artifactWritingEnabled;
}

/**
 * Enable or disable artifact writing globally
 * Disabling improves performance in preview mode
 */
export function setArtifactWritingEnabled(enabled: boolean): void {
  artifactWritingEnabled = enabled;
  console.log(`[DebugArtifacts] Artifact writing ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Check if artifacts should be written, log skip message if not
 * Returns true if write should proceed, false if it should be skipped
 */
function shouldWriteArtifact(artifactName: string): boolean {
  if (!artifactWritingEnabled) {
    // Only log once per unique artifact to reduce noise
    return false;
  }
  return true;
}

/**
 * Return value for skipped artifact writes
 */
const SKIPPED_WRITE_RESULT: WriteResult = {
  success: true,
  path: '',
  bytes: 0,
  error: 'Artifact writing disabled',
};

// ============================================================================
// ARTIFACT INFO TYPES
// ============================================================================

/**
 * Artifact metadata for debug manifest
 */
export interface ArtifactInfo {
  name: string;
  path: string;
  exists: boolean;
  bytes: number;
}

/**
 * Result of atomic JSON write
 */
export interface WriteResult {
  success: boolean;
  path: string;
  bytes: number;
  error?: string;
}

// ============================================================================
// ATOMIC WRITE HELPERS
// ============================================================================

/**
 * Generate unique tmp filename to avoid collisions
 */
function generateUniqueTmpPath(basePath: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 8);
  return `${basePath}.${ts}.${rand}.tmp`;
}

/**
 * Safe JSON write with overwrite support
 * - Uses unique tmp filename to avoid collisions
 * - Deletes existing file before move (idempotent)
 * - Cleans up tmp on both success and failure
 */
export async function writeJsonAtomic(
  path: string,
  obj: object,
  sessionDir?: string
): Promise<WriteResult> {
  const tmpPath = generateUniqueTmpPath(path);

  try {
    // Step 1: Write to uniquely-named temp file
    const jsonStr = JSON.stringify(obj, null, 2);
    await RNFS.writeFile(tmpPath, jsonStr, 'utf8');

    // Step 2: Delete existing file if present (makes write idempotent)
    try {
      const destExists = await RNFS.exists(path);
      if (destExists) {
        await RNFS.unlink(path);
      }
    } catch {
      // Ignore - file may not exist
    }

    // Step 3: Move temp to final path
    await RNFS.moveFile(tmpPath, path);

    // Step 4: Verify with stat
    const stat = await RNFS.stat(path);
    const bytes = typeof stat.size === 'string' ? parseInt(stat.size, 10) : stat.size;

    console.log(`[DebugArtifacts] ✓ Wrote ${path} (${bytes} bytes)`);

    return { success: true, path, bytes };
  } catch (error: any) {
    const errMsg = `Failed to write ${path}: ${error.message}\n${error.stack || ''}`;
    console.error(`[DebugArtifacts] ✗ ${errMsg}`);

    // Log to write_errors.log if sessionDir provided
    if (sessionDir) {
      await appendWriteError(sessionDir, errMsg);
    }

    // Clean up temp file if exists
    try {
      const tmpExists = await RNFS.exists(tmpPath);
      if (tmpExists) {
        await RNFS.unlink(tmpPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    return { success: false, path, bytes: 0, error: error.message };
  }
}

/**
 * Append error message to write_errors.log in session directory
 */
export async function appendWriteError(sessionDir: string, message: string): Promise<void> {
  const errorLogPath = `${sessionDir}/write_errors.log`;
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;

  try {
    const exists = await RNFS.exists(errorLogPath);
    if (exists) {
      await RNFS.appendFile(errorLogPath, entry, 'utf8');
    } else {
      await RNFS.writeFile(errorLogPath, entry, 'utf8');
    }
  } catch (e: any) {
    console.error(`[DebugArtifacts] Failed to write error log: ${e.message}`);
  }
}

/**
 * Verify artifact exists and get size
 */
export async function verifyArtifact(path: string): Promise<ArtifactInfo> {
  const name = path.split('/').pop() || 'unknown';
  try {
    const exists = await RNFS.exists(path);
    if (!exists) {
      return { name, path, exists: false, bytes: 0 };
    }
    const stat = await RNFS.stat(path);
    const bytes = typeof stat.size === 'string' ? parseInt(stat.size, 10) : stat.size;
    return { name, path, exists: true, bytes };
  } catch {
    return { name, path, exists: false, bytes: 0 };
  }
}

/**
 * Get the base documents directory for the app
 */
export function getDocumentsDir(): string {
  return RNFS.DocumentDirectoryPath;
}

/**
 * Get the path to the sessions directory
 */
export function getSessionsDir(): string {
  return `${getDocumentsDir()}/${SESSIONS_DIR}`;
}

/**
 * Get the path to a specific session directory
 */
export function getSessionDir(sessionId: string): string {
  return `${getSessionsDir()}/${sessionId}`;
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `scan_${timestamp}_${random}`;
}

/**
 * Ensure sessions directory exists
 */
export async function ensureSessionsDir(): Promise<void> {
  const sessionsDir = getSessionsDir();
  const exists = await RNFS.exists(sessionsDir);
  if (!exists) {
    await RNFS.mkdir(sessionsDir);
  }
}

/**
 * Create a new session directory
 * Logs session start info for debugging
 */
export async function createSessionDir(sessionId: string): Promise<string> {
  await ensureSessionsDir();
  const sessionDir = getSessionDir(sessionId);

  // Ensure directory exists (mkdir -p behavior)
  await RNFS.mkdir(sessionDir);

  // Create crops subdirectory
  const cropsDir = `${sessionDir}/crops`;
  await RNFS.mkdir(cropsDir);

  // Log session start - authoritative session info
  console.log('========================================');
  console.log(`[session] id=${sessionId} dir=${sessionDir}`);
  console.log(`[session] Xcode: Download Container -> AppData/Documents/sessions/${sessionId}/`);
  console.log('========================================');

  return sessionDir;
}

/**
 * Write debug manifest JSON (atomic)
 */
export async function writeDebugManifest(
  sessionId: string,
  manifest: DebugManifest
): Promise<string> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('debug_manifest.json')) {
    return '';
  }

  const sessionDir = getSessionDir(sessionId);
  const manifestPath = `${sessionDir}/debug_manifest.json`;

  // Ensure directory exists
  await RNFS.mkdir(sessionDir);

  const result = await writeJsonAtomic(manifestPath, manifest, sessionDir);
  if (!result.success) {
    console.error(`[DebugArtifacts] Failed to write debug_manifest.json: ${result.error}`);
  }
  return manifestPath;
}

/**
 * Write model IO contract JSON (atomic)
 */
export async function writeModelIO(
  sessionId: string,
  modelIO: ModelIOContract
): Promise<string> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('model_io.json')) {
    return '';
  }

  const sessionDir = getSessionDir(sessionId);
  const modelIOPath = `${sessionDir}/model_io.json`;

  // Ensure directory exists
  await RNFS.mkdir(sessionDir);

  const result = await writeJsonAtomic(modelIOPath, modelIO, sessionDir);
  if (!result.success) {
    console.error(`[DebugArtifacts] Failed to write model_io.json: ${result.error}`);
  }
  return modelIOPath;
}

/**
 * Write raw model output JSON (atomic)
 */
export async function writeRawModelOutput(
  sessionId: string,
  rawOutput: RawModelOutput
): Promise<string> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('detections_raw.json')) {
    return '';
  }

  const sessionDir = getSessionDir(sessionId);
  const rawOutputPath = `${sessionDir}/detections_raw.json`;

  // Ensure directory exists
  await RNFS.mkdir(sessionDir);

  const result = await writeJsonAtomic(rawOutputPath, rawOutput, sessionDir);
  if (!result.success) {
    console.error(`[DebugArtifacts] Failed to write detections_raw.json: ${result.error}`);
  }
  return rawOutputPath;
}

/**
 * Copy original image to session directory
 * NOTE: debug_manifest.json is written ONCE at end of pipeline via writeAllArtifacts()
 */
export async function copyOriginalImage(
  sessionId: string,
  sourceUri: string
): Promise<string> {
  const sessionDir = getSessionDir(sessionId);

  // Ensure session dir exists (mkdir -p)
  await RNFS.mkdir(sessionDir);

  const ext = sourceUri.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const destPath = `${sessionDir}/original.${ext}`;

  // Handle file:// prefix
  const cleanSourceUri = sourceUri.startsWith('file://')
    ? sourceUri.slice(7)
    : sourceUri;

  await RNFS.copyFile(cleanSourceUri, destPath);
  console.log(`[DebugArtifacts] Copied original image to ${destPath}`);

  // Verify original image was written
  const imageArtifact = await verifyArtifact(destPath);
  console.log(`[DebugArtifacts] original.${ext}: exists=${imageArtifact.exists}, bytes=${imageArtifact.bytes}`);

  return destPath;
}

/**
 * Write crop image and metadata (idempotent)
 * Skips copy if source and destination are the same path
 * Uses atomic write for metadata JSON
 */
export async function writeCrop(
  sessionId: string,
  cropIndex: number,
  cropUri: string,
  metadata: RectifyResult
): Promise<{ imagePath: string; metadataPath: string }> {
  const sessionDir = getSessionDir(sessionId);
  const cropsDir = `${sessionDir}/crops`;

  // Ensure crops directory exists
  await RNFS.mkdir(cropsDir);

  const ext = cropUri.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const imagePath = `${cropsDir}/crop_${cropIndex}.${ext}`;
  const metadataPath = `${cropsDir}/crop_${cropIndex}.json`;

  // Copy crop image only if source != destination (idempotent)
  const cleanCropUri = cropUri.startsWith('file://') ? cropUri.slice(7) : cropUri;
  const cleanImagePath = imagePath.startsWith('file://') ? imagePath.slice(7) : imagePath;

  if (cleanCropUri !== cleanImagePath) {
    // Delete existing destination if present
    try {
      const destExists = await RNFS.exists(cleanImagePath);
      if (destExists) {
        await RNFS.unlink(cleanImagePath);
      }
    } catch {
      // Ignore - file may not exist
    }
    await RNFS.copyFile(cleanCropUri, cleanImagePath);
  } else {
    console.log(`[DebugArtifacts] Crop image already at destination, skipping copy`);
  }

  // Write metadata using atomic write
  const result = await writeJsonAtomic(metadataPath, metadata, sessionDir);
  if (!result.success) {
    console.error(`[DebugArtifacts] Failed to write crop_${cropIndex}.json: ${result.error}`);
  }

  // Verify crop was written
  const cropArtifact = await verifyArtifact(cleanImagePath);
  console.log(`[DebugArtifacts] crop_${cropIndex}: exists=${cropArtifact.exists}, bytes=${cropArtifact.bytes}`);

  return { imagePath, metadataPath };
}

/**
 * Write coordinate test artifact for Gate 2 (atomic)
 */
export async function writeCoordinateTest(
  sessionId: string,
  testData: object
): Promise<string> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('coordinate_test.json')) {
    return '';
  }

  const sessionDir = getSessionDir(sessionId);
  const testPath = `${sessionDir}/coordinate_test.json`;

  await RNFS.mkdir(sessionDir);
  const result = await writeJsonAtomic(testPath, testData, sessionDir);
  if (!result.success) {
    console.error(`[DebugArtifacts] Failed to write coordinate_test.json: ${result.error}`);
  }
  return testPath;
}

/**
 * Write angle test artifact for Gate 3 (atomic)
 */
export async function writeAngleTest(
  sessionId: string,
  testData: object
): Promise<string> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('angle_test.json')) {
    return '';
  }

  const sessionDir = getSessionDir(sessionId);
  const testPath = `${sessionDir}/angle_test.json`;

  await RNFS.mkdir(sessionDir);
  const result = await writeJsonAtomic(testPath, testData, sessionDir);
  if (!result.success) {
    console.error(`[DebugArtifacts] Failed to write angle_test.json: ${result.error}`);
  }
  return testPath;
}

// ============================================================================
// NEW ARTIFACT WRITERS - Required for complete session artifacts
// ============================================================================

/**
 * Tensor statistics from model output
 */
export interface TensorStats {
  outputShape: number[];
  min: number;
  max: number;
  mean: number;
  nonZeroCount: number;
  totalElements: number;
  channelStats?: Array<{
    channel: number;
    min: number;
    max: number;
    mean: number;
  }>;
}

/**
 * Write tensor_stats.json - statistics about raw model output tensor (atomic)
 */
export async function writeTensorStats(
  sessionId: string,
  stats: TensorStats
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('tensor_stats.json')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const statsPath = `${sessionDir}/tensor_stats.json`;

  await RNFS.mkdir(sessionDir);
  return writeJsonAtomic(statsPath, stats, sessionDir);
}

/**
 * Raw sample anchors data
 */
export interface RawSampleAnchors {
  sampleIndices: number[];
  samples: Array<{
    index: number;
    cx: number;
    cy: number;
    w: number;
    h: number;
    score: number;      // probability [0,1] (after sigmoid if enabled)
    rawScore?: number;  // raw logit before sigmoid (for debugging)
    angle: number;
  }>;
  totalAnchors: number;
  highScoreCount: number;
  threshold: number;
}

/**
 * Write raw_sample_anchors.json - sample of raw anchor data before filtering (atomic)
 */
export async function writeRawSampleAnchors(
  sessionId: string,
  data: RawSampleAnchors
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('raw_sample_anchors.json')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const anchorsPath = `${sessionDir}/raw_sample_anchors.json`;

  await RNFS.mkdir(sessionDir);
  return writeJsonAtomic(anchorsPath, data, sessionDir);
}

/**
 * Decode mode comparison data
 */
export interface DecodeModeComparison {
  chosenMode: string;
  selectedScoreChannel: number;
  angleChannel?: number;
  sigmoidApplied: boolean;
  rawScoreRange?: { min: number; max: number };
  scoreProbRange?: { min: number; max: number };
  channelMapping: {
    cx: number;
    cy: number;
    w: number;
    h: number;
    score: number;
    angle: number;
  };
  alternativeModes?: Array<{
    mode: string;
    description: string;
    applicable: boolean;
  }>;
}

/**
 * Write decode_mode_comparison.json - decode mode selection info (atomic)
 */
export async function writeDecodeModeComparison(
  sessionId: string,
  data: DecodeModeComparison
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('decode_mode_comparison.json')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const comparePath = `${sessionDir}/decode_mode_comparison.json`;

  await RNFS.mkdir(sessionDir);
  return writeJsonAtomic(comparePath, data, sessionDir);
}

/**
 * Preprocess debug data including orientation normalization
 */
export interface PreprocessDebug {
  inputSize: { width: number; height: number };
  outputSize: { width: number; height: number };
  letterbox: {
    scale: number;
    padX: number;
    padY: number;
  };
  normalization: {
    method: string;
    range: [number, number];
  };
  tensorFormat: string;
  tensorShape: number[];
  // Orientation normalization info
  orientation?: {
    exifOrientation: number;
    rotationApplied: number;  // degrees (0, 90, 180, 270)
    mirrored: boolean;
    normalizedWidth: number;
    normalizedHeight: number;
    inputNormalizedPath?: string;  // path to input_normalized.jpg
  };
}

/**
 * Copy image as input_normalized.jpg
 * NOTE: This currently just copies the original.
 * For true normalization with EXIF rotation, would need native ImageManipulator.
 * React Native's Image component auto-applies EXIF when displaying,
 * so original.jpg displays correctly but inference needs the actual pixels normalized.
 */
export async function writeInputNormalized(
  sessionId: string,
  sourceUri: string,
  exifOrientation: number
): Promise<{ path: string; rotationApplied: number }> {
  const sessionDir = getSessionDir(sessionId);
  await RNFS.mkdir(sessionDir);

  const ext = sourceUri.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const normalizedPath = `${sessionDir}/input_normalized.${ext}`;

  const cleanSource = sourceUri.startsWith('file://') ? sourceUri.slice(7) : sourceUri;

  // Calculate rotation needed from EXIF orientation
  // Orientations: 1=normal, 3=180°, 6=90°CW, 8=90°CCW
  let rotationApplied = 0;
  switch (exifOrientation) {
    case 3: rotationApplied = 180; break;
    case 6: rotationApplied = 90; break;
    case 8: rotationApplied = 270; break;
    default: rotationApplied = 0;
  }

  // For now, just copy the original
  // TODO: Use ImageManipulator or native module to actually rotate pixels
  try {
    // Delete existing if present
    const exists = await RNFS.exists(normalizedPath);
    if (exists) {
      await RNFS.unlink(normalizedPath);
    }
    await RNFS.copyFile(cleanSource, normalizedPath);
    console.log(`[DebugArtifacts] Wrote input_normalized.${ext} (rotation=${rotationApplied}° from EXIF=${exifOrientation})`);
  } catch (error: any) {
    console.error(`[DebugArtifacts] Failed to write input_normalized: ${error.message}`);
  }

  return { path: normalizedPath, rotationApplied };
}

/**
 * Result of createDisplayImage
 */
export interface DisplayImageResult {
  path: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  resized: boolean;
}

/**
 * Create a downscaled display image for UI rendering
 *
 * This generates a smaller version of the normalized image to avoid
 * "[PERF ASSETS] Loading image at size ... larger than screen" warnings.
 *
 * The display image is ONLY for UI rendering - detection coordinates
 * are still relative to the original image dimensions and must be scaled
 * using the returned scale factor.
 *
 * @param sessionId - Session ID for artifact storage
 * @param sourcePath - Path to source image (usually input_normalized.jpg)
 * @param maxDimension - Max size for longest edge (default 1280)
 * @param quality - JPEG quality 0.0-1.0 (default 0.85)
 * @returns DisplayImageResult with path and scale info, or null if native module unavailable
 */
export async function createDisplayImage(
  sessionId: string,
  sourcePath: string,
  maxDimension: number = 1280,
  quality: number = 0.85
): Promise<DisplayImageResult | null> {
  const sessionDir = getSessionDir(sessionId);
  const displayPath = `${sessionDir}/display.jpg`;

  // Get native module
  const { NativeModules } = require('react-native');
  const { ImagePreprocessor } = NativeModules;

  if (!ImagePreprocessor || !ImagePreprocessor.createDisplayImage) {
    console.warn('[DebugArtifacts] createDisplayImage: Native module not available');
    return null;
  }

  try {
    // Clean source path for native module
    const cleanSource = sourcePath.startsWith('file://') ? sourcePath.slice(7) : sourcePath;

    const result = await ImagePreprocessor.createDisplayImage(
      cleanSource,
      displayPath,
      maxDimension,
      quality
    );

    console.log(
      `[DebugArtifacts] Created display.jpg: ${result.width}x${result.height} ` +
      `(source: ${result.sourceWidth}x${result.sourceHeight}, scale: ${result.scale.toFixed(3)}, resized: ${result.resized})`
    );

    return {
      path: displayPath,
      width: result.width,
      height: result.height,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      scale: result.scale,
      resized: result.resized,
    };
  } catch (error: any) {
    console.error(`[DebugArtifacts] createDisplayImage failed: ${error.message}`);
    return null;
  }
}

/**
 * Write preprocess_debug.json - preprocessing parameters (atomic)
 */
export async function writePreprocessDebug(
  sessionId: string,
  data: PreprocessDebug
): Promise<WriteResult> {
  const sessionDir = getSessionDir(sessionId);
  const preprocessPath = `${sessionDir}/preprocess_debug.json`;

  await RNFS.mkdir(sessionDir);
  return writeJsonAtomic(preprocessPath, data, sessionDir);
}

/**
 * Build debug manifest from pipeline results
 */
export function buildDebugManifest(params: {
  sessionId: string;
  source: 'camera' | 'fixture';
  fixtureName?: string;
  imageMeta: ImageMeta;
  letterboxParams: LetterboxParams;
  modelIO: ModelIOContract | string;
  detections: OBBDetection[];
  selectedIndex?: number;
  rectification?: RectifyResult[];
  timings: PipelineTimings;
  errors: string[];
  angleConvention?: string;
  /** Serialized FrameGeo - single source of truth for geometry */
  frameGeo?: object;
  /** Input tensor preprocessing metadata */
  inputTensorMeta?: InputTensorMeta;
}): DebugManifest {
  return {
    sessionId: params.sessionId,
    createdAt: new Date().toISOString(),
    source: params.source,
    fixtureName: params.fixtureName,
    imageMeta: params.imageMeta,
    rotationPolicy: params.imageMeta.isNormalized
      ? 'EXIF rotation applied to normalize upright'
      : 'No rotation normalization needed',
    letterboxParams: params.letterboxParams,
    modelIO: params.modelIO,
    detectionsOriginal: params.detections,
    selectedDetectionIndex: params.selectedIndex,
    rectification: params.rectification,
    timings: params.timings,
    errors: params.errors,
    angleConvention: params.angleConvention,
    // Include FrameGeo as single source of truth for ResultsScreen
    frameGeo: params.frameGeo,
    // Include input tensor preprocessing metadata
    inputTensorMeta: params.inputTensorMeta,
  };
}

/**
 * List all session IDs
 */
export async function listSessions(): Promise<string[]> {
  const sessionsDir = getSessionsDir();
  const exists = await RNFS.exists(sessionsDir);
  if (!exists) {
    return [];
  }

  const items = await RNFS.readDir(sessionsDir);
  return items
    .filter(item => item.isDirectory())
    .map(item => item.name)
    .sort()
    .reverse();
}

/**
 * Read debug manifest for a session
 */
export async function readDebugManifest(sessionId: string): Promise<DebugManifest | null> {
  const manifestPath = `${getSessionDir(sessionId)}/debug_manifest.json`;
  try {
    const content = await RNFS.readFile(manifestPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`[DebugArtifacts] Failed to read manifest for ${sessionId}:`, error);
    return null;
  }
}

/**
 * Delete a session and all its artifacts
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const sessionDir = getSessionDir(sessionId);
  const exists = await RNFS.exists(sessionDir);
  if (exists) {
    await RNFS.unlink(sessionDir);
    console.log(`[DebugArtifacts] Deleted session ${sessionId}`);
  }
}

/**
 * Build comprehensive capture debug manifest (GATE 6)
 * Includes all coordinate spaces and inference context
 */
export function buildCaptureDebugManifest(params: {
  sessionId: string;
  source: 'camera' | 'fixture';
  fixtureName?: string;
  imageMeta: ImageMeta;
  letterboxParams: LetterboxParams;
  modelIO: ModelIOContract | string;
  detectionsModelSpace: OBBModelSpace[];
  detectionsFrameSpace: OBBDetection[];
  detectionsViewSpace?: OBBDetection[];
  inferenceContext: InferenceContextManifest;
  postprocessStats: PostprocessStatsManifest;
  rectification?: RectifyResult[];
  timings: PipelineTimings;
  errors: string[];
}): DebugManifest {
  return {
    sessionId: params.sessionId,
    createdAt: new Date().toISOString(),
    source: params.source,
    fixtureName: params.fixtureName,
    imageMeta: params.imageMeta,
    rotationPolicy: params.imageMeta.isNormalized
      ? 'EXIF rotation applied to normalize upright'
      : 'No rotation normalization needed',
    letterboxParams: params.letterboxParams,
    modelIO: params.modelIO,

    // All coordinate spaces (GATE 6)
    detectionsModelSpace: params.detectionsModelSpace,
    detectionsFrameSpace: params.detectionsFrameSpace,
    detectionsViewSpace: params.detectionsViewSpace,
    detectionsOriginal: params.detectionsFrameSpace, // Legacy compatibility

    // Full inference context (GATE 6)
    inferenceContext: params.inferenceContext,
    postprocessStats: params.postprocessStats,

    rectification: params.rectification,
    timings: params.timings,
    errors: params.errors,
    angleConvention: 'radians, counter-clockwise from positive x-axis',
  };
}

/**
 * Write capture debug manifest with all details (GATE 6)
 * Logs the path for verification - uses atomic write
 */
export async function writeCaptureDebugManifest(
  sessionId: string,
  manifest: DebugManifest
): Promise<string> {
  const sessionDir = getSessionDir(sessionId);
  const manifestPath = `${sessionDir}/debug_manifest.json`;

  // Ensure directory exists
  await RNFS.mkdir(sessionDir);

  const result = await writeJsonAtomic(manifestPath, manifest, sessionDir);

  console.log('========================================');
  console.log(`[DebugArtifacts] CAPTURE DEBUG MANIFEST SAVED`);
  console.log(`[DebugArtifacts] Path: ${manifestPath}`);
  console.log(`[DebugArtifacts] Bytes: ${result.bytes}`);
  console.log(`[DebugArtifacts] Success: ${result.success}`);
  console.log(`[DebugArtifacts] Detections (model space): ${manifest.detectionsModelSpace?.length ?? 0}`);
  console.log(`[DebugArtifacts] Detections (frame space): ${manifest.detectionsFrameSpace?.length ?? 0}`);
  console.log('========================================');

  if (!result.success) {
    console.error(`[DebugArtifacts] Failed to write debug_manifest.json: ${result.error}`);
  }

  return manifestPath;
}

// ============================================================================
// COMPREHENSIVE ARTIFACT WRITING
// ============================================================================

/**
 * Diagnostic decode result (matches inferenceService.DiagDecodeResult)
 * Mode B layout: ch4=angle(rad), ch5=rawScore(logit)
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
  rawScoreRange: { min: number; max: number };   // ch5 raw logits
  scoreProbRange: { min: number; max: number };  // ch5 after sigmoid
  angleRange: { min: number; max: number };      // ch4 in radians
}

/**
 * Geom filter rejection stats for debugging
 */
export interface GeomFilterRejectionStats {
  byAspect: number;
  byArea: number;
  byBounds: number;
  byScore: number;
  byAngle: number;
  byNaN: number;
  sampleRejected?: Array<{
    reason: string;
    aspect: number;
    areaRatio: number;
    angleDeg: number;
    score: number;
    width: number;
    height: number;
    cx: number;
    cy: number;
  }>;
}

/**
 * Filtered detections data (final pipeline output)
 */
export interface FilteredDetectionsData {
  count: number;
  config: {
    thr: number;
    nmsIou: number;
    nmsMode: string;
    minAspect: number;
    maxAreaRatio: number;
    minScore: number;
  };
  detections: OBBDetection[];
  stageCounts: {
    raw: number;
    afterThr: number;
    afterNms: number;
    afterGeom: number;
  };
  /** Geom filter rejection stats - shows why detections were filtered */
  geomRejections?: GeomFilterRejectionStats;
}

/**
 * Write filtered_detections.json - final pipeline output (atomic)
 */
export async function writeFilteredDetections(
  sessionId: string,
  data: FilteredDetectionsData
): Promise<WriteResult> {
  const sessionDir = getSessionDir(sessionId);
  const detPath = `${sessionDir}/filtered_detections.json`;

  await RNFS.mkdir(sessionDir);
  return writeJsonAtomic(detPath, data, sessionDir);
}

/**
 * Write grouping_assignments.json - shows how detections were grouped into candidates (atomic)
 *
 * Includes:
 * - Which crops/detections belong to each candidate
 * - Merge decisions made (reason, IoU, angle diff, center dist, text similarity)
 * - Whether safety fallback was triggered
 * - Configuration thresholds used
 */
export async function writeGroupingAssignments(
  sessionId: string,
  assignments: GroupingAssignments
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('grouping_assignments.json')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const assignmentsPath = `${sessionDir}/grouping_assignments.json`;

  await RNFS.mkdir(sessionDir);
  return writeJsonAtomic(assignmentsPath, assignments, sessionDir);
}

/**
 * All session artifacts data for writeAllArtifacts
 */
export interface AllArtifactsData {
  sessionId: string;
  tensorStats?: TensorStats;
  rawSampleAnchors?: RawSampleAnchors;
  decodeModeComparison?: DecodeModeComparison;
  preprocessDebug?: PreprocessDebug;
  detectionsRaw?: RawModelOutput;
  diagResult?: DiagDecodeResult;
  filteredDetections?: FilteredDetectionsData;
  manifest: DebugManifest;
}

/**
 * Write all session artifacts and update manifest with verification
 * Guaranteed to write all files even if detections=0
 *
 * If artifact writing is disabled via setArtifactWritingEnabled(false),
 * this function returns an empty array without writing anything.
 */
export async function writeAllArtifacts(data: AllArtifactsData): Promise<ArtifactInfo[]> {
  // Early return if artifact writing is disabled (e.g., in preview mode)
  if (!artifactWritingEnabled) {
    console.log('[DebugArtifacts] Artifact writing disabled, skipping writeAllArtifacts');
    return [];
  }

  const { sessionId } = data;
  const sessionDir = getSessionDir(sessionId);
  const artifacts: ArtifactInfo[] = [];

  console.log('========================================');
  console.log(`[DebugArtifacts] Writing all artifacts for session ${sessionId}`);
  console.log(`[DebugArtifacts] Session dir: ${sessionDir}`);

  // Ensure directory exists
  await RNFS.mkdir(sessionDir);

  // 1. Write tensor_stats.json
  if (data.tensorStats) {
    const result = await writeTensorStats(sessionId, data.tensorStats);
    artifacts.push({
      name: 'tensor_stats.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  } else {
    // Write empty placeholder
    const emptyStats: TensorStats = {
      outputShape: [],
      min: 0,
      max: 0,
      mean: 0,
      nonZeroCount: 0,
      totalElements: 0,
      channelStats: [],
    };
    const result = await writeTensorStats(sessionId, emptyStats);
    artifacts.push({
      name: 'tensor_stats.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  }

  // 2. Write raw_sample_anchors.json
  if (data.rawSampleAnchors) {
    const result = await writeRawSampleAnchors(sessionId, data.rawSampleAnchors);
    artifacts.push({
      name: 'raw_sample_anchors.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  } else {
    // Write empty placeholder
    const emptyAnchors: RawSampleAnchors = {
      sampleIndices: [],
      samples: [],
      totalAnchors: 8400,
      highScoreCount: 0,
      threshold: 0.5,
    };
    const result = await writeRawSampleAnchors(sessionId, emptyAnchors);
    artifacts.push({
      name: 'raw_sample_anchors.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  }

  // 3. Write decode_mode_comparison.json
  if (data.decodeModeComparison) {
    const result = await writeDecodeModeComparison(sessionId, data.decodeModeComparison);
    artifacts.push({
      name: 'decode_mode_comparison.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  } else {
    // Write default decode mode info
    const defaultDecodeMode: DecodeModeComparison = {
      chosenMode: 'yolov8_obb_6channel',
      selectedScoreChannel: 4,
      sigmoidApplied: false,
      channelMapping: { cx: 0, cy: 1, w: 2, h: 3, score: 4, angle: 5 },
      alternativeModes: [],
    };
    const result = await writeDecodeModeComparison(sessionId, defaultDecodeMode);
    artifacts.push({
      name: 'decode_mode_comparison.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  }

  // 4. Write preprocess_debug.json
  if (data.preprocessDebug) {
    const result = await writePreprocessDebug(sessionId, data.preprocessDebug);
    artifacts.push({
      name: 'preprocess_debug.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  } else {
    // Write default preprocess info
    const defaultPreprocess: PreprocessDebug = {
      inputSize: { width: 0, height: 0 },
      outputSize: { width: 640, height: 640 },
      letterbox: { scale: 1, padX: 0, padY: 0 },
      normalization: { method: 'divide_255', range: [0, 1] },
      tensorFormat: 'NHWC',
      tensorShape: [1, 640, 640, 3],
    };
    const result = await writePreprocessDebug(sessionId, defaultPreprocess);
    artifacts.push({
      name: 'preprocess_debug.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  }

  // 5. Write detections_raw.json
  if (data.detectionsRaw) {
    const rawPath = `${sessionDir}/detections_raw.json`;
    const result = await writeJsonAtomic(rawPath, data.detectionsRaw, sessionDir);
    artifacts.push({
      name: 'detections_raw.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  } else {
    // Write empty raw output
    const emptyRaw: RawModelOutput = {
      outputs: [],
      shapes: [],
      notes: 'No inference output available',
    };
    const rawPath = `${sessionDir}/detections_raw.json`;
    const result = await writeJsonAtomic(rawPath, emptyRaw, sessionDir);
    artifacts.push({
      name: 'detections_raw.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  }

  // 6. Write diag_decode.json (diagnostic decode results - for debugging only)
  if (data.diagResult) {
    const diagPath = `${sessionDir}/diag_decode.json`;
    const result = await writeJsonAtomic(diagPath, data.diagResult, sessionDir);
    artifacts.push({
      name: 'diag_decode.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  } else {
    // Write empty diag result (Mode A: ch4=score, ch5=angle - matches Python decode_one.py)
    const emptyDiag: DiagDecodeResult = {
      diagDecodedCount: 0,
      top20: [],
      modeUsed: 'mode_a',
      scoreChannel: 4,
      angleChannel: 5,
      thresholdUsed: 0.01,
      sigmoidApplied: false,
      totalAnchors: 0,
      rawScoreRange: { min: 0, max: 0 },
      scoreProbRange: { min: 0, max: 0 },
      angleRange: { min: 0, max: 0 },
    };
    const diagPath = `${sessionDir}/diag_decode.json`;
    const result = await writeJsonAtomic(diagPath, emptyDiag, sessionDir);
    artifacts.push({
      name: 'diag_decode.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  }

  // 7. Write filtered_detections.json (FINAL pipeline output for display)
  if (data.filteredDetections) {
    const result = await writeFilteredDetections(sessionId, data.filteredDetections);
    artifacts.push({
      name: 'filtered_detections.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  } else {
    // Write placeholder with detections from manifest
    const placeholderFiltered: FilteredDetectionsData = {
      count: data.manifest.detectionsOriginal?.length ?? 0,
      config: {
        thr: 0.5,
        nmsIou: 0.9,
        nmsMode: 'aabb',
        minAspect: 6.0,
        maxAreaRatio: 0.08,
        minScore: 0.6,
      },
      detections: data.manifest.detectionsOriginal || [],
      stageCounts: {
        raw: 8400,
        afterThr: 0,
        afterNms: 0,
        afterGeom: data.manifest.detectionsOriginal?.length ?? 0,
      },
    };
    const result = await writeFilteredDetections(sessionId, placeholderFiltered);
    artifacts.push({
      name: 'filtered_detections.json',
      path: result.path,
      exists: result.success,
      bytes: result.bytes,
    });
  }

  // 8. Verify original.jpg exists
  const originalJpgPath = `${sessionDir}/original.jpg`;
  const originalPngPath = `${sessionDir}/original.png`;
  let originalArtifact = await verifyArtifact(originalJpgPath);
  if (!originalArtifact.exists) {
    originalArtifact = await verifyArtifact(originalPngPath);
  }
  artifacts.push(originalArtifact);

  // 9. Write final debug_manifest.json with all artifacts
  const finalManifest = {
    ...data.manifest,
    artifacts,
    chosenMode: data.decodeModeComparison?.chosenMode,
    selectedScoreChannel: data.decodeModeComparison?.selectedScoreChannel,
    sigmoidApplied: data.decodeModeComparison?.sigmoidApplied,
    // Diagnostic decode info
    diagDecodedCount: data.diagResult?.diagDecodedCount ?? 0,
    diagModeUsed: data.diagResult?.modeUsed,
    diagThreshold: data.diagResult?.thresholdUsed,
  };

  const manifestPath = `${sessionDir}/debug_manifest.json`;
  const manifestResult = await writeJsonAtomic(manifestPath, finalManifest, sessionDir);
  artifacts.push({
    name: 'debug_manifest.json',
    path: manifestResult.path,
    exists: manifestResult.success,
    bytes: manifestResult.bytes,
  });

  // Log summary
  console.log('[DebugArtifacts] Artifact write summary:');
  for (const artifact of artifacts) {
    const status = artifact.exists ? '✓' : '✗';
    console.log(`  ${status} ${artifact.name}: ${artifact.bytes} bytes`);
  }

  // Log export hint
  console.log('----------------------------------------');
  console.log(`[DebugArtifacts] Xcode: Download Container -> AppData/Documents/sessions/${sessionId}/`);
  console.log('========================================');

  return artifacts;
}

// ============================================================================
// SOURCE IMAGE DECODE STATS
// ============================================================================

/**
 * Source image decode stats - proves image was decoded to real pixels
 */
export interface SourceDecodeStats {
  width: number;
  height: number;
  byteLength: number;
  pixelCount: number;
  channels: {
    R: { min: number; max: number; mean: number; std: number };
    G: { min: number; max: number; mean: number; std: number };
    B: { min: number; max: number; mean: number; std: number };
  };
  globalMin: number;
  globalMax: number;
  path: string;
}

/**
 * Write source_decode_stats.json - proves image decode returned real pixels
 */
export async function writeSourceDecodeStats(
  sessionId: string,
  stats: SourceDecodeStats
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('source_decode_stats.json')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const statsPath = `${sessionDir}/source_decode_stats.json`;

  await RNFS.mkdir(sessionDir);

  // Log stats
  console.log('========================================');
  console.log('[DebugArtifacts] SOURCE DECODE STATS:');
  console.log(`[DebugArtifacts]   Size: ${stats.width}x${stats.height}`);
  console.log(`[DebugArtifacts]   Bytes: ${stats.byteLength}`);
  console.log(`[DebugArtifacts]   Global range: [${stats.globalMin}, ${stats.globalMax}]`);
  console.log(`[DebugArtifacts]   R: min=${stats.channels.R.min}, max=${stats.channels.R.max}, mean=${stats.channels.R.mean.toFixed(1)}`);
  console.log(`[DebugArtifacts]   G: min=${stats.channels.G.min}, max=${stats.channels.G.max}, mean=${stats.channels.G.mean.toFixed(1)}`);
  console.log(`[DebugArtifacts]   B: min=${stats.channels.B.min}, max=${stats.channels.B.max}, mean=${stats.channels.B.mean.toFixed(1)}`);

  // Check if decode produced real pixels
  if (stats.globalMax === 0) {
    console.log('[DebugArtifacts]   ⚠️  DECODE FAILED: globalMax=0, image is all black');
  } else if (stats.byteLength === 0) {
    console.log('[DebugArtifacts]   ⚠️  DECODE FAILED: byteLength=0');
  } else {
    console.log('[DebugArtifacts]   ✓ Decode OK: real pixels found');
  }
  console.log('========================================');

  return writeJsonAtomic(statsPath, stats, sessionDir);
}

/**
 * Write letterbox_640_preview.jpg - the 640x640 image BEFORE float normalization
 */
export async function writeLetterbox640Preview(
  sessionId: string,
  jpegBase64: string
): Promise<WriteResult> {
  const sessionDir = getSessionDir(sessionId);
  const previewPath = `${sessionDir}/letterbox_640_preview.jpg`;

  await RNFS.mkdir(sessionDir);

  try {
    await RNFS.writeFile(previewPath, jpegBase64, 'base64');
    const stats = await RNFS.stat(previewPath);
    const size = typeof stats.size === 'string' ? parseInt(stats.size, 10) : stats.size;

    console.log(`[DebugArtifacts] Wrote letterbox_640_preview.jpg: ${size} bytes`);

    return { path: previewPath, success: true, bytes: size };
  } catch (error: any) {
    console.error(`[DebugArtifacts] Failed to write letterbox_640_preview.jpg: ${error.message}`);
    return { path: previewPath, success: false, bytes: 0, error: error.message };
  }
}

// ============================================================================
// INPUT TENSOR VERIFICATION ARTIFACTS
// ============================================================================

/**
 * Per-channel stats for input tensor verification
 */
export interface InputChannelStats {
  channel: number;
  channelName: string;  // 'R', 'G', 'B'
  min: number;
  max: number;
  mean: number;
  std: number;
  p1: number;   // 1st percentile
  p50: number;  // median
  p99: number;  // 99th percentile
  nanCount: number;
  infCount: number;
}

/**
 * Input tensor stats for verification
 */
export interface InputTensorStats {
  dtype: string;
  shape: number[];
  tensorFormat: string;  // 'NHWC' or 'NCHW'
  totalElements: number;
  globalMin: number;
  globalMax: number;
  globalMean: number;
  globalStd: number;
  globalP1: number;   // 1st percentile
  globalP50: number;  // median
  globalP99: number;  // 99th percentile
  channels: InputChannelStats[];
  normalizationRange: [number, number];  // expected [0, 1]
  paddingFillValue: number;   // normalized padding value (e.g., 114/255 ≈ 0.447)
  channelOrder: 'RGB' | 'BGR';
  normalizationMethod: string;
  warnings: string[];
}

/**
 * Letterbox metadata for debugging preprocessing
 */
export interface LetterboxMeta {
  inputWidth: number;
  inputHeight: number;
  modelSize: number;
  scale: number;
  padX: number;
  padY: number;
  paddingAxis: 'horizontal' | 'vertical' | 'none';
  paddingFillValue: number;  // typically 114 (gray) or 0 (black) pre-normalization
  channelOrder: 'RGB' | 'BGR';
  normalizationMethod: string;  // 'divide_255'
}

/**
 * Compute percentile from sorted array
 */
function computePercentileFromSorted(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sortedArr.length - 1));
  return sortedArr[Math.min(idx, sortedArr.length - 1)];
}

/**
 * Compute input tensor stats from Float32Array with percentiles
 * For NHWC format: [1, H, W, C] where C=3 (RGB)
 */
export function computeInputTensorStats(
  inputTensor: Float32Array,
  shape: number[],
  paddingFillValue: number = 114 / 255,  // Default gray padding normalized
  channelOrder: 'RGB' | 'BGR' = 'RGB'
): InputTensorStats {
  const isNHWC = shape.length === 4 && shape[3] === 3;  // [1, H, W, C]
  const isNCHW = shape.length === 4 && shape[1] === 3;  // [1, C, H, W]

  const tensorFormat = isNHWC ? 'NHWC' : (isNCHW ? 'NCHW' : 'unknown');
  const totalElements = inputTensor.length;
  const warnings: string[] = [];

  // Collect all valid values for global stats
  const allValues: number[] = [];
  let nanCount = 0;
  let infCount = 0;

  for (let i = 0; i < totalElements; i++) {
    const val = inputTensor[i];
    if (isNaN(val)) { nanCount++; continue; }
    if (!isFinite(val)) { infCount++; continue; }
    allValues.push(val);
  }

  // Sort for global percentiles
  allValues.sort((a, b) => a - b);

  const globalMin = allValues.length > 0 ? allValues[0] : 0;
  const globalMax = allValues.length > 0 ? allValues[allValues.length - 1] : 0;
  const globalSum = allValues.reduce((s, v) => s + v, 0);
  const globalMean = allValues.length > 0 ? globalSum / allValues.length : 0;

  // Compute global std
  let globalSqDiffSum = 0;
  for (const v of allValues) {
    globalSqDiffSum += (v - globalMean) ** 2;
  }
  const globalStd = allValues.length > 1 ? Math.sqrt(globalSqDiffSum / (allValues.length - 1)) : 0;

  // Global percentiles
  const globalP1 = computePercentileFromSorted(allValues, 1);
  const globalP50 = computePercentileFromSorted(allValues, 50);
  const globalP99 = computePercentileFromSorted(allValues, 99);

  // Check normalization range
  if (globalMin < -0.01) {
    warnings.push(`globalMin=${globalMin.toFixed(4)} < 0 — unexpected for [0,1] normalization`);
  }
  if (globalMax > 1.01) {
    warnings.push(`globalMax=${globalMax.toFixed(4)} > 1 — unexpected for [0,1] normalization`);
  }
  if (nanCount > 0) {
    warnings.push(`Found ${nanCount} NaN values in input tensor`);
  }
  if (infCount > 0) {
    warnings.push(`Found ${infCount} Inf values in input tensor`);
  }

  // Per-channel stats with percentiles
  const channels: InputChannelStats[] = [];
  const channelNames = channelOrder === 'RGB' ? ['R', 'G', 'B'] : ['B', 'G', 'R'];

  const computeChannelStats = (values: number[], c: number, chNanCount: number, chInfCount: number): InputChannelStats => {
    // Sort for percentiles
    values.sort((a, b) => a - b);

    const chMin = values.length > 0 ? values[0] : 0;
    const chMax = values.length > 0 ? values[values.length - 1] : 0;
    const chSum = values.reduce((s, v) => s + v, 0);
    const chMean = values.length > 0 ? chSum / values.length : 0;

    // Compute std
    let sqDiffSum = 0;
    for (const v of values) {
      sqDiffSum += (v - chMean) ** 2;
    }
    const chStd = values.length > 1 ? Math.sqrt(sqDiffSum / (values.length - 1)) : 0;

    // Percentiles
    const p1 = computePercentileFromSorted(values, 1);
    const p50 = computePercentileFromSorted(values, 50);
    const p99 = computePercentileFromSorted(values, 99);

    return {
      channel: c,
      channelName: channelNames[c] || `ch${c}`,
      min: chMin,
      max: chMax,
      mean: chMean,
      std: chStd,
      p1,
      p50,
      p99,
      nanCount: chNanCount,
      infCount: chInfCount,
    };
  };

  if (isNHWC && shape.length === 4) {
    const [_, H, W, C] = shape;
    const pixelCount = H * W;

    for (let c = 0; c < C; c++) {
      let chNanCount = 0, chInfCount = 0;
      const values: number[] = [];

      for (let i = 0; i < pixelCount; i++) {
        const val = inputTensor[i * C + c];
        if (isNaN(val)) { chNanCount++; continue; }
        if (!isFinite(val)) { chInfCount++; continue; }
        values.push(val);
      }

      channels.push(computeChannelStats(values, c, chNanCount, chInfCount));
    }
  } else if (isNCHW && shape.length === 4) {
    const [_, C, H, W] = shape;
    const pixelCount = H * W;

    for (let c = 0; c < C; c++) {
      let chNanCount = 0, chInfCount = 0;
      const values: number[] = [];
      const channelOffset = c * pixelCount;

      for (let i = 0; i < pixelCount; i++) {
        const val = inputTensor[channelOffset + i];
        if (isNaN(val)) { chNanCount++; continue; }
        if (!isFinite(val)) { chInfCount++; continue; }
        values.push(val);
      }

      channels.push(computeChannelStats(values, c, chNanCount, chInfCount));
    }
  }

  return {
    dtype: 'float32',
    shape,
    tensorFormat,
    totalElements,
    globalMin,
    globalMax,
    globalMean,
    globalStd,
    globalP1,
    globalP50,
    globalP99,
    channels,
    normalizationRange: [0, 1],
    paddingFillValue,
    channelOrder,
    normalizationMethod: 'divide_255',
    warnings,
  };
}

/**
 * Write input_tensor_stats.json - input tensor verification (atomic)
 */
export async function writeInputTensorStats(
  sessionId: string,
  stats: InputTensorStats
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('input_tensor_stats.json')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const statsPath = `${sessionDir}/input_tensor_stats.json`;

  await RNFS.mkdir(sessionDir);

  // Log warnings
  if (stats.warnings.length > 0) {
    console.log('========================================');
    console.log('[DebugArtifacts] INPUT TENSOR WARNINGS:');
    for (const w of stats.warnings) {
      console.log(`[DebugArtifacts]   ⚠️  ${w}`);
    }
    console.log('========================================');
  } else {
    console.log(`[DebugArtifacts] Input tensor stats OK: shape=[${stats.shape.join(',')}], format=${stats.tensorFormat}, range=[${stats.globalMin.toFixed(4)}, ${stats.globalMax.toFixed(4)}]`);
  }

  return writeJsonAtomic(statsPath, stats, sessionDir);
}

/**
 * Write letterbox_meta.json - letterbox preprocessing info (atomic)
 */
export async function writeLetterboxMeta(
  sessionId: string,
  meta: LetterboxMeta
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('letterbox_meta.json')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const metaPath = `${sessionDir}/letterbox_meta.json`;

  await RNFS.mkdir(sessionDir);

  console.log(`[DebugArtifacts] Letterbox: ${meta.inputWidth}x${meta.inputHeight} → ${meta.modelSize}x${meta.modelSize}, scale=${meta.scale.toFixed(4)}, pad=(${meta.padX},${meta.padY}), axis=${meta.paddingAxis}`);

  return writeJsonAtomic(metaPath, meta, sessionDir);
}

/**
 * Build letterbox metadata from LetterboxParams
 */
export function buildLetterboxMeta(
  letterbox: LetterboxParams,
  paddingFillValue: number = 114  // Gray fill before normalization (114/255 ≈ 0.447)
): LetterboxMeta {
  const paddingAxis = letterbox.padX > 0 ? 'horizontal' :
                      letterbox.padY > 0 ? 'vertical' : 'none';

  return {
    inputWidth: letterbox.srcWidth,
    inputHeight: letterbox.srcHeight,
    modelSize: letterbox.dstWidth,  // Should be 640
    scale: letterbox.scale,
    padX: letterbox.padX,
    padY: letterbox.padY,
    paddingAxis,
    paddingFillValue,
    channelOrder: 'RGB',
    normalizationMethod: 'divide_255',
  };
}

/**
 * Convert float32 tensor [0,1] to uint8 array [0,255]
 * For NHWC format: [1, H, W, C] → H*W*C bytes
 */
export function tensorToRGBBytes(
  inputTensor: Float32Array,
  shape: number[]
): { bytes: Uint8Array; width: number; height: number } | null {
  const isNHWC = shape.length === 4 && shape[3] === 3;
  const isNCHW = shape.length === 4 && shape[1] === 3;

  if (!isNHWC && !isNCHW) {
    console.error(`[DebugArtifacts] tensorToRGBBytes: unsupported shape [${shape.join(', ')}]`);
    return null;
  }

  let width: number, height: number;
  const bytes: Uint8Array = new Uint8Array(inputTensor.length);

  if (isNHWC) {
    const [_, H, W, C] = shape;
    width = W;
    height = H;
    const pixelCount = H * W;

    for (let i = 0; i < pixelCount; i++) {
      for (let c = 0; c < C; c++) {
        const floatVal = inputTensor[i * C + c];
        // Clamp and convert to uint8
        const uint8Val = Math.max(0, Math.min(255, Math.round(floatVal * 255)));
        bytes[i * C + c] = uint8Val;
      }
    }
  } else {
    // NCHW format
    const [_, C, H, W] = shape;
    width = W;
    height = H;
    const pixelCount = H * W;

    // Convert NCHW to interleaved RGB
    for (let i = 0; i < pixelCount; i++) {
      for (let c = 0; c < C; c++) {
        const floatVal = inputTensor[c * pixelCount + i];
        const uint8Val = Math.max(0, Math.min(255, Math.round(floatVal * 255)));
        bytes[i * C + c] = uint8Val;
      }
    }
  }

  return { bytes, width, height };
}

/**
 * Convert string to Uint8Array (ASCII only)
 */
function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i);
  }
  return bytes;
}

/**
 * Create PPM image data from RGB bytes
 * PPM format: "P6\nwidth height\n255\n" + RGB bytes
 */
function createPPMData(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const header = `P6\n${width} ${height}\n255\n`;
  const headerBytes = stringToBytes(header);
  const result = new Uint8Array(headerBytes.length + bytes.length);
  result.set(headerBytes, 0);
  result.set(bytes, headerBytes.length);
  return result;
}

/**
 * Write input_tensor_preview.jpg - the exact float tensor converted back to uint8 RGB
 * This proves the tensor buffer passed to TFLite contains real image data.
 *
 * Uses native ImagePreprocessor.savePreviewImage when available for JPEG output,
 * falls back to PPM format otherwise.
 */
export async function writeInputTensorPreview(
  sessionId: string,
  inputTensor: Float32Array,
  shape: number[]
): Promise<{ path: string; success: boolean; error?: string }> {
  const sessionDir = getSessionDir(sessionId);
  const jpegPath = `${sessionDir}/input_tensor_preview.jpg`;
  const ppmPath = `${sessionDir}/input_tensor_preview.ppm`;

  await RNFS.mkdir(sessionDir);

  try {
    const result = tensorToRGBBytes(inputTensor, shape);
    if (!result) {
      return {
        path: jpegPath,
        success: false,
        error: 'Failed to convert tensor to RGB bytes',
      };
    }

    const { bytes, width, height } = result;

    // Try to use native module for JPEG output
    // Import NativeModules dynamically to avoid circular deps
    const { NativeModules } = require('react-native');
    const { ImagePreprocessor } = NativeModules;

    if (ImagePreprocessor && ImagePreprocessor.savePreviewImage) {
      // Convert RGB to RGBA (native expects RGBA)
      const rgbaBytes = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgbaBytes[i * 4] = bytes[i * 3];       // R
        rgbaBytes[i * 4 + 1] = bytes[i * 3 + 1]; // G
        rgbaBytes[i * 4 + 2] = bytes[i * 3 + 2]; // B
        rgbaBytes[i * 4 + 3] = 255;            // A
      }

      const rgbaBase64 = uint8ArrayToBase64(rgbaBytes);
      await ImagePreprocessor.savePreviewImage(rgbaBase64, width, height, jpegPath);

      console.log(`[DebugArtifacts] Wrote input_tensor_preview.jpg: ${width}x${height} (via native)`);
      return { path: jpegPath, success: true };
    }

    // Fallback: Write as PPM
    const ppmData = createPPMData(bytes, width, height);
    const base64Data = uint8ArrayToBase64(ppmData);
    await RNFS.writeFile(ppmPath, base64Data, 'base64');

    console.log(`[DebugArtifacts] Wrote input_tensor_preview.ppm: ${width}x${height}, ${ppmData.length} bytes (fallback)`);

    return {
      path: ppmPath,
      success: true,
    };
  } catch (error: any) {
    console.error(`[DebugArtifacts] Failed to write input tensor preview: ${error.message}`);
    return {
      path: jpegPath,
      success: false,
      error: error.message,
    };
  }
}

// ============================================================================
// SCORE SANITY ARTIFACTS
// ============================================================================

/**
 * Score sanity statistics for validating model output
 */
export interface ScoreSanityStats {
  // Raw score stats (before sigmoid)
  rawScore: {
    min: number;
    p1: number;
    p5: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
    std: number;
  };
  // Score probability stats (after sigmoid)
  scoreProb: {
    min: number;
    p1: number;
    p5: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
    std: number;
  };
  // Counts above threshold
  countsAboveThreshold: {
    '0.01': number;
    '0.05': number;
    '0.10': number;
    '0.30': number;
    '0.50': number;
    '0.70': number;
    '0.90': number;
  };
  totalAnchors: number;
  // Whether sigmoid was applied (must match decode path)
  sigmoidApplied: boolean;
  // Validity check
  valid: boolean;
  failureReason?: string;
  // Hard gate conditions
  hardGateConditions: {
    p5ScoreProbAbove03: boolean;  // FAIL if p5(scoreProb) > 0.3
    stdScoreProbBelow005: boolean; // FAIL if std(scoreProb) < 0.05
  };
}

/**
 * Compute percentile from sorted array
 */
function computePercentileFromSortedArray(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sortedArr.length - 1));
  return sortedArr[Math.min(idx, sortedArr.length - 1)];
}

/**
 * Sigmoid function for score conversion
 */
function sigmoidValue(x: number): number {
  if (x > 20) return 1.0;
  if (x < -20) return 0.0;
  return 1 / (1 + Math.exp(-x));
}

/**
 * Compute score sanity statistics from raw model output
 * @param rawOutput - Raw model output array [1, 6, 8400] flattened
 * @param shape - Output tensor shape
 * @param scoreChannel - Which channel contains raw scores (default 4 for Mode A)
 * @param applySigmoid - Whether to apply sigmoid to convert logits to probabilities (must match decode path)
 */
export function computeScoreSanityStats(
  rawOutput: number[],
  shape: number[],
  scoreChannel: number = 4,
  applySigmoid: boolean = false
): ScoreSanityStats {
  if (shape.length !== 3 || shape[1] !== 6) {
    return {
      rawScore: { min: 0, p1: 0, p5: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0, std: 0 },
      scoreProb: { min: 0, p1: 0, p5: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0, std: 0 },
      countsAboveThreshold: { '0.01': 0, '0.05': 0, '0.10': 0, '0.30': 0, '0.50': 0, '0.70': 0, '0.90': 0 },
      totalAnchors: 0,
      sigmoidApplied: applySigmoid,
      valid: false,
      failureReason: 'Invalid output shape',
      hardGateConditions: { p5ScoreProbAbove03: false, stdScoreProbBelow005: true },
    };
  }

  const numAnchors = shape[2];
  const rawScores: number[] = [];
  const scoreProbs: number[] = [];

  // Extract raw scores and compute probabilities
  // Use applySigmoid flag to match decode path behavior
  for (let i = 0; i < numAnchors; i++) {
    const rawScore = rawOutput[scoreChannel * numAnchors + i];
    if (!isNaN(rawScore) && isFinite(rawScore)) {
      rawScores.push(rawScore);
      // Only apply sigmoid if the decode path uses sigmoid (logit -> probability)
      // If applySigmoid=false, rawScore IS already a probability
      scoreProbs.push(applySigmoid ? sigmoidValue(rawScore) : rawScore);
    }
  }

  // Sort for percentiles
  const sortedRaw = [...rawScores].sort((a, b) => a - b);
  const sortedProb = [...scoreProbs].sort((a, b) => a - b);

  // Compute raw score stats
  const rawMin = sortedRaw.length > 0 ? sortedRaw[0] : 0;
  const rawMax = sortedRaw.length > 0 ? sortedRaw[sortedRaw.length - 1] : 0;
  const rawSum = rawScores.reduce((a, b) => a + b, 0);
  const rawMean = rawScores.length > 0 ? rawSum / rawScores.length : 0;
  let rawSqDiffSum = 0;
  for (const v of rawScores) rawSqDiffSum += (v - rawMean) ** 2;
  const rawStd = rawScores.length > 1 ? Math.sqrt(rawSqDiffSum / (rawScores.length - 1)) : 0;

  // Compute prob stats
  const probMin = sortedProb.length > 0 ? sortedProb[0] : 0;
  const probMax = sortedProb.length > 0 ? sortedProb[sortedProb.length - 1] : 0;
  const probSum = scoreProbs.reduce((a, b) => a + b, 0);
  const probMean = scoreProbs.length > 0 ? probSum / scoreProbs.length : 0;
  let probSqDiffSum = 0;
  for (const v of scoreProbs) probSqDiffSum += (v - probMean) ** 2;
  const probStd = scoreProbs.length > 1 ? Math.sqrt(probSqDiffSum / (scoreProbs.length - 1)) : 0;

  // Percentiles
  const rawP1 = computePercentileFromSortedArray(sortedRaw, 1);
  const rawP5 = computePercentileFromSortedArray(sortedRaw, 5);
  const rawP50 = computePercentileFromSortedArray(sortedRaw, 50);
  const rawP95 = computePercentileFromSortedArray(sortedRaw, 95);
  const rawP99 = computePercentileFromSortedArray(sortedRaw, 99);

  const probP1 = computePercentileFromSortedArray(sortedProb, 1);
  const probP5 = computePercentileFromSortedArray(sortedProb, 5);
  const probP50 = computePercentileFromSortedArray(sortedProb, 50);
  const probP95 = computePercentileFromSortedArray(sortedProb, 95);
  const probP99 = computePercentileFromSortedArray(sortedProb, 99);

  // Counts above thresholds
  const thresholds = [0.01, 0.05, 0.10, 0.30, 0.50, 0.70, 0.90];
  const counts: Record<string, number> = {};
  for (const t of thresholds) {
    counts[t.toFixed(2)] = scoreProbs.filter(p => p >= t).length;
  }

  // Hard gate conditions
  const p5ScoreProbAbove03 = probP5 > 0.3;
  const stdScoreProbBelow005 = probStd < 0.05;

  // Determine validity
  let valid = true;
  let failureReason: string | undefined;

  if (p5ScoreProbAbove03) {
    valid = false;
    failureReason = `SCORE_CHANNEL_INVALID_OR_MODEL_COLLAPSED: p5(scoreProb)=${probP5.toFixed(4)} > 0.3`;
  } else if (stdScoreProbBelow005 && rawScores.length > 0) {
    valid = false;
    failureReason = `SCORE_CHANNEL_INVALID_OR_MODEL_COLLAPSED: std(scoreProb)=${probStd.toFixed(4)} < 0.05`;
  }

  return {
    rawScore: {
      min: rawMin,
      p1: rawP1,
      p5: rawP5,
      p50: rawP50,
      p95: rawP95,
      p99: rawP99,
      max: rawMax,
      mean: rawMean,
      std: rawStd,
    },
    scoreProb: {
      min: probMin,
      p1: probP1,
      p5: probP5,
      p50: probP50,
      p95: probP95,
      p99: probP99,
      max: probMax,
      mean: probMean,
      std: probStd,
    },
    countsAboveThreshold: counts as ScoreSanityStats['countsAboveThreshold'],
    totalAnchors: numAnchors,
    sigmoidApplied: applySigmoid,
    valid,
    failureReason,
    hardGateConditions: {
      p5ScoreProbAbove03,
      stdScoreProbBelow005,
    },
  };
}

/**
 * Write score_sanity.json - validates score channel data
 */
export async function writeScoreSanity(
  sessionId: string,
  stats: ScoreSanityStats
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('score_sanity.json')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const sanityPath = `${sessionDir}/score_sanity.json`;

  await RNFS.mkdir(sessionDir);

  // Log score sanity results
  console.log('========================================');
  console.log('[DebugArtifacts] SCORE SANITY CHECK:');
  console.log(`[DebugArtifacts]   Total anchors: ${stats.totalAnchors}`);
  console.log(`[DebugArtifacts]   Sigmoid applied: ${stats.sigmoidApplied}`);
  console.log(`[DebugArtifacts]   rawScore: min=${stats.rawScore.min.toFixed(4)}, p50=${stats.rawScore.p50.toFixed(4)}, max=${stats.rawScore.max.toFixed(4)}, std=${stats.rawScore.std.toFixed(4)}`);
  console.log(`[DebugArtifacts]   scoreProb: min=${stats.scoreProb.min.toFixed(4)}, p5=${stats.scoreProb.p5.toFixed(4)}, p50=${stats.scoreProb.p50.toFixed(4)}, max=${stats.scoreProb.max.toFixed(4)}, std=${stats.scoreProb.std.toFixed(4)}`);
  console.log(`[DebugArtifacts]   Counts: >0.01=${stats.countsAboveThreshold['0.01']}, >0.30=${stats.countsAboveThreshold['0.30']}, >0.50=${stats.countsAboveThreshold['0.50']}, >0.90=${stats.countsAboveThreshold['0.90']}`);
  if (stats.valid) {
    console.log('[DebugArtifacts]   ✓ Score channel VALID');
  } else {
    console.log(`[DebugArtifacts]   ⚠️  ${stats.failureReason}`);
  }
  console.log('========================================');

  return writeJsonAtomic(sanityPath, stats, sessionDir);
}

// ============================================================================
// NMS WITNESS ARTIFACTS
// ============================================================================

/**
 * OBB detection for NMS witness (model space)
 */
export interface NMSWitnessDetection {
  index: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  score: number;
  aabb: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Overlapping pair information for NMS witness
 */
export interface NMSOverlappingPair {
  indexA: number;
  indexB: number;
  scoreA: number;
  scoreB: number;
  iou: number;
  detA: NMSWitnessDetection;
  detB: NMSWitnessDetection;
  // Which was suppressed (B has lower score, so B should be suppressed if IoU > threshold)
  bShouldBeSuppressed: boolean;
}

/**
 * NMS witness data
 */
export interface NMSWitnessData {
  // Top 50 detections by score (before NMS)
  topByScore: NMSWitnessDetection[];
  // Max IoU for each detection (against higher-scoring detections)
  maxIoUPerBox: Array<{ index: number; maxIoU: number; maxIoUPairIndex: number }>;
  // Top 10 overlapping pairs (highest IoU pairs)
  topOverlappingPairs: NMSOverlappingPair[];
  // Summary
  summary: {
    totalBeforeNMS: number;
    totalAfterNMS: number;
    numSuppressed: number;
    numPairsWithIoUAbove05: number;
    numPairsWithIoUAbove03: number;
    nmsIouThreshold: number;
    nmsMode: string;
  };
}

/**
 * Get 4 corners of an OBB
 */
function getOBBCornersForWitness(
  cx: number, cy: number, width: number, height: number, angle: number
): Array<{ x: number; y: number }> {
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
 * Compute AABB from OBB corners
 */
function computeAABBFromOBB(
  cx: number, cy: number, width: number, height: number, angle: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  const corners = getOBBCornersForWitness(cx, cy, width, height, angle);
  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/**
 * Compute AABB IoU
 */
function computeAABBIoUForWitness(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number }
): number {
  const interMinX = Math.max(a.minX, b.minX);
  const interMaxX = Math.min(a.maxX, b.maxX);
  const interMinY = Math.max(a.minY, b.minY);
  const interMaxY = Math.min(a.maxY, b.maxY);

  if (interMaxX <= interMinX || interMaxY <= interMinY) {
    return 0;
  }

  const interArea = (interMaxX - interMinX) * (interMaxY - interMinY);
  const aArea = (a.maxX - a.minX) * (a.maxY - a.minY);
  const bArea = (b.maxX - b.minX) * (b.maxY - b.minY);
  const unionArea = aArea + bArea - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Build NMS witness data from detections before and after NMS
 */
export function buildNMSWitnessData(
  detectionsBeforeNMS: Array<{
    cx: number;
    cy: number;
    width: number;
    height: number;
    angle: number;
    score: number;
  }>,
  numAfterNMS: number,
  nmsIouThreshold: number,
  nmsMode: string
): NMSWitnessData {
  // Sort by score descending
  const sorted = [...detectionsBeforeNMS]
    .map((d, i) => ({ ...d, originalIndex: i }))
    .sort((a, b) => b.score - a.score);

  // Take top 50
  const top50 = sorted.slice(0, 50);

  // Build witness detections with AABB
  const topByScore: NMSWitnessDetection[] = top50.map((d, i) => ({
    index: i,
    cx: d.cx,
    cy: d.cy,
    width: d.width,
    height: d.height,
    angle: d.angle,
    score: d.score,
    aabb: computeAABBFromOBB(d.cx, d.cy, d.width, d.height, d.angle),
  }));

  // Compute max IoU for each detection (against higher-scoring ones)
  const maxIoUPerBox: Array<{ index: number; maxIoU: number; maxIoUPairIndex: number }> = [];
  for (let i = 0; i < topByScore.length; i++) {
    let maxIoU = 0;
    let maxIoUPairIndex = -1;
    for (let j = 0; j < i; j++) {  // Only compare with higher-scoring (j < i)
      const iou = computeAABBIoUForWitness(topByScore[i].aabb, topByScore[j].aabb);
      if (iou > maxIoU) {
        maxIoU = iou;
        maxIoUPairIndex = j;
      }
    }
    maxIoUPerBox.push({ index: i, maxIoU, maxIoUPairIndex });
  }

  // Find all overlapping pairs and sort by IoU
  const allPairs: NMSOverlappingPair[] = [];
  for (let i = 0; i < topByScore.length; i++) {
    for (let j = i + 1; j < topByScore.length; j++) {
      const iou = computeAABBIoUForWitness(topByScore[i].aabb, topByScore[j].aabb);
      if (iou > 0.01) {  // Only include pairs with some overlap
        allPairs.push({
          indexA: i,
          indexB: j,
          scoreA: topByScore[i].score,
          scoreB: topByScore[j].score,
          iou,
          detA: topByScore[i],
          detB: topByScore[j],
          bShouldBeSuppressed: iou > nmsIouThreshold,
        });
      }
    }
  }

  // Sort by IoU descending and take top 10
  allPairs.sort((a, b) => b.iou - a.iou);
  const topOverlappingPairs = allPairs.slice(0, 10);

  // Count pairs above thresholds
  const numPairsWithIoUAbove05 = allPairs.filter(p => p.iou > 0.5).length;
  const numPairsWithIoUAbove03 = allPairs.filter(p => p.iou > 0.3).length;

  return {
    topByScore,
    maxIoUPerBox,
    topOverlappingPairs,
    summary: {
      totalBeforeNMS: detectionsBeforeNMS.length,
      totalAfterNMS: numAfterNMS,
      numSuppressed: detectionsBeforeNMS.length - numAfterNMS,
      numPairsWithIoUAbove05,
      numPairsWithIoUAbove03,
      nmsIouThreshold,
      nmsMode,
    },
  };
}

/**
 * Write nms_witness.json - proves NMS is working correctly
 */
export async function writeNMSWitness(
  sessionId: string,
  witnessData: NMSWitnessData
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('nms_witness.json')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const witnessPath = `${sessionDir}/nms_witness.json`;

  await RNFS.mkdir(sessionDir);

  // Log NMS witness summary
  console.log('========================================');
  console.log('[DebugArtifacts] NMS WITNESS:');
  console.log(`[DebugArtifacts]   Before NMS: ${witnessData.summary.totalBeforeNMS}`);
  console.log(`[DebugArtifacts]   After NMS: ${witnessData.summary.totalAfterNMS}`);
  console.log(`[DebugArtifacts]   Suppressed: ${witnessData.summary.numSuppressed}`);
  console.log(`[DebugArtifacts]   Pairs with IoU > 0.5: ${witnessData.summary.numPairsWithIoUAbove05}`);
  console.log(`[DebugArtifacts]   Pairs with IoU > 0.3: ${witnessData.summary.numPairsWithIoUAbove03}`);
  console.log(`[DebugArtifacts]   NMS threshold: ${witnessData.summary.nmsIouThreshold}`);
  if (witnessData.topOverlappingPairs.length > 0) {
    console.log(`[DebugArtifacts]   Top overlapping pair: IoU=${witnessData.topOverlappingPairs[0].iou.toFixed(4)}`);
  }
  console.log('========================================');

  return writeJsonAtomic(witnessPath, witnessData, sessionDir);
}

// ============================================================================
// MODEL-SPACE OVERLAY ARTIFACTS (AABB)
// ============================================================================

/**
 * OBB detection in model space for overlay drawing
 */
export interface OBBOverlayDetection {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  score: number;
}

/**
 * AABB box format for native overlay drawing
 */
export interface AABBBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

/**
 * Convert OBB detection to AABB by computing bounding box of rotated corners
 */
function obbToAABB(det: OBBOverlayDetection): AABBBox {
  const { cx, cy, width, height, angle, score } = det;
  const hw = width / 2;
  const hh = height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Compute 4 corners
  const corners = [
    { x: cx + (-hw) * cos - (-hh) * sin, y: cy + (-hw) * sin + (-hh) * cos },
    { x: cx + (hw) * cos - (-hh) * sin, y: cy + (hw) * sin + (-hh) * cos },
    { x: cx + (hw) * cos - (hh) * sin, y: cy + (hw) * sin + (hh) * cos },
    { x: cx + (-hw) * cos - (hh) * sin, y: cy + (-hw) * sin + (hh) * cos },
  ];

  // Find AABB
  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);

  return {
    x1: Math.min(...xs),
    y1: Math.min(...ys),
    x2: Math.max(...xs),
    y2: Math.max(...ys),
    score,
  };
}

/**
 * Write model-space AABB overlay image using native module.
 * Draws axis-aligned bounding boxes directly on the 640x640 letterbox preview.
 *
 * @param sessionId - Session ID
 * @param sourceImagePath - Path to source image (letterbox_640_preview.jpg)
 * @param detections - OBB detections in model space (640x640) - will be converted to AABB
 * @param outputFilename - Output filename (e.g., 'overlay_modelspace_raw.jpg')
 * @param topK - Maximum number of boxes to draw (default 200)
 */
export async function writeModelSpaceOverlay(
  sessionId: string,
  sourceImagePath: string,
  detections: OBBOverlayDetection[],
  outputFilename: string,
  topK: number = 200
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact(outputFilename)) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const outputPath = `${sessionDir}/${outputFilename}`;

  await RNFS.mkdir(sessionDir);

  // Sort by score descending and take top K
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const topDetections = sorted.slice(0, topK);

  // Check if native module is available
  const { NativeModules } = require('react-native');
  const { ImagePreprocessor } = NativeModules;

  if (!ImagePreprocessor || !ImagePreprocessor.drawAABBOverlay) {
    console.error(`[DebugArtifacts] Native drawAABBOverlay not available, cannot write ${outputFilename}`);
    return {
      success: false,
      path: outputPath,
      bytes: 0,
      error: 'Native drawAABBOverlay not available',
    };
  }

  try {
    // Convert OBB detections to AABB boxes
    const aabbBoxes = topDetections.map(d => obbToAABB(d));

    console.log(`[DebugArtifacts] Drawing ${aabbBoxes.length} AABB boxes for ${outputFilename}`);

    const result = await ImagePreprocessor.drawAABBOverlay(
      sourceImagePath,
      aabbBoxes,
      outputPath
    );

    console.log(`[DebugArtifacts] Wrote ${outputFilename}: ${aabbBoxes.length} boxes, ${result.size} bytes`);

    return {
      success: true,
      path: result.path,
      bytes: result.size,
    };
  } catch (error: any) {
    console.error(`[DebugArtifacts] Failed to write ${outputFilename}: ${error.message}`);
    return {
      success: false,
      path: outputPath,
      bytes: 0,
      error: error.message,
    };
  }
}

/**
 * Write both model-space overlay artifacts:
 * - overlay_modelspace_raw.jpg - detections after decode, before NMS (topK=200)
 * - overlay_modelspace_nms.jpg - detections after NMS (topK=200)
 *
 * @param sessionId - Session ID
 * @param detectionsBeforeNMS - Detections in model space before NMS
 * @param detectionsAfterNMS - Detections in model space after NMS
 */
export async function writeModelSpaceOverlays(
  sessionId: string,
  detectionsBeforeNMS: OBBOverlayDetection[],
  detectionsAfterNMS: OBBOverlayDetection[]
): Promise<{ rawOverlay: WriteResult; nmsOverlay: WriteResult }> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('overlay_modelspace')) {
    return {
      rawOverlay: SKIPPED_WRITE_RESULT,
      nmsOverlay: SKIPPED_WRITE_RESULT,
    };
  }

  const sessionDir = getSessionDir(sessionId);
  const letterboxPreviewPath = `${sessionDir}/letterbox_640_preview.jpg`;

  // Check if letterbox preview exists
  const letterboxExists = await RNFS.exists(letterboxPreviewPath);
  if (!letterboxExists) {
    console.error('[DebugArtifacts] FATAL: letterbox_640_preview.jpg not found, cannot create overlays');
    return {
      rawOverlay: { success: false, path: '', bytes: 0, error: 'letterbox_640_preview.jpg not found' },
      nmsOverlay: { success: false, path: '', bytes: 0, error: 'letterbox_640_preview.jpg not found' },
    };
  }

  console.log('========================================');
  console.log('[DebugArtifacts] CREATING MODEL-SPACE OVERLAYS (AABB):');
  console.log(`[DebugArtifacts]   Source: ${letterboxPreviewPath}`);
  console.log(`[DebugArtifacts]   Detections before NMS: ${detectionsBeforeNMS.length}`);
  console.log(`[DebugArtifacts]   Detections after NMS: ${detectionsAfterNMS.length}`);

  // Write raw overlay (before NMS, topK=200)
  const rawOverlay = await writeModelSpaceOverlay(
    sessionId,
    letterboxPreviewPath,
    detectionsBeforeNMS,
    'overlay_modelspace_raw.jpg',
    200
  );

  // Write NMS overlay (after NMS, topK=200)
  const nmsOverlay = await writeModelSpaceOverlay(
    sessionId,
    letterboxPreviewPath,
    detectionsAfterNMS,
    'overlay_modelspace_nms.jpg',
    200
  );

  console.log(`[DebugArtifacts]   Raw overlay: ${rawOverlay.success ? '✓ ' + rawOverlay.bytes + ' bytes' : '✗ ' + rawOverlay.error}`);
  console.log(`[DebugArtifacts]   NMS overlay: ${nmsOverlay.success ? '✓ ' + nmsOverlay.bytes + ' bytes' : '✗ ' + nmsOverlay.error}`);
  console.log('========================================');

  return { rawOverlay, nmsOverlay };
}

// ============================================================================
// LETTERBOX GEOMETRY VALIDATION
// ============================================================================

/**
 * Native truth from ImagePreprocessor.preprocessForTFLite
 */
export interface NativeLetterboxTruth {
  decodedW: number;
  decodedH: number;
  modelSize: number;
  scale: number;
  newW: number;
  newH: number;
  padX: number;
  padY: number;
}

/**
 * Letterbox inconsistency artifact
 */
export interface LetterboxInconsistency {
  reason: string;
  nativeTruth: NativeLetterboxTruth;
  computed: {
    isLandscape: boolean;
    expectedPaddingAxis: 'X' | 'Y';
    actualPaddingAxis: 'X' | 'Y' | 'NONE';
  };
  fatal: true;
}

/**
 * Validate letterbox geometry consistency.
 * Returns null if valid, or inconsistency data if invalid.
 *
 * HARD INVARIANT:
 * - If padY > 0 (vertical padding), image must be landscape (decodedW > decodedH)
 * - If padX > 0 (horizontal padding), image must be portrait (decodedW < decodedH)
 *
 * Violation indicates the letterbox was computed incorrectly.
 */
export function validateLetterboxConsistency(
  nativeTruth: NativeLetterboxTruth
): LetterboxInconsistency | null {
  const { decodedW, decodedH, padX, padY } = nativeTruth;

  const isLandscape = decodedW > decodedH;
  const isPortrait = decodedW < decodedH;
  const isSquare = decodedW === decodedH;

  // Determine actual padding axis
  let actualPaddingAxis: 'X' | 'Y' | 'NONE' = 'NONE';
  if (padY > 0) actualPaddingAxis = 'Y';
  else if (padX > 0) actualPaddingAxis = 'X';

  // Determine expected padding axis
  // Landscape (W > H) → scale by H, pad X (left/right)
  // Portrait (W < H) → scale by W, pad Y (top/bottom)
  // Square → no padding needed
  let expectedPaddingAxis: 'X' | 'Y' = isLandscape ? 'X' : 'Y';

  // Check for inconsistency
  let reason: string | null = null;

  if (padY > 0 && isPortrait) {
    // FATAL: padY > 0 means vertical padding, but portrait images should have horizontal padding
    reason = `FATAL_LETTERBOX_INCONSISTENT: padY=${padY} > 0 but decodedW=${decodedW} < decodedH=${decodedH} (portrait). ` +
             `Portrait images should have padX > 0, not padY.`;
  } else if (padX > 0 && isLandscape) {
    // FATAL: padX > 0 means horizontal padding, but landscape images should have vertical padding
    reason = `FATAL_LETTERBOX_INCONSISTENT: padX=${padX} > 0 but decodedW=${decodedW} > decodedH=${decodedH} (landscape). ` +
             `Landscape images should have padY > 0, not padX.`;
  }

  if (reason) {
    return {
      reason,
      nativeTruth,
      computed: {
        isLandscape,
        expectedPaddingAxis,
        actualPaddingAxis,
      },
      fatal: true,
    };
  }

  return null;
}

/**
 * Write letterbox_inconsistent.json artifact when geometry validation fails
 */
export async function writeLetterboxInconsistent(
  sessionId: string,
  inconsistency: LetterboxInconsistency
): Promise<WriteResult> {
  const sessionDir = getSessionDir(sessionId);
  const path = `${sessionDir}/letterbox_inconsistent.json`;

  console.error('========================================');
  console.error('[DebugArtifacts] FATAL LETTERBOX INCONSISTENCY:');
  console.error(`[DebugArtifacts]   ${inconsistency.reason}`);
  console.error(`[DebugArtifacts]   Native truth: ${JSON.stringify(inconsistency.nativeTruth)}`);
  console.error('========================================');

  return writeJsonAtomic(path, inconsistency, sessionDir);
}

/**
 * Convert Uint8Array to base64 string
 * Uses manual encoding since btoa is not available in React Native
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  const len = bytes.length;

  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < len ? bytes[i + 1] : 0;
    const b3 = i + 2 < len ? bytes[i + 2] : 0;

    result += base64Chars[b1 >> 2];
    result += base64Chars[((b1 & 0x03) << 4) | (b2 >> 4)];
    result += i + 1 < len ? base64Chars[((b2 & 0x0f) << 2) | (b3 >> 6)] : '=';
    result += i + 2 < len ? base64Chars[b3 & 0x3f] : '=';
  }

  return result;
}

/**
 * Write all input tensor artifacts: stats JSON and preview image
 * GUARANTEED to write both even if tensor is all zeros
 */
export async function writeInputTensorArtifacts(
  sessionId: string,
  inputTensor: Float32Array,
  shape: number[],
  paddingFillValue: number = 114 / 255,
  channelOrder: 'RGB' | 'BGR' = 'RGB'
): Promise<{
  statsPath: string;
  previewPath: string;
  statsWritten: boolean;
  previewWritten: boolean;
  errors: string[];
}> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('input_tensor')) {
    return {
      statsPath: '',
      previewPath: '',
      statsWritten: false,
      previewWritten: false,
      errors: [],
    };
  }

  const errors: string[] = [];

  // Compute and write stats
  const stats = computeInputTensorStats(inputTensor, shape, paddingFillValue, channelOrder);
  const statsResult = await writeInputTensorStats(sessionId, stats);
  if (!statsResult.success) {
    errors.push(`Stats write failed: ${statsResult.error}`);
  }

  // Write preview image
  const previewResult = await writeInputTensorPreview(sessionId, inputTensor, shape);
  if (!previewResult.success) {
    errors.push(`Preview write failed: ${previewResult.error}`);
  }

  console.log('========================================');
  console.log('[DebugArtifacts] INPUT TENSOR ARTIFACTS:');
  console.log(`[DebugArtifacts]   Stats: ${statsResult.success ? '✓' : '✗'} ${statsResult.path}`);
  console.log(`[DebugArtifacts]   Preview: ${previewResult.success ? '✓' : '✗'} ${previewResult.path}`);
  console.log(`[DebugArtifacts]   Shape: [${shape.join(', ')}]`);
  console.log(`[DebugArtifacts]   Global range: [${stats.globalMin.toFixed(4)}, ${stats.globalMax.toFixed(4)}]`);
  console.log(`[DebugArtifacts]   Global p1/p50/p99: ${stats.globalP1.toFixed(4)}/${stats.globalP50.toFixed(4)}/${stats.globalP99.toFixed(4)}`);
  if (errors.length > 0) {
    console.log(`[DebugArtifacts]   Errors: ${errors.join(', ')}`);
  }
  console.log('========================================');

  return {
    statsPath: statsResult.path,
    previewPath: previewResult.path,
    statsWritten: statsResult.success,
    previewWritten: previewResult.success,
    errors,
  };
}

// ============================================================================
// RECTIFICATION DEBUG OVERLAY
// ============================================================================

/**
 * OBB detection for rectification overlay (frame-space coordinates)
 */
export interface RectificationOverlayDetection {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  score: number;
  detectionIndex: number;
}

/**
 * Write rectification debug overlay artifact.
 * Draws OBB boxes on input_normalized.jpg to visualize what regions are being rectified.
 *
 * @param sessionId - Session ID
 * @param detections - OBB detections in frame-space coordinates
 * @returns WriteResult
 */
export async function writeRectificationDebugOverlay(
  sessionId: string,
  detections: RectificationOverlayDetection[]
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('rectification_overlay')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const normalizedPath = `${sessionDir}/input_normalized.jpg`;
  const outputPath = `${sessionDir}/overlay_rectification.jpg`;

  // Check if input_normalized.jpg exists
  const exists = await RNFS.exists(normalizedPath);
  if (!exists) {
    const error = 'input_normalized.jpg not found';
    console.error(`[DebugArtifacts] Cannot create rectification overlay: ${error}`);
    return { success: false, path: outputPath, bytes: 0, error };
  }

  // Get native module
  const { NativeModules } = require('react-native');
  const ImagePreprocessor = NativeModules.ImagePreprocessor;

  if (!ImagePreprocessor || !ImagePreprocessor.drawOBBOverlay) {
    const error = 'Native drawOBBOverlay not available';
    console.warn(`[DebugArtifacts] ${error}`);
    return { success: false, path: outputPath, bytes: 0, error };
  }

  try {
    // Convert detections to overlay format
    const overlayDetections = detections.map(d => ({
      cx: d.cx,
      cy: d.cy,
      width: d.width,
      height: d.height,
      angle: d.angle,
      score: d.score,
    }));

    const result = await ImagePreprocessor.drawOBBOverlay(
      normalizedPath,
      overlayDetections,
      outputPath,
      3.0  // thicker line width for frame-space (larger image)
    );

    console.log(`[DebugArtifacts] ✓ Created rectification overlay: ${detections.length} boxes`);

    return {
      success: true,
      path: result.path,
      bytes: result.size,
    };
  } catch (error: any) {
    console.error(`[DebugArtifacts] Rectification overlay failed: ${error.message}`);
    return {
      success: false,
      path: outputPath,
      bytes: 0,
      error: error.message,
    };
  }
}

// ============================================================================
// BLANK CROP DETECTOR
// ============================================================================

/**
 * Crop quality analysis result
 */
export interface CropQualityResult {
  /** Whether the crop appears to be blank/empty */
  isBlank: boolean;
  /** Variance of pixel values (low = likely blank) */
  variance: number;
  /** Minimum pixel value (0-255) */
  minValue: number;
  /** Maximum pixel value (0-255) */
  maxValue: number;
  /** Mean pixel value (0-255) */
  meanValue: number;
  /** Percentage of pixels that are near-gray (within ±10 of 114) */
  grayPercentage: number;
  /** Reason why crop is considered blank (if isBlank=true) */
  blankReason?: string;
}

/**
 * Analyze crop quality to detect blank/empty crops.
 * A blank crop typically has:
 * - Very low variance (all pixels same color)
 * - High percentage of gray pixels (padding fill color)
 *
 * @param cropPath - Path to the crop image file
 * @returns CropQualityResult
 */
export async function analyzeCropQuality(cropPath: string): Promise<CropQualityResult | null> {
  const { NativeModules } = require('react-native');
  const ImagePreprocessor = NativeModules.ImagePreprocessor;

  if (!ImagePreprocessor || !ImagePreprocessor.getImageDecodeStats) {
    console.warn('[DebugArtifacts] Cannot analyze crop quality: native module not available');
    return null;
  }

  try {
    const cleanPath = cropPath.startsWith('file://') ? cropPath.slice(7) : cropPath;
    const stats = await ImagePreprocessor.getImageDecodeStats(cleanPath);

    // Calculate overall variance from RGB channel stats
    const channels = stats.channels;
    const avgMean = (channels.R.mean + channels.G.mean + channels.B.mean) / 3;
    const avgStd = (channels.R.std + channels.G.std + channels.B.std) / 3;
    const variance = avgStd * avgStd;

    // Check for blank/empty crop
    const VARIANCE_THRESHOLD = 50;  // Very low variance = likely blank
    const GRAY_FILL_VALUE = 114;     // Standard padding fill color
    const GRAY_TOLERANCE = 10;       // ±10 from gray

    // Calculate what percentage of the image is near-gray
    // This is an approximation based on mean being close to gray
    const isNearGray = Math.abs(avgMean - GRAY_FILL_VALUE) < GRAY_TOLERANCE;
    const grayPercentage = isNearGray && variance < VARIANCE_THRESHOLD ? 95 : 0;

    let isBlank = false;
    let blankReason: string | undefined;

    if (variance < VARIANCE_THRESHOLD && isNearGray) {
      isBlank = true;
      blankReason = `Low variance (${variance.toFixed(1)}) and mean (${avgMean.toFixed(1)}) near gray fill (114)`;
    } else if (stats.globalMax === stats.globalMin) {
      isBlank = true;
      blankReason = `All pixels same value (${stats.globalMin})`;
    } else if (stats.globalMax - stats.globalMin < 10) {
      isBlank = true;
      blankReason = `Very narrow pixel range (${stats.globalMin}-${stats.globalMax})`;
    }

    return {
      isBlank,
      variance,
      minValue: stats.globalMin,
      maxValue: stats.globalMax,
      meanValue: avgMean,
      grayPercentage,
      blankReason,
    };
  } catch (error: any) {
    console.error(`[DebugArtifacts] Crop quality analysis failed: ${error.message}`);
    return null;
  }
}

/**
 * Write crop quality analysis for all crops in a session
 */
export async function writeCropQualityAnalysis(
  sessionId: string,
  cropPaths: Array<{ detectionIndex: number; cropUri: string }>
): Promise<WriteResult> {
  // GATE: Skip if artifact writing is disabled
  if (!shouldWriteArtifact('crop_quality')) {
    return SKIPPED_WRITE_RESULT;
  }

  const sessionDir = getSessionDir(sessionId);
  const outputPath = `${sessionDir}/crop_quality.json`;

  const results: Array<{
    detectionIndex: number;
    cropPath: string;
    quality: CropQualityResult | null;
  }> = [];

  let blankCount = 0;

  for (const { detectionIndex, cropUri } of cropPaths) {
    const cleanPath = cropUri.startsWith('file://') ? cropUri.slice(7) : cropUri;
    const quality = await analyzeCropQuality(cleanPath);

    if (quality?.isBlank) {
      blankCount++;
      console.warn(`[DebugArtifacts] ⚠️  Crop ${detectionIndex} appears BLANK: ${quality.blankReason}`);
    }

    results.push({
      detectionIndex,
      cropPath: cleanPath,
      quality,
    });
  }

  const summary = {
    totalCrops: results.length,
    blankCrops: blankCount,
    validCrops: results.length - blankCount,
    crops: results,
    analyzedAt: new Date().toISOString(),
  };

  console.log(`[DebugArtifacts] Crop quality: ${summary.validCrops}/${summary.totalCrops} valid (${blankCount} blank)`);

  return writeJsonAtomic(outputPath, summary, sessionDir);
}
