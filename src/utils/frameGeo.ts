/**
 * FrameGeo - Single source of truth for frame geometry
 *
 * This module provides a unified geometry object that captures all coordinate
 * mapping information at capture time. All subsequent operations use this
 * object instead of re-reading image dimensions.
 *
 * KEY INVARIANTS:
 * 1. normalizedUri is always file:///path (exactly one file:// prefix)
 * 2. pixelW/pixelH are the DISPLAY dimensions (EXIF-corrected)
 * 3. letterbox is computed exactly ONCE from pixelW/pixelH
 * 4. All mapping operations use this letterbox
 */

import type { LetterboxParams, SerializedFrameGeo } from '../types';

/**
 * Frame geometry - single source of truth for all coordinate mapping
 */
export interface FrameGeo {
  /** Normalized file URI (exactly file:///path format) */
  normalizedUri: string;

  /** Display width in pixels (EXIF-corrected) */
  pixelW: number;

  /** Display height in pixels (EXIF-corrected) */
  pixelH: number;

  /** Rotation applied to get display orientation (degrees: 0, 90, 180, 270) */
  rotationDeg: number;

  /** Whether image is mirrored (front camera) */
  mirrored: boolean;

  /** Original EXIF orientation value (1-8) */
  exifOrientation: number;

  /** Model input size (typically 640) */
  modelSize: number;

  /** Letterbox parameters computed from pixelW/pixelH */
  letterbox: LetterboxParams;

  /** Timestamp when this FrameGeo was created */
  createdAt: number;
}

/**
 * Normalize a file URI to exactly file:///path format
 *
 * Handles:
 * - file://file:///path -> file:///path
 * - file:///path -> file:///path
 * - file://path -> file:///path
 * - /path -> file:///path
 * - path -> file:///path (assumes absolute)
 */
export function normalizeFileUri(uri: string): string {
  if (!uri) {
    throw new Error('normalizeFileUri: empty URI');
  }

  // Remove any leading/trailing whitespace
  uri = uri.trim();

  // Handle double file:// prefix (file://file:///...)
  while (uri.startsWith('file://file://')) {
    uri = uri.replace('file://file://', 'file://');
  }

  // If already properly formatted file:///path
  if (uri.startsWith('file:///')) {
    return uri;
  }

  // If file://path (missing third slash for absolute path)
  if (uri.startsWith('file://')) {
    const path = uri.slice(7); // Remove file://
    // Ensure path starts with /
    if (path.startsWith('/')) {
      return `file://${path}`;
    } else {
      return `file:///${path}`;
    }
  }

  // If just a path (no scheme)
  if (uri.startsWith('/')) {
    return `file://${uri}`;
  }

  // Assume it's a relative path that should be absolute
  console.warn(`[FrameGeo] normalizeFileUri: unexpected URI format: ${uri}`);
  return `file:///${uri}`;
}

/**
 * Extract clean file path from URI (removes file:// prefix)
 */
export function uriToPath(uri: string): string {
  const normalized = normalizeFileUri(uri);
  // file:///path -> /path
  return normalized.slice(7);
}

/**
 * Calculate letterbox parameters for resizing to model input
 * This is the SINGLE implementation used everywhere.
 */
export function calculateLetterbox(
  pixelW: number,
  pixelH: number,
  modelSize: number = 640
): LetterboxParams {
  // Scale to fit within model size while maintaining aspect ratio
  const scale = Math.min(modelSize / pixelW, modelSize / pixelH);

  // Calculate new dimensions after scaling
  const newW = Math.round(pixelW * scale);
  const newH = Math.round(pixelH * scale);

  // Calculate padding needed to center the image
  const padX = Math.round((modelSize - newW) / 2);
  const padY = Math.round((modelSize - newH) / 2);

  return {
    scale,
    padX,
    padY,
    srcWidth: pixelW,
    srcHeight: pixelH,
    dstWidth: modelSize,
    dstHeight: modelSize,
  };
}

/**
 * Get EXIF-corrected dimensions from raw dimensions and orientation
 *
 * @param rawW Raw image width (from file)
 * @param rawH Raw image height (from file)
 * @param orientation EXIF orientation (1-8)
 * @returns Display dimensions and rotation info
 */
