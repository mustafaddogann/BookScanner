/**
 * Auto Export Service
 *
 * Automatically exports rejected books for analysis.
 * 1. Saves locally to Documents folder
 * 2. Uploads to Mac server if configured (for ClawdBot integration)
 */

import RNFS from 'react-native-fs';
import { MMKV } from 'react-native-mmkv';
import type { BookCandidate } from '../types';

// Local export directory (accessible via Files app)
const LOCAL_EXPORT_DIR = `${RNFS.DocumentDirectoryPath}/RejectsExports`;

// Storage keys
const SERVER_URL_KEY = 'clawdbot_server_url';
const LAST_IMAGE_URI_KEY = 'last_scanned_image_uri';
const AUTO_RESCAN_ENABLED_KEY = 'auto_rescan_enabled';
const AUTO_RESCAN_MIGRATED_KEY = 'auto_rescan_migrated_v2';

// MMKV storage instance
const storage = new MMKV({ id: 'bookscanner-autoexport' });

// Migration: Force auto-retry ON for existing users (runs once)
try {
  if (!storage.getBoolean(AUTO_RESCAN_MIGRATED_KEY)) {
    storage.set(AUTO_RESCAN_ENABLED_KEY, true);
    storage.set(AUTO_RESCAN_MIGRATED_KEY, true);
    console.log('[AutoExport] Migrated: Auto-retry enabled by default');
  }
} catch (e) {
  console.warn('[AutoExport] Migration failed:', e);
}

// Minimum rejects to trigger auto-export
const MIN_REJECTS_FOR_EXPORT = 1;

// Polling interval for rescan status (30 seconds)
const RESCAN_POLL_INTERVAL_MS = 30000;

// Rescan polling state
let rescanPollTimer: ReturnType<typeof setInterval> | null = null;
let rescanCallback: ((imageUri: string) => void) | null = null;

/**
 * Get the configured server URL for uploads.
 */
