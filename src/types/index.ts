// Core type definitions for BookScanner

// ============================================================================
// File Path Type Aliases
// ============================================================================

/**
 * Absolute filesystem path (e.g., /var/mobile/Containers/Data/...)
 * Use for native module calls that expect plain paths.
 */
export type LocalFilePath = string;

/**
 * File URI with scheme (e.g., file:///var/mobile/Containers/Data/...)
 * Use for React Native Image source.uri and other RN components.
 */
export type LocalFileUri = string;

// ============================================================================
// Image Types
// ============================================================================

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
  grouping?: number;
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
  Home: undefined;
  Scanner: { importUri?: string } | undefined;
  Results: {
    sessionId: string;
  };
  Debug: undefined;
  Settings: undefined;
  Diagnostics: {
    sessionId?: string;
  } | undefined;
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
  /** Per-rotation trial results (for mixed-orientation support) */
  rotationTrials?: RotationTrialResult[];
}

/**
 * Result from a single rotation trial during OCR
 */
export interface RotationTrialResult {
  /** Rotation angle (0, 90, 180, 270) */
  rotation: number;
  /** Full text from this rotation */
  fullText: string;
  /** Lines recognized at this rotation */
  lines: OCRLine[];
  /** Average confidence */
  avgConfidence: number;
  /** Alphanumeric ratio */
  alnumRatio: number;
  /** Character count */
  charCount: number;
  /** Composite quality score used for ranking */
  qualityScore: number;
  /** Title candidate from this rotation */
  titleCandidate: string | null;
  /** Author candidate from this rotation */
  authorCandidate: string | null;
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

// ============================================================================
// Gate 7: Book Candidate Grouping
// ============================================================================

/**
 * Unique identifier for a book candidate within a session
 */
export type BookCandidateId = string;

/**
 * A single line of evidence from OCR with provenance tracking
 */
export interface BookEvidenceLine {
  /** The recognized text content */
  text: string;
  /** Normalized text for comparison (lowercase, no punctuation) */
  normalizedText: string;
  /** Confidence score [0-1] */
  confidence: number;
  /** Which crop this line came from */
  sourceCropIndex: number;
  /** Rotation applied when OCR'd (degrees) */
  rotation: number;
  /** Bounding box in crop coordinates (optional) */
  bbox?: OCRBoundingBox;
}

/**
 * Source kind for evidence - determines ISBN handling policy
 * - spine_crop: ISBN is non-fatal noise, never used for lookup
 * - back_cover: Valid ISBN triggers lookup first
 * - inside_page: Valid ISBN triggers lookup first
 * - unknown: Conservative approach, treat as spine_crop
 */
export type EvidenceSourceKind = 'spine_crop' | 'back_cover' | 'inside_page' | 'unknown';

/**
 * ISBN candidate extracted from evidence with validation info
 */
export interface EvidenceIsbnCandidate {
  /** Raw string as extracted from OCR */
  raw: string;
  /** Normalized to digits only (uppercase X for ISBN-10 check digit) */
  normalized: string;
  /** ISBN type: 'isbn10' or 'isbn13' */
  type: 'isbn10' | 'isbn13';
  /** Whether checksum is valid */
  checksumValid: boolean;
}

/**
 * ISBN policy debug info
 */
export interface IsbnPolicyDebug {
  /** Source kind that determined the policy */
  sourceKind: EvidenceSourceKind;
  /** Policy that was applied */
  policyApplied: 'ignore' | 'boost_only' | 'lookup_first';
  /** Raw ISBN-like strings found (before validation) */
  candidatesRaw: string[];
  /** Valid ISBN candidates (checksum passed) */
  candidatesValid: EvidenceIsbnCandidate[];
  /** Whether ISBN lookup was attempted */
  lookupAttempted: boolean;
  /** Result of ISBN lookup if attempted */
  lookupResult?: 'success' | 'not_found' | 'error' | 'skipped';
}

/**
 * Merged evidence from multiple crops for a book candidate
 */
export interface BookEvidence {
  /** Top K crop indices selected for evidence (sorted by quality) */
  topCrops: number[];
  /** De-duplicated lines with provenance */
  mergedLines: BookEvidenceLine[];
  /** Full merged text block (lines joined with newline) */
  mergedTextBlock: string;
  /** Per-field hints extracted from evidence (optional, for Gate 8) */
  perFieldHints?: {
    titleHints: string[];
    authorHints: string[];
  };
  /** Source kind for ISBN policy (default: spine_crop for spine OCR) */
  sourceKind?: EvidenceSourceKind;
  /** ISBN policy debug info */
  isbnPolicy?: IsbnPolicyDebug;
}

/**
 * UI guess for immediate display (NOT canonical - will be replaced by resolver)
 * This is resolver-input only, never used for primary UI display.
 */
export interface UIGuess {
  /** Guessed title from local extraction */
  title: string | null;
  /** Guessed author from local extraction */
  author: string | null;
  /** Confidence in the guess [0-1] */
  confidence: number;
}

/**
 * Hypothesis data for resolver (Gate 8)
 * IMPORTANT: This is resolver-input ONLY, never used for UI display.
 * UI display uses legacy extraction (evidence.perFieldHints or OCR results).
 */
export interface BookHypothesis {
  /** Evidence quality tier */
  evidenceTier: EvidenceTier;
  /** Search candidates for resolver lookup */
  searchCandidates: SearchCandidate[];
  /** ISBN candidates extracted from OCR */
  isbnCandidates: string[];
  /** UI guess (resolver-input only, NOT for display) */
  uiGuess: UIGuess | null;
}

/**
 * A book candidate representing one physical book on the shelf
 * Groups multiple detections/crops that likely belong to the same book
 */
export interface BookCandidate {
  /** Unique ID within the session */
  id: BookCandidateId;
  /** Detection indices that belong to this candidate */
  detectionIndices: number[];
  /** Crop indices for this candidate (successful rectifications only) */
  cropIndices: number[];
  /** Index of the representative detection (highest score, used for display) */
  representativeDetectionIndex: number;
  /** Stable ordering key (for left-to-right shelf order) */
  orderingKey: number;
  /** Average angle of detections in radians */
  angleRad: number;
  /** Combined confidence score (max of all detections) */
  confidenceScore: number;
  /** Merged OCR evidence */
  evidence: BookEvidence;

