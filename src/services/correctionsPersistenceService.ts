/**
 * Corrections Persistence Service
 * Gate 10 Extension: Supabase Sync for User Corrections
 *
 * Syncs local corrections (stored in Zustand/MMKV) to Supabase's user_corrections table.
 *
 * IMPORTANT: All writes are logged with full error details.
 */

import { getSupabaseClient, isSupabaseConfigured } from '../config/supabase';
import type { Correction, CorrectionKey, BookCandidate } from '../types';
import { getCorrectionKey } from './correctionsMemory';
import { useDebugStore } from '../store/useDebugStore';

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

export interface PersistCorrectionResult {
  success: boolean;
  correctionId?: string;
  error?: string;
  details?: unknown;
}

interface UserCorrectionPayload {
  // One of these must be set (enforced by DB constraint)
  resolver_key: string | null;
  evidence_hash: string | null;

  // Corrected values
  corrected_title: string | null;
  corrected_authors: string[] | null;

  // Original values (for audit trail)
  original_title: string | null;
  original_authors: string[] | null;

  // Context
  session_id: string | null;
  candidate_id: string | null;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Persist a correction to Supabase's user_corrections table.
 *
 * ALWAYS logs: payload and result (success or error).
 *
 * @param correction - The correction data to persist
 * @param key - The correction key (isbn:xxx or hash:xxx)
 * @param sessionId - Optional session ID for context
 * @param candidateId - Optional candidate ID for context
 * @returns The correction ID from Supabase, or error if failed
 */
export async function persistCorrection(
  correction: Correction,
  key: CorrectionKey,
  sessionId?: string,
  candidateId?: string
): Promise<PersistCorrectionResult> {
  // Guard: Check if Supabase is configured
  if (!isSupabaseConfigured()) {
    console.log('[CorrectionsPersistence] Supabase not configured, skipping persist');
    return {
      success: false,
      error: 'Supabase not configured',
    };
  }

  const client = getSupabaseClient();
  if (!client) {
    console.error('[CorrectionsPersistence] Failed to get Supabase client');
    return {
      success: false,
      error: 'Failed to get Supabase client',
    };
  }

  // Parse key to determine resolver_key vs evidence_hash
  // Key format: "isbn:xxxxx" or "hash:xxxxx"
  let resolverKey: string | null = null;
  let evidenceHash: string | null = null;

  if (key.startsWith('isbn:')) {
    // If we have an ISBN, use it as resolver_key format
    // If we also have source info from the resolved book, include it
    resolverKey = key; // e.g., "isbn:9780743273565"
    evidenceHash = correction.contentHash || null; // Still include hash for backup
  } else if (key.startsWith('hash:')) {
    // Only have evidence hash, no resolver key
    evidenceHash = key.substring(5); // Remove "hash:" prefix
  } else {
    // Unknown key format, use the whole thing as evidence_hash
    evidenceHash = key;
  }

  // Build payload - ensure constraint is satisfied
  // Constraint: (resolver_key IS NOT NULL OR evidence_hash IS NOT NULL)
  if (!resolverKey && !evidenceHash) {
    console.error('[CorrectionsPersistence] Cannot persist: no resolver_key or evidence_hash');
    return {
      success: false,
      error: 'No key available for persistence',
    };
  }

  const payload: UserCorrectionPayload = {
    resolver_key: resolverKey,
    evidence_hash: evidenceHash,
    corrected_title: correction.correctedTitle,
    corrected_authors: correction.correctedAuthor ? [correction.correctedAuthor] : null,
    original_title: correction.originalTitle,
    original_authors: correction.originalAuthor ? [correction.originalAuthor] : null,
    session_id: sessionId || null,
    candidate_id: candidateId || null,
  };

  // Log payload when diagnostics enabled
  if (shouldLogVerbose()) {
    console.log('[CorrectionsPersistence] upsert payload:', JSON.stringify(payload, null, 2));
  }

  try {
    // Use upsert with resolver_key or evidence_hash as conflict target
    // We'll insert and let the DB handle conflicts via unique index
    const { data, error, status, statusText } = await client
      .from('user_corrections')
      .insert(payload)
      .select('id')
      .single();

    // Log result when diagnostics enabled
    if (shouldLogVerbose()) {
      console.log('[CorrectionsPersistence] insert result:', {
        status,
        statusText,
        error: error
          ? { message: error.message, code: error.code, details: error.details, hint: error.hint }
          : null,
        data,
      });
    }

    if (error) {
      // Always log errors
      console.error('[CorrectionsPersistence] Insert FAILED:', error);
      return {
        success: false,
        error: error.message,
        details: { code: error.code, details: error.details, hint: error.hint },
      };
    }

    const correctionId = data?.id as string;
    if (shouldLogVerbose()) {
      console.log(`[CorrectionsPersistence] Insert SUCCESS, correctionId: ${correctionId}`);
    }

    return {
      success: true,
      correctionId,
    };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[CorrectionsPersistence] Insert EXCEPTION:', e);
    return {
      success: false,
      error: errorMsg,
      details: e,
    };
  }
}

/**
 * Persist a correction for a book candidate.
 * Convenience function that extracts the key from the candidate.
 */
export async function persistCorrectionForCandidate(
  candidate: BookCandidate,
  correction: Correction,
  sessionId?: string
): Promise<PersistCorrectionResult> {
  const key = getCorrectionKey(candidate);
  return persistCorrection(correction, key, sessionId, candidate.id);
}

// ============================================================================
// Debug/Smoke Test
// ============================================================================

/**
 * Test write to user_corrections with a dummy record.
 * Use this to verify DB connectivity without the full pipeline.
 */
export async function testUserCorrectionsWrite(): Promise<PersistCorrectionResult> {
  const testCorrection: Correction = {
    contentHash: `test_hash_${Date.now()}`,
    isbn: null,
    correctedTitle: `Debug Test Title ${Date.now()}`,
    correctedAuthor: 'Debug Author',
    originalTitle: 'Original Test Title',
    originalAuthor: 'Original Author',
    createdAt: new Date().toISOString(),
    applyCount: 0,
  };

  const testKey: CorrectionKey = `hash:test_${Date.now()}`;

  console.log('[CorrectionsPersistence] Running smoke test write...');
  const result = await persistCorrection(testCorrection, testKey, 'debug_session');
  console.log('[CorrectionsPersistence] Smoke test result:', result);
  return result;
}
