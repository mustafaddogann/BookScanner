# BookScanner Pipeline Documentation

This document describes the image processing pipeline used by BookScanner to detect and extract book spine information from photographs.

**Related Documentation:**
- [docs/project_plan.md](./project_plan.md) - Project roadmap and Gates 7-10 (metadata extraction)
- [docs/gates.md](./gates.md) - Stop-the-line gate checklist
- [docs/build.md](./build.md) - Build troubleshooting

---

## Pipeline Overview

The pipeline processes captured images through the following stages:

```
Image Capture
     │
     ▼
┌─────────────────┐
│   1. META       │ ─── Extract EXIF metadata, normalize orientation
└─────────────────┘
     │
     ▼
┌─────────────────┐
│  2. LETTERBOX   │ ─── Build FrameGeo, compute letterbox params
└─────────────────┘
     │
     ▼
┌─────────────────┐
│  3. INFERENCE   │ ─── YOLOv8 OBB model detection
└─────────────────┘
     │
     ▼
┌─────────────────┐
│ 4. POSTPROCESS  │ ─── Decode anchors, NMS, geometry filters
└─────────────────┘
     │
     ▼
┌─────────────────┐
│ 5. OVERLAY-PREP │ ─── Prepare detection overlays for UI
└─────────────────┘
     │
     ▼
┌─────────────────┐
│ 6. RECTIFICATION│ ─── Extract and deskew book spine crops
└─────────────────┘
     │
     ▼
┌─────────────────┐
│     7. OCR      │ ─── Text recognition on crops
└─────────────────┘
     │
     ▼
┌─────────────────┐
│  8. GROUPING    │ ─── Cluster detections into book candidates
└─────────────────┘
     │
     ▼
┌─────────────────┐
│ 9. METADATA     │ ─── QUALITY_CLASSIFY → HYPOTHESIZE → RESOLVE → VERIFY → DECIDE
│    RESOLUTION   │     (feature-flagged: METADATA_RESOLUTION_ENABLED)
└─────────────────┘
     │
     ▼
┌ ─ ─ ─ ─ ─ ─ ─ ─ ┐
│ 10. EXTRACTION  │ ─── Gate 8: Extract title/author/ISBN/publisher
└ ─ ─ ─ ─ ─ ─ ─ ─ ┘     (see project_plan.md)
     │
     ▼
┌ ─ ─ ─ ─ ─ ─ ─ ─ ┐
│  11. RESOLVER   │ ─── Gate 9: External lookup (planned)
└ ─ ─ ─ ─ ─ ─ ─ ─ ┘     (see project_plan.md)
     │
     ▼
┌ ─ ─ ─ ─ ─ ─ ─ ─ ┐
│ 12. CORRECTIONS │ ─── Gate 10: Apply remembered corrections
└ ─ ─ ─ ─ ─ ─ ─ ─ ┘     (see project_plan.md)
```

**Note:** Stages 10-12 (dashed boxes) are planned but not yet implemented. See [project_plan.md](./project_plan.md) for details.

---

## Current Implementation Status

| Stage | Status | Platform |
|-------|--------|----------|
| 1. Meta | Implemented | iOS, Android |
| 2. Letterbox | Implemented | iOS, Android |
| 3. Inference | Implemented | iOS, Android |
| 4. Postprocess | Implemented | iOS, Android |
| 5. Overlay-Prep | Implemented | iOS, Android |
| 6. Rectification | Implemented | iOS only (CoreImage) |
| 7. OCR | Implemented | iOS (Vision), Android (ML Kit) |
| 8. Grouping | Implemented | iOS, Android |
| 9. Metadata Resolution | Implemented (feature-flagged) | iOS, Android |
| 10. Extraction | Planned | See Gate 8 |
| 11. Resolver | Planned | See Gate 9 |
| 12. Corrections | Planned | See Gate 10 |

---

## Stage Details

### 1. Meta Stage

**Purpose:** Extract image metadata and prepare for processing.

**Operations:**
- Normalize URI format (ensure `file://` prefix)
- Build `ImageMeta` with dimensions and EXIF orientation
- Write `input_normalized.jpg` (EXIF rotation applied to pixels)
- Generate `display.jpg` (downscaled for UI rendering, max 1280px)

**Outputs:**
- `input_normalized.jpg` - Full resolution, EXIF-normalized image
- `display.jpg` - Downscaled for UI (avoids PERF ASSETS warnings)

### 2. Letterbox Stage

**Purpose:** Prepare image geometry for model input.

