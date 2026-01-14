# Models Directory

Place your YOLOv8 OBB TFLite model here.

## Required Model

- **Filename**: `yolov8_obb.tflite`
- **Input**: 640x640x3 RGB image
- **Output**: OBB detections with format [cx, cy, w, h, angle, score, classId]

## Model Export Instructions

If you have a YOLOv8 OBB model trained with Ultralytics:

```python
from ultralytics import YOLO

# Load your trained model
model = YOLO('path/to/your/best.pt')

# Export to TFLite
model.export(format='tflite', imgsz=640)
```

## iOS Setup

1. Add the .tflite file to your Xcode project
2. Ensure "Copy Bundle Resources" includes the model file

## Android Setup

1. Place the .tflite file in `android/app/src/main/assets/models/`
2. The model will be bundled with the APK

## Alternative: Development Mode

During development, the pipeline will generate sample detections if no model is loaded.
This allows testing the full pipeline without a trained model.
