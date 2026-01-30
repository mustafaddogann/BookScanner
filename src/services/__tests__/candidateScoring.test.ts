/**
 * Candidate Scoring Tests
 */

import type { ResolvedBook } from '../../types';
import {
  scoreCandidate,
  scoreAndRankCandidates,
  buildEvidenceFromLines,
  makeDecisionFromScores,
  AUTO_ACCEPT_THRESHOLD,
  SUGGESTED_THRESHOLD,
} from '../candidateScoring';

describe('candidateScoring', () => {
  describe('scoreCandidate', () => {
    it('scores matching candidate high', () => {
      const evidence = buildEvidenceFromLines([
        'THE SHINING',
        'STEPHEN KING',
      ]);

      const candidate: ResolvedBook = {
        title: 'The Shining',
        authors: ['Stephen King'],
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      const score = scoreCandidate(candidate, evidence);

      expect(score.score).toBeGreaterThan(0.7);
      expect(score.titleOverlap).toBeGreaterThan(0);
      expect(score.authorOverlap).toBeGreaterThan(0);
      expect(score.matchedTitleTokens.length).toBeGreaterThan(0);
      expect(score.matchedAuthorTokens.length).toBeGreaterThan(0);
    });

    it('scores non-matching candidate low', () => {
      const evidence = buildEvidenceFromLines([
        'THE SHINING',
        'STEPHEN KING',
      ]);

      const candidate: ResolvedBook = {
        title: 'Gone with the Wind',
        authors: ['Margaret Mitchell'],
        source: 'openLibrary',
        sourceId: 'OL456M',
      };

      const score = scoreCandidate(candidate, evidence);

      expect(score.score).toBeLessThan(0.3);
    });

    it('gives ISBN bonus when matched', () => {
      // Need enough evidence tokens to pass the min signal check (overlap >= 2)
      const evidence = buildEvidenceFromLines([
        'THE SHINING',
        'STEPHEN KING',
        'ISBN 9780307743256',
      ]);

      const candidateWithIsbn: ResolvedBook = {
        title: 'The Shining',
        authors: ['Stephen King'],
        isbn13: '9780307743256',
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      const candidateWithoutIsbn: ResolvedBook = {
        title: 'The Shining',
        authors: ['Stephen King'],
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      const scoreWith = scoreCandidate(candidateWithIsbn, evidence);
      const scoreWithout = scoreCandidate(candidateWithoutIsbn, evidence);

      expect(scoreWith.isbnMatched).toBe(true);
      expect(scoreWith.isbnBonus).toBeGreaterThan(0);
      // ISBN match adds 0.15 bonus to score
      expect(scoreWith.score).toBeGreaterThan(scoreWithout.score);
    });

    it('penalizes generic titles', () => {
      const evidence = buildEvidenceFromLines([
        'THE NOVEL',
        'AUTHOR NAME',
      ]);

      const genericCandidate: ResolvedBook = {
        title: 'The',
        authors: ['Author Name'],
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      const score = scoreCandidate(genericCandidate, evidence);

      const genericPenalty = score.penalties.find((p) => p.type === 'generic_title');
      expect(genericPenalty).toBeDefined();
    });
  });

  describe('scoreAndRankCandidates', () => {
    it('ranks matching candidate first', () => {
      const evidence = buildEvidenceFromLines([
        'THE SHINING',
        'STEPHEN KING',
      ]);

      const candidates: ResolvedBook[] = [
        {
          title: 'Gone with the Wind',
          authors: ['Margaret Mitchell'],
          source: 'openLibrary',
          sourceId: 'OL1M',
        },
        {
          title: 'The Shining',
          authors: ['Stephen King'],
          source: 'openLibrary',
          sourceId: 'OL2M',
        },
        {
          title: 'It',
          authors: ['Stephen King'],
          source: 'openLibrary',
          sourceId: 'OL3M',
        },
      ];

      const ranked = scoreAndRankCandidates(candidates, evidence);

      expect(ranked[0].book.title).toBe('The Shining');
      expect(ranked[0].scoring.score).toBeGreaterThan(ranked[1].scoring.score);
    });
  });

  describe('makeDecisionFromScores', () => {
    it('accepts high score with ISBN (accept_high)', () => {
      const scoredCandidates = [
        {
          book: {
            title: 'The Shining',
            authors: ['Stephen King'],
            isbn13: '9780307743256',
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: {
            score: 0.95,
            overlapRatio: 0.9,
            coverageRatio: 0.8,
            orderScore: 1.0,
            overlapCount: 3,
            isbnBonus: 0.15,
            isbnMatched: true,
            penalties: [],
            matchedTokens: ['shining', 'stephen', 'king'],
            // Legacy fields
            titleOverlap: 0.9,
            authorOverlap: 0.9,
            matchedTitleTokens: ['shining'],
            matchedAuthorTokens: ['stephen', 'king'],
          },
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      expect(result.decision).toBe('accept_high');
      expect(result.topCandidate).toBeDefined();
    });

    it('returns suggested for moderate score (0.55-0.82)', () => {
      const scoredCandidates = [
        {
          book: {
            title: 'The Shining',
            authors: ['Stephen King'],
            isbn13: '9780307743256',
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: {
            score: 0.65, // Above suggested threshold (0.55)
            overlapRatio: 0.6,
            coverageRatio: 0.5,
            orderScore: 1.0,
            overlapCount: 2,
            isbnBonus: 0,
            isbnMatched: false,
            penalties: [],
            matchedTokens: ['shining', 'king'],
            // Legacy fields
            titleOverlap: 0.6,
            authorOverlap: 0.5,
            matchedTitleTokens: ['shining'],
            matchedAuthorTokens: ['king'],
          },
        },
      ];

      // Score 0.65 should return 'suggested' (not persisted)
      const result = makeDecisionFromScores(scoredCandidates);

      expect(result.decision).toBe('suggested');
    });

    it('rejects low score', () => {
      const scoredCandidates = [
        {
          book: {
            title: 'Gone with the Wind',
            authors: ['Margaret Mitchell'],
            source: 'openLibrary' as const,
            sourceId: 'OL456M',
          },
          scoring: {
            score: 0.2,
            overlapRatio: 0.1,
            coverageRatio: 0.1,
            orderScore: 0.9,
            overlapCount: 0,
            isbnBonus: 0,
            isbnMatched: false,
            penalties: [],
            matchedTokens: [],
            // Legacy fields
            titleOverlap: 0.1,
            authorOverlap: 0.1,
            matchedTitleTokens: [],
            matchedAuthorTokens: [],
          },
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      expect(result.decision).toBe('reject');
    });

    it('rejects empty candidates', () => {
      const result = makeDecisionFromScores([]);

      expect(result.decision).toBe('reject');
      expect(result.topCandidate).toBeNull();
    });

    it('returns suggested for moderate score regardless of boost pass', () => {
      const scoredCandidates = [
        {
          book: {
            title: 'The Shining',
            authors: ['Stephen King'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: {
            score: 0.75,
            overlapRatio: 0.7,
            coverageRatio: 0.6,
            orderScore: 1.0,
            overlapCount: 2,
            isbnBonus: 0,
            isbnMatched: false,
            penalties: [],
            matchedTokens: ['shining', 'king'],
            titleOverlap: 0.7,
            authorOverlap: 0.6,
            matchedTitleTokens: ['shining'],
            matchedAuthorTokens: ['king'],
          },
        },
      ];

      // 'suggested' is always returned for scores >= 0.55, regardless of boost pass
      // This is non-blocking - shows to user but doesn't persist to Supabase
      const result = makeDecisionFromScores(scoredCandidates);
      expect(result.decision).toBe('suggested');
      expect(result.reason).toContain('suggested match');
    });

    it('accepts accept_medium without ISBN when thresholds are met', () => {
      const scoredCandidates = [
        {
          book: {
            title: 'The Shining',
            authors: ['Stephen King'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: {
            score: 0.90, // >= 0.82
            overlapRatio: 0.85,
            coverageRatio: 0.8,
            orderScore: 1.0,
            overlapCount: 4, // >= 3
            isbnBonus: 0,
            isbnMatched: false, // No ISBN
            penalties: [],
            matchedTokens: ['shining', 'stephen', 'king', 'novel'],
            titleOverlap: 0.9,
            authorOverlap: 0.8,
            matchedTitleTokens: ['shining'],
            matchedAuthorTokens: ['stephen', 'king'],
          },
        },
        {
          book: {
            title: 'Other Book',
            authors: ['Other Author'],
            source: 'openLibrary' as const,
            sourceId: 'OL456M',
          },
          scoring: {
            score: 0.70, // Gap = 0.20 >= 0.18
            overlapRatio: 0.5,
            coverageRatio: 0.4,
            orderScore: 0.9,
            overlapCount: 2,
            isbnBonus: 0,
            isbnMatched: false,
            penalties: [],
            matchedTokens: ['other'],
            titleOverlap: 0.5,
            authorOverlap: 0.4,
            matchedTitleTokens: ['other'],
            matchedAuthorTokens: [],
          },
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      expect(result.decision).toBe('accept_medium');
      expect(result.topCandidate?.scoring.isbnMatched).toBe(false);
    });
  });

  describe('integration: bad OCR fields but good evidence', () => {
    it('scores correct candidate high even with swapped fields', () => {
      // Simulate OCR that got title/author swapped
      // Evidence has correct info, just in wrong fields
      const evidence = buildEvidenceFromLines([
        'FICTION',         // Noise - should be filtered
        'NICHOLAS SPARKS', // This is actually the author
        'THE GUARDIAN',    // This is actually the title
      ]);

      // The correct book
      const correctCandidate: ResolvedBook = {
        title: 'The Guardian',
        authors: ['Nicholas Sparks'],
        isbn13: '9780446612531',
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      // A wrong book
      const wrongCandidate: ResolvedBook = {
        title: 'Guardian Angels',
        authors: ['Fern Michaels'],
        source: 'openLibrary',
        sourceId: 'OL456M',
      };

      const correctScore = scoreCandidate(correctCandidate, evidence);
      const wrongScore = scoreCandidate(wrongCandidate, evidence);

      // Correct candidate should score higher
      expect(correctScore.score).toBeGreaterThan(wrongScore.score);
      // Should be high enough for at least manual review
      expect(correctScore.score).toBeGreaterThanOrEqual(SUGGESTED_THRESHOLD);
    });
  });
});
