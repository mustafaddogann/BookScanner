/**
 * Jest tests for rectification service geometry utilities
 * Tests corner computation and destination size calculation
 */

import { computeCorners } from '../rectificationService';
import type { OBBDetection } from '../../types';

describe('computeCorners', () => {
  it('should compute correct corners for axis-aligned box', () => {
    const obb: OBBDetection = {
      cx: 100,
      cy: 100,
      width: 40,
      height: 20,
      angle: 0,
      score: 0.9,
      classId: 0,
    };

    const corners = computeCorners(obb);

    // For axis-aligned (angle=0) box:
    // width=40, height=20, centered at (100,100)
    // topLeft = (100-20, 100-10) = (80, 90)
    // topRight = (100+20, 100-10) = (120, 90)
    // bottomRight = (100+20, 100+10) = (120, 110)
    // bottomLeft = (100-20, 100+10) = (80, 110)
    expect(corners.topLeft.x).toBeCloseTo(80, 3);
    expect(corners.topLeft.y).toBeCloseTo(90, 3);
    expect(corners.topRight.x).toBeCloseTo(120, 3);
    expect(corners.topRight.y).toBeCloseTo(90, 3);
    expect(corners.bottomRight.x).toBeCloseTo(120, 3);
    expect(corners.bottomRight.y).toBeCloseTo(110, 3);
    expect(corners.bottomLeft.x).toBeCloseTo(80, 3);
    expect(corners.bottomLeft.y).toBeCloseTo(110, 3);
  });

  it('should compute rotated corners at 45 degrees', () => {
    const obb: OBBDetection = {
      cx: 100,
      cy: 100,
      width: 40,
      height: 20,
      angle: Math.PI / 4, // 45 degrees
      score: 0.9,
      classId: 0,
    };

    const corners = computeCorners(obb);

    // Verify all corners are equidistant from center
    const halfDiag = Math.sqrt(20 * 20 + 10 * 10);
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

  it('should maintain rectangular shape for rotated box', () => {
    const obb: OBBDetection = {
      cx: 200,
      cy: 150,
      width: 100,
      height: 60,
      angle: Math.PI / 6, // 30 degrees
      score: 0.9,
      classId: 0,
    };

    const corners = computeCorners(obb);

    // Calculate edge lengths
    const topEdge = Math.sqrt(
      (corners.topRight.x - corners.topLeft.x) ** 2 +
      (corners.topRight.y - corners.topLeft.y) ** 2
    );
    const bottomEdge = Math.sqrt(
      (corners.bottomRight.x - corners.bottomLeft.x) ** 2 +
      (corners.bottomRight.y - corners.bottomLeft.y) ** 2
    );
    const leftEdge = Math.sqrt(
      (corners.bottomLeft.x - corners.topLeft.x) ** 2 +
      (corners.bottomLeft.y - corners.topLeft.y) ** 2
    );
    const rightEdge = Math.sqrt(
      (corners.bottomRight.x - corners.topRight.x) ** 2 +
      (corners.bottomRight.y - corners.topRight.y) ** 2
    );

    // Opposite edges should be equal
    expect(topEdge).toBeCloseTo(bottomEdge, 3);
    expect(leftEdge).toBeCloseTo(rightEdge, 3);

    // Edge lengths should match OBB dimensions
    expect(topEdge).toBeCloseTo(obb.width, 3);
    expect(leftEdge).toBeCloseTo(obb.height, 3);
  });

  it('should handle negative angles', () => {
    const obb: OBBDetection = {
      cx: 100,
      cy: 100,
      width: 40,
      height: 20,
      angle: -Math.PI / 4, // -45 degrees
      score: 0.9,
      classId: 0,
    };

    const corners = computeCorners(obb);

    // Verify all corners are equidistant from center
    const halfDiag = Math.sqrt(20 * 20 + 10 * 10);
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

  it('should handle 90 degree rotation', () => {
    const obb: OBBDetection = {
      cx: 100,
      cy: 100,
      width: 40,
      height: 20,
      angle: Math.PI / 2, // 90 degrees
      score: 0.9,
      classId: 0,
    };

    const corners = computeCorners(obb);

    // At 90 degrees, width and height are effectively swapped visually
    // The bounding box should now extend 10 units in x and 20 units in y
    const topEdge = Math.sqrt(
      (corners.topRight.x - corners.topLeft.x) ** 2 +
      (corners.topRight.y - corners.topLeft.y) ** 2
    );
    const leftEdge = Math.sqrt(
      (corners.bottomLeft.x - corners.topLeft.x) ** 2 +
      (corners.bottomLeft.y - corners.topLeft.y) ** 2
    );

    expect(topEdge).toBeCloseTo(obb.width, 3);
    expect(leftEdge).toBeCloseTo(obb.height, 3);
  });

  it('should handle typical book spine dimensions', () => {
    // Simulating a tall, narrow book spine
    const obb: OBBDetection = {
      cx: 500,
      cy: 400,
      width: 30,
      height: 200,
      angle: 0.1, // slight tilt
      score: 0.85,
      classId: 0,
    };

    const corners = computeCorners(obb);

    // All corners should be valid coordinates
    expect(corners.topLeft.x).toBeGreaterThan(0);
    expect(corners.topLeft.y).toBeGreaterThan(0);
    expect(corners.bottomRight.x).toBeGreaterThan(corners.topLeft.x);
    expect(corners.bottomRight.y).toBeGreaterThan(corners.topLeft.y);

    // Verify aspect ratio is preserved
    const topEdge = Math.sqrt(
      (corners.topRight.x - corners.topLeft.x) ** 2 +
      (corners.topRight.y - corners.topLeft.y) ** 2
    );
    const leftEdge = Math.sqrt(
      (corners.bottomLeft.x - corners.topLeft.x) ** 2 +
      (corners.bottomLeft.y - corners.topLeft.y) ** 2
    );

    expect(topEdge).toBeCloseTo(obb.width, 3);
    expect(leftEdge).toBeCloseTo(obb.height, 3);
  });
});
