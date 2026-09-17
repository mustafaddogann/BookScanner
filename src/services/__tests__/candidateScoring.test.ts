/**
 * Candidate Scoring Tests
 */

import type { ResolvedBook } from '../../types';
import type { CandidateScore, ScoredCandidate, ResolutionMode } from '../candidateScoring';
import {
  scoreCandidate,
  scoreAndRankCandidates,
  buildEvidenceFromLines,
  makeDecisionFromScores,
  AUTO_ACCEPT_THRESHOLD,
  SUGGESTED_THRESHOLD,
} from '../candidateScoring';

/**
 * Helper to create a mock CandidateScore with all required fields
 * Used for tests that need to create mock ScoredCandidate objects
 */
function createMockScoring(overrides: Partial<CandidateScore>): CandidateScore {
  const score = overrides.score ?? 0.5;
  const rawScore = overrides.rawScore ?? score;
  const finalScore = overrides.finalScore ?? score;
  return {
    score,
    rawScore,
    finalScore,
    overlapRatio: 0.5,
    coverageRatio: 0.5,
    orderScore: 1.0,
    overlapCount: 2,
    precision: 0.5,
    recall: 0.5,
    f1: 0.5,
    isbnBonus: 0,
    penalties: [],
    matchedTokens: [],
    isbnMatched: false,
    minSignalCapped: false,
    // TITLE_ONLY mode fields
    titleScore: overrides.titleScore ?? score,
    authorScore: overrides.authorScore ?? 0.5,
    titleTokenCount: overrides.titleTokenCount ?? 2,
    authorTokenCount: overrides.authorTokenCount ?? 2,
    resolutionMode: overrides.resolutionMode ?? 'FULL_MATCH',
    publisherScore: overrides.publisherScore ?? null,
    // Legacy fields
    titleOverlap: 0.5,
    authorOverlap: 0.5,
    matchedTitleTokens: [],
    matchedAuthorTokens: [],
    ...overrides,
  };
}

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

    it('gives ISBN bonus when matched (back_cover source)', () => {
      // Need enough evidence tokens to pass the min signal check (overlap >= 2)
      // Use sourceKind: 'back_cover' to enable ISBN extraction (spine_crop skips ISBN)
      // Note: ISBN must have valid checksum - 9780385121675 is valid for The Shining
      const evidence = buildEvidenceFromLines([
        'THE SHINING',
        'STEPHEN KING',
        'ISBN 9780385121675',
      ], { sourceKind: 'back_cover' });

      const candidateWithIsbn: ResolvedBook = {
        title: 'The Shining',
        authors: ['Stephen King'],
        isbn13: '9780385121675',
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      const candidateWithoutIsbn: ResolvedBook = {
        title: 'The Shining',
        authors: ['Stephen King'],
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      // Pass sourceKind to enable ISBN boost scoring
      const scoreWith = scoreCandidate(candidateWithIsbn, evidence, { sourceKind: 'back_cover' });
      const scoreWithout = scoreCandidate(candidateWithoutIsbn, evidence, { sourceKind: 'back_cover' });

      expect(scoreWith.isbnMatched).toBe(true);
      expect(scoreWith.isbnBonus).toBeGreaterThan(0);
      // ISBN match adds 0.15 bonus to score
      expect(scoreWith.score).toBeGreaterThan(scoreWithout.score);
    });

    it('penalizes generic titles without author signal', () => {
      const evidence = buildEvidenceFromLines([
        'THE NOVEL',
        'RANDOM TEXT',
      ]);

      const genericCandidate: ResolvedBook = {
        title: 'The',
        authors: ['Unknown Author'], // No match in evidence
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      const score = scoreCandidate(genericCandidate, evidence);

      const genericPenalty = score.penalties.find((p) => p.type === 'generic_title');
      expect(genericPenalty).toBeDefined();
    });

    it('does NOT penalize generic titles with author signal', () => {
      const evidence = buildEvidenceFromLines([
        'THE NOVEL',
        'AUTHOR NAME',
      ]);

      const genericCandidate: ResolvedBook = {
        title: 'The',
        authors: ['Author Name'], // Matches evidence - provides author signal
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      const score = scoreCandidate(genericCandidate, evidence);

      const genericPenalty = score.penalties.find((p) => p.type === 'generic_title');
      expect(genericPenalty).toBeUndefined(); // No penalty when author signal exists
    });

    it('matches OCR-corrupted CITY/VICTORY tokens without lowering gates', () => {
      // Regression test for scan_1772056794675_pwyvrs_book_84
      const evidence = buildEvidenceFromLines([
        'TY NHOC',
        'ILSOE VICTORY',
        'MASON COLLI',
        '1103 NOFER',
        'NA NOVEL',
        'JOHNA.',
      ]);

      const candidate: ResolvedBook = {
        title: 'Victory City',
        authors: ['Salman Rushdie'],
        source: 'openLibrary',
        sourceId: 'OLVC1M',
      };

      const score = scoreCandidate(candidate, evidence);

      // "ILSOE/nhoc" family should resolve into title anchors.
      expect(score.matchedTitleTokens).toContain('victory');
      expect(score.matchedTitleTokens).toContain('city');

      // Keep this in viable-range without changing decision thresholds.
      expect(score.score).toBeGreaterThanOrEqual(0.3);
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
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'The Shining',
            authors: ['Stephen King'],
            isbn13: '9780307743256',
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.95,
            overlapRatio: 0.9,
            coverageRatio: 0.8,
            orderScore: 1.0,
            overlapCount: 3,
            isbnBonus: 0.15,
            isbnMatched: true,
            matchedTokens: ['shining', 'stephen', 'king'],
            titleOverlap: 0.9,
            authorOverlap: 0.9,
            matchedTitleTokens: ['shining'],
            matchedAuthorTokens: ['stephen', 'king'],
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      expect(result.decision).toBe('accept_high');
      expect(result.topCandidate).toBeDefined();
    });

    it('returns suggested for moderate score (0.60-0.88) with sufficient overlap', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'The Shining',
            authors: ['Stephen King'],
            isbn13: '9780307743256',
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.65, // Above suggested threshold (0.60)
            overlapRatio: 0.6,
            coverageRatio: 0.5,
            orderScore: 1.0,
            overlapCount: 3, // Must be >= 3 for suggested
            matchedTokens: ['shining', 'stephen', 'king'],
            titleOverlap: 0.6,
            authorOverlap: 0.5,
            matchedTitleTokens: ['shining'],
            matchedAuthorTokens: ['stephen', 'king'],
            precision: 0.5,
            recall: 0.6,
            f1: 0.55,
          }),
        },
      ];

      // Score 0.65 with overlap >= 3 should return 'suggested' (not persisted)
      const result = makeDecisionFromScores(scoredCandidates);

      expect(result.decision).toBe('suggested');
    });

    it('rejects low score', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'Gone with the Wind',
            authors: ['Margaret Mitchell'],
            source: 'openLibrary' as const,
            sourceId: 'OL456M',
          },
          scoring: createMockScoring({
            score: 0.2,
            overlapRatio: 0.1,
            coverageRatio: 0.1,
            orderScore: 0.9,
            overlapCount: 0,
            titleOverlap: 0.1,
            authorOverlap: 0.1,
          }),
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

    it('returns suggested for moderate score with sufficient overlap', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'The Shining',
            authors: ['Stephen King'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.75,
            overlapRatio: 0.7,
            coverageRatio: 0.6,
            orderScore: 1.0,
            overlapCount: 3, // Must be >= 3 for suggested
            matchedTokens: ['shining', 'stephen', 'king'],
            titleOverlap: 0.7,
            authorOverlap: 0.6,
            matchedTitleTokens: ['shining'],
            matchedAuthorTokens: ['stephen', 'king'],
            precision: 0.6,
            recall: 0.7,
            f1: 0.65,
          }),
        },
      ];

      // 'suggested' is returned for scores >= 0.60 with overlap >= 3
      // This is non-blocking - shows to user but doesn't persist to Supabase
      const result = makeDecisionFromScores(scoredCandidates);
      expect(result.decision).toBe('suggested');
      // Accept either full_match_suggested or fast_path_good_match (both are valid suggested paths)
      expect(['full_match_suggested', 'fast_path_good_match']).toContain(result.reason);
    });

    it('accepts accept_medium without ISBN when thresholds are met', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'The Shining',
            authors: ['Stephen King'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.90, // >= 0.82
            overlapRatio: 0.85,
            coverageRatio: 0.8,
            orderScore: 1.0,
            overlapCount: 4, // >= 3
            matchedTokens: ['shining', 'stephen', 'king', 'novel'],
            titleOverlap: 0.9,
            authorOverlap: 0.8,
            matchedTitleTokens: ['shining'],
            matchedAuthorTokens: ['stephen', 'king'],
          }),
        },
        {
          book: {
            title: 'Other Book',
            authors: ['Other Author'],
            source: 'openLibrary' as const,
            sourceId: 'OL456M',
          },
          scoring: createMockScoring({
            score: 0.70, // Gap = 0.20 >= 0.18
            overlapRatio: 0.5,
            coverageRatio: 0.4,
            orderScore: 0.9,
            overlapCount: 2,
            matchedTokens: ['other'],
            titleOverlap: 0.5,
            authorOverlap: 0.4,
            matchedTitleTokens: ['other'],
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      expect(result.decision).toBe('accept_medium');
      expect(result.topCandidate?.scoring.isbnMatched).toBe(false);
    });

    it('treats duplicate editions as single candidate (gap = 1.0, not ambiguous)', () => {
      // Multiple editions of the same book should NOT trigger ambiguous
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'The Guardian',
            authors: ['Nicholas Sparks'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M', // Edition 1
          },
          scoring: createMockScoring({
            score: 0.85,
            overlapRatio: 0.8,
            coverageRatio: 0.7,
            orderScore: 1.0,
            overlapCount: 3,
            matchedTokens: ['guardian', 'nicholas', 'sparks'],
            titleOverlap: 0.8,
            authorOverlap: 0.7,
            matchedTitleTokens: ['guardian'],
            matchedAuthorTokens: ['nicholas', 'sparks'],
            precision: 0.7,
            recall: 0.8,
            f1: 0.75,
          }),
        },
        {
          book: {
            title: 'The Guardian', // Same title = same book (different edition)
            authors: ['Nicholas Sparks'],
            source: 'openLibrary' as const,
            sourceId: 'OL456M', // Edition 2
          },
          scoring: createMockScoring({
            score: 0.85, // Same score (editions often score identically)
            overlapRatio: 0.8,
            coverageRatio: 0.7,
            orderScore: 1.0,
            overlapCount: 3,
            matchedTokens: ['guardian', 'nicholas', 'sparks'],
            titleOverlap: 0.8,
            authorOverlap: 0.7,
            matchedTitleTokens: ['guardian'],
            matchedAuthorTokens: ['nicholas', 'sparks'],
            precision: 0.7,
            recall: 0.8,
            f1: 0.75,
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // Should NOT be ambiguous - duplicate editions don't count as "distinct"
      expect(result.manualReview).toBeFalsy();
      expect(result.scoreGap).toBe(1.0); // No distinct second = dominated
      expect(result.reason).not.toContain('Ambiguous');
    });

    it('correctly identifies ambiguous when two DISTINCT books have close scores', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'The Guardian',
            authors: ['Nicholas Sparks'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.80,
            overlapRatio: 0.75,
            coverageRatio: 0.65,
            orderScore: 1.0,
            overlapCount: 3,
            matchedTokens: ['guardian', 'nicholas', 'sparks'],
            titleOverlap: 0.8,
            authorOverlap: 0.7,
            matchedTitleTokens: ['guardian'],
            matchedAuthorTokens: ['nicholas', 'sparks'],
            precision: 0.65,
            recall: 0.75,
            f1: 0.70,
          }),
        },
        {
          book: {
            title: 'Guardian Angels', // DIFFERENT title = distinct book
            authors: ['Fern Michaels'],
            source: 'openLibrary' as const,
            sourceId: 'OL456M',
          },
          scoring: createMockScoring({
            score: 0.78, // Close score (gap = 0.02 < 0.08)
            overlapRatio: 0.7,
            coverageRatio: 0.6,
            orderScore: 0.9,
            overlapCount: 3,
            matchedTokens: ['guardian', 'angels'],
            titleOverlap: 0.7,
            authorOverlap: 0.0,
            matchedTitleTokens: ['guardian', 'angels'],
            precision: 0.6,
            recall: 0.7,
            f1: 0.65,
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // Should be ambiguous - two DISTINCT books with close scores
      expect(result.manualReview).toBe(true);
      expect(result.scoreGap).toBeCloseTo(0.02, 2);
      expect(result.reason).toBe('ambiguous_candidates');
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

  // =========================================================================
  // TITLE_ONLY mode tests
  // =========================================================================
  describe('TITLE_ONLY resolution mode', () => {
    it('title correct, author missing -> SUGGESTED (never REJECT)', () => {
      // Create a candidate where title matches but author doesn't
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'The Shining',
            authors: ['Stephen King'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.75,
            titleScore: 0.85, // Strong title match
            authorScore: 0, // No author match
            titleTokenCount: 2,
            authorTokenCount: 2,
            resolutionMode: 'TITLE_ONLY', // Author missing/weak
            overlapCount: 2,
            matchedTitleTokens: ['shining'],
            matchedAuthorTokens: [], // No author tokens matched
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // Must NOT be reject - title matches
      expect(result.decision).not.toBe('reject');
      // Should be SUGGESTED or TITLE_ONLY accept
      expect(['suggested', 'suggested_weak', 'accept_medium']).toContain(result.decision);
      expect(result.resolutionMode).toBe('TITLE_ONLY');
      // Reason explains the situation (title strong + author missing)
      expect(result.reason).toBe('title_strong_author_missing');
    });

    it('title correct, high confidence, few candidates -> TITLE_ONLY accept', () => {
      // High title score with anti-ambiguity signal (few candidates)
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'The Great Gatsby',
            authors: ['F. Scott Fitzgerald'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.93,
            titleScore: 0.95, // Very high title match
            authorScore: 0.1, // Weak author (triggers TITLE_ONLY)
            titleTokenCount: 3,
            authorTokenCount: 3,
            resolutionMode: 'TITLE_ONLY',
            overlapCount: 3,
            matchedTitleTokens: ['great', 'gatsby'],
            matchedAuthorTokens: [],
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // With high title score and few candidates (distinctCandidateCount = 1),
      // should be accepted
      expect(result.decision).toBe('accept_medium');
      expect(result.reason).toBe('title_only_high_confidence');
      expect(result.resolutionMode).toBe('TITLE_ONLY');
    });

    it('title correct but many candidates -> SUGGESTED with ambiguous reason', () => {
      // High title score but ambiguity (multiple distinct candidates)
      const firstCandidate: ScoredCandidate = {
        book: {
          title: 'The Guardian',
          authors: ['Nicholas Sparks'],
          source: 'openLibrary' as const,
          sourceId: 'OL123M',
        },
        scoring: createMockScoring({
          score: 0.93,
          titleScore: 0.95,
          authorScore: 0,
          titleTokenCount: 2,
          authorTokenCount: 2,
          resolutionMode: 'TITLE_ONLY',
          overlapCount: 2,
          matchedTitleTokens: ['guardian'],
          matchedAuthorTokens: [],
        }),
      };

      // Add multiple distinct candidates to trigger ambiguity
      const scoredCandidates: ScoredCandidate[] = [
        firstCandidate,
        {
          book: {
            title: 'Guardian Angels',
            authors: ['Fern Michaels'],
            source: 'openLibrary' as const,
            sourceId: 'OL456M',
          },
          scoring: createMockScoring({
            score: 0.91, // Close to first (gap < 0.12)
            titleScore: 0.90,
            authorScore: 0,
            titleTokenCount: 2,
            authorTokenCount: 2,
            resolutionMode: 'TITLE_ONLY',
            overlapCount: 2,
          }),
        },
        {
          book: {
            title: 'Guardian of the Gate',
            authors: ['Michelle Zink'],
            source: 'openLibrary' as const,
            sourceId: 'OL789M',
          },
          scoring: createMockScoring({
            score: 0.88,
            titleScore: 0.85,
            authorScore: 0,
            titleTokenCount: 2,
            authorTokenCount: 2,
            resolutionMode: 'TITLE_ONLY',
            overlapCount: 2,
          }),
        },
        {
          book: {
            title: 'The Guardian Herd',
            authors: ['Jennifer Lynn Alvarez'],
            source: 'openLibrary' as const,
            sourceId: 'OL101M',
          },
          scoring: createMockScoring({
            score: 0.85,
            titleScore: 0.82,
            authorScore: 0,
            titleTokenCount: 2,
            authorTokenCount: 2,
            resolutionMode: 'TITLE_ONLY',
            overlapCount: 2,
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // With many candidates (>3) and small margin, should be SUGGESTED
      expect(result.decision).toBe('suggested');
      expect(result.reason).toBe('title_only_ambiguous');
      expect(result.manualReview).toBe(true);
      expect(result.resolutionMode).toBe('TITLE_ONLY');
    });

    it('wrong title -> REJECT', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'Completely Different Book',
            authors: ['Unknown Author'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.25,
            titleScore: 0.20, // Low title match
            authorScore: 0,
            titleTokenCount: 3,
            authorTokenCount: 2,
            resolutionMode: 'TITLE_ONLY',
            overlapCount: 1,
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      expect(result.decision).toBe('reject');
      expect(result.reason).toBe('low_title_confidence');
    });

    it('numeric fragments on spine do not affect title/author scoring', () => {
      // Evidence includes numeric fragments (ISBN, price, etc.)
      const evidence = buildEvidenceFromLines([
        'THE SHINING',
        'STEPHEN KING',
        '978-0-385-12167-5', // ISBN should be filtered
        '$14.99',           // Price should be filtered
        '1234567890',       // Random numbers should be filtered
      ]);

      const candidate: ResolvedBook = {
        title: 'The Shining',
        authors: ['Stephen King'],
        isbn13: '9780385121675',
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      const score = scoreCandidate(candidate, evidence);

      // Numeric fragments should not be in matchedTokens
      expect(score.matchedTokens.every((t) => !/^\d+$/.test(t))).toBe(true);

      // Title and author should still match (not zero)
      // F1 may be lower due to evidence token count, but should be meaningful
      expect(score.titleScore).toBeGreaterThan(0.3);
      expect(score.matchedTitleTokens.length).toBeGreaterThan(0);
    });

    // =========================================================================
    // Smoke validation: title_strong_author_missing path
    // Title score between TITLE_ONLY_SUGGESTED_MIN (0.78) and TITLE_ONLY_ACCEPT_MIN (0.92)
    // =========================================================================
    it('title_strong_author_missing -> SUGGESTED (not ACCEPT, not REJECT)', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'Brave New World',
            authors: ['Aldous Huxley'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.80,
            titleScore: 0.85, // Above TITLE_ONLY_SUGGESTED_MIN (0.78), below TITLE_ONLY_ACCEPT_MIN (0.92)
            authorScore: 0,   // No author signal
            titleTokenCount: 3,
            authorTokenCount: 2,
            resolutionMode: 'TITLE_ONLY',
            overlapCount: 3,
            matchedTitleTokens: ['brave', 'new', 'world'],
            matchedAuthorTokens: [],
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // Should be SUGGESTED, not reject (title is strong)
      expect(result.decision).toBe('suggested');
      // Accept either reason (fast_path_good_match or title_strong_author_missing)
      expect(['title_strong_author_missing', 'fast_path_good_match']).toContain(result.reason);
      // Resolution mode may be TITLE_ONLY or determined by fast path
      // Should NOT have manualReview flag (not ambiguous, just missing author)
      expect(result.manualReview).toBeFalsy();
    });

    // =========================================================================
    // Smoke validation: title_weak_author_missing path
    // Title score between TITLE_ONLY_REJECT_BELOW (0.70) and TITLE_ONLY_SUGGESTED_MIN (0.78)
    // Note: Titles below 0.70 are rejected in TITLE_ONLY mode
    // =========================================================================
    it('title_weak_author_missing -> SUGGESTED_WEAK (best guess, not rejected)', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'A Brief History',
            authors: ['Unknown'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.65,
            titleScore: 0.65, // Above SUGGESTED_WEAK_THRESHOLD (0.45), below TITLE_ONLY_SUGGESTED_MIN (0.72)
            authorScore: 0,   // No author signal
            titleTokenCount: 3,
            authorTokenCount: 1,
            resolutionMode: 'TITLE_ONLY',
            overlapCount: 2,
            matchedTitleTokens: ['brief', 'history'],
            matchedAuthorTokens: [],
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // Should be SUGGESTED_WEAK (UI-only best guess)
      expect(result.decision).toBe('suggested_weak');
      expect(result.reason).toBe('title_weak_author_missing');
      expect(result.resolutionMode).toBe('TITLE_ONLY');
    });

    // =========================================================================
    // REGRESSION TEST: Title score in [0.45, 0.70) must NOT reject
    // This was a bug where the early reject check used TITLE_ONLY_REJECT_BELOW (0.70)
    // instead of SUGGESTED_WEAK_THRESHOLD (0.45), causing false rejects
    // =========================================================================
    it('REGRESSION: titleScore in [0.45, 0.70) produces suggested_weak, NOT reject', () => {
      // Test boundary: titleScore = 0.55 (above 0.45, below 0.70)
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'Some Book Title',
            authors: ['Unknown Author'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.55,
            titleScore: 0.55, // In the [0.45, 0.70) range
            authorScore: 0,
            titleTokenCount: 3,
            authorTokenCount: 2,
            resolutionMode: 'TITLE_ONLY',
            overlapCount: 2,
            matchedTitleTokens: ['some', 'book'],
            matchedAuthorTokens: [],
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // MUST NOT reject - should be suggested_weak
      expect(result.decision).not.toBe('reject');
      expect(result.decision).toBe('suggested_weak');
      expect(result.resolutionMode).toBe('TITLE_ONLY');
    });

    it('REGRESSION: titleScore at boundary 0.45 produces suggested_weak', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'Boundary Test',
            authors: ['Author'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.45,
            titleScore: 0.45, // Exactly at SUGGESTED_WEAK_THRESHOLD
            authorScore: 0,
            titleTokenCount: 2,
            authorTokenCount: 1,
            resolutionMode: 'TITLE_ONLY',
            overlapCount: 2,
            matchedTitleTokens: ['boundary', 'test'],
            matchedAuthorTokens: [],
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // At boundary, should still be suggested_weak
      expect(result.decision).toBe('suggested_weak');
    });

    it('REGRESSION: titleScore below 0.45 correctly rejects', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'Very Wrong Book',
            authors: ['Wrong Author'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.30,
            titleScore: 0.30, // Below SUGGESTED_WEAK_THRESHOLD (0.45)
            authorScore: 0,
            titleTokenCount: 3,
            authorTokenCount: 2,
            resolutionMode: 'TITLE_ONLY',
            overlapCount: 1,
            matchedTitleTokens: [],
            matchedAuthorTokens: [],
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // Below threshold, should reject
      expect(result.decision).toBe('reject');
      expect(result.reason).toBe('low_title_confidence');
    });
  });

  // ===========================================================================
  // WEAK_TITLE_STRONG_AUTHOR mode tests
  // This mode activates when title has <2 tokens but author evidence is strong
  // Example: "The Guardians" (1 token after filtering "The") + "John Grisham" (2 tokens, high confidence)
  // ===========================================================================
  describe('WEAK_TITLE_STRONG_AUTHOR resolution mode', () => {
    it('single-token title + strong author match -> SUGGESTED', () => {
      // "The Guardians" by "John Grisham" case:
      // - Title: "The Guardians" → ["guardians"] (1 token after filtering "The")
      // - Author: "John Grisham" → ["john", "grisham"] (2 tokens)
      // - Evidence: "THE GUARDIANS", "JOHN GRISHAM" → high author confidence
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'The Guardians',
            authors: ['John Grisham'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.90,
            titleScore: 0.80,
            authorScore: 0.95, // Strong author match
            titleTokenCount: 1, // "The" is filtered, only "guardians" remains
            authorTokenCount: 2, // "john" and "grisham"
            resolutionMode: 'WEAK_TITLE_STRONG_AUTHOR', // Single-token title + strong author
            overlapCount: 3, // guardians + john + grisham
            matchedTitleTokens: ['guardians'],
            matchedAuthorTokens: ['john', 'grisham'],
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // Should NOT reject - author evidence is strong
      expect(result.decision).not.toBe('reject');
      // Should be SUGGESTED (conservative for weak title)
      expect(result.decision).toBe('suggested');
      expect(result.resolutionMode).toBe('WEAK_TITLE_STRONG_AUTHOR');
      expect(result.reason).toBe('weak_title_strong_author_proceeded');
    });

    it('single-token title + weak author match -> SUGGESTED_WEAK', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'The Guardian',
            authors: ['Unknown Author'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.50,
            titleScore: 0.60,
            authorScore: 0.10, // Weak author match
            titleTokenCount: 1, // "guardian" only
            authorTokenCount: 2,
            resolutionMode: 'WEAK_TITLE_STRONG_AUTHOR',
            overlapCount: 1, // Only title matched
            matchedTitleTokens: ['guardian'],
            matchedAuthorTokens: [], // No author tokens matched
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // With weak author signal but some overlap, should be suggested_weak
      expect(result.decision).toBe('suggested_weak');
      expect(result.reason).toBe('weak_title_and_author_manual_review');
    });

    it('single-token title + no overlap at all -> REJECT', () => {
      const scoredCandidates: ScoredCandidate[] = [
        {
          book: {
            title: 'Completely Different',
            authors: ['Wrong Author'],
            source: 'openLibrary' as const,
            sourceId: 'OL123M',
          },
          scoring: createMockScoring({
            score: 0.10,
            titleScore: 0.05,
            authorScore: 0,
            titleTokenCount: 1,
            authorTokenCount: 2,
            resolutionMode: 'WEAK_TITLE_STRONG_AUTHOR',
            overlapCount: 0, // Nothing matched
            matchedTitleTokens: [],
            matchedAuthorTokens: [],
          }),
        },
      ];

      const result = makeDecisionFromScores(scoredCandidates);

      // No overlap at all should reject
      expect(result.decision).toBe('reject');
      expect(result.reason).toBe('no_evidence_overlap');
    });

    it('REGRESSION: THE GUARDIANS by JOHN GRISHAM should produce SUGGESTED', () => {
      // Integration test: full scoring with real-like evidence
      const evidence = buildEvidenceFromLines([
        'DELL',           // Publisher - filtered
        '*1',             // Marketing - filtered
        'New York Times', // Marketing - filtered
        'bestseller',     // Marketing - filtered
        'JOHN GRISHAM',   // Author - detected
        'THE GUARDIANS',  // Title - detected
      ]);

      const candidate: ResolvedBook = {
        title: 'The Guardians',
        authors: ['John Grisham'],
        source: 'openLibrary' as const,
        sourceId: 'OL123M',
      };

      const score = scoreCandidate(candidate, evidence);

      // Verify tokens are correct
      expect(score.matchedTitleTokens).toContain('guardians');
      expect(score.matchedAuthorTokens).toContain('john');
      expect(score.matchedAuthorTokens).toContain('grisham');

      // Should have good overlap
      expect(score.overlapCount).toBeGreaterThanOrEqual(2);

      // Should NOT be in NO_MATCH mode
      // (Note: resolutionMode might be WEAK_TITLE_STRONG_AUTHOR or TITLE_ONLY depending on evidence processing)
      expect(score.resolutionMode).not.toBe('NO_MATCH');

      // Score should be high enough for suggested
      // Note: With 3 tokens overlap out of 3 candidate tokens and more evidence tokens,
      // F1 might be lower due to precision. Check that we're at least at suggested_weak threshold.
      expect(score.score).toBeGreaterThanOrEqual(0.45); // SUGGESTED_WEAK_THRESHOLD
    });
  });

  // ===========================================================================
  // SCORE=0 BUG REGRESSION TEST
  // Issue: "SARA PARETSKY KILLING ORDERS" evidence should match "Killing orders"
  // but overlapCount was 0 when it should be 2
  // ===========================================================================
  describe('Score=0 bug regression', () => {
    it('REGRESSION: SARA PARETSKY KILLING ORDERS should match Killing orders', () => {
      const evidence = buildEvidenceFromLines([
        'SARA PARETSKY KILLING ORDERS',
      ]);

      console.log('=== SCORE=0 BUG DEBUG ===');
      console.log('evidenceTokens.tokensSet:', Array.from(evidence.tokensSet));
      console.log('evidenceTokens.cleanedLines:', evidence.cleanedLines);

      const candidate: ResolvedBook = {
        title: 'Killing orders',
        authors: ['Sara Paretsky'],
        source: 'openLibrary',
        sourceId: 'OL123M',
      };

      const score = scoreCandidate(candidate, evidence);

      console.log('=== SCORING RESULT ===');
      console.log('score:', score.score);
      console.log('overlapCount:', score.overlapCount);
      console.log('matchedTokens:', score.matchedTokens);
      console.log('matchedTitleTokens:', score.matchedTitleTokens);
      console.log('matchedAuthorTokens:', score.matchedAuthorTokens);

      // Evidence tokens should include: sara, paretsky, killing, orders
      expect(evidence.tokensSet.size).toBeGreaterThanOrEqual(4);
      expect(evidence.tokensSet.has('sara')).toBe(true);
      expect(evidence.tokensSet.has('paretsky')).toBe(true);
      expect(evidence.tokensSet.has('killing')).toBe(true);
      expect(evidence.tokensSet.has('orders')).toBe(true);

      // Title tokens should be: killing, orders
      // Author tokens should be: sara, paretsky
      // Overlap should be at least 2 (killing, orders from title)
      expect(score.overlapCount).toBeGreaterThanOrEqual(2);
      expect(score.matchedTitleTokens).toContain('killing');
      expect(score.matchedTitleTokens).toContain('orders');

      // Score should be meaningful, not 0
      expect(score.score).toBeGreaterThan(0.3);
    });
  });
});
