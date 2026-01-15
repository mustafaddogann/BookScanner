/**
 * TFLite Inference Service for YOLOv8 OBB
 *
 * STRICT MODE: No fallbacks. Model must exist.
 *
 * STOP-THE-LINE GATE: MODEL IO CONTRACT INSPECTION
 * Before running inference, we inspect and record model IO contract.
 */

import { Platform, NativeModules } from 'react-native';
import { loadTensorflowModel, TensorflowModel } from 'react-native-fast-tflite';
import RNFS from 'react-native-fs';

// Native module for resolving iOS bundle paths
const { ModelPathResolver } = NativeModules;

/**
 * Type definitions for ModelPathResolver native module (iOS only)
 */
interface ModelPathResolverModule {
  getBundledModelPath(filename: string): Promise<string>;
  listBundleResources(): Promise<Array<{ name: string; isDirectory: boolean; size: number }>>;
  checkFileExists(path: string): Promise<{ exists: boolean; size?: number; path: string }>;
}
import type {
  ModelIOContract,
  TensorInfo,
  OBBDetection,
  OBBModelSpace,
  LetterboxParams,
  RawModelOutput,
} from '../types';
import { mapModelToOriginalOBB, normalizeAngle } from '../utils/letterbox';
import { writeModelIO, writeRawModelOutput } from './debugArtifacts';

// Model configuration
const MODEL_INPUT_SIZE = 640;

/**
 * Postprocess configuration presets
 * Verified against Python tools/decode_one.py
 */
export interface PostprocessConfig {
  /** Confidence threshold for initial filtering */
  thr: number;
  /** NMS IoU threshold */
  nmsIou: number;
  /** NMS mode: 'aabb' (fast) or 'obb' (accurate) */
  nmsMode: 'aabb' | 'obb';
  /** Minimum aspect ratio (w/h) for spine filtering */
  minAspect: number;
  /** Maximum detection area as fraction of image area */
  maxAreaRatio: number;
  /** Minimum score for final filtered output */
  minScore: number;
}

/**
 * Spine preset - optimized for book spine detection
 * Matches Python: python3 tools/decode_one.py --preset spine
 */
export const SPINE_PRESET: PostprocessConfig = {
  thr: 0.50,
  nmsIou: 0.90,
  nmsMode: 'aabb',  // Use AABB for live preview (fast)
  minAspect: 6.0,
  maxAreaRatio: 0.08,
  minScore: 0.60,
};

/**
 * General preset - for non-spine detection
 */
export const GENERAL_PRESET: PostprocessConfig = {
  thr: 0.50,
  nmsIou: 0.50,
  nmsMode: 'aabb',
  minAspect: 1.0,
  maxAreaRatio: 0.50,
  minScore: 0.50,
};

/**
 * Live preview preset - fast processing for responsive UI
 */
export const LIVE_PREVIEW_PRESET: PostprocessConfig = {
  thr: 0.50,
  nmsIou: 0.90,
  nmsMode: 'aabb',  // Always AABB for speed
  minAspect: 6.0,
  maxAreaRatio: 0.08,
  minScore: 0.60,
};

/**
 * Capture preset - accurate processing for final output
 */
export const CAPTURE_PRESET: PostprocessConfig = {
  thr: 0.50,
  nmsIou: 0.90,
  nmsMode: 'aabb',  // Keep AABB for now; OBB can be enabled if device is fast
  minAspect: 6.0,
  maxAreaRatio: 0.08,
  minScore: 0.60,
};

// Current active config (can be changed at runtime)
let activeConfig: PostprocessConfig = SPINE_PRESET;

// Legacy constants for backward compatibility
const CONFIDENCE_THRESHOLD = SPINE_PRESET.thr;
const NMS_IOU_THRESHOLD = SPINE_PRESET.nmsIou;

/**
 * Postprocess statistics for debugging
 */
export interface PostprocessStats {
  numRaw: number;
  numAfterThr: number;
  numAfterNms: number;
  numAfterGeom: number;
  config: PostprocessConfig;
  timings?: {
    preprocess: number;
    inference: number;
    decode: number;
    nms: number;
    geomFilters: number;
    postprocessTotal: number;
    total: number;
  };
}

/**
 * Full inference context for logging and debug manifest
 * Captures all coordinate mapping parameters
 */
export interface InferenceContext {
  /** Frame dimensions (photo/image pixels) */
  frameWidth: number;
  frameHeight: number;
  /** View dimensions (preview canvas, if different) */
  viewWidth?: number;
  viewHeight?: number;
  /** Rotation applied to frame (degrees) */
  rotationDegrees: number;
  /** Whether image is mirrored (front camera) */
  mirrored: boolean;
  /** Resize mode used for letterboxing */
  resizeMode: 'letterbox' | 'stretch';
  /** Scale factors from letterbox */
  scaleX: number;
  scaleY: number;
  /** Offset from letterbox padding */
  offsetX: number;
  offsetY: number;
}

/**
 * Set the active postprocess configuration
 */
export function setPostprocessConfig(config: PostprocessConfig): void {
  activeConfig = { ...config };
  console.log('[InferenceService] Postprocess config updated:', config);
}

/**
 * Get the current postprocess configuration
 */
export function getPostprocessConfig(): PostprocessConfig {
  return { ...activeConfig };
}