  // ============================================================================
  // Gate 8: Hypothesis (resolver-input ONLY, gated by METADATA_RESOLUTION_ENABLED)
  // NEVER use for UI display - use evidence.perFieldHints instead
  // ============================================================================

  /**
   * Hypothesis for resolver (Gate 8)
   * Only populated when METADATA_RESOLUTION_ENABLED is true.
   * NEVER use for UI display.
   */
  hypothesis?: BookHypothesis;

  // ============================================================================
  // Gate 9: Resolver (CANONICAL)
  // ============================================================================

  /** Canonical resolved book from resolver (Gate 9) */
  resolvedBook?: ResolvedBook;

  /** Match confidence from resolver [0-1] (Gate 9) */
  resolvedConfidence?: number;

  /** Suggestions for manual review (Gate 9) */
  resolverSuggestions?: ResolvedBook[];

  /** Resolver decision (Gate 9)
   * - accept: Auto-accepted with high confidence (persisted)
   * - suggested: Suggested match for optional user review (NOT persisted)
   * - reject: No matching book found
   * - pending: Resolution in progress
   * - disabled: Metadata resolution feature is OFF
   * - offline: Network unavailable
   * - error: Resolution failed with error
   */
  resolverDecision?: 'accept' | 'reject' | 'suggested' | 'pending' | 'disabled' | 'offline' | 'error';

  /** Resolver decision reason (Gate 9) */
  resolverDecisionReason?: string;

  /** Verification flags from resolver (Gate 9) */
  resolverFlags?: ResolverFlag[];

  /** Evidence-driven search debug info (Gate 9) */
  evidenceSearchDebug?: {
    /** Decision from evidence scoring */
    decision?: 'accept_high' | 'accept_medium' | 'suggested' | 'reject';
    /** Pass 1 decision (before boost) */
    pass1Decision?: 'accept_high' | 'accept_medium' | 'suggested' | 'reject';
    /** Pass used (1 or 2) */
    passUsed?: number;
    /** Whether boost pass was triggered */
    boostTriggered?: boolean;
    /** Decision reason */
    reason?: string;
    /** Gap between top and second candidate */
    scoreGap?: number;
    /** Number of hypotheses generated */
    hypothesesCount: number;
    /** Total queries tried */
    queriesTriedCount?: number;
    /** Query strings tried */
    queriesTried: string[];
    /** Total candidates found */
    candidatesFound: number;
    /** Top candidate scores */
    topScores: Array<{ title: string; score: number; overlapCount?: number; isbnMatched?: boolean }>;
    /** Search time in ms */
    searchTimeMs: number;
    /** Whether this was flagged for manual review (ambiguity) */
    manualReview?: boolean;
    /** Whether auto-persisted */
    autoPersisted?: boolean;
  };

