/**
 * Open Library Provider
 *
 * Implements MetadataLookupProvider using Open Library APIs:
 * - Search API: https://openlibrary.org/search.json
 * - Books API: https://openlibrary.org/api/books (for ISBN enrichment)
 *
 * Gate 9: ISBN fetching and enrichment
 */

import type { ResolvedBook, EvidenceSourceKind } from '../types';
import type { MetadataLookupProvider } from './metadataLookupProvider';
import { useDebugStore } from '../store/useDebugStore';
import {
  getSupabaseBaseUrl,
  getSupabaseAnonKey,
  isSupabaseConfigured,
} from '../config/supabase';
import {
  generateHypotheses,
  generateBoostHypotheses,
  type SearchHypothesis,
  type HypothesisDebugContext,
  type HypothesisGenerationResult,
} from './queryHypotheses';
import {
  buildEvidenceTokens,
  type EvidenceTokens,
} from './evidenceNormalization';
import {
  determineIsbnPolicy,
  shouldApplyIsbnBoost,
  validateIsbnChecksum,
} from './isbnUtils';
import {
  scoreAndRankCandidates,
  makeDecisionFromScores,
  type ScoredCandidate,
  type ScoringDecision,
} from './candidateScoring';
import {
  MAX_RESULTS_PER_HYPOTHESIS as CONFIG_MAX_RESULTS,
  MAX_ENRICH_CALLS_PER_SESSION as CONFIG_MAX_ENRICH,
  SESSION_CACHE_TTL_MS as CONFIG_CACHE_TTL,
} from '../config/metadataResolutionConfig';

// API endpoints
const OPEN_LIBRARY_SEARCH = 'https://openlibrary.org/search.json';
const OPEN_LIBRARY_BOOKS = 'https://openlibrary.org/api/books';

// Request timeout in milliseconds
const FETCH_TIMEOUT = 10000;

// ============================================================================
// Rate-limit Safety Constants (from config)
// ============================================================================

/** Maximum results per hypothesis (for rate-limit safety) */
const MAX_RESULTS_PER_HYPOTHESIS = CONFIG_MAX_RESULTS;

/** Maximum total enrichment calls per session */
const MAX_ENRICHMENT_CALLS = CONFIG_MAX_ENRICH;

// ============================================================================
// In-Memory Query Cache (session-scoped)
// ============================================================================

interface CachedQueryResult {
  results: ResolvedBook[];
  timestamp: number;
}

/** In-memory cache keyed by query hash */
const queryCache = new Map<string, CachedQueryResult>();

/** Session-level enrichment call counter */
let sessionEnrichmentCalls = 0;

/** Cache TTL in milliseconds (from config) */
const SESSION_CACHE_TTL_MS = CONFIG_CACHE_TTL;

/**
 * Get cached query results if available and not expired
 */
function getCachedResults(queryHash: string): ResolvedBook[] | null {
  const cached = queryCache.get(queryHash);
  if (!cached) {
    return null;
  }

  // Check TTL
  if (Date.now() - cached.timestamp > SESSION_CACHE_TTL_MS) {
    queryCache.delete(queryHash);
    return null;
  }

  return cached.results;
}

/**
 * Cache query results
 */
function cacheResults(queryHash: string, results: ResolvedBook[]): void {
  queryCache.set(queryHash, {
    results,
    timestamp: Date.now(),
  });
}

/**
 * Clear the session cache (for testing or session reset)
 */
export function clearQueryCache(): void {
  queryCache.clear();
  sessionEnrichmentCalls = 0;
}

/**
 * Get cache stats for debugging
 */
export function getQueryCacheStats(): { size: number; enrichmentCalls: number } {
  return {
    size: queryCache.size,
    enrichmentCalls: sessionEnrichmentCalls,
  };
}

/**
 * Check if verbose diagnostics logging should be enabled.
 */
function shouldLogVerbose(): boolean {
  const diagnosticsEnabled = useDebugStore.getState().diagnosticsEnabled;
  return __DEV__ && diagnosticsEnabled;
}

/**
 * Search result from Open Library Search API
 */
interface OLSearchDoc {
  key: string; // Work key: "/works/OL123W"
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  publisher?: string[];
  isbn?: string[];
  cover_i?: number;
  edition_key?: string[]; // Edition keys: ["OL123M", "OL456M"]
  lccn?: string[];
  oclc?: string[];
}

/**
 * Response from Open Library Books API
 */
interface OLBooksApiResponse {
  [key: string]: OLBookData | undefined;
}

interface OLBookData {
  title?: string;
  authors?: Array<{ name: string; url?: string }>;
  publishers?: Array<{ name: string }>;
  publish_date?: string;
  identifiers?: {
    isbn_10?: string[];
    isbn_13?: string[];
    openlibrary?: string[];
    lccn?: string[];
    oclc?: string[];
  };
  cover?: {
    small?: string;
    medium?: string;
    large?: string;
  };
  number_of_pages?: number;
  subjects?: Array<{ name: string }>;
  url?: string;
}

