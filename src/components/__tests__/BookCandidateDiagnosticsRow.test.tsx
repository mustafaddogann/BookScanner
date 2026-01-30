/**
 * Tests for BookCandidateDiagnosticsRow
 *
 * Verifies that diagnostics rows only render when __DEV__ && diagnosticsEnabled
 */

import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { BookCandidateDiagnosticsRow } from '../BookCandidateDiagnosticsRow';
import type { BookCandidate, BookEvidence } from '../../types';

// Mock the useDebugStore
let mockDiagnosticsValue = true;
jest.mock('../../store/useDebugStore', () => ({
  useDebugStore: (selector: (state: { diagnosticsEnabled: boolean }) => boolean) => {
    return selector({ diagnosticsEnabled: mockDiagnosticsValue });
  },
}));

// Mock __DEV__
const originalDev = (global as any).__DEV__;

function createMockCandidate(overrides?: Partial<BookCandidate>): BookCandidate {
  const evidence: BookEvidence = {
    topCrops: [0],
    mergedLines: [],
    mergedTextBlock: 'Test text',
  };

  return {
    id: 'test-candidate-1',
    detectionIndices: [0],
    cropIndices: [0],
    representativeDetectionIndex: 0,
    orderingKey: 0,
    angleRad: 0,
    confidenceScore: 0.9,
    evidence,
    ...overrides,
  };
}

function findByTestID(tree: ReactTestRenderer, testID: string) {
  return tree.root.findAll((node) => node.props.testID === testID);
}

function findAllText(tree: ReactTestRenderer): string[] {
  const texts: string[] = [];
  tree.root.findAllByType('Text').forEach((node) => {
    if (typeof node.props.children === 'string') {
      texts.push(node.props.children);
    }
  });
  return texts;
}

describe('BookCandidateDiagnosticsRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).__DEV__ = true;
    mockDiagnosticsValue = true;
  });

  afterAll(() => {
    (global as any).__DEV__ = originalDev;
  });

  describe('visibility based on diagnosticsEnabled', () => {
    it('renders diagnostics row when diagnosticsEnabled is true', () => {
      mockDiagnosticsValue = true;

      const candidate = createMockCandidate({
        hypothesis: {
          evidenceTier: 'strong',
          searchCandidates: [],
          isbnCandidates: [],
          uiGuess: null,
        },
        resolverDecision: 'accept',
        resolvedConfidence: 0.95,
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(
          <BookCandidateDiagnosticsRow
            candidate={candidate}
            testID="diagnostics-row"
          />
        );
      });

      const matches = findByTestID(tree!, 'diagnostics-row');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT render diagnostics row when diagnosticsEnabled is false', () => {
      mockDiagnosticsValue = false;

      const candidate = createMockCandidate({
        hypothesis: {
          evidenceTier: 'strong',
          searchCandidates: [],
          isbnCandidates: [],
          uiGuess: null,
        },
        resolverDecision: 'accept',
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(
          <BookCandidateDiagnosticsRow
            candidate={candidate}
            testID="diagnostics-row"
          />
        );
      });

      // When component returns null, toJSON() returns null
      expect(tree!.toJSON()).toBeNull();
    });

    it('does NOT render diagnostics row when not in __DEV__ mode', () => {
      (global as any).__DEV__ = false;
      mockDiagnosticsValue = true;

      const candidate = createMockCandidate({
        resolverDecision: 'accept',
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(
          <BookCandidateDiagnosticsRow
            candidate={candidate}
            testID="diagnostics-row"
          />
        );
      });

      // When component returns null, toJSON() returns null
      expect(tree!.toJSON()).toBeNull();
    });
  });

  describe('content rendering', () => {
    beforeEach(() => {
      mockDiagnosticsValue = true;
    });

    it('shows evidence tier when available', () => {
      const candidate = createMockCandidate({
        hypothesis: {
          evidenceTier: 'usable',
          searchCandidates: [],
          isbnCandidates: [],
          uiGuess: null,
        },
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(
          <BookCandidateDiagnosticsRow candidate={candidate} testID="test" />
        );
      });

      const texts = findAllText(tree!);
      expect(texts).toContain('usable');
    });

    it('shows resolver decision', () => {
      const candidate = createMockCandidate({
        resolverDecision: 'suggested',
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(
          <BookCandidateDiagnosticsRow candidate={candidate} testID="test" />
        );
      });

      const texts = findAllText(tree!);
      expect(texts).toContain('suggested');
    });

    it('shows pending when no decision', () => {
      const candidate = createMockCandidate();

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(
          <BookCandidateDiagnosticsRow candidate={candidate} testID="test" />
        );
      });

      const texts = findAllText(tree!);
      expect(texts).toContain('pending');
    });

    it('shows confidence percentage', () => {
      const candidate = createMockCandidate({
        resolvedConfidence: 0.87,
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(
          <BookCandidateDiagnosticsRow candidate={candidate} testID="test" />
        );
      });

      const texts = findAllText(tree!);
      expect(texts).toContain('87%');
    });

    it('shows AUTO badge for accepted decisions', () => {
      const candidate = createMockCandidate({
        resolverDecision: 'accept',
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(
          <BookCandidateDiagnosticsRow candidate={candidate} testID="test" />
        );
      });

      const texts = findAllText(tree!);
      expect(texts).toContain('AUTO');
    });

    it('shows source provider when resolved', () => {
      const candidate = createMockCandidate({
        resolvedBook: {
          title: 'Test Book',
          authors: ['Test Author'],
          source: 'openLibrary',
          sourceId: 'OL123',
        },
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(
          <BookCandidateDiagnosticsRow candidate={candidate} testID="test" />
        );
      });

      const texts = findAllText(tree!);
      expect(texts).toContain('openLibrary');
    });

    it('shows alternatives count when suggestions exist', () => {
      const candidate = createMockCandidate({
        resolverSuggestions: [
          { title: 'Alt 1', authors: [], source: 'openLibrary', sourceId: 'OL1' },
          { title: 'Alt 2', authors: [], source: 'openLibrary', sourceId: 'OL2' },
        ],
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(
          <BookCandidateDiagnosticsRow candidate={candidate} testID="test" />
        );
      });

      const texts = findAllText(tree!);
      expect(texts).toContain('2 alt');
    });
  });
});