export function getDisplayDimensions(
  rawW: number,
  rawH: number,
  orientation: number
): { pixelW: number; pixelH: number; rotationDeg: number; mirrored: boolean } {
  // EXIF orientations:
  // 1: Normal (no rotation)
  // 2: Flipped horizontally
  // 3: Rotated 180°
  // 4: Flipped vertically
  // 5: Rotated 90° CCW and flipped horizontally
  // 6: Rotated 90° CW
  // 7: Rotated 90° CW and flipped horizontally
  // 8: Rotated 90° CCW

  let pixelW = rawW;
  let pixelH = rawH;
  let rotationDeg = 0;
  let mirrored = false;

  switch (orientation) {
    case 1:
      // Normal
      rotationDeg = 0;
      mirrored = false;
      break;
    case 2:
      // Flipped horizontally
      rotationDeg = 0;
      mirrored = true;
      break;
    case 3:
      // Rotated 180°
      rotationDeg = 180;
      mirrored = false;
      break;
    case 4:
      // Flipped vertically (same as 180° + horizontal flip)
      rotationDeg = 180;
      mirrored = true;
      break;
    case 5:
      // Rotated 90° CCW and flipped horizontally
      pixelW = rawH;
      pixelH = rawW;
      rotationDeg = 270;
      mirrored = true;
      break;
    case 6:
      // Rotated 90° CW (most common for portrait photos)
      pixelW = rawH;
      pixelH = rawW;
      rotationDeg = 90;
      mirrored = false;
      break;
    case 7:
      // Rotated 90° CW and flipped horizontally
      pixelW = rawH;
      pixelH = rawW;
      rotationDeg = 90;
      mirrored = true;
      break;
    case 8:
      // Rotated 90° CCW
      pixelW = rawH;
      pixelH = rawW;
      rotationDeg = 270;
      mirrored = false;
      break;
    default:
      // Unknown orientation, assume normal
      console.warn(`[FrameGeo] Unknown EXIF orientation: ${orientation}, assuming 1`);
      break;
  }

  return { pixelW, pixelH, rotationDeg, mirrored };
}

/**
 * Build FrameGeo from raw image info
 *
 * @param uri File URI (will be normalized)
 * @param rawW Raw image width from camera/file
 * @param rawH Raw image height from camera/file
 * @param exifOrientation EXIF orientation (1-8, default 1)
 * @param modelSize Model input size (default 640)
 */
export function buildFrameGeo(
  uri: string,
  rawW: number,
  rawH: number,
  exifOrientation: number = 1,
  modelSize: number = 640
): FrameGeo {
  // Normalize URI
  const normalizedUri = normalizeFileUri(uri);

  // Get display dimensions from EXIF
  const { pixelW, pixelH, rotationDeg, mirrored } = getDisplayDimensions(
    rawW,
    rawH,
    exifOrientation
  );

  // Calculate letterbox ONCE
  const letterbox = calculateLetterbox(pixelW, pixelH, modelSize);

  const frameGeo: FrameGeo = {
    normalizedUri,
    pixelW,
    pixelH,
    rotationDeg,
    mirrored,
    exifOrientation,
    modelSize,
    letterbox,
    createdAt: Date.now(),
  };

  // Log for debugging
  console.log('========================================');
  console.log('[FrameGeo] Created single-source geometry:');
  console.log(`  URI: ${normalizedUri.slice(0, 50)}...`);
  console.log(`  Raw dims: ${rawW}x${rawH}, EXIF: ${exifOrientation}`);
  console.log(`  Display dims: ${pixelW}x${pixelH} (rotation=${rotationDeg}°, mirrored=${mirrored})`);
  console.log(`  Letterbox: scale=${letterbox.scale.toFixed(4)}, padX=${letterbox.padX}, padY=${letterbox.padY}`);
  console.log(`  Padding axis: ${letterbox.padX > letterbox.padY ? 'HORIZONTAL (left/right)' : 'VERTICAL (top/bottom)'}`);
  console.log('========================================');

  return frameGeo;
}

/**
 * Map coordinates from model space to image space
 * Uses the FrameGeo's letterbox (single source of truth)
 */
export function mapModelToImage(
  modelX: number,
  modelY: number,
  frameGeo: FrameGeo
): { imageX: number; imageY: number } {
  const { scale, padX, padY } = frameGeo.letterbox;

  // Inverse letterbox: remove padding, then scale up
  const imageX = (modelX - padX) / scale;
  const imageY = (modelY - padY) / scale;

  return { imageX, imageY };
}

/**
 * Map coordinates from image space to model space
 * Uses the FrameGeo's letterbox (single source of truth)
 */
export function mapImageToModel(
  imageX: number,
  imageY: number,
  frameGeo: FrameGeo
): { modelX: number; modelY: number } {
  const { scale, padX, padY } = frameGeo.letterbox;

  // Forward letterbox: scale down, then add padding
  const modelX = imageX * scale + padX;
  const modelY = imageY * scale + padY;

  return { modelX, modelY };
}

