# BookScanner

A React Native application for detecting book spines using YOLOv8 Oriented Bounding Boxes (OBB).

## Features

- **Camera Capture**: High-quality still image capture using VisionCamera
- **OBB Detection**: YOLOv8 OBB model inference for oriented bounding box detection
- **SVG Overlay**: Visual overlay of detections with tap selection
- **Rectification**: Perspective transform to generate upright crop images
- **Fixture System**: Bundled and device fixtures for testing
- **Debug Artifacts**: Comprehensive logging and JSON debug outputs

## Quick Start

```bash
# 1. Install app dependencies
npm install

# 2. Train the ML model (see ML Training section)
cd ml && ./scripts/train_obb.sh

# 3. Export to TFLite
./scripts/export_tflite.sh

# 4. Inspect model IO contract
python scripts/inspect_model.py

# 5. Build and run the app
cd .. && npm run ios  # or npm run android
```

## Project Structure

```
BookScanner/
├── src/
│   ├── screens/          # App screens
│   ├── services/         # Business logic
│   ├── utils/            # Utility functions
│   ├── types/            # TypeScript definitions
│   ├── models/           # TFLite model files (yolov8_obb.tflite)
│   └── store/            # Zustand state management
├── ml/                   # ML training workspace
│   ├── datasets/         # Training datasets
│   ├── runs/             # Training outputs
│   └── scripts/          # Training and export scripts
├── docs/                 # Documentation
│   └── gates.md          # Stop-the-line gate checklist
├── backend/              # FastAPI rectification service
├── ios/                  # iOS native project
└── android/              # Android native project
```

## ML Training

### Prerequisites

```bash
cd ml
python3 -m venv venv
source venv/bin/activate
pip install ultralytics>=8.3.0 tensorflow
```

### Dataset Setup

The dataset should already be extracted to `ml/datasets/open_shelves/`:

```
ml/datasets/open_shelves/
├── train/images/    # 446 training images
├── train/labels/    # OBB labels (class x1 y1 x2 y2 x3 y3 x4 y4)
├── valid/images/    # 35 validation images
├── valid/labels/
└── data.yaml        # Dataset configuration
```

### Training

```bash
cd ml
source venv/bin/activate
./scripts/train_obb.sh
```

This trains a YOLO11n-OBB model for 100 epochs. Outputs are saved to `ml/runs/obb/train/`.

### Export to TFLite

```bash
./scripts/export_tflite.sh
```

This exports `best.pt` to TFLite and copies it to `src/models/yolov8_obb.tflite`.

### Inspect Model IO Contract

**CRITICAL**: Run this after export to understand the actual output tensor format:

```bash
python scripts/inspect_model.py
```

This produces `ml/model_io_contract.json` documenting:
- Input tensor shape (e.g., `[1, 640, 640, 3]`)
- Output tensor shape (e.g., `[1, 6, 8400]`)
- Output format analysis

The decode logic in `inferenceService.ts` MUST match the actual output format.

### Retraining with New Data

1. Add new images and labels to `ml/datasets/open_shelves/train/`
2. Update `data.yaml` if class names change
3. Run training: `./scripts/train_obb.sh`
4. Export: `./scripts/export_tflite.sh`
5. Inspect: `python scripts/inspect_model.py`
6. Update decode logic if output format changed

## Stop-the-Line Gates

See `docs/gates.md` for the full checklist. Summary:

| Gate | Description | Pass Criteria |
|------|-------------|---------------|
| 0 | Dataset Integrity | train/valid dirs exist, labels in OBB format |
| 1 | Training Complete | `best.pt` exists, mAP50 > 0.1 |
| 2 | TFLite Export | `yolov8_obb.tflite` exists, size > 1MB |
| 3 | Model IO Contract | `model_io_contract.json` written, output understood |
| 4 | Decode Logic Matches | Test image produces valid detections |
| 5 | End-to-End Works | Overlay aligns, crops show upright text |

**IMPORTANT**: Do NOT proceed past a failed gate.

## Coordinate Spaces

1. **ORIGINAL IMAGE PIXEL SPACE**: Canonical space for all detections. Origin (0,0) is top-left.

2. **MODEL SPACE**: 640x640 letterboxed input. Scale + padding applied.

3. **SCREEN SPACE**: Rendered image rect on device. Measured via onLayout.

## App Installation

```bash
# Install dependencies
npm install

# iOS
cd ios && bundle install && bundle exec pod install && cd ..
npm run ios

# Android
npm run android
```

## Model Bundling

After exporting `yolov8_obb.tflite` to `src/models/`:

### iOS
1. Open `ios/BookScanner.xcworkspace` in Xcode
2. Drag `src/models/yolov8_obb.tflite` into project
3. Ensure "Copy Bundle Resources" includes the file

### Android
```bash
mkdir -p android/app/src/main/assets/models
cp src/models/yolov8_obb.tflite android/app/src/main/assets/models/
```

## Debug Artifacts

Each pipeline run creates `Documents/sessions/{sessionId}/`:

- `debug_manifest.json` - Full pipeline state
- `original.jpg` - Input image copy
- `model_io.json` - Tensor specifications
- `detections_raw.json` - Raw model output
- `coordinate_test.json` - Mapping verification
- `angle_test.json` - Angle convention check
- `crops/crop_*.jpg` - Rectified crops

## Backend Rectification

Fallback when native OpenCV unavailable:

```bash
cd backend
pip install -r requirements.txt
python main.py  # Runs on http://localhost:8000
```

## Verification

Run from repo root to verify the TFLite model:

```bash
python3 -m pip install pillow numpy tensorflow
python3 tools/inspect_tflite.py
python3 tools/run_one_tflite.py
```

Outputs written to `debug/model_io.json` and `debug/detections_raw.json`.

## Testing

```bash
npm test                              # All tests
npm run test:coverage                 # With coverage
npm test -- --testPathPattern="letterbox"  # Specific test
```

## Dependencies

- react-native-vision-camera - Camera capture
- react-native-fast-tflite - TFLite inference
- react-native-svg - SVG overlay
- react-native-mmkv - Storage
- react-native-fs - File system
- zustand - State management
- ultralytics - Training (Python)
- tensorflow - TFLite inspection (Python)

## License

MIT