export function getServerUrl(): string | null {
  try {
    return storage.getString(SERVER_URL_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Set the server URL for uploads.
 */
export function setServerUrl(url: string | null): void {
  try {
    if (url) {
      storage.set(SERVER_URL_KEY, url);
    } else {
      storage.delete(SERVER_URL_KEY);
    }
  } catch (error) {
    console.warn('[AutoExport] Failed to save server URL:', error);
  }
}

/**
 * Auto-export rejected books for debugging analysis.
 *
 * Non-blocking - errors are logged but don't affect the main flow.
 * 1. Saves locally to Documents folder
 * 2. Uploads to Mac server if configured
 */
export async function autoExportRejects(
  sessionId: string,
  candidates: BookCandidate[]
): Promise<void> {
  try {
    // Export everything that's NOT accept or suggested
    // This matches the Results screen "Reject" filter exactly
    const problemBooks = candidates.filter((c) => {
      const decision = c.resolverDecision;
      // Only accept and suggested are "good" - everything else is a problem
      return decision !== 'accept' && decision !== 'suggested';
    });

    if (problemBooks.length < MIN_REJECTS_FOR_EXPORT) {
      console.log(`[AutoExport] Skipping - only ${problemBooks.length} problem books (min: ${MIN_REJECTS_FOR_EXPORT})`);
      return;
    }

    // Separate into categories for analysis
    const rejects = problemBooks.filter((c) => c.resolverDecision === 'reject');
    const pending = problemBooks.filter((c) => c.resolverDecision === 'pending' || !c.resolverDecision);
    const errors = problemBooks.filter((c) => c.resolverDecision === 'error');
    const offline = problemBooks.filter((c) => c.resolverDecision === 'offline' || c.resolverDecision === 'disabled');
    const other = problemBooks.filter((c) => {
      const d = c.resolverDecision;
      return d !== 'reject' && d !== 'pending' && d !== 'error' && d !== 'offline' && d !== 'disabled' && d;
    });

    // Ensure export directory exists
    const exportDir = LOCAL_EXPORT_DIR;
    const dirExists = await RNFS.exists(exportDir);
    if (!dirExists) {
      await RNFS.mkdir(exportDir);
    }

    // Build export data - send ALL problem books, not just explicit rejects
    const exportData = {
      sessionId,
      exportedAt: new Date().toISOString(),
      autoExport: true,
      totalBooks: candidates.length,
      // Problem book breakdown - matches Results screen "Reject" count
      rejectCount: problemBooks.length,
      explicitRejectCount: rejects.length,
      pendingCount: pending.length,
      errorCount: errors.length,
      offlineCount: offline.length,
      otherCount: other.length,
      acceptCount: candidates.filter((c) => c.resolverDecision === 'accept').length,
      suggestedCount: candidates.filter((c) => c.resolverDecision === 'suggested').length,
      // Send ALL problem books as "rejects" for Telegram analysis
      rejects: problemBooks.map((candidate, idx) => {
        // Determine problem category based on decision
        const decision = candidate.resolverDecision;
        const confidence = candidate.resolvedConfidence ?? 0;
        let problemCategory = decision || 'no_decision';

        return {
          bookNumber: idx + 1,
          id: candidate.id,
          problemCategory,
          resolvedConfidence: confidence,
          mergedText: candidate.evidence?.mergedTextBlock || '',
          // DEBUG: Add mergedLines to see if it differs from mergedText
          mergedLinesCount: candidate.evidence?.mergedLines?.length || 0,
          mergedLinesTexts: candidate.evidence?.mergedLines?.map((l) => l.text) || [],
          resolverDecision: candidate.resolverDecision,
          resolverDecisionReason: candidate.resolverDecisionReason,
          evidenceSearchDebug: candidate.evidenceSearchDebug,
          hypothesis: candidate.hypothesis,
          // DEBUG: Add perFieldHints if available
          perFieldHints: candidate.evidence?.perFieldHints,
        };
      }),
    };

    // Save locally
    const filename = `rejects_${sessionId}_${Date.now()}.json`;
    const filepath = `${exportDir}/${filename}`;
    await RNFS.writeFile(filepath, JSON.stringify(exportData, null, 2), 'utf8');
    console.log(`[AutoExport] Saved ${problemBooks.length} problem books locally: ${filename} (reject: ${rejects.length}, pending: ${pending.length}, error: ${errors.length}, offline: ${offline.length}, other: ${other.length})`);

    // Try to upload to server
    const serverUrl = getServerUrl();
    if (serverUrl) {
      await uploadToServer(serverUrl, exportData);
      // Also upload the scan image for persistence across app rebuilds
      await uploadScanImageToServer(sessionId);
    }

    // Clean up old exports (keep last 10)
    await cleanupOldExports(exportDir, 10);
  } catch (error: any) {
    // Non-blocking - just log the error
    console.warn('[AutoExport] Failed to export rejects:', error.message);
  }
}

/**
 * Upload export data to the Mac server.
 */
async function uploadToServer(serverUrl: string, data: object): Promise<void> {
  try {
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`[AutoExport] Uploaded to server: ${result.filename}`);
    } else {
      console.warn(`[AutoExport] Server upload failed: ${response.status}`);
    }
  } catch (error: any) {
    console.warn(`[AutoExport] Server upload error: ${error.message}`);
  }
}

/**
 * Upload scan image to Mac server for persistence across app rebuilds.
 */
export async function uploadScanImageToServer(sessionId: string): Promise<boolean> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    console.log('[AutoExport] No server URL, skipping image upload');
    return false;
  }

  const imageUri = getLastScannedImageUri();
  if (!imageUri) {
    console.log('[AutoExport] No image URI to upload');
    return false;
  }

  try {
    // Read image as base64
    const filePath = imageUri.replace('file://', '');
    const exists = await RNFS.exists(filePath);
    if (!exists) {
      console.warn('[AutoExport] Image file does not exist:', filePath);
      return false;
    }

    const imageBase64 = await RNFS.readFile(filePath, 'base64');
    console.log(`[AutoExport] Read image for upload: ${(imageBase64.length / 1024).toFixed(1)} KB`);

    // Upload to server
    const baseUrl = serverUrl.replace(/\/upload$/, '');
    const response = await fetch(`${baseUrl}/upload-scan-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId,
        imageBase64,
      }),
    });

    if (response.ok) {
      console.log('[AutoExport] Scan image uploaded to server');
      return true;
    } else {
      console.warn(`[AutoExport] Image upload failed: ${response.status}`);
      return false;
    }
  } catch (error: any) {
    console.warn(`[AutoExport] Image upload error: ${error.message}`);
    return false;
  }
}

/**
 * Download scan image from Mac server.
 * Returns the local file path if successful, null otherwise.
 */
export async function downloadScanImageFromServer(sessionId: string): Promise<string | null> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    console.log('[AutoExport] No server URL, cannot download image');
    return null;
  }

  try {
    const baseUrl = serverUrl.replace(/\/upload$/, '');
    const imageUrl = `${baseUrl}/scan-image/${sessionId}`;

    console.log('[AutoExport] Downloading scan image from server...');

    // Download to temp file
    const tempPath = `${RNFS.TemporaryDirectoryPath}/rescan_${sessionId}_${Date.now()}.jpg`;
    const downloadResult = await RNFS.downloadFile({
      fromUrl: imageUrl,
      toFile: tempPath,
    }).promise;

    if (downloadResult.statusCode === 200) {
      const fileUri = `file://${tempPath}`;
      console.log('[AutoExport] Scan image downloaded:', tempPath);
      // Update stored URI to point to downloaded file
      setLastScannedImageUri(fileUri);
      return fileUri;
    } else if (downloadResult.statusCode === 404) {
      console.log('[AutoExport] Scan image not found on server');
      return null;
    } else {
      console.warn(`[AutoExport] Image download failed: ${downloadResult.statusCode}`);
      return null;
    }
  } catch (error: any) {
    console.warn(`[AutoExport] Image download error: ${error.message}`);
    return null;
  }
}

/**
 * Check if the server has signaled a rescan.
 * Returns true if app should trigger a rescan.
 */
