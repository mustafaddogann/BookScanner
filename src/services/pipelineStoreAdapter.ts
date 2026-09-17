import type { ScanSession, OBBDetection } from '../types';
import { useAppStore, type SessionMeta } from '../store/useAppStore';
import { useBackgroundScanStore } from '../store/useBackgroundScanStore';

/**
 * Adapter interface that decouples pipeline from a specific store.
 *
 * The foreground adapter writes to useAppStore (existing singleton behavior).
 * The background adapter writes to an isolated slot in useBackgroundScanStore.
 */
export interface PipelineStoreAdapter {
  setProcessing(isProcessing: boolean, stage?: string | null): void;
  setSessionMeta(meta: Partial<SessionMeta> | null): void;
  setDetections(detections: OBBDetection[]): void;
  setCurrentSession(session: ScanSession | null): void;
  setError(error: string | null): void;
  addSession(session: ScanSession): void;
  getSessionMeta(): SessionMeta | null;
}

/**
 * Foreground adapter: delegates to useAppStore (existing behavior).
 */
export function createForegroundAdapter(): PipelineStoreAdapter {
  return {
    setProcessing(isProcessing, stage = null) {
      useAppStore.getState().setProcessing(isProcessing, stage);
    },
    setSessionMeta(meta) {
      useAppStore.getState().setSessionMeta(meta);
    },
    setDetections(detections) {
      useAppStore.getState().setDetections(detections);
    },
    setCurrentSession(session) {
      useAppStore.getState().setCurrentSession(session);
    },
    setError(error) {
      useAppStore.getState().setError(error);
    },
    addSession(session) {
      useAppStore.getState().addSession(session);
    },
    getSessionMeta() {
      return useAppStore.getState().sessionMeta;
    },
  };
}

/**
 * Background adapter: writes to an isolated slot in useBackgroundScanStore.
 *
 * - setCurrentSession is a NO-OP (background must not touch foreground session)
 * - addSession still writes to useAppStore (persists to MMKV sessions list)
 * - getSessionMeta reads from the background scan slot
 */
export function createBackgroundAdapter(sessionId: string): PipelineStoreAdapter {
  return {
    setProcessing(isProcessing, stage = null) {
      useBackgroundScanStore.getState().updateScan(sessionId, {
        isProcessing,
        stage,
      });
    },
    setSessionMeta(meta) {
      if (meta === null) {
        useBackgroundScanStore.getState().updateScan(sessionId, {
          sessionMeta: null,
        });
        return;
      }
      const scan = useBackgroundScanStore.getState().scans[sessionId];
      if (!scan) return;
      const current = scan.sessionMeta;
      const merged: SessionMeta = current
        ? { ...current, ...meta }
        : {
            frameGeo: null,
            imageDimensions: null,
            normalizedImagePath: null,
            originalImagePath: null,
            ...meta,
          };
      useBackgroundScanStore.getState().updateScan(sessionId, {
        sessionMeta: merged,
      });
    },
    setDetections(detections) {
      useBackgroundScanStore.getState().updateScan(sessionId, { detections });
    },
    setCurrentSession(_session) {
      // NO-OP: background must not touch foreground session
    },
    setError(error) {
      useBackgroundScanStore.getState().updateScan(sessionId, {
        error,
        isProcessing: false,
      });
    },
    addSession(session) {
      // Persist to MMKV via the main app store
      useAppStore.getState().addSession(session);
    },
    getSessionMeta() {
      const scan = useBackgroundScanStore.getState().scans[sessionId];
      return scan?.sessionMeta ?? null;
    },
  };
}
