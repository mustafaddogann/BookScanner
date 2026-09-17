import { buildEvidenceTokens, normalizeForScoring, splitJoinedWords } from '../evidenceNormalization';
import { makeDecisionFromScores, scoreAndRankCandidates } from '../candidateScoring';
import type { ResolvedBook } from '../../types';

const book = (title: string, authors: string[], id = 'OL1M'): ResolvedBook => ({
  title,
  authors,
  source: 'openLibrary',
  sourceId: id,
});

function decide(lines: string[], books: ResolvedBook[]) {
  return makeDecisionFromScores(scoreAndRankCandidates(books, buildEvidenceTokens(lines)));
}

describe('real-scan matches that should be accepted', () => {
  it('keeps accented letters when tokenizing', () => {
    expect(normalizeForScoring('Ali Ünal')).toEqual(['ali', 'unal']);
    expect(normalizeForScoring('Öldürmek')).toEqual(['oldurmek']);
    expect(normalizeForScoring('Kısa')).toEqual(['kisa']);
  });

  it('splits words OCR joined at a case change, but not name prefixes', () => {
    expect(splitJoinedWords('venderKahane')).toBe('vender Kahane');
    expect(splitJoinedWords('yazarŞeker')).toBe('yazar Şeker');
    for (const name of ['McDonald', 'MacDonald', 'DeLillo', 'LeBron', 'BALIKCIVE']) {
      expect(splitJoinedWords(name)).toBe(name);
    }
  });

  it('accepts a match whose author surname was joined to another word (Kahane)', () => {
    const decision = decide(
      ['venderKahane', 'Logic ans Contemporary Rhetoric'],
      [book('Logic and contemporary rhetoric', ['Howard Kahane', 'Nancy Cavender'])]
    );
    expect(decision.decision).toBe('accept_medium');
  });

  it('accepts a full title with a surname-only author (Ünal)', () => {
    const decision = decide(
      ['Living the Ethics and Morality of Islam', 'UNAL', 'uvaneu'],
      [book('Living the ethics and morality of Islam', ['Ali Ünal'])]
    );
    expect(decision.decision).toBe('accept_medium');
  });

  it('accepts a multi-author book when one surname matches (Gender)', () => {
    const decision = decide(
      ['GENDER', 'IDEAS • INTERACTIONS • INSTITUTIONS', 'VIADE', 'FERRE'],
      [book('Gender - Ideas, Interactions, Institutions', ['Lisa Wade', 'Myra Marx Ferree'])]
    );
    expect(decision.decision).toBe('accept_medium');
  });

  it('accepts a one-word title with a matching surname (Think)', () => {
    const decision = decide(
      ['BLACKBURN', 'Think', 'OXFORD'],
      [book('Think', ['Simon Blackburn'])]
    );
    expect(decision.decision).toBe('accept_medium');
    expect(decision.reason).toBe('anchored_title_surname_match');
  });

  it('keeps a one-word title as suggested when a close competitor exists', () => {
    const scored = scoreAndRankCandidates(
      [book('Think', ['Simon Blackburn'], 'OL1M'), book('Think Again', ['Simon Blackburn'], 'OL2M')],
      buildEvidenceTokens(['BLACKBURN', 'Think'])
    );
    // Pin the competitor inside the ambiguity margin
    const [top, competitor] = scored;
    const close = { ...competitor, scoring: { ...competitor.scoring, score: top.scoring.score - 0.03 } };

    const decision = makeDecisionFromScores([top, close]);
    expect(decision.decision).not.toBe('accept_medium');
  });

  it('does not accept a same-title match when the spine names a different author', () => {
    const decision = decide(
      ['WOMEN OF COLOR AND FEMINISM MATTICE ROUS PHO'],
      [book('Women of color', ['Darlene Mathis'])]
    );
    expect(decision.decision).not.toBe('accept_medium');
  });

  it('does not accept a partial title match whose author was not read', () => {
    const decision = decide(
      ['Harper Lee •Bülbülü Öldürmek'],
      [book('Kumandanı Öldürmek', ['村上春樹'])]
    );
    expect(decision.decision).not.toBe('accept_medium');
  });

  it('does not count an author-name word in a candidate title as title evidence', () => {
    // Real scan: only "Mitch Albom" was readable; the wrong record "The live Albom" was auto-accepted
    const decision = decide(
      ['Mitch Albom', 'the ine', 'the for the'],
      [
        book('The live Albom', ['Mitch Albom'], 'OL1M'),
        book('The Stranger in the Lifeboat', ['Mitch Albom'], 'OL2M'),
        book('Tuesdays with Morrie', ['Mitch Albom'], 'OL3M'),
      ]
    );
    expect(decision.decision).not.toBe('accept_medium');
    expect(decision.decision).not.toBe('accept_high');
  });

  it('shows the correctly spelled record when a typo record scores highest', () => {
    const decision = decide(
      ['THINKING,', 'FAST AND SLOW', 'DANIEL', 'KAHNEMAN'],
      [
        book('thiking fast and slow', ['Daniel Kahneman'], 'OL1M'),
        book('Thinking, fast and slow', ['Daniel Kahneman'], 'OL2M'),
        book('Thinking Fast and Slow by Daniel Kahneman', ['Gloria J. Russell'], 'OL3M'),
      ]
    );
    expect(decision.topCandidate?.book.title).toBe('Thinking, fast and slow');
  });
});