export async function checkRescanStatus(): Promise<{
  rescan: boolean;
  reason: string | null;
  auto_retry?: boolean;
  session_id?: string | null;
  latestAnalysis?: {
    sessionId: string | null;
    rejectCount: number;
    fixable: boolean;
  };
}> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { rescan: false, reason: null };
  }

  try {
    // Convert upload URL to rescan-status URL
    // e.g., http://10.0.0.233:8765/upload -> http://10.0.0.233:8765/rescan-status
    const baseUrl = serverUrl.replace(/\/upload$/, '');
    const response = await fetch(`${baseUrl}/rescan-status`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.ok) {
      const result = await response.json();
      console.log('[AutoExport] Rescan status:', result);
      return result;
    } else {
      console.warn(`[AutoExport] Rescan status check failed: ${response.status}`);
      return { rescan: false, reason: null };
    }
  } catch (error: any) {
    console.warn(`[AutoExport] Rescan status check error: ${error.message}`);
    return { rescan: false, reason: null };
  }
}

/**
 * Store the last scanned image URI for auto-rescan.
 */
export function setLastScannedImageUri(uri: string): void {
  try {
    storage.set(LAST_IMAGE_URI_KEY, uri);
    console.log('[AutoExport] Stored last image URI for rescan');
  } catch (error) {
    console.warn('[AutoExport] Failed to store image URI:', error);
  }
}

/**
 * Get the last scanned image URI.
 */
export function getLastScannedImageUri(): string | null {
  try {
    return storage.getString(LAST_IMAGE_URI_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Clear the last scanned image URI.
 * Called when the stored file no longer exists (e.g., after app reinstall).
 */
export function clearLastScannedImageUri(): void {
  try {
    storage.delete(LAST_IMAGE_URI_KEY);
    console.log('[AutoExport] Cleared last image URI');
  } catch (error) {
    console.warn('[AutoExport] Failed to clear image URI:', error);
  }
}

/**
 * Check if auto-rescan is enabled.
 * Default is TRUE - auto-retry is on by default.
 */
export function isAutoRescanEnabled(): boolean {
  try {
    return storage.getBoolean(AUTO_RESCAN_ENABLED_KEY) ?? true;
  } catch {
    return true;
  }
}

/**
 * Enable or disable auto-rescan polling.
 */
export function setAutoRescanEnabled(enabled: boolean): void {
  try {
    storage.set(AUTO_RESCAN_ENABLED_KEY, enabled);
    if (enabled) {
      console.log('[AutoExport] Auto-rescan enabled');
    } else {
      console.log('[AutoExport] Auto-rescan disabled');
      stopRescanPolling();
    }
  } catch (error) {
    console.warn('[AutoExport] Failed to set auto-rescan:', error);
  }
}

/**
 * Start polling for rescan signals.
 * When a rescan signal is received, the callback will be called with the image URI.
 */
export function startRescanPolling(onRescan: (imageUri: string) => void): void {
  if (rescanPollTimer) {
    console.log('[AutoExport] Rescan polling already active');
    return;
  }

  rescanCallback = onRescan;
  console.log('[AutoExport] Starting rescan polling...');

  const poll = async () => {
    if (!isAutoRescanEnabled()) {
      console.log('[AutoExport] Auto-rescan disabled, stopping poll');
      stopRescanPolling();
      return;
    }

    try {
      const status = await checkRescanStatus();
      if (status.rescan && status.auto_retry) {
        console.log('[AutoExport] Rescan signal received:', status.reason);
        const imageUri = getLastScannedImageUri();
        if (imageUri && rescanCallback) {
          console.log('[AutoExport] Triggering auto-rescan with:', imageUri);
          rescanCallback(imageUri);
        } else {
          console.warn('[AutoExport] No image URI stored for rescan');
        }
      }
    } catch (error) {
      console.warn('[AutoExport] Poll error:', error);
    }
  };

  // Initial poll after short delay
  setTimeout(poll, 5000);

  // Regular polling
  rescanPollTimer = setInterval(poll, RESCAN_POLL_INTERVAL_MS);
}

/**
 * Stop rescan polling.
 */
export function stopRescanPolling(): void {
  if (rescanPollTimer) {
    clearInterval(rescanPollTimer);
    rescanPollTimer = null;
    rescanCallback = null;
    console.log('[AutoExport] Rescan polling stopped');
  }
}

/**
 * Clean up old export files, keeping only the most recent N files.
 */
async function cleanupOldExports(dir: string, keepCount: number): Promise<void> {
  try {
    const files = await RNFS.readDir(dir);
    const rejectFiles = files
      .filter((f) => f.name.startsWith('rejects_') && f.name.endsWith('.json'))
      .sort((a, b) => (b.mtime?.getTime() || 0) - (a.mtime?.getTime() || 0));

    // Delete older files beyond keepCount
    for (let i = keepCount; i < rejectFiles.length; i++) {
      await RNFS.unlink(rejectFiles[i].path);
      console.log(`[AutoExport] Cleaned up old export: ${rejectFiles[i].name}`);
    }
  } catch (error: any) {
    console.warn('[AutoExport] Cleanup failed:', error.message);
  }
}
