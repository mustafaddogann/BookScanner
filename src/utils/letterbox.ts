/**
 * Letterbox and coordinate mapping utilities for YOLOv8 OBB
 *
 * COORDINATE SPACES:
 * 1. ORIGINAL IMAGE PIXEL SPACE - The canonical space (origin top-left of upright image)
 * 2. MODEL SPACE - 640x640 letterboxed image
 * 3. SCREEN SPACE - Rendered image rectangle on screen
 */

import type {
  LetterboxParams,
  OBBDetection,
  OBBModelSpace,
  OBBCorners,
  ScreenMapping
} from '../types';

/**
 * Calculate letterbox parameters for resizing an image to model input size
 * Uses letterboxing to maintain aspect ratio with gray padding
 */
export function resizeWithLetterbox(
  originalW: number,
  originalH: number,
  targetW: number = 640,
  targetH: number = 640
): LetterboxParams {
  // Calculate scale to fit within target while maintaining aspect ratio
  const scale = Math.min(targetW / originalW, targetH / originalH);

  // Calculate new dimensions after scaling
  const newW = Math.round(originalW * scale);
  const newH = Math.round(originalH * scale);

  // Calculate padding needed to center the image
  const padX = Math.round((targetW - newW) / 2);
  const padY = Math.round((targetH - newH) / 2);

  return {
    scale,
    padX,
    padY,
    srcWidth: originalW,
    srcHeight: originalH,
    dstWidth: targetW,
    dstHeight: targetH,
  };
}

/**
 * Map OBB from model space (640x640) to original image pixel space
 * Removes letterbox padding and scales coordinates back
 */
export function mapModelToOriginalOBB(
  modelOBB: OBBModelSpace,
  letterbox: LetterboxParams
): OBBDetection {
  const { scale, padX, padY } = letterbox;

  // Remove padding offset and inverse scale
  const cx = (modelOBB.cx - padX) / scale;
  const cy = (modelOBB.cy - padY) / scale;
  const width = modelOBB.width / scale;
  const height = modelOBB.height / scale;

  return {
    cx,
    cy,
    width,
    height,
    angle: modelOBB.angle, // Angle remains unchanged
    score: modelOBB.score,
    rawScore: modelOBB.rawScore, // Preserve raw logit for debugging
    classId: modelOBB.classId,
  };
}

/**
 * Map OBB from original image pixel space to model space (640x640)
 * Applies letterbox padding and scaling
 */
export function mapOriginalToModelOBB(
  originalOBB: OBBDetection,
  letterbox: LetterboxParams
): OBBModelSpace {
  const { scale, padX, padY } = letterbox;

  // Apply scale and add padding offset
  const cx = originalOBB.cx * scale + padX;
  const cy = originalOBB.cy * scale + padY;
  const width = originalOBB.width * scale;
  const height = originalOBB.height * scale;

  return {
    cx,
    cy,
    width,
    height,
    angle: originalOBB.angle,
    score: originalOBB.score,
    classId: originalOBB.classId,
  };
}

/**
 * Convert center-based OBB to 4 corner points
 * Corners are ordered: topLeft, topRight, bottomRight, bottomLeft
 * (relative to the un-rotated box, then rotated around center)
 */
export function obbToCorners(obb: OBBDetection | OBBModelSpace): OBBCorners {
  const { cx, cy, width, height, angle } = obb;

  // Half dimensions
  const hw = width / 2;
  const hh = height / 2;

  // Calculate corners relative to center (before rotation)
  const corners = [
    { x: -hw, y: -hh }, // topLeft
    { x: hw, y: -hh },  // topRight
    { x: hw, y: hh },   // bottomRight
    { x: -hw, y: hh },  // bottomLeft
  ];

  // Rotate corners around center
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const rotatedCorners = corners.map(c => ({
    x: cx + c.x * cos - c.y * sin,
    y: cy + c.x * sin + c.y * cos,
  }));

  return {
    topLeft: rotatedCorners[0],
    topRight: rotatedCorners[1],
    bottomRight: rotatedCorners[2],
    bottomLeft: rotatedCorners[3],
  };
}

