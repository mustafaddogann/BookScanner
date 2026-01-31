/**
 * Evidence Search Diagnostics Test
 *
 * Runs evidence-driven search on test cases and prints diagnostics:
 * - Pass/Suggest/Accept/Reject counts
 * - Median topScore
 * - Distribution of overlapCount
 *
 * This test validates the token-set fuzzy scoring implementation.
 */

import {
  scoreCandidate,
  scoreAndRankCandidates,
  buildEvidenceFromLines,
  makeDecisionFromScores,
  type ScoredCandidate,
} from '../candidateScoring';
import { tokenSetFuzzyScore, levenshteinSimilarity } from '../tokenSetFuzzyScoring';
import type { ResolvedBook } from '../../types';

// ============================================================================
// Test Cases: Simulated Evidence + Known Books
// ============================================================================

interface TestCase {
  name: string;
  evidenceLines: string[];
  expectedBook: {
    title: string;
    authors: string[];
  };
  otherCandidates?: ResolvedBook[];
}

const TEST_CASES: TestCase[] = [
  {
    name: 'The Guardian - Jumbled OCR',
    evidenceLines: [
      'FICTION',
      'NICHOLAS SPARKS',
      'THE GUARDIAN',
      '2004',
    ],
    expectedBook: {
      title: 'The Guardian',
      authors: ['Nicholas Sparks'],
    },
    otherCandidates: [
      {
        title: 'Guardian Angels',
        authors: ['Fern Michaels'],
        source: 'openLibrary',
        sourceId: 'OL456M',
      },
      {
        title: 'The Guardian of Lies',
        authors: ['Kate Furnivall'],
        source: 'openLibrary',
        sourceId: 'OL789M',
      },
    ],
  },
  {
    name: 'The Shining - Clean OCR',
    evidenceLines: [
      'THE SHINING',
      'STEPHEN KING',
    ],
    expectedBook: {
      title: 'The Shining',
      authors: ['Stephen King'],
    },
    otherCandidates: [
      {
        title: 'Doctor Sleep',
        authors: ['Stephen King'],
        source: 'openLibrary',
        sourceId: 'OL999M',
      },
    ],
  },
  {
    name: 'Gone Girl - Partial Match',
    evidenceLines: [
      'GONE GIRL',
      'FLYNN',
      'A NOVEL',
    ],
    expectedBook: {
      title: 'Gone Girl',
      authors: ['Gillian Flynn'],
    },
  },
  {
    name: 'ISBN Match - High Confidence',
    evidenceLines: [
      'THE ALCHEMIST',
      'PAULO COELHO',
      'ISBN 9780061122415',
    ],
    expectedBook: {
      title: 'The Alchemist',
      authors: ['Paulo Coelho'],
    },
  },
  {
    name: 'Fuzzy Match - OCR Errors',
    evidenceLines: [
      'HARY POTER',  // Misspelled
      'J K ROWLING',
      'CHAMBER OF SECRETS',
    ],
    expectedBook: {
      title: 'Harry Potter and the Chamber of Secrets',
      authors: ['J.K. Rowling'],
    },
  },
  {
    name: 'Generic Title - Should Penalize',
    evidenceLines: [
      'HOME',
      'AUTHOR UNKNOWN',
    ],
    expectedBook: {
      title: 'Home',
      authors: ['Marilynne Robinson'],
    },
  },
  {
    name: 'Multi-Author Book',
    evidenceLines: [
      'FREAKONOMICS',
      'STEVEN D LEVITT',
      'STEPHEN J DUBNER',
    ],
    expectedBook: {
      title: 'Freakonomics',
      authors: ['Steven D. Levitt', 'Stephen J. Dubner'],
    },
  },
  {
    name: 'Long Title - Token Overlap',
    evidenceLines: [
      'THE GIRL WITH',
      'THE DRAGON TATTOO',
      'STIEG LARSSON',
    ],
    expectedBook: {
      title: 'The Girl with the Dragon Tattoo',
      authors: ['Stieg Larsson'],
    },
  },
];

// ============================================================================
// Diagnostics Functions
// ============================================================================