/**
 * Canonicalize OBB: ensure w >= h and angle in [-pi/2, pi/2]
 * Matches Python: tools/decode_one.py canonicalize_obb()
 */
export function canonicalizeOBB(
  w: number,
  h: number,
  angle: number
): { w: number; h: number; angle: number } {
  // Swap if w < h
  if (w < h) {
    const temp = w;
    w = h;
    h = temp;
    angle = angle + Math.PI / 2;
  }

  // Normalize angle to [-pi/2, pi/2]
  while (angle > Math.PI / 2) {
    angle -= Math.PI;
  }
  while (angle < -Math.PI / 2) {
    angle += Math.PI;
  }

  return { w, h, angle };
}

/**
 * Apply geometric filters for spine detection
 * Matches Python: tools/decode_one.py geometric filters
 */
export function applyGeometricFilters(
  detections: OBBModelSpace[],
  imageWidth: number,
  imageHeight: number,
  config: PostprocessConfig = activeConfig
): OBBModelSpace[] {
  const imageArea = imageWidth * imageHeight;
  const filtered: OBBModelSpace[] = [];

  for (const det of detections) {
    // Aspect ratio filter (w >= h after canonicalization)
    const aspectRatio = det.height > 0 ? det.width / det.height : 0;
    if (aspectRatio < config.minAspect) {
      continue;
    }

    // Area ratio filter
    const detArea = det.width * det.height;
    const areaRatio = imageArea > 0 ? detArea / imageArea : 0;
    if (areaRatio > config.maxAreaRatio) {
      continue;
    }

    // Minimum score filter
    if (det.score < config.minScore) {
      continue;
    }

    filtered.push(det);
  }

  return filtered;
}

// DEBUG FLAG: Set to true ONLY for development without model
// MUST be false in production
const DEBUG_ALLOW_MISSING_MODEL = false;

let model: TensorflowModel | null = null;
let modelIOContract: ModelIOContract | null = null;
let isModelInspected = false;
let isUsingMockModel = false;

/** Model filename constant */
const MODEL_FILENAME = 'yolov8_obb.tflite';

/** Resolved absolute model path (set during loading) */
let resolvedModelPath: string | null = null;

/**
 * Get model path based on platform
 */
function getModelPath(): string {
  return resolvedModelPath || MODEL_FILENAME;
}

/**
 * Resolve the absolute path to the bundled model file.
 * iOS: Uses native module to resolve Bundle.main path
 * Android: Uses assets path (react-native-fast-tflite handles this)
 */
async function resolveModelPath(): Promise<{ path: string; isAssetUri: boolean }> {
  console.log('========================================');
  console.log('[InferenceService] Resolving model path...');
  console.log(`[InferenceService] Platform: ${Platform.OS}`);
  console.log(`[InferenceService] Model filename: ${MODEL_FILENAME}`);

  if (Platform.OS === 'ios') {
    // iOS: Must use native module to get absolute bundle path
    if (!ModelPathResolver) {
      throw new Error(
        'GATE 4 FAILED: ModelPathResolver native module not found.\n' +
        'Ensure ios/BookScanner/ModelPathResolver.m is included in the Xcode project.'
      );
    }

    const resolver = ModelPathResolver as ModelPathResolverModule;

    try {
      // Get absolute path from bundle
      const absolutePath = await resolver.getBundledModelPath(MODEL_FILENAME);
      console.log(`[InferenceService] Resolved model path: ${absolutePath}`);

      // Verify file exists and get size
      const fileInfo = await resolver.checkFileExists(absolutePath);
      console.log(`[InferenceService] Model file exists: ${fileInfo.exists}`);

      if (!fileInfo.exists) {
        // List bundle contents for debugging
        console.log('[InferenceService] Listing bundle resources for debugging...');
        try {
          await resolver.listBundleResources();
        } catch (e) {
          // Ignore listing errors
        }

        throw new Error(
          `Model file not found at resolved path: ${absolutePath}\n` +
          'Ensure yolov8_obb.tflite is added to Xcode "Copy Bundle Resources".'
        );
      }

      const sizeBytes = fileInfo.size || 0;
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
      console.log(`[InferenceService] Model file size: ${sizeBytes} bytes (${sizeMB} MB)`);

      resolvedModelPath = absolutePath;
      return { path: absolutePath, isAssetUri: false };

    } catch (error: any) {
      console.error('[InferenceService] iOS path resolution failed:', error.message);

      // List bundle contents for debugging
      console.log('[InferenceService] Listing bundle resources for debugging...');
      try {
        const resources = await resolver.listBundleResources();
        console.log('[InferenceService] Bundle has', resources.length, 'items');

        // Look for .tflite files
        const tfliteFiles = resources.filter(r => r.name.endsWith('.tflite'));
        if (tfliteFiles.length > 0) {
          console.log('[InferenceService] Found .tflite files:', tfliteFiles);
        } else {
          console.log('[InferenceService] No .tflite files found in bundle root');
        }
      } catch (listError) {
        // Ignore listing errors
      }

      throw new Error(
        `GATE 4 FAILED: iOS model path resolution failed.\n` +
        `Platform: ${Platform.OS}\n` +
        `Filename: ${MODEL_FILENAME}\n` +
        `Error: ${error.message}\n\n` +
        'To fix:\n' +
        '1. Copy src/models/yolov8_obb.tflite to ios/BookScanner/\n' +
        '2. In Xcode, add yolov8_obb.tflite to the project\n' +
        '3. In Build Phases > Copy Bundle Resources, ensure it is listed\n' +
        '4. Clean and rebuild: rm -rf ios/build && npx react-native run-ios'
      );
    }

  } else {
    // Android: Use assets path (react-native-fast-tflite handles asset:// internally)
    const assetPath = `asset://models/${MODEL_FILENAME}`;
    console.log(`[InferenceService] Using Android asset path: ${assetPath}`);

    // Verify the asset exists using RNFS
    try {
      const assetsDir = `${RNFS.MainBundlePath}`;
      console.log(`[InferenceService] Android assets dir: ${assetsDir}`);
      // Note: On Android, we can't easily verify asset existence before loading
      // The loadTensorflowModel will fail if the file doesn't exist
    } catch (e) {
      // Ignore - Android asset verification is best-effort
    }

    resolvedModelPath = assetPath;
    return { path: assetPath, isAssetUri: true };
  }
}

