import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';
import type { ScanSession, OBBDetection, DebugManifest } from '../types';

// Initialize MMKV storage
export const storage = new MMKV({
  id: 'bookscanner-storage',
});

interface AppState {
  // Current session state
  currentSessionId: string | null;
  currentSession: ScanSession | null;
  detections: OBBDetection[];
  selectedDetectionIndex: number | null;
  isProcessing: boolean;
  processingStage: string | null;
  error: string | null;

  // Session history
  sessions: ScanSession[];

  // Actions
  setCurrentSession: (session: ScanSession | null) => void;
  setDetections: (detections: OBBDetection[]) => void;
  setSelectedDetection: (index: number | null) => void;
  setProcessing: (isProcessing: boolean, stage?: string | null) => void;
  setError: (error: string | null) => void;
  addSession: (session: ScanSession) => void;
  updateSession: (sessionId: string, updates: Partial<ScanSession>) => void;
  loadSessions: () => void;
  clearCurrentSession: () => void;
}

// Keys for MMKV storage
const SESSIONS_KEY = 'sessions';

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  currentSessionId: null,
  currentSession: null,
  detections: [],
  selectedDetectionIndex: null,
  isProcessing: false,
  processingStage: null,
  error: null,
  sessions: [],

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
    });
  },
}));