/**
 * Candidate for ISBN enrichment
 */
interface EnrichmentCandidate {
  olid: string; // Edition OLID (e.g., "OL123M") or Work key
  title?: string;
  authors?: string[];
  publishYear?: string;
  coverUrl?: string;
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Extract year from various date formats
 */
function extractYear(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;
  const match = dateStr.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
  return match ? match[1] : undefined;
}

/**
 * Normalize ISBN by removing hyphens and spaces
 */
function normalizeIsbn(isbn: string): string {
  return isbn.replace(/[-\s]/g, '');
}

/**
 * Check if a string is a valid ISBN-13
 */
function isIsbn13(isbn: string): boolean {
  const normalized = normalizeIsbn(isbn);
  return /^97[89]\d{10}$/.test(normalized);
}

/**
 * Check if a string is a valid ISBN-10
 */
function isIsbn10(isbn: string): boolean {
  const normalized = normalizeIsbn(isbn);
  return /^\d{9}[\dXx]$/.test(normalized);
}

/**
 * Build cover URL from cover ID
 */
function buildCoverUrl(coverId: number | undefined): string | undefined {
  if (!coverId) return undefined;
  return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
}

// ============================================================================
// Supabase Catalog Lookup (local DB, sub-ms latency)
// ============================================================================

interface CatalogRow {
  id: string;
  provider: string;
  provider_id: string;
  isbn13: string | null;
  isbn10: string | null;
  title: string;
  authors: string[];
  publisher: string | null;
  publish_year: string | null;
  cover_url: string | null;
  resolver_key: string | null;
  similarity_score?: number;
}

function catalogRowToBook(row: CatalogRow): ResolvedBook {
  return {
    title: row.title,
    authors: row.authors ?? [],
    isbn13: row.isbn13 ?? undefined,
    isbn10: row.isbn10 ?? undefined,
    publisher: row.publisher ?? undefined,
    publishYear: row.publish_year ?? undefined,
    coverUrl: row.cover_url ?? undefined,
    source: 'openLibrary',
    sourceId: row.resolver_key ?? row.provider_id,
  };
}

/**
 * Search the local Supabase books_catalog via pg_trgm fuzzy search.
 * Returns results quickly from the pre-populated catalog.
 */
const CATALOG_FALLBACK_QUERY_LIMIT = 3;

async function searchCatalog(query: string, limit: number = 5): Promise<ResolvedBook[]> {
  if (!isSupabaseConfigured()) return [];

  try {
    const baseUrl = getSupabaseBaseUrl();
    const anonKey = getSupabaseAnonKey();
    const url = `${baseUrl}/rest/v1/rpc/search_books_fuzzy`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const rpcResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ p_query: query, p_limit: limit, p_threshold: 0.3 }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!rpcResponse.ok) {
      console.warn(`[Catalog] Fuzzy search failed: ${rpcResponse.status}`);
      return [];
    }

    const rows: CatalogRow[] = await rpcResponse.json();
    if (!rows || rows.length === 0) return [];

    console.log(`[Catalog] Fuzzy search "${query}" → ${rows.length} results (top: ${rows[0].similarity_score?.toFixed(2)})`);
    return rows.map(catalogRowToBook);
  } catch (error: any) {
    console.warn(`[Catalog] Search error: ${error.message}`);
    return [];
  }
}

/**
 * Look up a book by ISBN in the local catalog.
 */
async function searchCatalogByIsbn(isbn: string): Promise<ResolvedBook[]> {
  if (!isSupabaseConfigured()) return [];

  try {
    const baseUrl = getSupabaseBaseUrl();
    const anonKey = getSupabaseAnonKey();
    const column = isbn.length === 13 ? 'isbn13' : 'isbn10';
    const url = `${baseUrl}/rest/v1/books_catalog?${column}=eq.${isbn}&limit=1`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const rows: CatalogRow[] = await response.json();
    if (!rows || rows.length === 0) return [];

    console.log(`[Catalog] ISBN hit: ${isbn} → "${rows[0].title}"`);
    return rows.map(catalogRowToBook);
  } catch (error: any) {
    console.warn(`[Catalog] ISBN lookup error: ${error.message}`);
    return [];
  }
}

// ============================================================================
// Provider Implementation
// ============================================================================

/**
 * Open Library Provider Implementation
 */
export class OpenLibraryProvider implements MetadataLookupProvider {
  readonly name = 'openLibrary';
  readonly isEnabled = true;