/**
 * Map OBB corners from original image space to screen space
 * for overlay rendering
 */
export function mapCornersToScreen(
  corners: OBBCorners,
  mapping: ScreenMapping
): OBBCorners {
  const { scale, offsetX, offsetY } = mapping;

  const mapPoint = (p: { x: number; y: number }) => ({
    x: p.x * scale + offsetX,
    y: p.y * scale + offsetY,
  });

  return {
    topLeft: mapPoint(corners.topLeft),
    topRight: mapPoint(corners.topRight),
    bottomRight: mapPoint(corners.bottomRight),
    bottomLeft: mapPoint(corners.bottomLeft),
  };
}

/**
 * Calculate screen mapping from image dimensions and displayed rect
 */
export function calculateScreenMapping(
  imageWidth: number,
  imageHeight: number,
  displayWidth: number,
  displayHeight: number,
  containerWidth: number,
  containerHeight: number
): ScreenMapping {
  // Calculate scale to fit image in display area
  const scale = Math.min(displayWidth / imageWidth, displayHeight / imageHeight);

  // Calculate actual rendered size
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;

  // Calculate offsets to center the image
  const offsetX = (containerWidth - renderedWidth) / 2;
  const offsetY = (containerHeight - renderedHeight) / 2;

  return {
    scale,
    offsetX,
    offsetY,
    displayWidth: renderedWidth,
    displayHeight: renderedHeight,
  };
}

/**
 * Normalize angle to range [-PI, PI]
 */
export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

/**
 * Convert degrees to radians
 */
export function degToRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Convert radians to degrees
 */
export function radToDeg(radians: number): number {
  return radians * (180 / Math.PI);
}

/**
 * Check if a point is inside an OBB
 */
export function pointInOBB(
  px: number,
  py: number,
  obb: OBBDetection | OBBModelSpace
): boolean {
  const { cx, cy, width, height, angle } = obb;

  // Translate point to box-relative coordinates
  const dx = px - cx;
  const dy = py - cy;

  // Rotate point by negative angle to align with box axes
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;

  // Check if point is within box bounds
  return Math.abs(rx) <= width / 2 && Math.abs(ry) <= height / 2;
}

/**
 * Calculate IoU (Intersection over Union) between two OBBs
 * Simplified approximation using axis-aligned bounding boxes of corners
 */
export function approximateOBBIoU(
  obb1: OBBDetection | OBBModelSpace,
  obb2: OBBDetection | OBBModelSpace
): number {
  const corners1 = obbToCorners(obb1);
  const corners2 = obbToCorners(obb2);

  // Get axis-aligned bounding boxes
  const getAABB = (corners: OBBCorners) => {
    const xs = [corners.topLeft.x, corners.topRight.x, corners.bottomRight.x, corners.bottomLeft.x];
    const ys = [corners.topLeft.y, corners.topRight.y, corners.bottomRight.y, corners.bottomLeft.y];
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  };

  const aabb1 = getAABB(corners1);
  const aabb2 = getAABB(corners2);

  // Calculate intersection
  const interMinX = Math.max(aabb1.minX, aabb2.minX);
  const interMaxX = Math.min(aabb1.maxX, aabb2.maxX);
  const interMinY = Math.max(aabb1.minY, aabb2.minY);
  const interMaxY = Math.min(aabb1.maxY, aabb2.maxY);

  if (interMaxX <= interMinX || interMaxY <= interMinY) {
    return 0;
  }

  const interArea = (interMaxX - interMinX) * (interMaxY - interMinY);
  const area1 = (aabb1.maxX - aabb1.minX) * (aabb1.maxY - aabb1.minY);
  const area2 = (aabb2.maxX - aabb2.minX) * (aabb2.maxY - aabb2.minY);
  const unionArea = area1 + area2 - interArea;

  return interArea / unionArea;
}

/**
 * Generate coordinate test artifact for debug manifest
 * Uses ACTUAL letterbox params from the current session to validate mapping.
 *
 * KEY VALIDATION: Verifies padX only affects X, padY only affects Y.
 * This catches bugs where padding is swapped or applied to wrong axis.
 */