  // ============================================================================
  // Gate 10: Corrections Memory
  // ============================================================================

  /** Applied correction from corrections memory (Gate 10) */
  appliedCorrection?: Correction;
}

/**
 * Verification flag from resolver
 */
export interface ResolverFlag {
  flag: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  penalty: number;
}

/**
 * Summary of book candidate grouping results
 */
export interface BookCandidatesSummary {
  /** Number of raw detections before grouping */
  rawDetections: number;
  /** Number of successful crops */
  rawCrops: number;
  /** Number of book candidates after grouping */
  candidates: number;
  /** Average crops per candidate */
  avgCropsPerCandidate: number;
}

// ============================================================================
// Gate 8: Hypothesis Generation Types
// ============================================================================

/**
 * Evidence quality tier based on crop and OCR quality
 * Used by Gate 8 to classify evidence and adjust resolver scoring
 * Tier multipliers: strong=1.0, usable=0.85, weak=0.6, unusable=0
 */
export type EvidenceTier = 'strong' | 'usable' | 'weak' | 'unusable';

/**
 * Search candidate generated from OCR evidence
 * Used to query metadata sources
 */
export interface SearchCandidate {
  /** The search query string */
  query: string;
  /** Extracted title hint (may be partial) */
  titleHint?: string;
  /** Extracted author hint (may be partial) */
  authorHint?: string;
  /** ISBN if detected (ISBN-10 or ISBN-13, normalized) */
  isbn?: string;
  /** Publisher hint (from spine field extraction) */
  publisherHint?: string;
  /** Edition hint (from spine field extraction) */
  editionHint?: string;
  /** Year hint (from spine field extraction) */
  yearHint?: string;
  /** Confidence in this candidate [0-1] */
  confidence: number;
  /** Source crop index */
  cropIndex: number;
  /** Evidence tier of source */
  tier: EvidenceTier;
  /** Tokenized query for coverage scoring */
  tokens: string[];
}

/**
 * Signals used to compute match score
 */
export interface MatchSignals {
  /** Query title (normalized) */
  queryTitle: string;
  /** Result title (normalized) */
  resultTitle: string;
  /** Query author (normalized, optional) */
  queryAuthor?: string;
  /** Result author (normalized, optional) */
  resultAuthor?: string;
  /** Whether query had an author hint */
  queryHadAuthor: boolean;
  /** Whether ISBN matched between query and result */
  isbnMatched: boolean;
  /** Number of query tokens found in result */
  queryTokensInResult: number;
  /** Total query token count */
  queryTokenCount: number;
  /** Position of result in search results (0-indexed) */
  resultPosition: number;
}

/**
 * Resolved book with composite score
 */
export interface ScoredMatch {
  /** The resolved book metadata */
  book: ResolvedBook;
  /** Composite score [0-1] */
  composite: number;
  /** Normalized signal values (each 0-1) */
  normalizedSignals: Record<string, number>;
  /** Raw match signals */
  signals: MatchSignals;
}

/**
 * Resolved book metadata (enhanced MetadataMatch)
 */
export interface ResolvedBook {
  /** Book title */
  title: string;
  /** Author name(s) */
  authors: string[];
  /** ISBN-13 (preferred) */
  isbn13?: string;
  /** ISBN-10 */
  isbn10?: string;
  /** Publisher name */
  publisher?: string;
  /** Publication year */
  publishYear?: string;
  /** Edition info */
  edition?: string;
  /** Cover image URL */
  coverUrl?: string;
  /** Source of the metadata */
  source: 'openLibrary' | 'googleBooks' | 'manual' | 'ocr';
  /** Source-specific ID */
  sourceId?: string;
  /**
   * Stable book ID from books_catalog (Supabase UUID).
   * Only populated after upsert to books_catalog.
   * Use as canonical reference for corrections linking.
   */
  bookId?: string;
}

/**
 * Verification flags indicating potential issues with a match
 */
export type VerificationFlag =
  | 'author-mismatch'
  | 'isbn-mismatch'
  | 'token-coverage-low'
  | 'suspicious-edition'
  | 'year-implausible'
  | 'publisher-mismatch'
  | 'edition-conflict';

/**
 * Result of match verification
 */
export interface VerificationResult {
  /** Whether verification passed (no flags) */
  passed: boolean;
  /** Flags indicating issues found */
  flags: VerificationFlag[];
  /** Confidence after penalty adjustments [0-1] */
  adjustedConfidence: number;
  /** Total penalty applied */
  penalty: number;
}

/**
 * Accept high decision - ISBN match + high score (persisted to Supabase)
 */
export interface AcceptanceAcceptHigh {
  action: 'accept_high';
  book: ResolvedBook;
  confidence: number;
}

/**
 * Accept medium decision - high score + dominance (persisted to Supabase)
 */
export interface AcceptanceAcceptMedium {
  action: 'accept_medium';
  book: ResolvedBook;
  confidence: number;
}

/**
 * Suggested decision - moderate score, shown to user but NOT persisted
 * User can optionally review, but no action required
 */
export interface AcceptanceSuggested {
  action: 'suggested';
  book: ResolvedBook;
  confidence: number;
  alternatives: ResolvedBook[];
}

/**
 * Reject decision - no viable match found
 */
export interface AcceptanceReject {
  action: 'reject';
  reason: string;
}

/**
 * Legacy types for backwards compatibility
 * @deprecated Use new action types
 */
export interface AcceptanceAutoAccept {
  action: 'auto-accept';
  book: ResolvedBook;
  confidence: number;
}

export interface AcceptanceSuggest {
  action: 'suggest';
  book: ResolvedBook;
  alternatives: ResolvedBook[];
  warnings?: VerificationFlag[];
  confidence: number;
}

export interface AcceptanceAmbiguous {
  action: 'ambiguous';
  candidates: ResolvedBook[];
  reason?: string;
  warnings?: VerificationFlag[];
}

export interface AcceptanceNoMatch {
  action: 'no-match';
  fallback: 'manual-entry' | 'ocr-only';
}

/**
 * Acceptance decision union type
 */
export type AcceptanceDecision =
  | AcceptanceAcceptHigh
  | AcceptanceAcceptMedium
  | AcceptanceSuggested
  | AcceptanceReject
  // Legacy types for backwards compatibility
  | AcceptanceAutoAccept
  | AcceptanceSuggest
  | AcceptanceAmbiguous
  | AcceptanceNoMatch;

/**
 * Per-crop evidence classification
 */
export interface CropEvidenceClassification {
  /** Crop/detection index */
  cropIndex: number;
  /** Evidence tier */
  tier: EvidenceTier;
  /** OCR confidence */
  ocrConfidence: number;
  /** Character count */
  charCount: number;
  /** Alnum ratio */
  alnumRatio: number;
  /** Rectification status */
  rectificationStatus: 'success' | 'skipped' | 'failed';
  /** Blur score if available */
  blurScore?: number;
}

/**
 * Session-level evidence summary
 */
export interface EvidenceSummary {
  /** Overall session tier (best available) */
  sessionTier: EvidenceTier;
  /** Per-crop classifications */
  cropClassifications: CropEvidenceClassification[];
  /** Count by tier */
  tierCounts: Record<EvidenceTier, number>;
}

/**
 * Metadata resolution state for a book candidate
 */
export interface MetadataResolutionState {
  /** Evidence tier used for resolution */
  evidenceTier: EvidenceTier;
  /** Search candidates generated (for debugging) */
  searchCandidates?: SearchCandidate[];
  /** The acceptance decision */
  decision: AcceptanceDecision;
  /** Resolved book if any */
  resolvedBook?: ResolvedBook;
  /** Alternative matches if any */
  alternatives?: ResolvedBook[];
  /** Verification flags if any */
  verificationFlags?: VerificationFlag[];
  /** Resolution timestamp */
  resolvedAt?: string;
  /** Whether resolution was from offline queue */
  fromOfflineQueue?: boolean;
  /** Resolved candidates from Supabase resolver (Gate 9) */
  resolvedCandidates?: BookCandidate[];
  /** Evidence-driven search debug info */
  evidenceSearchDebug?: {
    /** Decision from evidence scoring */
    decision?: 'accept_high' | 'accept_medium' | 'suggested' | 'reject';
    /** Pass 1 decision (before boost) */
    pass1Decision?: 'accept_high' | 'accept_medium' | 'suggested' | 'reject';
    /** Pass used (1 or 2) */
    passUsed?: number;
    /** Whether boost pass was triggered */
    boostTriggered?: boolean;
    /** Decision reason */
    reason?: string;
    /** Gap between top and second candidate */
    scoreGap?: number;
    /** Number of hypotheses generated */
    hypothesesCount: number;
    /** Total queries tried */
    queriesTriedCount?: number;
    /** Query strings tried */
    queriesTried: string[];
    /** Total candidates found */
    candidatesFound: number;
    /** Top candidate scores */
    topScores: Array<{ title: string; score: number; overlapCount?: number; isbnMatched?: boolean }>;
    /** Search time in ms */
    searchTimeMs: number;
    /** Whether this was flagged for manual review (ambiguity) */
    manualReview?: boolean;
    /** Whether auto-persisted */
    autoPersisted?: boolean;
  };
}

// ============================================================================
// Gate 10: Corrections Memory Types
// ============================================================================

/**
 * Key for corrections lookup - either ISBN or content hash
 */
export type CorrectionKey = string;

/**
 * A user correction for a book
 * Stored in MMKV and applied automatically on future scans
 */
export interface Correction {
  /** Hash of original OCR content (for matching when no ISBN) */
  contentHash: string;
  /** ISBN if available (preferred key) */
  isbn: string | null;
  /** Corrected title (null means unchanged) */
  correctedTitle: string | null;
  /** Corrected author (null means unchanged) */
  correctedAuthor: string | null;
  /** Original title before correction */
  originalTitle: string | null;
  /** Original author before correction */
  originalAuthor: string | null;
  /** Timestamp when correction was created */
  createdAt: string;
  /** Number of times this correction was auto-applied */
  applyCount: number;
}

/**
 * Result of applying corrections to a candidate
 */
export interface CorrectionApplyResult {
  /** The candidate (possibly modified) */
  candidate: BookCandidate;
  /** Whether a correction was applied */
  applied: boolean;
  /** The correction that was applied (if any) */
  correction?: Correction;
}

// ============================================================================
// Spine Field Extraction Types (Enhanced Field Extraction)
// ============================================================================

/**
 * ISBN type discriminator
 */
export type ISBNType = 'isbn10' | 'isbn13';

/**
 * Base field candidate with provenance
 */
export interface BaseFieldCandidate {
  /** Extracted value */
  value: string;
  /** Confidence score [0-1] */
  confidence: number;
  /** Source line index in merged evidence */
  sourceLineIndex: number;
  /** Source crop index */
  cropIndex: number;
}

/**
 * ISBN candidate with type and normalization
 */
export interface ISBNCandidate extends BaseFieldCandidate {
  /** ISBN type (10 or 13) */
  type: ISBNType;
  /** Normalized ISBN (digits only, uppercase X for ISBN-10) */
  normalized: string;
  /** Original raw text before normalization */
  raw: string;
}

/**
 * Publisher candidate
 */
export interface PublisherCandidate extends BaseFieldCandidate {
  /** Detection method */
  method: 'keyword' | 'pattern' | 'known-publisher';
}

/**
 * Edition candidate
 */
export interface EditionCandidate extends BaseFieldCandidate {
  /** Detected edition number if any */
  editionNumber?: number;
  /** Edition type (numbered, revised, etc.) */
  editionType?: 'numbered' | 'revised' | 'updated' | 'reprint' | 'other';
}

/**
 * Year candidate
 */
export interface YearCandidate extends BaseFieldCandidate {
  /** Parsed year number */
  year: number;
  /** Context where year was found */
  context?: 'copyright' | 'edition' | 'publisher' | 'standalone';
}

/**
 * Title candidate with classification info
 */
export interface TitleCandidate extends BaseFieldCandidate {
  /** Whether this came from splitting a combined line */
  fromSplit?: boolean;
  /** Character count (used for ranking) */
  charCount: number;
  /** Word count */
  wordCount: number;
}

/**
 * Author candidate with classification info
 */
export interface AuthorCandidate extends BaseFieldCandidate {
  /** Whether this came from splitting a combined line */
  fromSplit?: boolean;
  /** Detected via "by" pattern */
  fromByPattern?: boolean;
  /** Person name confidence (heuristic) */
  nameConfidence: number;
}

/**
 * Complete spine field evidence extracted from OCR
 */
export interface SpineFieldEvidence {
  /** ISBN candidates (validated) */
  isbnCandidates: ISBNCandidate[];
  /** Publisher candidates */
  publisherCandidates: PublisherCandidate[];
  /** Edition candidates */
  editionCandidates: EditionCandidate[];
  /** Year candidates */
  yearCandidates: YearCandidate[];
  /** Title candidates (ranked by confidence) */
  titleCandidates: TitleCandidate[];
  /** Author candidates (ranked by confidence) */
  authorCandidates: AuthorCandidate[];
  /** Full normalized text for verification */
  fullTextNormalized: string;
  /** Best ISBN (if any) */
  bestIsbn?: string;
  /** Best title (if any) */
  bestTitle?: string;
  /** Best author (if any) */
  bestAuthor?: string;
  /** Best publisher (if any) */
  bestPublisher?: string;
  /** Best edition (if any) */
  bestEdition?: string;
  /** Best year (if any) */
  bestYear?: number;
}
