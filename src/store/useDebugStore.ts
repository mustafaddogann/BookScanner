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

interface DebugState {
  /** Whether diagnostics are enabled by user preference */
  diagnosticsEnabled: boolean;

  /** Whether the store has been initialized from storage */
  initialized: boolean;

  /** Set diagnostics enabled state (persists to storage) */
  setDiagnosticsEnabled: (enabled: boolean) => void;
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

export const useDebugStore = create<DebugState>((set, get) => ({
  diagnosticsEnabled: loadInitialValue(),
  initialized: true,

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
}));
