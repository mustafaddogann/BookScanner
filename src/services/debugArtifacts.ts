/**
 * Debug artifacts service - handles writing all debug outputs
 *
 * GUARANTEED ARTIFACT WRITING:
 * - All JSON artifacts use atomic writes (temp + move + verify)
 * - Errors are logged to write_errors.log in session dir
 * - debug_manifest.json tracks all artifacts with exists/bytes verification
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

const SESSIONS_DIR = 'sessions';

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
 */
export async function writeAllArtifacts(data: AllArtifactsData): Promise<ArtifactInfo[]> {
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
    // Write empty diag result (Mode B: ch4=angle, ch5=score)
    const emptyDiag: DiagDecodeResult = {
      diagDecodedCount: 0,
      top20: [],
      modeUsed: 'mode_b',
      scoreChannel: 5,
      angleChannel: 4,
      thresholdUsed: 0.01,
      sigmoidApplied: true,
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
