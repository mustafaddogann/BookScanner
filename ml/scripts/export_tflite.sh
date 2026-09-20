#!/bin/bash
# Export trained OBB model to TFLite

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ML_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$ML_DIR")"
BEST_PT="$ML_DIR/runs/obb/train/weights/best.pt"
OUTPUT_DIR="$PROJECT_ROOT/src/models"
OUTPUT_FILE="$OUTPUT_DIR/yolov8_obb.tflite"

echo "=== TFLite Export ==="
echo "Source: $BEST_PT"
echo "Output: $OUTPUT_FILE"

# Verify best.pt exists
if [ ! -f "$BEST_PT" ]; then
    echo "ERROR: best.pt not found at $BEST_PT"
    echo "Run training first: ./scripts/train_obb.sh"
    exit 1
fi

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Export to TFLite
echo ""
echo "Exporting to TFLite (imgsz=640)..."
cd "$ML_DIR"
yolo export \
    model="$BEST_PT" \
    format=tflite \
    imgsz=640

# Find the exported file
EXPORTED_FILE="$ML_DIR/runs/obb/train/weights/best_saved_model/best_float32.tflite"
if [ ! -f "$EXPORTED_FILE" ]; then
    # Try alternative location
    EXPORTED_FILE="$ML_DIR/runs/obb/train/weights/best_float32.tflite"
fi

if [ ! -f "$EXPORTED_FILE" ]; then
    # Search for it
    echo "Searching for exported TFLite file..."
    EXPORTED_FILE=$(find "$ML_DIR/runs" -name "*.tflite" -type f | head -1)
fi

if [ -z "$EXPORTED_FILE" ] || [ ! -f "$EXPORTED_FILE" ]; then
    echo "ERROR: TFLite file not found after export"
    echo "Check export logs above for errors"
    exit 1
fi

echo "Found exported file: $EXPORTED_FILE"

# Copy to src/models
cp "$EXPORTED_FILE" "$OUTPUT_FILE"

echo ""
echo "=== Export Complete ==="

# Verify output
if [ -f "$OUTPUT_FILE" ]; then
    SIZE=$(ls -la "$OUTPUT_FILE" | awk '{print $5}')
    echo "✓ Gate 2 PASS: TFLite file exists"
    echo "  Path: $OUTPUT_FILE"
    echo "  Size: $SIZE bytes"

    if [ "$SIZE" -lt 1000000 ]; then
        echo "⚠ WARNING: File size seems small (<1MB), verify model is valid"
    fi
else
    echo "✗ Gate 2 FAIL: TFLite file not created"
    exit 1
fi

# Fan the single source of truth out to the platform bundle locations.
# src/models/yolov8_obb.tflite is the only copy tracked in git; ios/ and
# android/app/src/main/assets/models/ are generated and gitignored.
echo ""
echo "Syncing model into platform bundles..."
cd "$PROJECT_ROOT"
node scripts/syncModel.js
