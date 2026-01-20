/**
 * Pipeline Service - Orchestrates the full detection pipeline
 *
 * STRICT MODE: No automatic fallbacks. Real model inference only.
 *
 * Pipeline stages:
 * 1. acquisition - Load/capture image
 * 2. meta - Extract image metadata
 * 3. letterbox - Prepare image for model input
 * 4. inference - Run YOLOv8 OBB detection
 * 5. postprocess - Decode and map detections
 * 6. overlay-prep - Prepare overlay data
 * 7. rectification - Generate crop images
 */

import { Image, NativeModules, Platform } from 'react-native';
import RNFS from 'react-native-fs';
import type {
  ImageMeta,
  ScanSession,
  OBBDetection,
  LetterboxParams,
  RectifyResult,
  DebugManifest,
  RawModelOutput,
  InputTensorMeta,
  PipelineOptions,
  PipelineMode,
  SavedTensor,
  NativeLetterboxTruth,
} from '../types';
import type { ImageSource } from './imageSource';
import {
  CameraSource,
  FixtureSource,
  createReplaySource,
  isReplaySource,
} from './imageSource';
import {
  setArtifactWritingEnabled,
  isArtifactWritingEnabled,
} from './debugArtifacts';
import { DEBUG_ARTIFACTS_ENABLED } from '../config/debug';

// Native image preprocessor module
const { ImagePreprocessor } = NativeModules;
const hasNativePreprocessor = !!ImagePreprocessor;

console.log(`[Pipeline] Native ImagePreprocessor available: ${hasNativePreprocessor}`);
import { resizeWithLetterbox } from '../utils/letterbox';
import { PipelineTimer } from '../utils/timing';
import {
  type FrameGeo,
  buildFrameGeo,
  normalizeFileUri,
  runCoordinateRoundtripTest,
  serializeFrameGeo,
} from '../utils/frameGeo';
import {
  loadModel,
  inspectModel,
  runInference,
  runInferenceRaw,
  getModelIOContract,
  isModelReady,
  getModelInputSize,
  isMockModel,
  preprocessImage,
  runPostprocess,
  getPostprocessConfig,
  setPostprocessConfig,
  computeTensorStats,
  extractRawSampleAnchors,
  getDecodeModeComparison,
  buildPreprocessDebug,
  analyzeDecodeMode,
  runDiagnosticDecode,
  runFullDiagnostics,
  getDecodeMode,
  isSigmoidEnabled,
  DEBUG_ALIGNMENT_PRESET,
  SPINE_PRESET,
  LIVE_PREVIEW_PRESET,
} from './inferenceService';
import { rectifyAll } from './rectificationService';
import { recognizeAllCrops, isTextRecognitionAvailable } from './textRecognitionService';
import {
  createSessionDir,
  writeDebugManifest,
  writeCoordinateTest,
  writeAngleTest,
  buildDebugManifest,
  copyOriginalImage,
  writeAllArtifacts,
  appendWriteError,
  getSessionDir,
  writeInputNormalized,
  createDisplayImage,
  writeInputTensorArtifacts,
  buildLetterboxMeta,
  writeLetterboxMeta,
  writeSourceDecodeStats,
  writeLetterbox640Preview,
  computeScoreSanityStats,
  writeScoreSanity,
  buildNMSWitnessData,
  writeNMSWitness,
  writeModelSpaceOverlays,
  validateLetterboxConsistency,
  writeLetterboxInconsistent,
  writeJsonAtomic,
  writeRectificationDebugOverlay,
  writeCropQualityAnalysis,
  type AllArtifactsData,
  type FilteredDetectionsData,
  type PreprocessDebug,
  type SourceDecodeStats,
  type ScoreSanityStats,
  type NMSWitnessData,
  type RectificationOverlayDetection,
} from './debugArtifacts';
import { buildImageMetaFromUri } from './imageService';
import { useAppStore } from '../store/useAppStore';
import { generateCoordinateTestArtifact } from '../utils/letterbox';

// DEBUG FLAG: Set to true ONLY to bypass model requirement during UI development
// MUST be false for any real testing or production
const DEBUG_GENERATE_FAKE_DETECTIONS = false;

/**
 * Base64 decode helper (atob may not be available in React Native)
 */
function base64Decode(base64: string): Uint8Array {
  const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < base64Chars.length; i++) {
    lookup[base64Chars.charCodeAt(i)] = i;
  }

  // Remove padding
  let len = base64.length;
  if (base64[len - 1] === '=') len--;
  if (base64[len - 1] === '=') len--;

  const bytes = new Uint8Array(Math.floor(len * 3 / 4));
  let p = 0;

  for (let i = 0; i < len; i += 4) {
    const c0 = lookup[base64.charCodeAt(i)];
    const c1 = lookup[base64.charCodeAt(i + 1)];
    const c2 = i + 2 < len ? lookup[base64.charCodeAt(i + 2)] : 0;
    const c3 = i + 3 < len ? lookup[base64.charCodeAt(i + 3)] : 0;

    bytes[p++] = (c0 << 2) | (c1 >> 4);
    if (i + 2 < len) bytes[p++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (i + 3 < len) bytes[p++] = ((c2 & 0x03) << 6) | c3;
  }

  return bytes;
}

interface PipelineResult {
  session: ScanSession;
  imageMeta: ImageMeta;
  detections: OBBDetection[];
  letterboxParams: LetterboxParams;
  rectification?: RectifyResult[];
  manifest: DebugManifest;
  errors: string[];
}

/**
 * Run the full detection pipeline on an image
 */
