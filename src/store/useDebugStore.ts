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
const AUTO_RETRY_KEY = 'debug_auto_retry_enabled';

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

  /** Whether auto-retry is enabled (for automated testing) */
  autoRetryEnabled: boolean;

  /** Auto-retry interval in seconds */
  autoRetryInterval: number;

  /** Whether the store has been initialized from storage */
  initialized: boolean;

  /** Set diagnostics enabled state (persists to storage) */
  setDiagnosticsEnabled: (enabled: boolean) => void;

  /** Set auto-retry enabled state */
  setAutoRetryEnabled: (enabled: boolean) => void;

  /** Set auto-retry interval */
  setAutoRetryInterval: (seconds: number) => void;

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

// Load auto-retry initial value - DEFAULT IS TRUE
function loadAutoRetryValue(): boolean {
  try {
    const stored = debugStorage.getBoolean(AUTO_RETRY_KEY);
    // Default to TRUE if not set
    const value = stored ?? true;
    console.log(`[AutoRetry] Loaded from storage: ${value}`);
    return value;
  } catch (error) {
    console.error('[AutoRetry] Failed to load from storage:', error);
    return true; // Default to true on error
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
  autoRetryEnabled: loadAutoRetryValue(), // Default TRUE, persisted
  autoRetryInterval: 10, // seconds
  initialized: true,
  writeStats: { ...initialWriteStats },

  setAutoRetryEnabled: (enabled: boolean) => {
    set({ autoRetryEnabled: enabled });
    // Persist to storage
    try {
      debugStorage.set(AUTO_RETRY_KEY, enabled);
      console.log('[AutoRetry] Enabled:', enabled, '(persisted)');
    } catch (error) {
      console.error('[AutoRetry] Failed to persist:', error);
    }
  },

  setAutoRetryInterval: (seconds: number) => {
    set({ autoRetryInterval: Math.max(5, Math.min(60, seconds)) });
  },

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
