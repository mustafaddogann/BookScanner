/**
 * Text Recognition Service - On-device OCR for book spine crops
 *
 * Uses native modules for OCR:
 * - iOS: Apple Vision VNRecognizeTextRequest
 * - Android: ML Kit Text Recognition
 *
 * NO network calls - all OCR is performed on-device.
 * Debug artifacts are written only when DEBUG_ARTIFACTS_ENABLED is true.
 */

import { NativeModules, Platform } from 'react-native';
import RNFS from 'react-native-fs';
import type { OCRResult, OCRSummary, TextRecognitionOptions } from '../types';
import { isArtifactWritingEnabled, getSessionDir } from './debugArtifacts';

// Get native TextRecognizer module
const TextRecognizer = NativeModules.TextRecognizer;

// Cache for availability check
let textRecognitionAvailable: boolean | null = null;
let textRecognitionMethod: string | null = null;

/**
 * Check if text recognition is available on this device
 * Results are cached for performance
 */
export async function isTextRecognitionAvailable(): Promise<{
  available: boolean;
  platform: string;
  method: string;
  reason?: string;
}> {
  if (!TextRecognizer) {
    console.log('[OCR] TextRecognizer native module not found');
    return {
      available: false,
      platform: Platform.OS,
      method: 'none',
      reason: 'Native module not linked',
    };
  }

  try {
    const result = await TextRecognizer.isTextRecognitionAvailable();
    textRecognitionAvailable = result.available;
    textRecognitionMethod = result.method;
    console.log(`[OCR] Text recognition: ${result.available ? 'AVAILABLE' : 'NOT AVAILABLE'} (${result.method})`);
    return result;
  } catch (error: any) {
    console.warn('[OCR] Failed to check text recognition availability:', error);
    textRecognitionAvailable = false;
    return {
      available: false,
      platform: Platform.OS,
      method: 'error',
      reason: error.message,
    };
  }
}

/**
 * Create an empty/skipped OCR result
 */
function createSkippedResult(reason: string): OCRResult {
  return {
    ok: false,
    skippedReason: reason,
    chosenRotation: 0,
    fullText: '',
    lines: [],
    avgConfidence: 0,
    alnumRatio: 0,
    charCount: 0,
    lineCount: 0,
    titleCandidate: null,
    authorCandidate: null,
    platform: Platform.OS as 'ios' | 'android',
  };
}

/**
 * Write OCR result to debug artifact (only if DEBUG_ARTIFACTS_ENABLED)
 */
async function writeOCRArtifact(
  sessionId: string,
  cropIndex: number,
  result: OCRResult
): Promise<void> {
  if (!isArtifactWritingEnabled()) {
    return;
  }

  try {
    const sessionDir = getSessionDir(sessionId);
    const cropsDir = `${sessionDir}/crops`;
    const ocrPath = `${cropsDir}/crop_${cropIndex}.ocr.json`;

    await RNFS.mkdir(cropsDir);
    await RNFS.writeFile(ocrPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[OCR] Wrote artifact: crop_${cropIndex}.ocr.json`);
  } catch (error: any) {
    console.warn(`[OCR] Failed to write artifact for crop ${cropIndex}:`, error.message);
  }
}

/**
 * Recognize text in a single crop image
 *
 * @param cropImagePath - Path to the crop image (file:// or absolute path)
 * @param sessionId - Session ID for artifact storage
 * @param cropIndex - Index of this crop (for naming)
 * @param options - Optional recognition options
 * @returns OCRResult with recognized text and metadata
 */
export async function recognizeCropText(
  cropImagePath: string,
  sessionId: string,
  cropIndex: number,
  options?: Partial<TextRecognitionOptions>
): Promise<OCRResult> {
  // Check availability (cached)
  if (textRecognitionAvailable === null) {
    await isTextRecognitionAvailable();
  }

  if (!textRecognitionAvailable) {
    const result = createSkippedResult(
      Platform.OS === 'android' ? 'android_mlkit_not_linked' : 'native_unavailable'
    );
    await writeOCRArtifact(sessionId, cropIndex, result);
    return result;
  }

  if (!TextRecognizer) {
    const result = createSkippedResult('native_module_not_found');
    await writeOCRArtifact(sessionId, cropIndex, result);
    return result;
  }

  // Verify crop file exists
  const cleanPath = cropImagePath.replace('file://', '');
  const exists = await RNFS.exists(cleanPath);
  if (!exists) {
    console.warn(`[OCR] Crop file not found: ${cleanPath}`);
    const result = createSkippedResult('crop_file_not_found');
    await writeOCRArtifact(sessionId, cropIndex, result);
    return result;
  }

  try {
    console.log(`[OCR] Processing crop ${cropIndex}: ${cleanPath}`);

    const recognitionOptions = {
      imagePath: cropImagePath.startsWith('file://') ? cropImagePath : `file://${cropImagePath}`,
      rotationsToTry: options?.rotationsToTry || [0, 90, 180, 270],
      recognitionLevel: options?.recognitionLevel || 'accurate',
      languages: options?.languages,
    };

    const result: OCRResult = await TextRecognizer.recognizeText(recognitionOptions);

    // Log result summary
    if (result.ok) {
      console.log(`[OCR] Crop ${cropIndex}: rotation=${result.chosenRotation}°, ` +
        `lines=${result.lineCount}, conf=${result.avgConfidence.toFixed(3)}, ` +
        `title="${result.titleCandidate || 'none'}"`);
    } else {
      console.log(`[OCR] Crop ${cropIndex}: failed - ${result.error || result.skippedReason}`);
    }

    // Write debug artifact
    await writeOCRArtifact(sessionId, cropIndex, result);

    return result;
  } catch (error: any) {
    console.error(`[OCR] Error processing crop ${cropIndex}:`, error);

    const result = createSkippedResult(`processing_error: ${error.message}`);
    await writeOCRArtifact(sessionId, cropIndex, result);
    return result;
  }
}

