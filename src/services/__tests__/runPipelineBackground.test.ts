/**
 * Lifecycle tests for runPipelineBackground.
 *
 * Two regressions are pinned here:
 *
 * 1. runPipelineBackground used to generate a session id, register the background
 *    store slot under it, then call runPipeline() - which generated its OWN id for
 *    the session directory, the artifacts and result.session.sessionId. The store
 *    slot, the on-disk session and the MMKV keys therefore all disagreed, and the
 *    persistence only worked by ordering coincidence. One id must now flow through.
 *
 * 2. A failed scan left its slot marked in-flight forever, so three failures
 *    permanently disabled capture.
 *
 * runPipeline runs for real here. In the Jest environment NativeModules has no
 * ImagePreprocessor, so the vision stages bail out early and the run finishes with
 * zero detections - which is exactly the bookkeeping-only path these tests care about.
 */

import RNFS from 'react-native-fs';
import { runPipelineBackground } from '../pipelineService';
import { useBackgroundScanStore } from '../../store/useBackgroundScanStore';
import { useAppStore, storage } from '../../store/useAppStore';

const mkdirMock = RNFS.mkdir as jest.Mock;
const storageSet = storage.set as unknown as jest.Mock;

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  useBackgroundScanStore.setState({ scans: {}, completedSessions: [] });
  useAppStore.setState({ sessions: [] });
  mkdirMock.mockClear();
  storageSet.mockClear();
});

/** Keys of the form `session_meta_<id>` / `session_detections_<id>` written to MMKV. */
function persistedSessionIds(prefix: string): string[] {
  return storageSet.mock.calls
    .map((call) => String(call[0]))
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

describe('runPipelineBackground session id threading', () => {
  it('uses one id for the store slot, the session directory and the MMKV keys', async () => {
    await runPipelineBackground('file:///tmp/shelf.jpg');

    const completed = useBackgroundScanStore.getState().completedSessions;
    expect(completed).toHaveLength(1);
    const sessionId = completed[0].sessionId;
    expect(sessionId).toMatch(/^scan_\d+_[a-z0-9]+$/);

    // The session directory createSessionDir() made must carry the same id.
    const mkdirPaths = mkdirMock.mock.calls.map((call) => String(call[0]));
    expect(mkdirPaths.some((p) => p.includes(sessionId))).toBe(true);

    // ResultsScreen rehydrates from these keys, so they must match too.
    expect(persistedSessionIds('session_meta_')).toContain(sessionId);
    expect(persistedSessionIds('session_detections_')).toContain(sessionId);
  });

  it('registers the session in the app store under that same id', async () => {
    await runPipelineBackground('file:///tmp/shelf.jpg');

    const sessionId = useBackgroundScanStore.getState().completedSessions[0].sessionId;
    const sessions = useAppStore.getState().sessions;
    expect(sessions.map((s) => s.sessionId)).toContain(sessionId);
  });
});

describe('runPipelineBackground slot lifecycle', () => {
  it('clears the slot and releases the permit on success', async () => {
    await runPipelineBackground('file:///tmp/shelf.jpg');

    const state = useBackgroundScanStore.getState();
    expect(state.scans).toEqual({});
    expect(state.activeCount()).toBe(0);
  });

  it('releases the permit but keeps the error when the pipeline throws', async () => {
    // createSessionDir is the first thing runPipeline does; failing it makes the
    // whole run reject, which is the path that used to leak the slot.
    mkdirMock.mockRejectedValueOnce(new Error('disk full'));

    await runPipelineBackground('file:///tmp/shelf.jpg');

    const state = useBackgroundScanStore.getState();
    const slots = Object.values(state.scans);
    expect(slots).toHaveLength(1);
    expect(slots[0].isProcessing).toBe(false);
    expect(slots[0].error).toBeTruthy();

    // The key assertion: a failed scan must not hold a concurrency permit.
    expect(state.activeCount()).toBe(0);
  });

  it('lets three failures still leave capture available', async () => {
    mkdirMock.mockRejectedValueOnce(new Error('disk full'));
    await runPipelineBackground('file:///a.jpg');
    mkdirMock.mockRejectedValueOnce(new Error('disk full'));
    await runPipelineBackground('file:///b.jpg');
    mkdirMock.mockRejectedValueOnce(new Error('disk full'));
    await runPipelineBackground('file:///c.jpg');

    const state = useBackgroundScanStore.getState();
    expect(Object.keys(state.scans)).toHaveLength(3);
    // Before the fix this was 3, which permanently disabled the capture button.
    expect(state.activeCount()).toBe(0);

    // So a fourth scan is still accepted.
    await expect(runPipelineBackground('file:///d.jpg')).resolves.toBeUndefined();
  });

  it('still refuses a fourth genuinely concurrent scan', async () => {
    useBackgroundScanStore.getState().startScan('a');
    useBackgroundScanStore.getState().startScan('b');
    useBackgroundScanStore.getState().startScan('c');

    await expect(runPipelineBackground('file:///tmp/shelf.jpg')).rejects.toThrow(
      /Maximum background scans reached/
    );
  });
});
