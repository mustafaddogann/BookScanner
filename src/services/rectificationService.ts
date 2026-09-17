/**
 * Rectification Service - OBB to canonical upright crop
 *
 * Implementation:
 * - iOS: Native CoreImage CIPerspectiveCorrection (preferred)
 * - Android: Placeholder (returns skipped)
 *
 * NO backend/network fallback - all rectification is on-device or skipped.
 */

import { NativeModules, Platform } from 'react-native';
import RNFS from 'react-native-fs';
import type { OBBDetection, OBBCorners, RectifyResult } from '../types';
import { obbToCorners } from '../utils/letterbox';
import { writeCrop } from './debugArtifacts';

// Target height for rectified crops
const TARGET_HEIGHT = 768;
const PADDING_MARGIN = 0.15; // 15% padding for wider crops that capture full spine text

// Get native ImagePreprocessor module
const ImagePreprocessor = NativeModules.ImagePreprocessor;

// Cache for native rectification availability
let nativeRectificationAvailable: boolean | null = null;
let availabilityCheckLogged = false;

/**
 * Check if native rectification is available on this device
 * Results are cached for performance
 */
export async function isNativeRectificationAvailable(): Promise<{
  available: boolean;
  platform: string;
  method: string;
  reason?: string;
}> {
  if (!ImagePreprocessor) {
    // Only log once to reduce spam
    if (!availabilityCheckLogged) {
      console.log('[Rectifier] ImagePreprocessor native module not found');
      availabilityCheckLogged = true;
    }
    return {
      available: false,
      platform: Platform.OS,
      method: 'none',
      reason: 'Native module not linked',
    };
  }

  try {
    const result = await ImagePreprocessor.isRectificationAvailable();
    nativeRectificationAvailable = result.available;
    console.log(`[Rectifier] Native rectification: ${result.available ? 'AVAILABLE' : 'NOT AVAILABLE'} (${result.method})`);
    return result;
  } catch (error: any) {
    console.warn('[Rectifier] Failed to check native rectification availability:', error);
    nativeRectificationAvailable = false;
    return {
      available: false,
      platform: Platform.OS,
      method: 'error',
      reason: error.message,
    };
  }
}

/**
 * Compute 4 corner points from OBB in original pixels
 */
export function computeCorners(obb: OBBDetection): OBBCorners {
  return obbToCorners(obb);
}

/**
 * Calculate destination rectangle size based on quad edge lengths
 * Returns dimensions that preserve the aspect ratio of the original quad
 */
function calculateDestSize(
  corners: OBBCorners,
  targetHeight: number
): { width: number; height: number } {
  // Calculate edge lengths
  const topEdge = Math.sqrt(
    Math.pow(corners.topRight.x - corners.topLeft.x, 2) +
    Math.pow(corners.topRight.y - corners.topLeft.y, 2)
  );
  const bottomEdge = Math.sqrt(
    Math.pow(corners.bottomRight.x - corners.bottomLeft.x, 2) +
    Math.pow(corners.bottomRight.y - corners.bottomLeft.y, 2)
  );
  const leftEdge = Math.sqrt(
    Math.pow(corners.bottomLeft.x - corners.topLeft.x, 2) +
    Math.pow(corners.bottomLeft.y - corners.topLeft.y, 2)
  );
  const rightEdge = Math.sqrt(
    Math.pow(corners.bottomRight.x - corners.topRight.x, 2) +
    Math.pow(corners.bottomRight.y - corners.topRight.y, 2)
  );

  // Average the parallel edges
  const avgWidth = (topEdge + bottomEdge) / 2;
  const avgHeight = (leftEdge + rightEdge) / 2;

  // Determine which dimension should be height (longer edge for book spines)
  const isPortrait = avgHeight > avgWidth;
  const aspectRatio = isPortrait ? avgWidth / avgHeight : avgHeight / avgWidth;

  const height = targetHeight;
  const width = Math.round(height * aspectRatio);

  return { width, height };
}

/**
 * Add padding margin to corners (expand outward from center)
 */
function addPaddingToCorners(
  corners: OBBCorners,
  margin: number,
  imageDimensions?: { width: number; height: number }
): OBBCorners {
  // Calculate center
  const cx = (corners.topLeft.x + corners.topRight.x + corners.bottomRight.x + corners.bottomLeft.x) / 4;
  const cy = (corners.topLeft.y + corners.topRight.y + corners.bottomRight.y + corners.bottomLeft.y) / 4;

  // Scale corners outward from center
  const scale = 1 + margin;
  const clampX = imageDimensions
    ? (value: number) => Math.max(0, Math.min(value, imageDimensions.width))
    : (value: number) => value;
  const clampY = imageDimensions
    ? (value: number) => Math.max(0, Math.min(value, imageDimensions.height))
    : (value: number) => value;

  const scalePoint = (p: { x: number; y: number }) => ({
    x: clampX(cx + (p.x - cx) * scale),
    y: clampY(cy + (p.y - cy) * scale),
  });

  return {
    topLeft: scalePoint(corners.topLeft),
    topRight: scalePoint(corners.topRight),
    bottomRight: scalePoint(corners.bottomRight),
    bottomLeft: scalePoint(corners.bottomLeft),
  };
}

