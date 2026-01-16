// Core type definitions for BookScanner

/**
 * Image metadata extracted after capture
 */
export interface ImageMeta {
  uri: string;
  width: number;
  height: number;
  fileSize: number;
  timestamp: number;
  orientation: number; // EXIF orientation (1-8)
  isNormalized: boolean; // true if rotation has been applied
}

/**
 * Letterbox parameters for model input preparation
 */
export interface LetterboxParams {
  scale: number;
  padX: number;
  padY: number;
  srcWidth: number;
  srcHeight: number;
  dstWidth: number;
  dstHeight: number;
}

/**
 * Oriented Bounding Box detection in ORIGINAL IMAGE PIXEL SPACE
 * Center-based representation with rotation
 */
export interface OBBDetection {
  cx: number;      // center x in original pixels
  cy: number;      // center y in original pixels
  width: number;   // box width in original pixels
  height: number;  // box height in original pixels
  angle: number;   // rotation angle in RADIANS
  score: number;   // confidence probability [0-1] (sigmoid applied)
  rawScore?: number; // raw logit score before sigmoid
  classId: number; // class index
  className?: string;
}

/**
 * OBB in model space (640x640)
 */
export interface OBBModelSpace {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  score: number;    // probability [0-1] (sigmoid applied)
  rawScore?: number; // raw logit score before sigmoid
  classId: number;
}

/**
 * 4-corner polygon representation of OBB
 */
export interface OBBCorners {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
}

/**
 * Screen space mapping for overlay rendering
 */
export interface ScreenMapping {
  scale: number;
  offsetX: number;
  offsetY: number;
  displayWidth: number;
  displayHeight: number;
}

/**
 * Rectification result metadata
 */
export interface RectifyResult {
  cropUri: string;
  sourceCorners: OBBCorners;
  outputWidth: number;
  outputHeight: number;
  paddingUsed: number;
  detectionIndex: number;
  /** Method used for rectification */
  rectificationMethod?: 'native_opencv' | 'backend' | 'fallback_copy';
  /** If fallback was used, this is the AABB region that SHOULD have been cropped */
  fallbackAABB?: { x: number; y: number; width: number; height: number };
}

/**
 * Model IO tensor info
 */
export interface TensorInfo {
  name: string;
  shape: number[];
  dtype: string;
  quantization?: {
    scale?: number;
    zeroPoint?: number;
  };
}

/**
 * Model IO contract from inspection
 */
export interface ModelIOContract {
  inputTensors: TensorInfo[];
  outputTensors: TensorInfo[];
  inspectedAt: string;
  modelPath: string;
}

/**
 * Timing measurements for a pipeline stage
 */
export interface StageTiming {
  stageName: string;
  startTime: number;
  endTime: number;
  durationMs: number;
}

/**
 * Pipeline timings collection
 */
export interface PipelineTimings {
  acquisition?: number;
  meta?: number;
  letterbox?: number;
  inference?: number;
  postprocess?: number;
  overlayPrep?: number;
  rectification?: number;
  total?: number;
}

/**
 * Inference context for debug manifest (GATE 6)
 */
export interface InferenceContextManifest {
  frameWidth: number;
  frameHeight: number;
  viewWidth?: number;
  viewHeight?: number;
  rotationDegrees: number;
  mirrored: boolean;
  resizeMode: 'letterbox' | 'stretch';
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Postprocess statistics for debug manifest (GATE 6)
 */
export interface PostprocessStatsManifest {
  counts: {
    raw: number;
    afterThreshold: number;
    afterNms: number;
    afterGeometricFilters: number;
  };
  config: {
    confidenceThreshold: number;
    nmsIouThreshold: number;
    nmsMode: string;
    minAspectRatio: number;
    maxAreaRatio: number;
    minScore: number;
  };
  timingsMs: {
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
 * Serialized FrameGeo for manifest storage
 */
export interface SerializedFrameGeo {
  normalizedUri: string;
  pixelW: number;
  pixelH: number;
  rotationDeg: number;
  mirrored: boolean;
  exifOrientation: number;
  modelSize: number;
  letterbox: {
    scale: number;
    padX: number;
    padY: number;
    srcWidth: number;
    srcHeight: number;
    dstWidth: number;
    dstHeight: number;
  };
  createdAt: number;
  paddingAxis: 'horizontal' | 'vertical';
}

/**
 * Input tensor preprocessing metadata for manifest
 */
export interface InputTensorMeta {
  /** Path to input_tensor_stats.json */
  inputTensorStatsPath?: string;
  /** Path to input_tensor_preview.ppm */
  inputTensorPreviewPath?: string;
  /** Padding fill value (normalized, e.g., 114/255 ≈ 0.447) */
  paddingFillValue: number;
  /** Channel order: RGB or BGR */
  channelOrder: 'RGB' | 'BGR';
  /** Normalization mode (e.g., 'divide_255') */
  normalizationMethod: string;
  /** Tensor shape [1, H, W, C] or [1, C, H, W] */
  tensorShape: number[];
  /** Tensor format: NHWC or NCHW */
  tensorFormat: string;
}

/**
 * Debug manifest written for each pipeline run
 */
export interface DebugManifest {
  sessionId: string;
  createdAt: string;
  source: 'camera' | 'fixture';
  fixtureName?: string;
  imageMeta: ImageMeta;
  rotationPolicy: string;
  letterboxParams: LetterboxParams;
  modelIO: ModelIOContract | string; // path or embedded

  // Detection arrays in different coordinate spaces (GATE 6)
  detectionsModelSpace?: OBBModelSpace[]; // cx,cy,w,h,angle,score in 640-space
  detectionsFrameSpace?: OBBDetection[]; // mapped to photo pixels (same as detectionsOriginal)
  detectionsViewSpace?: OBBDetection[]; // mapped to preview/canvas (if applicable)
  detectionsOriginal: OBBDetection[]; // Legacy field, same as detectionsFrameSpace

  // Inference context with all mapping params (GATE 6)
  inferenceContext?: InferenceContextManifest;
  postprocessStats?: PostprocessStatsManifest;

  /** FrameGeo - single source of truth for all geometry (serialized) */
  frameGeo?: SerializedFrameGeo | object;

  /** Input tensor preprocessing metadata */
  inputTensorMeta?: InputTensorMeta;

  selectedDetectionIndex?: number;
  rectification?: RectifyResult[];
  timings: PipelineTimings;
  errors: string[];
  angleConvention?: string;
}

/**
 * Scan session stored in MMKV
 */
export interface ScanSession {
  sessionId: string;
  createdAt: string;
  source: 'camera' | 'fixture';
  fixtureName?: string;
  imagePath: string;
  sessionDir: string;
  detectionCount: number;
  status: 'pending' | 'processing' | 'completed' | 'error';
  errorMessage?: string;
}

/**
 * Fixture definition
 */
export interface FixtureInfo {
  id: string;
  name: string;
  uri: string;
  source: 'bundled' | 'device';
  width?: number;
  height?: number;
  expectedDetections?: number;
  description?: string;
  // Optional ground truth labels for validation
  groundTruthLabels?: string;
}

/**
 * Raw model output before mapping
 */
export interface RawModelOutput {
  outputs: number[][];
  shapes: number[][];
  notes: string;
  rawTensorData?: any;
}

/**
 * Navigation param types
 */
export type RootStackParamList = {
  Scanner: undefined;
  Results: {
    sessionId: string;
  };
  Debug: undefined;
};
