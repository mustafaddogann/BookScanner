/**
 * Rectification Service - OBB to canonical upright crop
 *
 * Implementation priority:
 * 1. On-device native module (preferred) - requires OpenCV setup
 * 2. Backend rectification endpoint (contingency)
 */

import { Platform, NativeModules } from 'react-native';
import RNFS from 'react-native-fs';
import axios from 'axios';
import type { OBBDetection, OBBCorners, RectifyResult } from '../types';
import { obbToCorners } from '../utils/letterbox';
import { writeCrop } from './debugArtifacts';

// Target height for rectified crops
const TARGET_HEIGHT = 768;
const PADDING_MARGIN = 0.05; // 5% padding

// Backend endpoint for fallback rectification - configurable at runtime
let backendUrl = 'http://localhost:8000';

/**
 * Get current rectifier backend URL
 */
export function getRectifierUrl(): string {
  return backendUrl;
}

/**
 * Set rectifier backend URL at runtime
 * Use this for device testing with a remote server
 */
export function setRectifierUrl(url: string): void {
  backendUrl = url;
  console.log(`[Rectifier] Backend URL set to: ${url}`);
}

// Check if native OpenCV module is available
const OpenCVModule = NativeModules.OpenCVRectifier;
const hasNativeRectifier = !!OpenCVModule;

console.log(`[Rectifier] Native OpenCV available: ${hasNativeRectifier}`);

/**
 * Compute 4 corner points from OBB in original pixels
 */
export function computeCorners(obb: OBBDetection): OBBCorners {
  return obbToCorners(obb);
}

/**
 * Calculate destination rectangle size preserving aspect ratio
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
  const leftEdge = Math.sqrt(
    Math.pow(corners.bottomLeft.x - corners.topLeft.x, 2) +
    Math.pow(corners.bottomLeft.y - corners.topLeft.y, 2)
  );

  // Determine which dimension should be height (longer edge for spines)
  const isPortrait = leftEdge > topEdge;
  const aspectRatio = isPortrait ? topEdge / leftEdge : leftEdge / topEdge;

  const height = targetHeight;
  const width = Math.round(height * aspectRatio);

  return { width, height };
}

/**
 * Native rectification using OpenCV module
 */
async function rectifyNative(
  imageUri: string,
  corners: OBBCorners,
  destSize: { width: number; height: number },
  outputPath: string
): Promise<void> {
  if (!hasNativeRectifier) {
    throw new Error('Native OpenCV module not available');
  }

  // Convert corners to flat array format expected by native module
  const srcPoints = [
    corners.topLeft.x, corners.topLeft.y,
    corners.topRight.x, corners.topRight.y,
    corners.bottomRight.x, corners.bottomRight.y,
    corners.bottomLeft.x, corners.bottomLeft.y,
  ];

  // Clean URI
  const cleanUri = imageUri.startsWith('file://') ? imageUri.slice(7) : imageUri;

  await OpenCVModule.rectifyImage(
    cleanUri,
    srcPoints,
    destSize.width,
    destSize.height,
    outputPath
  );
}

/**
 * Backend rectification using FastAPI endpoint
 */
async function rectifyBackend(
  imageUri: string,
  corners: OBBCorners,
  destSize: { width: number; height: number },
  outputPath: string
): Promise<void> {
  const cleanUri = imageUri.startsWith('file://') ? imageUri.slice(7) : imageUri;

  // Read image as base64
  const imageBase64 = await RNFS.readFile(cleanUri, 'base64');

  // Call backend
  const response = await axios.post(
    `${backendUrl}/rectify`,
    {
      image_base64: imageBase64,
      src_points: [
        [corners.topLeft.x, corners.topLeft.y],
        [corners.topRight.x, corners.topRight.y],
        [corners.bottomRight.x, corners.bottomRight.y],
        [corners.bottomLeft.x, corners.bottomLeft.y],
      ],
      dest_width: destSize.width,
      dest_height: destSize.height,
    },
    {
      timeout: 30000,
    }
  );

  // Save result image
  const resultBase64 = response.data.image_base64;
  await RNFS.writeFile(outputPath, resultBase64, 'base64');
}

