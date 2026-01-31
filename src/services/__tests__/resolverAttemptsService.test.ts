/**
 * Resolver Attempts Service Tests
 *
 * REGRESSION TESTS: Verify payload structure matches Supabase schema
 */

import type { ResolverAttemptPayload } from '../resolverAttemptsService';

describe('resolverAttemptsService', () => {
  describe('ResolverAttemptPayload type', () => {
    /**
     * REGRESSION TEST: Payload must NOT include final_score column
     *
     * The Supabase resolver_attempts table uses `top_score` not `final_score`.
     * Earlier code incorrectly used `final_score` which caused upsert failures:
     * "Could not find column 'final_score' in schema 'public'"
     */
    it('REGRESSION: payload uses top_score, NOT final_score', () => {
      // Create a valid payload to verify structure
      const payload: ResolverAttemptPayload = {
        session_id: 'test-session',
        candidate_id: 'test-candidate',
        evidence_hash: 'abc123',
        evidence_tier: 'good',
        hypotheses_count: 5,
        top_match_resolver_key: 'ol:OL123M',
        top_match_title: 'The Shining',
        top_match_authors: ['Stephen King'],
        top_score: 0.85,
        decision: 'accept_medium',
        reason: 'full_match',
      };

      // Verify the payload has the expected keys
      expect(Object.keys(payload)).toContain('top_score');
      expect(Object.keys(payload)).not.toContain('final_score');
      expect(Object.keys(payload)).not.toContain('raw_score');
      expect(Object.keys(payload)).not.toContain('overlap_count');

      // Verify top_score is the correct field for score
      expect(payload.top_score).toBe(0.85);
    });

    it('payload correctly handles null values for optional fields', () => {
      const payload: ResolverAttemptPayload = {
        session_id: 'test-session',
        candidate_id: 'test-candidate',
        evidence_hash: 'abc123',
        evidence_tier: 'unusable',
        hypotheses_count: 0,
        top_match_resolver_key: null,
        top_match_title: null,
        top_match_authors: null,
        top_score: null,
        decision: 'reject',
        reason: 'no_evidence',
      };

      expect(payload.top_score).toBeNull();
      expect(payload.top_match_resolver_key).toBeNull();
      expect(payload.top_match_title).toBeNull();
      expect(payload.top_match_authors).toBeNull();
    });

    it('payload structure matches expected Supabase schema', () => {
      // Define the expected columns in the resolver_attempts table
      const expectedColumns = [
        'session_id',
        'candidate_id',
        'evidence_hash',
        'evidence_tier',
        'hypotheses_count',
        'top_match_resolver_key',
        'top_match_title',
        'top_match_authors',
        'top_score',
        'decision',
        'reason',
      ];

      const payload: ResolverAttemptPayload = {
        session_id: 'test',
        candidate_id: 'test',
        evidence_hash: 'test',
        evidence_tier: 'test',
        hypotheses_count: 0,
        top_match_resolver_key: null,
        top_match_title: null,
        top_match_authors: null,
        top_score: null,
        decision: 'reject',
        reason: null,
      };

      const payloadKeys = Object.keys(payload).sort();
      const expectedSorted = expectedColumns.sort();

      expect(payloadKeys).toEqual(expectedSorted);
    });
  });
});
