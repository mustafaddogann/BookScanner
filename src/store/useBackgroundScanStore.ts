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
  popCompletedSession: () => ScanSession | null;
  removeScan: (sessionId: string) => void;
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

  activeCount: () => {
    return Object.keys(get().scans).length;
  },
}));
