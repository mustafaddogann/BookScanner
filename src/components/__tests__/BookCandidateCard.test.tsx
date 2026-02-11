/**
 * Unit tests for BookCandidateCard component
 * Specifically tests confidence display alignment with resolver status
 */

import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { BookCandidateCard } from '../BookCandidateCard';
import type { BookCandidate, BookEvidence } from '../../types';

// Helper to create a mock BookCandidate
function createMockCandidate(overrides: Partial<BookCandidate> = {}): BookCandidate {
  const baseEvidence: BookEvidence = {
    topCrops: [0],
    mergedLines: [
      { text: 'Test Line', normalizedText: 'test line', confidence: 0.95, sourceCropIndex: 0, rotation: 0 },
    ],
    mergedTextBlock: 'Test Line',
  };

  return {
    id: 'test-candidate-1',
    detectionIndices: [0],
    cropIndices: [0],
    representativeDetectionIndex: 0,
    orderingKey: 0,
    angleRad: 0,
    confidenceScore: 0.9,
    evidence: baseEvidence,
    ...overrides,
  };
}

// Helper to find text content in a tree
function findAllText(tree: ReactTestRenderer): string[] {
  const texts: string[] = [];
  tree.root.findAllByType('Text').forEach((node) => {
    if (typeof node.props.children === 'string') {
      texts.push(node.props.children);
    } else if (Array.isArray(node.props.children)) {
      node.props.children.forEach((child: any) => {
        if (typeof child === 'string') {
          texts.push(child);
        }
      });
    }
  });
  return texts;
}

describe('BookCandidateCard', () => {
  describe('Confidence display with resolver alignment', () => {
    it('should clamp confidence to max 49% when resolver rejects', () => {
      // OCR confidence is 95%, but resolver rejected
      const candidate = createMockCandidate({
        resolverDecision: 'reject',
        resolverDecisionReason: 'insufficient_title_evidence',
        evidence: {
          topCrops: [0],
          mergedLines: [
            { text: 'Test', normalizedText: 'test', confidence: 0.95, sourceCropIndex: 0, rotation: 0 },
          ],
          mergedTextBlock: 'Test',
        },
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(<BookCandidateCard candidate={candidate} />);
      });

      const texts = findAllText(tree!);
      const allText = texts.join(' ');

      // Should show "Unverified" with clamped confidence (max 49%)
      expect(allText).toContain('Unverified');
      // Should NOT show 95% or 100%
      expect(allText).not.toContain('95%');
      expect(allText).not.toContain('100%');
      // Should show a lower percentage (clamped to 49)
      expect(allText).toContain('49%');
    });

    it('should show full confidence when resolver accepts', () => {
      const candidate = createMockCandidate({
        resolverDecision: 'accept',
        resolvedConfidence: 0.92,
        resolvedBook: {
          title: 'The Guardians',
          authors: ['John Grisham'],
          source: 'openLibrary',
        },
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(<BookCandidateCard candidate={candidate} />);
      });

      const texts = findAllText(tree!);
      const allText = texts.join(' ');

      // Should show "Confidence" (not Unverified) with actual value
      expect(allText).toContain('Confidence');
      expect(allText).not.toContain('Unverified');
      expect(allText).toContain('92%');
    });

    it('should show resolver confidence for suggested decisions', () => {
      const candidate = createMockCandidate({
        resolverDecision: 'suggested',
        resolvedConfidence: 0.65,
        resolvedBook: {
          title: 'The Guardians',
          authors: ['John Grisham'],
          source: 'openLibrary',
        },
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(<BookCandidateCard candidate={candidate} />);
      });

      const texts = findAllText(tree!);
      const allText = texts.join(' ');

      // Should show resolver confidence, not OCR confidence (95%)
      expect(allText).toContain('65%');
      expect(allText).not.toContain('95%');
    });

    it('should show "No match" badge when resolver rejects', () => {
      const candidate = createMockCandidate({
        resolverDecision: 'reject',
        resolverDecisionReason: 'low_title_confidence',
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(<BookCandidateCard candidate={candidate} />);
      });

      const texts = findAllText(tree!);
      expect(texts).toContain('No match');
    });

    it('should show "Verified" badge when resolver accepts', () => {
      const candidate = createMockCandidate({
        resolverDecision: 'accept',
        resolvedConfidence: 0.9,
        resolvedBook: {
          title: 'The Guardians',
          authors: ['John Grisham'],
          source: 'openLibrary',
        },
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(<BookCandidateCard candidate={candidate} />);
      });

      const texts = findAllText(tree!);
      expect(texts).toContain('Verified');
    });

    it('should show "Suggested" badge when resolver suggests', () => {
      const candidate = createMockCandidate({
        resolverDecision: 'suggested',
        resolvedConfidence: 0.6,
        resolvedBook: {
          title: 'The Guardians',
          authors: ['John Grisham'],
          source: 'openLibrary',
        },
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(<BookCandidateCard candidate={candidate} />);
      });

      const texts = findAllText(tree!);
      expect(texts).toContain('Suggested');
    });

    it('should never show 100% confidence when resolver rejects', () => {
      // Even with 100% OCR confidence, rejection should clamp
      const candidate = createMockCandidate({
        resolverDecision: 'reject',
        resolverDecisionReason: 'no_evidence_overlap',
        evidence: {
          topCrops: [0],
          mergedLines: [
            { text: 'Test', normalizedText: 'test', confidence: 1.0, sourceCropIndex: 0, rotation: 0 },
          ],
          mergedTextBlock: 'Test',
        },
      });

      let tree: ReactTestRenderer;
      act(() => {
        tree = create(<BookCandidateCard candidate={candidate} />);
      });

      const texts = findAllText(tree!);
      const allText = texts.join(' ');

      // CRITICAL: Must NOT show 100% when rejected
      expect(allText).not.toContain('100%');
      expect(allText).toContain('Unverified');
      expect(allText).toContain('49%');
    });
  });
});
