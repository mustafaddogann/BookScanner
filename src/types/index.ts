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
  score: number;   // confidence score [0-1]
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
  score: number;
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
  detectionsOriginal: OBBDetection[];
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