/**
 * Fallback: Axis-aligned bounding box crop
 * Used when neither native OpenCV nor backend is available.
 *
 * NOTE: This does NOT do perspective correction - it just crops the AABB
 * containing the OBB corners. The crop file will be larger than needed
 * and not properly rectified.
 *
 * TODO: Implement proper AABB cropping using react-native-image-crop-picker
 * or expo-image-manipulator. For now, we write the AABB region coordinates
 * as metadata so the caller knows the crop wasn't applied.
 */
async function rectifyFallback(
  imageUri: string,
  corners: OBBCorners,
  destSize: { width: number; height: number },
  outputPath: string
): Promise<{ fallbackUsed: true; aabbRegion: { x: number; y: number; width: number; height: number } }> {
  // Calculate axis-aligned bounding box from corners
  const xs = [corners.topLeft.x, corners.topRight.x, corners.bottomRight.x, corners.bottomLeft.x];
  const ys = [corners.topLeft.y, corners.topRight.y, corners.bottomRight.y, corners.bottomLeft.y];
  const aabbRegion = {
    x: Math.floor(Math.min(...xs)),
    y: Math.floor(Math.min(...ys)),
    width: Math.ceil(Math.max(...xs) - Math.min(...xs)),
    height: Math.ceil(Math.max(...ys) - Math.min(...ys)),
  };

  console.warn('[Rectifier] FALLBACK: No rectification available.');
  console.warn(`[Rectifier] Would crop AABB region: x=${aabbRegion.x}, y=${aabbRegion.y}, w=${aabbRegion.width}, h=${aabbRegion.height}`);
  console.warn('[Rectifier] Writing full image as placeholder (NOT a proper crop).');

  // TODO: Use react-native-image-crop-picker or expo-image-manipulator to:
  // 1. Read the original image
  // 2. Crop to aabbRegion
  // 3. Resize to destSize
  // 4. Write to outputPath
  //
  // For now, we copy the original so the pipeline doesn't break, but this is NOT correct.
  const cleanUri = imageUri.startsWith('file://') ? imageUri.slice(7) : imageUri;
  await RNFS.copyFile(cleanUri, outputPath);

  return { fallbackUsed: true, aabbRegion };
}

/**
 * Check if backend rectification service is available
 */
