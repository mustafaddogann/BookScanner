/**
 * Books Catalog Service
 * Gate 9 Extension: Persistent Book Identity
 *
 * Provides upsert operations for the books_catalog table.
 * Only stores books that are auto-accepted or user-confirmed.
 *
 * IMPORTANT: All writes are logged with full error details.
 */

import { getSupabaseClient, isSupabaseConfigured } from '../config/supabase';
import type { ResolvedBook, BookCandidate } from '../types';
import { isMetadataVerboseDebug } from '../config/debug';
import { useDebugStore } from '../store/useDebugStore';
import { buildResolverKey } from './openLibraryProvider';
import { getCapabilities, supportsResolverKey as checkResolverKeySupport } from './supabaseCapabilities';

/**
 * Check if verbose diagnostics logging should be enabled.
 * Requires: __DEV__ && diagnosticsEnabled
 */
function shouldLogVerbose(): boolean {
  const diagnosticsEnabled = useDebugStore.getState().diagnosticsEnabled;
  return __DEV__ && diagnosticsEnabled;
}

// ============================================================================
// Types
// ============================================================================

export interface UpsertBookResult {
  success: boolean;
  bookId?: string;
  error?: string;
  details?: unknown;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Upsert a resolved book into books_catalog and return the stable bookId.
 *
 * Uses provider + provider_id as the canonical unique key.
 * Only call this for auto-accepted or user-confirmed matches.
 *
 * ALWAYS logs: payload and result (success or error).
 *
 * @param resolved - The resolved book metadata
 * @returns The stable bookId from books_catalog, or error if failed
 */
export async function upsertResolvedBook(
  resolved: ResolvedBook
): Promise<UpsertBookResult> {
  // Guard: Check if Supabase is configured
  if (!isSupabaseConfigured()) {
    console.log('[BooksCatalog] Supabase not configured, skipping upsert');
    return {
      success: false,
      error: 'Supabase not configured',
    };
  }

  // Guard: Must have provider source and ID
  if (!resolved.source || resolved.source === 'manual' || resolved.source === 'ocr') {
    console.log(`[BooksCatalog] Skipping upsert for source: ${resolved.source}`);
    return {
      success: false,
      error: `Invalid source for catalog: ${resolved.source}`,
    };
  }

  if (!resolved.sourceId) {
    console.log('[BooksCatalog] Skipping upsert - no sourceId');
    return {
      success: false,
      error: 'No sourceId available',
    };
  }

  const client = getSupabaseClient();
  if (!client) {
    console.error('[BooksCatalog] Failed to get Supabase client');
    return {
      success: false,
      error: 'Failed to get Supabase client',
    };
  }

  // Check capabilities to determine upsert mode
  const capabilities = await getCapabilities();
  const useResolverKey = capabilities.supportsResolverKey;

  // Build resolver_key for canonical identification
  const resolverKey = buildResolverKey(resolved);

  // Build payload based on capabilities
  const basePayload = {
    provider: resolved.source, // 'openLibrary' | 'googleBooks'
    provider_id: resolved.sourceId,
    title: resolved.title,
    authors: resolved.authors || [],
    isbn13: resolved.isbn13 || null,
    isbn10: resolved.isbn10 || null,
    publisher: resolved.publisher || null,
    publish_year: resolved.publishYear || null,
    cover_url: resolved.coverUrl || null,
  };

  // Include resolver_key only if supported
  const payload = useResolverKey
    ? { ...basePayload, resolver_key: resolverKey }
    : basePayload;

  // Determine conflict target based on capabilities
  const conflictTarget = useResolverKey ? 'resolver_key' : 'provider,provider_id';
  const upsertMode = useResolverKey ? 'resolver_key' : 'legacy';

  // ALWAYS-ON: Log upsert attempt with mode
  console.log(`[BooksCatalog] upsert START mode=${upsertMode} resolver_key="${resolverKey}" title="${resolved.title}"`);

  // Verbose: Full payload when diagnostics enabled
  if (shouldLogVerbose()) {
    console.log('[BooksCatalog] upsert payload:', JSON.stringify(payload, null, 2));
  }

  try {
    // Use upsert with appropriate conflict target
    const { data, error, status, statusText } = await client
      .from('books_catalog')
      .upsert(payload, {
        onConflict: conflictTarget,
        ignoreDuplicates: false,
      })
      .select('id')
      .single();

    // Log result when diagnostics enabled
    if (shouldLogVerbose()) {
      console.log('[BooksCatalog] upsert result:', {
        status,
        statusText,
        error: error ? { message: error.message, code: error.code, details: error.details, hint: error.hint } : null,
        data,
      });
    }

    if (error) {
      // ALWAYS-ON: Log upsert failure with full error details
      console.error(`[BooksCatalog] upsert FAIL mode=${upsertMode} resolver_key="${resolverKey}" error="${error.message}" code=${error.code} details=${JSON.stringify(error.details)} hint=${error.hint}`);
      return {
        success: false,
        error: error.message,
        details: { code: error.code, details: error.details, hint: error.hint, mode: upsertMode },
      };
    }

    const bookId = data?.id as string;
    // ALWAYS-ON: Log upsert success
    console.log(`[BooksCatalog] upsert SUCCESS mode=${upsertMode} resolver_key="${resolverKey}" id=${bookId}`);

    return {
      success: true,
      bookId,
    };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[BooksCatalog] Upsert EXCEPTION:', e);
    return {
      success: false,
      error: errorMsg,
      details: e,
    };
  }
}

/**
 * Get a book from catalog by its stable bookId.
 */
export async function getBookById(
  bookId: string
): Promise<ResolvedBook | null> {
  if (!isSupabaseConfigured()) {
    return null;
  }

  const client = getSupabaseClient();
  if (!client) {
    return null;
  }

  try {
    const { data, error } = await client
      .from('books_catalog')
      .select('*')
      .eq('id', bookId)
      .single();

    if (error || !data) {
      console.log('[BooksCatalog] getBookById not found:', bookId, error?.message);
      return null;
    }

    return {
      title: data.title,
      authors: data.authors || [],
      isbn13: data.isbn13,
      isbn10: data.isbn10,
      publisher: data.publisher,
      publishYear: data.publish_year,
      coverUrl: data.cover_url,
      source: data.provider as 'openLibrary' | 'googleBooks',
      sourceId: data.provider_id,
      bookId: data.id,
    };
  } catch (e) {
    console.error('[BooksCatalog] getBookById exception:', e);
    return null;
  }
}

/**
 * Look up a book by ISBN (13 or 10).
 */
export async function getBookByIsbn(
  isbn: string
): Promise<ResolvedBook | null> {
  if (!isSupabaseConfigured()) {
    return null;
  }

  const client = getSupabaseClient();
  if (!client) {
    return null;
  }

  try {
    const column = isbn.length === 13 ? 'isbn13' : 'isbn10';

    const { data, error } = await client
      .from('books_catalog')
      .select('*')
      .eq(column, isbn)
      .single();

    if (error || !data) {
      return null;
    }

    return {
      title: data.title,
      authors: data.authors || [],
      isbn13: data.isbn13,
      isbn10: data.isbn10,
      publisher: data.publisher,
      publishYear: data.publish_year,
      coverUrl: data.cover_url,
      source: data.provider as 'openLibrary' | 'googleBooks',
      sourceId: data.provider_id,
      bookId: data.id,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// User Selection Hook
// ============================================================================

export interface ConfirmSelectionResult {
  success: boolean;
  bookId?: string;
  updatedBook?: ResolvedBook;
  error?: string;
}

/**
 * Confirm a user's selection from suggestions/ambiguous matches.
 */
export async function confirmUserSelection(
  selectedBook: ResolvedBook,
  candidateId?: string
): Promise<ConfirmSelectionResult> {
  console.log(`[BooksCatalog] User confirmed selection: "${selectedBook.title}"${candidateId ? ` (candidate: ${candidateId})` : ''}`);

  const result = await upsertResolvedBook(selectedBook);

  if (!result.success) {
    console.error('[BooksCatalog] confirmUserSelection FAILED:', result.error);
    return {
      success: false,
      error: result.error,
    };
  }

  const updatedBook: ResolvedBook = {
    ...selectedBook,
    bookId: result.bookId,
  };

  console.log(`[BooksCatalog] Selection confirmed, bookId: ${result.bookId}`);

  return {
    success: true,
    bookId: result.bookId,
    updatedBook,
  };
}

/**
 * Update a BookCandidate with a user-selected book.
 */
export async function applyUserSelectionToCandidate(
  candidate: BookCandidate,
  selectedBook: ResolvedBook
): Promise<BookCandidate> {
  const result = await confirmUserSelection(selectedBook, candidate.id);

  if (result.success && result.updatedBook) {
    return {
      ...candidate,
      resolvedBook: result.updatedBook,
      resolvedConfidence: 1.0,
      resolverDecision: 'accept',
    };
  }

  // If catalog upsert failed, still apply the selection (just without bookId)
  return {
    ...candidate,
    resolvedBook: selectedBook,
    resolvedConfidence: 1.0,
    resolverDecision: 'accept',
  };
}

// ============================================================================
// Debug/Smoke Test
// ============================================================================

/**
 * Test write to books_catalog with a dummy record.
 * Use this to verify DB connectivity without the full pipeline.
 */
export async function testBooksCatalogWrite(): Promise<UpsertBookResult> {
  const testBook: ResolvedBook = {
    title: `Debug Test Book ${Date.now()}`,
    authors: ['Debug Author'],
    source: 'openLibrary',
    sourceId: `debug_${Date.now()}`,
    isbn13: undefined,
    isbn10: undefined,
  };

  console.log('[BooksCatalog] Running smoke test write...');
  const result = await upsertResolvedBook(testBook);
  console.log('[BooksCatalog] Smoke test result:', result);
  return result;
}