/**
 * Inspect model tensors and create IO contract
 * GATE 3: This MUST succeed before any inference
 */
export async function inspectModel(sessionId?: string): Promise<ModelIOContract> {
  console.log('[InferenceService] Starting model inspection...');

  if (!model) {
    throw new Error('Model not loaded. Call loadModel() first.');
  }

  if (isUsingMockModel) {
    throw new Error('GATE 3 FAILED: Cannot inspect mock model. Load real TFLite model.');
  }

  // Get input tensor info
  const inputTensors: TensorInfo[] = model.inputs.map((input, index) => ({
    name: input.name || `input_${index}`,
    shape: Array.from(input.shape),
    dtype: input.dataType,
    quantization: undefined,
  }));

  // Get output tensor info
  const outputTensors: TensorInfo[] = model.outputs.map((output, index) => ({
    name: output.name || `output_${index}`,
    shape: Array.from(output.shape),
    dtype: output.dataType,
    quantization: undefined,
  }));

  const contract: ModelIOContract = {
    inputTensors,
    outputTensors,
    inspectedAt: new Date().toISOString(),
    modelPath: getModelPath(),
  };

  // Log inspection results
  console.log('[InferenceService] Model IO Contract:');
  console.log('  Inputs:', JSON.stringify(inputTensors, null, 2));
  console.log('  Outputs:', JSON.stringify(outputTensors, null, 2));

  // Write to session if provided
  if (sessionId) {
    await writeModelIO(sessionId, contract);
  }

  modelIOContract = contract;
  isModelInspected = true;

  // Validate output shape for OBB detection
  if (outputTensors.length === 0) {
    throw new Error('GATE 3 FAILED: Model has no output tensors');
  }

  const mainOutput = outputTensors[0];
  console.log(`[InferenceService] Main output shape: [${mainOutput.shape.join(', ')}]`);

  return contract;
}

/**
 * Load the TFLite model
 * STRICT: Fails if model file is missing (unless DEBUG flag is set)
 *
 * iOS: Loads from absolute bundle path resolved by native module
 * Android: Loads from assets using asset:// URI
 */
export async function loadModel(): Promise<void> {
  if (model) {
    console.log('[InferenceService] Model already loaded');
    return;
  }

  console.log('[InferenceService] Loading model...');

  try {
    // Step 1: Resolve the model path
    const { path, isAssetUri } = await resolveModelPath();

    // Step 2: Load the model
    console.log(`[InferenceService] Loading from: ${path}`);
    console.log(`[InferenceService] Is asset URI: ${isAssetUri}`);

    if (isAssetUri) {
      // Android: Use asset:// URI
      model = await loadTensorflowModel({ url: path } as any);
    } else {
      // iOS: Use absolute file path with file:// scheme
      // react-native-fast-tflite accepts file:// URLs
      const fileUrl = path.startsWith('file://') ? path : `file://${path}`;
      console.log(`[InferenceService] Loading with file URL: ${fileUrl}`);
      model = await loadTensorflowModel({ url: fileUrl } as any);
    }

    isUsingMockModel = false;
    console.log('[InferenceService] Model loaded successfully!');
    console.log(`[InferenceService] Interpreter created: true`);
    console.log('========================================');

  } catch (error: any) {
    console.error('[InferenceService] FAILED to load model:', error.message);
    console.log('========================================');

    if (DEBUG_ALLOW_MISSING_MODEL) {
      console.warn('========================================');
      console.warn('DEBUG MODE: Using mock model');
      console.warn('This is ONLY for UI development.');
      console.warn('Set DEBUG_ALLOW_MISSING_MODEL=false for production.');
      console.warn('========================================');

      model = createMockModel();
      isUsingMockModel = true;
    } else {
      throw new Error(
        `MODEL LOADING FAILED.\n` +
        `Platform: ${Platform.OS}\n` +
        `Resolved path: ${resolvedModelPath || 'not resolved'}\n` +
        `Error: ${error.message}\n\n` +
        'iOS Fix:\n' +
        '1. Add yolov8_obb.tflite to Xcode project\n' +
        '2. Ensure "Copy Bundle Resources" includes it\n' +
        '3. Clean build: rm -rf ios/build\n\n' +
        'Android Fix:\n' +
        '1. Place in android/app/src/main/assets/models/\n' +
        '2. Clean build: cd android && ./gradlew clean'
      );
    }
  }
}

