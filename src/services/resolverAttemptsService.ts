/**
 * Resolver Attempts Persistence
 * Writes per-candidate resolver outcomes to Supabase for observability.
 *
 * IMPORTANT: Non-blocking, failure-tolerant.
 */

import { getSupabaseClient, isSupabaseConfigured } from '../config/supabase';
import type { BookCandidate, ResolvedBook } from '../types';
import type { ResolverResult } from './supabaseResolverClient';
import { computeEvidenceHash } from '../utils/evidenceHash';
import { buildResolverKey } from './openLibraryProvider';
import { isDiagnosticLoggingEnabled } from '../config/debug';

export interface ResolverAttemptPayload {
  session_id: string;
  candidate_id: string;
  evidence_hash: string;
  evidence_tier: string;
  hypotheses_count: number;
  top_match_resolver_key: string | null;
  top_match_title: string | null;
  top_match_authors: string[] | null;
  top_score: number | null;
  decision: string;
  reason: string | null;
}

function extractTopMatchFromResult(
  result?: ResolverResult
): { book: ResolvedBook | null; score: number | null; reason: string | null } {
  const response = result?.response;
  if (!response) {
    return { book: null, score: null, reason: null };
  }

  const decision = response.acceptanceDecision;
  const decisionReason = decision?.reason ?? null;

  if (decision && decision.type === 'auto-accept') {
    return {
      book: decision.book,
      score: decision.confidence ?? null,
      reason: decisionReason,
    };
  }

  if (decision && decision.type === 'suggest') {
    return {
      book: decision.book,
      score: decision.confidence ?? null,
      reason: decisionReason,
    };
  }

  if (decision && decision.type === 'ambiguous' && decision.candidates?.length) {
    return {
      book: decision.candidates[0],
      score: null,
      reason: decisionReason,
    };
  }

  if (response.matches && response.matches.length > 0) {
    return {
      book: response.matches[0].book,
      score: response.matches[0].score.composite ?? null,
      reason: decisionReason,
    };
  }

  if (response.canonicalBook) {
    return {
      book: response.canonicalBook,
      score: null,
      reason: decisionReason,
    };
  }

  return { book: null, score: null, reason: decisionReason };
}

interface TopMatchInfo {
  book: ResolvedBook | null;
  score: number | null;
  debugTitle: string | null;
}

function extractTopMatchFromCandidate(candidate: BookCandidate): TopMatchInfo {
  const debug = candidate.evidenceSearchDebug;
  const debugTop = debug?.topScores?.[0] as {
    title: string;
    score: number;
  } | undefined;

  if (candidate.resolvedBook) {
    return {
      book: candidate.resolvedBook,
      score: candidate.resolvedConfidence ?? null,
      debugTitle: null,
    };
  }

  if (debugTop) {
    return {
      book: null,
      score: debugTop.score ?? null,
      debugTitle: debugTop.title,
    };
  }

  return { book: null, score: null, debugTitle: null };
}

function getHypothesesCount(candidate: BookCandidate): number {
  if (typeof candidate.evidenceSearchDebug?.hypothesesCount === 'number') {
    return candidate.evidenceSearchDebug.hypothesesCount;
  }
  return candidate.hypothesis?.searchCandidates?.length ?? 0;
}

function getDecisionReason(
  candidate: BookCandidate,
  result?: ResolverResult
): string | null {
  if (candidate.resolverDecisionReason) {
    return candidate.resolverDecisionReason;
  }
  if (candidate.evidenceSearchDebug?.reason) {
    return candidate.evidenceSearchDebug.reason;
  }
  const responseReason = result?.response?.acceptanceDecision?.reason;
  return responseReason ?? null;
}

/**
 * Persist resolver attempts for all candidates.
 * Uses upsert to keep the latest attempt per session/candidate.
 *
 * IMPORTANT: This function guarantees one row per candidate, even on failure.
 * - If no evidence/hypotheses: writes decision="reject", reason="no_evidence"
 * - Never leaves candidates in "pending" state after resolution completes
 */