/**
 * Map OBB from model space to image space
 */
export function mapOBBModelToImage(
  cx: number,
  cy: number,
  width: number,
  height: number,
  angle: number,
  frameGeo: FrameGeo
): { cx: number; cy: number; width: number; height: number; angle: number } {
  const { scale, padX, padY } = frameGeo.letterbox;

  return {
    cx: (cx - padX) / scale,
    cy: (cy - padY) / scale,
    width: width / scale,
    height: height / scale,
    angle, // Angle unchanged
  };
}

/**
 * Round-trip coordinate test
 * Maps 20 image-space points through image->model->image and checks error
 *
 * @returns Test result with points, errors, and pass/fail status
 */
export function runCoordinateRoundtripTest(
  frameGeo: FrameGeo
): {
  passed: boolean;
  maxError: number;
  points: Array<{
    original: { x: number; y: number };
    afterModel: { x: number; y: number };
    afterRoundtrip: { x: number; y: number };
    error: number;
  }>;
  frameGeoSummary: {
    pixelW: number;
    pixelH: number;
    padX: number;
    padY: number;
    scale: number;
  };
} {
  const { pixelW, pixelH, letterbox } = frameGeo;

  // Generate 20 test points across the image
  const testPoints: Array<{ x: number; y: number }> = [];

  // Grid of 4x4 = 16 points
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      testPoints.push({
        x: (pixelW * (i + 0.5)) / 4,
        y: (pixelH * (j + 0.5)) / 4,
      });
    }
  }

  // Add 4 corner points
  testPoints.push({ x: 0, y: 0 });
  testPoints.push({ x: pixelW, y: 0 });
  testPoints.push({ x: 0, y: pixelH });
  testPoints.push({ x: pixelW, y: pixelH });

  const results: Array<{
    original: { x: number; y: number };
    afterModel: { x: number; y: number };
    afterRoundtrip: { x: number; y: number };
    error: number;
  }> = [];

  let maxError = 0;

  for (const pt of testPoints) {
    // Image -> Model
    const model = mapImageToModel(pt.x, pt.y, frameGeo);

    // Model -> Image
    const roundtrip = mapModelToImage(model.modelX, model.modelY, frameGeo);

    // Calculate error
    const error = Math.sqrt(
      Math.pow(roundtrip.imageX - pt.x, 2) + Math.pow(roundtrip.imageY - pt.y, 2)
    );

    if (error > maxError) {
      maxError = error;
    }

    results.push({
      original: pt,
      afterModel: { x: model.modelX, y: model.modelY },
      afterRoundtrip: { x: roundtrip.imageX, y: roundtrip.imageY },
      error,
    });
  }

  const passed = maxError <= 1.0;

  if (!passed) {
    console.error('========================================');
    console.error('[FrameGeo] COORDINATE ROUNDTRIP TEST FAILED!');
    console.error(`  Max error: ${maxError.toFixed(4)} px (limit: 1.0 px)`);
    console.error(`  FrameGeo: ${pixelW}x${pixelH}, padX=${letterbox.padX}, padY=${letterbox.padY}`);
    console.error('========================================');
  } else {
    console.log('[FrameGeo] Coordinate roundtrip test PASSED (max error: ' + maxError.toFixed(4) + ' px)');
  }

  return {
    passed,
    maxError,
    points: results,
    frameGeoSummary: {
      pixelW,
      pixelH,
      padX: letterbox.padX,
      padY: letterbox.padY,
      scale: letterbox.scale,
    },
  };
}

/**
 * Serialize FrameGeo for debug artifacts
 */
export function serializeFrameGeo(frameGeo: FrameGeo): SerializedFrameGeo {
  return {
    normalizedUri: frameGeo.normalizedUri,
    pixelW: frameGeo.pixelW,
    pixelH: frameGeo.pixelH,
    rotationDeg: frameGeo.rotationDeg,
    mirrored: frameGeo.mirrored,
    exifOrientation: frameGeo.exifOrientation,
    modelSize: frameGeo.modelSize,
    letterbox: {
      scale: frameGeo.letterbox.scale,
      padX: frameGeo.letterbox.padX,
      padY: frameGeo.letterbox.padY,
      srcWidth: frameGeo.letterbox.srcWidth,
      srcHeight: frameGeo.letterbox.srcHeight,
      dstWidth: frameGeo.letterbox.dstWidth,
      dstHeight: frameGeo.letterbox.dstHeight,
    },
    createdAt: frameGeo.createdAt,
    paddingAxis: frameGeo.letterbox.padX > frameGeo.letterbox.padY ? 'horizontal' : 'vertical',
  };
}