/**
 * Create a mock model for DEBUG mode only
 */
function createMockModel(): TensorflowModel {
  return {
    inputs: [{ name: 'input', shape: [1, 640, 640, 3], dataType: 'float32' }],
    outputs: [{ name: 'output', shape: [1, 6, 8400], dataType: 'float32' }],
    runSync: () => {
      // Return empty output in debug mode
      console.warn('[InferenceService] Mock model inference - no real detections');
      return [new Float32Array(6 * 8400)];
    },
  } as any;
}

/**
 * Check if model is loaded and inspected
 */
export function isModelReady(): boolean {
  return model !== null && isModelInspected && !isUsingMockModel;
}

/**
 * Expected tensor shapes for YOLOv8 OBB model
 */
const EXPECTED_INPUT_SHAPE = [1, 640, 640, 3];
const EXPECTED_OUTPUT_SHAPE = [1, 6, 8400];

/**
 * Verify model is loaded and has correct tensor shapes
 * GATE 4: Run this once on app start or first inference
 * @returns Verification result with pass/fail and details
 */
export async function verifyModelLoaded(): Promise<{
  success: boolean;
  modelPath: string;
  modelExists: boolean;
  interpreterCreated: boolean;
  inputShape: number[] | null;
  outputShape: number[] | null;
  inputValid: boolean;
  outputValid: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  const modelPath = getModelPath();

  console.log('========================================');
  console.log('[InferenceService] GATE 4: Model Verification');
  console.log('========================================');
  console.log(`[InferenceService] Model path: ${modelPath}`);

  // Step 1: Try to load model
  let modelExists = false;
  let interpreterCreated = false;
  let inputShape: number[] | null = null;
  let outputShape: number[] | null = null;

  try {
    await loadModel();
    modelExists = true;
    interpreterCreated = model !== null;
    console.log(`[InferenceService] Model exists: ${modelExists}`);
    console.log(`[InferenceService] Interpreter created: ${interpreterCreated}`);
  } catch (e: any) {
    errors.push(`Model load failed: ${e.message}`);
    console.error(`[InferenceService] Model load FAILED: ${e.message}`);
  }

  // Step 2: Inspect tensors if model loaded
  if (interpreterCreated && !isUsingMockModel) {
    try {
      const contract = await inspectModel();

      inputShape = contract.inputTensors[0]?.shape || null;
      outputShape = contract.outputTensors[0]?.shape || null;

      console.log(`[InferenceService] Input tensor shape: [${inputShape?.join(', ') || 'null'}]`);
      console.log(`[InferenceService] Output tensor shape: [${outputShape?.join(', ') || 'null'}]`);
      console.log(`[InferenceService] Expected input: [${EXPECTED_INPUT_SHAPE.join(', ')}]`);
      console.log(`[InferenceService] Expected output: [${EXPECTED_OUTPUT_SHAPE.join(', ')}]`);
    } catch (e: any) {
      errors.push(`Model inspection failed: ${e.message}`);
      console.error(`[InferenceService] Inspection FAILED: ${e.message}`);
    }
  }

  // Step 3: Validate shapes
  const inputValid = inputShape !== null &&
    inputShape.length === EXPECTED_INPUT_SHAPE.length &&
    inputShape.every((dim, i) => dim === EXPECTED_INPUT_SHAPE[i]);

  const outputValid = outputShape !== null &&
    outputShape.length === EXPECTED_OUTPUT_SHAPE.length &&
    outputShape.every((dim, i) => dim === EXPECTED_OUTPUT_SHAPE[i]);

  if (!inputValid) {
    const msg = `Input shape mismatch: got [${inputShape?.join(', ') || 'null'}], expected [${EXPECTED_INPUT_SHAPE.join(', ')}]`;
    errors.push(msg);
    console.error(`[InferenceService] ${msg}`);
  }

  if (!outputValid) {
    const msg = `Output shape mismatch: got [${outputShape?.join(', ') || 'null'}], expected [${EXPECTED_OUTPUT_SHAPE.join(', ')}]`;
    errors.push(msg);
    console.error(`[InferenceService] ${msg}`);
  }

  const success = modelExists && interpreterCreated && inputValid && outputValid && !isUsingMockModel;

  console.log('========================================');
  console.log(`[InferenceService] GATE 4 RESULT: ${success ? 'PASS' : 'FAIL'}`);
  if (errors.length > 0) {
    console.log(`[InferenceService] Errors: ${errors.join('; ')}`);
  }
  console.log('========================================');

  return {
    success,
    modelPath,
    modelExists,
    interpreterCreated,
    inputShape,
    outputShape,
    inputValid,
    outputValid,
    errors,
  };
}

/**
 * Check if using mock model (DEBUG mode)
 */
export function isMockModel(): boolean {
  return isUsingMockModel;
}

/**
 * Get the current model IO contract
 */
export function getModelIOContract(): ModelIOContract | null {
  return modelIOContract;
}

/**
 * Preprocess image data for model input
 * Converts RGB image data to normalized float tensor
 *
 * NOTE: The exact format (NHWC vs NCHW) depends on the exported model.
 * Check model_io_contract.json after export to verify input shape.
 */
