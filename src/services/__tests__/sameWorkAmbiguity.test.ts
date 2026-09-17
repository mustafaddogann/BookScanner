import { buildEvidenceTokens } from '../evidenceNormalization';
import { makeDecisionFromScores, scoreAndRankCandidates } from '../candidateScoring';
import type { ResolvedBook } from '../../types';

const book = (title: string, author: string, id: string): ResolvedBook => ({
  title,
  authors: [author],
  source: 'openLibrary',
  sourceId: id,
});

function decide(lines: string[], books: ResolvedBook[]) {
  const scored = scoreAndRankCandidates(books, buildEvidenceTokens(lines));
  return makeDecisionFromScores(scored);
}

describe('ambiguity ignores other records of the same work', () => {
  it('does not treat study guides as competitors (Lord of the Flies scan)', () => {
    const decision = decide(
      ['WILLIAM GOLDING', 'LORD of the FLIES'],
      [
        book('Lord of the Flies', 'William Golding', 'OL1M'),
        book("William Golding's Lord of the flies", 'Harold Bloom', 'OL2M'),
        book("William Golding's Lord of the flies", 'Mary Hartley', 'OL3M'),
        book('Bloom\'s Notes: Lord of the Flies', 'Harold Bloom', 'OL4M'),
      ]
    );
    expect(decision.topCandidate?.book.title).toBe('Lord of the Flies');
    expect(decision.scoreGap).toBe(1);
  });

  it('merges a typo record with the correct record (Thinking, Fast and Slow scan)', () => {
    const decision = decide(
      ['THINKING,', 'FAST AND SLOW', 'DANIEL', 'KAHNEMAN'],
      [
        book('thiking fast and slow', 'Daniel Kahneman', 'OL1M'),
        book('Thinking, fast and slow', 'Daniel Kahneman', 'OL2M'),
        book('Thinking Fast and Slow by Daniel Kahneman', 'Gloria J. Russell', 'OL3M'),
        book('Summary of Thinking, Fast and Slow', 'Instaread Summaries', 'OL4M'),
      ]
    );
    expect(decision.scoreGap).toBe(1);
  });

  it('still flags two different books by the same author as ambiguous candidates', () => {
    const decision = decide(
      ['ISAAC ASIMOV', 'FOUNDATION'],
      [
        book('Foundation', 'Isaac Asimov', 'OL1M'),
        book('Foundation and Empire', 'Isaac Asimov', 'OL2M'),
      ]
    );
    expect(decision.scoreGap).toBeLessThan(1);
  });
});