function buildCandidates(testCase: TestCase): ResolvedBook[] {
  const correct: ResolvedBook = {
    title: testCase.expectedBook.title,
    authors: testCase.expectedBook.authors,
    source: 'openLibrary',
    sourceId: 'OL_EXPECTED',
    // Add ISBN for the ISBN test case
    ...(testCase.name.includes('ISBN') ? { isbn13: '9780061122415' } : {}),
  };

  return [correct, ...(testCase.otherCandidates || [])];
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ============================================================================
// Tests
// ============================================================================

describe('Evidence Search Diagnostics', () => {
  describe('Levenshtein Similarity', () => {
    it('computes exact match as 1.0', () => {
      expect(levenshteinSimilarity('harry', 'harry')).toBe(1.0);
    });

    it('computes fuzzy match for OCR errors', () => {
      // HARY vs HARRY - 1 character difference in 5-char string
      const sim = levenshteinSimilarity('hary', 'harry');
      expect(sim).toBeGreaterThan(0.75);
    });

    it('computes low similarity for unrelated strings', () => {
      const sim = levenshteinSimilarity('apple', 'orange');
      expect(sim).toBeLessThan(0.5);
    });
  });

  describe('Token Set Fuzzy Scoring', () => {
    it('scores matching evidence high', () => {
      const result = tokenSetFuzzyScore(
        'THE GUARDIAN NICHOLAS SPARKS',
        'The Guardian',
        ['Nicholas Sparks']
      );

      expect(result.score).toBeGreaterThan(0.6);
      expect(result.overlapCount).toBeGreaterThanOrEqual(2);
    });

    it('handles fuzzy token matching (OCR errors)', () => {
      const result = tokenSetFuzzyScore(
        'HARY POTER CHAMBER SECRETS',
        'Harry Potter and the Chamber of Secrets',
        ['J.K. Rowling']
      );

      // Should still find matches via fuzzy matching
      expect(result.overlapCount).toBeGreaterThanOrEqual(2);
    });

    it('adds ISBN bonus when matched', () => {
      const withIsbn = tokenSetFuzzyScore(
        'THE ALCHEMIST PAULO COELHO',
        'The Alchemist',
        ['Paulo Coelho'],
        { isbnMatch: true }
      );

      const withoutIsbn = tokenSetFuzzyScore(
        'THE ALCHEMIST PAULO COELHO',
        'The Alchemist',
        ['Paulo Coelho'],
        { isbnMatch: false }
      );

      expect(withIsbn.score).toBeGreaterThan(withoutIsbn.score);
      expect(withIsbn.isbnBonus).toBe(0.15);
    });
  });

  describe('Full Pipeline Diagnostics', () => {
    const results: {
      name: string;
      decision: string;
      topScore: number;
      overlapCount: number;
      isbnMatched: boolean;
      correctRankedFirst: boolean;
    }[] = [];

    beforeAll(() => {
      // Run all test cases
      for (const testCase of TEST_CASES) {
        const evidence = buildEvidenceFromLines(testCase.evidenceLines);
        const candidates = buildCandidates(testCase);
        const scored = scoreAndRankCandidates(candidates, evidence);
        const decision = makeDecisionFromScores(scored);

        const topCandidate = decision.topCandidate;
        const correctRankedFirst = topCandidate?.book.sourceId === 'OL_EXPECTED';

        results.push({
          name: testCase.name,
          decision: decision.decision,
          topScore: topCandidate?.scoring.score || 0,
          overlapCount: topCandidate?.scoring.overlapCount || 0,
          isbnMatched: topCandidate?.scoring.isbnMatched || false,
          correctRankedFirst,
        });
      }
    });

    it('ranks correct candidate first in most cases', () => {
      const correctCount = results.filter((r) => r.correctRankedFirst).length;
      console.log(`\n[Diagnostics] Correct ranked first: ${correctCount}/${results.length}`);
      expect(correctCount).toBeGreaterThanOrEqual(Math.floor(results.length * 0.7));
    });

    it('produces expected decision distribution', () => {
      const counts = {
        accept_high: 0,
        accept_medium: 0,
        suggested: 0,
        reject: 0,
      };

      for (const r of results) {
        if (r.decision in counts) {
          counts[r.decision as keyof typeof counts]++;
        }
      }

      console.log('\n[Diagnostics] Decision Distribution:');
      console.log(`  accept_high:   ${counts.accept_high}`);
      console.log(`  accept_medium: ${counts.accept_medium}`);
      console.log(`  suggested:     ${counts.suggested}`);
      console.log(`  reject:        ${counts.reject}`);

      // Most should be accept or suggested
      const acceptOrSuggested = counts.accept_high + counts.accept_medium + counts.suggested;
      expect(acceptOrSuggested).toBeGreaterThanOrEqual(Math.floor(results.length * 0.5));
    });

    it('has reasonable topScore median', () => {
      const scores = results.map((r) => r.topScore);
      const median = computeMedian(scores);

      console.log(`\n[Diagnostics] TopScore Statistics:`);
      console.log(`  Median: ${(median * 100).toFixed(1)}%`);
      console.log(`  Min: ${(Math.min(...scores) * 100).toFixed(1)}%`);
      console.log(`  Max: ${(Math.max(...scores) * 100).toFixed(1)}%`);

      // Median should be reasonable (at least 40%)
      expect(median).toBeGreaterThanOrEqual(0.4);
    });

    it('has reasonable overlapCount distribution', () => {
      const overlaps = results.map((r) => r.overlapCount);
      const distribution: Record<number, number> = {};
      for (const o of overlaps) {
        distribution[o] = (distribution[o] || 0) + 1;
      }

      console.log(`\n[Diagnostics] OverlapCount Distribution:`);
      for (const [count, freq] of Object.entries(distribution).sort((a, b) => Number(a[0]) - Number(b[0]))) {
        console.log(`  ${count} tokens: ${freq} cases`);
      }

      // Average overlap should be >= 2
      const avgOverlap = overlaps.reduce((a, b) => a + b, 0) / overlaps.length;
      console.log(`  Average: ${avgOverlap.toFixed(1)}`);
      expect(avgOverlap).toBeGreaterThanOrEqual(2);
    });

    it('prints full diagnostics table', () => {
      console.log('\n[Diagnostics] Full Results Table:');
      console.log('─'.repeat(80));
      console.log(
        `${'Name'.padEnd(35)} | ${'Decision'.padEnd(13)} | ${'Score'.padEnd(6)} | ${'Overlap'.padEnd(7)} | ${'ISBN'.padEnd(4)} | Correct`
      );
      console.log('─'.repeat(80));

      for (const r of results) {
        console.log(
          `${r.name.padEnd(35)} | ${r.decision.padEnd(13)} | ${(r.topScore * 100).toFixed(0).padStart(4)}%  | ${String(r.overlapCount).padStart(7)} | ${r.isbnMatched ? 'yes' : 'no '.padEnd(3)} | ${r.correctRankedFirst ? 'YES' : 'NO'}`
        );
      }
      console.log('─'.repeat(80));
    });
  });
});
