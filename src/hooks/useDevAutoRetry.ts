/**
 * useDevAutoRetry - development-only automation loops for the Results screen.
 *
 * These two loops exist to drive the local AI-coding feedback loop
 * (scripts/rejectsServer.js + scripts/autoFixDaemon.js):
 *
 * 1. Auto-retry: re-runs metadata resolution on an interval while any candidate
 *    is still unresolved, then exports the rejects for offline analysis.
 * 2. Auto-rescan: polls the local dev server; when it signals that a fix was
 *    deployed, navigates back to Scanner to rescan the last image.
 *
 * Both are HARD-DISABLED outside __DEV__. Auto-retry alone costs hundreds of Open
 * Library queries per pass, so a shipped build must never run it: it would drain
 * battery and data and get the device rate-limited. Enable it from Settings while
 * developing (useDebugStore.autoRetryEnabled).
 */

import { useEffect } from 'react';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types';
import { useAppStore } from '../store/useAppStore';
import { useDebugStore } from '../store/useDebugStore';
import { retryMetadataResolution } from '../services/metadataResolutionOrchestrator';
import {
  autoExportRejects,
  checkRescanStatus,
  getLastScannedImageUri,
  getServerUrl,
} from '../services/autoExportService';

const RESCAN_POLL_INTERVAL_MS = 30000;
const RESCAN_INITIAL_DELAY_MS = 5000;

interface UseDevAutoRetryParams {
  sessionId: string;
  navigation: NativeStackNavigationProp<RootStackParamList, 'Results'>;
  /** True while a user-triggered retry is in flight, so we don't overlap. */
  isRetrying: boolean;
  setIsRetrying: (retrying: boolean) => void;
}

export function useDevAutoRetry({
  sessionId,
  navigation,
  isRetrying,
  setIsRetrying,
}: UseDevAutoRetryParams): void {
  const autoRetryEnabled = useDebugStore((state) => state.autoRetryEnabled);
  const autoRetryInterval = useDebugStore((state) => state.autoRetryInterval);
  const setAutoRetryEnabled = useDebugStore((state) => state.setAutoRetryEnabled);

  // __DEV__ is a compile-time constant, so in a release build both effects below
  // short-circuit on their first line and no timer is ever created.
  const enabled = __DEV__ && autoRetryEnabled;

  // Loop 1: periodically re-run metadata resolution while rejects remain.
  useEffect(() => {
    if (!enabled || isRetrying) return;

    const timer = setInterval(() => {
      const currentMeta = useAppStore.getState().sessionMeta;
      const rejectCount =
        currentMeta?.bookCandidates?.filter((c) => {
          const decision = c.resolverDecision;
          return decision !== 'accept' && decision !== 'suggested';
        }).length || 0;

      if (rejectCount === 0) {
        console.log('[AutoRetry] No rejects, disabling auto-retry');
        setAutoRetryEnabled(false);
        return;
      }

      console.log(`[AutoRetry] ${rejectCount} rejects found, retrying...`);
      setIsRetrying(true);
      retryMetadataResolution({
        sessionId,
        rectificationResults: currentMeta?.rectificationResults || [],
        ocrResultsByCropIndex: currentMeta?.ocrResultsByCropIndex || {},
        bookCandidates: currentMeta?.bookCandidates || [],
      })
        .then((result) => {
          console.log('[AutoRetry] Retry complete');
          useAppStore.getState().setSessionMeta({
            metadataResolution: result.resolutionState,
            bookCandidates: result.resolutionState?.resolvedCandidates,
          });
          autoExportRejects(sessionId, result.resolutionState?.resolvedCandidates || []);
        })
        .catch((err) => {
          console.error('[AutoRetry] Retry failed:', err);
        })
        .finally(() => {
          setIsRetrying(false);
        });
    }, autoRetryInterval * 1000);

    return () => clearInterval(timer);
  }, [
    enabled,
    isRetrying,
    autoRetryInterval,
    sessionId,
    setAutoRetryEnabled,
    setIsRetrying,
  ]);

  // Loop 2: poll the dev server for a "code was fixed, rescan now" signal.
  useEffect(() => {
    if (!enabled) return;

    const pollForRescan = async () => {
      try {
        const status = await checkRescanStatus();
        if (!status.rescan || !status.auto_retry) return;

        console.log('[AutoRescan] Server signaled rescan:', status.reason);
        const imageUri = getLastScannedImageUri();
        if (!imageUri) return;

        const serverUrl = getServerUrl();
        if (serverUrl) {
          try {
            const baseUrl = serverUrl.replace(/\/upload$/, '');
            await fetch(`${baseUrl}/clear-rescan`, { method: 'POST' });
          } catch (e) {
            console.warn('[AutoRescan] Failed to clear rescan flag:', e);
          }
        }

        console.log('[AutoRescan] Auto-navigating to rescan with:', imageUri);
        navigation.navigate('Scanner', { importUri: imageUri });
      } catch (error) {
        console.warn('[AutoRescan] Poll error:', error);
      }
    };

    const timer = setInterval(pollForRescan, RESCAN_POLL_INTERVAL_MS);
    const initialCheck = setTimeout(pollForRescan, RESCAN_INITIAL_DELAY_MS);

    return () => {
      clearInterval(timer);
      clearTimeout(initialCheck);
    };
  }, [enabled, navigation]);
}
