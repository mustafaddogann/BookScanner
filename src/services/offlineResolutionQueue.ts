/**
 * Offline Resolution Queue - LOCAL provider path
 *
 * Persists unresolved metadata lookups (searchCandidates) for retry when online.
 * Enqueued from metadataResolutionOrchestrator when the local provider is disabled.
 *
 * ## STATUS: incomplete - do not enable the flag without finishing it
 *
 * Gated on METADATA_OFFLINE_QUEUE_ENABLED (config/debug.ts), currently false.
 *
 * processOfflineQueue() below is NEVER CALLED from anywhere in src/. There is no app-
 * start hook, no connectivity listener and no timer that drains this queue. The header
 * previously claimed it "automatically processes on app start"; it does not.
 * Enabling the flag as-is would accumulate items in MMKV that are never retried,
 * which is worse than having no queue.
 *
 * To finish it: call processOfflineQueue() on a connectivity regain (or at app start
 * in App.tsx, next to loadSessions) and assert in a test that items drain.
 *
 * NOTE: there is a second queue, offlineResolverQueue.ts, for the SUPABASE resolver
 * path. They are not interchangeable - that one queues BookCandidates and retries via
 * the Edge Function; this one queues searchCandidates for the local provider.
 *
 * Queue features:
 * - Max 50 items (oldest removed when exceeded)
 * - Dedupe by sessionId
 */

import type { EvidenceTier, SearchCandidate } from '../types';
import { storage } from '../store/useAppStore';
import { isOfflineQueueEnabled, isMetadataVerboseDebug } from '../config/debug';

const QUEUE_KEY = 'metadata_offline_queue';
const MAX_QUEUE_SIZE = 50;

/**
 * Queue item for offline resolution
 */
export interface OfflineQueueItem {
  sessionId: string;
  searchCandidates: SearchCandidate[];
  evidenceTier: EvidenceTier;
  timestamp: number;
  retryCount?: number;
}

/**
 * Get the current offline queue
 */
export function getOfflineQueue(): OfflineQueueItem[] {
  if (!isOfflineQueueEnabled()) {
    return [];
  }

  try {
    const queueJson = storage.getString(QUEUE_KEY);
    if (!queueJson) {
      return [];
    }
    return JSON.parse(queueJson) as OfflineQueueItem[];
  } catch (e) {
    console.warn('[OfflineQueue] Failed to read queue:', e);
    return [];
  }
}

/**
 * Save the offline queue
 */
function saveQueue(queue: OfflineQueueItem[]): void {
  try {
    storage.set(QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.warn('[OfflineQueue] Failed to save queue:', e);
  }
}

/**
 * Add an item to the offline queue
 *
 * - Dedupes by sessionId (updates existing entry)
 * - Enforces max size (removes oldest items)
 */
export async function queueForOfflineResolution(item: OfflineQueueItem): Promise<void> {
  if (!isOfflineQueueEnabled()) {
    return;
  }

  const verbose = isMetadataVerboseDebug();
  let queue = getOfflineQueue();

  // Check for existing item with same sessionId
  const existingIndex = queue.findIndex(q => q.sessionId === item.sessionId);
  if (existingIndex >= 0) {
    // Update existing item
    queue[existingIndex] = {
      ...item,
      retryCount: (queue[existingIndex].retryCount || 0) + 1,
    };
    if (verbose) {
      console.log(`[OfflineQueue] Updated existing item for session ${item.sessionId}`);
    }
  } else {
    // Add new item
    queue.push(item);
    if (verbose) {
      console.log(`[OfflineQueue] Added new item for session ${item.sessionId}`);
    }
  }

  // Enforce max size (remove oldest)
  if (queue.length > MAX_QUEUE_SIZE) {
    queue = queue
      .sort((a, b) => b.timestamp - a.timestamp) // Newest first
      .slice(0, MAX_QUEUE_SIZE);
    if (verbose) {
      console.log(`[OfflineQueue] Trimmed queue to ${MAX_QUEUE_SIZE} items`);
    }
  }

  saveQueue(queue);
}

/**
 * Remove an item from the queue
 */
export function removeFromQueue(sessionId: string): void {
  if (!isOfflineQueueEnabled()) {
    return;
  }

  const queue = getOfflineQueue().filter(q => q.sessionId !== sessionId);
  saveQueue(queue);

  if (isMetadataVerboseDebug()) {
    console.log(`[OfflineQueue] Removed item for session ${sessionId}`);
  }
}

/**
 * Clear the entire queue
 */
export function clearOfflineQueue(): void {
  saveQueue([]);
  if (isMetadataVerboseDebug()) {
    console.log('[OfflineQueue] Queue cleared');
  }
}

/**
 * Get queue size
 */
export function getQueueSize(): number {
  return getOfflineQueue().length;
}

/**
 * Process queued items (called when app starts or when going online)
 *
 * @param processor - Function to process each item (should return true if successful)
 * @returns Number of successfully processed items
 */
export async function processOfflineQueue(
  processor: (item: OfflineQueueItem) => Promise<boolean>
): Promise<number> {
  if (!isOfflineQueueEnabled()) {
    return 0;
  }

  const verbose = isMetadataVerboseDebug();
  const queue = getOfflineQueue();

  if (queue.length === 0) {
    if (verbose) {
      console.log('[OfflineQueue] Queue is empty, nothing to process');
    }
    return 0;
  }

  if (verbose) {
    console.log(`[OfflineQueue] Processing ${queue.length} queued items`);
  }

  let successCount = 0;
  const remainingItems: OfflineQueueItem[] = [];

  for (const item of queue) {
    try {
      const success = await processor(item);
      if (success) {
        successCount++;
        if (verbose) {
          console.log(`[OfflineQueue] Successfully processed session ${item.sessionId}`);
        }
      } else {
        // Keep for retry
        remainingItems.push({
          ...item,
          retryCount: (item.retryCount || 0) + 1,
        });
      }
    } catch (e) {
      console.warn(`[OfflineQueue] Failed to process session ${item.sessionId}:`, e);
      // Keep for retry
      remainingItems.push({
        ...item,
        retryCount: (item.retryCount || 0) + 1,
      });
    }
  }

  // Save remaining items
  saveQueue(remainingItems);

  if (verbose) {
    console.log(`[OfflineQueue] Processed ${successCount}/${queue.length} items, ${remainingItems.length} remaining`);
  }

  return successCount;
}
