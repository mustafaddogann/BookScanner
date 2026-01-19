/**
 * Debug configuration for BookScanner
 * Controls expensive debug artifact generation
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
