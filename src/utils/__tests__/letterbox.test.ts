/**
 * Jest tests for letterbox and coordinate mapping utilities
 * Tests mapping invertibility and correct padding handling
 */

import {
  resizeWithLetterbox,
  mapModelToOriginalOBB,
  mapOriginalToModelOBB,
  obbToCorners,
  normalizeAngle,
  degToRad,
  radToDeg,
  pointInOBB,
  approximateOBBIoU,
} from '../letterbox';
import type { OBBDetection } from '../../types';

describe('resizeWithLetterbox', () => {
  it('should handle square image (no padding needed)', () => {
    const result = resizeWithLetterbox(640, 640, 640, 640);
    expect(result.scale).toBe(1);
    expect(result.padX).toBe(0);
    expect(result.padY).toBe(0);
    expect(result.srcWidth).toBe(640);
    expect(result.srcHeight).toBe(640);
    expect(result.dstWidth).toBe(640);
    expect(result.dstHeight).toBe(640);
  });

  it('should handle landscape image (vertical padding)', () => {
    const result = resizeWithLetterbox(1280, 640, 640, 640);
    expect(result.scale).toBe(0.5);
    expect(result.padX).toBe(0);
    expect(result.padY).toBe(160); // (640 - 320) / 2
  });

  it('should handle portrait image (horizontal padding)', () => {
    const result = resizeWithLetterbox(640, 1280, 640, 640);
    expect(result.scale).toBe(0.5);
    expect(result.padX).toBe(160); // (640 - 320) / 2
    expect(result.padY).toBe(0);
  });

  it('should handle arbitrary dimensions', () => {
    const result = resizeWithLetterbox(1920, 1080, 640, 640);
    const expectedScale = 640 / 1920; // ~0.333
    expect(result.scale).toBeCloseTo(expectedScale, 5);

    const scaledHeight = Math.round(1080 * result.scale);
    expect(result.padX).toBe(0);
    expect(result.padY).toBe(Math.round((640 - scaledHeight) / 2));
  });

  it('should handle very small images', () => {
    const result = resizeWithLetterbox(100, 50, 640, 640);
    expect(result.scale).toBe(640 / 100); // Scale up to fit width
    expect(result.padX).toBe(0);
    expect(result.padY).toBeGreaterThan(0);
  });
});

