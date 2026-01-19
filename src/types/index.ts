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
  rectificationMethod?: 'native_opencv' | 'backend' | 'fallback_copy' | 'skipped';
  /** If fallback was used, this is the AABB region that SHOULD have been cropped */
  fallbackAABB?: { x: number; y: number; width: number; height: number };
  /** Reason why rectification was skipped (only when rectificationMethod='skipped') */
  skippedReason?: string;
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
  ocr?: number;
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

// ============================================================================
// Pipeline Mode & ImageSource Types (Architecture Upgrade)
// ============================================================================

/**
 * Pipeline execution mode
 * - 'preview': Fast path for live camera preview (no artifacts, AABB NMS)
 * - 'capture': Full pipeline for final captures (all artifacts, OBB NMS)
 */
export type PipelineMode = 'preview' | 'capture';

/**
 * Image source type discriminator
 */
export type ImageSourceType = 'camera' | 'fixture' | 'replay';

/**
 * Base metadata common to all image sources
 */
export interface ImageSourceMetadata {
  sourceType: ImageSourceType;
  uri: string;
  width: number;
  height: number;
  orientation: number;
  timestamp: number;
}

/**
 * Camera-specific metadata
 */
export interface CameraSourceMetadata extends ImageSourceMetadata {
  sourceType: 'camera';
  deviceId?: string;
  flash?: boolean;
}

/**
 * Fixture-specific metadata
 */
export interface FixtureSourceMetadata extends ImageSourceMetadata {
  sourceType: 'fixture';
  fixtureId: string;
  fixtureName: string;
  groundTruthPath?: string;
}

/**
 * Replay-specific metadata
 */
export interface ReplaySourceMetadata extends ImageSourceMetadata {
  sourceType: 'replay';
  originalSessionId: string;
  tensorPath: string;
  skipPreprocessing: boolean;
}

/**
 * Pipeline options controlling execution behavior
 */
export interface PipelineOptions {
  /** Pipeline mode: 'preview' or 'capture' */
  mode: PipelineMode;
  /** Whether to write debug artifacts to disk */
  writeArtifacts: boolean;
  /** Skip the rectification step */
  skipRectification: boolean;
  /** Save preprocessed tensor for replay capability */
  saveTensorForReplay: boolean;
  /** Override the auto-generated session ID */
  sessionIdOverride?: string;
}

/**
 * Native letterbox truth values from ImagePreprocessor
 * These are the actual values used during native preprocessing
 */
export interface NativeLetterboxTruth {
  decodedW: number;
  decodedH: number;
  modelSize: number;
  scale: number;
  newW: number;
  newH: number;
  padX: number;
  padY: number;
}

/**
 * Saved tensor metadata for replay capability
 * Stored as {sessionDir}/saved_tensor.json
 */
export interface SavedTensor {
  /** Session ID this tensor belongs to */
  sessionId: string;
  /** Absolute path to the saved tensor binary file */
  tensorPath: string;
  /** Tensor shape [1, 640, 640, 3] */
  tensorShape: number[];
  /** Letterbox parameters used during preprocessing */
  letterboxParams: LetterboxParams;
  /** Native preprocessing truth values */
  nativeTruth: NativeLetterboxTruth;
  /** ISO timestamp when tensor was saved */
  createdAt: string;
}

// ============================================================================
// OCR / Text Recognition Types (GATE 6)
// ============================================================================

/**
 * Bounding box for OCR text line
 */
export interface OCRBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A single line of recognized text
 */
export interface OCRLine {
  /** The recognized text content */
  text: string;
  /** Bounding box in image coordinates */
  bbox: OCRBoundingBox;
  /** Confidence score [0-1] */
  confidence: number;
}

/**
 * OCR recognition result
 */
export interface OCRResult {
  /** Whether OCR succeeded */
  ok: boolean;
  /** Error message if failed */
  error?: string;
  /** Reason if skipped */
  skippedReason?: string;
  /** The rotation that produced best results (degrees) */
  chosenRotation: number;
  /** Full concatenated text from all lines */
  fullText: string;
  /** Individual recognized lines with position and confidence */
  lines: OCRLine[];
  /** Average confidence across all lines */
  avgConfidence: number;
  /** Ratio of alphanumeric characters to total characters */
  alnumRatio: number;
  /** Total character count */
  charCount: number;
  /** Total line count */
  lineCount: number;
  /** Best candidate for book title */
  titleCandidate: string | null;
  /** Best candidate for author name */
  authorCandidate: string | null;
  /** Processing time in milliseconds */
  processingTimeMs?: number;
  /** Platform that performed OCR */
  platform?: 'ios' | 'android';
  /** Recognition level used */
  recognitionLevel?: 'fast' | 'accurate';
}

/**
 * OCR summary for a session
 */
export interface OCRSummary {
  /** Total crops processed */
  total: number;
  /** Successfully OCR'd crops */
  succeeded: number;
  /** Skipped crops (no OCR available or failed) */
  skipped: number;
  /** Number of crops with title candidates */
  withTitles: number;
  /** Number of crops with author candidates */
  withAuthors: number;
  /** Most common chosen rotation */
  dominantRotation?: number;
  /** Timestamp when OCR completed */
  completedAt: string;
}

/**
 * Book metadata from external lookup
 */
export interface MetadataMatch {
  /** Match confidence/relevance score */
  score: number;
  /** Book title */
  title: string;
  /** Author name(s) */
  authors: string[];
  /** ISBN-10 or ISBN-13 */
  isbn?: string;
  /** Publisher name */
  publisher?: string;
  /** Publication year */
  publishYear?: string;
  /** Cover image URL */
  coverUrl?: string;
  /** Source of the metadata */
  source: 'openLibrary' | 'googleBooks';
  /** Open Library work/edition key or Google Books volume ID */
  sourceId?: string;
}

/**
 * Options for text recognition
 */
export interface TextRecognitionOptions {
  /** Path to the image file */
  imagePath: string;
  /** Rotations to try in degrees (default: [0, 90, 180, 270]) */
  rotationsToTry?: number[];
  /** Recognition accuracy level */
  recognitionLevel?: 'fast' | 'accurate';
  /** Languages to prioritize (ISO codes) */
  languages?: string[];
}
