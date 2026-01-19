import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';
import type { ScanSession, OBBDetection, SerializedFrameGeo } from '../types';
import { setRectifierUrl as setServiceRectifierUrl } from '../services/rectificationService';

// Initialize MMKV storage
export const storage = new MMKV({
  id: 'bookscanner-storage',
});

/**
 * Session metadata stored in-memory for UI rendering
 * This is the SINGLE SOURCE OF TRUTH for geometry - NOT debug_manifest.json
 */
export interface SessionMeta {
  /** Serialized FrameGeo from pipeline */
  frameGeo: SerializedFrameGeo | null;
  /** Image dimensions for overlay mapping */
  imageDimensions: { width: number; height: number } | null;
  /** Path to normalized image for display */
  normalizedImagePath: string | null;
  /** Original image path (pre-normalization) */
  originalImagePath: string | null;
}

interface AppState {
  // Current session state
  currentSessionId: string | null;
  currentSession: ScanSession | null;
  detections: OBBDetection[];
  selectedDetectionIndex: number | null;
  isProcessing: boolean;
  processingStage: string | null;
  error: string | null;

  // Session metadata (frameGeo, dimensions) - SINGLE SOURCE OF TRUTH
  sessionMeta: SessionMeta | null;

  // Session history
  sessions: ScanSession[];

  // Rectifier configuration
  rectifierUrl: string;
  rectifierEnabled: boolean;

  // Actions
  setCurrentSession: (session: ScanSession | null) => void;
  setDetections: (detections: OBBDetection[]) => void;
  setSelectedDetection: (index: number | null) => void;
  setProcessing: (isProcessing: boolean, stage?: string | null) => void;
  setError: (error: string | null) => void;
  setSessionMeta: (meta: SessionMeta | null) => void;
  addSession: (session: ScanSession) => void;
  updateSession: (sessionId: string, updates: Partial<ScanSession>) => void;
  loadSessions: () => void;
  clearCurrentSession: () => void;
  setRectifierUrl: (url: string) => void;
  setRectifierEnabled: (enabled: boolean) => void;
}

// Keys for MMKV storage
const SESSIONS_KEY = 'sessions';
const RECTIFIER_URL_KEY = 'rectifierUrl';
const RECTIFIER_ENABLED_KEY = 'rectifierEnabled';

// Default rectifier URL
const DEFAULT_RECTIFIER_URL = 'http://localhost:8000';

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  currentSessionId: null,
  currentSession: null,
  detections: [],
  selectedDetectionIndex: null,
  isProcessing: false,
  processingStage: null,
  error: null,
  sessionMeta: null,
  sessions: [],

  // Rectifier configuration (loaded from MMKV)
  rectifierUrl: storage.getString(RECTIFIER_URL_KEY) || DEFAULT_RECTIFIER_URL,
  rectifierEnabled: storage.getString(RECTIFIER_ENABLED_KEY) !== 'false',

  // Actions
  setCurrentSession: (session) => {
    set({
      currentSession: session,
      currentSessionId: session?.sessionId ?? null,
      error: null,
    });
  },

  setDetections: (detections) => {
    set({ detections });
  },

  setSelectedDetection: (index) => {
    set({ selectedDetectionIndex: index });
  },

  setProcessing: (isProcessing, stage = null) => {
    set({
      isProcessing,
      processingStage: stage,
      error: isProcessing ? null : get().error,
    });
  },

  setError: (error) => {
    set({
      error,
      isProcessing: false,
      processingStage: null,
    });
  },

  setSessionMeta: (meta) => {
    set({ sessionMeta: meta });
    if (meta) {
      console.log(`[AppStore] Session meta set: frameGeo=${!!meta.frameGeo}, dims=${meta.imageDimensions?.width}x${meta.imageDimensions?.height}`);
    } else {
      console.log('[AppStore] Session meta cleared');
    }
  },

  addSession: (session) => {
    const sessions = [...get().sessions, session];
    set({ sessions });
    // Persist to MMKV
    storage.set(SESSIONS_KEY, JSON.stringify(sessions));
  },

  updateSession: (sessionId, updates) => {
    const sessions = get().sessions.map((s) =>
      s.sessionId === sessionId ? { ...s, ...updates } : s
    );
    set({ sessions });
    // Persist to MMKV
    storage.set(SESSIONS_KEY, JSON.stringify(sessions));

    // Update current session if it matches
    const currentSession = get().currentSession;
    if (currentSession?.sessionId === sessionId) {
      set({ currentSession: { ...currentSession, ...updates } });
    }
  },

  loadSessions: () => {
    try {
      const sessionsJson = storage.getString(SESSIONS_KEY);
      if (sessionsJson) {
        const sessions: ScanSession[] = JSON.parse(sessionsJson);
        set({ sessions });
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  },

  clearCurrentSession: () => {
    set({
      currentSession: null,
      currentSessionId: null,
      detections: [],
      selectedDetectionIndex: null,
      isProcessing: false,
      processingStage: null,
      error: null,
      sessionMeta: null,
    });
  },

  setRectifierUrl: (url) => {
    set({ rectifierUrl: url });
    storage.set(RECTIFIER_URL_KEY, url);
    // Also update the service module
    setServiceRectifierUrl(url);
    console.log(`[AppStore] Rectifier URL set to: ${url}`);
  },

  setRectifierEnabled: (enabled) => {
    set({ rectifierEnabled: enabled });
    storage.set(RECTIFIER_ENABLED_KEY, enabled ? 'true' : 'false');
    console.log(`[AppStore] Rectification ${enabled ? 'enabled' : 'disabled'}`);
  },
}));