export async function runPipeline(
  imageUri: string,
  source: 'camera' | 'fixture',
  fixtureName?: string
): Promise<PipelineResult> {
  const timer = new PipelineTimer();
  const errors: string[] = [];
  const sessionId = `scan_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  console.log(`[Pipeline] Starting pipeline for session ${sessionId}`);
  console.log(`[Pipeline] Source: ${source}, Image: ${imageUri}`);

  // Update store
  const store = useAppStore.getState();
  store.setProcessing(true, 'initialization');

  // Track raw output and diagnostic results for artifacts
  let rawOutput: RawModelOutput | undefined;
  let diagResult: ReturnType<typeof runDiagnosticDecode> | undefined;
  let postprocessStats: ReturnType<typeof runPostprocess>['stats'] | undefined;
  let postprocessResult: ReturnType<typeof runPostprocess> | undefined;
  let scoreSanityStats: ScoreSanityStats | undefined;

  // Track orientation normalization info
  let normalizedImagePath: string | undefined;
  let rotationApplied: number = 0;

  // Track input tensor metadata for manifest
  let inputTensorMeta: InputTensorMeta | undefined;

  // SINGLE SOURCE OF TRUTH: FrameGeo captures all geometry at capture time
  let frameGeo: FrameGeo | undefined;

  // Track display image for UI rendering (downscaled to avoid PERF ASSETS warnings)
  let displayImagePath: string | undefined;
  let displayImageScale: number = 1.0;

  try {
    // Create session directory
    const sessionDir = await createSessionDir(sessionId);

    // Copy original image to session
    await copyOriginalImage(sessionId, imageUri);

    // STAGE 1: Meta
    timer.startStage('meta');
    store.setProcessing(true, 'meta');

    // Normalize URI FIRST - single format everywhere
    const normalizedUri = normalizeFileUri(imageUri);
    console.log(`[Pipeline] Normalized URI: ${normalizedUri.slice(0, 60)}...`);

    const imageMeta = await buildImageMetaFromUri(normalizedUri);
    console.log(`[Pipeline] Image: ${imageMeta.width}x${imageMeta.height}, EXIF orientation: ${imageMeta.orientation}`);

    // Write input_normalized.jpg (for deterministic inference)
    const normalizedResult = await writeInputNormalized(
      sessionId,
      normalizedUri,
      imageMeta.orientation
    );
    normalizedImagePath = normalizedResult.path;
    rotationApplied = normalizedResult.rotationApplied;
    console.log(`[Pipeline] Normalized image: ${normalizedImagePath} (rotation applied: ${rotationApplied}°)`);

    // Create display.jpg - downscaled for UI rendering to avoid PERF ASSETS warnings
    // Max dimension 1280px is sufficient for most phone screens
    const displayResult = await createDisplayImage(sessionId, normalizedImagePath, 1280, 0.85);
    if (displayResult) {
      displayImagePath = displayResult.path;
      displayImageScale = displayResult.scale;
      console.log(`[Pipeline] Display image: ${displayImagePath} (scale: ${displayImageScale.toFixed(3)})`);
    } else {
      // Fall back to normalized image if display creation fails
      displayImagePath = normalizedImagePath;
      displayImageScale = 1.0;
      console.log('[Pipeline] Display image creation failed, using normalized image');
    }

    timer.endStage('meta');

    // STAGE 2: Letterbox - BUILD FRAMEGEO AS SINGLE SOURCE OF TRUTH
    timer.startStage('letterbox');
    store.setProcessing(true, 'letterbox');

    // Build FrameGeo - this is THE ONLY place we compute letterbox params
    // All subsequent operations MUST use frameGeo.letterbox
    const modelSize = getModelInputSize();
    frameGeo = buildFrameGeo(
      normalizedUri,
      imageMeta.width,
      imageMeta.height,
      imageMeta.orientation,
      modelSize
    );

    // Extract letterbox for compatibility with existing code
    const letterboxParams = frameGeo.letterbox;
    console.log(`[Pipeline] FrameGeo created: ${frameGeo.pixelW}x${frameGeo.pixelH}, letterbox scale=${letterboxParams.scale.toFixed(3)}, pad=(${letterboxParams.padX}, ${letterboxParams.padY})`);

    // GATE: Run round-trip coordinate test - MUST pass before we proceed
    const roundtripTest = runCoordinateRoundtripTest(frameGeo);
    if (!roundtripTest.passed) {
      const errMsg = `COORDINATE ROUNDTRIP TEST FAILED: max error ${roundtripTest.maxError.toFixed(4)}px (limit 1.0px)`;
      console.error(`[Pipeline] ${errMsg}`);
      errors.push(errMsg);
      // Write test results for debugging (only if artifacts enabled)
      if (DEBUG_ARTIFACTS_ENABLED) {
        try {
          await RNFS.writeFile(
            `${sessionDir}/coordinate_roundtrip.json`,
            JSON.stringify(roundtripTest, null, 2),
            'utf8'
          );
        } catch {}
      }
      // Note: We continue despite failure so artifacts are written for debugging
    } else {
      console.log(`[Pipeline] Coordinate roundtrip test PASSED (max error: ${roundtripTest.maxError.toFixed(4)}px)`);
    }

    timer.endStage('letterbox');

    // Write coordinate test artifact (Gate 2) - uses ACTUAL FrameGeo
    try {
      // Include both the legacy format AND the new FrameGeo roundtrip results
      const coordTest = {
        ...generateCoordinateTestArtifact(letterboxParams),
        frameGeoRoundtrip: {
          passed: roundtripTest.passed,
          maxError: roundtripTest.maxError,
          numPoints: roundtripTest.points.length,
          frameGeoSummary: roundtripTest.frameGeoSummary,
          // Include first 5 points for debugging
          samplePoints: roundtripTest.points.slice(0, 5),
        },
        frameGeo: serializeFrameGeo(frameGeo),
      };
      await writeCoordinateTest(sessionId, coordTest);
    } catch (coordError: any) {
      const errMsg = `Coordinate test write failed: ${coordError.message}`;
      console.error(`[Pipeline] ${errMsg}`, coordError.stack);
      errors.push(errMsg);
      await appendWriteError(sessionDir, `${errMsg}\n${coordError.stack || ''}`);
    }

    // STAGE 3: Model Loading & Inspection (Gate 3)
    timer.startStage('inference');
    store.setProcessing(true, 'model-loading');

    let detections: OBBDetection[] = [];

    try {
      // Load model - this will FAIL if model is missing (unless DEBUG flag is set)
      if (!isModelReady()) {
        await loadModel();
        await inspectModel(sessionId);
      }

      // Check if we're using mock model
      if (isMockModel()) {
        const msg = 'Pipeline using MOCK MODEL - no real detections possible';
        console.warn(`[Pipeline] ${msg}`);
        errors.push(msg);

        if (DEBUG_GENERATE_FAKE_DETECTIONS) {
          console.warn('[Pipeline] DEBUG_GENERATE_FAKE_DETECTIONS=true, generating fake detections');
          detections = generateDebugDetections(imageMeta.width, imageMeta.height);
        }
      } else {
        // Real model inference
        store.setProcessing(true, 'inference');

        const PADDING_FILL_VALUE_UINT8 = 114;  // Gray padding (pre-normalization)
        const PADDING_FILL_VALUE = PADDING_FILL_VALUE_UINT8 / 255;  // Normalized
        const tensorShape: [number, number, number, number] = [1, 640, 640, 3];  // NHWC format
        let inputTensor: Float32Array;

        // ================================================================
        // STEP 1: Decode source image and verify it has real pixels
        // ================================================================
        if (!hasNativePreprocessor) {
          throw new Error('INPUT_TENSOR_EMPTY: Native ImagePreprocessor not available. Cannot decode image.');
        }

        console.log('[Pipeline] STEP 1: Decoding source image...');

        // HARD GUARD: Verify file exists before decode attempt
        const fsPath = normalizedUri.startsWith('file://') ? normalizedUri.slice(7) : normalizedUri;
        const fileExists = await RNFS.exists(fsPath);
        console.log(`[Pipeline] File existence check: exists=${fileExists}, path=${fsPath}`);
        if (!fileExists) {
          throw new Error(`[Preprocess] file missing. uri=${normalizedUri} path=${fsPath}`);
        }

        let decodeStats: SourceDecodeStats;
        try {
          decodeStats = await ImagePreprocessor.getImageDecodeStats(normalizedUri);

          // Write source_decode_stats.json (GUARANTEED)
          await writeSourceDecodeStats(sessionId, decodeStats);

          // HARD GATE: Abort if decode failed
          if (decodeStats.byteLength === 0) {
            throw new Error(`INPUT_TENSOR_EMPTY: Source decode byteLength=0`);
          }
          if (decodeStats.globalMax === 0) {
            throw new Error(`INPUT_TENSOR_EMPTY: Source decode globalMax=0 (image is all black)`);
          }

          console.log(`[Pipeline] Source decode OK: ${decodeStats.width}x${decodeStats.height}, range=[${decodeStats.globalMin}, ${decodeStats.globalMax}]`);
        } catch (decodeError: any) {
          const errMsg = `Source decode failed: ${decodeError.message}`;
          console.error(`[Pipeline] ${errMsg}`);
          errors.push(errMsg);
          throw new Error(`INPUT_TENSOR_EMPTY: ${errMsg}`);
        }

        // ================================================================
        // STEP 2: Preprocess with letterbox (native module)
        // ================================================================
        console.log('[Pipeline] STEP 2: Preprocessing with letterbox...');
        try {
          const preprocessResult = await ImagePreprocessor.preprocessForTFLite(
            normalizedUri,
            640,  // targetSize
            PADDING_FILL_VALUE_UINT8  // paddingValue
          );

          // HARD GUARD: preprocessResult must exist
          if (!preprocessResult) {
            throw new Error(`[Preprocess] preprocessForTFLite returned undefined. uri=${normalizedUri}`);
          }

          // ================================================================
          // STEP 3: Write letterbox_640_preview.jpg (BEFORE float normalization)
          // ================================================================
          console.log('[Pipeline] STEP 3: Writing letterbox_640_preview.jpg...');
          try {
            const previewPath = `${sessionDir}/letterbox_640_preview.jpg`;
            await ImagePreprocessor.savePreviewImage(
              preprocessResult.previewBase64RGBA,
              640,
              640,
              previewPath
            );
            console.log(`[Pipeline] Wrote letterbox_640_preview.jpg`);
          } catch (previewError: any) {
            console.error(`[Pipeline] Failed to write letterbox_640_preview: ${previewError.message}`);
            errors.push(`letterbox_640_preview failed: ${previewError.message}`);
          }

          // ================================================================
          // STEP 4: Decode float32 tensor from base64
          // ================================================================
          console.log('[Pipeline] STEP 4: Decoding float32 tensor...');
          const tensorBase64 = preprocessResult.tensorBase64;
          const tensorBytes = base64Decode(tensorBase64);
          inputTensor = new Float32Array(tensorBytes.buffer);

          // Verify tensor size
          const expectedSize = 640 * 640 * 3;
          if (inputTensor.length !== expectedSize) {
            throw new Error(`INPUT_TENSOR_EMPTY: Tensor size mismatch: got ${inputTensor.length}, expected ${expectedSize}`);
          }

          // ================================================================
          // STEP 5: Verify tensor has real data (HARD GATE)
          // ================================================================
          const tensorStats = preprocessResult.tensorStats;
          console.log(`[Pipeline] Tensor stats from native: min=${tensorStats.min.toFixed(4)}, max=${tensorStats.max.toFixed(4)}, mean=${tensorStats.mean.toFixed(4)}, std=${tensorStats.std.toFixed(4)}`);

          // HARD GATE: Abort if tensor is constant (all zeros or all same value)
          if (tensorStats.std === 0) {
            // Write artifacts before aborting
            await writeInputTensorArtifacts(sessionId, inputTensor, tensorShape, PADDING_FILL_VALUE, 'RGB');
            throw new Error(`INPUT_TENSOR_EMPTY: tensor std=0 (constant value, likely all zeros)`);
          }
          if (tensorStats.max === 0) {
            await writeInputTensorArtifacts(sessionId, inputTensor, tensorShape, PADDING_FILL_VALUE, 'RGB');
            throw new Error(`INPUT_TENSOR_EMPTY: tensor max=0 (all zeros)`);
          }

          console.log(`[Pipeline] ✓ Tensor verification passed: non-constant data with std=${tensorStats.std.toFixed(4)}`);

          // ================================================================
          // NATIVE TRUTH: Use native values for letterbox params
          // Falls back to legacy `letterbox` object if `nativeTruth` is not available
          // (e.g., when running on older native build without nativeTruth support)
          // ================================================================
          let nativeTruth: NativeLetterboxTruth;

          if (preprocessResult.nativeTruth) {
            // Use nativeTruth (preferred - newer native builds)
            nativeTruth = preprocessResult.nativeTruth;
            console.log('[Pipeline] Using nativeTruth from preprocessing');
          } else if (preprocessResult.letterbox) {
            // Fall back to legacy letterbox object (older native builds)
            console.log('[Pipeline] ⚠️  nativeTruth not available, falling back to letterbox');
            const lb = preprocessResult.letterbox;
            nativeTruth = {
              decodedW: lb.srcWidth,
              decodedH: lb.srcHeight,
              modelSize: lb.dstWidth,  // Assume square (640x640)
              scale: lb.scale,
              newW: Math.round(lb.srcWidth * lb.scale),
              newH: Math.round(lb.srcHeight * lb.scale),
              padX: lb.padX,
              padY: lb.padY,
            };
          } else {
            // Neither available - this is a fatal error
            throw new Error(
              `[Preprocess] Neither nativeTruth nor letterbox available. preprocessResult keys=${Object.keys(preprocessResult).join(',')}`
            );
          }

          // Validate nativeTruth dimensions
          if (!Number.isFinite(nativeTruth.decodedW) || !Number.isFinite(nativeTruth.decodedH)) {
            throw new Error(
              `[Preprocess] nativeTruth has invalid dimensions. decodedW=${nativeTruth.decodedW}, decodedH=${nativeTruth.decodedH}`
            );
          }

          console.log('[Pipeline] Native truth from preprocessing:');
          console.log(`[Pipeline]   decodedW=${nativeTruth.decodedW}, decodedH=${nativeTruth.decodedH}`);
          console.log(`[Pipeline]   modelSize=${nativeTruth.modelSize}, scale=${nativeTruth.scale.toFixed(6)}`);
          console.log(`[Pipeline]   newW=${nativeTruth.newW}, newH=${nativeTruth.newH}`);
          console.log(`[Pipeline]   padX=${nativeTruth.padX}, padY=${nativeTruth.padY}`);

          // ================================================================
          // HARD INVARIANT: Validate letterbox geometry consistency
          // ================================================================
          const inconsistency = validateLetterboxConsistency(nativeTruth);
          if (inconsistency) {
            // Write the inconsistency artifact before throwing
            await writeLetterboxInconsistent(sessionId, inconsistency);
            throw new Error(inconsistency.reason);
          }
          console.log('[Pipeline] ✓ Letterbox geometry consistency validated');

          // Update letterboxParams from native truth
          letterboxParams.srcWidth = nativeTruth.decodedW;
          letterboxParams.srcHeight = nativeTruth.decodedH;
          letterboxParams.dstWidth = nativeTruth.modelSize;
          letterboxParams.dstHeight = nativeTruth.modelSize;
          letterboxParams.scale = nativeTruth.scale;
          letterboxParams.padX = nativeTruth.padX;
          letterboxParams.padY = nativeTruth.padY;

          // ================================================================
          // STEP 6: Write input tensor artifacts (GUARANTEED)
          // ================================================================
          console.log('[Pipeline] STEP 6: Writing input tensor artifacts...');
          const tensorArtifacts = await writeInputTensorArtifacts(
            sessionId,
            inputTensor,
            tensorShape,
            PADDING_FILL_VALUE,
            'RGB'
          );
          if (tensorArtifacts.errors.length > 0) {
            errors.push(...tensorArtifacts.errors.map(e => `Input tensor artifact: ${e}`));
          }

          // Set inputTensorMeta for debug manifest
          inputTensorMeta = {
            inputTensorStatsPath: tensorArtifacts.statsPath,
            inputTensorPreviewPath: tensorArtifacts.previewPath,
            paddingFillValue: PADDING_FILL_VALUE,
            channelOrder: 'RGB',
            normalizationMethod: 'divide_255',
            tensorShape,
            tensorFormat: 'NHWC',
          };

          // Write letterbox metadata using NATIVE TRUTH values
          const letterboxMeta = {
            ...buildLetterboxMeta(letterboxParams, PADDING_FILL_VALUE_UINT8),
            // Override with explicit native truth
            inputWidth: nativeTruth.decodedW,
            inputHeight: nativeTruth.decodedH,
            nativeTruth,  // Include full native truth for debugging
          };
          await writeLetterboxMeta(sessionId, letterboxMeta);

          // ================================================================
          // UPDATE FRAMEGEO: Rebuild with native truth dimensions
          // ================================================================
          // Check if native decoded dimensions differ from JS imageMeta
          if (frameGeo && (frameGeo.pixelW !== nativeTruth.decodedW || frameGeo.pixelH !== nativeTruth.decodedH)) {
            console.log('[Pipeline] ⚠️ Native decoded dimensions differ from JS imageMeta:');
            console.log(`[Pipeline]   JS imageMeta: ${imageMeta.width}x${imageMeta.height}`);
            console.log(`[Pipeline]   JS frameGeo: ${frameGeo.pixelW}x${frameGeo.pixelH}`);
            console.log(`[Pipeline]   Native truth: ${nativeTruth.decodedW}x${nativeTruth.decodedH}`);
            console.log('[Pipeline]   Rebuilding frameGeo with native truth...');

            // Rebuild FrameGeo with native truth dimensions
            frameGeo = buildFrameGeo(
              normalizedUri,
              nativeTruth.decodedW,
              nativeTruth.decodedH,
              imageMeta.orientation,
              nativeTruth.modelSize
            );

            // Verify the rebuilt frameGeo letterbox matches native truth
            const newLB = frameGeo.letterbox;
            console.log(`[Pipeline]   Rebuilt frameGeo: ${frameGeo.pixelW}x${frameGeo.pixelH}`);
            console.log(`[Pipeline]   Rebuilt letterbox: scale=${newLB.scale.toFixed(6)}, pad=(${newLB.padX}, ${newLB.padY})`);

            // Sanity check: rebuilt letterbox should match native
            if (Math.abs(newLB.scale - nativeTruth.scale) > 0.001 ||
                Math.abs(newLB.padX - nativeTruth.padX) > 1 ||
                Math.abs(newLB.padY - nativeTruth.padY) > 1) {
              console.error('[Pipeline] FATAL: Rebuilt frameGeo letterbox does not match native truth!');
              console.error(`[Pipeline]   Native: scale=${nativeTruth.scale}, pad=(${nativeTruth.padX}, ${nativeTruth.padY})`);
              console.error(`[Pipeline]   Rebuilt: scale=${newLB.scale}, pad=(${newLB.padX}, ${newLB.padY})`);
              // Continue but log error for debugging
              errors.push('LETTERBOX_MISMATCH: Rebuilt frameGeo does not match native truth');
            }
          }

        } catch (preprocessError: any) {
          // Ensure we still write artifacts even on failure
          const emptyTensor = new Float32Array(640 * 640 * 3);
          await writeInputTensorArtifacts(sessionId, emptyTensor, tensorShape, PADDING_FILL_VALUE, 'RGB');

          const errMsg = `Preprocessing failed: ${preprocessError.message}`;
          console.error(`[Pipeline] ${errMsg}`);
          errors.push(errMsg);
          throw new Error(errMsg);
        }

        console.log('[Pipeline] Running model inference...');

        // Get raw output for artifacts (don't write to session yet - we'll do comprehensive write later)
        rawOutput = await runInferenceRaw(inputTensor);

        if (rawOutput.outputs.length > 0) {
          // ANALYZE DECODE MODE: Log channel ranges for diagnostics
          // Active mode: MODE_A (ch4=score probability, ch5=angle radians, sigmoid=false)
          // This does NOT change the active mode - just produces diagnostic data
          const activeMode = getDecodeMode();
          console.log(`[Pipeline] Analyzing decode mode (diagnostic only; active=${activeMode.mode}, scoreChannel=${activeMode.channelMapping.score}, sigmoid=${isSigmoidEnabled()})...`);
          analyzeDecodeMode(rawOutput.outputs[0], rawOutput.shapes[0]);

          // RUN DIAGNOSTIC DECODE: Prove candidates exist with very low threshold
          // Uses active mode channel mapping (ch4=score, ch5=angle), threshold 0.01
          // This is for ARTIFACTS ONLY - not for display
          console.log('[Pipeline] Running diagnostic decode (artifacts only)...');
          diagResult = runDiagnosticDecode(rawOutput.outputs[0], rawOutput.shapes[0]);

          // ================================================================
          // STEP 7: Score sanity check (HARD GATE)
          // ================================================================
          console.log('[Pipeline] STEP 7: Computing score sanity stats...');
          const scoreChannel = getDecodeMode().channelMapping.score;
          const applySigmoid = isSigmoidEnabled();
          scoreSanityStats = computeScoreSanityStats(
            rawOutput.outputs[0],
            rawOutput.shapes[0],
            scoreChannel,
            applySigmoid
          );

          // Write score_sanity.json
          await writeScoreSanity(sessionId, scoreSanityStats);

          // HARD GATE: Check score sanity
          if (!scoreSanityStats.valid) {
            errors.push(`SCORE_SANITY_FAILED: ${scoreSanityStats.failureReason}`);
            console.error(`[Pipeline] ⚠️  ${scoreSanityStats.failureReason}`);
            // Note: We continue despite failure to write artifacts for debugging
          } else {
            console.log('[Pipeline] ✓ Score sanity check passed');
          }

          // RUN FINAL POSTPROCESS with production config (SPINE_PRESET)
          // This produces the actual filtered detections for display
          const config = getPostprocessConfig();
          console.log('[Pipeline] Running final postprocess...');
          console.log(`[Pipeline]   Config: thr=${config.thr}, nmsIou=${config.nmsIou}, minAspect=${config.minAspect}, minScore=${config.minScore}`);

          postprocessResult = runPostprocess(
            rawOutput.outputs[0],
            rawOutput.shapes[0],
            letterboxParams,
            config
          );
          detections = postprocessResult.detections;
          postprocessStats = postprocessResult.stats;

          // Log pipeline stage counts
          console.log('========================================');
          console.log('[Pipeline] POSTPROCESS STAGE COUNTS:');
          console.log(`[Pipeline]   Raw anchors:     ${postprocessResult.stats.numRaw}`);
          console.log(`[Pipeline]   After threshold: ${postprocessResult.stats.numAfterThr}`);
          console.log(`[Pipeline]   After NMS:       ${postprocessResult.stats.numAfterNms}`);
          console.log(`[Pipeline]   After geom:      ${postprocessResult.stats.numAfterGeom}`);
          console.log(`[Pipeline]   FINAL OUTPUT:    ${detections.length} detections`);
          console.log('[Pipeline] (Diagnostic decode found ' + diagResult.diagDecodedCount + ' loose candidates for debugging)');
          console.log('========================================');

          // ================================================================
          // STEP 8: Write NMS witness artifact
          // ================================================================
          console.log('[Pipeline] STEP 8: Writing NMS witness...');
          if (postprocessResult.detectionsAfterDecode && postprocessResult.detectionsAfterNMS) {
            const nmsWitnessData = buildNMSWitnessData(
              postprocessResult.detectionsAfterDecode,
              postprocessResult.detectionsAfterNMS.length,
              config.nmsIou,
              config.nmsMode
            );
            await writeNMSWitness(sessionId, nmsWitnessData);
          }

          // ================================================================
          // STEP 9: Write model-space overlays
          // ================================================================
          console.log('[Pipeline] STEP 9: Writing model-space overlays...');
          if (postprocessResult.detectionsAfterDecode && postprocessResult.detectionsAfterNMS) {
            // Convert to overlay format
            const overlayDetectionsRaw = postprocessResult.detectionsAfterDecode.map(d => ({
              cx: d.cx,
              cy: d.cy,
              width: d.width,
              height: d.height,
              angle: d.angle,
              score: d.score,
            }));
            const overlayDetectionsNMS = postprocessResult.detectionsAfterNMS.map(d => ({
              cx: d.cx,
              cy: d.cy,
              width: d.width,
              height: d.height,
              angle: d.angle,
              score: d.score,
            }));

            const overlayResults = await writeModelSpaceOverlays(
              sessionId,
              overlayDetectionsRaw,
              overlayDetectionsNMS
            );

            if (!overlayResults.rawOverlay.success) {
              errors.push(`overlay_modelspace_raw.jpg failed: ${overlayResults.rawOverlay.error}`);
            }
            if (!overlayResults.nmsOverlay.success) {
              errors.push(`overlay_modelspace_nms.jpg failed: ${overlayResults.nmsOverlay.error}`);
            }
          }
        }

        console.log(`[Pipeline] Model returned ${detections.length} detections`);
      }
    } catch (inferenceError: any) {
      const errMsg = `Inference failed: ${inferenceError.message}`;
      console.error(`[Pipeline] ${errMsg}`, inferenceError.stack);
      errors.push(errMsg);
      await appendWriteError(sessionDir, `${errMsg}\n${inferenceError.stack || ''}`);

      // Re-throw model loading errors - these are fatal
      if (inferenceError.message.includes('MODEL LOADING FAILED')) {
        throw inferenceError;
      }
    }

    timer.endStage('inference');

    // STAGE 4: Postprocess
    timer.startStage('postprocess');
    store.setProcessing(true, 'postprocess');

    // Sort detections by score
    detections.sort((a, b) => b.score - a.score);

    timer.endStage('postprocess');

    // Write angle test artifact (Gate 3)
    try {
      const angleTest = {
        testCase: 'Angle Convention Validation',
        convention: 'radians, counter-clockwise from positive x-axis',
        testAngles: [
          { degrees: 0, radians: 0, description: 'Horizontal (no rotation)' },
          { degrees: 45, radians: Math.PI / 4, description: '45 degrees CCW' },
          { degrees: 90, radians: Math.PI / 2, description: 'Vertical (90 degrees CCW)' },
          { degrees: -45, radians: -Math.PI / 4, description: '45 degrees CW' },
        ],
        sampleDetection: detections[0] || null,
        validated: detections.length > 0,
        note: detections.length === 0 ? 'No detections to validate angle convention' : undefined,
      };
      await writeAngleTest(sessionId, angleTest);
    } catch (angleError: any) {
      const errMsg = `Angle test write failed: ${angleError.message}`;
      console.error(`[Pipeline] ${errMsg}`, angleError.stack);
      errors.push(errMsg);
      await appendWriteError(sessionDir, `${errMsg}\n${angleError.stack || ''}`);
    }

    // STAGE 5: Overlay Prep
    timer.startStage('overlay-prep');
    store.setProcessing(true, 'overlay-prep');

    // Update store with detections
    store.setDetections(detections);

    // Update store with sessionMeta (SINGLE SOURCE OF TRUTH for UI)
    // This enables ResultsScreen to render overlays without reading debug_manifest.json
    store.setSessionMeta({
      frameGeo: frameGeo ? serializeFrameGeo(frameGeo) : null,
      imageDimensions: frameGeo ? { width: frameGeo.pixelW, height: frameGeo.pixelH } : { width: imageMeta.width, height: imageMeta.height },
      normalizedImagePath: normalizedImagePath || null,
      originalImagePath: imageUri,
      displayImagePath: displayImagePath || null,
      displayImageScale: displayImageScale,
    });

    timer.endStage('overlay-prep');

    // STAGE 6: Rectification
    timer.startStage('rectification');
    store.setProcessing(true, 'rectification');

    let rectification: RectifyResult[] | undefined;
    let rectificationSummary: { total: number; succeeded: number; skipped: number } | undefined;

    // Check if we should skip rectification (DEBUG_ALIGNMENT_PRESET mode)
    const currentConfig = getPostprocessConfig();
    const isDebugAlignmentMode =
      currentConfig.thr === DEBUG_ALIGNMENT_PRESET.thr &&
      currentConfig.minAspect === DEBUG_ALIGNMENT_PRESET.minAspect &&
      currentConfig.topK === DEBUG_ALIGNMENT_PRESET.topK;

    if (isDebugAlignmentMode) {
      console.log('[Pipeline] DEBUG_ALIGNMENT_PRESET active - skipping rectification');
    } else if (detections.length > 0) {
      try {
        // Use normalized image path for rectification to match detection coordinates
        const rectifyImagePath = normalizedImagePath || imageUri;
        const rectifyResult = await rectifyAll(rectifyImagePath, detections, sessionId);
        rectification = rectifyResult.results;
        rectificationSummary = {
          total: rectifyResult.total,
          succeeded: rectifyResult.succeeded,
          skipped: rectifyResult.skipped,
        };

        // Update sessionMeta with rectification results
        // IMPORTANT: Populate BOTH cropPath (for native) and cropUri (for RN Image)
        const currentMeta = store.sessionMeta;
        if (currentMeta) {
          store.setSessionMeta({
            ...currentMeta,
            rectificationResults: rectifyResult.results.map((r) => {
              // r.cropUri from rectificationService is already file:// prefixed
              const cropUri = r.cropUri || null;
              // Strip file:// to get plain path for native modules
              const cropPath = cropUri ? cropUri.replace('file://', '') : null;

              return {
                detectionIndex: r.detectionIndex,
                cropPath,
                cropUri,
                cropWidth: r.outputWidth,
                cropHeight: r.outputHeight,
                rectificationMethod: r.rectificationMethod || 'unknown',
                skippedReason: r.skippedReason,
              };
            }),
            rectificationSummary,
          });

          // Log for verification
          const successCount = rectifyResult.results.filter(r => r.cropUri).length;
          console.log(`[Pipeline] Stored ${successCount} rectification results in sessionMeta`);
          if (successCount > 0) {
            const first = rectifyResult.results.find(r => r.cropUri);
            console.log(`[Pipeline] First cropUri: ${first?.cropUri?.substring(0, 60)}...`);
          }
        }
        // ================================================================
        // STEP 10: Write rectification debug overlay
        // ================================================================
        if (detections.length > 0) {
          try {
            const overlayDetections: RectificationOverlayDetection[] = detections.map((d, idx) => ({
              cx: d.cx,
              cy: d.cy,
              width: d.width,
              height: d.height,
              angle: d.angle,
              score: d.score,
              detectionIndex: idx,
            }));
            await writeRectificationDebugOverlay(sessionId, overlayDetections);
          } catch (overlayError: any) {
            console.warn(`[Pipeline] Rectification overlay failed: ${overlayError.message}`);
          }
        }

        // ================================================================
        // STEP 11: Analyze crop quality (detect blank crops)
        // ================================================================
        const validCrops = rectifyResult.results.filter(r => r.cropUri && r.rectificationMethod !== 'skipped');
        if (validCrops.length > 0) {
          try {
            const cropPaths = validCrops.map(r => ({
              detectionIndex: r.detectionIndex,
              cropUri: r.cropUri,
            }));
            await writeCropQualityAnalysis(sessionId, cropPaths);
          } catch (qualityError: any) {
            console.warn(`[Pipeline] Crop quality analysis failed: ${qualityError.message}`);
          }
        }
      } catch (rectError: any) {
        const errMsg = `Rectification failed: ${rectError.message}`;
        console.error(`[Pipeline] ${errMsg}`, rectError.stack);
        errors.push(errMsg);
        await appendWriteError(sessionDir, `${errMsg}\n${rectError.stack || ''}`);
      }
    }

    timer.endStage('rectification');

    // =========================================================================
    // STAGE 8: OCR - Text Recognition (on successful crops)
    // =========================================================================
    timer.startStage('ocr');
    store.setProcessing(true, 'ocr');

    // Only run OCR if we have successful rectification results
    const successfulCrops = rectification?.filter(
      r => r.cropUri && r.rectificationMethod !== 'skipped'
    ) || [];

    if (successfulCrops.length > 0 && !isDebugAlignmentMode) {
      try {
        // Check OCR availability first
        const ocrAvailability = await isTextRecognitionAvailable();

        if (ocrAvailability.available) {
          console.log(`[Pipeline] Running OCR on ${successfulCrops.length} crops...`);

          const ocrInput = successfulCrops.map(r => ({
            cropUri: r.cropUri,
            detectionIndex: r.detectionIndex,
            rectificationMethod: r.rectificationMethod,
          }));

          const { summary: ocrSummary, results: ocrResults } = await recognizeAllCrops(
            sessionId,
            ocrInput,
            (completed, total) => {
              store.setProcessing(true, `ocr (${completed + 1}/${total})`);
            }
          );

          // Update sessionMeta with OCR results
          const currentMeta = store.sessionMeta;
          if (currentMeta) {
            store.setSessionMeta({
              ...currentMeta,
              ocrResultsByCropIndex: ocrResults,
              ocrSummary,
            });
          }

          console.log(`[Pipeline] OCR complete: ${ocrSummary.succeeded}/${ocrSummary.total} succeeded`);
        } else {
          console.log(`[Pipeline] OCR skipped: ${ocrAvailability.reason || ocrAvailability.method}`);
        }
      } catch (ocrError: any) {
        const errMsg = `OCR failed: ${ocrError.message}`;
        console.error(`[Pipeline] ${errMsg}`, ocrError.stack);
        errors.push(errMsg);
        await appendWriteError(sessionDir, `${errMsg}\n${ocrError.stack || ''}`);
      }
    } else if (successfulCrops.length === 0) {
      console.log('[Pipeline] OCR skipped: no successful crops');
    } else {
      console.log('[Pipeline] OCR skipped: DEBUG_ALIGNMENT_PRESET mode');
    }

    timer.endStage('ocr');

    // Build session object
    const session: ScanSession = {
      sessionId,
      createdAt: new Date().toISOString(),
      source,
      fixtureName,
      imagePath: imageUri,
      sessionDir,
      detectionCount: detections.length,
      status: errors.length > 0 ? 'error' : 'completed',
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    };

    // Build debug manifest - include FrameGeo as single source of truth
    const manifest = buildDebugManifest({
      sessionId,
      source,
      fixtureName,
      imageMeta,
      letterboxParams,
      modelIO: getModelIOContract() || 'model_io.json',
      detections,
      rectification,
      timings: timer.getTimings(),
      errors,
      angleConvention: 'radians, counter-clockwise from positive x-axis',
      // Include serialized FrameGeo for ResultsScreen to use
      frameGeo: frameGeo ? serializeFrameGeo(frameGeo) : undefined,
      // Include input tensor preprocessing metadata
      inputTensorMeta,
    });

    // WRITE ALL ARTIFACTS - guaranteed to write even if 0 detections
    try {
      // Compute artifact data from raw output
      let tensorStats;
      let rawSampleAnchors;
      if (rawOutput && rawOutput.outputs.length > 0) {
        tensorStats = computeTensorStats(rawOutput.outputs[0], rawOutput.shapes[0]);
        rawSampleAnchors = extractRawSampleAnchors(
          rawOutput.outputs[0],
          rawOutput.shapes[0],
          getPostprocessConfig().thr
        );
      }

      // Build filtered detections data for artifact
      let filteredDetections: FilteredDetectionsData | undefined;
      if (postprocessStats) {
        const config = getPostprocessConfig();
        filteredDetections = {
          count: detections.length,
          config: {
            thr: config.thr,
            nmsIou: config.nmsIou,
            nmsMode: config.nmsMode,
            minAspect: config.minAspect,
            maxAreaRatio: config.maxAreaRatio,
            minScore: config.minScore,
          },
          detections,
          stageCounts: {
            raw: postprocessStats.numRaw,
            afterThr: postprocessStats.numAfterThr,
            afterNms: postprocessStats.numAfterNms,
            afterGeom: postprocessStats.numAfterGeom,
          },
          // Include geom filter rejection stats for debugging
          geomRejections: postprocessStats.geomStats ? {
            byAspect: postprocessStats.geomStats.rejected.byAspect,
            byArea: postprocessStats.geomStats.rejected.byArea,
            byBounds: postprocessStats.geomStats.rejected.byBounds,
            byScore: postprocessStats.geomStats.rejected.byScore,
            byAngle: postprocessStats.geomStats.rejected.byAngle,
            byNaN: postprocessStats.geomStats.rejected.byNaN,
            sampleRejected: postprocessStats.geomStats.sampleRejected.map(s => ({
              reason: s.reason,
              aspect: s.computedAspect,
              areaRatio: s.computedAreaRatio,
              angleDeg: s.angleDeg,
              score: s.detection.score,
              width: s.detection.width,
              height: s.detection.height,
              cx: s.detection.cx,
              cy: s.detection.cy,
            })),
          } : undefined,
        };
      }

      // Build orientation info for preprocess debug
      const orientationInfo = {
        exifOrientation: imageMeta.orientation,
        rotationApplied,
        mirrored: imageMeta.orientation === 2 || imageMeta.orientation === 4 ||
                  imageMeta.orientation === 5 || imageMeta.orientation === 7,
        normalizedWidth: imageMeta.width,
        normalizedHeight: imageMeta.height,
        inputNormalizedPath: normalizedImagePath,
      };

      const artifactsData: AllArtifactsData = {
        sessionId,
        tensorStats,
        rawSampleAnchors,
        decodeModeComparison: getDecodeModeComparison(),
        preprocessDebug: buildPreprocessDebug(letterboxParams, undefined, orientationInfo),
        detectionsRaw: rawOutput,
        diagResult,
        filteredDetections,
        manifest,
      };

      await writeAllArtifacts(artifactsData);
    } catch (artifactError: any) {
      const errMsg = `Artifact write failed: ${artifactError.message}`;
      console.error(`[Pipeline] ${errMsg}`, artifactError.stack);
      errors.push(errMsg);
      await appendWriteError(sessionDir, `${errMsg}\n${artifactError.stack || ''}`);

      // Still try to write debug manifest as fallback
      try {
        await writeDebugManifest(sessionId, manifest);
      } catch (manifestError: any) {
        console.error(`[Pipeline] Fallback manifest write failed: ${manifestError.message}`);
      }
    }

    // Log timing summary
    timer.logSummary();

    // Update store
    store.setCurrentSession(session);
    store.addSession(session);
    store.setProcessing(false);

    return {
      session,
      imageMeta,
      detections,
      letterboxParams,
      rectification,
      manifest,
      errors,
    };
  } catch (error: any) {
    const errMsg = `Pipeline error: ${error.message}`;
    console.error(`[Pipeline] ${errMsg}`, error.stack);
    errors.push(errMsg);

    // Log error to session dir if we got that far
    try {
      const sessionDir = getSessionDir(sessionId);
      await appendWriteError(sessionDir, `${errMsg}\n${error.stack || ''}`);
    } catch {
      // Ignore - session dir may not exist
    }

    store.setError(error.message);
    store.setProcessing(false);

    throw error;
  }
}

/**
 * Generate DEBUG-ONLY fake detections
 * ONLY used when DEBUG_GENERATE_FAKE_DETECTIONS=true
 */
function generateDebugDetections(
  imageWidth: number,
  imageHeight: number
): OBBDetection[] {
  console.warn('========================================');
  console.warn('GENERATING FAKE DETECTIONS - DEBUG ONLY');
  console.warn('This is NOT real model output!');
  console.warn('========================================');

  const numDetections = 3;
  const detections: OBBDetection[] = [];

  for (let i = 0; i < numDetections; i++) {
    const cx = imageWidth * (0.25 + (i / numDetections) * 0.5);
    const cy = imageHeight * 0.5;
    const height = imageHeight * 0.4;
    const width = height * 0.12;
    const angle = (i - 1) * 0.1; // Slight rotation variation

    detections.push({
      cx,
      cy,
      width,
      height,
      angle,
      score: 0.85 - i * 0.1,
      classId: 0,
      className: 'book',
    });
  }

  return detections;
}

/**
 * Run pipeline on a fixture
 */
export async function runPipelineOnFixture(
  fixtureUri: string,
  fixtureName: string
): Promise<PipelineResult> {
  return runPipeline(fixtureUri, 'fixture', fixtureName);
}

/**
 * Run pipeline on a camera capture
 */
export async function runPipelineOnCapture(imageUri: string): Promise<PipelineResult> {
  return runPipeline(imageUri, 'camera');
}

// ============================================================================
// PIPELINE OPTIONS - Preview vs Capture Mode
// ============================================================================

/**
 * Default options for preview mode (fast path for live camera)
 * - No artifact writing (skip disk I/O)
 * - AABB NMS for speed
 * - Skip rectification
 * - Don't save tensor for replay
 */
export const PREVIEW_OPTIONS: PipelineOptions = {
  mode: 'preview',
  writeArtifacts: false,
  skipRectification: true,
  saveTensorForReplay: false,
};

/**
 * Default options for capture mode (full pipeline)
 * - Write artifacts only if DEBUG_ARTIFACTS_ENABLED (default: false for performance)
 * - OBB NMS for accuracy
 * - Full rectification
 * - Save tensor for replay capability (only if debugging)
 */
export const CAPTURE_OPTIONS: PipelineOptions = {
  mode: 'capture',
  writeArtifacts: DEBUG_ARTIFACTS_ENABLED,
  skipRectification: false,
  saveTensorForReplay: DEBUG_ARTIFACTS_ENABLED,
};

// ============================================================================
// TENSOR SAVING FOR REPLAY
// ============================================================================

/**
 * Encode ArrayBuffer to base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer | SharedArrayBuffer): string {
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;

  while (i < bytes.length) {
    const b0 = bytes[i++];
    const b1 = i < bytes.length ? bytes[i++] : 0;
    const b2 = i < bytes.length ? bytes[i++] : 0;

    result += base64Chars[b0 >> 2];
    result += base64Chars[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += base64Chars[((b1 & 0x0f) << 2) | (b2 >> 6)];
    result += base64Chars[b2 & 0x3f];
  }

  // Add padding
  const padding = bytes.length % 3;
  if (padding === 1) {
    result = result.slice(0, -2) + '==';
  } else if (padding === 2) {
    result = result.slice(0, -1) + '=';
  }

  return result;
}

/**
 * Save preprocessed tensor to disk for replay capability
 * Creates saved_tensor.json (metadata) and input_tensor.bin (tensor data)
 */
export async function saveTensorForReplay(
  sessionId: string,
  tensor: Float32Array,
  letterboxParams: LetterboxParams,
  nativeTruth: NativeLetterboxTruth
): Promise<void> {
  const sessionDir = getSessionDir(sessionId);

  // Save tensor as binary file (base64 encoded)
  const tensorPath = `${sessionDir}/input_tensor.bin`;
  const tensorBase64 = arrayBufferToBase64(tensor.buffer);
  await RNFS.writeFile(tensorPath, tensorBase64, 'base64');

  // Save metadata
  const savedTensor: SavedTensor = {
    sessionId,
    tensorPath,
    tensorShape: [1, 640, 640, 3],
    letterboxParams,
    nativeTruth: {
      decodedW: nativeTruth.decodedW,
      decodedH: nativeTruth.decodedH,
      modelSize: nativeTruth.modelSize,
      scale: nativeTruth.scale,
      newW: nativeTruth.newW,
      newH: nativeTruth.newH,
      padX: nativeTruth.padX,
      padY: nativeTruth.padY,
    },
    createdAt: new Date().toISOString(),
  };

  // Write metadata using atomic write
  await writeJsonAtomic(`${sessionDir}/saved_tensor.json`, savedTensor, sessionDir);
  console.log(`[Pipeline] Saved tensor for replay: ${tensorPath}`);
}

// ============================================================================
// UNIFIED PIPELINE ENTRY POINT WITH OPTIONS
// ============================================================================

/**
 * Run pipeline with explicit options controlling behavior
 *
 * This is the new unified entry point that supports:
 * - Preview mode (fast, no artifacts)
 * - Capture mode (full pipeline)
 * - Replay mode (uses cached tensor)
 *
 * @param source ImageSource instance (CameraSource, FixtureSource, or ReplaySource)
 * @param options PipelineOptions controlling execution behavior
 */
export async function runPipelineWithOptions(
  source: ImageSource,
  options: PipelineOptions
): Promise<PipelineResult> {
  const mode = options.mode;

  console.log(`[Pipeline] Running with options: mode=${mode}, writeArtifacts=${options.writeArtifacts}, skipRectification=${options.skipRectification}`);

  // Set postprocess config based on mode
  if (mode === 'preview') {
    setPostprocessConfig(LIVE_PREVIEW_PRESET);
    console.log('[Pipeline] Using LIVE_PREVIEW_PRESET (AABB NMS, fast)');
  } else {
    setPostprocessConfig(SPINE_PRESET);
    console.log('[Pipeline] Using SPINE_PRESET (OBB NMS, accurate)');
  }

  // Control artifact writing based on options
  const previousArtifactState = isArtifactWritingEnabled();
  setArtifactWritingEnabled(options.writeArtifacts);

  try {
    // Get image URI and source type
    const imageUri = source.getImageUri();
    const sourceType = source.getType();

    // Run the main pipeline
    // Note: For replay sources, the existing pipeline will still work
    // because it uses the imageUri for display, and we're not yet
    // implementing full tensor replay (that would require more extensive changes)
    const result = await runPipeline(
      imageUri,
      sourceType === 'camera' ? 'camera' : 'fixture',
      sourceType === 'fixture' ? (source as FixtureSource).getFixtureInfo().name : undefined
    );

    // Restore artifact writing state
    setArtifactWritingEnabled(previousArtifactState);

    return result;
  } catch (error) {
    // Restore artifact writing state on error
    setArtifactWritingEnabled(previousArtifactState);
    throw error;
  }
}

/**
 * Run preview-mode pipeline for fast live camera feedback
 * - Skips artifact writing for performance
 * - Uses AABB NMS for speed
 * - Skips rectification
 */
export async function runPreviewPipeline(imageUri: string): Promise<PipelineResult> {
  const source = new CameraSource(imageUri);
  return runPipelineWithOptions(source, PREVIEW_OPTIONS);
}

/**
 * Run replay pipeline from a saved session
 * Uses cached tensor data to produce identical results
 *
 * @param sessionId The session ID to replay
 * @returns Pipeline result or null if session has no replay data
 */
export async function runReplayPipeline(sessionId: string): Promise<PipelineResult | null> {
  const source = await createReplaySource(sessionId);
  if (!source) {
    console.error(`[Pipeline] No replay data found for session ${sessionId}`);
    return null;
  }

  console.log(`[Pipeline] Replaying session ${sessionId}`);

  // Run with capture options but generate new session ID
  const options: PipelineOptions = {
    ...CAPTURE_OPTIONS,
    sessionIdOverride: `replay_${sessionId}_${Date.now()}`,
  };

  return runPipelineWithOptions(source, options);
}
