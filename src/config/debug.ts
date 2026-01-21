/**
 * Debug configuration for BookScanner
 * Controls expensive debug artifact generation and feature flags
 */

/**
 * Master switch for debug artifact generation
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
 * Check if debug artifacts should be generated
 */
export function isDebugArtifactsEnabled(): boolean {
  return DEBUG_ARTIFACTS_ENABLED;
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
export const METADATA_LOOKUP_ENABLED = false;

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
export const METADATA_RESOLUTION_ENABLED = false;

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