/**
 * Native rectification using ImagePreprocessor.rectifyPerspective
 */
async function rectifyWithNativeModule(
  imageUri: string,
  corners: OBBCorners,
  outputPath: string,
  targetHeight: number
): Promise<{
  success: boolean;
  path: string;
  width: number;
  height: number;
  method: string;
  error?: string;
}> {
  if (!ImagePreprocessor || !ImagePreprocessor.rectifyPerspective) {
    return {
      success: false,
      path: '',
      width: 0,
      height: 0,
      method: 'skipped',
      error: 'Native rectifyPerspective not available',
    };
  }

  try {
    const result = await ImagePreprocessor.rectifyPerspective(
      imageUri,
      {
        topLeft: { x: corners.topLeft.x, y: corners.topLeft.y },
        topRight: { x: corners.topRight.x, y: corners.topRight.y },
        bottomRight: { x: corners.bottomRight.x, y: corners.bottomRight.y },
        bottomLeft: { x: corners.bottomLeft.x, y: corners.bottomLeft.y },
      },
      outputPath,
      targetHeight
    );

    // Handle case where native module returns skipped (e.g., Android placeholder)
    if (result.method === 'skipped') {
      return {
        success: false,
        path: '',
        width: 0,
        height: 0,
        method: 'skipped',
        error: result.skippedReason || 'Native rectification skipped',
      };
    }

    return {
      success: true,
      path: result.path,
      width: result.width,
      height: result.height,
      method: result.method || 'native',
    };
  } catch (error: any) {
    console.error('[Rectifier] Native rectification error:', error);
    return {
      success: false,
      path: '',
      width: 0,
      height: 0,
      method: 'error',
      error: error.message,
    };
  }
}

/**
 * Rectify an OBB detection to an upright crop
 *
 * @param imageUri - Source image URI (file:// or absolute path)
 * @param obb - OBB detection in original pixel coordinates
 * @param detectionIndex - Index of this detection (for naming)
 * @param sessionId - Session ID for artifact storage
 * @param imageDimensions - Source image dimensions for corner clamping
 * @returns RectifyResult with crop path and metadata, or skipped status
 */
export async function rectify(
  imageUri: string,
  obb: OBBDetection,
  detectionIndex: number,
  sessionId: string,
  imageDimensions?: { width: number; height: number }
): Promise<RectifyResult> {
  // Compute corners from OBB
  const corners = computeCorners(obb);

  // Check native availability (cached)
  if (nativeRectificationAvailable === null) {
    await isNativeRectificationAvailable();
  }

  // If native rectification is not available, skip immediately
  if (!nativeRectificationAvailable) {
    console.log(`[Rectifier] Skipping detection ${detectionIndex} - native rectification unavailable`);
    return {
      cropUri: '',
      sourceCorners: corners,
      outputWidth: 0,
      outputHeight: 0,
      paddingUsed: PADDING_MARGIN,
      detectionIndex,
      rectificationMethod: 'skipped',
      skippedReason: Platform.OS === 'android' ? 'android_not_implemented' : 'native_unavailable',
    };
  }

  // Add padding margin to corners, clamped to image bounds
  const paddedCorners = addPaddingToCorners(corners, PADDING_MARGIN, imageDimensions);

  // Calculate destination size
  const destSize = calculateDestSize(paddedCorners, TARGET_HEIGHT);

  // Generate output path
  const sessionDir = `${RNFS.DocumentDirectoryPath}/sessions/${sessionId}`;
  const cropsDir = `${sessionDir}/crops`;
  const outputPath = `${cropsDir}/crop_${detectionIndex}.jpg`;

  // Ensure directories exist
  await RNFS.mkdir(sessionDir);
  await RNFS.mkdir(cropsDir);

  // Use normalized image path if available, otherwise use original
  const cleanUri = imageUri.startsWith('file://') ? imageUri : `file://${imageUri}`;

  // Perform native rectification
  const nativeResult = await rectifyWithNativeModule(
    cleanUri,
    paddedCorners,
    outputPath,
    TARGET_HEIGHT
  );

  if (!nativeResult.success) {
    console.warn(`[Rectifier] Detection ${detectionIndex} skipped: ${nativeResult.error}`);
    return {
      cropUri: '',
      sourceCorners: corners,
      outputWidth: destSize.width,
      outputHeight: destSize.height,
      paddingUsed: PADDING_MARGIN,
      detectionIndex,
      rectificationMethod: 'skipped',
      skippedReason: nativeResult.error || 'native_failed',
    };
  }

  console.log(`[Rectifier] ✓ Detection ${detectionIndex}: ${nativeResult.width}x${nativeResult.height} (${nativeResult.method})`);

  // Build result
  const result: RectifyResult = {
    cropUri: `file://${nativeResult.path}`,
    sourceCorners: corners,
    outputWidth: nativeResult.width,
    outputHeight: nativeResult.height,
    paddingUsed: PADDING_MARGIN,
    detectionIndex,
    rectificationMethod: 'native_opencv', // Keep consistent with type, actual method is CoreImage
  };

  // Write crop metadata (only if debug artifacts enabled)
  await writeCrop(sessionId, detectionIndex, nativeResult.path, result);

  return result;
}