**Operations:**
- Build `FrameGeo` as single source of truth for coordinate mapping
- Compute letterbox parameters (scale, padding)
- Run coordinate roundtrip test to validate mapping accuracy

**Key Concept - FrameGeo:**
```typescript
interface FrameGeo {
  uri: string;
  pixelW: number;      // Normalized image width
  pixelH: number;      // Normalized image height
  orientation: number; // EXIF orientation value
  modelSize: number;   // Model input size (640)
  letterbox: {
    scale: number;     // Scale factor from image to model
    padX: number;      // Left padding in model space
    padY: number;      // Top padding in model space
    srcWidth: number;
    srcHeight: number;
    dstWidth: number;
    dstHeight: number;
  };
}
```

### 3. Inference Stage

**Purpose:** Run YOLOv8 OBB model to detect book spines.

**Operations:**
- Preprocess image with native `ImagePreprocessor.preprocessForTFLite`
- Create 640x640 input tensor (NHWC format, float32)
- Run TFLite model inference
- Write diagnostic artifacts (tensor stats, letterbox preview)

**Model Input:**
- Format: NHWC (batch, height, width, channels)
- Size: [1, 640, 640, 3]
- Normalization: divide by 255
- Padding fill value: 114 (gray)

**Model Output:**
- Shape: [1, 8400, 6] (batch, anchors, channels)
- Channels: [cx, cy, w, h, score, angle]

### 4. Postprocess Stage

**Purpose:** Decode model output into usable detections.

**Operations:**
1. **Threshold Filter:** Keep anchors with score > threshold
2. **OBB NMS:** Non-maximum suppression for oriented boxes
3. **Geometry Filters:**
   - Aspect ratio check (reject if too square)
   - Area ratio check (reject if too large)
   - Bounds check (reject if outside image)
   - Score check (final confidence threshold)
4. **Coordinate Mapping:** Transform from model space to image space

**Configuration (SPINE_PRESET):**
```typescript
{
  thr: 0.25,          // Score threshold
  nmsIou: 0.45,       // NMS IoU threshold
  nmsMode: 'OBB',     // Use oriented box NMS
  minAspect: 2.0,     // Minimum height/width ratio
  maxAreaRatio: 0.5,  // Maximum box area / image area
  minScore: 0.3       // Final score threshold
}
```

### 5. Overlay-Prep Stage

**Purpose:** Prepare detection data for UI rendering.

**Operations:**
- Store detections in app state
- Store `SessionMeta` with geometry info
- Prepare for SVG overlay rendering

### 6. Rectification Stage

**Purpose:** Extract straightened book spine images.

**Platform Support:**
- **iOS:** Uses CoreImage `CIPerspectiveCorrection` filter, max 2048px output
- **Android:** Not yet implemented (returns `skipped`)

**Operations:**
- For each detection, compute perspective transform
- Extract crop with deskewing
- Save as `crop_{index}.jpg`

**Rectification Methods:**
- `native_perspective` - CoreImage perspective correction (iOS)
- `skipped` - Detection too small, invalid, or platform unsupported

**Service Location:** `src/services/rectificationService.ts`

### 7. OCR Stage

**Purpose:** Extract text from book spine crops.

**Platform Support:**
- **iOS:** Apple Vision `VNRecognizeTextRequest` with accurate recognition level
- **Android:** ML Kit text recognition

**Operations:**
- Try 4 rotations (0°, 90°, 180°, 270°)
- Score each rotation by: confidence × alnum ratio × sqrt(char count)
- Select best rotation
- Extract title and author candidates via heuristics
- Store results in `SessionMeta.ocrResultsByCropIndex`

**Service Location:** `src/services/textRecognitionService.ts`

**Post-Processing:** `src/services/ocrPostProcessingService.ts`
- Normalize lines (trim, collapse whitespace)
- Filter noise (ISBN patterns, URLs, prices, barcodes)
- Extract title/author candidates
- Support user edits via `SessionMeta.userEdits`

---

### 8. Grouping Stage

**Purpose:** Cluster multiple detections/crops that belong to the same physical book.

**Problem Solved:** Multiple detections may represent the same book (overlapping regions, different angles). This stage groups them into book candidates.

**Algorithm:** Uses a **conservative-by-default** approach to avoid incorrectly merging unrelated spines:

**Merge Conditions (ONLY merges under strict conditions):**
1. **High IoU Path (≥0.50):** Duplicate detections that heavily overlap
2. **Split-Detection Path:** ALL conditions must be met:
   - Angle difference ≤ 10°
   - Center distance ≤ 15% of min dimension
   - OCR text similarity ≥ 0.75 (**REQUIRED** - no OCR = no merge)

