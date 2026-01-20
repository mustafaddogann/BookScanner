# BookScanner Pipeline Documentation

This document describes the image processing pipeline used by BookScanner to detect and extract book spine information from photographs.

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
```

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

**Operations:**
- For each detection, compute perspective transform
- Extract crop with deskewing
- Save as `crop_{index}.jpg`

**Rectification Methods:**
- `native_affine` - Core Graphics affine transform
- `native_perspective` - Core Graphics perspective transform
- `skipped` - Detection too small or invalid

### 7. OCR Stage

**Purpose:** Extract text from book spine crops.

**Operations:**
- Run Vision framework text recognition
- Extract title and author candidates
- Apply heuristics to separate title from author

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

## Debug Artifacts

When `DEBUG_ARTIFACTS_ENABLED = true`, additional artifacts are written:

- `overlay_modelspace_raw.jpg` - Pre-NMS detections on letterbox preview
- `overlay_modelspace_nms.jpg` - Post-NMS detections on letterbox preview
- `detections_raw.json` - Raw model output
- `preprocess_debug.json` - Preprocessing parameters

## Error Handling

The pipeline tracks errors at each stage:

- Errors are logged but don't necessarily abort the pipeline
- `write_errors.log` records any artifact write failures
- `debug_manifest.json` includes an `errors` array
- Session `status` is set to `'error'` if any critical failures occur

## Performance Notes

- Display image (`display.jpg`) is capped at 1280px to avoid PERF ASSETS warnings
- Artifact writing can be disabled for preview mode
- AABB NMS is faster than OBB NMS (used in preview mode)
- Model warmup runs on app start to reduce first-inference latency
