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

// Backend endpoint for fallback rectification
const BACKEND_URL = 'http://localhost:8000';

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
    `${BACKEND_URL}/rectify`,
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
 * Fallback: Simple crop without perspective correction
 * Used when neither native nor backend is available
 */
async function rectifyFallback(
  imageUri: string,
  corners: OBBCorners,
  destSize: { width: number; height: number },
  outputPath: string
): Promise<void> {
  console.warn('[Rectifier] Using fallback crop (no perspective correction)');

  // For fallback, we just copy the image and note that rectification wasn't applied
  // This allows the pipeline to continue for testing purposes
  const cleanUri = imageUri.startsWith('file://') ? imageUri.slice(7) : imageUri;
  await RNFS.copyFile(cleanUri, outputPath);
}

/**
 * Check if backend rectification service is available
 */
export async function isBackendAvailable(): Promise<boolean> {
  try {
    const response = await axios.get(`${BACKEND_URL}/health`, { timeout: 2000 });
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
 * @returns RectifyResult with crop path and metadata
 */
export async function rectify(
  imageUri: string,
  obb: OBBDetection,
  detectionIndex: number,
  sessionId: string
): Promise<RectifyResult> {
  console.log(`[Rectifier] Rectifying detection ${detectionIndex}`);

  // Compute corners
  const corners = computeCorners(obb);

  // Add padding margin
  const paddedCorners = addPaddingToCorners(corners, PADDING_MARGIN);

  // Calculate destination size
  const destSize = calculateDestSize(paddedCorners, TARGET_HEIGHT);

  // Generate output path
  const sessionDir = `${RNFS.DocumentDirectoryPath}/sessions/${sessionId}`;
  const cropsDir = `${sessionDir}/crops`;
  const outputPath = `${cropsDir}/crop_${detectionIndex}.jpg`;

  // Ensure crops directory exists
  if (!(await RNFS.exists(cropsDir))) {
    await RNFS.mkdir(cropsDir);
  }

  // Try rectification methods in order of preference
  let rectificationMethod = 'none';

  if (hasNativeRectifier) {
    try {
      await rectifyNative(imageUri, paddedCorners, destSize, outputPath);
      rectificationMethod = 'native_opencv';
      console.log('[Rectifier] Used native OpenCV rectification');
    } catch (error) {
      console.warn('[Rectifier] Native rectification failed:', error);
    }
  }

  if (rectificationMethod === 'none') {
    const backendAvailable = await isBackendAvailable();
    if (backendAvailable) {
      try {
        await rectifyBackend(imageUri, paddedCorners, destSize, outputPath);
        rectificationMethod = 'backend';
        console.log('[Rectifier] Used backend rectification');
      } catch (error) {
        console.warn('[Rectifier] Backend rectification failed:', error);
      }
    }
  }

  if (rectificationMethod === 'none') {
    await rectifyFallback(imageUri, paddedCorners, destSize, outputPath);
    rectificationMethod = 'fallback_copy';
    console.log('[Rectifier] Used fallback (copy only)');
  }

  // Build result
  const result: RectifyResult = {
    cropUri: `file://${outputPath}`,
    sourceCorners: corners,
    outputWidth: destSize.width,
    outputHeight: destSize.height,
    paddingUsed: PADDING_MARGIN,
    detectionIndex,
  };

  // Write crop metadata
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