describe('mapModelToOriginalOBB and mapOriginalToModelOBB', () => {
  it('should be inverse operations (mapping invertibility)', () => {
    const letterbox = resizeWithLetterbox(1920, 1080, 640, 640);

    const originalOBB: OBBDetection = {
      cx: 960,
      cy: 540,
      width: 200,
      height: 100,
      angle: Math.PI / 4,
      score: 0.95,
      classId: 0,
    };

    // Map to model space and back
    const modelOBB = mapOriginalToModelOBB(originalOBB, letterbox);
    const backToOriginal = mapModelToOriginalOBB(modelOBB, letterbox);

    // Verify invertibility
    expect(backToOriginal.cx).toBeCloseTo(originalOBB.cx, 3);
    expect(backToOriginal.cy).toBeCloseTo(originalOBB.cy, 3);
    expect(backToOriginal.width).toBeCloseTo(originalOBB.width, 3);
    expect(backToOriginal.height).toBeCloseTo(originalOBB.height, 3);
    expect(backToOriginal.angle).toBeCloseTo(originalOBB.angle, 5);
    expect(backToOriginal.score).toBe(originalOBB.score);
    expect(backToOriginal.classId).toBe(originalOBB.classId);
  });

  it('should preserve angle through mapping', () => {
    const letterbox = resizeWithLetterbox(1280, 720, 640, 640);

    const angles = [0, Math.PI / 6, Math.PI / 4, Math.PI / 3, Math.PI / 2, -Math.PI / 4];

    for (const angle of angles) {
      const originalOBB: OBBDetection = {
        cx: 640,
        cy: 360,
        width: 100,
        height: 50,
        angle,
        score: 0.9,
        classId: 0,
      };

      const modelOBB = mapOriginalToModelOBB(originalOBB, letterbox);
      const backToOriginal = mapModelToOriginalOBB(modelOBB, letterbox);

      expect(backToOriginal.angle).toBeCloseTo(angle, 5);
    }
  });

  it('should correctly handle center point mapping', () => {
    const letterbox = resizeWithLetterbox(1920, 1080, 640, 640);

    // Image center in original space
    const originalOBB: OBBDetection = {
      cx: 960, // center of 1920
      cy: 540, // center of 1080
      width: 100,
      height: 50,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    const modelOBB = mapOriginalToModelOBB(originalOBB, letterbox);

    // In model space, the image is scaled and padded
    // After padding, the center of the scaled image should be at (320, 320) + padding offset
    const expectedCx = 960 * letterbox.scale + letterbox.padX;
    const expectedCy = 540 * letterbox.scale + letterbox.padY;

    expect(modelOBB.cx).toBeCloseTo(expectedCx, 3);
    expect(modelOBB.cy).toBeCloseTo(expectedCy, 3);
  });

  it('should correctly handle edge cases at image boundaries', () => {
    const letterbox = resizeWithLetterbox(1000, 500, 640, 640);

    // Top-left corner
    const topLeftOBB: OBBDetection = {
      cx: 50,
      cy: 25,
      width: 100,
      height: 50,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    const modelTopLeft = mapOriginalToModelOBB(topLeftOBB, letterbox);
    const backTopLeft = mapModelToOriginalOBB(modelTopLeft, letterbox);

    expect(backTopLeft.cx).toBeCloseTo(topLeftOBB.cx, 3);
    expect(backTopLeft.cy).toBeCloseTo(topLeftOBB.cy, 3);

    // Bottom-right corner
    const bottomRightOBB: OBBDetection = {
      cx: 950,
      cy: 475,
      width: 100,
      height: 50,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    const modelBottomRight = mapOriginalToModelOBB(bottomRightOBB, letterbox);
    const backBottomRight = mapModelToOriginalOBB(modelBottomRight, letterbox);

    expect(backBottomRight.cx).toBeCloseTo(bottomRightOBB.cx, 3);
    expect(backBottomRight.cy).toBeCloseTo(bottomRightOBB.cy, 3);
  });
});

describe('obbToCorners', () => {
  it('should generate correct corners for axis-aligned box', () => {
    const obb: OBBDetection = {
      cx: 100,
      cy: 100,
      width: 40,
      height: 20,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    const corners = obbToCorners(obb);

    expect(corners.topLeft.x).toBeCloseTo(80, 5);
    expect(corners.topLeft.y).toBeCloseTo(90, 5);
    expect(corners.topRight.x).toBeCloseTo(120, 5);
    expect(corners.topRight.y).toBeCloseTo(90, 5);
    expect(corners.bottomRight.x).toBeCloseTo(120, 5);
    expect(corners.bottomRight.y).toBeCloseTo(110, 5);
    expect(corners.bottomLeft.x).toBeCloseTo(80, 5);
    expect(corners.bottomLeft.y).toBeCloseTo(110, 5);
  });

  it('should rotate corners correctly at 90 degrees', () => {
    const obb: OBBDetection = {
      cx: 100,
      cy: 100,
      width: 40,
      height: 20,
      angle: Math.PI / 2, // 90 degrees CCW
      score: 0.9,
      classId: 0,
    };

    const corners = obbToCorners(obb);

    // After 90 degree CCW rotation:
    // Original corners (relative to center): TL(-20,-10), TR(20,-10), BR(20,10), BL(-20,10)
    // After rotation: x' = x*cos - y*sin, y' = x*sin + y*cos
    // cos(90) = 0, sin(90) = 1, so: x' = -y, y' = x
    // TL: x'=10, y'=-20 -> (110, 80)
    // TR: x'=10, y'=20 -> (110, 120)
    // BR: x'=-10, y'=20 -> (90, 120)
    // BL: x'=-10, y'=-20 -> (90, 80)
    expect(corners.topLeft.x).toBeCloseTo(110, 3);
    expect(corners.topLeft.y).toBeCloseTo(80, 3);
    expect(corners.topRight.x).toBeCloseTo(110, 3);
    expect(corners.topRight.y).toBeCloseTo(120, 3);
    expect(corners.bottomRight.x).toBeCloseTo(90, 3);
    expect(corners.bottomRight.y).toBeCloseTo(120, 3);
    expect(corners.bottomLeft.x).toBeCloseTo(90, 3);
    expect(corners.bottomLeft.y).toBeCloseTo(80, 3);
  });

  it('should maintain corner distances from center', () => {
    const obb: OBBDetection = {
      cx: 200,
      cy: 150,
      width: 100,
      height: 60,
      angle: Math.PI / 6,
      score: 0.9,
      classId: 0,
    };

    const corners = obbToCorners(obb);
    const halfDiag = Math.sqrt(50 * 50 + 30 * 30);

    // Each corner should be at the same distance from center
    const distances = [
      Math.sqrt((corners.topLeft.x - obb.cx) ** 2 + (corners.topLeft.y - obb.cy) ** 2),
      Math.sqrt((corners.topRight.x - obb.cx) ** 2 + (corners.topRight.y - obb.cy) ** 2),
      Math.sqrt((corners.bottomRight.x - obb.cx) ** 2 + (corners.bottomRight.y - obb.cy) ** 2),
      Math.sqrt((corners.bottomLeft.x - obb.cx) ** 2 + (corners.bottomLeft.y - obb.cy) ** 2),
    ];

    for (const dist of distances) {
      expect(dist).toBeCloseTo(halfDiag, 3);
    }
  });
});

describe('normalizeAngle', () => {
  it('should normalize angles within [-PI, PI]', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(Math.PI)).toBeCloseTo(Math.PI, 5);
    expect(normalizeAngle(-Math.PI)).toBeCloseTo(-Math.PI, 5);
    expect(normalizeAngle(Math.PI * 2)).toBeCloseTo(0, 5);
    expect(normalizeAngle(-Math.PI * 2)).toBeCloseTo(0, 5);
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 5);
    expect(normalizeAngle(-Math.PI * 3)).toBeCloseTo(-Math.PI, 5);
  });
});

describe('degToRad and radToDeg', () => {
  it('should convert correctly', () => {
    expect(degToRad(0)).toBe(0);
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2, 5);
    expect(degToRad(180)).toBeCloseTo(Math.PI, 5);
    expect(degToRad(360)).toBeCloseTo(Math.PI * 2, 5);

    expect(radToDeg(0)).toBe(0);
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90, 5);
    expect(radToDeg(Math.PI)).toBeCloseTo(180, 5);
    expect(radToDeg(Math.PI * 2)).toBeCloseTo(360, 5);
  });

  it('should be inverse operations', () => {
    const angles = [0, 30, 45, 60, 90, 120, 180, 270, 360];
    for (const deg of angles) {
      expect(radToDeg(degToRad(deg))).toBeCloseTo(deg, 5);
    }
  });
});

