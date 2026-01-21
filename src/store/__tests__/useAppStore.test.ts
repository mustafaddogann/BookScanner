/**
 * Unit tests for useAppStore - specifically testing setSessionMeta merge semantics
 *
 * These tests verify that setSessionMeta MERGES partial updates instead of REPLACING,
 * which was the root cause of rectificationResults/ocrResults being clobbered.
 */

import { useAppStore } from '../useAppStore';
import type { DetectionRectifyInfo, SessionMeta } from '../useAppStore';
import type { OCRResult, SerializedFrameGeo } from '../../types';

// Suppress console.log during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Reset store state before each test
beforeEach(() => {
  useAppStore.getState().clearCurrentSession();
});

describe('setSessionMeta merge semantics', () => {
  // Helper to create minimal SessionMeta
  const createFrameGeo = (): SerializedFrameGeo => ({
    normalizedUri: 'file:///path/to/image.jpg',
    pixelW: 4032,
    pixelH: 3024,
    rotationDeg: 0,
    mirrored: false,
    exifOrientation: 1,
    modelSize: 640,
    letterbox: {
      scale: 0.158,
      padX: 0,
      padY: 80,
      srcWidth: 4032,
      srcHeight: 3024,
      dstWidth: 640,
      dstHeight: 640,
    },
    createdAt: Date.now(),
    paddingAxis: 'vertical',
  });

  const createRectificationResults = (count: number): DetectionRectifyInfo[] =>
    Array.from({ length: count }, (_, i) => ({
      detectionIndex: i,
      cropPath: `/path/to/crop_${i}.jpg`,
      cropUri: `file:///path/to/crop_${i}.jpg`,
      cropWidth: 100,
      cropHeight: 200,
      rectificationMethod: 'native_opencv',
    }));

  const createOcrResult = (title: string): OCRResult => ({
    ok: true,
    chosenRotation: 0,
    fullText: title,
    lines: [{ text: title, confidence: 0.9, bbox: { x: 0, y: 0, width: 100, height: 20 } }],
    avgConfidence: 0.9,
    alnumRatio: 0.8,
    charCount: title.length,
    lineCount: 1,
    titleCandidate: title,
    authorCandidate: null,
  });

  describe('core merge behavior', () => {
    it('should merge partial updates without removing existing fields', () => {
      const store = useAppStore.getState();

      // Set initial meta with frameGeo
      const frameGeo = createFrameGeo();
      store.setSessionMeta({
        frameGeo,
        imageDimensions: { width: 4032, height: 3024 },
        normalizedImagePath: '/path/to/normalized.jpg',
        originalImagePath: '/path/to/original.jpg',
      });

      // Verify initial state
      let meta = useAppStore.getState().sessionMeta;
      expect(meta?.frameGeo).toBeTruthy();
      expect(meta?.imageDimensions).toEqual({ width: 4032, height: 3024 });

      // Set rectificationResults - should NOT remove frameGeo
      const rectResults = createRectificationResults(5);
      store.setSessionMeta({
        rectificationResults: rectResults,
        rectificationSummary: { total: 5, succeeded: 5, skipped: 0 },
      });

      // Verify both frameGeo AND rectificationResults exist
      meta = useAppStore.getState().sessionMeta;
      expect(meta?.frameGeo).toBeTruthy();
      expect(meta?.imageDimensions).toEqual({ width: 4032, height: 3024 });
      expect(meta?.rectificationResults).toHaveLength(5);
      expect(meta?.rectificationSummary?.succeeded).toBe(5);
    });

    it('should preserve rectificationResults when updating ocrResults', () => {
      const store = useAppStore.getState();

      // Set frameGeo and rectificationResults
      store.setSessionMeta({
        frameGeo: createFrameGeo(),
        imageDimensions: { width: 4032, height: 3024 },
      });
      store.setSessionMeta({
        rectificationResults: createRectificationResults(3),
        rectificationSummary: { total: 3, succeeded: 3, skipped: 0 },
      });

      // Verify rectification is present
      let meta = useAppStore.getState().sessionMeta;
      expect(meta?.rectificationResults).toHaveLength(3);

      // Now add OCR results - should NOT remove rectificationResults
      store.setSessionMeta({
        ocrResultsByCropIndex: {
          0: createOcrResult('Book Title 1'),
          1: createOcrResult('Book Title 2'),
        },
        ocrSummary: {
          total: 3,
          succeeded: 2,
          skipped: 1,
          withTitles: 2,
          withAuthors: 0,
          completedAt: new Date().toISOString(),
        },
      });

      // Verify ALL data is preserved
      meta = useAppStore.getState().sessionMeta;
      expect(meta?.frameGeo).toBeTruthy();
      expect(meta?.imageDimensions).toEqual({ width: 4032, height: 3024 });
      expect(meta?.rectificationResults).toHaveLength(3);
      expect(meta?.ocrResultsByCropIndex?.[0]?.titleCandidate).toBe('Book Title 1');
      expect(meta?.ocrSummary?.succeeded).toBe(2);
    });

    it('should preserve all fields when updating bookCandidates', () => {
      const store = useAppStore.getState();

      // Simulate full pipeline: frameGeo -> rectification -> OCR -> grouping
      store.setSessionMeta({
        frameGeo: createFrameGeo(),
        imageDimensions: { width: 4032, height: 3024 },
        normalizedImagePath: '/path/to/normalized.jpg',
        originalImagePath: '/path/to/original.jpg',
      });

      store.setSessionMeta({
        rectificationResults: createRectificationResults(2),
        rectificationSummary: { total: 2, succeeded: 2, skipped: 0 },
      });

      store.setSessionMeta({
        ocrResultsByCropIndex: {
          0: createOcrResult('Book One'),
          1: createOcrResult('Book Two'),
        },
      });

      // Now add book candidates (grouping stage)
      store.setSessionMeta({
        bookCandidates: [
          {
            id: 'test_book_0',
            detectionIndices: [0, 1],
            cropIndices: [0, 1],
            representativeDetectionIndex: 0,
            orderingKey: 0,
            angleRad: 0,
            confidenceScore: 0.9,
            evidence: {
              topCrops: [0, 1],
              mergedLines: [],
              mergedTextBlock: 'Book One\nBook Two',
            },
          },
        ],
        bookCandidatesSummary: {
          rawDetections: 2,
          rawCrops: 2,
          candidates: 1,
          avgCropsPerCandidate: 2,
        },
      });

      // Verify ALL data is still present
      const meta = useAppStore.getState().sessionMeta;
      expect(meta?.frameGeo).toBeTruthy();
      expect(meta?.imageDimensions).toEqual({ width: 4032, height: 3024 });
      expect(meta?.rectificationResults).toHaveLength(2);
      expect(meta?.ocrResultsByCropIndex?.[0]?.titleCandidate).toBe('Book One');
      expect(meta?.bookCandidates).toHaveLength(1);
      expect(meta?.bookCandidatesSummary?.candidates).toBe(1);
    });
  });

  describe('null handling', () => {
    it('should clear sessionMeta entirely when passed null', () => {
      const store = useAppStore.getState();

      // Set some data
      store.setSessionMeta({
        frameGeo: createFrameGeo(),
        imageDimensions: { width: 1920, height: 1080 },
        rectificationResults: createRectificationResults(3),
      });

      // Verify data exists
      expect(useAppStore.getState().sessionMeta).toBeTruthy();
      expect(useAppStore.getState().sessionMeta?.rectificationResults).toHaveLength(3);

      // Clear with null
      store.setSessionMeta(null);

      // Verify cleared
      expect(useAppStore.getState().sessionMeta).toBeNull();
    });

    it('should create sessionMeta from scratch when current is null', () => {
      const store = useAppStore.getState();

      // Ensure sessionMeta is null
      store.setSessionMeta(null);
      expect(useAppStore.getState().sessionMeta).toBeNull();

      // Set partial data when current is null
      store.setSessionMeta({
        rectificationResults: createRectificationResults(2),
      });

      // Should create sessionMeta with just that field (plus defaults for required fields)
      const meta = useAppStore.getState().sessionMeta;
      expect(meta).toBeTruthy();
      expect(meta?.rectificationResults).toHaveLength(2);
      // frameGeo is null (default) not undefined when creating from scratch
      expect(meta?.frameGeo).toBeNull();
    });
  });

  describe('pipeline simulation', () => {
    it('should maintain all data through simulated pipeline stages', () => {
      const store = useAppStore.getState();

      // Stage 1: overlay-prep (frameGeo, dims, paths)
      store.setSessionMeta({
        frameGeo: createFrameGeo(),
        imageDimensions: { width: 4032, height: 3024 },
        normalizedImagePath: '/normalized.jpg',
        originalImagePath: '/original.jpg',
        displayImagePath: '/display.jpg',
        displayImageScale: 0.25,
      });

      // Stage 2: rectification
      store.setSessionMeta({
        rectificationResults: createRectificationResults(12),
        rectificationSummary: { total: 12, succeeded: 12, skipped: 0 },
      });

      // Stage 3: OCR
      const ocrResults: Record<number, OCRResult> = {};
      for (let i = 0; i < 12; i++) {
        ocrResults[i] = createOcrResult(`Book ${i + 1}`);
      }
      store.setSessionMeta({
        ocrResultsByCropIndex: ocrResults,
        ocrSummary: {
          total: 12,
          succeeded: 12,
          skipped: 0,
          withTitles: 12,
          withAuthors: 0,
          completedAt: new Date().toISOString(),
        },
      });

      // Stage 4: grouping
      store.setSessionMeta({
        bookCandidates: [
          {
            id: 'test_book_0',
            detectionIndices: Array.from({ length: 12 }, (_, i) => i),
            cropIndices: Array.from({ length: 12 }, (_, i) => i),
            representativeDetectionIndex: 0,
            orderingKey: 0,
            angleRad: 0,
            confidenceScore: 0.95,
            evidence: {
              topCrops: [0, 1, 2],
              mergedLines: [],
              mergedTextBlock: 'Merged text',
            },
          },
        ],
        bookCandidatesSummary: {
          rawDetections: 12,
          rawCrops: 12,
          candidates: 1,
          avgCropsPerCandidate: 12,
        },
      });

      // Final verification: ALL data must be present
      const finalMeta = useAppStore.getState().sessionMeta;

      // From Stage 1
      expect(finalMeta?.frameGeo?.pixelW).toBe(4032);
      expect(finalMeta?.imageDimensions).toEqual({ width: 4032, height: 3024 });
      expect(finalMeta?.normalizedImagePath).toBe('/normalized.jpg');
      expect(finalMeta?.displayImagePath).toBe('/display.jpg');

      // From Stage 2
      expect(finalMeta?.rectificationResults).toHaveLength(12);
      expect(finalMeta?.rectificationSummary?.succeeded).toBe(12);

      // From Stage 3
      expect(Object.keys(finalMeta?.ocrResultsByCropIndex || {}).length).toBe(12);
      expect(finalMeta?.ocrResultsByCropIndex?.[5]?.titleCandidate).toBe('Book 6');
      expect(finalMeta?.ocrSummary?.succeeded).toBe(12);

      // From Stage 4
      expect(finalMeta?.bookCandidates).toHaveLength(1);
      expect(finalMeta?.bookCandidatesSummary?.candidates).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should handle rapid successive updates', () => {
      const store = useAppStore.getState();

      // Simulate rapid updates (no await between them)
      store.setSessionMeta({ frameGeo: createFrameGeo() });
      store.setSessionMeta({ imageDimensions: { width: 100, height: 100 } });
      store.setSessionMeta({ normalizedImagePath: '/path1.jpg' });
      store.setSessionMeta({ rectificationResults: createRectificationResults(5) });
      store.setSessionMeta({ originalImagePath: '/path2.jpg' });

      const meta = useAppStore.getState().sessionMeta;
      expect(meta?.frameGeo).toBeTruthy();
      expect(meta?.imageDimensions).toEqual({ width: 100, height: 100 });
      expect(meta?.normalizedImagePath).toBe('/path1.jpg');
      expect(meta?.originalImagePath).toBe('/path2.jpg');
      expect(meta?.rectificationResults).toHaveLength(5);
    });

    it('should allow overwriting specific fields', () => {
      const store = useAppStore.getState();

      // Initial set
      store.setSessionMeta({
        imageDimensions: { width: 1000, height: 1000 },
        rectificationResults: createRectificationResults(3),
      });

      // Overwrite imageDimensions
      store.setSessionMeta({
        imageDimensions: { width: 2000, height: 2000 },
      });

      const meta = useAppStore.getState().sessionMeta;
      expect(meta?.imageDimensions).toEqual({ width: 2000, height: 2000 });
      expect(meta?.rectificationResults).toHaveLength(3); // Still preserved
    });
  });
});
