/**
 * Unit tests for Supabase Resolver Client
 * Gate 9: Resolver + Scoring + Verification + Acceptance
 */

import type { BookCandidate, BookEvidence, EvidenceTier } from '../../types';
import {
  buildResolveRequest,
  applyResolverResult,
  normalizeSupabaseBaseUrl,
  buildEdgeFunctionUrl,
  ResolverResult,
  ResolveResponse,
} from '../supabaseResolverClient';

// ============================================================================
// Test Utilities
// ============================================================================

function createMockEvidence(text: string = 'Test Book\nTest Author'): BookEvidence {
  return {
    topCrops: [0],
    mergedLines: [
      { text: 'Test Book', normalizedText: 'testbook', confidence: 0.9, sourceCropIndex: 0, rotation: 0 },
      { text: 'Test Author', normalizedText: 'testauthor', confidence: 0.85, sourceCropIndex: 0, rotation: 0 },
    ],
    mergedTextBlock: text,
  };
}

function createMockCandidate(
  id: string = 'test-candidate',
  hypothesis?: BookCandidate['hypothesis']
): BookCandidate {
  return {
    id,
    detectionIndices: [0],
    cropIndices: [0],
    representativeDetectionIndex: 0,
    orderingKey: 0,
    angleRad: 0,
    confidenceScore: 0.9,
    evidence: createMockEvidence(),
    hypothesis,
  };
}

function createMockHypothesis(tier: EvidenceTier = 'strong'): BookCandidate['hypothesis'] {
  return {
    evidenceTier: tier,
    searchCandidates: [
      {
        query: 'Test Book Test Author',
        confidence: 0.85,
        cropIndex: 0,
        tier,
        tokens: ['test', 'book', 'author'],
        titleHint: 'Test Book',
        authorHint: 'Test Author',
      },
    ],
    isbnCandidates: ['9780123456789'],
    uiGuess: {
      title: 'Test Book',
      author: 'Test Author',
      confidence: 0.8,
    },
  };
}

// ============================================================================
// buildResolveRequest Tests
// ============================================================================

describe('buildResolveRequest', () => {
  it('returns null when candidate has no hypothesis', () => {
    const candidate = createMockCandidate('no-hypothesis');
    const result = buildResolveRequest('session-1', candidate);
    expect(result).toBeNull();
  });

  it('builds request from candidate with hypothesis', () => {
    const candidate = createMockCandidate('with-hypothesis', createMockHypothesis());
    const result = buildResolveRequest('session-1', candidate);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-1');
    expect(result!.candidateId).toBe('with-hypothesis');
    expect(result!.evidenceTier).toBe('strong');
    expect(result!.queries).toHaveLength(1);
    expect(result!.queries[0].query).toBe('Test Book Test Author');
    expect(result!.queries[0].titleHint).toBe('Test Book');
    expect(result!.queries[0].authorHint).toBe('Test Author');
    expect(result!.isbnCandidates).toHaveLength(1);
    expect(result!.isbnCandidates[0].isbn).toBe('9780123456789');
  });

  it('includes evidence hash in request', () => {
    const candidate = createMockCandidate('with-hash', createMockHypothesis());
    const result = buildResolveRequest('session-1', candidate);

    expect(result).not.toBeNull();
    expect(result!.evidenceHash).toBeDefined();
    expect(result!.evidenceHash.length).toBeGreaterThan(0);
  });

  it('handles different evidence tiers', () => {
    const tiers: EvidenceTier[] = ['strong', 'usable', 'weak', 'unusable'];

    for (const tier of tiers) {
      const candidate = createMockCandidate(`tier-${tier}`, createMockHypothesis(tier));
      const result = buildResolveRequest('session-1', candidate);

      expect(result).not.toBeNull();
      expect(result!.evidenceTier).toBe(tier);
    }
  });
});

// ============================================================================
// applyResolverResult Tests
// ============================================================================