describe('pointInOBB', () => {
  it('should detect point inside axis-aligned OBB', () => {
    const obb: OBBDetection = {
      cx: 100,
      cy: 100,
      width: 40,
      height: 20,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    expect(pointInOBB(100, 100, obb)).toBe(true); // center
    expect(pointInOBB(90, 95, obb)).toBe(true); // inside
    expect(pointInOBB(80, 90, obb)).toBe(true); // on edge
    expect(pointInOBB(70, 100, obb)).toBe(false); // outside
    expect(pointInOBB(100, 80, obb)).toBe(false); // outside
  });

  it('should detect point inside rotated OBB', () => {
    const obb: OBBDetection = {
      cx: 100,
      cy: 100,
      width: 40,
      height: 20,
      angle: Math.PI / 4, // 45 degrees
      score: 0.9,
      classId: 0,
    };

    expect(pointInOBB(100, 100, obb)).toBe(true); // center
    // A point that would be inside if axis-aligned but outside when rotated
    expect(pointInOBB(115, 108, obb)).toBe(true);
    // A point that would be outside the rotated box
    expect(pointInOBB(125, 100, obb)).toBe(false);
  });
});

describe('approximateOBBIoU', () => {
  it('should return 1 for identical OBBs', () => {
    const obb: OBBDetection = {
      cx: 100,
      cy: 100,
      width: 40,
      height: 20,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    expect(approximateOBBIoU(obb, obb)).toBeCloseTo(1, 3);
  });

  it('should return 0 for non-overlapping OBBs', () => {
    const obb1: OBBDetection = {
      cx: 50,
      cy: 50,
      width: 40,
      height: 20,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    const obb2: OBBDetection = {
      cx: 200,
      cy: 200,
      width: 40,
      height: 20,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    expect(approximateOBBIoU(obb1, obb2)).toBe(0);
  });

  it('should return partial overlap value', () => {
    const obb1: OBBDetection = {
      cx: 100,
      cy: 100,
      width: 40,
      height: 40,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    const obb2: OBBDetection = {
      cx: 120,
      cy: 100,
      width: 40,
      height: 40,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    const iou = approximateOBBIoU(obb1, obb2);
    expect(iou).toBeGreaterThan(0);
    expect(iou).toBeLessThan(1);
  });
});

// NOTE: generateCoordinateTestArtifact moved to ../letterbox.ts for production use
// Tests should only import, never export production utilities