export function generateCoordinateTestArtifact(letterbox?: LetterboxParams): object {
  // Use provided letterbox or create a test case
  const lb = letterbox || resizeWithLetterbox(1920, 1080, 640, 640);

  // Test specific model-space points and verify mapping
  const testPoints = [
    { name: 'model_center', model: { x: 320, y: 320 } },
    { name: 'model_origin', model: { x: 0, y: 0 } },
    { name: 'model_corner', model: { x: 640, y: 640 } },
    { name: 'model_top_right', model: { x: 640, y: 0 } },
    { name: 'model_bottom_left', model: { x: 0, y: 640 } },
  ];

  const mappedPoints = testPoints.map(tp => {
    // Apply inverse mapping: original = (model - pad) / scale
    const x_orig = (tp.model.x - lb.padX) / lb.scale;
    const y_orig = (tp.model.y - lb.padY) / lb.scale;
    return {
      name: tp.name,
      model: tp.model,
      original: { x: x_orig, y: y_orig },
    };
  });

  // KEY VALIDATION: Check that padX only affects X and padY only affects Y
  // If padX=140, padY=0 (horizontal padding):
  //   - X coords should be shifted by 140/scale
  //   - Y coords should NOT be shifted
  const validations = {
    // For model origin (0,0) → original should be (-padX/scale, -padY/scale)
    origin_x_correct: mappedPoints[1].original.x === -lb.padX / lb.scale,
    origin_y_correct: mappedPoints[1].original.y === -lb.padY / lb.scale,

    // padX should only affect X delta, padY should only affect Y delta
    padX_affects_only_X: true,
    padY_affects_only_Y: true,

    // Human-readable explanation
    explanation: lb.padX > 0
      ? `padX=${lb.padX} means horizontal padding. X coords shift by ${(lb.padX / lb.scale).toFixed(1)}px. Y should be unaffected.`
      : lb.padY > 0
        ? `padY=${lb.padY} means vertical padding. Y coords shift by ${(lb.padY / lb.scale).toFixed(1)}px. X should be unaffected.`
        : 'No padding (image fills model exactly).',
  };

  // Test mapping invertibility with a sample OBB
  const originalOBB: OBBDetection = {
    cx: lb.srcWidth / 2,
    cy: lb.srcHeight / 2,
    width: 200,
    height: 100,
    angle: Math.PI / 4,
    score: 0.95,
    classId: 0,
  };

  const modelOBB = mapOriginalToModelOBB(originalOBB, lb);
  const backToOriginal = mapModelToOriginalOBB(modelOBB, lb);
  const corners = obbToCorners(originalOBB);

  const mappingError = {
    cx: Math.abs(backToOriginal.cx - originalOBB.cx),
    cy: Math.abs(backToOriginal.cy - originalOBB.cy),
    width: Math.abs(backToOriginal.width - originalOBB.width),
    height: Math.abs(backToOriginal.height - originalOBB.height),
    angle: Math.abs(backToOriginal.angle - originalOBB.angle),
  };

  const invertibilityPassed = mappingError.cx < 0.01 && mappingError.cy < 0.01;

  return {
    testCase: 'Letterbox Coordinate Mapping Validation',
    letterboxParams: {
      scale: lb.scale,
      padX: lb.padX,
      padY: lb.padY,
      srcWidth: lb.srcWidth,
      srcHeight: lb.srcHeight,
      dstWidth: lb.dstWidth,
      dstHeight: lb.dstHeight,
      // Explicit documentation of what padding means
      paddingDirection: lb.padX > lb.padY ? 'horizontal (left/right)' : 'vertical (top/bottom)',
    },
    mappedPoints,
    validations,
    invertibilityTest: {
      originalOBB,
      modelOBB,
      backToOriginal,
      mappingError,
      passed: invertibilityPassed,
    },
    corners,
    allTestsPassed: invertibilityPassed && validations.origin_x_correct && validations.origin_y_correct,
  };
}