describe('applyResolverResult', () => {
  it('returns candidate with pending decision when result is unsuccessful', () => {
    const candidate = createMockCandidate('failed', createMockHypothesis());
    const failedResult: ResolverResult = {
      success: false,
      error: 'Network error',
    };

    const updated = applyResolverResult(candidate, failedResult);

    expect(updated.resolverDecision).toBe('pending');
    expect(updated.resolvedBook).toBeUndefined();
    expect(updated.resolverSuggestions).toBeUndefined();
  });

  it('applies auto-accept decision correctly', () => {
    const candidate = createMockCandidate('accept', createMockHypothesis());
    const response: ResolveResponse = {
      status: 'resolved',
      cacheHit: true,
      quotaRemaining: 25,
      matches: [],
      acceptanceDecision: {
        type: 'auto-accept',
        book: {
          title: 'Resolved Book',
          authors: ['Resolved Author'],
          isbn13: '9780123456789',
          isbn10: undefined,
          publisher: 'Publisher',
          publishYear: '2023',
          edition: undefined,
          coverUrl: undefined,
          source: 'openLibrary',
          sourceId: 'OL123',
        },
        confidence: 0.92,
        reason: 'High confidence match',
      },
      canonicalBook: null,
      verificationFlags: [],
      processingTimeMs: 150,
    };
    const successResult: ResolverResult = {
      success: true,
      response,
    };

    const updated = applyResolverResult(candidate, successResult);

    expect(updated.resolverDecision).toBe('accept');
    expect(updated.resolvedBook).toBeDefined();
    expect(updated.resolvedBook!.title).toBe('Resolved Book');
    expect(updated.resolvedConfidence).toBe(0.92);
  });

  it('applies suggest decision correctly', () => {
    const candidate = createMockCandidate('suggest', createMockHypothesis());
    const mainBook = {
      title: 'Main Book',
      authors: ['Author 1'],
      isbn13: undefined,
      isbn10: undefined,
      publisher: undefined,
      publishYear: undefined,
      edition: undefined,
      coverUrl: undefined,
      source: 'openLibrary' as const,
      sourceId: 'OL1',
    };
    const altBook = {
      title: 'Alt Book',
      authors: ['Author 2'],
      isbn13: undefined,
      isbn10: undefined,
      publisher: undefined,
      publishYear: undefined,
      edition: undefined,
      coverUrl: undefined,
      source: 'openLibrary' as const,
      sourceId: 'OL2',
    };

    const response: ResolveResponse = {
      status: 'resolved',
      cacheHit: false,
      quotaRemaining: 20,
      matches: [],
      acceptanceDecision: {
        type: 'suggest',
        book: mainBook,
        confidence: 0.75,
        alternatives: [altBook],
        reason: 'Needs confirmation',
      },
      canonicalBook: mainBook,
      verificationFlags: [],
      processingTimeMs: 200,
    };
    const result: ResolverResult = {
      success: true,
      response,
    };

    const updated = applyResolverResult(candidate, result);

    expect(updated.resolverDecision).toBe('suggested');
    expect(updated.resolvedBook).toBeDefined();
    expect(updated.resolvedBook!.title).toBe('Main Book');
    expect(updated.resolverSuggestions).toHaveLength(1);
    expect(updated.resolverSuggestions![0].title).toBe('Alt Book');
    expect(updated.resolvedConfidence).toBe(0.75);
  });

  it('applies ambiguous decision correctly', () => {
    const candidate = createMockCandidate('ambiguous', createMockHypothesis());
    const candidates = [
      {
        title: 'Book A',
        authors: ['Author A'],
        isbn13: undefined,
        isbn10: undefined,
        publisher: undefined,
        publishYear: undefined,
        edition: undefined,
        coverUrl: undefined,
        source: 'openLibrary' as const,
        sourceId: 'OL1',
      },
      {
        title: 'Book B',
        authors: ['Author B'],
        isbn13: undefined,
        isbn10: undefined,
        publisher: undefined,
        publishYear: undefined,
        edition: undefined,
        coverUrl: undefined,
        source: 'openLibrary' as const,
        sourceId: 'OL2',
      },
    ];

    const response: ResolveResponse = {
      status: 'ambiguous',
      cacheHit: false,
      quotaRemaining: 15,
      matches: [],
      acceptanceDecision: {
        type: 'ambiguous',
        candidates,
        reason: 'Multiple matches',
      },
      canonicalBook: null,
      verificationFlags: [],
      processingTimeMs: 180,
    };
    const result: ResolverResult = {
      success: true,
      response,
    };

    const updated = applyResolverResult(candidate, result);

    expect(updated.resolverDecision).toBe('suggested');
    expect(updated.resolvedBook).toBeUndefined();
    expect(updated.resolverSuggestions).toHaveLength(2);
  });

  it('applies no-match decision correctly', () => {
    const candidate = createMockCandidate('no-match', createMockHypothesis());
    const response: ResolveResponse = {
      status: 'no-match',
      cacheHit: false,
      quotaRemaining: 10,
      matches: [],
      acceptanceDecision: {
        type: 'no-match',
        reason: 'No matching books found',
        fallbackToOcr: true,
      },
      canonicalBook: null,
      verificationFlags: [],
      processingTimeMs: 100,
    };
    const result: ResolverResult = {
      success: true,
      response,
    };

    const updated = applyResolverResult(candidate, result);

    expect(updated.resolverDecision).toBe('reject');
    expect(updated.resolvedBook).toBeUndefined();
    expect(updated.resolverSuggestions).toBeUndefined();
  });

  it('stores verification flags', () => {
    const candidate = createMockCandidate('with-flags', createMockHypothesis());
    const response: ResolveResponse = {
      status: 'resolved',
      cacheHit: false,
      quotaRemaining: 20,
      matches: [],
      acceptanceDecision: {
        type: 'auto-accept',
        book: {
          title: 'Book',
          authors: ['Author'],
          isbn13: undefined,
          isbn10: undefined,
          publisher: undefined,
          publishYear: undefined,
          edition: undefined,
          coverUrl: undefined,
          source: 'openLibrary',
          sourceId: 'OL1',
        },
        confidence: 0.9,
        reason: 'High confidence',
      },
      canonicalBook: null,
      verificationFlags: [
        {
          flag: 'author-mismatch',
          severity: 'warning',
          message: 'Author name differs',
          penalty: 0.1,
        },
      ],
      processingTimeMs: 100,
    };
    const result: ResolverResult = {
      success: true,
      response,
    };

    const updated = applyResolverResult(candidate, result);

    expect(updated.resolverFlags).toBeDefined();
    expect(updated.resolverFlags).toHaveLength(1);
    expect(updated.resolverFlags![0].flag).toBe('author-mismatch');
  });
});

