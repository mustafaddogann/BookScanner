/**
 * Supabase Client Configuration
 * Gate 9: Resolver + Scoring + Verification + Acceptance
 *
 * Configure Supabase project URL and anon key via environment variables.
 * These are safe to expose in client code (RLS protects data).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { MMKV } from 'react-native-mmkv';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Supabase project URL.
 * Replace with your Supabase project URL.
 */
const SUPABASE_URL: string = 'https://uqcaqupotfouuzusxtat.supabase.co';

/**
 * Supabase anon key (safe to expose - RLS protects data).
 * Replace with your Supabase anon key.
 */
const SUPABASE_ANON_KEY: string = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxY2FxdXBvdGZvdXV6dXN4dGF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyMDkyODcsImV4cCI6MjA4NDc4NTI4N30.R6n8T9meDcg7mb4w611uNqEsZGgqg6XJpIdm3HcMhvw';

/**
 * Get the Supabase base URL (for direct fetch calls).
 */
export function getSupabaseBaseUrl(): string {
  return SUPABASE_URL;
}

/**
 * Get the Supabase anon key (for direct fetch calls).
 */
export function getSupabaseAnonKey(): string {
  return SUPABASE_ANON_KEY;
}

/**
 * Edge Function endpoints
 */
export const EDGE_FUNCTIONS = {
  resolveCandidates: 'resolve_candidates',
} as const;

// ============================================================================
// Storage Adapter for MMKV
// ============================================================================

const storage = new MMKV({ id: 'supabase-auth' });

const mmkvStorageAdapter = {
  getItem: (key: string): string | null => {
    return storage.getString(key) ?? null;
  },
  setItem: (key: string, value: string): void => {
    storage.set(key, value);
  },
  removeItem: (key: string): void => {
    storage.delete(key);
  },
};

// ============================================================================
// Supabase Client
// ============================================================================

let supabaseClient: SupabaseClient | null = null;

/**
 * Check if Supabase is configured with valid credentials.
 */
export function isSupabaseConfigured(): boolean {
  return (
    SUPABASE_URL !== 'https://your-project.supabase.co' &&
    SUPABASE_ANON_KEY !== 'your-anon-key' &&
    SUPABASE_URL.startsWith('https://') &&
    SUPABASE_ANON_KEY.length > 20
  );
}

/**
 * Get or create the Supabase client.
 * Returns null if Supabase is not configured.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    console.warn('[Supabase] Not configured - resolver will be disabled');
    return null;
  }

  if (!supabaseClient) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: mmkvStorageAdapter,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });
  }

  return supabaseClient;
}

/**
 * Get the Edge Function URL for a given function name.
 */
export function getEdgeFunctionUrl(functionName: string): string {
  return `${SUPABASE_URL}/functions/v1/${functionName}`;
}

/**
 * Get the current session token for Edge Function calls.
 */
export async function getSessionToken(): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const { data: { session } } = await client.auth.getSession();
  return session?.access_token ?? null;
}

// ============================================================================
// Connection Status
// ============================================================================

/**
 * Check if the device is online and can reach Supabase.
 * Uses a simple HEAD request to the Supabase URL.
 */
export async function checkSupabaseConnection(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: 'HEAD',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok || response.status === 401; // 401 is expected without auth
  } catch {
    return false;
  }
}
