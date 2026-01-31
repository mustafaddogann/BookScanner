/**
 * Debug Store
 * Persistent storage for debug/diagnostics settings.
 *
 * MMKV-backed to persist across app restarts.
 */

import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

// ============================================================================
// Storage
// ============================================================================

const DEBUG_DIAGNOSTICS_KEY = 'debug_diagnostics_enabled';

// Dedicated MMKV instance for debug settings
const debugStorage = new MMKV({
  id: 'bookscanner-debug',
});

// ============================================================================
// Store State
// ============================================================================

/**
 * Write stats for books_catalog persistence observability
 */
export interface WriteStats {
  /** Number of upsert attempts */
  writesAttempted: number;
  /** Number of successful writes */
  writesSucceeded: number;
  /** Number of failed writes */
  writesFailed: number;
  /** Last error message (if any) */
  lastWriteError: string | null;
  /** Timestamp of last write attempt */
  lastWriteTime: number | null;
}

interface DebugState {
  /** Whether diagnostics are enabled by user preference */
  diagnosticsEnabled: boolean;

  /** Whether the store has been initialized from storage */
  initialized: boolean;

  /** Set diagnostics enabled state (persists to storage) */
  setDiagnosticsEnabled: (enabled: boolean) => void;

  /** Write stats for books_catalog persistence */
  writeStats: WriteStats;

  /** Record a write attempt */
  recordWriteAttempt: () => void;

  /** Record a successful write */
  recordWriteSuccess: () => void;

  /** Record a failed write */
  recordWriteFailure: (error: string) => void;

  /** Reset write stats */
  resetWriteStats: () => void;
}

// ============================================================================
// Store Implementation
// ============================================================================

// Load initial value from storage synchronously
function loadInitialValue(): boolean {
  try {
    const stored = debugStorage.getBoolean(DEBUG_DIAGNOSTICS_KEY);
    const value = stored ?? false;
    console.log(`[DiagnosticsToggle] Loaded from storage: ${value}`);
    return value;
  } catch (error) {
    console.error('[DiagnosticsToggle] Failed to load from storage:', error);
    return false;
  }
}

const initialWriteStats: WriteStats = {
  writesAttempted: 0,
  writesSucceeded: 0,
  writesFailed: 0,
  lastWriteError: null,
  lastWriteTime: null,
};

export const useDebugStore = create<DebugState>((set, get) => ({
  diagnosticsEnabled: loadInitialValue(),
  initialized: true,
  writeStats: { ...initialWriteStats },

  setDiagnosticsEnabled: (enabled: boolean) => {
    const previous = get().diagnosticsEnabled;

    // Update state
    set({ diagnosticsEnabled: enabled });

    // Persist to storage
    try {
      debugStorage.set(DEBUG_DIAGNOSTICS_KEY, enabled);

      // Read back for verification
      const readBack = debugStorage.getBoolean(DEBUG_DIAGNOSTICS_KEY);

      console.log('[DiagnosticsToggle] Toggle changed:', {
        previous,
        new: enabled,
        persistedReadBack: readBack,
      });
    } catch (error) {
      console.error('[DiagnosticsToggle] Failed to persist:', error);
    }
  },

  recordWriteAttempt: () => {
    set((state) => ({
      writeStats: {
        ...state.writeStats,
        writesAttempted: state.writeStats.writesAttempted + 1,
        lastWriteTime: Date.now(),
      },
    }));
  },

  recordWriteSuccess: () => {
    set((state) => ({
      writeStats: {
        ...state.writeStats,
        writesSucceeded: state.writeStats.writesSucceeded + 1,
      },
    }));
  },

  recordWriteFailure: (error: string) => {
    set((state) => ({
      writeStats: {
        ...state.writeStats,
        writesFailed: state.writeStats.writesFailed + 1,
        lastWriteError: error,
      },
    }));
  },

  resetWriteStats: () => {
    set({ writeStats: { ...initialWriteStats } });
  },
}));
