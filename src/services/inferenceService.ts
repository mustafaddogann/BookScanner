/**
 * TFLite Inference Service for YOLOv8 OBB
 *
 * STRICT MODE: No fallbacks. Model must exist.
 *
 * STOP-THE-LINE GATE: MODEL IO CONTRACT INSPECTION
 * Before running inference, we inspect and record model IO contract.
 */

import { Platform } from 'react-native';
import { loadTensorflowModel, TensorflowModel } from 'react-native-fast-tflite';
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
const CONFIDENCE_THRESHOLD = 0.25;
const NMS_IOU_THRESHOLD = 0.45;

// DEBUG FLAG: Set to true ONLY for development without model
// MUST be false in production
const DEBUG_ALLOW_MISSING_MODEL = false;

let model: TensorflowModel | null = null;
let modelIOContract: ModelIOContract | null = null;
let isModelInspected = false;
let isUsingMockModel = false;

/**
 * Get model path based on platform
 */
function getModelPath(): string {
  return Platform.select({
    ios: 'yolov8_obb.tflite',
    android: 'yolov8_obb.tflite',
  }) || 'yolov8_obb.tflite';
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
 */
export async function loadModel(): Promise<void> {
  if (model) {
    console.log('[InferenceService] Model already loaded');
    return;
  }

  console.log('[InferenceService] Loading model...');
  const modelPath = getModelPath();

  try {
    // Try loading from bundled assets
    model = await loadTensorflowModel({ url: `asset://models/${modelPath}` } as any);
    isUsingMockModel = false;
    console.log('[InferenceService] Model loaded successfully from assets');
  } catch (error: any) {
    console.error('[InferenceService] FAILED to load model:', error.message);

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
        `MODEL LOADING FAILED: ${modelPath} not found.\n` +
        'Ensure the TFLite model is bundled in src/models/yolov8_obb.tflite\n' +
        'iOS: Add to Xcode project "Copy Bundle Resources"\n' +
        'Android: Place in android/app/src/main/assets/models/\n' +
        `Original error: ${error.message}`
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
 * Apply Non-Maximum Suppression to OBB detections
 */
export function applyOBBNMS(
  detections: OBBModelSpace[],
  iouThreshold: number = NMS_IOU_THRESHOLD
): OBBModelSpace[] {
  if (detections.length === 0) return [];

  // Sort by score descending
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: OBBModelSpace[] = [];

  for (const det of sorted) {
    let shouldKeep = true;

    for (const keptDet of kept) {
      const iou = computeOBBIoU(det, keptDet);
      if (iou > iouThreshold) {
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
 * Compute IoU between two OBBs (simplified axis-aligned approximation)
 */
function computeOBBIoU(a: OBBModelSpace, b: OBBModelSpace): number {
  const aMinX = a.cx - a.width / 2;
  const aMaxX = a.cx + a.width / 2;
  const aMinY = a.cy - a.height / 2;
  const aMaxY = a.cy + a.height / 2;

  const bMinX = b.cx - b.width / 2;
  const bMaxX = b.cx + b.width / 2;
  const bMinY = b.cy - b.height / 2;
  const bMaxY = b.cy + b.height / 2;

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

  return interArea / unionArea;
}

/**
 * Decode raw model output to OBB detections
 *
 * IMPORTANT: This function MUST match the actual model output format.
 * Run ml/scripts/inspect_model.py after export to verify the output shape.
 *
 * Typical YOLOv8-OBB output formats:
 * - [1, 6, num_anchors] for single class: [x, y, w, h, angle, conf]
 * - [1, 5+num_classes, num_anchors] for multi-class OBB
 */
export function decodeModelOutput(
  rawOutput: Float32Array | number[],
  outputShape: number[],
  confidenceThreshold: number = CONFIDENCE_THRESHOLD
): OBBModelSpace[] {
  const detections: OBBModelSpace[] = [];

  console.log(`[InferenceService] Decoding output shape: [${outputShape.join(', ')}]`);

  if (outputShape.length !== 3) {
    console.error(`[InferenceService] Unexpected output shape: ${outputShape}`);
    return detections;
  }

  const [batch, dim1, dim2] = outputShape;

  // Determine format based on shape
  // Format A: [1, num_features, num_anchors] where num_features >= 6
  // Format B: [1, num_anchors, num_features] where num_features < num_anchors

  let numAnchors: number;
  let numFeatures: number;
  let isTransposed: boolean;

  if (dim1 < dim2 && dim1 >= 6) {
    // Format A: [1, features, anchors] - typical YOLO output
    numFeatures = dim1;
    numAnchors = dim2;
    isTransposed = false;
  } else if (dim2 >= 6) {
    // Format B: [1, anchors, features]
    numFeatures = dim2;
    numAnchors = dim1;
    isTransposed = true;
  } else {
    console.error(`[InferenceService] Cannot determine output format: [${outputShape.join(', ')}]`);
    return detections;
  }

  console.log(`[InferenceService] Format: ${isTransposed ? 'B [anchors, features]' : 'A [features, anchors]'}`);
  console.log(`[InferenceService] Features: ${numFeatures}, Anchors: ${numAnchors}`);

  // YOLOv8-OBB typically outputs:
  // For single class: [x, y, w, h, angle, class_conf] = 6 features
  // For multi-class: [x, y, w, h, angle, class0_conf, class1_conf, ...] = 5 + num_classes

  const numClasses = numFeatures - 5; // x, y, w, h, angle = 5 base features

  for (let i = 0; i < numAnchors; i++) {
    let cx, cy, w, h, angle, bestScore, bestClassId;

    if (isTransposed) {
      // Format B: row-major [anchors, features]
      const offset = i * numFeatures;
      cx = rawOutput[offset];
      cy = rawOutput[offset + 1];
      w = rawOutput[offset + 2];
      h = rawOutput[offset + 3];
      angle = rawOutput[offset + 4];

      // Find best class score
      bestScore = 0;
      bestClassId = 0;
      for (let c = 0; c < numClasses; c++) {
        const classScore = rawOutput[offset + 5 + c];
        if (classScore > bestScore) {
          bestScore = classScore;
          bestClassId = c;
        }
      }
    } else {
      // Format A: column-major [features, anchors]
      cx = rawOutput[0 * numAnchors + i];
      cy = rawOutput[1 * numAnchors + i];
      w = rawOutput[2 * numAnchors + i];
      h = rawOutput[3 * numAnchors + i];
      angle = rawOutput[4 * numAnchors + i];

      // Find best class score
      bestScore = 0;
      bestClassId = 0;
      for (let c = 0; c < numClasses; c++) {
        const classScore = rawOutput[(5 + c) * numAnchors + i];
        if (classScore > bestScore) {
          bestScore = classScore;
          bestClassId = c;
        }
      }
    }

    if (bestScore >= confidenceThreshold) {
      detections.push({
        cx,
        cy,
        width: w,
        height: h,
        angle: normalizeAngle(angle),
        score: bestScore,
        classId: bestClassId,
      });
    }
  }

  console.log(`[InferenceService] Decoded ${detections.length} detections above threshold ${confidenceThreshold}`);
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

  // Decode to model-space detections
  const modelDetections = decodeModelOutput(
    rawOutput.outputs[0],
    rawOutput.shapes[0]
  );

  // Apply NMS
  const nmsDetections = applyOBBNMS(modelDetections);

  console.log(`[InferenceService] ${nmsDetections.length} detections after NMS`);

  // Map to original image pixel space
  const originalDetections: OBBDetection[] = nmsDetections.map(det =>
    mapModelToOriginalOBB(det, letterbox)
  );

  return originalDetections;
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
