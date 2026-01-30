/**
 * Supabase Capabilities Service
 *
 * Probes the hosted Supabase DB to detect available schema features.
 * Provides runtime fallback when schema updates haven't been applied.
 *
 * ALWAYS-ON logging for all probes and capability changes.
 */

import { getSupabaseClient, isSupabaseConfigured } from '../config/supabase';

// ============================================================================
// Types
// ============================================================================

export interface SupabaseCapabilities {
  /** Whether books_catalog.resolver_key column exists */
  supportsResolverKey: boolean;
  /** Last probe timestamp */
  probedAt: number;
  /** Last probe error (if any) */
  lastError?: {
    code: string;
    message: string;
  };
}

export interface ProbeResult {
  success: boolean;
  supportsResolverKey: boolean;
  error?: {
    code: string;
    message: string;
  };
}

// ============================================================================
// In-Memory Cache
// ============================================================================

let cachedCapabilities: SupabaseCapabilities | null = null;

// Cache TTL: 5 minutes (probe again if stale)
const CACHE_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// Probe Functions
// ============================================================================

/**
 * Probe books_catalog to check if resolver_key column exists.
 *
 * Uses a minimal query: SELECT resolver_key FROM books_catalog LIMIT 1
 * If PGRST204 error is returned, column doesn't exist (or schema cache stale).
 *
 * ALWAYS logs probe attempt and result.
 */
export async function probeResolverKeySupport(): Promise<ProbeResult> {
  console.log('[SupabaseCapabilities] Probing resolver_key support...');

  if (!isSupabaseConfigured()) {
    console.log('[SupabaseCapabilities] Supabase not configured');
    return {
      success: false,
      supportsResolverKey: false,
      error: { code: 'NOT_CONFIGURED', message: 'Supabase not configured' },
    };
  }

  const client = getSupabaseClient();
  if (!client) {
    console.log('[SupabaseCapabilities] Failed to get client');
    return {
      success: false,
      supportsResolverKey: false,
      error: { code: 'NO_CLIENT', message: 'Failed to get Supabase client' },
    };
  }

  try {
    // Probe: try to select resolver_key column
    const { data, error } = await client
      .from('books_catalog')
      .select('resolver_key')
      .limit(1);

    if (error) {
      // Check for PGRST204 or similar schema cache errors
      const isPGRST204 = error.code === 'PGRST204' ||
        error.message?.includes('Could not find') ||
        error.message?.includes('resolver_key');

      if (isPGRST204) {
        console.log(`[SupabaseCapabilities] resolver_key NOT available: ${error.code} - ${error.message}`);
        return {
          success: true,
          supportsResolverKey: false,
          error: { code: error.code || 'UNKNOWN', message: error.message },
        };
      }

      // Other error (network, auth, etc.)
      console.log(`[SupabaseCapabilities] Probe error: ${error.code} - ${error.message}`);
      return {
        success: false,
        supportsResolverKey: false,
        error: { code: error.code || 'UNKNOWN', message: error.message },
      };
    }

    // No error = column exists
    console.log('[SupabaseCapabilities] resolver_key IS available');
    return {
      success: true,
      supportsResolverKey: true,
    };
  } catch (e: any) {
    console.log(`[SupabaseCapabilities] Probe exception: ${e.message}`);
    return {
      success: false,
      supportsResolverKey: false,
      error: { code: 'EXCEPTION', message: e.message || 'Unknown exception' },
    };
  }
}

/**
 * Get cached capabilities or probe if cache is stale/missing.
 *
 * ALWAYS logs cache hits/misses.
 */
export async function getCapabilities(forceRefresh = false): Promise<SupabaseCapabilities> {
  const now = Date.now();

  // Return cached if fresh
  if (!forceRefresh && cachedCapabilities) {
    const age = now - cachedCapabilities.probedAt;
    if (age < CACHE_TTL_MS) {
      console.log(`[SupabaseCapabilities] Using cached (age=${Math.round(age / 1000)}s) supportsResolverKey=${cachedCapabilities.supportsResolverKey}`);
      return cachedCapabilities;
    }
    console.log('[SupabaseCapabilities] Cache stale, re-probing...');
  } else if (forceRefresh) {
    console.log('[SupabaseCapabilities] Force refresh requested');
  } else {
    console.log('[SupabaseCapabilities] No cache, probing...');
  }

  // Probe
  const result = await probeResolverKeySupport();

  // Update cache
  cachedCapabilities = {
    supportsResolverKey: result.supportsResolverKey,
    probedAt: now,
    lastError: result.error,
  };

  console.log(`[SupabaseCapabilities] Cached: supportsResolverKey=${cachedCapabilities.supportsResolverKey}`);
  return cachedCapabilities;
}

/**
 * Get cached capabilities synchronously (may be null if never probed).
 */
export function getCachedCapabilities(): SupabaseCapabilities | null {
  return cachedCapabilities;
}

/**
 * Check if resolver_key is supported (uses cache, non-blocking).
 * Returns false if not yet probed.
 */
export function supportsResolverKey(): boolean {
  return cachedCapabilities?.supportsResolverKey ?? false;
}

/**
 * Clear the capabilities cache (useful for testing or after schema update).
 */
export function clearCapabilitiesCache(): void {
  console.log('[SupabaseCapabilities] Cache cleared');
  cachedCapabilities = null;
}
