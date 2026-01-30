/**
 * Offline Resolver Queue
 * Gate 9: Resolver + Scoring + Verification + Acceptance
 *
 * Queues unresolved candidates for retry when the device comes back online.
 * Uses MMKV for persistent storage.
 */

import { MMKV } from 'react-native-mmkv';
import { Platform, AppState, AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { NetInfoState } from '@react-native-community/netinfo';
import type { BookCandidate } from '../types';
import {
  ResolveRequest,
  buildResolveRequest,
  resolveCandidate,
  applyResolverResult,
  ResolverResult,
} from './supabaseResolverClient';
import { isMetadataVerboseDebug, isOfflineQueueEnabled as isMetadataOfflineQueueEnabled } from '../config/debug';
import { useAppStore } from '../store/useAppStore';

// ============================================================================
// Configuration
// ============================================================================

const QUEUE_STORAGE_KEY = 'resolver_offline_queue';
const MAX_QUEUE_SIZE = 100;
const BATCH_SIZE = 5;
const RETRY_DELAY_MS = 2000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ============================================================================
// Types
// ============================================================================

interface QueuedItem {
  id: string;
  sessionId: string;
  candidateId: string;
  request: ResolveRequest;
  timestamp: number;
  retryCount: number;
}

interface QueueState {
  items: QueuedItem[];
  lastProcessedAt: number | null;
}

// ============================================================================
// Storage
// ============================================================================

const storage = new MMKV({ id: 'resolver-queue' });

function loadQueue(): QueueState {
  try {
    const data = storage.getString(QUEUE_STORAGE_KEY);
    if (data) {
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[OfflineQueue] Failed to load queue:', error);
  }
  return { items: [], lastProcessedAt: null };
}

function saveQueue(state: QueueState): void {
  try {
    storage.set(QUEUE_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('[OfflineQueue] Failed to save queue:', error);
  }
}

// ============================================================================
// Queue Operations
// ============================================================================

/**
 * Add a candidate to the offline queue.
 */
export function enqueueCandidate(
  sessionId: string,
  candidate: BookCandidate
): boolean {
  if (!isMetadataOfflineQueueEnabled()) {
    return false;
  }

  const request = buildResolveRequest(sessionId, candidate);
  if (!request) {
    console.warn('[OfflineQueue] Failed to build request for:', candidate.id);
    return false;
  }

  const state = loadQueue();

  // Check for duplicates
  if (state.items.some((item) => item.candidateId === candidate.id)) {
    if (isMetadataVerboseDebug()) {
      console.log('[OfflineQueue] Candidate already queued:', candidate.id);
    }
    return false;
  }

  // Enforce max queue size
  if (state.items.length >= MAX_QUEUE_SIZE) {
    // Remove oldest items
    state.items = state.items.slice(-MAX_QUEUE_SIZE + 1);
  }

  const item: QueuedItem = {
    id: `${sessionId}-${candidate.id}-${Date.now()}`,
    sessionId,
    candidateId: candidate.id,
    request,
    timestamp: Date.now(),
    retryCount: 0,
  };

  state.items.push(item);
  saveQueue(state);

  if (isMetadataVerboseDebug()) {
    console.log('[OfflineQueue] Enqueued candidate:', candidate.id);
  }

  return true;
}

/**
 * Get the number of items in the queue.
 */
export function getQueueSize(): number {
  const state = loadQueue();
  return state.items.length;
}

/**
 * Clear all items from the queue.
 */
export function clearQueue(): void {
  saveQueue({ items: [], lastProcessedAt: null });
  console.log('[OfflineQueue] Queue cleared');
}

/**
 * Remove expired items from the queue.
 */
export function pruneExpiredItems(): number {
  const state = loadQueue();
  const now = Date.now();
  const initialCount = state.items.length;

  state.items = state.items.filter((item) => now - item.timestamp < MAX_AGE_MS);

  const removedCount = initialCount - state.items.length;
  if (removedCount > 0) {
    saveQueue(state);
    console.log(`[OfflineQueue] Pruned ${removedCount} expired items`);
  }

  return removedCount;
}

// ============================================================================
// Queue Processing
// ============================================================================

let isProcessing = false;

/**
 * Process queued items in batches.
 */
export async function processQueue(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  if (!isMetadataOfflineQueueEnabled()) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  if (isProcessing) {
    console.log('[OfflineQueue] Already processing');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  isProcessing = true;

  try {
    // Prune expired items first
    pruneExpiredItems();

    const state = loadQueue();
    if (state.items.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    console.log(`[OfflineQueue] Processing ${state.items.length} queued items`);

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    // Process in batches
    const itemsToProcess = state.items.slice(0, BATCH_SIZE);
    const remainingItems: QueuedItem[] = state.items.slice(BATCH_SIZE);
    const failedItems: QueuedItem[] = [];

    for (const item of itemsToProcess) {
      processed++;

      // Create a minimal candidate for the resolver
      const candidate: BookCandidate = {
        id: item.candidateId,
        detectionIndices: [],
        cropIndices: [],
        representativeDetectionIndex: 0,
        orderingKey: 0,
        angleRad: 0,
        confidenceScore: 0,
        evidence: {
          topCrops: [],
          mergedLines: [],
          mergedTextBlock: '',
        },
        hypothesis: {
          evidenceTier: item.request.evidenceTier,
          searchCandidates: item.request.queries.map((q) => ({
            query: q.query,
            confidence: q.confidence,
            cropIndex: -1,
            tier: item.request.evidenceTier,
            tokens: q.query.split(' '),
            titleHint: q.titleHint,
            authorHint: q.authorHint,
          })),
          isbnCandidates: item.request.isbnCandidates.map((i) => i.isbn),
          uiGuess: null,
        },
      };

      const result = await resolveCandidate(item.sessionId, candidate);

      if (result.success) {
        succeeded++;
        // TODO: Update session meta with result if session is still active
        if (isMetadataVerboseDebug()) {
          console.log(`[OfflineQueue] Resolved ${item.candidateId}`);
        }
      } else if (result.offline || result.timeout) {
        // Put back in queue for retry
        item.retryCount++;
        failedItems.push(item);
        console.log(`[OfflineQueue] Will retry ${item.candidateId} (attempt ${item.retryCount})`);
      } else {
        failed++;
        console.log(`[OfflineQueue] Failed ${item.candidateId}: ${result.error}`);
      }

      // Add delay between requests
      if (processed < itemsToProcess.length) {
        await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    // Update queue with remaining and failed items
    state.items = [...failedItems, ...remainingItems];
    state.lastProcessedAt = Date.now();
    saveQueue(state);

    console.log(`[OfflineQueue] Processed: ${processed}, Succeeded: ${succeeded}, Failed: ${failed}`);

    return { processed, succeeded, failed };
  } finally {
    isProcessing = false;
  }
}

// ============================================================================
// Auto-Processing
// ============================================================================

let unsubscribeNetInfo: (() => void) | null = null;

/**
 * Start auto-processing when network becomes available.
 */
export function startAutoProcessing(): void {
  if (!isMetadataOfflineQueueEnabled()) {
    return;
  }

  // Listen for network changes
  unsubscribeNetInfo = NetInfo.addEventListener((state: NetInfoState) => {
    if (state.isConnected && state.isInternetReachable) {
      const queueSize = getQueueSize();
      if (queueSize > 0) {
        console.log(`[OfflineQueue] Network available, processing ${queueSize} items`);
        processQueue();
      }
    }
  });

  // Also listen for app state changes
  const handleAppStateChange = (nextAppState: AppStateStatus) => {
    if (nextAppState === 'active') {
      const queueSize = getQueueSize();
      if (queueSize > 0) {
        NetInfo.fetch().then((state) => {
          if (state.isConnected && state.isInternetReachable) {
            console.log(`[OfflineQueue] App active, processing ${queueSize} items`);
            processQueue();
          }
        });
      }
    }
  };

  AppState.addEventListener('change', handleAppStateChange);

  console.log('[OfflineQueue] Auto-processing enabled');
}

/**
 * Stop auto-processing.
 */
export function stopAutoProcessing(): void {
  if (unsubscribeNetInfo) {
    unsubscribeNetInfo();
    unsubscribeNetInfo = null;
  }
  console.log('[OfflineQueue] Auto-processing disabled');
}
