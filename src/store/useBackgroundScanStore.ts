import { create } from 'zustand';
import type { ScanSession, OBBDetection } from '../types';
import type { SessionMeta } from './useAppStore';
import { useUnreviewedStore } from './useUnreviewedStore';

export interface BackgroundScan {
  sessionId: string;
  stage: string | null;
  isProcessing: boolean;
  error: string | null;
  sessionMeta: SessionMeta | null;
  detections: OBBDetection[];
}

interface BackgroundScanState {
  scans: Record<string, BackgroundScan>;
  completedSessions: ScanSession[];

  startScan: (sessionId: string) => void;
  updateScan: (sessionId: string, updates: Partial<BackgroundScan>) => void;
  completeScan: (sessionId: string, session: ScanSession) => void;
  /** Mark a scan as failed: keeps the slot so the error stays visible, but stops counting it as in-flight. */
  failScan: (sessionId: string, error: string) => void;
  popCompletedSession: () => ScanSession | null;
  removeScan: (sessionId: string) => void;
  /** Number of scans still running. Failed scans are NOT counted. */
  activeCount: () => number;
}

export const useBackgroundScanStore = create<BackgroundScanState>((set, get) => ({
  scans: {},
  completedSessions: [],

  startScan: (sessionId) => {
    set((state) => ({
      scans: {
        ...state.scans,
        [sessionId]: {
          sessionId,
          stage: 'initialization',
          isProcessing: true,
          error: null,
          sessionMeta: null,
          detections: [],
        },
      },
    }));
  },

  updateScan: (sessionId, updates) => {
    set((state) => {
      const existing = state.scans[sessionId];
      if (!existing) return state;
      return {
        scans: {
          ...state.scans,
          [sessionId]: { ...existing, ...updates },
        },
      };
    });
  },

  completeScan: (sessionId, session) => {
    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.scans;
      return {
        scans: rest,
        completedSessions: [...state.completedSessions, session],
      };
    });
    useUnreviewedStore.getState().addUnreviewed(session.sessionId);
  },

  failScan: (sessionId, error) => {
    set((state) => {
      const existing = state.scans[sessionId];
      if (!existing) return state;
      return {
        scans: {
          ...state.scans,
          [sessionId]: { ...existing, error, isProcessing: false, stage: null },
        },
      };
    });
  },

  popCompletedSession: () => {
    const { completedSessions } = get();
    if (completedSessions.length === 0) return null;
    const [first, ...rest] = completedSessions;
    set({ completedSessions: rest });
    return first;
  },

  removeScan: (sessionId) => {
    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.scans;
      return { scans: rest };
    });
  },

  // Counts only scans still running. A failed scan keeps its slot so the user can
  // read the error and dismiss it, but it must not hold a concurrency permit -
  // otherwise three failures would block capture until the app restarts.
  activeCount: () => {
    return Object.values(get().scans).filter((scan) => scan.isProcessing).length;
  },
}));