export function preprocessImage(
  imageData: Uint8Array,
  width: number,
  height: number
): Float32Array {
  const inputSize = MODEL_INPUT_SIZE;

  // Check model input shape to determine format
  const inputShape = modelIOContract?.inputTensors[0]?.shape;
  const isNHWC = inputShape && inputShape[3] === 3; // [1, H, W, C]
  const isNCHW = inputShape && inputShape[1] === 3; // [1, C, H, W]

  if (isNHWC) {
    // TFLite typically uses NHWC format
    const tensor = new Float32Array(1 * inputSize * inputSize * 3);
    for (let i = 0; i < inputSize * inputSize; i++) {
      const pixelOffset = i * 3;
      tensor[i * 3] = imageData[pixelOffset] / 255.0;     // R
      tensor[i * 3 + 1] = imageData[pixelOffset + 1] / 255.0; // G
      tensor[i * 3 + 2] = imageData[pixelOffset + 2] / 255.0; // B
    }
    return tensor;
  } else {
    // NCHW format (PyTorch convention)
    const tensor = new Float32Array(1 * 3 * inputSize * inputSize);
    for (let i = 0; i < inputSize * inputSize; i++) {
      const pixelOffset = i * 3;
      tensor[i] = imageData[pixelOffset] / 255.0;                        // R
      tensor[inputSize * inputSize + i] = imageData[pixelOffset + 1] / 255.0;     // G
      tensor[2 * inputSize * inputSize + i] = imageData[pixelOffset + 2] / 255.0; // B
    }
    return tensor;
  }
}

/**
 * Compute AABB IoU between two OBBs (axis-aligned approximation)
 * Fast for live preview - ignores rotation angle
 */
function computeAABBIoU(a: OBBModelSpace, b: OBBModelSpace): number {
  // Use half-widths for AABB (ignoring rotation)
  const aHalfW = a.width / 2;
  const aHalfH = a.height / 2;
  const bHalfW = b.width / 2;
  const bHalfH = b.height / 2;

  const aMinX = a.cx - aHalfW;
  const aMaxX = a.cx + aHalfW;
  const aMinY = a.cy - aHalfH;
  const aMaxY = a.cy + aHalfH;

  const bMinX = b.cx - bHalfW;
  const bMaxX = b.cx + bHalfW;
  const bMinY = b.cy - bHalfH;
  const bMaxY = b.cy + bHalfH;

  const interMinX = Math.max(aMinX, bMinX);
  const interMaxX = Math.min(aMaxX, bMaxX);
  const interMinY = Math.max(aMinY, bMinY);
  const interMaxY = Math.min(aMaxY, bMaxY);

  if (interMaxX <= interMinX || interMaxY <= interMinY) {
    return 0;
  }

  const interArea = (interMaxX - interMinX) * (interMaxY - interMinY);
  const aArea = a.width * a.height;
  const bArea = b.width * b.height;
  const unionArea = aArea + bArea - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Apply Non-Maximum Suppression using AABB IoU
 * Matches Python: tools/decode_one.py nms_aabb()
 */
export function applyNMS(
  detections: OBBModelSpace[],
  config: PostprocessConfig = activeConfig
): OBBModelSpace[] {
  if (detections.length === 0) return [];

  // Sort by score descending
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: OBBModelSpace[] = [];

  for (const det of sorted) {
    let shouldKeep = true;

    for (const keptDet of kept) {
      const iou = computeAABBIoU(det, keptDet);
      if (iou > config.nmsIou) {
        shouldKeep = false;
        break;
      }
    }

    if (shouldKeep) {
      kept.push(det);
    }
  }

  return kept;
}

/**
 * Legacy function name for backward compatibility
 * @deprecated Use applyNMS instead
 */
export function applyOBBNMS(
  detections: OBBModelSpace[],
  iouThreshold: number = NMS_IOU_THRESHOLD
): OBBModelSpace[] {
  const tempConfig = { ...activeConfig, nmsIou: iouThreshold };
  return applyNMS(detections, tempConfig);
}

/**
 * Decode raw model output to OBB detections
 *
 * VERIFIED CHANNEL MAPPING (from tools/decode_one.py):
 * - Output shape: [1, 6, 8400]
 * - ch0 = cx (center x in model space 0-640)
 * - ch1 = cy (center y in model space 0-640)
 * - ch2 = w (width)
 * - ch3 = h (height)
 * - ch4 = score (confidence)
 * - ch5 = angle (radians)
 *
 * Canonicalization is applied to ensure w >= h and angle in [-pi/2, pi/2].
 */
export function decodeModelOutput(
  rawOutput: Float32Array | number[],
  outputShape: number[],
  config: PostprocessConfig = activeConfig
): OBBModelSpace[] {
  const detections: OBBModelSpace[] = [];

  if (outputShape.length !== 3) {
    console.error(`[InferenceService] Unexpected output shape: ${outputShape}`);
    return detections;
  }

  const [batch, numChannels, numAnchors] = outputShape;

  // Verified format: [1, 6, 8400] where channels are [cx, cy, w, h, score, angle]
  if (numChannels !== 6) {
    console.error(`[InferenceService] Expected 6 channels, got ${numChannels}`);
    return detections;
  }

  for (let i = 0; i < numAnchors; i++) {
    // Extract values using verified channel mapping
    const cx = rawOutput[0 * numAnchors + i];
    const cy = rawOutput[1 * numAnchors + i];
    let w = rawOutput[2 * numAnchors + i];
    let h = rawOutput[3 * numAnchors + i];
    const score = rawOutput[4 * numAnchors + i];
    let angle = rawOutput[5 * numAnchors + i];

    // Apply confidence threshold early to skip unnecessary work
    if (score < config.thr) {
      continue;
    }

    // Canonicalize: ensure w >= h and normalize angle
    const canonical = canonicalizeOBB(w, h, angle);
    w = canonical.w;
    h = canonical.h;
    angle = canonical.angle;

    detections.push({
      cx,
      cy,
      width: w,
      height: h,
      angle,
      score,
      classId: 0, // Single class model
    });
  }

  return detections;
}

/**
 * Run inference on preprocessed image tensor
 * Returns raw model outputs for debugging
 */
export async function runInferenceRaw(
  inputTensor: Float32Array,
  sessionId?: string
): Promise<RawModelOutput> {
  if (!model) {
    throw new Error('Model not loaded. Call loadModel() first.');
  }

  if (!isModelInspected) {
    throw new Error('GATE 3 VIOLATION: Model must be inspected before inference');
  }

  if (isUsingMockModel) {
    console.warn('[InferenceService] Running mock inference - no real detections');
  }

  console.log('[InferenceService] Running inference...');

  // Run model
  const outputs = model.runSync([inputTensor]);

  // Process outputs
  const rawOutput: RawModelOutput = {
    outputs: [],
    shapes: [],
    notes: isUsingMockModel ? 'MOCK MODEL OUTPUT' : 'Raw model output before postprocessing',
  };

  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i];
    rawOutput.outputs.push(Array.from(output as Float32Array));
    rawOutput.shapes.push(Array.from(modelIOContract!.outputTensors[i].shape));
  }

  // Write raw output for debugging
  if (sessionId) {
    await writeRawModelOutput(sessionId, rawOutput);
  }

  return rawOutput;
}