/**
 * Rectification summary statistics
 */
export interface RectificationSummary {
  total: number;
  succeeded: number;
  skipped: number;
  results: RectifyResult[];
}

/**
 * Rectify all detections in a session
 * Returns detailed summary with counts
 */
export async function rectifyAll(
  imageUri: string,
  detections: OBBDetection[],
  sessionId: string,
  imageDimensions?: { width: number; height: number }
): Promise<RectificationSummary> {
  const results: RectifyResult[] = [];
  let succeeded = 0;
  let skipped = 0;

  console.log(`[Rectifier] Processing ${detections.length} detections...`);

  // Check availability once
  if (nativeRectificationAvailable === null) {
    const availability = await isNativeRectificationAvailable();
    console.log(`[Rectifier] Native rectification: ${availability.available ? 'ENABLED' : 'DISABLED'} (${availability.method})`);
  }

  for (let i = 0; i < detections.length; i++) {
    try {
      const result = await rectify(imageUri, detections[i], i, sessionId, imageDimensions);
      results.push(result);

      if (result.rectificationMethod === 'skipped') {
        skipped++;
      } else {
        succeeded++;
      }
    } catch (error) {
      console.error(`[Rectifier] Error processing detection ${i}:`, error);
      // Create a skipped result for failed detections
      const corners = computeCorners(detections[i]);
      results.push({
        cropUri: '',
        sourceCorners: corners,
        outputWidth: 0,
        outputHeight: 0,
        paddingUsed: PADDING_MARGIN,
        detectionIndex: i,
        rectificationMethod: 'skipped',
        skippedReason: 'processing_error',
      });
      skipped++;
    }
  }

  // Log accurate summary (no misleading "Rectified N" when all skipped)
  console.log(`[Rectifier] === RECTIFICATION SUMMARY ===`);
  console.log(`[Rectifier]   Total detections: ${detections.length}`);
  console.log(`[Rectifier]   Succeeded: ${succeeded}`);
  console.log(`[Rectifier]   Skipped: ${skipped}`);
  if (skipped > 0 && succeeded === 0) {
    console.log(`[Rectifier]   NOTE: All detections skipped - native rectification may be unavailable`);
  }
  console.log(`[Rectifier] ============================`);

  return {
    total: detections.length,
    succeeded,
    skipped,
    results,
  };
}

/**
 * Run rectification self-test on first detection
 * Only for debugging - runs one rectification to verify module works
 */
export async function runRectificationSelfTest(
  imageUri: string,
  obb: OBBDetection,
  sessionId: string
): Promise<{
  success: boolean;
  message: string;
  cropPath?: string;
  cropDimensions?: { width: number; height: number };
}> {
  console.log('[Rectifier] Running self-test...');

  // Check availability
  const availability = await isNativeRectificationAvailable();
  if (!availability.available) {
    return {
      success: false,
      message: `Native rectification not available: ${availability.reason || availability.method}`,
    };
  }

  // Run rectification
  const result = await rectify(imageUri, obb, 0, sessionId);

  if (result.rectificationMethod === 'skipped') {
    return {
      success: false,
      message: `Rectification skipped: ${result.skippedReason}`,
    };
  }

  // Verify crop file exists
  const cropPath = result.cropUri.replace('file://', '');
  const exists = await RNFS.exists(cropPath);

  if (!exists) {
    return {
      success: false,
      message: `Crop file not found at: ${cropPath}`,
    };
  }

  // Get file stats
  const stat = await RNFS.stat(cropPath);

  return {
    success: true,
    message: `Self-test passed: ${result.outputWidth}x${result.outputHeight} crop, ${stat.size} bytes`,
    cropPath,
    cropDimensions: {
      width: result.outputWidth,
      height: result.outputHeight,
    },
  };
}
