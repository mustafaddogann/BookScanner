/**
 * Unit tests for bracket stripping and weak title + strong author gating
 */

import {
  normalizeLine,
  buildEvidenceTokens,
  recoverAuthorCandidates,
} from '../evidenceNormalization';
import {
  scoreCandidate,
  makeDecisionFromScores,
  scoreAndRankCandidates,
} from '../candidateScoring';
import type { ResolvedBook } from '../../types';

describe('normalizeLine bracket stripping', () => {
  it('strips brackets from fully wrapped lines', () => {
    const result = normalizeLine('[NICHOLAS SPARKS]');
    expect(result.wasWrapped).toBe(true);
    expect(result.original).toBe('NICHOLAS SPARKS');
    expect(result.normalized).toBe('nicholas sparks');
  });

  it('strips parentheses from fully wrapped lines', () => {
    const result = normalizeLine('(JOHN GRISHAM)');
    expect(result.wasWrapped).toBe(true);
    expect(result.original).toBe('JOHN GRISHAM');
  });

  it('strips curly braces from fully wrapped lines', () => {
    const result = normalizeLine('{STEPHEN KING}');
    expect(result.wasWrapped).toBe(true);
    expect(result.original).toBe('STEPHEN KING');
  });

  it('does not mark partially bracketed lines as wrapped', () => {
    const result = normalizeLine('[FICTION] SPARKS');
    expect(result.wasWrapped).toBe(false);
  });

  it('handles normal lines without brackets', () => {
    const result = normalizeLine('THE GUARDIAN');
    expect(result.wasWrapped).toBe(false);
    expect(result.original).toBe('THE GUARDIAN');
  });
});

describe('recoverAuthorCandidates with wrapped lines', () => {
  it('gives high confidence (0.9) to bracketed author names', () => {
    const wrappedLines = ['NICHOLAS SPARKS'];
    const candidates = recoverAuthorCandidates([], [], wrappedLines);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].line).toBe('NICHOLAS SPARKS');
    expect(candidates[0].confidence).toBe(0.9);
    expect(candidates[0].reason).toBe('bracketed_author_name');
  });

  it('rejects single-word wrapped lines as author names', () => {
    const wrappedLines = ['FICTION'];
    const candidates = recoverAuthorCandidates([], [], wrappedLines);

    // Single word should not be treated as author
    const bracketedCandidate = candidates.find(c => c.reason === 'bracketed_author_name');
    expect(bracketedCandidate).toBeUndefined();
  });

  it('accepts 2-4 word wrapped lines as author names', () => {
    const wrappedLines = ['MARY HIGGINS CLARK'];
    const candidates = recoverAuthorCandidates([], [], wrappedLines);

    expect(candidates[0].line).toBe('MARY HIGGINS CLARK');
    expect(candidates[0].confidence).toBe(0.9);
  });
});

describe('buildEvidenceTokens with brackets', () => {
  it('extracts bestAuthorConfidence from bracketed lines', () => {
    const lines = ['FICTION', '[NICHOLAS SPARKS]', 'THE', 'GUARDIAN'];
    const tokens = buildEvidenceTokens(lines);

    expect(tokens.bestAuthorConfidence).toBe(0.9);
    expect(tokens.bestAuthorTokenCount).toBe(2);
  });

  it('returns low confidence when no author evidence', () => {
    const lines = ['FICTION', 'THE', 'GUARDIAN'];
    const tokens = buildEvidenceTokens(lines);

    expect(tokens.bestAuthorConfidence).toBeLessThan(0.75);
  });
});

describe('WEAK_TITLE_STRONG_AUTHOR gating', () => {
  const mockBook: ResolvedBook = {
    title: 'The Guardian',
    authors: ['Nicholas Sparks'],
    source: 'openLibrary',
    sourceId: 'OL123W',
  };
  const oneWordBook: ResolvedBook = { ...mockBook, title: 'Guardian' };

  it('does NOT reject when title is weak but author evidence is strong', () => {
    // Evidence: FICTION, [NICHOLAS SPARKS], THE, GUARDIAN
    // Title "THE GUARDIAN" becomes just "GUARDIAN" (1 token after stopword removal)
    // But author "NICHOLAS SPARKS" is bracketed (high confidence)
    const lines = ['FICTION', '[NICHOLAS SPARKS]', 'THE', 'GUARDIAN'];
    const evidenceTokens = buildEvidenceTokens(lines);

    const scored = scoreAndRankCandidates([mockBook], evidenceTokens);
    const decision = makeDecisionFromScores(scored);

    // "The Guardian" counts as a two-word title, so exact title + full author name is accepted
    expect(decision.decision).not.toBe('reject');
    expect(['accept_medium', 'suggested', 'suggested_weak']).toContain(decision.decision);
  });

  it('uses WEAK_TITLE_STRONG_AUTHOR resolution mode for one-word titles', () => {
    const evidenceTokens = buildEvidenceTokens(['[NICHOLAS SPARKS]', 'GUARDIAN']);

    expect(scoreCandidate(oneWordBook, evidenceTokens).resolutionMode).toBe('WEAK_TITLE_STRONG_AUTHOR');
  });

  it('counts leading articles toward title length', () => {
    const evidenceTokens = buildEvidenceTokens(['[NICHOLAS SPARKS]', 'GUARDIAN']);

    expect(scoreCandidate(mockBook, evidenceTokens).resolutionMode).toBe('FULL_MATCH');
  });

  it('still rejects when both title AND author evidence are weak', () => {
    const lines = ['FICTION', 'THE'];
    const evidenceTokens = buildEvidenceTokens(lines);

    const scored = scoreAndRankCandidates([mockBook], evidenceTokens);
    const decision = makeDecisionFromScores(scored);

    // No meaningful evidence - should reject
    expect(decision.decision).toBe('reject');
  });
});