**Safety Cap:** If any candidate would have >3 crops after merging, falls back to 1:1 mapping (no merges at all).

**Key Services:**
- `bookCandidateGrouper.ts` - Conservative clustering with IoU and OCR-based merge paths
- `spineEvidenceMerger.ts` - Merge OCR from top K crops per candidate

**Configuration (Conservative):**
```typescript
const IOU_MERGE_THRESHOLD = 0.50;           // Minimum IoU to merge as duplicates
const SPLIT_ANGLE_THRESHOLD_RAD = 0.175;    // ~10 degrees max angle difference
const SPLIT_CENTER_DIST_RATIO = 0.15;       // Center proximity as % of min dimension
const SPLIT_OCR_SIMILARITY_THRESHOLD = 0.75; // Minimum OCR text similarity
const MAX_CROPS_PER_CANDIDATE = 3;          // Safety cap - triggers fallback if exceeded
```

**Debug Artifact:** When `DEBUG_ARTIFACTS_ENABLED` is true, writes `grouping_assignments.json` with:
- Which crops/detections belong to each candidate
- Merge decisions with details (reason, IoU, angle diff, center dist, text similarity)
- Whether safety fallback was triggered
- Configuration thresholds used

**Output:** `SessionMeta.bookCandidates[]`, `SessionMeta.bookCandidatesSummary`

**Tests:** 19 comprehensive unit tests covering all merge paths and edge cases

---

### 9. Metadata Resolution Stage

**Purpose:** Classify evidence quality, generate search candidates, and make acceptance decisions.

**Feature Flag:** `METADATA_RESOLUTION_ENABLED` (OFF by default)

**Operations:** Runs a 5-phase pipeline:

```
QUALITY_CLASSIFY → HYPOTHESIZE → RESOLVE → VERIFY → DECIDE
```

1. **QUALITY_CLASSIFY:** Classify evidence quality for each crop
   - Tiers: `strong`, `usable`, `weak`, `unusable`
   - Based on OCR confidence, alphanumeric ratio, text length

2. **HYPOTHESIZE:** Generate search candidates from evidence
   - Extract ISBN using OCR-tolerant normalization
   - Build title/author hints from evidence lines
   - When `METADATA_FIELD_EXTRACTION_ENABLED`: Extract publisher, edition, year
   - Enhanced title/author classification to fix OCR assignment errors
   - Rank candidates by evidence quality

3. **RESOLVE:** Search metadata provider for matches
   - ISBN lookup (most reliable)
   - Text search fallback (title + author)
   - Provider is pluggable (via `MetadataLookupProvider` interface)

4. **VERIFY:** Score and rank matches
   - Composite score: 40% title + 30% ISBN + 20% author + 10% year
   - Verification flags: author-mismatch, isbn-mismatch, token-coverage-low
   - With field extraction: publisher-mismatch, edition-conflict

5. **DECIDE:** Make acceptance decision
   - `auto-accept`: High confidence, clear winner
   - `suggest`: Likely match but needs confirmation
   - `ambiguous`: Multiple valid candidates
   - `no-match`: No suitable matches found

**Key Services:**
| Service | Purpose |
|---------|---------|
| `evidenceQualityService.ts` | Classify crop evidence tiers |
| `searchCandidateService.ts` | Generate search candidates |
| `metadataResolverService.ts` | Score and rank matches |
| `matchVerificationService.ts` | Verify matches and generate flags |
| `acceptanceDecisionService.ts` | Make final acceptance decisions |
| `metadataResolutionOrchestrator.ts` | Orchestrate full pipeline |
| `metadataLookupProvider.ts` | Provider interface |
| `metadataLookupProviderFactory.ts` | Provider factory |
| `offlineResolutionQueue.ts` | Queue for offline retry |

**Types:**
```typescript
// Evidence tiers
type EvidenceTier = 'strong' | 'usable' | 'weak' | 'unusable';

// Acceptance decisions
type AcceptanceAction = 'auto-accept' | 'suggest' | 'ambiguous' | 'no-match';

// Verification flags
type VerificationFlag =
  | 'author-mismatch'
  | 'isbn-mismatch'
  | 'token-coverage-low'
  | 'suspicious-edition'
  | 'year-implausible'
  | 'publisher-mismatch'   // From field extraction
  | 'edition-conflict';    // From field extraction
```

**Feature Flags (in `src/config/debug.ts`):**
```typescript
METADATA_RESOLUTION_ENABLED      // Enable metadata resolution (default: false)
METADATA_FIELD_EXTRACTION_ENABLED // Enable enhanced field extraction (default: false)
METADATA_OFFLINE_QUEUE_ENABLED   // Enable offline queue (default: false)
METADATA_VERBOSE_DEBUG           // Verbose logging (default: false)
```

