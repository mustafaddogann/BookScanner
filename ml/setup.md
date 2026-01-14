# ML Training Setup

## Prerequisites

- Python 3.10+
- CUDA-capable GPU (optional but recommended)

## Environment Setup

```bash
# Create virtual environment
cd ml
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install --upgrade pip
pip install ultralytics>=8.3.0
pip install onnx onnxruntime  # For TFLite export

# Verify installation
yolo version
python -c "import ultralytics; print(ultralytics.__version__)"
```

## GPU Verification (if available)

```bash
# Check CUDA availability
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}'); print(f'Device: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"CPU\"}')"

# For Apple Silicon (MPS)
python -c "import torch; print(f'MPS available: {torch.backends.mps.is_available()}')"
```

## Dataset Setup

The dataset zip should be extracted to `ml/datasets/open_shelves/`:

```bash
# From BookScanner root
unzip "../Open Shelves.v9i.yolov8-obb.zip" -d ml/datasets/open_shelves/
```

Expected structure:
```
ml/datasets/open_shelves/
├── train/
│   ├── images/
│   └── labels/
├── valid/
│   ├── images/
│   └── labels/
└── data.yaml
```

## Training

```bash
# From ml/ directory with venv activated
./scripts/train_obb.sh
```

## Export to TFLite

```bash
# After training completes
./scripts/export_tflite.sh
```

## Troubleshooting

### "No module named ultralytics"
```bash
pip install ultralytics
```

### CUDA out of memory
Reduce batch size in `train_obb.sh` (e.g., `batch=8` or `batch=4`)

### MPS (Apple Silicon) issues
Add `device=cpu` to training command if MPS causes issues

### TFLite export fails
Ensure onnx and onnxruntime are installed:
```bash
pip install onnx onnxruntime
```
