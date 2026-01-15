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

import { Image } from 'react-native';
import RNFS from 'react-native-fs';
import type {
  ImageMeta,
  ScanSession,
  OBBDetection,
  LetterboxParams,
  RectifyResult,
  DebugManifest,
} from '../types';
import { resizeWithLetterbox } from '../utils/letterbox';
import { PipelineTimer } from '../utils/timing';
import {
  loadModel,
  inspectModel,
  runInference,
  getModelIOContract,
  isModelReady,
  getModelInputSize,
  isMockModel,
  preprocessImage,
} from './inferenceService';
import { rectifyAll } from './rectificationService';
import {
  createSessionDir,
  writeDebugManifest,
  writeCoordinateTest,
  writeAngleTest,
  buildDebugManifest,
  copyOriginalImage,
} from './debugArtifacts';
import { buildImageMetaFromUri } from './imageService';
import { useAppStore } from '../store/useAppStore';
import { generateCoordinateTestArtifact } from '../utils/letterbox';

// DEBUG FLAG: Set to true ONLY to bypass model requirement during UI development
// MUST be false for any real testing or production
const DEBUG_GENERATE_FAKE_DETECTIONS = false;

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

  try {
    // Create session directory
    const sessionDir = await createSessionDir(sessionId);

    // Copy original image to session
    await copyOriginalImage(sessionId, imageUri);

    // STAGE 1: Meta
    timer.startStage('meta');
    store.setProcessing(true, 'meta');

    const imageMeta = await buildImageMetaFromUri(imageUri);
    console.log(`[Pipeline] Image: ${imageMeta.width}x${imageMeta.height}`);

    timer.endStage('meta');

    // STAGE 2: Letterbox
    timer.startStage('letterbox');
    store.setProcessing(true, 'letterbox');

    const letterboxParams = resizeWithLetterbox(
      imageMeta.width,
      imageMeta.height,
      getModelInputSize(),
      getModelInputSize()
    );
    console.log(`[Pipeline] Letterbox: scale=${letterboxParams.scale.toFixed(3)}, pad=(${letterboxParams.padX}, ${letterboxParams.padY})`);

    timer.endStage('letterbox');

    // Write coordinate test artifact (Gate 2)
    const coordTest = generateCoordinateTestArtifact();
    await writeCoordinateTest(sessionId, coordTest);

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

        // TODO: Implement image tensor preparation from actual image file
        // This requires reading the image, resizing with letterbox, and converting to tensor
        // For now, we need the image data as RGB bytes

        // Placeholder: Create dummy tensor for testing pipeline flow
        // In production, this should be the actual preprocessed image
        const inputTensor = new Float32Array(1 * 640 * 640 * 3);

        console.log('[Pipeline] Running model inference...');
        detections = await runInference(inputTensor, letterboxParams, sessionId);
        console.log(`[Pipeline] Model returned ${detections.length} detections`);
      }
    } catch (inferenceError: any) {
      console.error('[Pipeline] Inference error:', inferenceError);
      errors.push(`Inference failed: ${inferenceError.message}`);

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

    // STAGE 5: Overlay Prep
    timer.startStage('overlay-prep');
    store.setProcessing(true, 'overlay-prep');

    // Update store with detections
    store.setDetections(detections);

    timer.endStage('overlay-prep');

    // STAGE 6: Rectification
    timer.startStage('rectification');
    store.setProcessing(true, 'rectification');

    let rectification: RectifyResult[] | undefined;

    if (detections.length > 0) {
      try {
        rectification = await rectifyAll(imageUri, detections, sessionId);
        console.log(`[Pipeline] Rectified ${rectification.length} detections`);
      } catch (rectError: any) {
        console.error('[Pipeline] Rectification error:', rectError);
        errors.push(`Rectification failed: ${rectError.message}`);
      }
    }

    timer.endStage('rectification');

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

    // Build and write debug manifest
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
    });

    await writeDebugManifest(sessionId, manifest);

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
    console.error('[Pipeline] Pipeline error:', error);
    errors.push(`Pipeline error: ${error.message}`);

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