/**
 * Full postprocess pipeline result
 */
export interface PostprocessResult {
  /** Detections in original image pixel space */
  detections: OBBDetection[];
  /** Detections in model space (before coordinate mapping) */
  detectionsModelSpace: OBBModelSpace[];
  /** Pipeline statistics */
  stats: PostprocessStats;
}

/**
 * Run full postprocess pipeline on raw model output
 * Matches Python: tools/decode_one.py main pipeline
 */
export function runPostprocess(
  rawOutput: Float32Array | number[],
  outputShape: number[],
  letterbox: LetterboxParams,
  config: PostprocessConfig = activeConfig
): PostprocessResult {
  const startTotal = Date.now();

  // Step 1: Decode (includes canonicalization and initial threshold)
  const startDecode = Date.now();
  const decoded = decodeModelOutput(rawOutput, outputShape, config);
  const decodeTime = Date.now() - startDecode;

  // Step 2: NMS
  const startNms = Date.now();
  const afterNms = applyNMS(decoded, config);
  const nmsTime = Date.now() - startNms;

  // Step 3: Geometric filters
  const startGeom = Date.now();
  const afterGeom = applyGeometricFilters(
    afterNms,
    letterbox.srcWidth,
    letterbox.srcHeight,
    config
  );
  const geomTime = Date.now() - startGeom;

  const totalTime = Date.now() - startTotal;

  // Map to original image pixel space
  const detections: OBBDetection[] = afterGeom.map(det =>
    mapModelToOriginalOBB(det, letterbox)
  );

  const stats: PostprocessStats = {
    numRaw: 8400, // Total anchors
    numAfterThr: decoded.length,
    numAfterNms: afterNms.length,
    numAfterGeom: afterGeom.length,
    config,
    timings: {
      decode: decodeTime,
      nms: nmsTime,
      geomFilters: geomTime,
      total: totalTime,
    },
  };

  return { detections, detectionsModelSpace: afterGeom, stats };
}

/**
 * Run full inference pipeline
 * Returns OBB detections in ORIGINAL IMAGE PIXEL SPACE
 */
export async function runInference(
  inputTensor: Float32Array,
  letterbox: LetterboxParams,
  sessionId?: string
): Promise<OBBDetection[]> {
  // Run raw inference
  const rawOutput = await runInferenceRaw(inputTensor, sessionId);

  if (rawOutput.outputs.length === 0) {
    console.warn('[InferenceService] No outputs from model');
    return [];
  }

  // Run postprocess pipeline
  const result = runPostprocess(
    rawOutput.outputs[0],
    rawOutput.shapes[0],
    letterbox,
    activeConfig
  );

  console.log(
    `[InferenceService] Pipeline: ${result.stats.numAfterThr} decoded → ` +
    `${result.stats.numAfterNms} after NMS → ${result.stats.numAfterGeom} filtered`
  );

  return result.detections;
}

/**
 * Run inference with full stats (for capture mode or debugging)
 */
