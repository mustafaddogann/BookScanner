/**
 * Edge Function: resolve_candidates
 * Gate 9: Resolver + Scoring + Verification + Acceptance
 *
 * Resolution strategy:
 * 1. Supabase-first (books_catalog + resolver_cache)
 * 2. Optional Open Library fallback when Supabase cannot resolve confidently
 * 3. Write-through cache of confident fallback matches into books_catalog
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
  VerificationFlag,
  RateLimitState,
  RATE_LIMIT,
  ResolverEvent,
  AcceptanceDecision,
  ResolutionMetrics,
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
const OPEN_LIBRARY_FALLBACK_TIMEOUT_MS = 3500;
const MAX_OPEN_LIBRARY_ISBN_FALLBACKS = 2;
const MAX_OPEN_LIBRARY_SEARCH_FALLBACKS = 2;
const ENABLE_OPEN_LIBRARY_FALLBACK =
  (Deno.env.get('ENABLE_OPEN_LIBRARY_FALLBACK') ?? 'false').toLowerCase() ===
  'true';

const CACHE_MISS_SENTINEL = { __cache_miss: true } as const;

// In-memory rate limiting (best-effort, per-instance)
const rateLimitMap = new Map<string, RateLimitState>();

// ============================================================================
// Types
// ============================================================================

type SupabaseClient = ReturnType<typeof createClient>;

interface CacheLookupResult {
  hit: boolean;
  data: unknown | null;
  knownMiss: boolean;
}

interface IsbnSupabaseLookupResult {
  book: ResolvedBook | null;
  needsOpenLibraryFallback: boolean;
}

interface SearchSupabaseLookupResult {
  books: ResolvedBook[];
  needsOpenLibraryFallback: boolean;
}

interface ResolveCandidateResult {
  matches: ScoredMatch[];
  cacheHit: boolean;
  verificationFlags: VerificationFlag[];
  metrics: ResolutionMetrics;
  fallbackBookKeys: string[];
}

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
// Helpers
// ============================================================================

function createEmptyResolutionMetrics(total = 0): ResolutionMetrics {
  return {
    cache: {
      catalogHits: 0,
      resolverCacheHits: 0,
      resolverCacheMisses: 0,
    },
    fallback: {
      triggered: false,
      openLibraryIsbnCalls: 0,
      openLibrarySearchCalls: 0,
    },
    timingsMs: {
      supabaseLookup: 0,
      fallbackLookup: 0,
      scoringAndDecision: 0,
      total,
    },
  };
}

function normalizeIsbn(isbn: string): string {
  return isbn.replace(/[^0-9Xx]/g, '').toUpperCase();
}

function normalizeCatalogIsbn(
  isbn: string | null | undefined,
  expectedLength: 10 | 13
): string | null {
  if (!isbn) return null;
  const normalized = normalizeIsbn(isbn);
  return normalized.length === expectedLength ? normalized : null;
}

function normalizeRequestIsbns(isbnCandidates: ResolveRequest['isbnCandidates']): string[] {
  const unique = new Set<string>();
  for (const candidate of isbnCandidates) {
    const normalized = normalizeIsbn(candidate.isbn);
    if (normalized.length === 10 || normalized.length === 13) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function buildBookIdentityKey(book: ResolvedBook): string {
  return [
    book.source,
    book.sourceId ?? '',
    book.isbn13 ?? '',
    book.isbn10 ?? '',
    normalizeQuery(book.title),
  ].join('|');
}

function isCacheMissPayload(payload: unknown): boolean {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      '__cache_miss' in payload &&
      (payload as Record<string, unknown>).__cache_miss === true
  );
}

function isFallbackDecisionConfident(decision: AcceptanceDecision): boolean {
  if (decision.type === 'auto-accept') {
    return true;
  }
  if (decision.type === 'suggest') {
    return decision.confidence >= 0.9;
  }
  return false;
}

function shouldAttemptOpenLibraryFallback(decision: AcceptanceDecision): boolean {
  return decision.type === 'no-match' || decision.type === 'ambiguous';
}

function deduplicateBooks(books: ResolvedBook[]): ResolvedBook[] {
  const seen = new Set<string>();
  return books.filter((book) => {
    const key = buildBookIdentityKey(book);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreAndVerifyMatches(
  request: ResolveRequest,
  books: ResolvedBook[]
): { matches: ScoredMatch[]; verificationFlags: VerificationFlag[] } {
  const primaryQuery = request.queries[0] ?? {
    query: '',
    confidence: 0,
    source: 'ocr' as const,
  };
  const allQueryIsbns = normalizeRequestIsbns(request.isbnCandidates);

  const scoredMatches: ScoredMatch[] = books.map((book, index) => ({
    book,
    score: computeMatchScore(book, primaryQuery, allQueryIsbns, index),
  }));

  scoredMatches.sort((a, b) => b.score.composite - a.score.composite);

  const verificationFlags: VerificationFlag[] = [];
  if (scoredMatches.length > 0) {
    const evidenceTokens = request.queries.flatMap((q) => tokenize(q.query));
    verificationFlags.push(
      ...verifyMatch(
        scoredMatches[0].book,
        primaryQuery,
        allQueryIsbns,
        evidenceTokens
      )
    );
  }

  return {
    matches: scoredMatches,
    verificationFlags,
  };
}

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
  supabase: SupabaseClient,
  provider: string,
  queryType: string,
  queryHash: string
): Promise<CacheLookupResult> {
  const { data, error } = await supabase
    .from('resolver_cache')
    .select('response_json, id, hit_count')
    .eq('provider', provider)
    .eq('query_type', queryType)
    .eq('query_hash', queryHash)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (error || !data) {
    return { hit: false, data: null, knownMiss: false };
  }

  // Update hit count (fire-and-forget)
  supabase
    .from('resolver_cache')
    .update({
      hit_count: (typeof data.hit_count === 'number' ? data.hit_count : 0) + 1,
      last_hit_at: new Date().toISOString(),
    })
    .eq('id', data.id)
    .then(() => {});

  const knownMiss = isCacheMissPayload(data.response_json);
  return {
    hit: true,
    data: knownMiss ? null : data.response_json,
    knownMiss,
  };
}

async function writeCache(
  supabase: SupabaseClient,
  provider: string,
  queryType: string,
  queryHash: string,
  queryText: string,
  responseJson: unknown
): Promise<void> {
  const payload = responseJson ?? CACHE_MISS_SENTINEL;

  const { error } = await supabase.from('resolver_cache').upsert(
    {
      provider,
      query_type: queryType,
      query_hash: queryHash,
      query_text: queryText,
      response_json: payload,
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
  supabase: SupabaseClient,
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
// Supabase Catalog Lookup (books_catalog + resolver_cache)
// ============================================================================

function mapCatalogRowToBook(row: {
  provider: string;
  provider_id: string;
  isbn13: string | null;
  isbn10: string | null;
  title: string;
  authors: string[];
  publisher: string | null;
  publish_year: string | null;
  cover_url: string | null;
}): ResolvedBook {
  const source = row.provider === 'googleBooks' ? 'googleBooks' : 'openLibrary';

  return {
    title: row.title,
    authors: row.authors ?? [],
    isbn13: row.isbn13,
    isbn10: row.isbn10,
    publisher: row.publisher,
    publishYear: row.publish_year ? parseInt(row.publish_year, 10) || null : null,
    edition: null,
    coverUrl: row.cover_url,
    source,
    sourceId: row.provider_id,
  };
}

async function lookupCatalogByIsbn(
  supabase: SupabaseClient,
  isbn: string
): Promise<ResolvedBook | null> {
  const normalizedIsbn = normalizeIsbn(isbn);
  const column = normalizedIsbn.length === 13 ? 'isbn13' : normalizedIsbn.length === 10 ? 'isbn10' : null;
  if (!column) {
    return null;
  }

  const { data, error } = await supabase
    .from('books_catalog')
    .select('provider, provider_id, isbn13, isbn10, title, authors, publisher, publish_year, cover_url')
    .eq(column, normalizedIsbn)
    .limit(1)
    .single();

  if (error || !data) return null;
  return mapCatalogRowToBook(data);
}

async function searchCatalogFuzzy(
  supabase: SupabaseClient,
  query: string,
  limit: number = SEARCH_LIMIT
): Promise<ResolvedBook[]> {
  const { data, error } = await supabase.rpc('search_books_fuzzy', {
    p_query: query,
    p_limit: limit,
    p_threshold: 0.3,
  });

  if (error || !data || data.length === 0) return [];

  return data.map((row: any) =>
    mapCatalogRowToBook({
      provider: row.provider,
      provider_id: row.provider_id,
      isbn13: row.isbn13,
      isbn10: row.isbn10,
      title: row.title,
      authors: row.authors,
      publisher: row.publisher,
      publish_year: row.publish_year,
      cover_url: row.cover_url,
    })
  );
}

async function lookupIsbnFromSupabase(
  supabase: SupabaseClient,
  isbn: string,
  metrics: ResolutionMetrics
): Promise<IsbnSupabaseLookupResult> {
  const normalizedIsbn = normalizeIsbn(isbn);

  // 1) Catalog hit (fastest path)
  const catalogBook = await lookupCatalogByIsbn(supabase, normalizedIsbn);
  if (catalogBook) {
    metrics.cache.catalogHits += 1;
    console.log(`[Resolver][Supabase] ISBN catalog hit: ${normalizedIsbn} -> "${catalogBook.title}"`);
    return { book: catalogBook, needsOpenLibraryFallback: false };
  }

  // 2) resolver_cache hit
  const queryHash = await computeHash(normalizedIsbn);
  const cached = await lookupCache(supabase, 'openLibrary', 'isbn', queryHash);
  if (cached.hit) {
    metrics.cache.resolverCacheHits += 1;
    if (cached.data) {
      const book = mapIsbnResponseToBook(cached.data as OpenLibraryIsbnResponse, normalizedIsbn);
      console.log(`[Resolver][Supabase] ISBN resolver_cache hit: ${normalizedIsbn} -> "${book.title}"`);
      return { book, needsOpenLibraryFallback: false };
    }

    console.log(`[Resolver][Supabase] ISBN known miss (resolver_cache): ${normalizedIsbn}`);
    return { book: null, needsOpenLibraryFallback: false };
  }

  // 3) Cache miss (eligible for Open Library fallback if needed)
  metrics.cache.resolverCacheMisses += 1;
  return { book: null, needsOpenLibraryFallback: true };
}

async function searchBooksFromSupabase(
  supabase: SupabaseClient,
  query: string,
  metrics: ResolutionMetrics
): Promise<SearchSupabaseLookupResult> {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return { books: [], needsOpenLibraryFallback: false };
  }

  const catalogBooks = await searchCatalogFuzzy(supabase, normalizedQuery);
  if (catalogBooks.length > 0) {
    metrics.cache.catalogHits += 1;
    console.log(`[Resolver][Supabase] Search catalog hit: "${normalizedQuery}" -> ${catalogBooks.length} results`);
  }

  const queryHash = await computeHash(normalizedQuery);
  const cached = await lookupCache(supabase, 'openLibrary', 'search', queryHash);

  if (cached.hit) {
    metrics.cache.resolverCacheHits += 1;

    const cachedBooks = cached.data
      ? ((cached.data as OpenLibrarySearchResponse).docs ?? [])
          .slice(0, SEARCH_LIMIT)
          .map(mapSearchDocToBook)
      : [];

    const merged = deduplicateBooks([...catalogBooks, ...cachedBooks]).slice(0, SEARCH_LIMIT);

    console.log(
      `[Resolver][Supabase] Search resolver_cache hit: "${normalizedQuery}" -> ${merged.length} merged results`
    );

    return {
      books: merged,
      needsOpenLibraryFallback: false,
    };
  }

  // No resolver_cache row; fallback may be attempted only if Supabase-only decision is unresolved.
  metrics.cache.resolverCacheMisses += 1;

  return {
    books: catalogBooks,
    needsOpenLibraryFallback: true,
  };
}

// ============================================================================
// Open Library Fallback
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

async function lookupIsbnFromOpenLibrary(
  supabase: SupabaseClient,
  isbn: string,
  metrics: ResolutionMetrics,
  evidenceTier: ResolveRequest['evidenceTier']
): Promise<ResolvedBook | null> {
  const normalizedIsbn = normalizeIsbn(isbn);
  const queryHash = await computeHash(normalizedIsbn);
  const callStart = Date.now();

  metrics.fallback.openLibraryIsbnCalls += 1;

  try {
    const url = `${OPEN_LIBRARY_BASE}/isbn/${normalizedIsbn}.json`;
    const response = await fetchWithTimeout(url, OPEN_LIBRARY_FALLBACK_TIMEOUT_MS);

    if (response.status === 404) {
      await writeCache(supabase, 'openLibrary', 'isbn', queryHash, normalizedIsbn, null);
      void logEvent(supabase, {
        eventType: 'provider_call',
        provider: 'openLibrary',
        queryType: 'isbn',
        evidenceTier,
        durationMs: Date.now() - callStart,
        matchCount: 0,
      });
      return null;
    }

    if (!response.ok) {
      console.error(`[Resolver][Fallback] Open Library ISBN failed: status=${response.status} isbn=${normalizedIsbn}`);
      void logEvent(supabase, {
        eventType: 'provider_error',
        provider: 'openLibrary',
        queryType: 'isbn',
        evidenceTier,
        durationMs: Date.now() - callStart,
        errorCode: String(response.status),
      });
      return null;
    }

    const data: OpenLibraryIsbnResponse = await response.json();
    await writeCache(supabase, 'openLibrary', 'isbn', queryHash, normalizedIsbn, data);

    const book = mapIsbnResponseToBook(data, normalizedIsbn);
    void logEvent(supabase, {
      eventType: 'provider_call',
      provider: 'openLibrary',
      queryType: 'isbn',
      evidenceTier,
      durationMs: Date.now() - callStart,
      matchCount: 1,
    });
    console.log(`[Resolver][Fallback] Open Library ISBN hit: ${normalizedIsbn} -> "${book.title}"`);
    return book;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.error('[Resolver][Fallback] Open Library ISBN error:', message);
    void logEvent(supabase, {
      eventType: 'provider_error',
      provider: 'openLibrary',
      queryType: 'isbn',
      evidenceTier,
      durationMs: Date.now() - callStart,
      errorCode: message,
    });
    return null;
  }
}

async function searchBooksFromOpenLibrary(
  supabase: SupabaseClient,
  query: string,
  metrics: ResolutionMetrics,
  evidenceTier: ResolveRequest['evidenceTier']
): Promise<ResolvedBook[]> {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return [];
  }

  const queryHash = await computeHash(normalizedQuery);
  const callStart = Date.now();

  metrics.fallback.openLibrarySearchCalls += 1;

  try {
    const encodedQuery = encodeURIComponent(normalizedQuery);
    const url = `${OPEN_LIBRARY_BASE}/search.json?q=${encodedQuery}&limit=${SEARCH_LIMIT}`;
    const response = await fetchWithTimeout(url, OPEN_LIBRARY_FALLBACK_TIMEOUT_MS);

    if (!response.ok) {
      console.error(`[Resolver][Fallback] Open Library search failed: status=${response.status} query="${normalizedQuery}"`);
      void logEvent(supabase, {
        eventType: 'provider_error',
        provider: 'openLibrary',
        queryType: 'search',
        evidenceTier,
        durationMs: Date.now() - callStart,
        errorCode: String(response.status),
      });
      return [];
    }

    const data: OpenLibrarySearchResponse = await response.json();
    await writeCache(
      supabase,
      'openLibrary',
      'search',
      queryHash,
      normalizedQuery,
      data
    );

    const docs = Array.isArray(data.docs) ? data.docs : [];
    const books = docs.slice(0, SEARCH_LIMIT).map(mapSearchDocToBook);

    void logEvent(supabase, {
      eventType: 'provider_call',
      provider: 'openLibrary',
      queryType: 'search',
      evidenceTier,
      durationMs: Date.now() - callStart,
      matchCount: books.length,
    });

    console.log(`[Resolver][Fallback] Open Library search: "${normalizedQuery}" -> ${books.length} results`);
    return books;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.error('[Resolver][Fallback] Open Library search error:', message);
    void logEvent(supabase, {
      eventType: 'provider_error',
      provider: 'openLibrary',
      queryType: 'search',
      evidenceTier,
      durationMs: Date.now() - callStart,
      errorCode: message,
    });
    return [];
  }
}

async function persistConfidentFallbackBook(
  supabase: SupabaseClient,
  book: ResolvedBook,
  confidence: number
): Promise<void> {
  if (book.source !== 'openLibrary' && book.source !== 'googleBooks') {
    return;
  }

  const providerId = book.sourceId ?? book.isbn13 ?? book.isbn10;
  if (!providerId) {
    return;
  }

  const payload = {
    provider: book.source,
    provider_id: providerId,
    title: book.title,
    authors: book.authors ?? [],
    isbn13: normalizeCatalogIsbn(book.isbn13, 13),
    isbn10: normalizeCatalogIsbn(book.isbn10, 10),
    publisher: book.publisher ?? null,
    publish_year: book.publishYear != null ? String(book.publishYear) : null,
    cover_url: book.coverUrl ?? null,
    source_confidence: confidence,
  } as const;

  const { error } = await supabase
    .from('books_catalog')
    .upsert(payload, { onConflict: 'provider,provider_id' });

  if (!error) {
    console.log(
      `[Resolver][CacheWriteThrough] books_catalog upsert ok provider=${book.source} provider_id="${providerId}" confidence=${confidence.toFixed(3)}`
    );
    return;
  }

  // Compatibility fallback for deployments that do not yet have source_confidence
  if ((error.message ?? '').includes('source_confidence')) {
    const { source_confidence: _ignored, ...compatPayload } = payload;
    const { error: compatError } = await supabase
      .from('books_catalog')
      .upsert(compatPayload, { onConflict: 'provider,provider_id' });

    if (!compatError) {
      console.log(
        `[Resolver][CacheWriteThrough] books_catalog upsert ok (compat mode) provider=${book.source} provider_id="${providerId}"`
      );
      return;
    }

    console.error('[Resolver][CacheWriteThrough] books_catalog compat upsert failed:', compatError);
    return;
  }

  console.error('[Resolver][CacheWriteThrough] books_catalog upsert failed:', error);
}

// ============================================================================
// Main Resolution Logic
// ============================================================================

async function resolveCandidate(
  supabase: SupabaseClient,
  request: ResolveRequest
): Promise<ResolveCandidateResult> {
  const metrics = createEmptyResolutionMetrics();
  const supabaseBooks: ResolvedBook[] = [];

  const fallbackIsbns: string[] = [];
  const fallbackQueries: string[] = [];

  const uniqueIsbns = normalizeRequestIsbns(request.isbnCandidates);
  const uniqueQueries = Array.from(
    new Set(request.queries.map((q) => normalizeQuery(q.query)).filter(Boolean))
  );

  // Phase 1: Supabase-only lookups
  const supabaseLookupStart = Date.now();

  for (const isbn of uniqueIsbns) {
    const result = await lookupIsbnFromSupabase(supabase, isbn, metrics);
    if (result.book) {
      supabaseBooks.push(result.book);
    }
    if (result.needsOpenLibraryFallback) {
      fallbackIsbns.push(isbn);
    }
  }

  for (const query of uniqueQueries) {
    const result = await searchBooksFromSupabase(supabase, query, metrics);
    if (result.books.length > 0) {
      supabaseBooks.push(...result.books);
    }
    if (result.needsOpenLibraryFallback) {
      fallbackQueries.push(query);
    }
  }

  metrics.timingsMs.supabaseLookup = Date.now() - supabaseLookupStart;

  const dedupedSupabaseBooks = deduplicateBooks(supabaseBooks);

  const scoringStart = Date.now();
  let { matches, verificationFlags } = scoreAndVerifyMatches(
    request,
    dedupedSupabaseBooks
  );

  // Phase 2: Conditional Open Library fallback
  const initialDecision = makeAcceptanceDecision(
    matches,
    request.evidenceTier,
    verificationFlags
  );

  const fallbackBookKeys = new Set<string>();

  if (
    ENABLE_OPEN_LIBRARY_FALLBACK &&
    shouldAttemptOpenLibraryFallback(initialDecision) &&
    (fallbackIsbns.length > 0 || fallbackQueries.length > 0)
  ) {
    metrics.fallback.triggered = true;

    const fallbackLookupStart = Date.now();
    const fallbackBooks: ResolvedBook[] = [];

    for (const isbn of fallbackIsbns.slice(0, MAX_OPEN_LIBRARY_ISBN_FALLBACKS)) {
      const book = await lookupIsbnFromOpenLibrary(
        supabase,
        isbn,
        metrics,
        request.evidenceTier
      );
      if (book) {
        fallbackBooks.push(book);
        fallbackBookKeys.add(buildBookIdentityKey(book));
      }
    }

    for (const query of fallbackQueries.slice(0, MAX_OPEN_LIBRARY_SEARCH_FALLBACKS)) {
      const books = await searchBooksFromOpenLibrary(
        supabase,
        query,
        metrics,
        request.evidenceTier
      );
      for (const book of books) {
        fallbackBooks.push(book);
        fallbackBookKeys.add(buildBookIdentityKey(book));
      }
    }

    metrics.timingsMs.fallbackLookup = Date.now() - fallbackLookupStart;

    const mergedBooks = deduplicateBooks([...dedupedSupabaseBooks, ...fallbackBooks]);
    const rescored = scoreAndVerifyMatches(request, mergedBooks);
    matches = rescored.matches;
    verificationFlags = rescored.verificationFlags;
  } else if (
    !ENABLE_OPEN_LIBRARY_FALLBACK &&
    (fallbackIsbns.length > 0 || fallbackQueries.length > 0)
  ) {
    console.log(
      `[Resolver] Open Library fallback disabled (candidate=${request.candidateId})`
    );
  }

  metrics.timingsMs.scoringAndDecision = Date.now() - scoringStart;
  metrics.timingsMs.total =
    metrics.timingsMs.supabaseLookup +
    metrics.timingsMs.fallbackLookup +
    metrics.timingsMs.scoringAndDecision;

  const cacheHit =
    metrics.cache.catalogHits > 0 || metrics.cache.resolverCacheHits > 0;

  return {
    matches,
    cacheHit,
    verificationFlags,
    metrics,
    fallbackBookKeys: Array.from(fallbackBookKeys),
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
          resolutionMetrics: createEmptyResolutionMetrics(Date.now() - startTime),
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
        resolutionMetrics: createEmptyResolutionMetrics(Date.now() - startTime),
      };

      return new Response(JSON.stringify(response), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Resolve candidate
    const {
      matches,
      cacheHit,
      verificationFlags,
      metrics,
      fallbackBookKeys,
    } = await resolveCandidate(supabase, request);

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

    // Write-through cache: persist confident fallback matches into books_catalog
    if (
      canonicalBook &&
      isFallbackDecisionConfident(acceptanceDecision) &&
      fallbackBookKeys.includes(buildBookIdentityKey(canonicalBook))
    ) {
      const confidence =
        acceptanceDecision.type === 'no-match' || acceptanceDecision.type === 'ambiguous'
          ? 0
          : acceptanceDecision.confidence;

      await persistConfidentFallbackBook(supabase, canonicalBook, confidence);
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

    console.log(
      '[ResolverMetrics] ' +
        `session=${request.sessionId} candidate=${request.candidateId} ` +
        `cache_hits=${metrics.cache.catalogHits + metrics.cache.resolverCacheHits} ` +
        `cache_misses=${metrics.cache.resolverCacheMisses} ` +
        `fallback_triggered=${metrics.fallback.triggered} ` +
        `fallback_isbn_calls=${metrics.fallback.openLibraryIsbnCalls} ` +
        `fallback_search_calls=${metrics.fallback.openLibrarySearchCalls} ` +
        `phase_ms.supabase=${metrics.timingsMs.supabaseLookup} ` +
        `phase_ms.fallback=${metrics.timingsMs.fallbackLookup} ` +
        `phase_ms.decision=${metrics.timingsMs.scoringAndDecision} ` +
        `phase_ms.total=${metrics.timingsMs.total}`
    );

    const response: ResolveResponse = {
      status,
      cacheHit,
      quotaRemaining: rateLimit.remaining,
      matches: matches.slice(0, 5), // Return top 5
      acceptanceDecision,
      canonicalBook,
      verificationFlags,
      processingTimeMs: Date.now() - startTime,
      resolutionMetrics: {
        ...metrics,
        timingsMs: {
          ...metrics.timingsMs,
          total: Date.now() - startTime,
        },
      },
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
      resolutionMetrics: createEmptyResolutionMetrics(Date.now() - startTime),
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