export async function isBackendAvailable(): Promise<boolean> {
  try {
    const response = await axios.get(`${backendUrl}/health`, { timeout: 2000 });
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Rectify an OBB detection to an upright crop
 *
 * @param imageUri - Source image URI
 * @param obb - OBB detection in original pixel coordinates
 * @param detectionIndex - Index of this detection (for naming)
 * @param sessionId - Session ID for artifact storage
 * @returns RectifyResult with crop path and metadata, or skipped status
 */
export async function rectify(
  imageUri: string,
  obb: OBBDetection,
  detectionIndex: number,
  sessionId: string
): Promise<RectifyResult> {
  console.log(`[Rectifier] Rectifying detection ${detectionIndex}`);

  // EARLY EXIT: If native OpenCV is not available, skip rectification entirely
  // Do NOT attempt localhost backend calls on device - they will always fail
  if (!hasNativeRectifier) {
    console.log('[Rectifier] Native OpenCV unavailable - skipping rectification (no network fallback)');
    const corners = computeCorners(obb);
    return {
      cropUri: '',
      sourceCorners: corners,
      outputWidth: 0,
      outputHeight: 0,
      paddingUsed: PADDING_MARGIN,
      detectionIndex,
      rectificationMethod: 'skipped',
      skippedReason: 'native_opencv_unavailable',
    };
  }

  // Compute corners
  const corners = computeCorners(obb);

  // Add padding margin
  const paddedCorners = addPaddingToCorners(corners, PADDING_MARGIN);

  // Calculate destination size
  const destSize = calculateDestSize(paddedCorners, TARGET_HEIGHT);

  // Generate output path with unique tmp suffix to avoid collision during write
  const sessionDir = `${RNFS.DocumentDirectoryPath}/sessions/${sessionId}`;
  const cropsDir = `${sessionDir}/crops`;
  const finalPath = `${cropsDir}/crop_${detectionIndex}.jpg`;

  // Use tmp file for atomic write
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);
  const tmpPath = `${cropsDir}/crop_${detectionIndex}.${ts}.${rand}.tmp.jpg`;
  let outputPath = tmpPath;

  // Ensure session and crops directory exists (mkdir -p behavior)
  await RNFS.mkdir(sessionDir);
  await RNFS.mkdir(cropsDir);

  // Try native rectification
  let rectificationMethod: 'native_opencv' | 'skipped' = 'skipped';

  try {
    await rectifyNative(imageUri, paddedCorners, destSize, outputPath);
    rectificationMethod = 'native_opencv';
    console.log('[Rectifier] Used native OpenCV rectification');
  } catch (error) {
    console.warn('[Rectifier] Native rectification failed:', error);
    // Return skipped status instead of trying fallbacks
    return {
      cropUri: '',
      sourceCorners: corners,
      outputWidth: destSize.width,
      outputHeight: destSize.height,
      paddingUsed: PADDING_MARGIN,
      detectionIndex,
      rectificationMethod: 'skipped',
      skippedReason: 'native_opencv_failed',
    };
  }

  // Atomic move: tmp file -> final path (idempotent)
  try {
    // Delete existing final file if present
    const finalExists = await RNFS.exists(finalPath);
    if (finalExists) {
      await RNFS.unlink(finalPath);
    }
    // Move tmp to final
    await RNFS.moveFile(tmpPath, finalPath);
    outputPath = finalPath;
    console.log(`[Rectifier] Moved tmp to final: ${finalPath}`);
  } catch (moveError: any) {
    console.warn(`[Rectifier] Move failed, using tmp path: ${moveError.message}`);
    // Fall back to using tmp path if move fails
    outputPath = tmpPath;
  }

  // Build result
  const result: RectifyResult = {
    cropUri: `file://${outputPath}`,
    sourceCorners: corners,
    outputWidth: destSize.width,
    outputHeight: destSize.height,
    paddingUsed: PADDING_MARGIN,
    detectionIndex,
    rectificationMethod,
  };

  // Write crop metadata (writeCrop will skip image copy since outputPath is already the final location)
  await writeCrop(sessionId, detectionIndex, outputPath, result);

  return result;
}

/**
 * Add padding margin to corners
 */
function addPaddingToCorners(corners: OBBCorners, margin: number): OBBCorners {
  // Calculate center
  const cx = (corners.topLeft.x + corners.topRight.x + corners.bottomRight.x + corners.bottomLeft.x) / 4;
  const cy = (corners.topLeft.y + corners.topRight.y + corners.bottomRight.y + corners.bottomLeft.y) / 4;

  // Scale corners outward from center
  const scale = 1 + margin;

  const scalePoint = (p: { x: number; y: number }) => ({
    x: cx + (p.x - cx) * scale,
    y: cy + (p.y - cy) * scale,
  });

  return {
    topLeft: scalePoint(corners.topLeft),
    topRight: scalePoint(corners.topRight),
    bottomRight: scalePoint(corners.bottomRight),
    bottomLeft: scalePoint(corners.bottomLeft),
  };
}

/**
 * Rectify all detections in a session
 */
export async function rectifyAll(
  imageUri: string,
  detections: OBBDetection[],
  sessionId: string
): Promise<RectifyResult[]> {
  const results: RectifyResult[] = [];

  for (let i = 0; i < detections.length; i++) {
    try {
      const result = await rectify(imageUri, detections[i], i, sessionId);
      results.push(result);
    } catch (error) {
      console.error(`[Rectifier] Failed to rectify detection ${i}:`, error);
    }
  }

  return results;
}

/**
 * Configure backend URL
 */
export function setBackendUrl(url: string): void {
  // This would need to be a module-level variable that's mutable
  console.log(`[Rectifier] Backend URL set to: ${url}`);
}
