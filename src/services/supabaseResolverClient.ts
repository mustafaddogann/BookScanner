/**
 * Supabase Resolver Client Service
 * Gate 9: Resolver + Scoring + Verification + Acceptance
 *
 * Calls the Supabase Edge Function to resolve book candidates.
 * Handles offline/timeout gracefully with queuing support.
 */

import { Platform } from 'react-native';
import {
  getSupabaseBaseUrl,
  getSupabaseAnonKey,
  isSupabaseConfigured,
  EDGE_FUNCTIONS,
} from '../config/supabase';
import type {
  BookCandidate,
  BookHypothesis,
  ResolvedBook,
  AcceptanceDecision,
  EvidenceTier,
  SearchCandidate,
} from '../types';
import { isMetadataVerboseDebug } from '../config/debug';
import { computeEvidenceHash } from '../utils/evidenceHash';

// ============================================================================
// Types
// ============================================================================

export interface ResolveRequest {
  sessionId: string;
  candidateId: string;
  evidenceHash: string;
  evidenceTier: EvidenceTier;
  queries: QueryCandidate[];
  isbnCandidates: IsbnCandidate[];
}

export interface QueryCandidate {
  query: string;
  confidence: number;
  source: 'ocr' | 'ai';
  titleHint?: string;
  authorHint?: string;
}

export interface IsbnCandidate {
  isbn: string;
  confidence: number;
}

export interface ResolveResponse {
  status: 'resolved' | 'ambiguous' | 'no-match' | 'rate-limited' | 'error';
  cacheHit: boolean;
  quotaRemaining: number;
  matches: ScoredMatchResponse[];
  acceptanceDecision: AcceptanceDecisionResponse;
  canonicalBook: ResolvedBook | null;
  verificationFlags: VerificationFlag[];
  processingTimeMs: number;
  resolutionMetrics?: {
    cache: {
      catalogHits: number;
      resolverCacheHits: number;
      resolverCacheMisses: number;
    };
    fallback: {
      triggered: boolean;
      openLibraryIsbnCalls: number;
      openLibrarySearchCalls: number;
    };
    timingsMs: {
      supabaseLookup: number;
      fallbackLookup: number;
      scoringAndDecision: number;
      total: number;
    };
  };
}

export interface ScoredMatchResponse {
  book: ResolvedBook;
  score: {
    composite: number;
    signals: Record<string, number>;
    normalizedSignals: Record<string, number>;
  };
}

export type AcceptanceDecisionResponse =
  | { type: 'auto-accept'; book: ResolvedBook; confidence: number; reason: string }
  | { type: 'suggest'; book: ResolvedBook; confidence: number; alternatives: ResolvedBook[]; reason: string }
  | { type: 'ambiguous'; candidates: ResolvedBook[]; reason: string }
  | { type: 'no-match'; reason: string; fallbackToOcr: boolean };

export interface VerificationFlag {
  flag: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  penalty: number;
}

export interface ResolverResult {
  success: boolean;
  response?: ResolveResponse;
  error?: string;
  offline?: boolean;
  timeout?: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

const REQUEST_TIMEOUT_MS = 10000; // 10 seconds (user requirement)
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;
const MAX_CONCURRENT_REQUESTS = 2; // Concurrency cap

// ============================================================================
// Concurrency Control
// ============================================================================

let activeRequests = 0;
const pendingRequests: Array<{
  resolve: (value: void) => void;
}> = [];

async function acquireSlot(): Promise<void> {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests++;
    return;
  }
  // Wait for a slot to become available
  await new Promise<void>((resolve) => {
    pendingRequests.push({ resolve });
  });
  activeRequests++;
}

function releaseSlot(): void {
  activeRequests--;
  const next = pendingRequests.shift();
  if (next) {
    next.resolve();
  }
}

// ============================================================================
// Debug Counters
// ============================================================================

export interface ResolverDebugCounters {
  resolverCalls: number;
  resolverRetries: number;
  resolverSuccesses: number;
  resolverFailures: number;
  resolverCacheHits: number;
  resolverLatencyMsTotal: number;
  resolverLatencyMsAvg: number;
}

let debugCounters: ResolverDebugCounters = {
  resolverCalls: 0,
  resolverRetries: 0,
  resolverSuccesses: 0,
  resolverFailures: 0,
  resolverCacheHits: 0,
  resolverLatencyMsTotal: 0,
  resolverLatencyMsAvg: 0,
};

export function getResolverDebugCounters(): ResolverDebugCounters {
  return { ...debugCounters };
}