export async function runInferenceWithStats(
  inputTensor: Float32Array,
  letterbox: LetterboxParams,
  config: PostprocessConfig = activeConfig,
  sessionId?: string
): Promise<PostprocessResult> {
  // Run raw inference
  const rawOutput = await runInferenceRaw(inputTensor, sessionId);

  if (rawOutput.outputs.length === 0) {
    console.warn('[InferenceService] No outputs from model');
    return {
      detections: [],
      detectionsModelSpace: [],
      stats: {
        numRaw: 0,
        numAfterThr: 0,
        numAfterNms: 0,
        numAfterGeom: 0,
        config,
      },
    };
  }

  // Run postprocess pipeline
  return runPostprocess(
    rawOutput.outputs[0],
    rawOutput.shapes[0],
    letterbox,
    config
  );
}

/**
 * Unload the model to free memory
 */
export function unloadModel(): void {
  model = null;
  modelIOContract = null;
  isModelInspected = false;
  isUsingMockModel = false;
  console.log('[InferenceService] Model unloaded');
}

/**
 * Get model input size
 */
export function getModelInputSize(): number {
  return MODEL_INPUT_SIZE;
}

/**
 * Get confidence threshold
 */
export function getConfidenceThreshold(): number {
  return CONFIDENCE_THRESHOLD;
}

// ============================================================================
// LIVE PREVIEW THROTTLING
// ============================================================================

/** Minimum interval between inference runs (ms) - 3 FPS max */
const THROTTLE_INTERVAL_MS = 333; // 1000ms / 3 = 333ms per frame

/** Last inference timestamp */
let lastInferenceTime = 0;

/** Whether an inference is currently in progress */
let inferenceInProgress = false;

/**
 * Check if enough time has passed since last inference
 */
export function canRunInference(): boolean {
  if (inferenceInProgress) return false;
  const now = Date.now();
  return now - lastInferenceTime >= THROTTLE_INTERVAL_MS;
}

/**
 * Get time until next allowed inference (ms)
 */
export function getTimeUntilNextInference(): number {
  if (inferenceInProgress) return THROTTLE_INTERVAL_MS;
  const elapsed = Date.now() - lastInferenceTime;
  return Math.max(0, THROTTLE_INTERVAL_MS - elapsed);
}

/**
 * Run throttled inference for live preview
 * Returns null if throttled or already running
 */
export async function runThrottledInference(
  inputTensor: Float32Array,
  letterbox: LetterboxParams,
  sessionId?: string
): Promise<OBBDetection[] | null> {
  if (!canRunInference()) {
    return null;
  }

  inferenceInProgress = true;
  lastInferenceTime = Date.now();

  try {
    return await runInference(inputTensor, letterbox, sessionId);
  } finally {
    inferenceInProgress = false;
  }
}

/**
 * Run throttled inference with stats for debugging
 */
export async function runThrottledInferenceWithStats(
  inputTensor: Float32Array,
  letterbox: LetterboxParams,
  config: PostprocessConfig = LIVE_PREVIEW_PRESET,
  sessionId?: string
): Promise<PostprocessResult | null> {
  if (!canRunInference()) {
    return null;
  }

  inferenceInProgress = true;
  lastInferenceTime = Date.now();

  try {
    return await runInferenceWithStats(inputTensor, letterbox, config, sessionId);
  } finally {
    inferenceInProgress = false;
  }
}

/**
 * Reset throttling state (e.g., when switching modes)
 */
export function resetThrottle(): void {
  lastInferenceTime = 0;
  inferenceInProgress = false;
}

// ============================================================================
// CAPTURE MODE
// ============================================================================

/**
 * Run capture mode inference with accurate postprocessing
 * Uses CAPTURE_PRESET and returns full stats for debug artifacts
 */
export async function runCaptureInference(
  inputTensor: Float32Array,
  letterbox: LetterboxParams,
  sessionId?: string
): Promise<PostprocessResult> {
  // Reset throttle to ensure capture runs immediately
  resetThrottle();

  // Run with capture preset (can enable OBB NMS if needed)
  return runInferenceWithStats(inputTensor, letterbox, CAPTURE_PRESET, sessionId);
}

/**
 * Export detection stats as debug JSON
 */
export function formatStatsForDebug(stats: PostprocessStats): object {
  return {
    counts: {
      raw: stats.numRaw,
      afterThreshold: stats.numAfterThr,
      afterNms: stats.numAfterNms,
      afterGeometricFilters: stats.numAfterGeom,
    },
    config: {
      confidenceThreshold: stats.config.thr,
      nmsIouThreshold: stats.config.nmsIou,
      nmsMode: stats.config.nmsMode,
      minAspectRatio: stats.config.minAspect,
      maxAreaRatio: stats.config.maxAreaRatio,
      minScore: stats.config.minScore,
    },
    timingsMs: stats.timings,
  };
}

/**
 * Log inference run with full context (GATE 5 requirement)
 * Only logs when inference actually runs, not when throttled
 */