// ============================================================================
// URL Normalization Tests
// ============================================================================

describe('normalizeSupabaseBaseUrl', () => {
  it('adds https:// to bare domain', () => {
    expect(normalizeSupabaseBaseUrl('example.supabase.co')).toBe('https://example.supabase.co');
  });

  it('replaces http:// with https://', () => {
    expect(normalizeSupabaseBaseUrl('http://example.supabase.co')).toBe('https://example.supabase.co');
  });

  it('keeps https:// as-is', () => {
    expect(normalizeSupabaseBaseUrl('https://example.supabase.co')).toBe('https://example.supabase.co');
  });

  it('removes trailing slashes', () => {
    expect(normalizeSupabaseBaseUrl('https://example.supabase.co/')).toBe('https://example.supabase.co');
    expect(normalizeSupabaseBaseUrl('https://example.supabase.co///')).toBe('https://example.supabase.co');
  });

  it('trims whitespace', () => {
    expect(normalizeSupabaseBaseUrl('  https://example.supabase.co  ')).toBe('https://example.supabase.co');
  });

  it('handles all edge cases combined', () => {
    expect(normalizeSupabaseBaseUrl('  http://example.supabase.co//  ')).toBe('https://example.supabase.co');
  });
});

describe('buildEdgeFunctionUrl', () => {
  it('builds correct URL from base and function name', () => {
    const url = buildEdgeFunctionUrl('https://example.supabase.co', 'resolve_candidates');
    expect(url).toBe('https://example.supabase.co/functions/v1/resolve_candidates');
  });

  it('normalizes base URL before building', () => {
    const url = buildEdgeFunctionUrl('http://example.supabase.co/', 'my_function');
    expect(url).toBe('https://example.supabase.co/functions/v1/my_function');
  });

  it('handles bare domain', () => {
    const url = buildEdgeFunctionUrl('example.supabase.co', 'test_fn');
    expect(url).toBe('https://example.supabase.co/functions/v1/test_fn');
  });

  it('handles all input variants and produces consistent output', () => {
    const projectId = 'uqcaqupotfouuzusxtat';
    const expectedUrl = `https://${projectId}.supabase.co/functions/v1/resolve_candidates`;

    // Bare domain
    expect(buildEdgeFunctionUrl(`${projectId}.supabase.co`, 'resolve_candidates'))
      .toBe(expectedUrl);

    // With https:// and trailing slash
    expect(buildEdgeFunctionUrl(`https://${projectId}.supabase.co/`, 'resolve_candidates'))
      .toBe(expectedUrl);

    // With http:// (should convert to https)
    expect(buildEdgeFunctionUrl(`http://${projectId}.supabase.co`, 'resolve_candidates'))
      .toBe(expectedUrl);

    // With multiple trailing slashes
    expect(buildEdgeFunctionUrl(`https://${projectId}.supabase.co////`, 'resolve_candidates'))
      .toBe(expectedUrl);

    // With whitespace
    expect(buildEdgeFunctionUrl(`  https://${projectId}.supabase.co  `, 'resolve_candidates'))
      .toBe(expectedUrl);

    // All edge cases combined
    expect(buildEdgeFunctionUrl(`  http://${projectId}.supabase.co////  `, 'resolve_candidates'))
      .toBe(expectedUrl);
  });
});
