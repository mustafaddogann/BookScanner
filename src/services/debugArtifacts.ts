/**
 * Debug artifacts service - handles writing all debug outputs
 */

import RNFS from 'react-native-fs';
import type {
  DebugManifest,
  ImageMeta,
  LetterboxParams,
  ModelIOContract,
  OBBDetection,
  RectifyResult,
  PipelineTimings,
  RawModelOutput,
} from '../types';

const SESSIONS_DIR = 'sessions';

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
 */
export async function createSessionDir(sessionId: string): Promise<string> {
  await ensureSessionsDir();
  const sessionDir = getSessionDir(sessionId);
  await RNFS.mkdir(sessionDir);

  // Create crops subdirectory
  const cropsDir = `${sessionDir}/crops`;
  await RNFS.mkdir(cropsDir);

  return sessionDir;
}

/**
 * Write debug manifest JSON
 */
export async function writeDebugManifest(
  sessionId: string,
  manifest: DebugManifest
): Promise<string> {
  const sessionDir = getSessionDir(sessionId);
  const manifestPath = `${sessionDir}/debug_manifest.json`;

  await RNFS.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[DebugArtifacts] Wrote debug_manifest.json to ${manifestPath}`);
  return manifestPath;
}

/**
 * Write model IO contract JSON
 */
export async function writeModelIO(
  sessionId: string,
  modelIO: ModelIOContract
): Promise<string> {
  const sessionDir = getSessionDir(sessionId);
  const modelIOPath = `${sessionDir}/model_io.json`;

  await RNFS.writeFile(modelIOPath, JSON.stringify(modelIO, null, 2), 'utf8');
  console.log(`[DebugArtifacts] Wrote model_io.json to ${modelIOPath}`);
  return modelIOPath;
}

/**
 * Write raw model output JSON
 */
export async function writeRawModelOutput(
  sessionId: string,
  rawOutput: RawModelOutput
): Promise<string> {
  const sessionDir = getSessionDir(sessionId);
  const rawOutputPath = `${sessionDir}/detections_raw.json`;

  await RNFS.writeFile(rawOutputPath, JSON.stringify(rawOutput, null, 2), 'utf8');
  console.log(`[DebugArtifacts] Wrote detections_raw.json to ${rawOutputPath}`);
  return rawOutputPath;
}

/**
 * Copy original image to session directory
 */
export async function copyOriginalImage(
  sessionId: string,
  sourceUri: string
): Promise<string> {
  const sessionDir = getSessionDir(sessionId);
  const ext = sourceUri.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const destPath = `${sessionDir}/original.${ext}`;

  // Handle file:// prefix
  const cleanSourceUri = sourceUri.startsWith('file://')
    ? sourceUri.slice(7)
    : sourceUri;

  await RNFS.copyFile(cleanSourceUri, destPath);
  console.log(`[DebugArtifacts] Copied original image to ${destPath}`);
  return destPath;
}

/**
 * Write crop image and metadata
 */
export async function writeCrop(
  sessionId: string,
  cropIndex: number,
  cropUri: string,
  metadata: RectifyResult
): Promise<{ imagePath: string; metadataPath: string }> {
  const sessionDir = getSessionDir(sessionId);
  const cropsDir = `${sessionDir}/crops`;

  const ext = cropUri.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const imagePath = `${cropsDir}/crop_${cropIndex}.${ext}`;
  const metadataPath = `${cropsDir}/crop_${cropIndex}.json`;

  // Copy crop image
  const cleanCropUri = cropUri.startsWith('file://') ? cropUri.slice(7) : cropUri;
  await RNFS.copyFile(cleanCropUri, imagePath);

  // Write metadata
  await RNFS.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

  console.log(`[DebugArtifacts] Wrote crop_${cropIndex} to ${cropsDir}`);
  return { imagePath, metadataPath };
}

/**
 * Write coordinate test artifact for Gate 2
 */
export async function writeCoordinateTest(
  sessionId: string,
  testData: object
): Promise<string> {
  const sessionDir = getSessionDir(sessionId);
  const testPath = `${sessionDir}/coordinate_test.json`;

  await RNFS.writeFile(testPath, JSON.stringify(testData, null, 2), 'utf8');
  console.log(`[DebugArtifacts] Wrote coordinate_test.json to ${testPath}`);
  return testPath;
}

/**
 * Write angle test artifact for Gate 3
 */
export async function writeAngleTest(
  sessionId: string,
  testData: object
): Promise<string> {
  const sessionDir = getSessionDir(sessionId);
  const testPath = `${sessionDir}/angle_test.json`;

  await RNFS.writeFile(testPath, JSON.stringify(testData, null, 2), 'utf8');
  console.log(`[DebugArtifacts] Wrote angle_test.json to ${testPath}`);
  return testPath;
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
