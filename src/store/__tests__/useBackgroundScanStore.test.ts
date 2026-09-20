/**
 * Unit tests for useBackgroundScanStore.
 *
 * Regression cover for the bug where a failed background scan kept its slot marked
 * as in-flight forever: activeCount() never returned to 0, so after three failures
 * ScannerScreen permanently disabled capture and runPipelineBackground threw
 * "Maximum background scans reached (3)" until the app was restarted.
 */

import { useBackgroundScanStore } from '../useBackgroundScanStore';
import { useUnreviewedStore } from '../useUnreviewedStore';
import type { ScanSession } from '../../types';

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  useBackgroundScanStore.setState({ scans: {}, completedSessions: [] });
  useUnreviewedStore.setState({ unreviewedIds: new Set() });
});

function makeSession(sessionId: string): ScanSession {
  return {
    sessionId,
    createdAt: new Date().toISOString(),
    source: 'camera',
    imagePath: `file:///tmp/${sessionId}.jpg`,
    sessionDir: `/tmp/sessions/${sessionId}`,
    detectionCount: 3,
    status: 'completed',
  };
}

describe('activeCount', () => {
  it('counts only scans that are still processing', () => {
    const store = useBackgroundScanStore.getState();
    store.startScan('a');
    store.startScan('b');

    expect(useBackgroundScanStore.getState().activeCount()).toBe(2);
  });

  it('does not count failed scans, so capture stays available', () => {
    const store = useBackgroundScanStore.getState();
    store.startScan('a');
    store.startScan('b');
    store.startScan('c');
    expect(useBackgroundScanStore.getState().activeCount()).toBe(3);

    // Three failures used to brick the camera permanently.
    useBackgroundScanStore.getState().failScan('a', 'boom');
    useBackgroundScanStore.getState().failScan('b', 'boom');
    useBackgroundScanStore.getState().failScan('c', 'boom');

    expect(useBackgroundScanStore.getState().activeCount()).toBe(0);
  });

  it('returns to zero after a completed scan', () => {
    useBackgroundScanStore.getState().startScan('a');
    useBackgroundScanStore.getState().completeScan('a', makeSession('a'));

    expect(useBackgroundScanStore.getState().activeCount()).toBe(0);
  });
});

describe('failScan', () => {
  it('keeps the slot so the error remains readable', () => {
    useBackgroundScanStore.getState().startScan('a');
    useBackgroundScanStore.getState().failScan('a', 'decode failed');

    const scan = useBackgroundScanStore.getState().scans.a;
    expect(scan).toBeDefined();
    expect(scan.error).toBe('decode failed');
    expect(scan.isProcessing).toBe(false);
    expect(scan.stage).toBeNull();
  });

  it('is a no-op for an unknown session', () => {
    useBackgroundScanStore.getState().failScan('missing', 'boom');
    expect(useBackgroundScanStore.getState().scans).toEqual({});
  });

  it('leaves the slot dismissable via removeScan', () => {
    useBackgroundScanStore.getState().startScan('a');
    useBackgroundScanStore.getState().failScan('a', 'boom');
    useBackgroundScanStore.getState().removeScan('a');

    expect(useBackgroundScanStore.getState().scans.a).toBeUndefined();
    expect(useBackgroundScanStore.getState().activeCount()).toBe(0);
  });
});

describe('completeScan', () => {
  it('removes the slot and queues the session for the completion haptic', () => {
    useBackgroundScanStore.getState().startScan('a');
    useBackgroundScanStore.getState().completeScan('a', makeSession('a'));

    const state = useBackgroundScanStore.getState();
    expect(state.scans.a).toBeUndefined();
    expect(state.completedSessions.map((s) => s.sessionId)).toEqual(['a']);
    expect(useUnreviewedStore.getState().unreviewedIds.has('a')).toBe(true);
  });

  it('popCompletedSession drains the queue in order', () => {
    const store = useBackgroundScanStore.getState();
    store.startScan('a');
    store.startScan('b');
    useBackgroundScanStore.getState().completeScan('a', makeSession('a'));
    useBackgroundScanStore.getState().completeScan('b', makeSession('b'));

    expect(useBackgroundScanStore.getState().popCompletedSession()?.sessionId).toBe('a');
    expect(useBackgroundScanStore.getState().popCompletedSession()?.sessionId).toBe('b');
    expect(useBackgroundScanStore.getState().popCompletedSession()).toBeNull();
  });
});

describe('updateScan', () => {
  it('ignores updates for sessions that are gone', () => {
    useBackgroundScanStore.getState().updateScan('nope', { stage: 'ocr' });
    expect(useBackgroundScanStore.getState().scans).toEqual({});
  });
});