**Output:**
- `SessionMeta.evidenceSummary` - Evidence quality summary
- `SessionMeta.metadataResolution` - Resolution state and decision
- `SessionMeta.metadataQueuedForOffline` - Whether queued for offline retry

---

## Future Pipeline Stages (Gates 8-10)

The following stages are planned to improve metadata extraction accuracy. See [project_plan.md](./project_plan.md) for full implementation details.

### 10. Extraction Stage (Gate 8)

**Purpose:** Extract structured fields (title, author, ISBN, publisher, edition) from merged evidence.

**Key Components:**
- `spineFieldExtractor.ts` - Pattern matching and ranking
- `isbnValidator.ts` - ISBN-10/13 checksum validation with OCR-tolerant normalization

**Output:** `BookCandidate.extractedFields`

### 11. Resolver Stage (Gate 9)

**Purpose:** Correct OCR errors and fill missing fields using external databases.

**Key Components:**
- `bookResolverService.ts` - Provider orchestration
- `openLibraryProvider.ts` - Open Library API
- `resolverCache.ts` - MMKV cache with TTL

**Output:** `BookCandidate.resolvedMetadata`

### 12. Corrections Stage (Gate 10)

**Purpose:** Apply user corrections from previous scans automatically.

**Key Components:**
- `correctionsMemory.ts` - Match by ISBN or content hash
- `useCorrectionsStore.ts` - MMKV-backed persistence

**Output:** `BookCandidate.appliedCorrection`

---

## Coordinate Systems

The pipeline uses multiple coordinate systems that must be carefully tracked:

### 1. Pixel Space (Image Coordinates)

- Origin: Top-left of normalized image
- Units: Pixels
- Range: (0,0) to (pixelW, pixelH)
- Used by: Detection results, rectification

### 2. Model Space (Letterbox Coordinates)

- Origin: Top-left of 640x640 model input
- Units: Pixels (in model input)
- Range: (0,0) to (640, 640)
- Includes gray padding areas
- Used by: Raw model output

### 3. Screen Space (Display Coordinates)

- Origin: Top-left of image container
- Units: Pixels (screen)
- Scaled and offset from pixel space
- Used by: SVG overlay rendering

### Coordinate Transformation

**Model Space → Pixel Space:**
```
pixel_x = (model_x - padX) / scale
pixel_y = (model_y - padY) / scale
```

**Pixel Space → Screen Space:**
```
screen_x = pixel_x * screenMapping.scale + screenMapping.offsetX
screen_y = pixel_y * screenMapping.scale + screenMapping.offsetY
```

---

## OBB (Oriented Bounding Box) Format

Detections use oriented bounding boxes with 5 parameters:

```
┌──────────────────────────┐
│                          │
│        (cx, cy) ●        │  ← Center point
│                          │
│    width ←────────→      │
│                          │
│    ↑ height              │
│                          │
└──────────────────────────┘
          ↻ angle (radians, CCW from x-axis)
```

**OBB to Corners:**
```typescript
function obbToCorners(obb: OBBDetection): OBBCorners {
  const hw = obb.width / 2;
  const hh = obb.height / 2;
  const cos = Math.cos(obb.angle);
  const sin = Math.sin(obb.angle);

  return {
    topLeft:     { x: cx - hw*cos + hh*sin, y: cy - hw*sin - hh*cos },
    topRight:    { x: cx + hw*cos + hh*sin, y: cy + hw*sin - hh*cos },
    bottomRight: { x: cx + hw*cos - hh*sin, y: cy + hw*sin + hh*cos },
    bottomLeft:  { x: cx - hw*cos - hh*sin, y: cy - hw*sin + hh*cos },
  };
}
```

---

## Session Artifacts

Each pipeline run creates a session directory with the following structure:

```
sessions/
└── scan_1705678901234_abc123/
    ├── original.jpg              # Raw captured image
    ├── input_normalized.jpg      # EXIF-normalized (full res)
    ├── display.jpg               # Downscaled for UI (max 1280px)
    ├── letterbox_640_preview.jpg # Model input visualization
    ├── debug_manifest.json       # Session metadata
    ├── coordinate_test.json      # Mapping validation
    ├── letterbox_meta.json       # Letterbox parameters
    ├── input_tensor_stats.json   # Tensor statistics
    ├── score_sanity.json         # Score distribution analysis
    ├── nms_witness.json          # NMS debugging info
    ├── filtered_detections.json  # Final detection list
    └── crops/
        ├── crop_0.jpg            # Rectified spine image
        ├── crop_0_meta.json      # Crop metadata
        ├── crop_1.jpg
        └── ...
```

