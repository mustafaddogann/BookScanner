/**
 * Corrections Store
 * Gate 10: Corrections Memory
 *
 * MMKV-backed persistent storage for user corrections.
 * Corrections are keyed by ISBN (preferred) or content hash.
 */

import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';
import type { Correction, CorrectionKey } from '../types';

// ============================================================================
// Storage
// ============================================================================

const CORRECTIONS_STORAGE_KEY = 'corrections_memory';
const MAX_CORRECTIONS = 500; // Limit to prevent unbounded growth

// Dedicated MMKV instance for corrections
const correctionsStorage = new MMKV({
  id: 'bookscanner-corrections',
});

// ============================================================================
// Store State
// ============================================================================

interface CorrectionsState {
  /** All corrections indexed by key (ISBN or content hash) */
  corrections: Record<CorrectionKey, Correction>;

  /** Whether the store has been initialized from storage */
  initialized: boolean;

  /** Set or update a correction */
  setCorrection: (key: CorrectionKey, correction: Correction) => void;

  /** Delete a correction */
  deleteCorrection: (key: CorrectionKey) => void;

  /** Get a correction by key */
  getCorrection: (key: CorrectionKey) => Correction | undefined;

  /** Get all corrections */
  getAllCorrections: () => Correction[];

  /** Increment apply count for a correction */
  incrementApplyCount: (key: CorrectionKey) => void;

  /** Clear all corrections */
  clearAll: () => void;

  /** Load corrections from persistent storage */
  loadFromStorage: () => void;

  /** Get total count */
  getCount: () => number;
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useCorrectionsStore = create<CorrectionsState>((set, get) => ({
  corrections: {},
  initialized: false,

  setCorrection: (key: CorrectionKey, correction: Correction) => {
    const { corrections } = get();

    // Enforce max corrections limit (LRU eviction)
    const keys = Object.keys(corrections);
    if (keys.length >= MAX_CORRECTIONS && !corrections[key]) {
      // Find oldest correction by createdAt
      const oldest = keys.reduce((oldestKey, currKey) => {
        const oldestDate = new Date(corrections[oldestKey].createdAt).getTime();
        const currDate = new Date(corrections[currKey].createdAt).getTime();
        return currDate < oldestDate ? currKey : oldestKey;
      }, keys[0]);

      // Delete oldest
      delete corrections[oldest];
      console.log(`[CorrectionsStore] Evicted oldest correction: ${oldest}`);
    }

    const updated = { ...corrections, [key]: correction };
    set({ corrections: updated });

    // Persist to storage
    try {
      correctionsStorage.set(CORRECTIONS_STORAGE_KEY, JSON.stringify(updated));
    } catch (error) {
      console.error('[CorrectionsStore] Failed to persist correction:', error);
    }
  },

  deleteCorrection: (key: CorrectionKey) => {
    const { corrections } = get();
    const updated = { ...corrections };
    delete updated[key];
    set({ corrections: updated });

    // Persist to storage
    try {
      correctionsStorage.set(CORRECTIONS_STORAGE_KEY, JSON.stringify(updated));
    } catch (error) {
      console.error('[CorrectionsStore] Failed to persist deletion:', error);
    }
  },

  getCorrection: (key: CorrectionKey) => {
    return get().corrections[key];
  },

  getAllCorrections: () => {
    return Object.values(get().corrections);
  },

  incrementApplyCount: (key: CorrectionKey) => {
    const { corrections, setCorrection } = get();
    const correction = corrections[key];
    if (correction) {
      setCorrection(key, {
        ...correction,
        applyCount: correction.applyCount + 1,
      });
    }
  },

  clearAll: () => {
    set({ corrections: {} });
    try {
      correctionsStorage.delete(CORRECTIONS_STORAGE_KEY);
      console.log('[CorrectionsStore] Cleared all corrections');
    } catch (error) {
      console.error('[CorrectionsStore] Failed to clear storage:', error);
    }
  },

  loadFromStorage: () => {
    try {
      const data = correctionsStorage.getString(CORRECTIONS_STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data) as Record<CorrectionKey, Correction>;
        set({ corrections: parsed, initialized: true });
        console.log(
          `[CorrectionsStore] Loaded ${Object.keys(parsed).length} corrections from storage`
        );
      } else {
        set({ initialized: true });
        console.log('[CorrectionsStore] No stored corrections found');
      }
    } catch (error) {
      console.error('[CorrectionsStore] Failed to load from storage:', error);
      set({ initialized: true });
    }
  },

  getCount: () => {
    return Object.keys(get().corrections).length;
  },
}));

// ============================================================================
// Initialize on import
// ============================================================================

// Load corrections from storage when module is imported
useCorrectionsStore.getState().loadFromStorage();
