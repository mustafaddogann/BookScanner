import { useEffect, useRef } from 'react';
import { Vibration } from 'react-native';
import { useBackgroundScanStore } from '../store/useBackgroundScanStore';

/**
 * Watches useBackgroundScanStore.completedSessions.
 * When a background scan finishes, vibrates the device as subtle feedback.
 * No toast, no navigation — the user keeps shooting.
 */
export function useBackgroundScanHaptic() {
  const completedCount = useBackgroundScanStore((s) => s.completedSessions.length);
  const popCompleted = useBackgroundScanStore((s) => s.popCompletedSession);
  const processingRef = useRef(false);

  useEffect(() => {
    if (completedCount === 0 || processingRef.current) return;
    processingRef.current = true;

    const session = popCompleted();
    if (!session) {
      processingRef.current = false;
      return;
    }

    Vibration.vibrate(50);

    processingRef.current = false;
  }, [completedCount, popCompleted]);
}