---

## Debug Artifacts

When `DEBUG_ARTIFACTS_ENABLED = true`, additional artifacts are written:

- `overlay_modelspace_raw.jpg` - Pre-NMS detections on letterbox preview
- `overlay_modelspace_nms.jpg` - Post-NMS detections on letterbox preview
- `detections_raw.json` - Raw model output
- `preprocess_debug.json` - Preprocessing parameters

---

## Data Flow: SessionMeta

All pipeline results flow through `SessionMeta` in the Zustand store (single source of truth):

```typescript
interface SessionMeta {
  // Geometry (from stages 1-2)
  frameGeo: SerializedFrameGeo | null;
  imageDimensions: { width: number; height: number } | null;
  normalizedImagePath: string | null;
  displayImagePath: string | null;
  displayImageScale: number;

  // Rectification (from stage 6)
  rectificationResults: DetectionRectifyInfo[];
  rectificationSummary: { total: number; succeeded: number; skipped: number };

  // OCR (from stage 7)
  ocrResultsByCropIndex: Record<number, OCRResult>;
  ocrSummary: OCRSummary;

  // User edits
  userEdits: Record<number, { title?: string; author?: string }>;

  // Grouping (from stage 8)
  bookCandidates: BookCandidate[];
  bookCandidatesSummary: BookCandidatesSummary;

  // Metadata Resolution (from stage 9, feature-flagged)
  evidenceSummary?: EvidenceSummary;           // Evidence quality per crop
  metadataResolution?: MetadataResolutionState; // Resolution decision
  metadataQueuedForOffline?: boolean;           // Queued for offline retry
}
```

---

## Error Handling

The pipeline tracks errors at each stage:

- Errors are logged but don't necessarily abort the pipeline
- `write_errors.log` records any artifact write failures
- `debug_manifest.json` includes an `errors` array
- Session `status` is set to `'error'` if any critical failures occur

---

## Performance Notes

- Display image (`display.jpg`) is capped at 1280px to avoid PERF ASSETS warnings
- Artifact writing can be disabled for preview mode
- AABB NMS is faster than OBB NMS (used in preview mode)
- Model warmup runs on app start to reduce first-inference latency
- Rectification outputs capped at 2048px on iOS

---

## Service Files

| Service | Location | Purpose |
|---------|----------|---------|
| `pipelineService.ts` | `src/services/` | Orchestrates full pipeline |
| `inferenceService.ts` | `src/services/` | TFLite model inference |
| `rectificationService.ts` | `src/services/` | Native module bridge for rectification |
| `textRecognitionService.ts` | `src/services/` | Native OCR bridge |
| `ocrPostProcessingService.ts` | `src/services/` | Title/author heuristics, noise filtering |
| `debugArtifacts.ts` | `src/services/` | Debug file writing |

**Grouping services (Stage 8):**
| Service | Purpose |
|---------|---------|
| `bookCandidateGrouper.ts` | Cluster detections into candidates |
| `spineEvidenceMerger.ts` | Merge OCR from multiple crops |

**Metadata Resolution services (Stage 9, feature-flagged):**
| Service | Purpose |
|---------|---------|
| `evidenceQualityService.ts` | Classify evidence tier per crop |
| `searchCandidateService.ts` | Generate search candidates from evidence |
| `spineFieldExtractionService.ts` | Extract ISBN, publisher, edition, year, title, author (feature-flagged) |
| `metadataResolverService.ts` | Score and rank matches |
| `matchVerificationService.ts` | Verify matches, generate flags (incl. publisher-mismatch, edition-conflict) |
| `acceptanceDecisionService.ts` | Make acceptance decisions |
| `metadataResolutionOrchestrator.ts` | Orchestrate full pipeline |
| `metadataLookupProvider.ts` | Provider interface |
| `metadataLookupProviderFactory.ts` | Provider factory |
| `offlineResolutionQueue.ts` | Queue for offline retry |
| `stringSimilarity.ts` | Fuzzy string matching |
| `isbnUtils.ts` | ISBN parsing and validation |

**Future services (Gates 8-10):**
| Service | Purpose |
|---------|---------|
| `spineFieldExtractor.ts` | Extract structured fields |
| `bookResolverService.ts` | External lookup orchestration |
| `openLibraryProvider.ts` | Open Library API |
| `resolverCache.ts` | Lookup result caching |
| `correctionsMemory.ts` | User correction persistence |