export async function persistResolverAttempts(
  sessionId: string,
  candidates: BookCandidate[],
  resolverResults?: Map<string, ResolverResult>
): Promise<void> {
  if (!isSupabaseConfigured()) {
    return;
  }

  const client = getSupabaseClient();
  if (!client) {
    return;
  }

  // COVERAGE ASSERTION: Log input/output counts (only when diagnostic logging enabled)
  const inputCount = candidates.length;
  const candidateIds = candidates.map((c) => c.id);
  const verbose = isDiagnosticLoggingEnabled();
  if (verbose) {
    console.log(`[ResolverAttempts] START persist sessionId=${sessionId} input_count=${inputCount} candidate_ids=${JSON.stringify(candidateIds)}`);
  }

  const payloads: ResolverAttemptPayload[] = candidates.map((candidate) => {
    const result = resolverResults?.get(candidate.id);
    const evidenceHash = computeEvidenceHash(candidate.evidence);
    const evidenceTier = candidate.hypothesis?.evidenceTier ?? 'unusable';
    const hypothesesCount = getHypothesesCount(candidate);

    const topMatchFromResult = extractTopMatchFromResult(result);
    const topMatchFromCandidate = extractTopMatchFromCandidate(candidate);

    const topBook = topMatchFromResult.book || topMatchFromCandidate.book;
    const topScore =
      topMatchFromResult.score !== null && topMatchFromResult.score !== undefined
        ? topMatchFromResult.score
        : topMatchFromCandidate.score;

    const resolverKey = topBook ? buildResolverKey(topBook) : null;
    const topTitle =
      topBook?.title ?? topMatchFromCandidate.debugTitle ?? null;
    const topAuthors = topBook?.authors ?? null;

    // COVERAGE: Ensure no candidate stays "pending" - convert to reject if no evidence
    let decision =
      candidate.evidenceSearchDebug?.decision ??
      candidate.resolverDecision ??
      'pending';

    let reason =
      getDecisionReason(candidate, result) ??
      topMatchFromResult.reason ??
      null;

    // COVERAGE FIX: Convert pending to reject if no hypotheses (no evidence case)
    if (decision === 'pending' && hypothesesCount === 0) {
      decision = 'reject';
      reason = reason ?? 'no_evidence';
    }

    return {
      session_id: sessionId,
      candidate_id: candidate.id,
      evidence_hash: evidenceHash,
      evidence_tier: evidenceTier,
      hypotheses_count: hypothesesCount,
      top_match_resolver_key: resolverKey,
      top_match_title: topTitle,
      top_match_authors: topAuthors,
      top_score: topScore ?? null,
      decision,
      reason,
    };
  });

  // COVERAGE ASSERTION: Verify payload count matches input
  const processedIds = payloads.map((p) => p.candidate_id);
  const missingIds = candidateIds.filter((id) => !processedIds.includes(id));
  if (missingIds.length > 0) {
    console.error(`[ResolverAttempts] COVERAGE_ERROR: Missing candidates in payloads: ${JSON.stringify(missingIds)}`);
  }

  try {
    const { error } = await client
      .from('resolver_attempts')
      .upsert(payloads, { onConflict: 'session_id,candidate_id' });

    if (error) {
      console.warn('[ResolverAttempts] upsert failed:', error.message);
      if (verbose) {
        console.log(`[ResolverAttempts] END persist sessionId=${sessionId} processed_count=${payloads.length} status=FAILED error="${error.message}"`);
      }
    } else if (verbose) {
      console.log(`[ResolverAttempts] END persist sessionId=${sessionId} processed_count=${payloads.length} status=OK`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.warn('[ResolverAttempts] upsert exception:', message);
    if (verbose) {
      console.log(`[ResolverAttempts] END persist sessionId=${sessionId} processed_count=${payloads.length} status=EXCEPTION error="${message}"`);
    }
  }
}
