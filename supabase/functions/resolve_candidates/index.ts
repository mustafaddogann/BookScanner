/**
 * Edge Function: resolve_candidates
 * Gate 9: Resolver + Scoring + Verification + Acceptance
 *
 * Resolves book candidates by:
 * 1. Checking cache for existing results
 * 2. Calling Open Library API for ISBN and search lookups
 * 3. Scoring and ranking matches
 * 4. Verifying matches against evidence
 * 5. Making acceptance decisions
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  ResolveRequest,
  ResolveResponse,
  ResolveStatus,
  ResolvedBook,
  ScoredMatch,
  OpenLibrarySearchResponse,
  OpenLibraryIsbnResponse,
  EvidenceTier,
  VerificationFlag,
  RateLimitState,
  RATE_LIMIT,
  ResolverEvent,
} from '../_shared/types.ts';
import {
  normalizeQuery,
  computeHash,
  tokenize,
  mapSearchDocToBook,
  mapIsbnResponseToBook,
  computeMatchScore,
  verifyMatch,
  makeAcceptanceDecision,
  getDefaultCacheTtl,
} from '../_shared/utils.ts';

// ============================================================================
// Configuration
// ============================================================================

const OPEN_LIBRARY_BASE = 'https://openlibrary.org';
const SEARCH_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 10000;

// In-memory rate limiting (best-effort, per-instance)
const rateLimitMap = new Map<string, RateLimitState>();

// ============================================================================
// CORS Headers
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ============================================================================
// Rate Limiting
// ============================================================================

function checkRateLimit(clientId: string): {
  allowed: boolean;
  remaining: number;
} {
  const now = Date.now();
  const state = rateLimitMap.get(clientId);

  // New window or expired window
  if (!state || now - state.windowStart > RATE_LIMIT.windowMs) {
    rateLimitMap.set(clientId, { count: 1, windowStart: now });
    return { allowed: true, remaining: RATE_LIMIT.maxRequests - 1 };
  }

  // Within window
  if (state.count >= RATE_LIMIT.maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  state.count++;
  return { allowed: true, remaining: RATE_LIMIT.maxRequests - state.count };
}

// ============================================================================
// Cache Operations
// ============================================================================

async function lookupCache(
  supabase: ReturnType<typeof createClient>,
  provider: string,
  queryType: string,
  queryHash: string
): Promise<{ hit: boolean; data: unknown | null }> {
  const { data, error } = await supabase
    .from('resolver_cache')
    .select('response_json, id')
    .eq('provider', provider)
    .eq('query_type', queryType)
    .eq('query_hash', queryHash)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (error || !data) {
    return { hit: false, data: null };
  }

  // Update hit count (fire-and-forget)
  supabase
    .from('resolver_cache')
    .update({ hit_count: data.hit_count + 1, last_hit_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {});

  return { hit: true, data: data.response_json };
}

async function writeCache(
  supabase: ReturnType<typeof createClient>,
  provider: string,
  queryType: string,
  queryHash: string,
  queryText: string,
  responseJson: unknown
): Promise<void> {
  const { error } = await supabase.from('resolver_cache').upsert(
    {
      provider,
      query_type: queryType,
      query_hash: queryHash,
      query_text: queryText,
      response_json: responseJson,
      expires_at: getDefaultCacheTtl().toISOString(),
    },
    {
      onConflict: 'provider,query_type,query_hash',
    }
  );

  if (error) {
    console.error('[Cache] Write error:', error);
  }
}

// ============================================================================
// Telemetry
// ============================================================================

async function logEvent(
  supabase: ReturnType<typeof createClient>,
  event: ResolverEvent
): Promise<void> {
  const { error } = await supabase.from('resolver_events').insert({
    event_type: event.eventType,
    provider: event.provider,
    query_type: event.queryType,
    evidence_tier: event.evidenceTier,
    duration_ms: event.durationMs,
    match_count: event.matchCount,
    decision_type: event.decisionType,
    top_score: event.topScore,
    dominance_gap: event.dominanceGap,
    error_code: event.errorCode,
    quota_remaining: event.quotaRemaining,
  });

  if (error) {
    console.error('[Telemetry] Log error:', error);
  }
}

// ============================================================================
// Open Library API
// ============================================================================

async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function lookupIsbn(
  supabase: ReturnType<typeof createClient>,
  isbn: string
): Promise<{ book: ResolvedBook | null; cacheHit: boolean }> {
  const queryHash = await computeHash(isbn);

  // Check cache
  const cached = await lookupCache(supabase, 'openLibrary', 'isbn', queryHash);
  if (cached.hit && cached.data) {
    const book = mapIsbnResponseToBook(
      cached.data as OpenLibraryIsbnResponse,
      isbn
    );
    return { book, cacheHit: true };
  }

  // Fetch from Open Library
  try {
    const url = `${OPEN_LIBRARY_BASE}/isbn/${isbn}.json`;
    const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

    if (response.status === 404) {
      // Cache the miss
      await writeCache(supabase, 'openLibrary', 'isbn', queryHash, isbn, null);
      return { book: null, cacheHit: false };
    }

    if (!response.ok) {
      console.error(`[OpenLibrary] ISBN lookup failed: ${response.status}`);
      return { book: null, cacheHit: false };
    }

    const data: OpenLibraryIsbnResponse = await response.json();

    // Cache the result
    await writeCache(supabase, 'openLibrary', 'isbn', queryHash, isbn, data);

    const book = mapIsbnResponseToBook(data, isbn);
    return { book, cacheHit: false };
  } catch (error) {
    console.error('[OpenLibrary] ISBN lookup error:', error);
    return { book: null, cacheHit: false };
  }
}

async function searchBooks(
  supabase: ReturnType<typeof createClient>,
  query: string
): Promise<{ books: ResolvedBook[]; cacheHit: boolean }> {
  const normalizedQuery = normalizeQuery(query);
  const queryHash = await computeHash(normalizedQuery);

  // Check cache
  const cached = await lookupCache(supabase, 'openLibrary', 'search', queryHash);
  if (cached.hit && cached.data) {
    const response = cached.data as OpenLibrarySearchResponse;
    const books = response.docs.slice(0, SEARCH_LIMIT).map(mapSearchDocToBook);
    return { books, cacheHit: true };
  }

  // Fetch from Open Library
  try {
    const encodedQuery = encodeURIComponent(normalizedQuery);
    const url = `${OPEN_LIBRARY_BASE}/search.json?q=${encodedQuery}&limit=${SEARCH_LIMIT}`;
    const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

    if (!response.ok) {
      console.error(`[OpenLibrary] Search failed: ${response.status}`);
      return { books: [], cacheHit: false };
    }

    const data: OpenLibrarySearchResponse = await response.json();

    // Cache the result
    await writeCache(
      supabase,
      'openLibrary',
      'search',
      queryHash,
      normalizedQuery,
      data
    );

    const books = data.docs.slice(0, SEARCH_LIMIT).map(mapSearchDocToBook);
    return { books, cacheHit: false };
  } catch (error) {
    console.error('[OpenLibrary] Search error:', error);
    return { books: [], cacheHit: false };
  }
}

// ============================================================================
// Main Resolution Logic
// ============================================================================

async function resolveCandidate(
  supabase: ReturnType<typeof createClient>,
  request: ResolveRequest
): Promise<{
  matches: ScoredMatch[];
  cacheHit: boolean;
  verificationFlags: VerificationFlag[];
}> {
  const allBooks: ResolvedBook[] = [];
  let anyCacheHit = false;

  // 1. Try ISBN lookups first (highest confidence)
  for (const isbnCandidate of request.isbnCandidates) {
    const { book, cacheHit } = await lookupIsbn(supabase, isbnCandidate.isbn);
    if (cacheHit) anyCacheHit = true;
    if (book) {
      allBooks.push(book);
    }
  }

  // 2. Try search queries
  for (const query of request.queries) {
    const { books, cacheHit } = await searchBooks(supabase, query.query);
    if (cacheHit) anyCacheHit = true;
    allBooks.push(...books);
  }

  // 3. Deduplicate by sourceId
  const seen = new Set<string>();
  const uniqueBooks = allBooks.filter((book) => {
    if (seen.has(book.sourceId)) return false;
    seen.add(book.sourceId);
    return true;
  });

  // 4. Score each book
  const primaryQuery = request.queries[0] ?? {
    query: '',
    confidence: 0,
    source: 'ocr' as const,
  };
  const primaryIsbn = request.isbnCandidates[0]?.isbn ?? null;

  const scoredMatches: ScoredMatch[] = uniqueBooks.map((book, index) => ({
    book,
    score: computeMatchScore(book, primaryQuery, primaryIsbn, index),
  }));

  // 5. Sort by composite score
  scoredMatches.sort((a, b) => b.score.composite - a.score.composite);

  // 6. Verify top match
  const verificationFlags: VerificationFlag[] = [];
  if (scoredMatches.length > 0) {
    const evidenceTokens = request.queries.flatMap((q) => tokenize(q.query));
    const topFlags = verifyMatch(
      scoredMatches[0].book,
      primaryQuery,
      primaryIsbn,
      evidenceTokens
    );
    verificationFlags.push(...topFlags);
  }

  return {
    matches: scoredMatches,
    cacheHit: anyCacheHit,
    verificationFlags,
  };
}

// ============================================================================
// Request Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  const startTime = Date.now();

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Get client ID for rate limiting
    const clientId =
      req.headers.get('x-forwarded-for') ??
      req.headers.get('x-real-ip') ??
      'unknown';

    // Check rate limit
    const rateLimit = checkRateLimit(clientId);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({
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
          processingTimeMs: Date.now() - startTime,
        } satisfies ResolveResponse),
        {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Parse request
    const request: ResolveRequest = await req.json();

    // Validate request
    if (!request.sessionId || !request.candidateId || !request.evidenceTier) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Create Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Log request event
    await logEvent(supabase, {
      eventType: 'resolve_request',
      evidenceTier: request.evidenceTier,
      quotaRemaining: rateLimit.remaining,
    });

    // Skip resolution for unusable evidence
    if (request.evidenceTier === 'unusable') {
      const response: ResolveResponse = {
        status: 'no-match',
        cacheHit: false,
        quotaRemaining: rateLimit.remaining,
        matches: [],
        acceptanceDecision: {
          type: 'no-match',
          reason: 'Evidence tier is unusable',
          fallbackToOcr: true,
        },
        canonicalBook: null,
        verificationFlags: [],
        processingTimeMs: Date.now() - startTime,
      };

      return new Response(JSON.stringify(response), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Resolve candidate
    const { matches, cacheHit, verificationFlags } = await resolveCandidate(
      supabase,
      request
    );

    // Log cache event
    await logEvent(supabase, {
      eventType: cacheHit ? 'cache_hit' : 'cache_miss',
      evidenceTier: request.evidenceTier,
    });

    // Make acceptance decision
    const acceptanceDecision = makeAcceptanceDecision(
      matches,
      request.evidenceTier,
      verificationFlags
    );

    // Determine status and canonical book
    let status: ResolveStatus;
    let canonicalBook: ResolvedBook | null = null;

    switch (acceptanceDecision.type) {
      case 'auto-accept':
        status = 'resolved';
        canonicalBook = acceptanceDecision.book;
        break;
      case 'suggest':
        status = 'resolved';
        canonicalBook = acceptanceDecision.book;
        break;
      case 'ambiguous':
        status = 'ambiguous';
        break;
      case 'no-match':
        status = 'no-match';
        break;
    }

    // Log decision event
    const topScore = matches[0]?.score.composite ?? 0;
    const secondScore = matches[1]?.score.composite ?? 0;
    await logEvent(supabase, {
      eventType: 'decision_made',
      evidenceTier: request.evidenceTier,
      decisionType: acceptanceDecision.type,
      matchCount: matches.length,
      topScore,
      dominanceGap: topScore - secondScore,
      durationMs: Date.now() - startTime,
    });

    const response: ResolveResponse = {
      status,
      cacheHit,
      quotaRemaining: rateLimit.remaining,
      matches: matches.slice(0, 5), // Return top 5
      acceptanceDecision,
      canonicalBook,
      verificationFlags,
      processingTimeMs: Date.now() - startTime,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[resolve_candidates] Error:', error);

    const response: ResolveResponse = {
      status: 'error',
      cacheHit: false,
      quotaRemaining: 0,
      matches: [],
      acceptanceDecision: {
        type: 'no-match',
        reason: `Internal error: ${error instanceof Error ? error.message : 'Unknown'}`,
        fallbackToOcr: true,
      },
      canonicalBook: null,
      verificationFlags: [],
      processingTimeMs: Date.now() - startTime,
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