export function resetResolverDebugCounters(): void {
  debugCounters = {
    resolverCalls: 0,
    resolverRetries: 0,
    resolverSuccesses: 0,
    resolverFailures: 0,
    resolverCacheHits: 0,
    resolverLatencyMsTotal: 0,
    resolverLatencyMsAvg: 0,
  };
}

function updateDebugCounters(
  success: boolean,
  retries: number,
  latencyMs: number,
  cacheHit: boolean
): void {
  debugCounters.resolverCalls++;
  debugCounters.resolverRetries += retries;
  if (success) {
    debugCounters.resolverSuccesses++;
    if (cacheHit) {
      debugCounters.resolverCacheHits++;
    }
  } else {
    debugCounters.resolverFailures++;
  }
  debugCounters.resolverLatencyMsTotal += latencyMs;
  debugCounters.resolverLatencyMsAvg =
    debugCounters.resolverLatencyMsTotal / debugCounters.resolverCalls;
}

// ============================================================================
// URL Building (string-only, NO URL object mutation)
// ============================================================================

/**
 * Normalize a Supabase base URL.
 * - Trims whitespace
 * - Adds https:// if missing protocol
 * - Removes trailing slashes
 */
export function normalizeSupabaseBaseUrl(base: string): string {
  let url = base.trim();
  // Add https:// if no protocol
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // Force https (never http)
  url = url.replace(/^http:\/\//i, 'https://');
  // Remove trailing slashes
  url = url.replace(/\/+$/, '');
  return url;
}

/**
 * Build Edge Function URL from base and function name.
 * Pure string concatenation - no URL object.
 */
export function buildEdgeFunctionUrl(base: string, fnName: string): string {
  const normalizedBase = normalizeSupabaseBaseUrl(base);
  return `${normalizedBase}/functions/v1/${fnName}`;
}

/**
 * Build the Edge Function URL for the configured Supabase project.
 * Uses string-only operations - NO URL object construction or mutation.
 */
function buildEdgeFunctionEndpoint(functionName: string): string {
  const baseUrl = getSupabaseBaseUrl();
  return buildEdgeFunctionUrl(baseUrl, functionName);
}

// ============================================================================
// Request Building
// ============================================================================

/**
 * Build a ResolveRequest from a BookCandidate with hypothesis.
 */
export function buildResolveRequest(
  sessionId: string,
  candidate: BookCandidate
): ResolveRequest | null {
  const hypothesis = candidate.hypothesis;
  if (!hypothesis) {
    console.warn('[ResolverClient] Candidate has no hypothesis:', candidate.id);
    return null;
  }

  // Compute evidence hash for cache key
  const evidenceHash = computeEvidenceHash(candidate.evidence);

  // Convert SearchCandidates to QueryCandidates
  const queries: QueryCandidate[] = hypothesis.searchCandidates.map((sc) => ({
    query: sc.query,
    confidence: sc.confidence,
    source: 'ocr' as const,
    titleHint: sc.titleHint,
    authorHint: sc.authorHint,
  }));

  // Convert ISBN candidates
  const isbnCandidates: IsbnCandidate[] = hypothesis.isbnCandidates.map((isbn) => ({
    isbn,
    confidence: 0.95, // High confidence for extracted ISBNs
  }));

  return {
    sessionId,
    candidateId: candidate.id,
    evidenceHash,
    evidenceTier: hypothesis.evidenceTier,
    queries,
    isbnCandidates,
  };
}

// ============================================================================
// API Calls
// ============================================================================

/**
 * Call the resolve_candidates Edge Function.
 * Uses concurrency cap and proper retry policy (5xx/network/timeout only).
 * GUARANTEED: Never throws - always returns a structured ResolverResult.
 */
async function callResolveFunction(
  request: ResolveRequest
): Promise<ResolverResult> {
  // Top-level guard: ensure this function NEVER throws to caller
  try {
    if (!isSupabaseConfigured()) {
      return {
        success: false,
        error: 'Supabase not configured',
        offline: true,
      };
    }

    // Build URL as plain string (no URL object mutation)
    let endpoint: string;
    try {
      endpoint = buildEdgeFunctionEndpoint(EDGE_FUNCTIONS.resolveCandidates);
    } catch (urlError) {
      console.error('[ResolverClient] Failed to build endpoint URL:', urlError);
      return {
        success: false,
        error: 'Failed to build endpoint URL',
      };
    }

    if (isMetadataVerboseDebug()) {
      console.log(`[ResolverClient] Endpoint: ${endpoint}`);
    }

    const startTime = Date.now();
    let retryCount = 0;

    // Acquire concurrency slot
    await acquireSlot();

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        // Use anon key directly - avoids Supabase SDK internal URL manipulation
        const anonKey = getSupabaseAnonKey();

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': anonKey,
            'Authorization': `Bearer ${anonKey}`,
            'x-client-info': `bookscanner/${Platform.OS}`,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[ResolverClient] HTTP ${response.status}: ${errorText}`);

          // 429 Rate Limited - do NOT retry
          if (response.status === 429) {
            const latency = Date.now() - startTime;
            updateDebugCounters(false, retryCount, latency, false);
            return {
              success: false,
              error: 'Rate limited',
              response: {
                status: 'rate-limited',
                cacheHit: false,
                quotaRemaining: 0,
                matches: [],
                acceptanceDecision: {
                  type: 'no-match',
                  reason: 'Rate limit exceeded',
                  fallbackToOcr: true,
                },
                canonicalBook: null,
                verificationFlags: [],
                processingTimeMs: 0,
              },
            };
          }

          // 4xx Client errors - do NOT retry (except 429 handled above)
          if (response.status >= 400 && response.status < 500) {
            const latency = Date.now() - startTime;
            updateDebugCounters(false, retryCount, latency, false);
            return {
              success: false,
              error: `HTTP ${response.status}: ${errorText}`,
            };
          }

          // 5xx Server errors - retry with backoff
          if (response.status >= 500 && attempt < MAX_RETRIES) {
            retryCount++;
            await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
            continue;
          }

          const latency = Date.now() - startTime;
          updateDebugCounters(false, retryCount, latency, false);
          return {
            success: false,
            error: `HTTP ${response.status}: ${errorText}`,
          };
        }

        const data: ResolveResponse = await response.json();
        const latency = Date.now() - startTime;
        updateDebugCounters(true, retryCount, latency, data.cacheHit);

        if (isMetadataVerboseDebug()) {
          console.log(`[ResolverClient] Status: ${data.status}, Decision: ${data.acceptanceDecision.type}`);
        }

        return {
          success: true,
          response: data,
        };
      } catch (error) {
        // Timeout - retry
        if (error instanceof Error && error.name === 'AbortError') {
          if (attempt < MAX_RETRIES) {
            retryCount++;
            await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS));
            continue;
          }
          const latency = Date.now() - startTime;
          updateDebugCounters(false, retryCount, latency, false);
          return {
            success: false,
            error: 'Request timeout',
            timeout: true,
          };
        }

        // Network error - do NOT retry (likely offline)
        if (error instanceof TypeError && error.message.includes('Network')) {
          const latency = Date.now() - startTime;
          updateDebugCounters(false, retryCount, latency, false);
          return {
            success: false,
            error: 'Network error',
            offline: true,
          };
        }

        // TypeError with protocol getter issue - handle gracefully
        if (error instanceof TypeError && error.message.includes('protocol')) {
          console.error('[ResolverClient] URL protocol error - falling back:', error);
          const latency = Date.now() - startTime;
          updateDebugCounters(false, retryCount, latency, false);
          return {
            success: false,
            error: 'URL protocol error',
          };
        }

        console.error('[ResolverClient] Error:', error);

        // Other errors - retry with backoff
        if (attempt < MAX_RETRIES) {
          retryCount++;
          await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }

        const latency = Date.now() - startTime;
        updateDebugCounters(false, retryCount, latency, false);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }

    const latency = Date.now() - startTime;
    updateDebugCounters(false, retryCount, latency, false);
    return {
      success: false,
      error: 'Max retries exceeded',
    };
  } finally {
    // Always release concurrency slot
    releaseSlot();
  }
  } catch (outerError) {
    // Catch-all: log and return structured error - NEVER crash
    console.error('[ResolverClient] Unexpected error (caught at top level):', outerError);
    return {
      success: false,
      error: outerError instanceof Error ? outerError.message : 'Unexpected error',
    };
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve a single book candidate.
 */
export async function resolveCandidate(
  sessionId: string,
  candidate: BookCandidate
): Promise<ResolverResult> {
  const request = buildResolveRequest(sessionId, candidate);
  if (!request) {
    return {
      success: false,
      error: 'Failed to build resolve request',
    };
  }

  if (isMetadataVerboseDebug()) {
    console.log(`[ResolverClient] Resolving candidate ${candidate.id}`, {
      evidenceTier: request.evidenceTier,
      queryCount: request.queries.length,
      isbnCount: request.isbnCandidates.length,
    });
  }

  const result = await callResolveFunction(request);

  if (isMetadataVerboseDebug()) {
    if (result.success && result.response) {
      console.log(`[ResolverClient] Resolved ${candidate.id}:`, {
        status: result.response.status,
        cacheHit: result.response.cacheHit,
        matchCount: result.response.matches.length,
        decision: result.response.acceptanceDecision.type,
        processingTimeMs: result.response.processingTimeMs,
      });
    } else {
      console.log(`[ResolverClient] Failed ${candidate.id}:`, {
        error: result.error,
        offline: result.offline,
        timeout: result.timeout,
      });
    }
  }

  if (result.success && result.response) {
    const metrics = result.response.resolutionMetrics;
    if (metrics) {
      console.log(
        `[ResolverClient] Metrics candidate=${candidate.id} ` +
          `cacheHits=${metrics.cache.catalogHits + metrics.cache.resolverCacheHits} ` +
          `cacheMisses=${metrics.cache.resolverCacheMisses} ` +
          `fallback=${metrics.fallback.triggered} ` +
          `olIsbnCalls=${metrics.fallback.openLibraryIsbnCalls} ` +
          `olSearchCalls=${metrics.fallback.openLibrarySearchCalls} ` +
          `ms.total=${metrics.timingsMs.total} ` +
          `ms.supabase=${metrics.timingsMs.supabaseLookup} ` +
          `ms.fallback=${metrics.timingsMs.fallbackLookup}`
      );
    } else {
      console.warn(
        `[ResolverClient] No resolutionMetrics in response for candidate=${candidate.id} (edge function may be outdated)`
      );
    }
  }

  return result;
}

/**
 * Resolve multiple book candidates.
 * Processes sequentially to respect rate limits.
 */
export async function resolveCandidates(
  sessionId: string,
  candidates: BookCandidate[]
): Promise<Map<string, ResolverResult>> {
  const results = new Map<string, ResolverResult>();

  for (const candidate of candidates) {
    // Skip candidates without hypothesis
    if (!candidate.hypothesis) {
      results.set(candidate.id, {
        success: false,
        error: 'No hypothesis available',
      });
      continue;
    }

    // Skip unusable evidence
    if (candidate.hypothesis.evidenceTier === 'unusable') {
      results.set(candidate.id, {
        success: true,
        response: {
          status: 'no-match',
          cacheHit: false,
          quotaRemaining: -1,
          matches: [],
          acceptanceDecision: {
            type: 'no-match',
            reason: 'Evidence tier is unusable',
            fallbackToOcr: true,
          },
          canonicalBook: null,
          verificationFlags: [],
          processingTimeMs: 0,
        },
      });
      continue;
    }

    const result = await resolveCandidate(sessionId, candidate);
    results.set(candidate.id, result);

    // Log rate limit/offline but continue so every candidate gets a result entry
    if (result.response?.status === 'rate-limited' || result.offline) {
      console.warn('[ResolverClient] Rate limited or offline - continuing batch to capture all candidates');
    }
  }

  return results;
}

/**
 * Apply resolver result to a book candidate.
 */
export function applyResolverResult(
  candidate: BookCandidate,
  result: ResolverResult
): BookCandidate {
  if (!result.response) {
    const fallbackReason = result.error || (result.offline ? 'offline' : undefined);
    return {
      ...candidate,
      resolverDecision: result.offline ? 'offline' : 'pending',
      resolverDecisionReason: fallbackReason,
    };
  }

  const { response } = result;

  // Map response decision to candidate fields
  let resolverDecision: BookCandidate['resolverDecision'];
  let resolvedBook: ResolvedBook | undefined;
  let resolverSuggestions: ResolvedBook[] | undefined;
  let resolvedConfidence: number | undefined;

  switch (response.acceptanceDecision.type) {
    case 'auto-accept':
      resolverDecision = 'accept';
      resolvedBook = response.acceptanceDecision.book;
      resolvedConfidence = response.acceptanceDecision.confidence;
      break;

    case 'suggest':
      resolverDecision = 'suggested';
      resolvedBook = response.acceptanceDecision.book;
      resolverSuggestions = response.acceptanceDecision.alternatives;
      resolvedConfidence = response.acceptanceDecision.confidence;
      break;

    case 'ambiguous':
      resolverDecision = 'suggested';
      resolverSuggestions = response.acceptanceDecision.candidates;
      break;

    case 'no-match':
      resolverDecision = 'reject';
      break;
  }

  return {
    ...candidate,
    resolverDecision,
    resolvedBook,
    resolverSuggestions,
    resolvedConfidence,
    resolverDecisionReason: response.acceptanceDecision.reason,
    // Store verification flags for UI display
    resolverFlags: response.verificationFlags,
  };
}
