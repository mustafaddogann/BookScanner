/**
 * Unit tests for bookCandidateGrouper (Gate 7) - CONSERVATIVE GROUPING
 *
 * Tests verify that grouping is conservative by default:
 * - No merge unless strong evidence of duplicates or split-detection
 * - Merges only on: IoU >= 0.50 OR (angle <= 10°, close centers, OCR similarity >= 0.75)
 * - Safety cap: if any candidate would have > 3 crops, fall back to 1:1
 */

import { groupDetectionsIntoCandidates, GroupingInput } from '../bookCandidateGrouper';
import type { OBBDetection, OCRResult } from '../../types';
import type { DetectionRectifyInfo } from '../../store/useAppStore';

// Suppress console.log during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('groupDetectionsIntoCandidates - Conservative Algorithm', () => {
  // Helper to create a detection at a specific position
  const makeDetection = (
    cx: number,
    cy: number,
    width: number,
    height: number,
    angle: number,
    score: number
  ): OBBDetection => ({
    cx,
    cy,
    width,
    height,
    angle, // radians
    score,
    classId: 0,
    className: 'book_spine',
  });

  // Helper to create rectification info
  const makeRectInfo = (detectionIndex: number, hasCrop: boolean = true): DetectionRectifyInfo => ({
    detectionIndex,
    cropPath: hasCrop ? `/path/to/crop_${detectionIndex}.jpg` : null,
    cropUri: hasCrop ? `file:///path/to/crop_${detectionIndex}.jpg` : null,
    cropWidth: hasCrop ? 100 : 0,
    cropHeight: hasCrop ? 200 : 0,
    rectificationMethod: hasCrop ? 'native_opencv' : 'skipped',
    skippedReason: hasCrop ? undefined : 'test_skip',
  });

  // Helper to create OCR result
  const makeOCRResult = (text: string): OCRResult => {
    const lines = text.split('\n');
    return {
      ok: true,
      fullText: text,
      lines: lines.map((line, i) => ({
        text: line,
        confidence: 0.95,
        bbox: { x: 0, y: i * 20, width: 100, height: 20 },
      })),
      chosenRotation: 0,
      avgConfidence: 0.95,
      alnumRatio: 0.9,
      charCount: text.length,
      lineCount: lines.length,
      titleCandidate: null,
      authorCandidate: null,
    };
  };

  describe('empty input', () => {
    it('should return empty result for no detections', () => {
      const input: GroupingInput = {
        detections: [],
        rectificationResults: [],
        sessionId: 'test_session',
      };

      const result = groupDetectionsIntoCandidates(input);

      expect(result.candidates).toHaveLength(0);
      expect(result.summary).toEqual({
        rawDetections: 0,
        rawCrops: 0,
        candidates: 0,
        avgCropsPerCandidate: 0,
      });
      expect(result.debugAssignments.safetyFallbackTriggered).toBe(false);
    });
  });

  describe('no merge by default', () => {
    it('should NOT merge 10 detections that are far apart', () => {
      // Create 10 detections spread across the image (far apart)
      const detections: OBBDetection[] = [];
      for (let i = 0; i < 10; i++) {
        // Each spine is 200px apart horizontally - well beyond any merge threshold
        detections.push(makeDetection(100 + i * 200, 300, 40, 150, 0.1, 0.9 - i * 0.01));
      }

      const input: GroupingInput = {
        detections,
        rectificationResults: detections.map((_, i) => makeRectInfo(i)),
        sessionId: 'test_10_separate',
      };

      const result = groupDetectionsIntoCandidates(input);

      // Should produce 10 separate candidates - one for each detection
      expect(result.candidates).toHaveLength(10);
      expect(result.summary.candidates).toBe(10);
      expect(result.summary.rawDetections).toBe(10);
      expect(result.debugAssignments.merges).toHaveLength(0);
      expect(result.debugAssignments.safetyFallbackTriggered).toBe(false);
    });

    it('should NOT merge detections with different angles even if close', () => {
      // Two detections at nearby positions but very different angles
      const detections = [
        makeDetection(100, 200, 50, 150, 0.0, 0.9),    // 0 degrees
        makeDetection(105, 205, 50, 150, 0.5, 0.85),   // ~29 degrees (> 10° threshold)
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'test_angle_diff',
      };

      const result = groupDetectionsIntoCandidates(input);

      // Should produce 2 separate candidates due to angle difference
      expect(result.candidates).toHaveLength(2);
      expect(result.debugAssignments.merges).toHaveLength(0);
    });

    it('should NOT merge nearby detections without OCR similarity', () => {
      // Two detections with different heights - this gives low IoU (<0.5) while
      // center distance is within split-detection threshold (15% of min dimension).
      // Without OCR, the split-detection path should NOT merge.
      const detections = [
        makeDetection(100, 200, 100, 400, 0.05, 0.9),   // Tall box
        makeDetection(114, 200, 100, 200, 0.06, 0.85), // Shorter box, 14px shift
        // IoU ≈ 0.40, center dist = 14px < 15px threshold (min dim = 100)
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'test_no_ocr',
        // No ocrResultsByCropIndex provided - this is the key
      };

      const result = groupDetectionsIntoCandidates(input);

      // Without OCR confirmation, split-detection path should not merge
      // (IoU is < 0.5 so IoU path doesn't fire either)
      expect(result.candidates).toHaveLength(2);
    });
  });

  describe('merge duplicates (high IoU)', () => {
    it('should merge two nearly identical detections with high IoU', () => {
      // Two detections that almost completely overlap (>= 50% IoU)
      // Same center, same size, same angle - this is a duplicate detection
      const detections = [
        makeDetection(100, 200, 50, 150, 0.1, 0.9),
        makeDetection(100, 200, 50, 150, 0.1, 0.85), // Identical position
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'test_duplicate',
      };

      const result = groupDetectionsIntoCandidates(input);

      // Should merge into 1 candidate (high IoU duplicate)
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].detectionIndices).toHaveLength(2);
      expect(result.candidates[0].detectionIndices).toContain(0);
      expect(result.candidates[0].detectionIndices).toContain(1);
      expect(result.summary.candidates).toBe(1);

      // Should have a merge record with iou_duplicate reason
      expect(result.debugAssignments.merges.length).toBeGreaterThan(0);
      expect(result.debugAssignments.merges[0].reason).toBe('iou_duplicate');
      expect(result.debugAssignments.merges[0].iou).toBeGreaterThanOrEqual(0.5);
    });

    it('should merge overlapping detections with >= 50% IoU', () => {
      // Two detections with significant overlap
      // Shift by ~20% of dimension to get ~50% overlap
      const detections = [
        makeDetection(100, 200, 100, 200, 0.0, 0.9),
        makeDetection(120, 200, 100, 200, 0.0, 0.85), // Shifted 20px on 100px width
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'test_high_iou',
      };

      const result = groupDetectionsIntoCandidates(input);

      // With 80px overlap on 100px boxes, IoU should be >= 0.5
      expect(result.candidates).toHaveLength(1);
      expect(result.debugAssignments.merges[0].reason).toBe('iou_duplicate');
    });
  });

  describe('split merge with OCR similarity', () => {
    it('should merge split-detection when OCR confirms same text', () => {
      // Two detections with different heights: low IoU (<0.5) but close centers
      // Center distance within threshold, similar angle, and OCR confirms similarity
      const detections = [
        makeDetection(100, 200, 100, 400, 0.05, 0.9),   // Tall box
        makeDetection(114, 200, 100, 200, 0.06, 0.85), // Shorter box, 14px shift
        // IoU ≈ 0.40, center dist = 14px < 15px threshold (min dim = 100)
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'test_split_ocr',
        ocrResultsByCropIndex: {
          0: makeOCRResult('THE GREAT GATSBY F SCOTT FITZGERALD'),
          1: makeOCRResult('THE GREAT GATSBY F. SCOTT FITZGERALD'), // Very similar text
        },
      };

      const result = groupDetectionsIntoCandidates(input);

      // Should merge due to split-detection with OCR confirmation
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].detectionIndices).toHaveLength(2);

      // Check merge record - should be split_detection (not iou_duplicate since IoU < 0.5)
      const merges = result.debugAssignments.merges;
      expect(merges.length).toBeGreaterThan(0);
      expect(merges[0].reason).toBe('split_detection');
      expect(merges[0].textSim).not.toBeNull();
      expect(merges[0].textSim!).toBeGreaterThanOrEqual(0.75);
    });
  });

  describe('no split merge without OCR similarity', () => {
    it('should NOT merge split-detection when OCR text is different', () => {
      // Two detections with different heights: low IoU (<0.5) but close centers
      // This tests that different OCR text prevents the split-detection merge
      const detections = [
        makeDetection(100, 200, 100, 400, 0.05, 0.9),   // Tall box
        makeDetection(114, 200, 100, 200, 0.06, 0.85), // Shorter box, 14px shift
        // IoU ≈ 0.40, center dist = 14px < 15px threshold (min dim = 100)
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'test_diff_text',
        ocrResultsByCropIndex: {
          0: makeOCRResult('THE GREAT GATSBY'),
          1: makeOCRResult('PRIDE AND PREJUDICE'), // Completely different text
        },
      };

      const result = groupDetectionsIntoCandidates(input);

      // Should NOT merge - OCR confirms different books
      expect(result.candidates).toHaveLength(2);
      expect(result.debugAssignments.merges).toHaveLength(0);
    });

    it('should NOT merge when OCR similarity is below threshold (0.75)', () => {
      // Two detections with different heights: low IoU (<0.5) but close centers
      // This tests that low OCR similarity prevents the split-detection merge
      const detections = [
        makeDetection(100, 200, 100, 400, 0.05, 0.9),   // Tall box
        makeDetection(114, 200, 100, 200, 0.06, 0.85), // Shorter box, 14px shift
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'test_low_sim',
        ocrResultsByCropIndex: {
          0: makeOCRResult('THE GREAT GATSBY'),
          1: makeOCRResult('CRIME AND PUNISHMENT'), // Completely different
        },
      };

      const result = groupDetectionsIntoCandidates(input);

      // Should NOT merge - OCR similarity too low
      expect(result.candidates).toHaveLength(2);
    });
  });

  describe('safety cap fallback', () => {
    it('should trigger safety fallback when a candidate would have > 3 crops', () => {
      // Create 5 detections that all overlap significantly (forcing merge)
      // This should trigger the safety cap since 5 > MAX_CROPS_PER_CANDIDATE (3)
      const detections: OBBDetection[] = [];
      for (let i = 0; i < 5; i++) {
        // All at nearly the same position - will all merge together
        detections.push(makeDetection(100, 200, 100, 200, 0.0, 0.9 - i * 0.01));
      }

      const input: GroupingInput = {
        detections,
        rectificationResults: detections.map((_, i) => makeRectInfo(i)),
        sessionId: 'test_safety_cap',
      };

      const result = groupDetectionsIntoCandidates(input);

      // Safety fallback should be triggered
      expect(result.debugAssignments.safetyFallbackTriggered).toBe(true);

      // Should fall back to 5 separate candidates (1:1 mapping)
      expect(result.candidates).toHaveLength(5);
      expect(result.summary.candidates).toBe(5);

      // Each candidate should have exactly 1 detection
      for (const candidate of result.candidates) {
        expect(candidate.detectionIndices).toHaveLength(1);
        expect(candidate.cropIndices).toHaveLength(1);
      }
    });

    it('should NOT trigger safety fallback when clusters are small', () => {
      // Create 2 pairs of duplicates (2 clusters of 2 each)
      const detections = [
        makeDetection(100, 200, 100, 200, 0.0, 0.9),  // Cluster 1
        makeDetection(100, 200, 100, 200, 0.0, 0.85), // Cluster 1 (duplicate)
        makeDetection(400, 200, 100, 200, 0.0, 0.8),  // Cluster 2
        makeDetection(400, 200, 100, 200, 0.0, 0.75), // Cluster 2 (duplicate)
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: detections.map((_, i) => makeRectInfo(i)),
        sessionId: 'test_no_safety',
      };

      const result = groupDetectionsIntoCandidates(input);

      // Should NOT trigger safety fallback (max cluster size is 2, <= 3)
      expect(result.debugAssignments.safetyFallbackTriggered).toBe(false);

      // Should have 2 candidates (one per cluster)
      expect(result.candidates).toHaveLength(2);
    });
  });

  describe('stable left-to-right ordering', () => {
    it('should order candidates left-to-right by centroid X', () => {
      // Three detections at different X positions, added in random order
      const detections = [
        makeDetection(500, 200, 50, 150, 0.1, 0.9),   // Rightmost
        makeDetection(100, 200, 50, 150, 0.1, 0.85),  // Leftmost
        makeDetection(300, 200, 50, 150, 0.1, 0.8),   // Middle
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1), makeRectInfo(2)],
        sessionId: 'test_ordering',
      };

      const result = groupDetectionsIntoCandidates(input);

      // Should have 3 candidates ordered left-to-right
      expect(result.candidates).toHaveLength(3);

      // orderingKey should be 0, 1, 2 for left-to-right
      expect(result.candidates[0].orderingKey).toBe(0);
      expect(result.candidates[1].orderingKey).toBe(1);
      expect(result.candidates[2].orderingKey).toBe(2);

      // First candidate (orderingKey=0) should be the leftmost (detectionIndex 1, cx=100)
      expect(result.candidates[0].representativeDetectionIndex).toBe(1);
      // Second candidate should be middle (detectionIndex 2, cx=300)
      expect(result.candidates[1].representativeDetectionIndex).toBe(2);
      // Third candidate should be rightmost (detectionIndex 0, cx=500)
      expect(result.candidates[2].representativeDetectionIndex).toBe(0);
    });
  });

  describe('representative selection', () => {
    it('should select detection with highest score as representative', () => {
      // Two overlapping detections with different scores (will merge due to high IoU)
      const detections = [
        makeDetection(100, 200, 100, 200, 0.0, 0.7),   // Lower score
        makeDetection(100, 200, 100, 200, 0.0, 0.95),  // Higher score
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'test_rep_score',
      };

      const result = groupDetectionsIntoCandidates(input);

      expect(result.candidates).toHaveLength(1);
      // Detection 1 has higher score (0.95), should be representative
      expect(result.candidates[0].representativeDetectionIndex).toBe(1);
      expect(result.candidates[0].confidenceScore).toBe(0.95);
    });
  });

  describe('crop mapping', () => {
    it('should correctly map detection indices to crop indices', () => {
      // Two overlapping detections (will merge)
      const detections = [
        makeDetection(100, 200, 100, 200, 0.0, 0.9),
        makeDetection(100, 200, 100, 200, 0.0, 0.85),
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'test_crop_map',
      };

      const result = groupDetectionsIntoCandidates(input);

      expect(result.candidates[0].cropIndices).toContain(0);
      expect(result.candidates[0].cropIndices).toContain(1);
      expect(result.summary.rawCrops).toBe(2);
    });

    it('should exclude skipped crops from crop indices', () => {
      // Two overlapping detections (will merge), but one has no crop
      const detections = [
        makeDetection(100, 200, 100, 200, 0.0, 0.9),
        makeDetection(100, 200, 100, 200, 0.0, 0.85),
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [
          makeRectInfo(0, true),   // Has crop
          makeRectInfo(1, false),  // Skipped
        ],
        sessionId: 'test_skipped_crop',
      };

      const result = groupDetectionsIntoCandidates(input);

      // Both detections cluster together
      expect(result.candidates).toHaveLength(1);
      // But only one crop
      expect(result.candidates[0].cropIndices).toHaveLength(1);
      expect(result.candidates[0].cropIndices).toContain(0);
      expect(result.summary.rawCrops).toBe(1);
    });
  });

  describe('candidate ID generation', () => {
    it('should generate unique IDs with session prefix', () => {
      const detections = [
        makeDetection(100, 200, 50, 150, 0.1, 0.9),
        makeDetection(500, 200, 50, 150, 0.1, 0.85),
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'my_session_123',
      };

      const result = groupDetectionsIntoCandidates(input);

      expect(result.candidates[0].id).toBe('my_session_123_book_0');
      expect(result.candidates[1].id).toBe('my_session_123_book_1');
    });
  });

  describe('debug assignments', () => {
    it('should include config in debug assignments', () => {
      const input: GroupingInput = {
        detections: [makeDetection(100, 200, 50, 150, 0.1, 0.9)],
        rectificationResults: [makeRectInfo(0)],
        sessionId: 'test_config',
      };

      const result = groupDetectionsIntoCandidates(input);

      expect(result.debugAssignments.config).toEqual({
        iouMergeThreshold: 0.5,
        splitAngleThresholdDeg: expect.closeTo(10, 1), // ~10 degrees
        splitCenterDistRatio: 0.15,
        splitOcrSimilarityThreshold: 0.75,
        maxCropsPerCandidate: 3,
      });
    });

    it('should track merge records when merges occur', () => {
      // Two identical detections that will merge
      const detections = [
        makeDetection(100, 200, 100, 200, 0.0, 0.9),
        makeDetection(100, 200, 100, 200, 0.0, 0.85),
      ];

      const input: GroupingInput = {
        detections,
        rectificationResults: [makeRectInfo(0), makeRectInfo(1)],
        sessionId: 'test_merge_record',
      };

      const result = groupDetectionsIntoCandidates(input);

      expect(result.debugAssignments.merges).toHaveLength(1);
      expect(result.debugAssignments.merges[0]).toMatchObject({
        aIndex: 0,
        bIndex: 1,
        reason: 'iou_duplicate',
      });
      expect(result.debugAssignments.merges[0].iou).toBeGreaterThanOrEqual(0.5);
    });

    it('should clear merge records when safety fallback triggers', () => {
      // Create 5 overlapping detections to trigger safety fallback
      const detections: OBBDetection[] = [];
      for (let i = 0; i < 5; i++) {
        detections.push(makeDetection(100, 200, 100, 200, 0.0, 0.9 - i * 0.01));
      }

      const input: GroupingInput = {
        detections,
        rectificationResults: detections.map((_, i) => makeRectInfo(i)),
        sessionId: 'test_fallback_merges',
      };

      const result = groupDetectionsIntoCandidates(input);

      // Safety fallback triggered
      expect(result.debugAssignments.safetyFallbackTriggered).toBe(true);
      // Merges should be cleared since they were reverted
      expect(result.debugAssignments.merges).toHaveLength(0);
    });
  });
});
