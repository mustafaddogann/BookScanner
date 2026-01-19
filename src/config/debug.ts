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
