#!/bin/bash
# Train YOLOv8/YOLO11 OBB model on Open Shelves dataset

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ML_DIR="$(dirname "$SCRIPT_DIR")"
DATASET_DIR="$ML_DIR/datasets/open_shelves"
DATA_YAML="$DATASET_DIR/data.yaml"

echo "=== YOLOv8 OBB Training ==="
echo "ML Directory: $ML_DIR"
echo "Dataset: $DATASET_DIR"
echo "Data YAML: $DATA_YAML"

# Verify dataset exists
if [ ! -f "$DATA_YAML" ]; then
    echo "ERROR: data.yaml not found at $DATA_YAML"
    echo "Run: unzip 'Open Shelves.v9i.yolov8-obb.zip' -d ml/datasets/open_shelves/"
    exit 1
fi

# Verify train/valid directories
if [ ! -d "$DATASET_DIR/train/images" ]; then
    echo "ERROR: train/images not found"
    exit 1
fi

if [ ! -d "$DATASET_DIR/valid/images" ]; then
    echo "ERROR: valid/images not found"
    exit 1
fi

# Count images
TRAIN_COUNT=$(ls "$DATASET_DIR/train/images" | wc -l | tr -d ' ')
VALID_COUNT=$(ls "$DATASET_DIR/valid/images" | wc -l | tr -d ' ')
echo "Train images: $TRAIN_COUNT"
echo "Valid images: $VALID_COUNT"

# Training configuration
MODEL="yolo11n-obb.pt"  # Nano OBB model for speed
EPOCHS=100
IMGSZ=640
BATCH=16
PROJECT="$ML_DIR/runs/obb"
NAME="train"

echo ""
echo "=== Starting Training ==="
echo "Model: $MODEL"
echo "Epochs: $EPOCHS"
echo "Image size: $IMGSZ"
echo "Batch size: $BATCH"
echo ""

# Run training
cd "$ML_DIR"
yolo obb train \
    model=$MODEL \
    data="$DATA_YAML" \
    epochs=$EPOCHS \
    imgsz=$IMGSZ \
    batch=$BATCH \
    project="$PROJECT" \
    name="$NAME" \
    exist_ok=True \
    verbose=True

echo ""
echo "=== Training Complete ==="
echo "Weights saved to: $PROJECT/$NAME/weights/"
echo ""
echo "Best model: $PROJECT/$NAME/weights/best.pt"
echo "Last model: $PROJECT/$NAME/weights/last.pt"
echo ""

# Verify output
if [ -f "$PROJECT/$NAME/weights/best.pt" ]; then
    echo "✓ Gate 1 PASS: best.pt exists"
    ls -la "$PROJECT/$NAME/weights/best.pt"
else
    echo "✗ Gate 1 FAIL: best.pt not found"
    exit 1
fi
