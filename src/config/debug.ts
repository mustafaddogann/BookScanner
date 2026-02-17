/**
 * Debug configuration for BookScanner
 * Controls expensive debug artifact generation and feature flags
 *
 * IMPORTANT: The user-controlled diagnosticsEnabled toggle in useDebugStore
 * is the PRIMARY gate for all diagnostics features. These flags are SECONDARY
 * and must be ANDed with diagnosticsEnabled.
 */

import { useDebugStore } from '../store/useDebugStore';

/**
 * Secondary flag for debug artifact generation.
 * The primary gate is diagnosticsEnabled from useDebugStore.
 *
 * When false (default for production):
 * - No overlay images written
 * - No detections_raw.json
 * - No diag_decode.json
 * - No raw_sample_anchors.json
 * - No nms_witness.json
 * - No tensor previews
 * - Minimal artifacts for core functionality only
 *
 * When true (for debugging):
 * - Full artifact generation (overlays, JSON files, etc.)
 * - Same behavior as before this optimization
 */
export const DEBUG_ARTIFACTS_ENABLED = false;

/**
 * Check if debug artifacts should be generated.
 * Requires BOTH diagnosticsEnabled AND DEBUG_ARTIFACTS_ENABLED.
 */
export function isDebugArtifactsEnabled(): boolean {
  const diagnosticsEnabled = useDebugStore.getState().diagnosticsEnabled;
  return __DEV__ && diagnosticsEnabled && DEBUG_ARTIFACTS_ENABLED;
}

/**
 * Feature flag for book metadata lookup
 *
 * When false (default):
 * - No network calls for metadata lookup
 * - Title/author from OCR only
 *
 * When true:
 * - Enables Open Library / Google Books lookups
 * - Requires internet connection
 */
export const METADATA_LOOKUP_ENABLED = true;

/**
 * Check if metadata lookup is enabled
 */
export function isMetadataLookupEnabled(): boolean {
  return METADATA_LOOKUP_ENABLED;
}

// ============================================================================
// Metadata Resolution Feature Flags (Gate 8+)
// ============================================================================

/**
 * Master switch for metadata resolution pipeline
 *
 * When false (default):
 * - Uses simple OCR-derived title/author only
 * - No evidence tiers, no search candidates, no verification
 *
 * When true:
 * - Enables full metadata resolution pipeline:
 *   QUALITY_CLASSIFY → HYPOTHESIZE → RESOLVE → VERIFY → DECIDE
 * - Requires METADATA_LOOKUP_ENABLED for network lookups
 */
export const METADATA_RESOLUTION_ENABLED = true;

/**
 * Enable AI-powered refinement of OCR text
 * Placeholder for future integration with LLM APIs
 *
 * When false (default):
 * - Uses rule-based OCR post-processing only
 *
 * When true:
 * - Would enable LLM-based title/author extraction
 * - Requires API key configuration (not implemented)
 */
export const METADATA_AI_REFINEMENT_ENABLED = false;

/**
 * Enable offline queue for metadata resolution
 *
 * When false (default):
 * - If offline, immediately falls back to OCR-only
 *
 * When true:
 * - Queues unresolved lookups for retry when online
 * - Persists queue to MMKV storage
 */
export const METADATA_OFFLINE_QUEUE_ENABLED = false;

/**
 * Verbose debug logging for metadata resolution
 *
 * When false (default):
 * - Minimal logging
 *
 * When true:
 * - Logs all scoring signals, verification flags, decision logic
 */
export const METADATA_VERBOSE_DEBUG = false;

/**
 * Use Supabase Edge Function resolver instead of local evidence-driven resolver.
 *
 * When false (default):
 * - Always run local evidence-driven resolver for per-candidate suggestions
 * - Supabase is used only for persisting accepted matches
 *
 * When true:
 * - Use Supabase resolver as the primary resolution path
 */
export const METADATA_USE_SUPABASE_RESOLVER = true;

/**
 * Check if metadata resolution is enabled
 */
export function isMetadataResolutionEnabled(): boolean {
  return METADATA_RESOLUTION_ENABLED;
}

/**
 * Check if AI refinement is enabled
 */
export function isAIRefinementEnabled(): boolean {
  return METADATA_AI_REFINEMENT_ENABLED;
}

/**
 * Check if offline queue is enabled
 */
export function isOfflineQueueEnabled(): boolean {
  return METADATA_OFFLINE_QUEUE_ENABLED;
}

/**
 * Check if verbose debug logging is enabled
 */
export function isMetadataVerboseDebug(): boolean {
  return METADATA_VERBOSE_DEBUG;
}

/**
 * Check if Supabase Edge Function resolver should be used
 */
export function isSupabaseResolverEnabled(): boolean {
  return METADATA_USE_SUPABASE_RESOLVER;
}

// ============================================================================
// Field Extraction Feature Flag
// ============================================================================

/**
 * Enable enhanced field extraction from OCR evidence
 *
 * When false (default):
 * - Uses simple title/author extraction only
 * - No ISBN/publisher/edition/year extraction
 *
 * When true:
 * - Enables structured field extraction:
 *   - ISBN (10/13) with validation
 *   - Publisher detection
 *   - Edition detection
 *   - Year extraction
 *   - Improved title/author splitting
 * - Feeds enhanced evidence into search candidates
 */
export const METADATA_FIELD_EXTRACTION_ENABLED = false;

/**
 * Check if field extraction is enabled
 */
export function isFieldExtractionEnabled(): boolean {
  return METADATA_FIELD_EXTRACTION_ENABLED;
}

// ============================================================================
// Diagnostic Logging
// ============================================================================

/**
 * Check if diagnostic logging should be enabled.
 * Diagnostic logs include resolver endpoints, HTTP status, decisions, and correction apply results.
 *
 * Primary gate: diagnosticsEnabled from useDebugStore
 * Secondary gates: DEBUG_ARTIFACTS_ENABLED or METADATA_VERBOSE_DEBUG
 *
 * Enabled when: __DEV__ && diagnosticsEnabled && (DEBUG_ARTIFACTS_ENABLED || METADATA_VERBOSE_DEBUG)
 */
export function isDiagnosticLoggingEnabled(): boolean {
  const diagnosticsEnabled = useDebugStore.getState().diagnosticsEnabled;
  return __DEV__ && diagnosticsEnabled && (DEBUG_ARTIFACTS_ENABLED || METADATA_VERBOSE_DEBUG);
}

/**
 * Log a diagnostic message if diagnostic logging is enabled.
 */
export function logDiagnostic(tag: string, message: string, data?: unknown): void {
  if (isDiagnosticLoggingEnabled()) {
    if (data !== undefined) {
      console.log(`[${tag}] ${message}`, data);
    } else {
      console.log(`[${tag}] ${message}`);
    }
  }
}

/**
 * Check if diagnostics UI features should be shown.
 * This is the primary gate for diagnostics UI elements.
 */
export function isDiagnosticsUIEnabled(): boolean {
  const diagnosticsEnabled = useDebugStore.getState().diagnosticsEnabled;
  return __DEV__ && diagnosticsEnabled;
}