  /**
   * Search by ISBN using Open Library Books API
   */
  async searchByIsbn(isbn: string): Promise<ResolvedBook[]> {
    const normalized = normalizeIsbn(isbn);
    if (!isIsbn10(normalized) && !isIsbn13(normalized)) {
      console.warn(`[OpenLibrary] Invalid ISBN format: ${isbn}`);
      return [];
    }

    const verbose = shouldLogVerbose();
    if (verbose) {
      console.log(`[OpenLibrary] searchByIsbn: ${normalized}`);
    }

    // Check local catalog first
    const catalogResults = await searchCatalogByIsbn(normalized);
    if (catalogResults.length > 0) {
      return catalogResults;
    }

    try {
      // Use Books API with ISBN bibkey
      const bibkey = `ISBN:${normalized}`;
      const url = `${OPEN_LIBRARY_BOOKS}?bibkeys=${bibkey}&format=json&jscmd=data`;

      if (verbose) {
        console.log(`[OpenLibrary] Books API request: ${url}`);
      }

      const response = await fetchWithTimeout(url, FETCH_TIMEOUT);
      if (!response.ok) {
        console.warn(`[OpenLibrary] Books API error: ${response.status}`);
        return [];
      }

      const data: OLBooksApiResponse = await response.json();
      const bookData = data[bibkey];

      if (!bookData) {
        if (verbose) {
          console.log(`[OpenLibrary] No result for ISBN: ${normalized}`);
        }
        return [];
      }

      // Extract ISBNs
      const isbn13 = bookData.identifiers?.isbn_13?.[0];
      const isbn10 = bookData.identifiers?.isbn_10?.[0];
      const olid = bookData.identifiers?.openlibrary?.[0];

      const resolvedBook: ResolvedBook = {
        title: bookData.title || '',
        authors: bookData.authors?.map((a) => a.name) || [],
        isbn13: isbn13 ? normalizeIsbn(isbn13) : undefined,
        isbn10: isbn10 ? normalizeIsbn(isbn10) : undefined,
        publisher: bookData.publishers?.[0]?.name,
        publishYear: extractYear(bookData.publish_date),
        coverUrl: bookData.cover?.medium || bookData.cover?.small,
        source: 'openLibrary',
        sourceId: olid || normalized,
      };

      if (verbose) {
        console.log(`[OpenLibrary] ISBN result:`, JSON.stringify(resolvedBook, null, 2));
      }

      return [resolvedBook];
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn('[OpenLibrary] ISBN request timed out');
      } else {
        console.warn(`[OpenLibrary] ISBN search error: ${error.message}`);
      }
      return [];
    }
  }

  /**
   * Search by text query using Open Library Search API
   * Then enriches top results to get ISBNs
   */
  async searchByText(query: string): Promise<ResolvedBook[]> {
    if (!query || query.trim().length < 2) {
      return [];
    }

    // ALWAYS-ON: Log search start
    console.log(`[OpenLibraryProvider] searchByText START query="${query}"`);
    const startTime = Date.now();

    const verbose = shouldLogVerbose();

    // Check local catalog first (fast, no network to OL)
    const catalogResults = await searchCatalog(query, 5);
    if (catalogResults.length >= 3) {
      console.log(`[OpenLibraryProvider] searchByText END query="${query}" count=${catalogResults.length} ms=${Date.now() - startTime} source=catalog`);
      return catalogResults;
    }

    try {
      // Fall back to Open Library API
      const candidates = await this.searchByQuery(query, 5);

      if (candidates.length === 0 && catalogResults.length > 0) {
        // OL returned nothing but catalog had some results — use them
        console.log(`[OpenLibraryProvider] searchByText END query="${query}" count=${catalogResults.length} ms=${Date.now() - startTime} source=catalog_fallback`);
        return catalogResults;
      }

      if (candidates.length === 0) {
        // ALWAYS-ON: Log search end
        console.log(`[OpenLibraryProvider] searchByText END query="${query}" count=0 ms=${Date.now() - startTime}`);
        return [];
      }

      if (verbose) {
        console.log(`[OpenLibrary] Search returned ${candidates.length} candidates`);
      }

      // Enrich top candidates to get ISBNs
      const enriched = await this.enrichToISBN(candidates);

      // Merge catalog results with OL results (catalog first, deduplicate by title)
      if (catalogResults.length > 0) {
        const seen = new Set(catalogResults.map((b) => b.title.toLowerCase()));
        const unique = enriched.filter((b) => !seen.has(b.title.toLowerCase()));
        const merged = [...catalogResults, ...unique].slice(0, 10);
        console.log(`[OpenLibraryProvider] searchByText END query="${query}" count=${merged.length} ms=${Date.now() - startTime} source=merged`);
        return merged;
      }

      // ALWAYS-ON: Log search end
      console.log(`[OpenLibraryProvider] searchByText END query="${query}" count=${enriched.length} ms=${Date.now() - startTime} source=openLibrary`);

      return enriched;
    } catch (error: any) {
      // If OL fails but catalog had results, use them
      if (catalogResults.length > 0) {
        console.log(`[OpenLibraryProvider] searchByText END query="${query}" count=${catalogResults.length} ms=${Date.now() - startTime} source=catalog_error_fallback`);
        return catalogResults;
      }
      // ALWAYS-ON: Log search error
      console.warn(`[OpenLibraryProvider] searchByText ERROR query="${query}" error="${error.message}" ms=${Date.now() - startTime}`);
      return [];
    }
  }

  /**
   * Search Open Library by query string
   * Returns candidates with edition keys for ISBN enrichment
   */
  async searchByQuery(queryString: string, limit: number = 5): Promise<EnrichmentCandidate[]> {
    const verbose = shouldLogVerbose();

    // Build search URL with general query
    const encodedQuery = encodeURIComponent(queryString);
    const url = `${OPEN_LIBRARY_SEARCH}?q=${encodedQuery}&limit=${limit}&fields=key,title,author_name,first_publish_year,publisher,isbn,cover_i,edition_key`;

    if (verbose) {
      console.log(`[OpenLibrary] Search API request: ${url}`);
    }

    const response = await fetchWithTimeout(url, FETCH_TIMEOUT);
    if (!response.ok) {
      console.warn(`[OpenLibrary] Search API error: ${response.status}`);
      return [];
    }

    const data = await response.json();

    if (!data.docs || !Array.isArray(data.docs)) {
      return [];
    }

    if (verbose) {
      console.log(`[OpenLibrary] Search response: ${data.docs.length} docs, numFound: ${data.numFound}`);
    }

    // Convert to enrichment candidates
    const candidates: EnrichmentCandidate[] = data.docs.slice(0, limit).map((doc: OLSearchDoc) => {
      // Prefer first edition key if available, otherwise use work key
      let olid: string;
      if (doc.edition_key && doc.edition_key.length > 0) {
        olid = doc.edition_key[0]; // Edition OLID (e.g., "OL123M")
      } else {
        // Extract OLID from work key (e.g., "/works/OL123W" -> "OL123W")
        olid = doc.key?.replace('/works/', '') || '';
      }

      // ALWAYS-ON: Log author extraction from Search API
      console.log(`[OpenLibrary] Search doc: title="${doc.title}" author_name=${JSON.stringify(doc.author_name)} olid=${olid}`);

      return {
        olid,
        title: doc.title,
        authors: doc.author_name,
        publishYear: doc.first_publish_year?.toString(),
        coverUrl: buildCoverUrl(doc.cover_i),
      };
    });

    return candidates.filter((c) => c.olid); // Filter out any without OLID
  }

  /**
   * Enrich candidates with ISBN data using Open Library Books API
   * Uses batch request for efficiency
   */
  async enrichToISBN(candidates: EnrichmentCandidate[]): Promise<ResolvedBook[]> {
    if (candidates.length === 0) {
      return [];
    }

    const verbose = shouldLogVerbose();

    // Build bibkeys for batch request
    // Format: OLID:OL123M,OLID:OL456M
    const bibkeys = candidates
      .map((c) => `OLID:${c.olid}`)
      .join(',');

    const url = `${OPEN_LIBRARY_BOOKS}?bibkeys=${encodeURIComponent(bibkeys)}&format=json&jscmd=data`;

    if (verbose) {
      console.log(`[OpenLibrary] Books API batch request for ${candidates.length} OLIDs`);
    }

    try {
      const response = await fetchWithTimeout(url, FETCH_TIMEOUT);
      if (!response.ok) {
        console.warn(`[OpenLibrary] Books API batch error: ${response.status}`);
        // Fall back to returning candidates without ISBN enrichment
        return this.candidatesToResolvedBooks(candidates);
      }

      const data: OLBooksApiResponse = await response.json();

      if (verbose) {
        const returnedKeys = Object.keys(data);
        console.log(`[OpenLibrary] Books API returned ${returnedKeys.length} results`);
      }

      // Merge enriched data with candidates
      const results: ResolvedBook[] = [];

      // ALWAYS-ON: Log what Books API returned
      console.log(`[OpenLibrary] Books API returned keys: ${Object.keys(data).join(', ') || 'none'}`);

      for (const candidate of candidates) {
        const bibkey = `OLID:${candidate.olid}`;
        const bookData = data[bibkey];

        // ALWAYS-ON: Debug author flow
        console.log(`[OpenLibrary] Enriching ${bibkey}: candidate.authors=${JSON.stringify(candidate.authors)}, bookData.authors=${JSON.stringify(bookData?.authors)}`);

        if (bookData) {
          // Extract ISBNs from enriched data
          const isbn13 = bookData.identifiers?.isbn_13?.[0];
          const isbn10 = bookData.identifiers?.isbn_10?.[0];

          const resolved: ResolvedBook = {
            title: bookData.title || candidate.title || '',
            authors: bookData.authors?.map((a) => a.name) || candidate.authors || [],
            isbn13: isbn13 ? normalizeIsbn(isbn13) : undefined,
            isbn10: isbn10 ? normalizeIsbn(isbn10) : undefined,
            publisher: bookData.publishers?.[0]?.name,
            publishYear: extractYear(bookData.publish_date) || candidate.publishYear,
            coverUrl: bookData.cover?.medium || bookData.cover?.small || candidate.coverUrl,
            source: 'openLibrary',
            sourceId: candidate.olid,
          };

          // ALWAYS-ON: Log final resolved book with authors
          console.log(`[OpenLibrary] Enriched "${resolved.title}" authors=${JSON.stringify(resolved.authors)} isbn13=${resolved.isbn13}`);

          results.push(resolved);
        } else {
          // No enrichment data - use candidate info
          results.push({
            title: candidate.title || '',
            authors: candidate.authors || [],
            publishYear: candidate.publishYear,
            coverUrl: candidate.coverUrl,
            source: 'openLibrary',
            sourceId: candidate.olid,
          });
        }
      }

      return results;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn('[OpenLibrary] Books API batch request timed out');
      } else {
        console.warn(`[OpenLibrary] Books API batch error: ${error.message}`);
      }
      // Fall back to candidates without ISBN enrichment
      return this.candidatesToResolvedBooks(candidates);
    }
  }

  /**
   * Convert candidates to ResolvedBook without ISBN enrichment (fallback)
   */
  private candidatesToResolvedBooks(candidates: EnrichmentCandidate[]): ResolvedBook[] {
    return candidates.map((c) => ({
      title: c.title || '',
      authors: c.authors || [],
      publishYear: c.publishYear,
      coverUrl: c.coverUrl,
      source: 'openLibrary' as const,
      sourceId: c.olid,
    }));
  }

  /**
   * Check if Open Library is reachable
   */
  async checkAvailability(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${OPEN_LIBRARY_SEARCH}?q=test&limit=1`,
        5000
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Search by evidence lines using hypothesis generation and scoring
   *
   * This is the core evidence-driven resolution method. It:
   * 1. Builds evidence tokens from merged OCR lines
   * 2. Generates multiple search hypotheses (max 5 for pass1, max 12 for pass2)
   * 3. Runs searches for each hypothesis (max 10 results each)
   * 4. Scores and ranks all candidates against evidence
   * 5. Returns scored candidates with decision
   *
   * Rate-limit safety:
   * - Max 5 hypotheses per crop (pass1), max 12 (pass2)
   * - Max 10 results per hypothesis
   * - In-memory query cache to avoid duplicate requests
   * - Capped enrichment calls per session
   *
   * @param evidenceLines - Raw text lines from merged OCR evidence
   * @param ocrTitle - OCR-extracted title (used as fallback only)
   * @param ocrAuthor - OCR-extracted author (used as fallback only)
   * @param pass - Which pass (1 = initial, 2 = boost). Default 1.
   * @param excludeQueries - Queries already tried (for pass 2 deduplication)
   * @param debugContext - Debug context for logging
   * @param sourceKind - Evidence source kind for ISBN policy (default: 'spine_crop')
   */
  async searchByEvidence(
    evidenceLines: string[],
    ocrTitle?: string | null,
    ocrAuthor?: string | null,
    pass: 1 | 2 = 1,
    excludeQueries?: Set<string>,
    debugContext?: HypothesisDebugContext,
    sourceKind: EvidenceSourceKind = 'spine_crop'
  ): Promise<EvidenceSearchResult> {
    const startTime = Date.now();
    const candidateLabel = debugContext?.candidateId ? ` candidateId="${debugContext.candidateId}"` : '';
    const verbose = shouldLogVerbose();
    if (verbose) {
      console.log(`[OpenLibrary] searchByEvidence START lines=${evidenceLines.length}${candidateLabel}`);
    }

    // Build evidence tokens with source-aware ISBN extraction
    // For spine_crop: Skip ISBN extraction (spine OCR produces unreliable ISBNs)
    // For back_cover/inside_page: Extract ISBNs for lookup/boost
    const evidenceTokens = buildEvidenceTokens(evidenceLines, { sourceKind });

    if (verbose) {
      console.log(`[OpenLibrary] Evidence: ${evidenceTokens.tokensSet.size} tokens, ${evidenceTokens.cleanedLines.length} cleaned lines`);
      console.log(`[OpenLibrary] Person names: ${evidenceTokens.personNameLines.join(', ') || 'none'}`);
      console.log(`[OpenLibrary] Title-like: ${evidenceTokens.titleLikeLines.join(', ') || 'none'}`);
      console.log(`[OpenLibrary] ISBNs: ${evidenceTokens.isbns.join(', ') || 'none'}`);
    }

    // Generate hypotheses based on pass
    let hypothesisResult: HypothesisGenerationResult;
    if (pass === 1) {
      // Pass 1: Standard hypothesis generation (max 5)
      hypothesisResult = generateHypotheses(evidenceLines, ocrTitle, ocrAuthor, debugContext);
    } else {
      // Pass 2: Boost hypothesis generation (max 12, excluding already tried queries)
      hypothesisResult = generateBoostHypotheses(
        evidenceLines,
        excludeQueries || new Set(),
        ocrTitle,
        ocrAuthor,
        debugContext
      );
    }
    const hypotheses = hypothesisResult.hypotheses;

    // ALWAYS-ON: Log hypotheses for debugging resolution issues
    console.log(`[OpenLibrary] Pass ${pass}: Generated ${hypotheses.length} hypotheses`);
    for (const h of hypotheses) {
      console.log(`[OpenLibrary]   [${h.priority}] ${h.type}: "${h.query}"`);
    }

    // Collect all candidates from all hypotheses
    const allCandidates: ResolvedBook[] = [];
    const seenOlids = new Set<string>();
    const hypothesisResults: HypothesisSearchResult[] = [];

    let hypothesisIndex = 0;
    for (const hypothesis of hypotheses) {
      const currentIndex = hypothesisIndex++;
      // Build cache key
      const queryHash = buildQueryHash(
        hypothesis.type === 'isbn' ? 'isbn' : 'text',
        hypothesis.query
      );

      try {
        let results: ResolvedBook[] = [];

        // Check cache first
        const cachedResults = getCachedResults(queryHash);
        if (cachedResults) {
          results = cachedResults;
          if (verbose) {
            console.log(`[OpenLibrary] CACHE HIT for "${hypothesis.query}": ${results.length} results`);
          }
        } else {
          // Cache miss - make API call
          if (hypothesis.type === 'isbn') {
            // Direct ISBN search
            results = await this.searchByIsbn(hypothesis.query);
          } else {
            // Text search with max results limit
            const candidates = await this.searchByQuery(hypothesis.query, MAX_RESULTS_PER_HYPOTHESIS);

            // Enrich to ISBN if we haven't exceeded session limit
            if (candidates.length > 0 && sessionEnrichmentCalls < MAX_ENRICHMENT_CALLS) {
              sessionEnrichmentCalls++;
              results = await this.enrichToISBN(candidates);
            } else if (candidates.length > 0) {
              // Skip enrichment, use candidates as-is
              results = this.candidatesToResolvedBooks(candidates);
              if (verbose) {
                console.log(`[OpenLibrary] Skipping enrichment (limit reached: ${sessionEnrichmentCalls}/${MAX_ENRICHMENT_CALLS})`);
              }
            }
          }

          // Cache results
          cacheResults(queryHash, results);
        }

        hypothesisResults.push({
          hypothesis,
          resultCount: results.length,
          results: results.slice(0, 3), // Keep top 3 for debugging
          pass,
        });

        // ALWAYS-ON: Log results for each hypothesis
        console.log(
          `[OpenLibrary] hypothesis=${currentIndex + 1}/${hypotheses.length} type=${hypothesis.type} query="${hypothesis.query}" results=${results.length}`
        );
        if (results.length > 0) {
          console.log(`[OpenLibrary]   top result: "${results[0].title}" by ${results[0].authors?.join(', ') || 'unknown'}`);
        }

        // Dedupe by OLID
        for (const result of results) {
          if (result.sourceId && !seenOlids.has(result.sourceId)) {
            seenOlids.add(result.sourceId);
            allCandidates.push(result);
          }
        }
      } catch (e: any) {
        console.warn(`[OpenLibrary] Hypothesis "${hypothesis.query}" failed: ${e.message}`);
        hypothesisResults.push({
          hypothesis,
          resultCount: 0,
          error: e.message,
          pass,
        });
      }
    }

    // Open Library can miss badly misread titles ("Hasir Misalest") that our own catalog
    // still matches by trigram similarity; scoring and gates below still decide.
    if (allCandidates.length === 0) {
      const fallbackQueries = [
        ...new Set(hypotheses.filter((h) => h.type !== 'isbn').map((h) => h.query)),
      ].slice(0, CATALOG_FALLBACK_QUERY_LIMIT);
      for (const query of fallbackQueries) {
        const catalogResults = await searchCatalog(query, 5);
        for (const result of catalogResults) {
          if (result.sourceId && !seenOlids.has(result.sourceId)) {
            seenOlids.add(result.sourceId);
            allCandidates.push({ ...result, fromCatalogFallback: true });
          }
        }
      }
      if (allCandidates.length > 0) {
        console.log(
          `[OpenLibrary] Catalog fallback found ${allCandidates.length} candidates${candidateLabel}`
        );
      }
    }

    // Build ISBN policy debug info
    const validIsbns = evidenceTokens.isbns.filter((isbn) => validateIsbnChecksum(isbn));
    const isbnPolicy = determineIsbnPolicy(
      sourceKind,
      validIsbns.map((isbn) => ({
        raw: isbn,
        normalized: isbn,
        type: isbn.length === 10 ? 'isbn10' as const : 'isbn13' as const,
        checksumValid: true,
      }))
    );
    const isbnPolicyDebug: IsbnPolicyDebugInfo = {
      sourceKind,
      policyApplied: isbnPolicy,
      candidatesRaw: evidenceTokens.isbns,
      candidatesValid: validIsbns,
      usedForScoring: shouldApplyIsbnBoost(isbnPolicy),
      isbnMatchedTopCandidate: false, // Will be updated if we have a top candidate
    };

    if (allCandidates.length === 0) {
      if (verbose) {
        console.log(`[OpenLibrary] searchByEvidence END pass=${pass} no candidates ms=${Date.now() - startTime}`);
      }
      return {
        decision: 'reject',
        scoredCandidates: [],
        topCandidate: null,
        reviewCandidates: [],
        scoreGap: 0,
        reason: 'No candidates found from any hypothesis',
        evidenceTokens,
        hypotheses: hypothesisResult,
        hypothesisResults,
        searchTimeMs: Date.now() - startTime,
        passUsed: pass,
        queriesTriedCount: hypotheses.length,
        boostTriggered: pass === 2,
        manualReview: false,
        isbnPolicy: isbnPolicyDebug,
      };
    }

    // Score and rank candidates with source-aware ISBN policy
    // sourceKind determines whether ISBN is used for scoring:
    // - spine_crop: ISBN is noise, never used for scoring boost
    // - back_cover/inside_page: Valid ISBN match adds boost
    const scoredCandidates = scoreAndRankCandidates(allCandidates, evidenceTokens, {
      sourceKind,
    });

    if (verbose) {
      console.log(`[OpenLibrary] Scored ${scoredCandidates.length} candidates:`);
      for (const sc of scoredCandidates.slice(0, 5)) {
        console.log(`[OpenLibrary]   ${sc.scoring.score.toFixed(3)} "${sc.book.title}" by ${sc.book.authors?.join(', ') || 'unknown'}`);
      }
    }

    // Make decision (isAfterBoostPass=true only for pass 2)
    const isAfterBoostPass = pass === 2;
    const gateDebug = {
      ...debugContext,
      rawLines: evidenceLines,
      normalizedLines: evidenceTokens.cleanedLines,
      bestAuthorCandidate: evidenceTokens.recoveredAuthorCandidates[0]?.line,
      bestAuthorConfidence: evidenceTokens.bestAuthorConfidence,
      advancedExtraction: evidenceTokens.advancedExtraction ? {
        title: evidenceTokens.advancedExtraction.title,
        author: evidenceTokens.advancedExtraction.author,
        titleConfidence: evidenceTokens.advancedExtraction.titleConfidence,
        authorConfidence: evidenceTokens.advancedExtraction.authorConfidence,
      } : undefined,
    };
    const decisionResult = makeDecisionFromScores(scoredCandidates, isAfterBoostPass, gateDebug);

    // Get top scoring for logging and ISBN policy debug
    const topScoring = decisionResult.topCandidate?.scoring;

    // Enhanced instrumentation logging (verbose only to reduce spam)
    if (verbose) {
      console.log(`[OpenLibrary] searchByEvidence END ${candidateLabel} pass=${pass} decision=${decisionResult.decision} ` +
        `topScore=${topScoring?.score.toFixed(3) || 'N/A'} ` +
        `overlap=${topScoring?.overlapCount ?? 'N/A'} ` +
        `gap=${decisionResult.scoreGap.toFixed(3)} ` +
        `isbn=${topScoring?.isbnMatched ? 'yes' : 'no'} ` +
        `candidates=${allCandidates.length} ` +
        `hypotheses=${hypotheses.length} ` +
        `ms=${Date.now() - startTime}`);
    }

    // Update ISBN policy debug with top candidate match info
    isbnPolicyDebug.isbnMatchedTopCandidate = topScoring?.isbnMatched ?? false;

    return {
      decision: decisionResult.decision,
      scoredCandidates,
      topCandidate: decisionResult.topCandidate,
      reviewCandidates: decisionResult.reviewCandidates,
      scoreGap: decisionResult.scoreGap,
      reason: decisionResult.reason,
      evidenceTokens,
      hypotheses: hypothesisResult,
      hypothesisResults,
      searchTimeMs: Date.now() - startTime,
      passUsed: pass,
      queriesTriedCount: hypotheses.length,
      boostTriggered: pass === 2,
      manualReview: decisionResult.manualReview,
      isbnPolicy: isbnPolicyDebug,
    };
  }
}

// ============================================================================
// Evidence Search Types
// ============================================================================

/**
 * Result from hypothesis-based search
 */
export interface HypothesisSearchResult {
  hypothesis: SearchHypothesis;
  resultCount: number;
  results?: ResolvedBook[];
  error?: string;
  /** Which pass this result came from (1 = initial, 2 = boost) */
  pass: 1 | 2;
}

/**
 * ISBN policy debug info for evidence search
 */
export interface IsbnPolicyDebugInfo {
  /** Source kind that determined the policy */
  sourceKind: EvidenceSourceKind;
  /** Policy that was applied */
  policyApplied: 'ignore' | 'boost_only' | 'lookup_first';
  /** Raw ISBN-like strings found in evidence */
  candidatesRaw: string[];
  /** Valid ISBN candidates (checksum passed) */
  candidatesValid: string[];
  /** Whether ISBN was used for scoring boost */
  usedForScoring: boolean;
  /** Whether ISBN match was found with top candidate */
  isbnMatchedTopCandidate: boolean;
}

/**
 * Full result from evidence-driven search
 */
export interface EvidenceSearchResult {
  /** Final decision: accept_high, accept_medium, suggested, or reject */
  decision: ScoringDecision;
  /** All scored candidates (sorted by score) */
  scoredCandidates: ScoredCandidate[];
  /** Top candidate (may be null if no results) */
  topCandidate: ScoredCandidate | null;
  /** Alternative candidates for suggested (if decision is suggested) */
  reviewCandidates: ScoredCandidate[];
  /** Gap between top and second candidate scores */
  scoreGap: number;
  /** Human-readable reason for the decision */
  reason: string;
  /** Processed evidence tokens */
  evidenceTokens: EvidenceTokens;
  /** Generated hypotheses */
  hypotheses: HypothesisGenerationResult;
  /** Results per hypothesis (for debugging) */
  hypothesisResults: HypothesisSearchResult[];
  /** Total search time in ms */
  searchTimeMs: number;
  /** Which pass produced this result (1 = initial, 2 = boost) */
  passUsed: 1 | 2;
  /** Decision from pass 1 (before boost) */
  pass1Decision?: ScoringDecision;
  /** Number of queries tried across all passes */
  queriesTriedCount: number;
  /** Whether boost pass was triggered */
  boostTriggered: boolean;
  /** Whether this should trigger manual review (ambiguity only) */
  manualReview?: boolean;
  /** ISBN policy debug info */
  isbnPolicy?: IsbnPolicyDebugInfo;
}

// ============================================================================
// Resolver Cache Integration
// ============================================================================

/**
 * Build resolver_key for a resolved book
 * Format: "openlibrary:<OLID>" or "isbn:<isbn13>"
 */
export function buildResolverKey(book: ResolvedBook): string {
  if (book.source === 'openLibrary' && book.sourceId) {
    return `openlibrary:${book.sourceId}`;
  }
  if (book.isbn13) {
    return `isbn:${book.isbn13}`;
  }
  if (book.isbn10) {
    return `isbn:${book.isbn10}`;
  }
  // Fallback to source:id format
  return `${book.source}:${book.sourceId || 'unknown'}`;
}

/**
 * Build cache key hash for resolver_cache
 */
export function buildQueryHash(queryType: 'text' | 'isbn', query: string): string {
  // Simple hash using FNV-1a
  let hash = 2166136261;
  const normalized = `${queryType}:${query.toLowerCase().trim()}`;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16);
}

// ============================================================================
// Debug / Smoke Test
// ============================================================================

/**
 * Smoke test: Resolve "The Shining Stephen King" and verify ISBN returned
 */
export async function testOpenLibraryIsbnResolution(): Promise<{
  success: boolean;
  book?: ResolvedBook;
  hasIsbn: boolean;
  error?: string;
}> {
  const provider = new OpenLibraryProvider();
  const testQuery = 'The Shining Stephen King';

  console.log('[OpenLibrary] Running smoke test with query:', testQuery);

  try {
    const results = await provider.searchByText(testQuery);

    if (results.length === 0) {
      return {
        success: false,
        hasIsbn: false,
        error: 'No results returned',
      };
    }

    const firstResult = results[0];
    const hasIsbn = !!(firstResult.isbn13 || firstResult.isbn10);

    console.log('[OpenLibrary] Smoke test result:', {
      title: firstResult.title,
      isbn13: firstResult.isbn13,
      isbn10: firstResult.isbn10,
      hasIsbn,
    });

    return {
      success: true,
      book: firstResult,
      hasIsbn,
    };
  } catch (error: any) {
    console.error('[OpenLibrary] Smoke test error:', error);
    return {
      success: false,
      hasIsbn: false,
      error: error.message,
    };
  }
}