/**
 * Recognize text in all crops for a session
 * Processes sequentially with progress logging
 *
 * @param sessionId - Session ID
 * @param crops - Array of crop info with cropUri
 * @param onProgress - Optional callback for progress updates
 * @returns OCRSummary with all results
 */
export async function recognizeAllCrops(
  sessionId: string,
  crops: Array<{ cropUri: string | null; detectionIndex: number; rectificationMethod?: string }>,
  onProgress?: (completed: number, total: number) => void
): Promise<{
  summary: OCRSummary;
  results: Record<number, OCRResult>;
}> {
  const results: Record<number, OCRResult> = {};
  let succeeded = 0;
  let skipped = 0;
  let withTitles = 0;
  let withAuthors = 0;
  const rotationCounts: Record<number, number> = {};

  console.log(`[OCR] Processing ${crops.length} crops...`);

  // Check availability once
  if (textRecognitionAvailable === null) {
    const availability = await isTextRecognitionAvailable();
    console.log(`[OCR] Text recognition: ${availability.available ? 'ENABLED' : 'DISABLED'} (${availability.method})`);
  }

  for (let i = 0; i < crops.length; i++) {
    const crop = crops[i];

    // Report progress
    if (onProgress) {
      onProgress(i, crops.length);
    }

    // Skip if no crop URI or rectification was skipped
    if (!crop.cropUri || crop.rectificationMethod === 'skipped') {
      const result = createSkippedResult('no_crop_available');
      results[crop.detectionIndex] = result;
      skipped++;
      continue;
    }

    try {
      const result = await recognizeCropText(
        crop.cropUri,
        sessionId,
        crop.detectionIndex
      );

      results[crop.detectionIndex] = result;

      if (result.ok) {
        succeeded++;

        if (result.titleCandidate) withTitles++;
        if (result.authorCandidate) withAuthors++;

        // Track rotation counts
        rotationCounts[result.chosenRotation] = (rotationCounts[result.chosenRotation] || 0) + 1;
      } else {
        skipped++;
      }
    } catch (error: any) {
      console.error(`[OCR] Error processing crop ${crop.detectionIndex}:`, error);
      results[crop.detectionIndex] = createSkippedResult(`error: ${error.message}`);
      skipped++;
    }
  }

  // Find dominant rotation
  let dominantRotation: number | undefined;
  let maxCount = 0;
  for (const [rotation, count] of Object.entries(rotationCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantRotation = parseInt(rotation, 10);
    }
  }

  // Build summary
  const summary: OCRSummary = {
    total: crops.length,
    succeeded,
    skipped,
    withTitles,
    withAuthors,
    dominantRotation,
    completedAt: new Date().toISOString(),
  };

  // Log summary
  console.log(`[OCR] === OCR SUMMARY ===`);
  console.log(`[OCR]   Total crops: ${summary.total}`);
  console.log(`[OCR]   Succeeded: ${summary.succeeded}`);
  console.log(`[OCR]   Skipped: ${summary.skipped}`);
  console.log(`[OCR]   With titles: ${summary.withTitles}`);
  console.log(`[OCR]   With authors: ${summary.withAuthors}`);
  if (dominantRotation !== undefined) {
    console.log(`[OCR]   Dominant rotation: ${dominantRotation}°`);
  }
  console.log(`[OCR] ====================`);

  return { summary, results };
}

/**
 * Run OCR self-test on a single image
 * Useful for debugging and verification
 */
export async function runOCRSelfTest(
  imagePath: string
): Promise<{
  success: boolean;
  message: string;
  result?: OCRResult;
}> {
  console.log('[OCR] Running self-test...');

  // Check availability
  const availability = await isTextRecognitionAvailable();
  if (!availability.available) {
    return {
      success: false,
      message: `Text recognition not available: ${availability.reason || availability.method}`,
    };
  }

  // Run recognition
  try {
    const result = await recognizeCropText(imagePath, 'selftest', 0);

    if (!result.ok) {
      return {
        success: false,
        message: `OCR failed: ${result.error || result.skippedReason}`,
        result,
      };
    }

    return {
      success: true,
      message: `Self-test passed: ${result.lineCount} lines, ${result.charCount} chars, ` +
        `rotation=${result.chosenRotation}°, title="${result.titleCandidate || 'none'}"`,
      result,
    };
  } catch (error: any) {
    return {
      success: false,
      message: `Self-test error: ${error.message}`,
    };
  }
}

/**
 * Select the best title candidate from OCR results
 * Uses scoring based on confidence, character count, and alnum ratio
 */
export function selectBestTitle(
  results: Record<number, OCRResult>
): { title: string; authorCandidate: string | null; cropIndex: number } | null {
  let bestTitle: string | null = null;
  let bestAuthor: string | null = null;
  let bestCropIndex = -1;
  let bestScore = -1;

  for (const [indexStr, result] of Object.entries(results)) {
    if (!result.ok || !result.titleCandidate) continue;

    const index = parseInt(indexStr, 10);

    // Score based on confidence, char count, and alnum ratio
    const score =
      result.avgConfidence * 0.5 +
      Math.min(result.charCount / 50, 1) * 0.3 +
      result.alnumRatio * 0.2;

    if (score > bestScore) {
      bestScore = score;
      bestTitle = result.titleCandidate;
      bestAuthor = result.authorCandidate;
      bestCropIndex = index;
    }
  }

  if (bestTitle === null) {
    return null;
  }

  return {
    title: bestTitle,
    authorCandidate: bestAuthor,
    cropIndex: bestCropIndex,
  };
}