export function logInferenceRun(
  context: InferenceContext,
  stats: PostprocessStats
): void {
  const timings = stats.timings || {
    preprocess: 0,
    inference: 0,
    decode: 0,
    nms: 0,
    geomFilters: 0,
    postprocessTotal: 0,
    total: 0,
  };

  console.log('----------------------------------------');
  console.log('[InferenceService] INFERENCE RUN');
  console.log('----------------------------------------');

  // Frame info
  console.log(`  Frame: ${context.frameWidth}x${context.frameHeight}`);
  if (context.viewWidth && context.viewHeight) {
    console.log(`  View: ${context.viewWidth}x${context.viewHeight}`);
  }

  // Transform info
  console.log(`  Rotation: ${context.rotationDegrees}°`);
  console.log(`  Mirrored: ${context.mirrored}`);
  console.log(`  ResizeMode: ${context.resizeMode}`);
  console.log(`  Scale: X=${context.scaleX.toFixed(4)}, Y=${context.scaleY.toFixed(4)}`);
  console.log(`  Offset: X=${context.offsetX.toFixed(1)}, Y=${context.offsetY.toFixed(1)}`);

  // Timings
  console.log(`  Timings (ms):`);
  console.log(`    preprocess=${timings.preprocess}, inference=${timings.inference}`);
  console.log(`    decode=${timings.decode}, nms=${timings.nms}, geom=${timings.geomFilters}`);
  console.log(`    postprocess_total=${timings.postprocessTotal}, TOTAL=${timings.total}`);

  // Warn if postprocess is slow
  if (timings.postprocessTotal > 50) {
    console.warn(`  [WARN] Postprocess > 50ms (${timings.postprocessTotal}ms)`);
  }

  // Counts
  console.log(`  Counts:`);
  console.log(`    anchors=${stats.numRaw}, after_thr=${stats.numAfterThr}, after_nms=${stats.numAfterNms}, after_geom=${stats.numAfterGeom}`);

  console.log('----------------------------------------');
}

/**
 * Create inference context from letterbox params
 */
export function createInferenceContext(
  letterbox: LetterboxParams,
  viewWidth?: number,
  viewHeight?: number,
  rotationDegrees: number = 0,
  mirrored: boolean = false
): InferenceContext {
  return {
    frameWidth: letterbox.srcWidth,
    frameHeight: letterbox.srcHeight,
    viewWidth,
    viewHeight,
    rotationDegrees,
    mirrored,
    resizeMode: 'letterbox',
    scaleX: letterbox.scale,
    scaleY: letterbox.scale, // Letterbox uses uniform scaling
    offsetX: letterbox.padX,
    offsetY: letterbox.padY,
  };
}

/**
 * Run inference with full timing and logging (GATE 5)
 * Logs every run with context, timings, and counts
 */
export async function runInferenceWithLogging(
  inputTensor: Float32Array,
  letterbox: LetterboxParams,
  context: Partial<InferenceContext> = {},
  config: PostprocessConfig = activeConfig,
  sessionId?: string
): Promise<PostprocessResult> {
  const startTotal = Date.now();

  // Build full context
  const fullContext: InferenceContext = {
    frameWidth: letterbox.srcWidth,
    frameHeight: letterbox.srcHeight,
    viewWidth: context.viewWidth,
    viewHeight: context.viewHeight,
    rotationDegrees: context.rotationDegrees ?? 0,
    mirrored: context.mirrored ?? false,
    resizeMode: 'letterbox',
    scaleX: letterbox.scale,
    scaleY: letterbox.scale,
    offsetX: letterbox.padX,
    offsetY: letterbox.padY,
  };

  // Step 1: Preprocess timing (input tensor is already prepared)
  const preprocessTime = 0; // Preprocess happens before this call

  // Step 2: Run inference
  const inferenceStart = Date.now();
  const rawOutput = await runInferenceRaw(inputTensor, sessionId);
  const inferenceTime = Date.now() - inferenceStart;

  if (rawOutput.outputs.length === 0) {
    console.warn('[InferenceService] No outputs from model');
    return {
      detections: [],
      detectionsModelSpace: [],
      stats: {
        numRaw: 0,
        numAfterThr: 0,
        numAfterNms: 0,
        numAfterGeom: 0,
        config,
      },
    };
  }

  // Step 3: Postprocess with timing
  const postprocessStart = Date.now();

  // Decode
  const decodeStart = Date.now();
  const decoded = decodeModelOutput(rawOutput.outputs[0], rawOutput.shapes[0], config);
  const decodeTime = Date.now() - decodeStart;

  // NMS
  const nmsStart = Date.now();
  const afterNms = applyNMS(decoded, config);
  const nmsTime = Date.now() - nmsStart;

  // Geometric filters
  const geomStart = Date.now();
  const afterGeom = applyGeometricFilters(
    afterNms,
    letterbox.srcWidth,
    letterbox.srcHeight,
    config
  );
  const geomTime = Date.now() - geomStart;

  const postprocessTime = Date.now() - postprocessStart;
  const totalTime = Date.now() - startTotal;

  // Map to original space
  const detections: OBBDetection[] = afterGeom.map(det =>
    mapModelToOriginalOBB(det, letterbox)
  );

  const stats: PostprocessStats = {
    numRaw: 8400,
    numAfterThr: decoded.length,
    numAfterNms: afterNms.length,
    numAfterGeom: afterGeom.length,
    config,
    timings: {
      preprocess: preprocessTime,
      inference: inferenceTime,
      decode: decodeTime,
      nms: nmsTime,
      geomFilters: geomTime,
      postprocessTotal: postprocessTime,
      total: totalTime,
    },
  };

  // Log the inference run (GATE 5 requirement)
  logInferenceRun(fullContext, stats);

  return { detections, detectionsModelSpace: afterGeom, stats };
}
