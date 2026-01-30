/**
 * Evidence Hash Utility
 * Gate 9: Resolver + Scoring + Verification + Acceptance
 *
 * Computes a stable hash of book evidence for cache keys and deduplication.
 */

import type { BookEvidence } from '../types';

/**
 * Simple string hash function (FNV-1a).
 * Used for client-side hashing without crypto dependencies.
 */
function fnv1aHash(str: string): string {
  let hash = 2166136261; // FNV offset basis

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }

  // Convert to unsigned 32-bit and then to hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Normalize text for hashing.
 * Removes punctuation, collapses whitespace, lowercases.
 */
function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute a stable, order-independent hash of book evidence.
 * Used for cache keys, deduplication, and corrections matching.
 *
 * DETERMINISM GUARANTEE:
 * Only uses normalized text lines:
 * - lowercase
 * - remove punctuation
 * - collapse whitespace
 * - filter short lines (< 4 chars)
 * - SORT lines alphabetically
 * - join with '|'
 *
 * Does NOT include: crop index, rotation, bbox, confidence, perFieldHints
 *
 * @param evidence - Book evidence with merged lines and text block
 * @returns Hex string hash of the evidence
 */
export function computeEvidenceHash(evidence: BookEvidence): string {
  // Build a stable, order-independent representation using ONLY normalized text lines
  let lineTexts: string[] = [];

  // Prefer mergedLines
  if (evidence.mergedLines && evidence.mergedLines.length > 0) {
    lineTexts = evidence.mergedLines
      .map((line) => normalizeForHash(line.text))
      .filter((t) => t.length >= 4); // Filter short lines for stability
  }

  // Fallback to mergedTextBlock ONLY if no lines available
  if (lineTexts.length === 0 && evidence.mergedTextBlock) {
    lineTexts = evidence.mergedTextBlock
      .split(/\n/)
      .map(normalizeForHash)
      .filter((t) => t.length >= 4);
  }

  // Handle empty evidence
  if (lineTexts.length === 0) {
    return 'empty-evidence';
  }

  // Sort for order-independence, then join
  const combined = lineTexts.sort().join('|');

  // Compute hash
  return fnv1aHash(combined);
}

/**
 * Compute hash of multiple evidence objects.
 * Used for batch deduplication.
 */
export function computeBatchEvidenceHash(evidences: BookEvidence[]): string {
  const hashes = evidences.map(computeEvidenceHash).sort();
  return fnv1aHash(hashes.join(':'));
}
